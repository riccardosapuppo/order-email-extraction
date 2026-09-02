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

import { join, read, readEml, stageOf } from '@order-email/core';
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

  const entries: Entry[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(full, file), 'utf8');
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

  return { folder: full, readAt: new Date(), entries, orders, unlinked };
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
     * The weakest link in the chain, which is what decides whether a person
     * should look — not the average, which would let one certain field hide
     * three guesses.
     */
    confidence: order.readings.reduce((lowest, linked) => Math.min(lowest, linked.confidence), 1),

    /** Every doubt anything raised about it, so they are in one place. */
    doubts: order.readings.flatMap((linked) => [`${linked.fact.kind}: ${linked.why}`]),
  };
}
