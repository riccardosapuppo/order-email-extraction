import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Message } from '@order-email/core';

import { theModel, whyNotAModel } from '../src/model/claude.js';

/**
 * Nothing here reaches the network.
 *
 * The one thing that would make these tests meaningless is if they needed a key
 * to run: a check nobody can run is a check nobody runs. `send` is injected, so
 * what is asserted is what this file sends and what it does with what comes
 * back — which is all of it that is ours.
 */

const message: Message = {
  id: '01-order.eml',
  from: { email: 'buyer@northgate.example' },
  to: [{ email: 'sales@medisupply.example' }],
  subject: 'Order PO-4471',
  receivedAt: new Date('2026-03-02T09:00:00Z'),
  body: 'Please supply 12 boxes of nitrile gloves against PO-4471.',
  attachments: [],
};

function answering(input: unknown, init: { ok?: boolean; status?: number; body?: string } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const send = (async (url: unknown, options: unknown) => {
    calls.push({ url: String(url), init: (options ?? {}) as RequestInit });

    if (init.ok === false) {
      return {
        ok: false,
        status: init.status ?? 429,
        statusText: 'Too Many Requests',
        text: async () => init.body ?? 'slow down',
      } as unknown as Response;
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'tool_use', name: 'record', input }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { send, calls };
}

describe('asking a model, and what is done with the answer', () => {
  it('says why it cannot run rather than failing at the first message', () => {
    assert.match(whyNotAModel({ key: '' }) ?? '', /ANTHROPIC_API_KEY/);
    assert.equal(whyNotAModel({ key: 'a-key' }), null);
  });

  it('sends the key in a header and asks for the answer as a tool call', async () => {
    const { send, calls } = answering({ kind: 'unknown', confidence: 0.5 });

    await theModel({ key: 'a-key', model: 'a-model', send }).read(message);

    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /api\.anthropic\.com/);

    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], 'a-key');
    assert.ok(headers['anthropic-version'], 'the version is pinned, not left to the default');

    const sent = JSON.parse(String(calls[0]!.init.body));
    assert.equal(sent.model, 'a-model');
    assert.equal(sent.tool_choice.name, 'record');
    assert.ok(String(sent.messages[0].content).includes(message.body), 'it is shown the body it will be checked against');
  });

  it('checks what comes back instead of believing it', async () => {
    // Two values, one of them in the message and one of them not.
    const { send } = answering({
      kind: 'order',
      confidence: 0.95,
      reference: { value: 'PO-4471', confidence: 0.95, where: 'subject', quote: 'PO-4471' },
      items: [
        {
          name: { value: 'nitrile gloves', confidence: 0.9, where: 'body', quote: 'nitrile gloves' },
          quantity: { value: 40, confidence: 0.95, where: 'body', quote: '40 boxes' },
        },
      ],
    });

    const reading = await theModel({ key: 'a-key', send }).read(message);

    assert.equal(reading.fact.kind, 'order');
    assert.ok(reading.doubts.some((doubt) => doubt.includes('not in this message')));
    assert.ok(reading.confidence <= 0.25, 'a reading with an invented value goes to a person');
  });

  it('turns a refusal from the API into one unread message, not a dead mailbox', async () => {
    const { send } = answering(null, { ok: false, status: 429, body: 'rate limit' });

    const reading = await theModel({ key: 'a-key', model: 'a-model', send }).read(message);

    assert.equal(reading.fact.kind, 'unknown');
    assert.equal(reading.confidence, 0);
    assert.ok(reading.doubts[0]?.includes('429'), reading.doubts[0]);
    assert.ok(reading.doubts[0]?.includes('rate limit'), 'the body says which limit; the status alone does not');
  });

  it('does not accept an answer that arrived without the reading in it', async () => {
    const send = (async () =>
      ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'certainly!' }] }) }) as unknown as Response) as unknown as typeof fetch;

    const reading = await theModel({ key: 'a-key', send }).read(message);

    assert.equal(reading.fact.kind, 'unknown');
    assert.ok(reading.doubts[0]?.includes('did not contain'), reading.doubts[0]);
  });

  it('names itself, so a value can be traced to the reader that produced it', async () => {
    const { send } = answering({
      kind: 'shipment',
      confidence: 0.8,
      tracking: { value: 'TRK-9', confidence: 0.8, where: 'body', quote: 'PO-4471' },
    });

    const reading = await theModel({ key: 'a-key', model: 'some-model-id', send }).read(message);

    assert.equal(reading.fact.kind, 'shipment');
    assert.equal(
      reading.fact.kind === 'shipment' ? reading.fact.tracking?.provenance.rule : null,
      'some-model-id'
    );
  });
});
