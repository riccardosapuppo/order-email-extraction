/**
 * The HTTP interface: the orders, and the emails they were read out of.
 *
 * Four endpoints, and the fourth is the one this project exists for. A list of
 * orders is what every system of this kind shows. `GET /api/messages/:file`
 * returns the message *with the spans that were read out of it*, so the
 * interface can show somebody the sentence a quantity came from rather than
 * asking them to take it on trust.
 *
 * Everything is derived from the folder on every request against a snapshot
 * taken at startup. `POST /api/reload` takes a new one — which is the whole of
 * the write surface, because nothing here owns any state worth keeping.
 */

import express, { type Express } from 'express';

import { fieldsOf } from '@order-email/core';

import { mailboxOf, readMailbox, summarise, type Mailbox, type Settings } from './mailbox.js';
import type { Source } from './source.js';

export interface Options {
  /** A folder of .eml files, when there is no source. Kept for the tests. */
  readonly folder?: string;

  /** Where the mail comes from: a folder, or an IMAP mailbox. */
  readonly source?: Source;

  readonly settings: Settings;
}

/** The app, and the way to make it fetch again. */
export interface Service {
  readonly api: Express;
  reload(): Promise<Mailbox>;
}

export function build({ folder, source, settings }: Options): Service {
  // Something to answer with before anything has been fetched. Fetching over
  // IMAP is a round trip, and a server that refuses every request until the
  // first sync finishes is a server that looks broken while it is working.
  let mailbox: Mailbox = folder && !source ? readMailbox(folder, settings) : empty(source?.describes ?? folder ?? '');

  /** Fetch, and replace the snapshot. Never leaves a half-read mailbox behind. */
  async function reload(): Promise<Mailbox> {
    if (!source) {
      mailbox = readMailbox(folder ?? '.', settings);
      return mailbox;
    }

    const { raws, from } = await source.load();
    mailbox = mailboxOf(raws, settings, from);
    return mailbox;
  }

  const api = express();
  api.disable('x-powered-by');
  api.use(express.json({ limit: '100kb' }));

  api.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      folder: mailbox.folder,
      readAt: mailbox.readAt,
      messages: mailbox.entries.length,
      orders: mailbox.orders.length,
      forAPerson: mailbox.unlinked.length,
    });
  });

  /** Every order the mailbox has revealed. */
  api.get('/api/orders', (req, res) => {
    res.json({
      readAt: mailbox.readAt,
      orders: mailbox.orders.map(summarise),
    });
  });

  /**
   * One order, with every message attached to it and why each was attached.
   *
   * The "why" travels with the order rather than being reconstructible from
   * it: "the same reference, 4471" and "the only open order with that supplier
   * in the last 90 days" are very different grounds for believing a shipment
   * belongs here, and somebody checking needs to be told which it was.
   */
  api.get('/api/orders/:key', (req, res) => {
    const order = mailbox.orders.find((one) => one.key === req.params.key);
    if (!order) return res.status(404).json({ error: 'no such order' });

    res.json({
      order: summarise(order),
      messages: order.readings.map((linked) => {
        const entry = mailbox.entries.find((one) => one.message.id === linked.messageId);
        return {
          file: linked.messageId,
          kind: linked.fact.kind,
          why: linked.why,
          confidence: linked.confidence,
          from: entry?.message.from ?? null,
          subject: entry?.message.subject ?? '',
          receivedAt: entry?.message.receivedAt ?? null,
          doubts: entry?.reading.doubts ?? [],
        };
      }),
    });
  });

  /**
   * A message, and where each value in it came from.
   *
   * The spans are sent as offsets into the subject and the body, along with
   * both, so the interface can highlight rather than search — searching for
   * the text again would find the second occurrence as happily as the first.
   */
  api.get('/api/messages/:file', (req, res) => {
    const entry = mailbox.entries.find((one) => one.file === req.params.file);
    if (!entry) return res.status(404).json({ error: 'no such message' });

    res.json({
      file: entry.file,
      from: entry.message.from,
      to: entry.message.to,
      subject: entry.message.subject,
      receivedAt: entry.message.receivedAt,
      body: entry.message.body,
      attachments: entry.message.attachments,

      kind: entry.reading.fact.kind,
      confidence: entry.reading.confidence,
      because: entry.reading.because,
      doubts: entry.reading.doubts,

      fields: fieldsOf(entry.reading.fact).map(({ path, field }) => ({
        path,
        value: field.value instanceof Date ? field.value.toISOString() : field.value,
        confidence: field.confidence,
        where: field.provenance.where,
        from: field.provenance.from,
        to: field.provenance.to,
        text: field.provenance.text,
        rule: field.provenance.rule,
      })),
    });
  });

  /** Everything the system would not attach to an order by itself. */
  api.get('/api/for-a-person', (req, res) => {
    res.json({
      messages: mailbox.unlinked.map(({ message, reading, why }) => ({
        file: message.id,
        subject: message.subject,
        from: message.from,
        receivedAt: message.receivedAt,
        kind: reading.fact.kind,
        why,
      })),
    });
  });

  api.post('/api/reload', (req, res, next) => {
    reload().then(
      () => res.json({ readAt: mailbox.readAt, messages: mailbox.entries.length, orders: mailbox.orders.length }),
      // A failed fetch leaves the previous snapshot in place, and says so.
      // Emptying the orders because a mailbox was briefly unreachable would
      // be the worst of both: no data, and no explanation.
      (error: Error) =>
        res.status(502).json({
          error: 'the mail could not be fetched',
          detail: error.message,
          still_showing: mailbox.readAt,
        })
    );
  });

  api.use((req, res) => {
    res.status(404).json({
      error: 'no such endpoint',
      you_asked_for: `${req.method} ${req.originalUrl}`,
      the_api_starts_at: '/api',
    });
  });

  api.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('unhandled:', error.message);
    if (res.headersSent) return next(error);
    res.status(500).json({ error: 'something went wrong here' });
  });

  return { api, reload };
}

/**
 * A mailbox with nothing in it, for the moment before the first fetch.
 *
 * Not null, and not a thrown error: every endpoint reads the same shape, and
 * one that has to check for absence is one that will forget to.
 */
function empty(from: string): Mailbox {
  return { folder: from, readAt: new Date(0), entries: [], orders: [], unlinked: [] };
}
