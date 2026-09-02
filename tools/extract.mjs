#!/usr/bin/env node
/**
 * Reads a folder of `.eml` files and says what it made of them.
 *
 *     npm run extract                 the messages in mail/
 *     npm run extract -- path/to/dir  yours
 *     npm run extract -- --show       every field, with the text it came from
 *
 * This is the check that is **not** written behind the same door as the code.
 * The unit tests were written alongside the rules they test, which makes them
 * good at saying the rules still do what they did and blind to everything a
 * real message does differently: a header folded across three lines, a body in
 * quoted-printable, an order written as a sentence, a supplier who replies from
 * a different address. Every project in this portfolio has been caught by that
 * at least once — checks driven by the same handful of examples the code was
 * written for, all passing, while the first real input failed.
 *
 * So: point it at a folder of messages nobody here has seen. Export a thread
 * from any mail client, drop the files in, and read what comes out.
 *
 * What it reports is the outcome, because that is what matters:
 *
 *   read          understood, and attached to an order
 *   set aside     understood, and not confidently attached — a person decides
 *   ignored       an out-of-office, an invoice, a newsletter
 *   not read      nothing recognised at all
 *
 * The last one is the only failure. `set aside` is the system working: an
 * unlinked email costs somebody a minute, and a wrongly linked one is found by
 * a customer.
 *
 * Nothing is written anywhere and nothing leaves the machine.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.join(here, '..', 'packages', 'core', 'build', 'src', 'index.js');

if (!fs.existsSync(core)) {
  console.error('The core package has not been built. Run: npm run build');
  process.exit(1);
}

const { readEml, read, join, stageOf, fieldsOf } = await import(
  `file:///${core.replace(/\\/g, '/')}`
);

const args = process.argv.slice(2);
const show = args.includes('--show');
const given = args.filter((one) => !one.startsWith('--'));
const folder = given[0] ? path.resolve(given[0]) : path.join(here, '..', 'mail');

if (!fs.existsSync(folder)) {
  console.error(`There is nothing at ${folder}.`);
  process.exit(1);
}

const files = fs
  .readdirSync(folder)
  .filter((name) => name.toLowerCase().endsWith('.eml'))
  .sort();

if (files.length === 0) {
  console.error(`No .eml files in ${folder}. Export a thread from any mail client into it.`);
  process.exit(1);
}

console.log(`Reading ${files.length} messages from ${folder}\n`);

/** Domains that are suppliers, so their replies are not read as new orders. */
const SUPPLIERS = ['medisupply.example'];

const entries = files.map((name) => {
  const raw = fs.readFileSync(path.join(folder, name), 'utf8');
  const message = readEml(raw, name);
  return { name, message, reading: read(message, { supplierDomains: SUPPLIERS }) };
});

const { orders, unlinked } = join(entries.map(({ message, reading }) => ({ message, reading })));

const attachedTo = new Map();
for (const order of orders) {
  for (const linked of order.readings) attachedTo.set(linked.messageId, order);
}
const setAside = new Set(unlinked.map(({ message }) => message.id));

const IGNORED = new Set(['acknowledgement', 'billing', 'marketing']);

let notRead = 0;

console.log('What each message turned out to be');
for (const { name, message, reading } of entries) {
  const kind = reading.fact.kind;
  const order = attachedTo.get(message.id);

  let outcome;
  if (order) outcome = `read      → ${order.reference ?? order.key}`;
  else if (setAside.has(message.id)) outcome = 'set aside';
  else if (IGNORED.has(kind)) outcome = 'ignored';
  else {
    outcome = 'NOT READ ';
    notRead += 1;
  }

  console.log(`  ${outcome}  ${name}  (${kind}, ${Math.round(reading.confidence * 100)}%)`);

  for (const doubt of reading.doubts) console.log(`             doubt: ${doubt}`);

  if (show) {
    for (const { path: field, field: value } of fieldsOf(reading.fact)) {
      const written = value.value instanceof Date ? value.value.toDateString() : value.value;
      console.log(
        `             ${field} = ${written}   [${value.provenance.where} ${value.provenance.from}-${value.provenance.to} "${value.provenance.text}" via ${value.provenance.rule}]`
      );
    }
  }
}

console.log(`\nOrders rebuilt from those messages: ${orders.length}`);
for (const order of orders) {
  const when = order.firstSeen.toISOString().slice(0, 10);
  console.log(
    `\n  ${order.reference ?? order.key}  —  ${stageOf(order)}  (opened ${when}, ${order.readings.length} messages)`
  );
  for (const linked of order.readings) {
    console.log(`     ${linked.fact.kind.padEnd(13)} ${linked.why}`);
  }

  const items = order.readings
    .filter((linked) => linked.fact.kind === 'order')
    .flatMap((linked) => linked.fact.items ?? []);
  for (const item of items) {
    console.log(
      `     item          ${item.quantity.value} ${item.unit?.value ?? ''} ${item.name.value}`.replace(/\s+/g, ' ')
    );
  }
}

if (unlinked.length > 0) {
  console.log(`\nSet aside for a person: ${unlinked.length}`);
  for (const { message, why } of unlinked) {
    console.log(`  ${message.id}: ${why}`);
  }
}

console.log('');
if (notRead > 0) {
  console.log(`${notRead} of ${entries.length} messages could not be read at all.`);
  process.exit(1);
}

console.log(
  `All ${entries.length} messages accounted for: ${orders.length} orders, ${unlinked.length} for a person to look at.`
);
