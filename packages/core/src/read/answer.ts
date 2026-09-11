/**
 * What a model is allowed to say, and what is done with it before anybody sees
 * it.
 *
 * ── The thing being replaced, and what was actually wrong with it ────────────
 *
 * The original of this project had a model do the reading, and it read well.
 * What went wrong was downstream: its JSON went into the database as it
 * arrived, with a `confidence` column nothing ever read. When a value was wrong
 * there was no way to ask where it had come from, because the answer — a
 * sentence in an email — had never been written down.
 *
 * So the model is not the problem and this file does not treat it as one. It is
 * a reader, and a good one: it handles a layout nobody wrote a rule for, which
 * `extract/rules.ts` by definition cannot. It is held to the same contract as
 * the rules, and the contract is the whole of the argument here — **a value has
 * to point at the words it came from**.
 *
 * ── How that is enforced ─────────────────────────────────────────────────────
 *
 * The model is asked for the text it read each value out of, never for offsets
 * (`locate.ts` says why). Every quote is then looked for in the message:
 *
 *  - found: the value is kept, with the span of the message's own characters;
 *  - found in the other part: kept, and said out loud, because a model that
 *    thinks the subject line is the body is right about the words and wrong
 *    about the message;
 *  - found more than once: kept, with a doubt, because the first occurrence is
 *    not necessarily the one it meant;
 *  - not found: **dropped**, with a doubt naming the value and the words that
 *    were not there.
 *
 * That last one is the case worth building all of this for. A model asked to
 * fill in a field will fill it in, and the invented answer looks exactly like
 * the read one — same shape, same plausible confidence. The difference is that
 * the read one can be pointed at.
 */

import type { Field, Fact, Item, Kind, Provenance, Reading } from '../facts.js';
import { field } from '../facts.js';
import type { Message } from '../message.js';
import { locate } from './locate.js';

/** A value, and the words the model says it read it from. */
export interface Quoted<T> {
  readonly value: T;
  readonly confidence: number;
  readonly where: 'subject' | 'body';
  /** Verbatim from the message. Checked, never trusted. */
  readonly quote: string;
}

export interface QuotedItem {
  readonly name: Quoted<string>;
  readonly quantity: Quoted<number>;
  readonly unit?: Quoted<string>;
  readonly specs?: Quoted<string>;
}

/**
 * The whole of what a model may return.
 *
 * Deliberately the same shape as `Fact`, minus the offsets it cannot know and
 * plus the quotes it can. Anything else it says is discarded without comment:
 * a reader that grows fields by being asked nicely is a reader nothing can be
 * asserted about.
 */
export interface Answer {
  readonly kind: Kind;
  readonly confidence: number;
  readonly because?: readonly string[];

  readonly reference?: Quoted<string>;
  readonly items?: readonly QuotedItem[];
  readonly priority?: Quoted<'low' | 'normal' | 'high'>;
  readonly wanted?: Quoted<string>;

  readonly supplierOrderId?: Quoted<string>;
  readonly status?: Quoted<'accepted' | 'partial' | 'rejected' | 'delayed'>;
  readonly eta?: Quoted<string>;

  readonly note?: Quoted<string>;
  readonly carrier?: Quoted<string>;
  readonly tracking?: Quoted<string>;
}

/**
 * An answer, checked against the message, as a Reading like any other.
 *
 * `by` names the model, and goes into every provenance this produces. It is
 * there so that a value that turns out to be wrong can be traced to the reader
 * that produced it — the same reason a rule carries its function name. "The
 * model said so" is not an answer anybody can act on; "claude-sonnet-5 said so,
 * out of these words, on this date" is.
 */
export function readingFrom(message: Message, answer: Answer, by: string): Reading {
  const because = [...(answer.because ?? [])];
  const doubts: string[] = [];
  let invented = 0;

  const check = <T>(path: string, quoted: Quoted<T> | undefined): Field<T> | undefined => {
    if (!quoted || quoted.value === undefined || quoted.value === null) return undefined;

    const found = verify(message, quoted, path, because, doubts);
    if (!found) {
      invented += 1;
      return undefined;
    }

    return field(quoted.value, clamp(quoted.confidence), { ...found, rule: by });
  };

  const date = (path: string, quoted: Quoted<string> | undefined): Field<Date> | undefined => {
    const asText = check(path, quoted);
    if (!asText) return undefined;

    const when = new Date(asText.value);
    if (Number.isNaN(when.getTime())) {
      doubts.push(`${path}: "${asText.value}" is not a date this can use, so it was dropped`);
      return undefined;
    }

    return field(when, asText.confidence, asText.provenance);
  };

  const fact = buildFact(answer, check, date, doubts);

  /*
   * One invented value is not a slightly less good reading.
   *
   * A reading holding a value the model produced out of nothing is a reading a
   * person has to look at, whatever the model thought of itself — so the
   * confidence is pushed below any threshold rather than averaged down towards
   * one. `facts.ts` says this number is used for exactly one decision, and this
   * is that decision being made.
   */
  const stated = clamp(answer.confidence);
  const confidence = invented > 0 ? Math.min(stated, 0.25) : stated;

  if (invented > 0) {
    because.push(
      `${invented} value${invented === 1 ? '' : 's'} could not be found in the message, so this needs a person`
    );
  }

  return { messageId: message.id, fact, confidence, because, doubts };
}

// ---------------------------------------------------------------------------

type Check = <T>(path: string, quoted: Quoted<T> | undefined) => Field<T> | undefined;
type CheckDate = (path: string, quoted: Quoted<string> | undefined) => Field<Date> | undefined;

function buildFact(answer: Answer, check: Check, date: CheckDate, doubts: string[]): Fact {
  if (answer.kind === 'order') {
    const items: Item[] = [];

    for (const [at, one] of (answer.items ?? []).entries()) {
      const name = check(`items[${at}].name`, one.name);
      const quantity = check(`items[${at}].quantity`, one.quantity);

      // Both or neither. An item with a name and no quantity is not half an
      // item, it is a line somebody has to read themselves.
      if (!name || !quantity) {
        doubts.push(`items[${at}]: a name and a quantity are both needed, so this line was dropped`);
        continue;
      }

      const unit = check(`items[${at}].unit`, one.unit);
      const specs = check(`items[${at}].specs`, one.specs);

      // Spread rather than assigned. `exactOptionalPropertyTypes` is on in this
      // package, so an optional field is absent or present -- never present and
      // holding undefined, which is a third state nothing downstream expects.
      items.push({ name, quantity, ...(unit ? { unit } : {}), ...(specs ? { specs } : {}) });
    }

    const reference = check('reference', answer.reference);
    const priority = check('priority', answer.priority);
    const wanted = date('wanted', answer.wanted);

    return {
      kind: 'order',
      ...(reference ? { reference } : {}),
      items,
      ...(priority ? { priority } : {}),
      ...(wanted ? { wanted } : {}),
    };
  }

  if (answer.kind === 'confirmation') {
    const status = check('status', answer.status);

    // A confirmation is a supplier's answer, so the answer is the one part of
    // it that cannot be missing. Without it this is a message that mentioned an
    // order, which is what `unknown` means.
    if (!status) {
      doubts.push('a confirmation has to say what was confirmed, and this one did not');
      return { kind: 'unknown' };
    }

    const reference = check('reference', answer.reference);
    const supplierOrderId = check('supplierOrderId', answer.supplierOrderId);
    const eta = date('eta', answer.eta);

    return {
      kind: 'confirmation',
      ...(reference ? { reference } : {}),
      ...(supplierOrderId ? { supplierOrderId } : {}),
      status,
      ...(eta ? { eta } : {}),
    };
  }

  if (answer.kind === 'shipment') {
    const reference = check('reference', answer.reference);
    const note = check('note', answer.note);
    const carrier = check('carrier', answer.carrier);
    const tracking = check('tracking', answer.tracking);

    return {
      kind: 'shipment',
      ...(reference ? { reference } : {}),
      ...(note ? { note } : {}),
      ...(carrier ? { carrier } : {}),
      ...(tracking ? { tracking } : {}),
    };
  }

  return { kind: answer.kind };
}

/**
 * Where the quote really is, or nothing, having said why.
 *
 * Everything but the rule: which reader this was is the caller's to say, and
 * naming it here would let two callers disagree about it.
 */
function verify<T>(
  message: Message,
  quoted: Quoted<T>,
  path: string,
  because: string[],
  doubts: string[]
): Omit<Provenance, 'rule'> | null {
  const parts = {
    subject: message.subject ?? '',
    body: message.body,
  } as const;

  const said = quoted.where === 'subject' ? 'subject' : 'body';
  const other = said === 'subject' ? 'body' : 'subject';

  let where: 'subject' | 'body' = said;
  let found = locate(parts[said], quoted.quote);

  if (!found) {
    const elsewhere = locate(parts[other], quoted.quote);
    if (elsewhere) {
      because.push(`${path}: quoted as the ${said}, found in the ${other}`);
      where = other;
      found = elsewhere;
    }
  }

  if (!found) {
    doubts.push(
      `${path}: the words it quoted are not in this message — ${short(quoted.quote)} — so the value ${short(
        String(quoted.value)
      )} was dropped`
    );
    return null;
  }

  if (found.occurrences > 1) {
    doubts.push(
      `${path}: ${short(quoted.quote)} appears ${found.occurrences} times in the ${where}, and this is the first`
    );
  }

  return { where, from: found.from, to: found.to, text: found.text };
}

function clamp(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  return Math.min(1, Math.max(0, confidence));
}

function short(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return `"${one.length > 60 ? `${one.slice(0, 57)}...` : one}"`;
}
