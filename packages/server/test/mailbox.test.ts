import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, before } from 'node:test';

import { fieldsOf } from '@order-email/core';

import { readMailbox, summarise, type Mailbox } from '../src/mailbox.js';

/**
 * These run against the real `mail/` folder rather than against invented
 * fixtures, and that is deliberate. What `summarise` produces is the whole of
 * what the interface sees, and every mistake it has made so far was a mistake
 * about real messages: a number that was true of the join and presented as
 * though it were true of the reading, a "weakest value" that named a field
 * nothing could open.
 *
 * This suite existed as an empty folder for a while, so `npm test` on this
 * package type-checked, ran nothing, and reported success — a check that passes
 * by finding nothing, which is the worst kind.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIL = path.join(here, '..', '..', '..', '..', 'mail');

let mailbox: Mailbox;

before(async () => {
  mailbox = await readMailbox(MAIL, { supplierDomains: ['medisupply.example'] });
});

describe('reading the folder', () => {
  it('accounts for every message, in one of the three ways there are', () => {
    // Three, not two. A message either belongs to an order, or is waiting for a
    // person because nothing here says which order it belongs to, or was
    // understood and has nothing to do with an order at all — an out-of-office,
    // a piece of marketing. Written as two, this test failed on the
    // out-of-office and the test was the thing that was wrong.
    //
    // What it is really guarding is that nothing falls through in silence.
    const NOTHING_TO_DO = ['acknowledgement', 'billing', 'marketing', 'unknown'];

    const attached = new Set(
      mailbox.orders.flatMap((order) => order.readings.map((linked) => linked.messageId))
    );
    const waiting = new Set(mailbox.unlinked.map((one) => one.message.id));

    for (const entry of mailbox.entries) {
      assert.ok(
        attached.has(entry.file) ||
          waiting.has(entry.file) ||
          NOTHING_TO_DO.includes(entry.reading.fact.kind),
        `${entry.file} was read as ${entry.reading.fact.kind} and then went nowhere`
      );
    }
  });

  it('leaves a shipment for an order nobody placed to a person', () => {
    // The message a system that guesses would file against the nearest order,
    // quietly corrupting it. Declining is the behaviour, not a gap in it.
    assert.ok(
      mailbox.unlinked.some((one) => one.message.id === '09-shipment-nobody-can-place.eml'),
      'a shipment for an unknown order was attached to something'
    );
  });
});

describe('what the interface is told about an order', () => {
  it('answers the two questions separately', () => {
    for (const order of mailbox.orders) {
      const said = summarise(order);
      assert.equal(typeof said.joined, 'number', `${said.key} has no join confidence`);
      assert.equal(typeof said.read, 'number', `${said.key} has no reading confidence`);
    }
  });

  it('does not call an order with no reference of its own a certain reading', () => {
    // The defect this pair of numbers exists to prevent. Reporting the join
    // alone put "100%, read outright" on the most fragile order in the mailbox,
    // because nothing had been joined onto it wrongly, having never been joined
    // at all.
    const orphan = mailbox.orders.find((order) => order.reference === null);
    assert.ok(orphan, 'the mailbox no longer contains an order without a reference');

    const said = summarise(orphan);
    assert.ok(
      said.read < 1,
      `an order held together by sender and thread reported ${said.read} on its values`
    );
  });

  it('reports the WEAKEST value it read, not an average of them', () => {
    for (const order of mailbox.orders) {
      const said = summarise(order);

      const every = order.readings.flatMap((linked) =>
        fieldsOf(linked.fact).map(({ field }) => field.confidence)
      );

      if (every.length === 0) continue;
      assert.equal(
        said.read,
        Math.min(...every),
        `${said.key} reported ${said.read} with a field at ${Math.min(...every)}`
      );
    }
  });

  it('names the least certain value, and a message somebody can open to check it', () => {
    for (const order of mailbox.orders) {
      const said = summarise(order);
      if (!said.weakest) continue;

      assert.equal(
        said.weakest.confidence,
        said.read,
        `${said.key} points at a value that is not its weakest`
      );

      assert.ok(
        mailbox.entries.some((entry) => entry.file === said.weakest!.file),
        `${said.key} points at ${said.weakest.file}, which is not in the folder`
      );
    }
  });

  it('every span points at the words it says it does', () => {
    /*
     * The invariant the interface rests on, asserted over the real folder.
     *
     * A field carries offsets and the text it read; the interface is sent the
     * subject and the body and highlights those offsets in them. If the two
     * disagree by one character the mark lands on the wrong words — and it
     * still looks like a working feature, which is what makes it worth a check
     * rather than a comment.
     *
     * It is not hypothetical. The rules measure the body with quoted replies
     * removed, while the message carries them whole; today that only ever
     * differs by a trailing newline, so nothing moves. A message opening with a
     * blank line would shift every mark in it, and this is what would say so.
     */
    for (const entry of mailbox.entries) {
      for (const { path: which, field } of fieldsOf(entry.reading.fact)) {
        const part = field.provenance.where === 'subject' ? entry.message.subject : entry.message.body;
        const atTheOffsets = part.slice(field.provenance.from, field.provenance.to);

        assert.equal(
          atTheOffsets,
          field.provenance.text,
          `${entry.file} ${which}: the offsets point at ${JSON.stringify(atTheOffsets)}, ` +
            `and the field says it read ${JSON.stringify(field.provenance.text)}`
        );
      }
    }
  });

  it('carries a date as something JSON can hold', () => {
    // `summarise` is serialised straight to the client. A Date that arrives as
    // an empty object is a field that silently disappears from the screen.
    for (const order of mailbox.orders) {
      const said = summarise(order);
      const roundTripped = JSON.parse(JSON.stringify(said));

      if (said.eta) assert.equal(typeof roundTripped.eta, 'string');
      if (said.weakest?.value instanceof Date) {
        assert.fail(`${said.key} would send a Date object as the weakest value`);
      }
    }
  });
});
