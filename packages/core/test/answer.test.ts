import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fieldsOf } from '../src/facts.js';
import type { Message } from '../src/message.js';
import { readingFrom, type Answer } from '../src/read/answer.js';

const message: Message = {
  id: '01-order.eml',
  from: { email: 'buyer@northgate.example' },
  to: [{ email: 'sales@medisupply.example' }],
  subject: 'Order PO-4471',
  receivedAt: new Date('2026-03-02T09:00:00Z'),
  body: 'Please supply 12 boxes of nitrile gloves against PO-4471.\nWanted by 14 March, and it is urgent.',
  attachments: [],
};

const anOrder = (over: Partial<Answer> = {}): Answer => ({
  kind: 'order',
  confidence: 0.9,
  reference: { value: 'PO-4471', confidence: 0.95, where: 'subject', quote: 'PO-4471' },
  items: [
    {
      name: { value: 'nitrile gloves', confidence: 0.9, where: 'body', quote: 'nitrile gloves' },
      quantity: { value: 12, confidence: 0.9, where: 'body', quote: '12 boxes' },
    },
  ],
  ...over,
});

/** The invariant: every span points at the words it says it does. */
function everySpanIsReal(reading: ReturnType<typeof readingFrom>): boolean {
  return fieldsOf(reading.fact).every(({ field }) => {
    const part = field.provenance.where === 'subject' ? message.subject : message.body;
    return part.slice(field.provenance.from, field.provenance.to) === field.provenance.text;
  });
}

describe('what a model says, checked against the message', () => {
  it('keeps a value whose words are in the message, and says where', () => {
    const reading = readingFrom(message, anOrder(), 'a-model');

    assert.equal(reading.fact.kind, 'order');
    assert.equal(reading.doubts.length, 0);
    assert.ok(everySpanIsReal(reading));

    const reference = fieldsOf(reading.fact).find((one) => one.path === 'reference');
    assert.equal(reference?.field.value, 'PO-4471');
    assert.equal(reference?.field.provenance.where, 'subject');
  });

  it('names the reader on every span it produced', () => {
    // Not "the model". A value that turns out to be wrong has to be traceable
    // to something somebody can go and look at, the way a rule names a function.
    const reading = readingFrom(message, anOrder(), 'claude-sonnet-5');

    for (const { field } of fieldsOf(reading.fact)) {
      assert.equal(field.provenance.rule, 'claude-sonnet-5');
    }
  });

  it('drops a value it cannot find, and says which words were not there', () => {
    // The whole reason this file exists. 14 is a plausible quantity for this
    // email and the email does not say it.
    const reading = readingFrom(
      message,
      anOrder({
        items: [
          {
            name: { value: 'nitrile gloves', confidence: 0.9, where: 'body', quote: 'nitrile gloves' },
            quantity: { value: 14, confidence: 0.97, where: 'body', quote: '14 boxes' },
          },
        ],
      }),
      'a-model'
    );

    assert.equal(reading.fact.kind, 'order');
    assert.deepEqual(
      fieldsOf(reading.fact).map((one) => one.path),
      ['reference'],
      'the item went, because half an item is a line somebody has to read'
    );
    assert.ok(reading.doubts.some((doubt) => doubt.includes('not in this message')));
    assert.ok(everySpanIsReal(reading));
  });

  it('puts an invented value below any threshold, whatever the model thought', () => {
    // 0.97 stated, and it invented a quantity. Averaging that down would leave
    // it looking like a moderately good reading; it is a reading for a person.
    const reading = readingFrom(
      message,
      anOrder({
        confidence: 0.97,
        reference: { value: 'PO-9999', confidence: 0.97, where: 'subject', quote: 'PO-9999' },
      }),
      'a-model'
    );

    assert.ok(reading.confidence <= 0.25, `confidence was ${reading.confidence}`);
    assert.ok(reading.because.some((line) => line.includes('needs a person')));
  });

  it('accepts a quote found in the other part, and says so', () => {
    const reading = readingFrom(
      message,
      anOrder({
        reference: { value: 'PO-4471', confidence: 0.9, where: 'body', quote: 'Order PO-4471' },
      }),
      'a-model'
    );

    const reference = fieldsOf(reading.fact).find((one) => one.path === 'reference');
    assert.equal(reference?.field.provenance.where, 'subject');
    assert.ok(reading.because.some((line) => line.includes('found in the subject')));
    assert.ok(everySpanIsReal(reading));
  });

  it('warns when the quote appears more than once instead of picking quietly', () => {
    const twice: Message = { ...message, body: 'Send 12 now. Last time it was 12.' };

    const reading = readingFrom(
      twice,
      anOrder({
        items: [
          {
            name: { value: 'gloves', confidence: 0.9, where: 'subject', quote: 'Order' },
            quantity: { value: 12, confidence: 0.9, where: 'body', quote: '12' },
          },
        ],
      }),
      'a-model'
    );

    assert.ok(reading.doubts.some((doubt) => doubt.includes('appears 2 times')));
  });

  it('refuses a confirmation that does not say what was confirmed', () => {
    const reading = readingFrom(message, { kind: 'confirmation', confidence: 0.8 }, 'a-model');

    assert.equal(reading.fact.kind, 'unknown');
    assert.ok(reading.doubts.some((doubt) => doubt.includes('what was confirmed')));
  });

  it('drops a date it cannot read rather than inventing one', () => {
    const reading = readingFrom(
      message,
      anOrder({ wanted: { value: 'sometime soon', confidence: 0.8, where: 'body', quote: 'Wanted by 14 March' } }),
      'a-model'
    );

    assert.equal(
      fieldsOf(reading.fact).find((one) => one.path === 'wanted'),
      undefined
    );
    assert.ok(reading.doubts.some((doubt) => doubt.includes('is not a date')));
  });

  it('takes nothing from a model that answers with a confidence out of range', () => {
    const reading = readingFrom(message, anOrder({ confidence: 4 }), 'a-model');
    assert.ok(reading.confidence <= 1);
  });
});
