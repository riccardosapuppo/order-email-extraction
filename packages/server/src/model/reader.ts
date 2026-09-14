/**
 * The other reader: a model, asked for the words and not for the offsets.
 *
 * ── Why there is no SDK here ─────────────────────────────────────────────────
 *
 * The README claims this server has no runtime dependency beyond Express, and a
 * check asserts it on every push. That claim is worth more than the few lines an
 * SDK would save: it is what lets somebody believe "reads a folder and serves it
 * on localhost" without auditing a dependency tree. Three HTTP calls against
 * three documented APIs are not the place to spend it -- and one SDK per
 * provider would be three.
 *
 * ── Why the key is only ever read from the environment or typed in ───────────
 *
 * The same reason `imap/client.ts` gives for IMAP_PASSWORD: a secret passed as a
 * command-line argument is a secret in the shell history and in the process
 * list, where every other process on the machine can read it. There is no
 * `--key` flag and no file in this repository that could hold one. What the
 * screen posts is held in a closure for the life of the process and never
 * written down.
 */

import { readingFrom, type Answer, type Message, type Reading } from '@order-email/core';

import { PROVIDERS, providerCalled, providerFromEnvironment, type Provider } from './providers.js';

export { PROVIDERS } from './providers.js';

export interface ModelSettings {
  /** `anthropic`, `mistral`, `openai`. Otherwise: whichever key is set. */
  readonly provider?: string;
  readonly model?: string;
  readonly key?: string;

  /** Injected by the tests, so none of them reaches the network. */
  readonly send?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
}

/** What was asked for, resolved, or the reason it could not be. */
function settle(settings: ModelSettings): { provider: Provider; model: string; key: string } | string {
  const env = settings.env ?? process.env;

  const provider = settings.provider ? providerCalled(settings.provider) : providerFromEnvironment(env);

  if (settings.provider && !provider) {
    return `there is no provider called "${settings.provider}" here: ${PROVIDERS.map((one) => one.id).join(', ')}`;
  }

  if (!provider) {
    // A key with no provider is the case worth saying out loud: the key is
    // there, and nothing about it says which API it opens.
    return settings.key
      ? `a key was given but not which provider it belongs to: ${PROVIDERS.map((one) => one.id).join(', ')}`
      : `no key for any provider: set ${PROVIDERS.map((one) => one.keyName).join(', ')} or type one in`;
  }

  const key = (settings.key ?? env[provider.keyName] ?? '').trim();

  if (key === '') {
    return `no key for ${provider.label}: set ${provider.keyName} or type one in`;
  }

  return {
    provider,
    key,
    model: (settings.model ?? env[provider.modelName] ?? provider.defaultModel).trim(),
  };
}

/** Whether a model reader can be built at all, said in words for the caller. */
export function whyNotAModel(settings: ModelSettings = {}): string | null {
  const settled = settle(settings);
  return typeof settled === 'string' ? settled : null;
}

/**
 * A reader backed by a model.
 *
 * Every reading it produces goes through `readingFrom`, which checks each quoted
 * span against the message and drops what it cannot find. Nothing this file
 * returns has been believed.
 */
export function theModel(settings: ModelSettings = {}) {
  const settled = settle(settings);

  if (typeof settled === 'string') {
    // Callers are expected to have asked `whyNotAModel` first; this is here so
    // that a caller who did not gets the same sentence rather than a crash
    // somewhere further in.
    throw new Error(settled);
  }

  const { provider, model, key } = settled;
  const send = settings.send ?? fetch;

  return {
    /** The model id: what goes into every provenance this reader produces. */
    name: model,
    describes: `${model} at ${provider.label}, checked against the message`,

    async read(message: Message): Promise<Reading> {
      try {
        const answer = await ask(message, { provider, model, key, send });
        return readingFrom(message, answer as Answer, model);
      } catch (error) {
        /*
         * A model that cannot be reached is one unread message, not a dead
         * mailbox. It comes back as a reading with no facts in it and a doubt
         * saying why -- the same shape as a message that could not be parsed,
         * and it lands in the same place: in front of a person.
         *
         * When every message fails this way the API layer notices and says so
         * instead, because eleven copies of "401" is not a mailbox, it is a
         * wrong key.
         */
        return {
          messageId: message.id,
          fact: { kind: 'unknown' },
          confidence: 0,
          because: [],
          doubts: [`${model} could not read this message: ${(error as Error).message}`],
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------

interface Asking {
  readonly provider: Provider;
  readonly model: string;
  readonly key: string;
  readonly send: typeof fetch;
}

async function ask(message: Message, { provider, model, key, send }: Asking): Promise<unknown> {
  const response = await send(provider.endpoint, {
    method: 'POST',
    headers: provider.headers(key),
    body: JSON.stringify(provider.body({ model, system: SYSTEM, user: asText(message), schema: SCHEMA })),
  });

  if (!response.ok) {
    // The body, not just the status. Every one of these APIs says which field
    // was wrong, and a caller told only "400" goes looking in the wrong place.
    throw new Error(`${response.status} ${response.statusText}: ${short(await response.text())}`);
  }

  return provider.answerFrom(await response.json());
}

/**
 * The message as the model sees it: exactly what the interface will show.
 *
 * The body is passed whole, quoted replies and all, because the offsets found
 * afterwards have to point into the same string a person is shown. Trimming here
 * and highlighting there is how a mark ends up on the wrong sentence.
 */
function asText(message: Message): string {
  return [
    `From: ${message.from.email}`,
    `Subject: ${message.subject}`,
    `Received: ${message.receivedAt.toISOString()}`,
    '',
    'BODY:',
    message.body,
  ].join('\n');
}

const SYSTEM = [
  'You read one supplier email and record what it is and what it says.',
  '',
  'Every value you record must carry the exact text you read it from, copied',
  'character for character out of the subject or the body above. That text is',
  'searched for in the message afterwards: a value whose quote is not found is',
  'discarded, and a reading with a discarded value is sent to a person.',
  '',
  'So: never quote text that is not in the message, never tidy a quote up, and',
  'never record a value you cannot quote. Leaving a field out is correct and',
  'costs nothing. Guessing costs somebody an afternoon.',
  '',
  'Quote the smallest run of text that contains the value and makes it checkable:',
  'for a quantity, the words around the number, not the number alone.',
  '',
  'confidence is between 0 and 1 and is used for one decision only: whether this',
  'goes through or goes to a person. It is not a score out of ten.',
].join('\n');

const quoted = (type: string, description: string) => ({
  type: 'object',
  description,
  properties: {
    value: { type },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    where: { type: 'string', enum: ['subject', 'body'] },
    quote: { type: 'string', description: 'Verbatim from the message. Searched for; not trusted.' },
  },
  required: ['value', 'confidence', 'where', 'quote'],
});

const SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['order', 'confirmation', 'shipment', 'acknowledgement', 'billing', 'marketing', 'unknown'],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    because: {
      type: 'array',
      items: { type: 'string' },
      description: 'Why you concluded that, in the order you concluded it. For a person deciding whether to trust it.',
    },

    reference: quoted('string', 'The buyer order reference, as written.'),
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: quoted('string', 'What is being ordered.'),
          quantity: quoted('number', 'How many.'),
          unit: quoted('string', 'Boxes, packs, units, as written.'),
          specs: quoted('string', 'Size, gauge, colour, and the like.'),
        },
        required: ['name', 'quantity'],
      },
    },
    priority: quoted('string', 'low, normal or high.'),
    wanted: quoted('string', 'The date it is wanted by, as an ISO date.'),

    supplierOrderId: quoted('string', "The supplier's own reference for it."),
    status: quoted('string', 'accepted, partial, rejected or delayed.'),
    eta: quoted('string', 'The date the supplier expects to deliver, as an ISO date.'),

    note: quoted('string', 'What the shipment message says about it.'),
    carrier: quoted('string', 'Who is carrying it.'),
    tracking: quoted('string', 'The tracking number, as written.'),
  },
  required: ['kind', 'confidence'],
};

function short(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 200 ? `${one.slice(0, 197)}...` : one;
}
