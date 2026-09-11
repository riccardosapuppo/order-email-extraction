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

import { theRules, type Reader } from '@order-email/core';

import { mailboxOf, readMailbox, summarise, type Mailbox, type Settings } from './mailbox.js';
import { theModel, whyNotAModel } from './model/claude.js';
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
  /*
   * Something to answer with before anything has been read.
   *
   * It used to read the folder here, synchronously, when there was no source.
   * Reading is asynchronous now -- a model reader crosses a network per message
   * -- so there is one path for everybody: empty until `reload()` has been
   * awaited. `main.ts` awaits it before it listens, so nothing is served from
   * this placeholder in normal use; a test that builds the service and asks
   * immediately gets an empty mailbox rather than a half-read one.
   */
  let mailbox: Mailbox = empty(source?.describes ?? folder ?? '');

  /*
   * Which reader is running, and it can change while it runs.
   *
   * It used to be fixed at startup by a flag. That made the second reader
   * something you had to already know about and restart to try -- which is the
   * same as not having it, for anybody who opens this to see what it does. The
   * screen at /reading switches it.
   *
   * The key lives here, in a closure, for the life of this process. It is never
   * written to disk, never logged, never sent back, and never put in a URL. The
   * server binds to 127.0.0.1, so the only thing that can post one is something
   * already on this machine.
   */
  let reader: Reader = settings.reader ?? theRules({ supplierDomains: settings.supplierDomains });
  const reading = (): Settings => ({ ...settings, reader });

  /** Fetch, and replace the snapshot. Never leaves a half-read mailbox behind. */
  async function reload(): Promise<Mailbox> {
    if (!source) {
      mailbox = await readMailbox(folder ?? '.', reading());
      return mailbox;
    }

    const { raws, from } = await source.load();
    mailbox = await mailboxOf(raws, reading(), from);
    return mailbox;
  }

  const api = express();
  api.disable('x-powered-by');
  api.use(express.json({ limit: '100kb' }));

  api.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',

      /*
       * Which program this is, and not only that something answered.
       *
       * 3200 is a port like any other and the next thing to take it will also
       * answer `{"status":"ok"}`. `npm start` stops what is on its ports only
       * when what is on them says this — so a leftover of this project is
       * cleared and a stranger is left alone and named. See tools/lib/ports.mjs.
       */
      what: 'order-email-extraction',

      /*
       * Who is reading, on every screen rather than on one.
       *
       * Which reader is in use was visible only in the README and in the flag
       * that chooses it: somebody looking at the running thing could not tell
       * that a model was an option at all, and the values only name a model
       * once one has actually read something -- so the option was invisible
       * precisely to whoever had not already found it. The shell asks for this
       * at startup and says it in the header, beside which mailbox is being
       * read, which is the other question of the same kind.
       */
      readBy: reader.describes,
      readerName: reader.name,
      couldBeAModel: reader.name === 'rules',
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

  /**
   * Switch reader, and read the mailbox again with it.
   *
   * The whole of the write surface, along with reload, and it owns nothing: the
   * answer is recomputed from the mail either way. Switching back to the rules
   * forgets the key.
   */
  api.post('/api/reader', (req, res) => {
    const asked = req.body as { reader?: unknown; key?: unknown; model?: unknown };
    const which = asked.reader === 'model' ? 'model' : asked.reader === 'rules' ? 'rules' : null;

    if (!which) {
      return res.status(400).json({ error: 'reader is "rules" or "model"' });
    }

    if (which === 'rules') {
      reader = theRules({ supplierDomains: settings.supplierDomains });
      return reread(res);
    }

    const key = typeof asked.key === 'string' && asked.key.trim() !== '' ? asked.key.trim() : undefined;
    const model = typeof asked.model === 'string' && asked.model.trim() !== '' ? asked.model.trim() : undefined;
    const why = whyNotAModel(key ? { key } : {});

    if (why) {
      // Said in words rather than as a code, because this answer is shown to a
      // person on the screen that asked the question.
      return res.status(400).json({ error: why });
    }

    reader = theModel({ ...(key ? { key } : {}), ...(model ? { model } : {}) });
    return reread(res);
  });

  /** Read it all again, and say what that produced. Never says the key. */
  function reread(res: express.Response) {
    return reload().then(
      () => {
        /*
         * A reader that could not read a single message is a broken reader, not
         * a quiet mailbox.
         *
         * The model reader turns a refusal from the API into one unread message
         * with the reason in its doubts, which is right: one message failing
         * should not empty the mailbox. But a wrong key fails all of them, and
         * without this the screen would report a successful switch to a reader
         * that had produced no orders at all -- and the reason, which the API
         * actually gave, would be buried eleven times over in a list nobody
         * opens next.
         */
        const couldNot = mailbox.entries.filter((one) =>
          one.reading.doubts.some((doubt) => doubt.includes('could not read this message'))
        );

        if (mailbox.entries.length > 0 && couldNot.length === mailbox.entries.length) {
          const said = couldNot[0]?.reading.doubts.find((doubt) => doubt.includes('could not read this message')) ?? '';
          reader = theRules({ supplierDomains: settings.supplierDomains });

          return reload().then(() =>
            res.status(502).json({
              error: 'that reader could not read anything, so the rules are reading again',
              detail: said.replace(/^.*could not read this message: /, ''),
            })
          );
        }

        return res.json({
          readBy: reader.describes,
          readerName: reader.name,
          couldBeAModel: reader.name === 'rules',
          readAt: mailbox.readAt,
          messages: mailbox.entries.length,
          orders: mailbox.orders.length,
          forAPerson: mailbox.unlinked.length,

          /*
           * What the reader would not stand behind, counted.
           *
           * The number worth showing when a model has just read the mailbox: a
           * doubt is a value it produced whose words were not in the message,
           * or a line it could not complete. The rules produce doubts too, of a
           * different kind, so this is comparable between the two.
           */
          doubts: mailbox.entries.reduce((all, one) => all + one.reading.doubts.length, 0),
        });
      },
      (error: Error) => {
        // Back to the reader that was working, rather than leaving a screen
        // that cannot read anything.
        reader = theRules({ supplierDomains: settings.supplierDomains });
        res.status(502).json({ error: 'reading with that failed', detail: error.message });
      }
    );
  }

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
