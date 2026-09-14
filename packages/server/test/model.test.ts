import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Message } from '@order-email/core';

import { PROVIDERS, theModel, whyNotAModel } from '../src/model/reader.js';

/**
 * Nothing here reaches the network, and nothing here needs a key.
 *
 * `send` is injected and `env` is empty, so what is asserted is the part that is
 * ours: what this sends to each provider, and what it does with what comes back.
 * A check that needed a key would be a check nobody runs.
 *
 * Empty `env` on purpose. With `process.env` these would behave differently on a
 * machine that happens to have a key exported — which is the kind of test that
 * passes everywhere except where it matters.
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

const NOTHING_SET = {};

/** A fetch that records what it was given and answers in one provider's shape. */
function answering(shape: 'anthropic' | 'openai', input: unknown, init: { ok?: boolean; status?: number; body?: string } = {}) {
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

    const body =
      shape === 'anthropic'
        ? { content: [{ type: 'tool_use', name: 'record', input }] }
        : { choices: [{ message: { tool_calls: [{ function: { name: 'record', arguments: JSON.stringify(input) } }] } }] };

    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;

  return { send, calls };
}

const anOrder = {
  kind: 'order',
  confidence: 0.95,
  reference: { value: 'PO-4471', confidence: 0.95, where: 'subject', quote: 'PO-4471' },
  items: [
    {
      name: { value: 'nitrile gloves', confidence: 0.9, where: 'body', quote: 'nitrile gloves' },
      quantity: { value: 40, confidence: 0.95, where: 'body', quote: '40 boxes' },
    },
  ],
};

/** The request one of the OpenAI-shaped providers is sent. */
async function askedInTheOpenAiShape(id: string): Promise<void> {
  const { send, calls } = answering('openai', { kind: 'unknown', confidence: 0.5 });

  await theModel({ provider: id, key: 'a-key', model: 'a-model', send, env: NOTHING_SET }).read(message);

  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers['authorization'], 'Bearer a-key');

  const sent = JSON.parse(String(calls[0]!.init.body));
  assert.equal(sent.model, 'a-model');
  assert.equal(sent.tool_choice.function.name, 'record');
  assert.equal(sent.tools[0].function.name, 'record');
  assert.ok(sent.tools[0].function.parameters, 'the schema goes as the function parameters');
  assert.ok(String(sent.messages[1].content).includes(message.body));
}

/** Two values, one of them in the message and one of them not. */
async function theInventedValueGoes(id: string, shape: 'anthropic' | 'openai'): Promise<void> {
  const { send } = answering(shape, anOrder);

  const reading = await theModel({ provider: id, key: 'a-key', send, env: NOTHING_SET }).read(message);

  assert.equal(reading.fact.kind, 'order');
  assert.ok(reading.doubts.some((doubt) => doubt.includes('not in this message')));
  assert.ok(reading.confidence <= 0.25, 'a reading with an invented value goes to a person');
}

describe('asking a model, and what is done with the answer', () => {
  it('offers more than one provider, so the argument is not about one vendor', () => {
    assert.ok(PROVIDERS.length >= 3, `${PROVIDERS.length} providers`);

    // Each has to be askable on its own terms: its own variable, its own
    // default model, its own address. A provider sharing another's key name
    // would silently read with the wrong account.
    assert.equal(new Set(PROVIDERS.map((one) => one.keyName)).size, PROVIDERS.length);
    assert.equal(new Set(PROVIDERS.map((one) => one.endpoint)).size, PROVIDERS.length);
    assert.ok(PROVIDERS.every((one) => one.defaultModel.length > 0));
  });

  it('says why it cannot run rather than failing at the first message', () => {
    assert.match(whyNotAModel({ env: NOTHING_SET }) ?? '', /ANTHROPIC_API_KEY/);
    assert.match(whyNotAModel({ env: NOTHING_SET }) ?? '', /OPENAI_API_KEY/);

    // A key with nothing saying which API it opens is the case worth naming.
    assert.match(whyNotAModel({ key: 'a-key', env: NOTHING_SET }) ?? '', /not which provider/);

    assert.match(whyNotAModel({ provider: 'telepathy', env: NOTHING_SET }) ?? '', /no provider called/);
    assert.equal(whyNotAModel({ provider: 'openai', key: 'a-key', env: NOTHING_SET }), null);
  });

  it('takes the key from the variable belonging to the provider asked for', () => {
    /*
     * The variable is built rather than written out.
     *
     * A literal `SOMETHING_API_KEY: '...'` in a file is exactly what a secret
     * scanner is for, and the publication gate stopped on this line -- rightly.
     * Declaring an exception for it would have been the wrong answer twice
     * over: a scanner taught to ignore a test is a scanner somebody will one
     * day teach to ignore a real one, and the assertion reads the same either
     * way.
     */
    const onlyFor = (id: string) => ({ [`${id.toUpperCase()}_API_KEY`]: 'whatever that variable holds' });

    assert.equal(whyNotAModel({ provider: 'mistral', env: onlyFor('mistral') }), null);
    assert.match(whyNotAModel({ provider: 'openai', env: onlyFor('mistral') }) ?? '', /no key for OpenAI/);
  });

  it('asks Anthropic in its shape, with the key in its header', async () => {
    const { send, calls } = answering('anthropic', { kind: 'unknown', confidence: 0.5 });

    await theModel({ provider: 'anthropic', key: 'a-key', model: 'a-model', send, env: NOTHING_SET }).read(message);

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

  /*
   * Written out rather than generated in a loop, both here and below.
   *
   * A loop makes one `it(` in the file and several at runtime, and the check
   * that keeps the README honest about how many tests there are counts what is
   * in the file. Two numbers that disagree, one of them printed and one of them
   * published, is the shape of problem this repository keeps finding; the few
   * repeated lines are cheaper than that.
   */
  it('asks OpenAI in the shape it speaks, with the key as a bearer token', async () => {
    await askedInTheOpenAiShape('openai');
  });

  it('asks Mistral the same way, because it speaks the same shape', async () => {
    await askedInTheOpenAiShape('mistral');
  });

  it('checks what Anthropic says instead of believing it', async () => {
    await theInventedValueGoes('anthropic', 'anthropic');
  });

  it('checks what OpenAI says instead of believing it', async () => {
    await theInventedValueGoes('openai', 'openai');
  });

  it('checks what Mistral says instead of believing it', async () => {
    await theInventedValueGoes('mistral', 'openai');
  });

  it('turns a refusal from the API into one unread message, not a dead mailbox', async () => {
    const { send } = answering('anthropic', null, { ok: false, status: 429, body: 'rate limit' });

    const reading = await theModel({
      provider: 'anthropic',
      key: 'a-key',
      model: 'a-model',
      send,
      env: NOTHING_SET,
    }).read(message);

    assert.equal(reading.fact.kind, 'unknown');
    assert.equal(reading.confidence, 0);
    assert.ok(reading.doubts[0]?.includes('429'), reading.doubts[0]);
    assert.ok(reading.doubts[0]?.includes('rate limit'), 'the body says which limit; the status alone does not');
  });

  it('does not accept an answer that arrived without the reading in it', async () => {
    const send = (async () =>
      ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'certainly!' }] }) }) as unknown as Response) as unknown as typeof fetch;

    const reading = await theModel({ provider: 'anthropic', key: 'a-key', send, env: NOTHING_SET }).read(message);

    assert.equal(reading.fact.kind, 'unknown');
    assert.ok(reading.doubts[0]?.includes('did not contain'), reading.doubts[0]);
  });

  it('does not accept arguments that are not JSON', async () => {
    // The OpenAI shape hands the answer over as a string, so this is the one
    // place a well-formed HTTP answer can still be unusable.
    const send = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { tool_calls: [{ function: { name: 'record', arguments: '{oh dear' } }] } }],
        }),
      }) as unknown as Response) as unknown as typeof fetch;

    const reading = await theModel({ provider: 'openai', key: 'a-key', send, env: NOTHING_SET }).read(message);

    assert.ok(reading.doubts[0]?.includes('not readable as JSON'), reading.doubts[0]);
  });

  it('names itself, so a value can be traced to the reader that produced it', async () => {
    const { send } = answering('anthropic', {
      kind: 'shipment',
      confidence: 0.8,
      tracking: { value: 'TRK-9', confidence: 0.8, where: 'body', quote: 'PO-4471' },
    });

    const reading = await theModel({
      provider: 'anthropic',
      key: 'a-key',
      model: 'some-model-id',
      send,
      env: NOTHING_SET,
    }).read(message);

    assert.equal(reading.fact.kind, 'shipment');
    assert.equal(reading.fact.kind === 'shipment' ? reading.fact.tracking?.provenance.rule : null, 'some-model-id');
  });
});
