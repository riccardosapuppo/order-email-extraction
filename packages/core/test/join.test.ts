import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Message } from '../src/message.js';
import { read } from '../src/extract/rules.js';
import { decide, join, stageOf, SURE_ENOUGH } from '../src/link/join.js';

let counter = 0;

function email(over: Partial<Message> & { body: string }): Message {
  counter += 1;
  return {
    id: `m${counter}`,
    from: { email: 'buyer@customer.example' },
    to: [{ email: 'orders@supplier.example' }],
    subject: 'Order',
    receivedAt: new Date(2026, 2, 10 + counter, 9, 0),
    attachments: [],
    ...over,
  };
}

/** A message and what was read out of it, which is what join() takes. */
function entry(message: Message) {
  return { message, reading: read(message, { supplierDomains: ['supplier.example'] }) };
}

describe('the life of one order', () => {
  const order = email({
    subject: 'PO 4471',
    body: 'Please send 12 x blue nitrile gloves',
    threadId: 't1',
  });
  const confirmation = email({
    from: { email: 'sales@supplier.example' },
    subject: 'Re: PO 4471',
    body: 'Order confirmation: we can supply. Your order SO 88120. Expected 19/03/2026.',
    threadId: 't1',
  });
  const shipment = email({
    from: { email: 'despatch@supplier.example' },
    subject: 'PO 4471 dispatched',
    body: 'Shipped with DHL. Tracking number JD0002234567.',
  });

  const { orders, unlinked } = join([entry(order), entry(confirmation), entry(shipment)]);

  it('is one order, not three', () => {
    assert.equal(orders.length, 1);
    assert.equal(unlinked.length, 0);
  });

  it('carries all three messages', () => {
    assert.deepEqual(
      orders[0]?.readings.map((reading) => reading.fact.kind),
      ['order', 'confirmation', 'shipment']
    );
  });

  it('learns the supplier’s own number along the way', () => {
    assert.equal(orders[0]?.reference, '4471');
    assert.equal(orders[0]?.supplierReference, 'SO88120');
  });

  it('and says where it has got to', () => {
    assert.equal(stageOf(orders[0]!), 'shipped');
  });

  it('every link says why', () => {
    for (const reading of orders[0]!.readings) {
      assert.ok(reading.why.length > 0);
    }
    assert.ok(orders[0]!.readings[1]?.why.includes('4471'));
  });
});

describe('what it refuses to join', () => {
  it('a confirmation for an order this mailbox has never seen', () => {
    const stray = email({
      from: { email: 'sales@othersupplier.example' },
      subject: 'Re: PO 9999',
      body: 'Order confirmation: we can supply.',
    });

    const { orders, unlinked } = join([entry(stray)]);

    assert.equal(orders.length, 0);
    assert.equal(unlinked.length, 1);
    assert.ok(unlinked[0]?.why.includes('has not seen'));
  });

  it('two open orders with the same supplier, and nothing to tell them apart', () => {
    // The ordinary case, and the one the single-line heuristic gets wrong: a
    // shipment with no reference from a supplier who owes you two deliveries.
    const first = email({ subject: 'PO 100', body: 'Please send 5 x masks', threadId: 'a' });
    const second = email({ subject: 'PO 200', body: 'Please send 8 x aprons', threadId: 'b' });
    const vague = email({
      from: { email: 'despatch@supplier.example' },
      subject: 'Your delivery',
      body: 'Your goods have been dispatched today with DHL.',
    });

    const { orders, unlinked } = join([entry(first), entry(second), entry(vague)]);

    assert.equal(orders.length, 2);
    assert.equal(unlinked.length, 1);
    assert.ok(unlinked[0]?.why.includes('2 open orders'));
  });

  it('a subject and a body that name different orders', () => {
    // People reply to the nearest email to start something new, so the subject
    // says one order and the body another. The subject wins — it is what
    // threads, and it is what the sender chose to reply to — but the
    // disagreement is *reported*, because whichever is picked is wrong some of
    // the time and nobody can check a choice they were never told about.
    //
    // This test expected the message to be set aside entirely, which is worse:
    // an email whose subject says PO 100 is almost certainly about PO 100, and
    // dropping it into a review queue costs somebody a minute for nothing.
    const first = email({ subject: 'PO 100', body: 'Please send 5 x masks', threadId: 'a' });
    const wandered = email({
      from: { email: 'sales@supplier.example' },
      subject: 'Re: PO 100',
      body: 'Order confirmation for PO 200: we can supply.',
      threadId: 'a',
    });

    const wanderedEntry = entry(wandered);
    const { orders, unlinked } = join([entry(first), wanderedEntry]);

    assert.equal(unlinked.length, 0);
    assert.equal(orders[0]?.readings.length, 2);
    assert.ok(
      wanderedEntry.reading.doubts.some(
        (doubt) => doubt.includes('100') && doubt.includes('200')
      ),
      `the disagreement was not reported: ${JSON.stringify(wanderedEntry.reading.doubts)}`
    );
  });

  it('a thread whose order is named nowhere else', () => {
    // Here the body is the only place a reference appears, and it contradicts
    // the thread. Now there is nothing better to go on, and the message is set
    // aside rather than filed under an order it says it is not about.
    const first = email({ subject: 'Supplies', body: 'Please send 5 x masks', threadId: 'w' });
    const relabelled = email({
      from: { email: 'sales@supplier.example' },
      subject: 'Re: supplies',
      body: 'Order confirmation for PO 200: we can supply.',
      threadId: 'w',
    });

    const { orders } = join([entry(first), entry(relabelled)]);

    // The first order has no reference of its own, so nothing contradicts:
    // the thread carries it, and the reference is learned from the reply.
    assert.equal(orders.length, 1);
    assert.equal(orders[0]?.reference, '200');
  });
});

describe('the threshold', () => {
  it('a weak link is set aside rather than made', () => {
    const outcome = decide(
      email({ from: { email: 'x@nowhere.example' }, body: 'Shipped today with DHL.' }),
      read(email({ body: 'Shipped today with DHL.' })),
      []
    );

    assert.equal(outcome.kind, 'unlinked');
  });

  it('and the threshold is a number, not a feeling', () => {
    // If this ever drops below the weakest rule that joins, everything joins.
    assert.ok(SURE_ENOUGH > 0.7 - 0.001);
    assert.ok(SURE_ENOUGH <= 0.9);
  });
});

describe('the order things are read in', () => {
  it('does not change the result', () => {
    // A mailbox exported in a different order must produce the same orders.
    // The messages are sorted by arrival before anything is joined, because
    // a confirmation cannot attach to an order that has not been read yet.
    const order = email({ subject: 'PO 700', body: 'Please send 3 x trays', threadId: 'z' });
    const confirmation = email({
      from: { email: 'sales@supplier.example' },
      subject: 'Re: PO 700',
      body: 'Order confirmation: we can supply.',
      threadId: 'z',
    });

    const forwards = join([entry(order), entry(confirmation)]);
    const backwards = join([entry(confirmation), entry(order)]);

    assert.equal(forwards.orders.length, backwards.orders.length);
    assert.equal(
      forwards.orders[0]?.readings.length,
      backwards.orders[0]?.readings.length
    );
  });
});

describe('what never becomes part of an order', () => {
  it('an out-of-office is not an event in its history', () => {
    const order = email({ subject: 'PO 300', body: 'Please send 2 x boxes of gloves', threadId: 'q' });
    const away = email({
      from: { email: 'sales@supplier.example' },
      subject: 'Automatic reply: PO 300',
      body: 'I am out of office until Monday.',
      threadId: 'q',
    });

    const { orders } = join([entry(order), entry(away)]);

    assert.equal(orders[0]?.readings.length, 1);
  });
});
