/**
 * The mailbox, read into orders.
 *
 * There is no database here, and that is the argument rather than a shortcut.
 * In this system the email **is** the record: every field an order carries can
 * be traced to a span of a message, and the orders are a projection of the
 * mailbox rather than a second copy of the truth. Reading the folder at
 * startup, and again when asked, keeps that honest — nothing can drift,
 * because there is nothing to drift from.
 *
 * The original stored the LLM's output in Postgres and then had to keep the
 * two in step: `llm_status`, `llm_retry_after`, `sync_forzata_prenotazioni`,
 * a nightly job to re-run what had failed. Most of that machinery exists to
 * repair a copy. Without the copy, it is not needed.
 *
 * What that costs, said plainly: this does not scale past a folder somebody
 * can hold, there is nowhere to record a human decision ("this shipment does
 * belong to that order"), and every restart re-reads everything. A real
 * deployment needs a store for the decisions people make — not for the facts,
 * which stay in the mail.
 */

import fs from 'node:fs';
import path from 'node:path';

import { fieldsOf, join, read, readEml, stageOf } from '@order-email/core';
import type { Message, Order, Reading } from '@order-email/core';

export interface Entry {
  readonly file: string;
  readonly message: Message;
  readonly reading: Reading;
}

export interface Mailbox {
  readonly folder: string;
  readonly readAt: Date;
  readonly entries: readonly Entry[];
  readonly orders: readonly Order[];
  readonly unlinked: ReadonlyArray<{ message: Message; reading: Reading; why: string }>;
}

export interface Settings {
  /** Domains that are suppliers, so their replies are not read as new orders. */
  readonly supplierDomains: readonly string[];
}

/**
 * Reads every `.eml` in a folder.
 *
 * A file that cannot be read does not stop the others. A mailbox is somebody
 * else's export and one malformed message in it is ordinary; refusing the
 * whole folder because of one is the kind of strictness that gets a tool
 * abandoned. The failure is kept and reported rather than swallowed.
 */
export function readMailbox(folder: string, settings: Settings): Mailbox {
  const full = path.resolve(folder);

  const files = fs
    .readdirSync(full)
    .filter((name) => name.toLowerCase().endsWith('.eml'))
    .sort();

  return mailboxOf(
    files.map((name) => ({ name, raw: readOrExplain(path.join(full, name)) })),
    settings,
    full
  );
}

/** One message as it arrived, with a name to call it by. */
export interface Raw {
  readonly name: string;
  /** The message, or an Error if fetching this one failed. */
  readonly raw: string | Error;
}

/**
 * Raw messages into orders, whatever fetched them.
 *
 * A folder of `.eml` files and an IMAP account are two different problems with
 * two different failure modes, and neither of them is what this project is
 * about. They are adapters; this is where what they produce becomes the same
 * thing, and the only place that knows how a message becomes an order.
 */
export function mailboxOf(raws: readonly Raw[], settings: Settings, from: string): Mailbox {
  const entries: Entry[] = [];

  for (const { name: file, raw } of raws) {
    try {
      if (raw instanceof Error) throw raw;

      const message = readEml(raw, file);
      entries.push({
        file,
        message,
        reading: read(message, { supplierDomains: settings.supplierDomains }),
      });
    } catch (error) {
      entries.push({
        file,
        message: unreadable(file),
        reading: {
          messageId: file,
          fact: { kind: 'unknown' },
          confidence: 0,
          because: [],
          doubts: [`this file could not be read: ${(error as Error).message}`],
        },
      });
    }
  }

  const { orders, unlinked } = join(entries.map(({ message, reading }) => ({ message, reading })));

  return { folder: from, readAt: new Date(), entries, orders, unlinked };
}

/**
 * A file that will not open is one bad message, not a bad mailbox.
 *
 * The error is carried through as a value rather than thrown, so it becomes the
 * `doubts` line on one entry instead of ending the read. A mailbox is somebody
 * else's export and one malformed message in it is ordinary.
 */
function readOrExplain(file: string): string | Error {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    return error as Error;
  }
}

function unreadable(file: string): Message {
  return {
    id: file,
    from: { email: '' },
    to: [],
    subject: '',
    receivedAt: new Date(0),
    body: '',
    attachments: [],
  };
}

/** An order with the things a list needs, worked out once. */
export function summarise(order: Order) {
  const items = order.readings
    .filter((linked) => linked.fact.kind === 'order')
    .flatMap((linked) => (linked.fact.kind === 'order' ? linked.fact.items : []));

  const shipment = order.readings
    .map((linked) => linked.fact)
    .reverse()
    .find((fact) => fact.kind === 'shipment');

  const confirmation = order.readings
    .map((linked) => linked.fact)
    .reverse()
    .find((fact) => fact.kind === 'confirmation');

  return {
    key: order.key,
    reference: order.reference,
    stage: stageOf(order),
    correspondents: order.correspondents,
    firstSeen: order.firstSeen,
    lastSeen: order.lastSeen,
    messages: order.readings.length,

    items: items.map((item) => ({
      name: item.name.value,
      quantity: item.quantity.value,
      unit: item.unit?.value ?? null,
      confidence: Math.min(item.name.confidence, item.quantity.confidence),
    })),

    eta: confirmation?.kind === 'confirmation' ? (confirmation.eta?.value ?? null) : null,
    supplierReference: order.supplierReference,
    carrier: shipment?.kind === 'shipment' ? (shipment.carrier?.value ?? null) : null,
    tracking: shipment?.kind === 'shipment' ? (shipment.tracking?.value ?? null) : null,

    /**
     * Two numbers, because there are two questions, and collapsing them into
     * one is the habit this whole project is against.
     *
     *   `joined`  — is this the right order? How sure the system is that these
     *               emails belong together.
     *   `read`    — are these the right values? The weakest field in any of
     *               them.
     *
     * Each is the WEAKEST link and not the average, which would let one certain
     * value hide three guesses.
     *
     * They were one number for a while and it was wrong twice over. Reporting
     * only the join put "100%, read outright" beside the one order in the
     * mailbox with no reference of its own — the most fragile order on the
     * screen, presented as certain, because nothing had been joined onto it
     * wrongly, having never been joined at all. Then taking the minimum of both
     * marked every order in the mailbox as doubtful, because one date read at
     * 0.6 dragged an otherwise solid order under the line. A screen on which
     * everything is flagged says nothing.
     *
     * A person needs to look if either is low, and needs to know WHICH — the
     * two failures are repaired differently.
     */
    joined: order.readings.reduce((lowest, linked) => Math.min(lowest, linked.confidence), 1),

    read: order.readings.reduce(
      (lowest, linked) =>
        fieldsOf(linked.fact).reduce(
          (weakest, { field }) => Math.min(weakest, field.confidence),
          lowest
        ),
      1
    ),

    /**
     * The single value most worth checking, and which message to check it in.
     *
     * This replaced a card labelled "doubts" that listed the grounds each email
     * was joined on — "the same reference, 4471" and so on. Those are reasons to
     * be confident, printed under a heading that said the opposite, and they
     * repeated a column of the table below them. A heading that contradicts what
     * is under it is worse than no heading.
     *
     * What a person actually wants from this screen is where to look first.
     */
    weakest: weakestOf(order),
  };
}

function weakestOf(order: Order) {
  let worst: { path: string; value: unknown; confidence: number; file: string; rule: string } | null =
    null;

  for (const linked of order.readings) {
    for (const { path, field } of fieldsOf(linked.fact)) {
      if (worst && field.confidence >= worst.confidence) continue;
      worst = {
        path,
        value: field.value instanceof Date ? field.value.toISOString() : field.value,
        confidence: field.confidence,
        file: linked.messageId,
        rule: field.provenance.rule,
      };
    }
  }

  return worst;
}
