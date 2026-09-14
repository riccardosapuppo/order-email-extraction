/**
 * The model providers this can read with, and what each one wants.
 *
 * ── Why more than one ────────────────────────────────────────────────────────
 *
 * Because the argument this project makes is about the contract, not about
 * whose model honours it. A reader has to say which words it read a value from,
 * that quote is looked for in the message, and a value whose words are not
 * there is dropped. That is true of any of them, and a demonstration wired to
 * exactly one vendor invites the reader to think the checking is somehow
 * specific to that vendor. It is not: the same `readingFrom` checks all three.
 *
 * It is also the honest shape. Somebody trying this has a key for whichever one
 * they already pay for, and a screen that only accepts one of the three is a
 * screen most people cannot use.
 *
 * ── Why two request shapes and not three ─────────────────────────────────────
 *
 * Anthropic asks for tools one way; OpenAI defined a shape that Mistral also
 * speaks, so those two share an implementation rather than having one each
 * copied and edited. Where they are the same they are the same object here, so
 * a fix to one cannot miss the other.
 *
 * ── Why a tool call and not "please answer in JSON" ──────────────────────────
 *
 * Asking for JSON in prose gets JSON most of the time and, the rest of the
 * time, JSON wrapped in a sentence explaining the JSON. Handing the model a
 * tool whose schema is the shape required makes the shape the API's problem,
 * and a malformed answer an error here rather than a field that silently went
 * missing. All three support it.
 *
 * The order below is alphabetical, deliberately: this file should not read as a
 * recommendation.
 */

/** How to ask one of them, and how to read what comes back. */
export interface Provider {
  readonly id: string;

  /** What the screen calls it. */
  readonly label: string;

  /** The variable it is read from when nobody typed a key in. */
  readonly keyName: string;

  /** Used when no model is named. Overridable on the screen and by variable. */
  readonly defaultModel: string;

  readonly modelName: string;
  readonly endpoint: string;

  headers(key: string): Record<string, string>;

  body(asked: { model: string; system: string; user: string; schema: unknown }): unknown;

  /** The recorded answer, or a thrown explanation. Never a silent undefined. */
  answerFrom(body: unknown): unknown;
}

const TOOL = 'record';
const ABOUT = 'Record what this email is and what it says.';

/**
 * The shape OpenAI defined and Mistral speaks.
 *
 * `max_tokens` is deliberately absent. It is deprecated for some models and
 * refused outright by others, and the default is ample for one email; asking
 * for a field that a model might reject is how a reader stops working on a
 * model nobody here has tried.
 */
function openAiShaped(one: {
  id: string;
  label: string;
  keyName: string;
  modelName: string;
  defaultModel: string;
  endpoint: string;
}): Provider {
  return {
    ...one,

    headers: (key) => ({
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    }),

    body: ({ model, system, user, schema }) => ({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      tools: [{ type: 'function', function: { name: TOOL, description: ABOUT, parameters: schema } }],
      tool_choice: { type: 'function', function: { name: TOOL } },
    }),

    answerFrom: (body) => {
      const said = body as {
        choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
      };

      const called = said.choices?.[0]?.message?.tool_calls?.find((one) => one.function?.name === TOOL);
      const written = called?.function?.arguments;

      if (typeof written !== 'string') throw new Error('the answer did not contain the recorded reading');

      try {
        return JSON.parse(written);
      } catch {
        // The arguments arrive as a string, so this is the one place a
        // well-formed HTTP answer can still be unusable.
        throw new Error('the recorded reading was not readable as JSON');
      }
    },
  };
}

export const PROVIDERS: readonly Provider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    keyName: 'ANTHROPIC_API_KEY',
    modelName: 'ANTHROPIC_MODEL',
    defaultModel: 'claude-sonnet-5',
    endpoint: 'https://api.anthropic.com/v1/messages',

    headers: (key) => ({
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    }),

    body: ({ model, system, user, schema }) => ({
      model,
      max_tokens: 2000,
      system,
      tools: [{ name: TOOL, description: ABOUT, input_schema: schema }],
      tool_choice: { type: 'tool', name: TOOL },
      messages: [{ role: 'user', content: user }],
    }),

    answerFrom: (body) => {
      const said = body as { content?: Array<{ type: string; name?: string; input?: unknown }> };
      const used = said.content?.find((part) => part.type === 'tool_use' && part.name === TOOL);

      if (!used?.input) throw new Error('the answer did not contain the recorded reading');
      return used.input;
    },
  },

  openAiShaped({
    id: 'mistral',
    label: 'Mistral',
    keyName: 'MISTRAL_API_KEY',
    modelName: 'MISTRAL_MODEL',
    defaultModel: 'mistral-large-latest',
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
  }),

  openAiShaped({
    id: 'openai',
    label: 'OpenAI',
    keyName: 'OPENAI_API_KEY',
    modelName: 'OPENAI_MODEL',
    defaultModel: 'gpt-4o',
    endpoint: 'https://api.openai.com/v1/chat/completions',
  }),
];

export function providerCalled(id: string | undefined): Provider | null {
  return PROVIDERS.find((one) => one.id === id) ?? null;
}

/**
 * The one whose key is already in the environment, if exactly one is.
 *
 * No preference: the list is alphabetical and the first one with a key wins,
 * which is only a tie-break. With none set there is nothing to guess at and the
 * caller is told to choose.
 */
export function providerFromEnvironment(env = process.env): Provider | null {
  return PROVIDERS.find((one) => (env[one.keyName] ?? '').trim() !== '') ?? null;
}
