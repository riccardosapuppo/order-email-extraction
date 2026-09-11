/**
 * The other reader: a model, asked for the words and not for the offsets.
 *
 * ── Why there is no SDK here ─────────────────────────────────────────────────
 *
 * The README claims this server has no runtime dependency beyond Express, and
 * a check asserts it on every push. That claim is worth more than the few lines
 * an SDK would save: it is what makes "read a folder and serve it on localhost"
 * something a reader can believe without auditing a dependency tree. One HTTP
 * call against a documented API is not the place to spend it.
 *
 * ── Why the answer comes back as a tool call ─────────────────────────────────
 *
 * Asking for JSON in prose gets JSON most of the time, and the rest of the time
 * gets JSON wrapped in a sentence explaining the JSON. Handing the model a tool
 * whose input schema is the shape required makes the shape the API's problem
 * rather than a regular expression's, and a malformed answer becomes an error
 * here instead of a field that silently went missing.
 *
 * ── Why the key is only ever read from the environment ───────────────────────
 *
 * The same reason `imap/client.ts` gives for IMAP_PASSWORD: a secret passed as
 * an argument is a secret in the shell history and in the process list, where
 * every other process on the machine can read it. There is deliberately no
 * `--key` flag, and there is no file in this repository that could hold one.
 */

import { readingFrom, type Answer, type Message, type Reading } from '@order-email/core';

/** Capable enough to read an email nobody wrote a rule for. Overridable. */
const MODEL = 'claude-sonnet-5';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

export interface ModelSettings {
  readonly model?: string;
  readonly key?: string;
  /** Injected by the tests, so none of them reaches the network. */
  readonly send?: typeof fetch;
}

/** Whether a model reader can be built at all, said in words for the caller. */
export function whyNotAModel(settings: ModelSettings = {}): string | null {
  const key = settings.key ?? process.env.ANTHROPIC_API_KEY;
  if (!key || key.trim() === '') {
    return 'ANTHROPIC_API_KEY is not set, so there is no model to ask';
  }
  return null;
}

/**
 * A reader backed by a model.
 *
 * Every reading it produces goes through `readingFrom`, which checks each
 * quoted span against the message and drops what it cannot find. Nothing this
 * file returns has been believed.
 */
export function theModel(settings: ModelSettings = {}) {
  const model = settings.model ?? process.env.ANTHROPIC_MODEL ?? MODEL;
  const key = settings.key ?? process.env.ANTHROPIC_API_KEY ?? '';
  const send = settings.send ?? fetch;

  return {
    name: model,
    describes: `${model}, checked against the message`,

    async read(message: Message): Promise<Reading> {
      try {
        const answer = await ask(message, { model, key, send });
        return readingFrom(message, answer, model);
      } catch (error) {
        /*
         * A model that cannot be reached is one unread message, not a dead
         * mailbox. It comes back as a reading with no facts in it and a doubt
         * saying why -- which is the same shape as a message that could not be
         * parsed, and lands in the same place: in front of a person.
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
  readonly model: string;
  readonly key: string;
  readonly send: typeof fetch;
}

async function ask(message: Message, { model, key, send }: Asking): Promise<Answer> {
  const response = await send(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      system: SYSTEM,
      tool_choice: { type: 'tool', name: 'record' },
      tools: [{ name: 'record', description: 'Record what this email is and what it says.', input_schema: SCHEMA }],
      messages: [{ role: 'user', content: asText(message) }],
    }),
  });

  if (!response.ok) {
    // The body, not just the status. A 400 from this API says which field was
    // wrong, and a caller told only "400" goes looking in the wrong place.
    throw new Error(`${response.status} ${response.statusText}: ${short(await response.text())}`);
  }

  const body = (await response.json()) as { content?: Array<{ type: string; name?: string; input?: unknown }> };
  const used = body.content?.find((part) => part.type === 'tool_use' && part.name === 'record');

  if (!used?.input) throw new Error('the answer did not contain the recorded reading');

  return used.input as Answer;
}

/**
 * The message as the model sees it: exactly what the interface will show.
 *
 * The body is passed whole, quoted replies and all, because the offsets found
 * afterwards have to point into the same string a person is shown. Trimming
 * here and highlighting there is how a mark ends up on the wrong sentence.
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
