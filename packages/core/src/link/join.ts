/**
 * Which order is this email about?
 *
 * This is the hard part, and the part the original solved with one line:
 *
 *     order_key = coalesce(po_reference, thread_id || ':' || from_email)
 *
 * That works until it does not, and when it does not it is silent. A supplier
 * who replies from a shared mailbox, a thread somebody starts fresh instead of
 * hitting reply, a reference typed with a space in it — each one either splits
 * an order in two or, worse, **joins two orders into one**. A shipment attached
 * to the wrong order tells a customer their goods are on the way when they are
 * not, and the trail back to the decision does not exist.
 *
 * So linking here is a set of rules tried strongest first, each one saying how
 * sure it is and why. Below a threshold nothing is linked and the email goes to
 * a person — because **an unlinked email is a small problem and a wrongly
 * linked one is not**. The first costs somebody a minute; the second is found
 * by a customer.
 */

import type { Fact, Reading } from '../facts.js';
import type { Message } from '../message.js';
import { domainOf } from '../message.js';

/** An order, as far as the mailbox has revealed it. */
export interface Order {
  /** Stable, and derived from the first thing that identified it. */
  readonly key: string;

  /** The purchase-order reference, when one has ever been seen. */
  readonly reference: string | null;

  /** The supplier's own number for it, learned from their reply. */
  readonly supplierReference: string | null;

  /** Threads this order has been discussed in. More than one is normal. */
  readonly threads: readonly string[];

  /**
   * Every domain that has been on an email about it, sender or recipient.
   *
   * Recipients too, and that is the point: an order goes *out* to a supplier,
   * so their domain only ever appears in the To line of the message that
   * opened it. Recording senders alone meant a supplier's reply with no
   * reference matched nothing at all — the order had never heard of them.
   */
  readonly correspondents: readonly string[];

  readonly firstSeen: Date;
  readonly lastSeen: Date;

  /** Every reading attached to it, in the order they arrived. */
  readonly readings: readonly LinkedReading[];
}

export interface LinkedReading {
  readonly messageId: string;
  readonly fact: Fact;
  readonly why: string;
  readonly confidence: number;
}

export type Outcome =
  | { readonly kind: 'joined'; readonly key: string; readonly why: string; readonly confidence: number }
  | { readonly kind: 'opened'; readonly key: string; readonly why: string }
  | { readonly kind: 'unlinked'; readonly why: string; readonly candidates: readonly string[] };

/** Below this, nothing is joined and a person is asked. */
export const SURE_ENOUGH = 0.7;

/**
 * How long after an order a message can still be about it, when nothing but
 * the sender connects them. Ninety days is long for a consumables order and
 * short enough that a supplier's unrelated email a year later is not swept in.
 */
export const WINDOW_DAYS = 90;

function referenceOf(fact: Fact): string | null {
  if (fact.kind === 'order' || fact.kind === 'confirmation' || fact.kind === 'shipment') {
    return fact.reference?.value ?? null;
  }
  return null;
}

function supplierReferenceOf(fact: Fact): string | null {
  return fact.kind === 'confirmation' ? (fact.supplierOrderId?.value ?? null) : null;
}

/** Everybody on the message, by domain. */
function domainsOf(message: Message): string[] {
  const all = [domainOf(message.from), ...message.to.map((one) => domainOf(one))];
  return [...new Set(all.filter(Boolean))];
}

function days(from: Date, to: Date): number {
  return Math.abs(to.getTime() - from.getTime()) / 86_400_000;
}

/**
 * Where this reading belongs.
 *
 * The rules, strongest first. Each returns a reason in words, because the
 * reason is what a person needs when they are asked to check one.
 */
export function decide(message: Message, reading: Reading, orders: readonly Order[]): Outcome {
  const reference = referenceOf(reading.fact);
  const supplierReference = supplierReferenceOf(reading.fact);

  // 1. The same purchase-order reference. As close to certain as this gets:
  //    it is the number both sides chose to identify the order by.
  if (reference) {
    const byReference = orders.filter((order) => order.reference === reference);
    if (byReference.length === 1) {
      return {
        kind: 'joined',
        key: byReference[0]!.key,
        why: `the same reference, ${reference}`,
        confidence: 0.98,
      };
    }
    if (byReference.length > 1) {
      // Two orders carrying one reference is a fault in the data, not a
      // choice to be made here. Picking either is how the wrong customer is
      // told their delivery has left.
      return {
        kind: 'unlinked',
        why: `${byReference.length} orders already carry the reference ${reference}`,
        candidates: byReference.map((order) => order.key),
      };
    }
  }

  // 2. The supplier's own number, learned when they first replied.
  if (supplierReference) {
    const bySupplier = orders.filter((order) => order.supplierReference === supplierReference);
    if (bySupplier.length === 1) {
      return {
        kind: 'joined',
        key: bySupplier[0]!.key,
        why: `the supplier's own reference, ${supplierReference}`,
        confidence: 0.92,
      };
    }
  }

  // 3. The same thread. Strong, and not certain: people reply to the nearest
  //    email to start something new, so a thread can wander onto a second
  //    order — which is why this is below a reference and not equal to it.
  if (message.threadId) {
    const byThread = orders.filter((order) => order.threads.includes(message.threadId!));
    if (byThread.length === 1) {
      const order = byThread[0]!;
      // A reference that contradicts the thread wins by disagreeing: if this
      // email names an order and the thread names another, the email is about
      // what it says it is about.
      if (reference && order.reference && order.reference !== reference) {
        return {
          kind: 'unlinked',
          why: `the thread belongs to ${order.reference} and this names ${reference}`,
          candidates: [order.key],
        };
      }
      return {
        kind: 'joined',
        key: order.key,
        why: 'the same conversation',
        confidence: 0.85,
      };
    }
  }

  // 4. Nothing but the correspondent and the calendar. Deliberately not enough
  //    on its own unless there is exactly one candidate: a supplier with two
  //    open orders is the ordinary case, and guessing between them is the
  //    mistake this whole file exists to avoid.
  //
  //    And only when the message carries no reference of its own. If it names
  //    an order and that order is not here, the sender is the wrong thing to
  //    go on: the email says which order it is about, and it is not any of
  //    these. Without this guard a customer's second order was swallowed into
  //    their first — the messages come from the same address, and that was
  //    enough.
  //    Never for an order, either. An email that places an order opens one —
  //    that is what it is. Attaching it to an existing order because it came
  //    from the same address turns a customer's second request into extra
  //    items on their first, and the second request then has no order of its
  //    own to be confirmed or shipped against. Found by running the tool over
  //    a mailbox where somebody ordered twice in a week.
  const domain = domainOf(message.from);
  if (domain && !reference && reading.fact.kind !== 'order') {
    const nearby = orders.filter(
      (order) =>
        order.correspondents.includes(domain) &&
        days(order.lastSeen, message.receivedAt) <= WINDOW_DAYS
    );

    if (nearby.length === 1) {
      return {
        kind: 'joined',
        key: nearby[0]!.key,
        why: `the only open order with ${domain} in the last ${WINDOW_DAYS} days`,
        confidence: 0.72,
      };
    }
    if (nearby.length > 1) {
      return {
        kind: 'unlinked',
        why: `${nearby.length} open orders with ${domain}, and nothing here says which`,
        candidates: nearby.map((order) => order.key),
      };
    }
  }

  // 5. Nothing matched. An order email opens one; anything else is a reply to
  //    something this mailbox has not seen, and that is a fact worth stating
  //    rather than a row to invent.
  if (reading.fact.kind === 'order') {
    return {
      kind: 'opened',
      key: reference ?? `${message.threadId ?? message.id}`,
      why: reference ? `a new order, ${reference}` : 'a new order with no reference of its own',
    };
  }

  return {
    kind: 'unlinked',
    why: `a ${reading.fact.kind} about an order this mailbox has not seen`,
    candidates: [],
  };
}

/**
 * Every message, in the order they arrived, joined into orders.
 *
 * In arrival order because that is the only order the information exists in: a
 * confirmation cannot be linked to an order that has not been read yet. Sorting
 * by date first, rather than trusting the folder, is what keeps a mailbox
 * exported in a different order from producing different results.
 */
export function join(
  entries: ReadonlyArray<{ message: Message; reading: Reading }>
): { orders: Order[]; unlinked: Array<{ message: Message; reading: Reading; why: string }> } {
  const inOrder = [...entries].sort(
    (a, b) => a.message.receivedAt.getTime() - b.message.receivedAt.getTime()
  );

  const orders: Order[] = [];
  const unlinked: Array<{ message: Message; reading: Reading; why: string }> = [];

  for (const { message, reading } of inOrder) {
    // Nothing to file. An out-of-office is a real message and not part of an
    // order's history, and putting it in one makes "last event" useless.
    if (['acknowledgement', 'marketing', 'billing', 'unknown'].includes(reading.fact.kind)) {
      continue;
    }

    const outcome = decide(message, reading, orders);

    if (outcome.kind === 'unlinked' || (outcome.kind === 'joined' && outcome.confidence < SURE_ENOUGH)) {
      unlinked.push({
        message,
        reading,
        why: outcome.kind === 'unlinked' ? outcome.why : `not sure enough: ${outcome.why}`,
      });
      continue;
    }

    const domain = domainOf(message.from);
    const linked: LinkedReading = {
      messageId: message.id,
      fact: reading.fact,
      why: outcome.why,
      confidence: outcome.kind === 'joined' ? outcome.confidence : 1,
    };

    if (outcome.kind === 'opened') {
      orders.push({
        key: outcome.key,
        reference: referenceOf(reading.fact),
        supplierReference: null,
        threads: message.threadId ? [message.threadId] : [],
        correspondents: domainsOf(message),
        firstSeen: message.receivedAt,
        lastSeen: message.receivedAt,
        readings: [linked],
      });
      continue;
    }

    const at = orders.findIndex((order) => order.key === outcome.key);
    const order = orders[at]!;

    orders[at] = {
      ...order,
      // Learned as it goes: a reference or a supplier's number seen for the
      // first time in a later message makes every message after it easier to
      // place.
      reference: order.reference ?? referenceOf(reading.fact),
      supplierReference: order.supplierReference ?? supplierReferenceOf(reading.fact),
      threads:
        message.threadId && !order.threads.includes(message.threadId)
          ? [...order.threads, message.threadId]
          : order.threads,
      correspondents: [...new Set([...order.correspondents, ...domainsOf(message)])],
      lastSeen: message.receivedAt,
      readings: [...order.readings, linked],
    };
  }

  return { orders, unlinked };
}

/** Where an order has got to, from what has been read about it. */
export type Stage = 'ordered' | 'confirmed' | 'partly_confirmed' | 'refused' | 'shipped';

export function stageOf(order: Order): Stage {
  const kinds = order.readings.map((reading) => reading.fact.kind);

  if (kinds.includes('shipment')) return 'shipped';

  const confirmations = order.readings
    .map((reading) => reading.fact)
    .filter((fact): fact is Extract<Fact, { kind: 'confirmation' }> => fact.kind === 'confirmation');

  const last = confirmations[confirmations.length - 1];
  if (last) {
    if (last.status.value === 'rejected') return 'refused';
    if (last.status.value === 'partial') return 'partly_confirmed';
    return 'confirmed';
  }

  return 'ordered';
}
