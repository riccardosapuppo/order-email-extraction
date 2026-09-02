/**
 * What was read out of an email, and where each piece of it came from.
 *
 * This file is the argument the whole project makes. An order extracted from
 * an email goes into a system people act on: somebody ships against it, bills
 * against it, chases a supplier about it. When it is wrong, nothing announces
 * that — the mistake is discovered by a customer, weeks later, and the trail
 * back to the sentence that caused it does not exist.
 *
 * So nothing here is a bare value. Every extracted field carries:
 *
 *   - **where it came from**: the exact span of the email it was read out of,
 *     so a person can be shown the sentence rather than told a number;
 *   - **how it was found**: the name of the rule, so a rule that turns out to
 *     be wrong can be found and every field it ever produced re-examined;
 *   - **how sure**: one number, used for exactly one decision — whether this
 *     goes through or goes to a person.
 *
 * The thing being replaced put an LLM's JSON straight into Postgres with a
 * `confidence` column nothing read. A confidence nobody acts on is a decoration.
 */

/** The exact piece of the email a value was read from. */
export interface Provenance {
  /** Which part of the message: the subject line, or the body. */
  readonly where: 'subject' | 'body';

  /** Character offsets into that part, so the sentence can be shown. */
  readonly from: number;
  readonly to: number;

  /** What was actually there. Kept so a change to the source is detectable. */
  readonly text: string;

  /** The rule that read it. Names a function, not a category. */
  readonly rule: string;
}

/** A value that knows where it came from. */
export interface Field<T> {
  readonly value: T;
  readonly confidence: number;
  readonly provenance: Provenance;
}

/** What an email turned out to be. */
export type Kind =
  | 'order'
  | 'confirmation'
  | 'shipment'
  | 'acknowledgement'
  | 'billing'
  | 'marketing'
  | 'unknown';

export interface Item {
  readonly name: Field<string>;
  readonly quantity: Field<number>;
  readonly unit?: Field<string>;
  readonly specs?: Field<string>;
}

/**
 * Somebody ordering something.
 *
 * Named for the act rather than for the thing, because "Order" on its own is
 * ambiguous here: link/join.ts has one too, and it means something else. This
 * is *an email that places an order*; that is *an order, as the mailbox has
 * revealed it across several messages*. Two lifetimes, two names — confusing
 * them is how a shipment ends up attached to an email rather than to the
 * order it belongs to.
 */
export interface OrderPlaced {
  readonly kind: 'order';
  readonly reference?: Field<string>;
  readonly items: readonly Item[];
  readonly priority?: Field<'low' | 'normal' | 'high'>;
  readonly wanted?: Field<Date>;
}

/** A supplier saying they have it, or do not. */
export interface Confirmation {
  readonly kind: 'confirmation';
  readonly reference?: Field<string>;
  readonly supplierOrderId?: Field<string>;
  readonly status: Field<'accepted' | 'partial' | 'rejected' | 'delayed'>;
  readonly eta?: Field<Date>;
}

/** Something being sent. */
export interface Shipment {
  readonly kind: 'shipment';
  readonly reference?: Field<string>;
  readonly note?: Field<string>;
  readonly carrier?: Field<string>;
  readonly tracking?: Field<string>;
}

export interface NothingUseful {
  readonly kind: 'acknowledgement' | 'billing' | 'marketing' | 'unknown';
}

export type Fact = OrderPlaced | Confirmation | Shipment | NothingUseful;

/**
 * One email, read.
 *
 * `confidence` is about the reading as a whole and is deliberately not the
 * average of the fields: an order whose reference is certain and whose
 * quantities are guesses is not "moderately confident", it is an order that
 * needs a person to look at the quantities.
 */
export interface Reading {
  readonly messageId: string;
  readonly fact: Fact;
  readonly confidence: number;

  /**
   * Why it reached that conclusion, in the order the rules ran. Written for a
   * person deciding whether to trust it, not for a log nobody opens.
   */
  readonly because: readonly string[];

  /** What it saw and could not make sense of. Empty is the good case. */
  readonly doubts: readonly string[];
}

/** Everything a fact claims, flattened — for showing, and for checking. */
export function fieldsOf(fact: Fact): Array<{ path: string; field: Field<unknown> }> {
  const found: Array<{ path: string; field: Field<unknown> }> = [];

  const take = (path: string, value: unknown) => {
    if (isField(value)) found.push({ path, field: value });
  };

  if (fact.kind === 'order') {
    take('reference', fact.reference);
    take('priority', fact.priority);
    take('wanted', fact.wanted);
    fact.items.forEach((item, at) => {
      take(`items[${at}].name`, item.name);
      take(`items[${at}].quantity`, item.quantity);
      take(`items[${at}].unit`, item.unit);
      take(`items[${at}].specs`, item.specs);
    });
  } else if (fact.kind === 'confirmation') {
    take('reference', fact.reference);
    take('supplierOrderId', fact.supplierOrderId);
    take('status', fact.status);
    take('eta', fact.eta);
  } else if (fact.kind === 'shipment') {
    take('reference', fact.reference);
    take('note', fact.note);
    take('carrier', fact.carrier);
    take('tracking', fact.tracking);
  }

  return found;
}

function isField(value: unknown): value is Field<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    'confidence' in value &&
    'provenance' in value
  );
}

/** A field, with the span it was read from. */
export function field<T>(
  value: T,
  confidence: number,
  provenance: Provenance
): Field<T> {
  if (confidence < 0 || confidence > 1) {
    // A confidence outside the range is a bug in a rule, and it would quietly
    // push a bad reading past the threshold. Better here than in the review
    // queue that never fills up.
    throw new RangeError(`confidence out of range: ${confidence}`);
  }
  return { value, confidence, provenance };
}
