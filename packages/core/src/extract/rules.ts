/**
 * Reading an email, with rules.
 *
 * Rules and not a model, and that is a decision rather than a stage this has
 * not reached. Three reasons, in the order they matter:
 *
 *   1. **It runs.** Whoever clones this gets working extraction with no key,
 *      no account and no bill. A demonstration that needs a credential before
 *      it does anything is a demonstration nobody runs.
 *   2. **It can be checked.** A rule that reads a purchase-order number can be
 *      pointed at the character it read it from. "The model said so" cannot,
 *      and the whole argument of this project is that an extracted field has
 *      to carry where it came from.
 *   3. **It fails visibly.** A rule that does not match returns nothing, and
 *      nothing is a state the rest of the system already handles. A model asked
 *      for a purchase-order number returns a plausible one whether or not the
 *      email has one, and that failure is silent — which is the expensive kind.
 *
 * The interface is one function, so a model-backed reader is a second file and
 * no change to anything else. That is the point of putting the boundary here,
 * and `Reader` in `read.ts` is one method wide for the same reason.
 *
 * These rules are tuned to the sample messages in `mail/`, and they will not
 * survive everything a real mailbox contains. That is written down rather than
 * discovered: `tools/extract.mjs` exists to point them at messages nobody here
 * has seen, and to report what they made of them.
 */

import type { Fact, Item, Kind, Reading } from '../facts.js';
import type { Message } from '../message.js';
import { domainOf, withoutQuoted } from '../message.js';
import { firstHit, fromHit, hits, lineAround } from './found.js';

/**
 * What the message is.
 *
 * Ordered on purpose, and the order encodes what is expensive to get wrong.
 * An automatic acknowledgement is checked before an order because "your order
 * has been received" contains the word order and is not one — reading it as an
 * order books the same goods twice, and nobody notices until they arrive.
 */
const KINDS: Array<{ kind: Kind; pattern: RegExp; rule: string }> = [
  {
    kind: 'acknowledgement',
    rule: 'automatic-reply',
    pattern:
      /\b(out of office|automatic reply|autoreply|do not reply|this is an automated|delivery status notification|read receipt)\b/i,
  },
  {
    kind: 'billing',
    rule: 'invoice-or-statement',
    pattern: /\b(invoice|statement of account|remittance|credit note|vat)\b/i,
  },
  {
    kind: 'marketing',
    rule: 'unsubscribe-footer',
    pattern: /\b(unsubscribe|newsletter|special offer|this month'?s deals|view in browser)\b/i,
  },
  {
    kind: 'shipment',
    rule: 'dispatch-language',
    pattern:
      /\b(dispatch(ed)?|shipped|shipment|on its way|tracking (number|no|ref)|consignment|courier|delivery note)\b/i,
  },
  {
    kind: 'confirmation',
    rule: 'supplier-reply',
    pattern:
      /\b(order (confirmation|confirmed|acknowledg)|we (can|will) (supply|deliver)|expected (delivery|despatch)|lead time|back ?order|out of stock|unable to supply)\b/i,
  },
  {
    kind: 'order',
    rule: 'order-language',
    pattern:
      /\b(please (send|supply|deliver|order)|we (need|require|would like)|purchase order|p\.?o\.? ?(number|no|ref)|can you (send|supply)|order the following|kindly (send|supply))\b/i,
  },
];

/** A purchase-order reference, in the shapes people write them. */
const REFERENCE =
  /\b(?:P\.?O\.?|purchase order|order|ref(?:erence)?|our order)\s*(?:number|no\.?|#|ref\.?)?\s*[:\-]?\s*([A-Z]{0,4}[-/ ]?\d{3,10}(?:[-/]\d{1,4})?)\b/i;

/** A supplier's own number for the same order. */
const SUPPLIER_REFERENCE =
  /\b(?:your (?:order|ref(?:erence)?)|our (?:order|reference|job)|sales order|SO)\s*(?:number|no\.?|#)?\s*[:\-]?\s*([A-Z]{0,4}[-/ ]?\d{3,10})\b/i;

const TRACKING =
  /\b(?:tracking|consignment|awb|waybill)\s*(?:number|no\.?|#|ref\.?)?\s*[:\-]?\s*([A-Z0-9]{6,25})\b/i;

const CARRIER = /\b(dhl|ups|fedex|tnt|gls|dpd|royal mail|parcelforce|bartolini|sda|brt)\b/i;

/** A delivery note number, which is not the same thing as a tracking number. */
const DELIVERY_NOTE =
  /\b(?:delivery note|despatch note|ddt|packing (?:slip|list))\s*(?:number|no\.?|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/-]{2,20})\b/i;

/**
 * A line of an order.
 *
 * Two shapes, because people write both and the difference is only in which
 * side the number is on:
 *
 *     12 x blue nitrile gloves, medium
 *     blue nitrile gloves, medium - qty 12
 *
 * A quantity with no unit is a count. A unit is kept when it is written,
 * because "2 boxes" and "2" are different orders and the difference is not
 * recoverable later.
 */
const LINE_LEADING = /^\s*[-*•]?\s*(\d{1,4})\s*(?:x|×|\bpcs?\b|\bpieces?\b)?\s+(.{3,90}?)\s*$/;
const LINE_TRAILING =
  /^\s*[-*•]?\s*(.{3,90}?)[,;\s]+(?:qty|quantity|amount|n\.?)\s*[:\-]?\s*(\d{1,4})\s*$/i;

/**
 * A quantity and a thing, written inside a sentence.
 *
 * "Please send 12 x gloves and 4 boxes of wipes." is how most of a real
 * mailbox is written, and reading only lines that are *nothing but* an item
 * finds none of it. This was found by a test asserting the obvious sentence
 * and getting an order with no lines in it.
 *
 * Narrower than the line patterns on purpose. It requires the explicit "x", or
 * a unit word, so that "12 September" and "PO 4471" are not read as
 * quantities: inside a sentence there is no line structure left to lean on,
 * and the cost of a wrong item is somebody being sent twelve of something.
 */
const INLINE = new RegExp(
  String.raw`\b(\d{1,4})\s*(?:x|×)\s*([a-z][\w'’\- ]{2,50}?)(?=[.,;]|\band\b|$)` +
    String.raw`|\b(\d{1,4})\s+((?:box(?:es)?|pack(?:s|ets?)?|case(?:s)?|bottle(?:s)?|carton(?:s)?|roll(?:s)?|pair(?:s)?)\s+of\s+[a-z][\w'’\- ]{2,40}?)(?=[.,;]|\band\b|$)`,
  'gi'
);

const UNIT =
  /\b(box(?:es)?|pack(?:s|ets?)?|case(?:s)?|bottle(?:s)?|carton(?:s)?|roll(?:s)?|pair(?:s)?|litre(?:s)?|l|kg|g|ml|unit(?:s)?)\b/i;

const URGENT = /\b(urgent|asap|as soon as possible|immediately|today|by tomorrow|priority)\b/i;
const RELAXED = /\b(no rush|whenever|next month|not urgent|when convenient)\b/i;

const STATUS: Array<{ status: 'accepted' | 'partial' | 'rejected' | 'delayed'; pattern: RegExp }> = [
  { status: 'rejected', pattern: /\b(unable to supply|cannot supply|discontinued|no longer available|out of stock)\b/i },
  { status: 'partial', pattern: /\b(part(ial|ly)|some items|the rest (to )?follow|remainder|back ?order)\b/i },
  { status: 'delayed', pattern: /\b(delay(ed)?|later than|put back|postponed|lead time of)\b/i },
  { status: 'accepted', pattern: /\b(confirm(ed|ing)?|accepted|we (can|will) (supply|deliver)|in stock|on its way)\b/i },
];

/** A date somebody wrote for a person to read. */
const DATE =
  /\b(\d{1,2})[\/. -](\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\/. -](\d{2,4})\b/i;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function readDate(written: string): Date | null {
  const match = DATE.exec(written);
  if (!match) return null;

  const day = Number(match[1]);
  const monthText = String(match[2]).toLowerCase();
  const month = /^\d+$/.test(monthText) ? Number(monthText) - 1 : MONTHS[monthText.slice(0, 3)];
  let year = Number(match[3]);
  if (year < 100) year += 2000;

  if (month === undefined || Number.isNaN(day) || Number.isNaN(year)) return null;

  const made = new Date(year, month, day);
  // Day and month the wrong way round is the classic, and a date that rolls
  // over — 31 April becoming 1 May — is the sign of it. Refused rather than
  // accepted a day out.
  if (made.getDate() !== day || made.getMonth() !== month) return null;
  return made;
}

export interface ReadOptions {
  /** Domains that are suppliers rather than customers, for telling replies apart. */
  readonly supplierDomains?: readonly string[];
}

/** What this email appears to be, and what can be read out of it. */
export function read(message: Message, options: ReadOptions = {}): Reading {
  const body = withoutQuoted(message.body);
  const subject = message.subject ?? '';
  const both = `${subject}\n${body}`;

  const because: string[] = [];
  const doubts: string[] = [];

  const kind = classify(both, message, options, because);

  if (kind === 'order') {
    return asOrder(message, subject, body, because, doubts);
  }
  if (kind === 'confirmation') {
    return asConfirmation(message, subject, body, because, doubts);
  }
  if (kind === 'shipment') {
    return asShipment(message, subject, body, because, doubts);
  }

  return {
    messageId: message.id,
    fact: { kind },
    confidence: kind === 'unknown' ? 0.2 : 0.7,
    because,
    doubts,
  };
}

function classify(
  text: string,
  message: Message,
  options: ReadOptions,
  because: string[]
): Kind {
  for (const candidate of KINDS) {
    const hit = firstHit(text, candidate.pattern);
    if (!hit) continue;

    because.push(`${candidate.kind}: "${hit.text.trim()}" (${candidate.rule})`);

    // A supplier saying "please send" is confirming, not ordering. Without
    // this, every reply from a supplier that quotes the request back reads as
    // a second order for the same goods.
    if (candidate.kind === 'order' && isSupplier(message, options)) {
      because.push(`from a supplier domain, so read as a reply rather than an order`);
      return 'confirmation';
    }

    return candidate.kind;
  }

  because.push('nothing recognised');
  return 'unknown';
}

function isSupplier(message: Message, options: ReadOptions): boolean {
  const from = domainOf(message.from);
  return (options.supplierDomains ?? []).some((domain) => domain.toLowerCase() === from);
}

function referenceOf(subject: string, body: string, pattern: RegExp, rule: string) {
  const inSubject = firstHit(subject, pattern);
  if (inSubject) {
    // A reference in the subject line is the strongest signal there is: people
    // put it there so the reply threads, and it survives quoting intact.
    return fromHit(clean(inSubject.groups[0] ?? ''), 0.95, 'subject' as const, inSubject, rule);
  }

  const inBody = firstHit(body, pattern);
  if (inBody) return fromHit(clean(inBody.groups[0] ?? ''), 0.8, 'body' as const, inBody, rule);

  return undefined;
}

function clean(reference: string): string {
  return reference.trim().replace(/\s+/g, '').toUpperCase();
}

/** Items written inside a sentence, with offsets into the whole body. */
function inlineItems(line: string, start: number): Item[] {
  const found: Item[] = [];

  for (const match of line.matchAll(INLINE)) {
    if (match.index === undefined) continue;

    // Two alternatives in one pattern: "12 x gloves" and "4 boxes of wipes".
    const quantityText = match[1] ?? match[3] ?? '';
    const nameText = (match[2] ?? match[4] ?? '').trim();
    if (!quantityText || nameText.length < 3) continue;

    const quantity = Number(quantityText);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    const nameAt = line.indexOf(nameText, match.index);
    const quantityAt = line.indexOf(quantityText, match.index);
    const unitHit = firstHit(nameText, UNIT);

    found.push({
      name: fromHit(
        nameText,
        // Lower than a list line, and deliberately so. A sentence has no
        // structure to lean on, so this is the reading most likely to be
        // wrong — and the number is what decides whether a person looks.
        0.65,
        'body',
        {
          text: nameText,
          from: start + (nameAt === -1 ? match.index : nameAt),
          to: start + (nameAt === -1 ? match.index + match[0].length : nameAt + nameText.length),
          groups: [],
        },
        'quantity-inside-a-sentence'
      ),
      quantity: fromHit(
        quantity,
        0.8,
        'body',
        {
          text: quantityText,
          from: start + (quantityAt === -1 ? match.index : quantityAt),
          to:
            start +
            (quantityAt === -1 ? match.index + quantityText.length : quantityAt + quantityText.length),
          groups: [],
        },
        'quantity-inside-a-sentence'
      ),
      ...(unitHit
        ? {
            unit: fromHit(
              unitHit.text.toLowerCase(),
              0.7,
              'body',
              {
                ...unitHit,
                from: start + (nameAt === -1 ? match.index : nameAt) + unitHit.from,
                to: start + (nameAt === -1 ? match.index : nameAt) + unitHit.to,
              },
              'unit-word'
            ),
          }
        : {}),
    });
  }

  return found;
}

function itemsIn(body: string, doubts: string[]): Item[] {
  const items: Item[] = [];
  let offset = 0;

  for (const line of body.split('\n')) {
    const start = offset;
    offset += line.length + 1;

    const trimmed = line.trim();
    if (trimmed.length < 4) continue;

    const leading = LINE_LEADING.exec(line);
    const trailing = LINE_TRAILING.exec(line);

    // Not a line that is only an item: look inside it for ones written into a
    // sentence. Only when the line patterns found nothing, so a proper list
    // line is never read twice.
    if (!leading && !trailing) {
      for (const inline of inlineItems(line, start)) items.push(inline);
      continue;
    }

    // Both groups, or neither. A regular expression that matched but whose
    // capture came back empty is a pattern bug, and taking the line anyway
    // would produce an item called "" with a quantity of NaN — which reaches
    // the database looking like data.
    const quantityText = (leading ? leading[1] : trailing?.[2]) ?? '';
    const nameText = ((leading ? leading[2] : trailing?.[1]) ?? '').trim();
    if (!quantityText || !nameText) continue;

    // A line that is all numbers, or whose "name" is a date or a reference, is
    // not an order line. Without this, "PO 4471 - 12" becomes twelve of a
    // product called PO 4471.
    if (/^\d+$/.test(nameText) || DATE.test(nameText) || /^p\.?o\.?\b/i.test(nameText)) {
      doubts.push(`ignored a line that looks like a reference rather than an item: "${trimmed}"`);
      continue;
    }

    const quantity = Number(quantityText);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    const at = line.indexOf(nameText);
    const nameHit = {
      text: nameText,
      from: start + (at === -1 ? 0 : at),
      to: start + (at === -1 ? line.length : at + nameText.length),
      groups: [] as string[],
    };
    const quantityAt = line.indexOf(quantityText);
    const quantityHit = {
      text: quantityText,
      from: start + (quantityAt === -1 ? 0 : quantityAt),
      to: start + (quantityAt === -1 ? line.length : quantityAt + quantityText.length),
      groups: [] as string[],
    };

    const unitHit = firstHit(nameText, UNIT);

    items.push({
      name: fromHit(nameText, 0.8, 'body', nameHit, leading ? 'line-leading-quantity' : 'line-trailing-quantity'),
      quantity: fromHit(quantity, 0.9, 'body', quantityHit, 'line-quantity'),
      ...(unitHit
        ? {
            unit: fromHit(unitHit.text.toLowerCase(), 0.7, 'body', {
              ...unitHit,
              from: nameHit.from + unitHit.from,
              to: nameHit.from + unitHit.to,
            }, 'unit-word'),
          }
        : {}),
    });
  }

  return items;
}

function asOrder(
  message: Message,
  subject: string,
  body: string,
  because: string[],
  doubts: string[]
): Reading {
  const reference = referenceOf(subject, body, REFERENCE, 'purchase-order-reference');
  const items = itemsIn(body, doubts);

  const urgent = firstHit(`${subject}\n${body}`, URGENT);
  const relaxed = firstHit(`${subject}\n${body}`, RELAXED);

  const priority = urgent
    ? fromHit('high' as const, 0.7, 'body', urgent, 'urgency-word')
    : relaxed
      ? fromHit('low' as const, 0.6, 'body', relaxed, 'urgency-word')
      : undefined;

  const wantedHit = firstHit(body, DATE);
  const wantedDate = wantedHit ? readDate(wantedHit.text) : null;
  const wanted = wantedHit && wantedDate
    ? fromHit(wantedDate, 0.6, 'body', wantedHit, 'a-date-in-the-body')
    : undefined;

  if (items.length === 0) {
    doubts.push('no order lines could be read: the quantities may be in an attachment or a table');
  }
  if (!reference) {
    doubts.push('no purchase-order reference, so this can only be matched by sender and subject');
  }

  const fact: Fact = {
    kind: 'order',
    items,
    ...(reference ? { reference } : {}),
    ...(priority ? { priority } : {}),
    ...(wanted ? { wanted } : {}),
  };

  // Deliberately not the average of the fields. An order whose reference is
  // certain and whose lines could not be read is not "moderately confident";
  // it is an order somebody has to look at.
  const confidence = items.length === 0 ? 0.3 : reference ? 0.9 : 0.65;

  return { messageId: message.id, fact, confidence, because, doubts };
}

function asConfirmation(
  message: Message,
  subject: string,
  body: string,
  because: string[],
  doubts: string[]
): Reading {
  const both = `${subject}\n${body}`;
  const reference = referenceOf(subject, body, REFERENCE, 'purchase-order-reference');
  const supplierOrderId = referenceOf(subject, body, SUPPLIER_REFERENCE, 'supplier-reference');

  // Named rather than taken from the end of the list: a reordering of STATUS
  // would otherwise silently change what an unreadable reply is assumed to be,
  // and "assumed accepted" is the assumption that costs money.
  const UNREAD = { status: 'accepted' as const, pattern: /$^/ };
  const status = STATUS.find((candidate) => candidate.pattern.test(both)) ?? UNREAD;
  if (status === UNREAD) {
    doubts.push('the supplier’s answer could not be read as accepted, partial, delayed or refused');
  }

  const statusHit = firstHit(both, status.pattern) ?? {
    text: '',
    from: 0,
    to: 0,
    groups: [],
  };

  const etaHit = firstHit(body, DATE);
  const etaDate = etaHit ? readDate(etaHit.text) : null;

  const fact: Fact = {
    kind: 'confirmation',
    status: fromHit(status.status, statusHit.text ? 0.8 : 0.3, 'body', statusHit, 'status-language'),
    ...(reference ? { reference } : {}),
    ...(supplierOrderId ? { supplierOrderId } : {}),
    ...(etaHit && etaDate ? { eta: fromHit(etaDate, 0.6, 'body', etaHit, 'a-date-in-the-body') } : {}),
  };

  if (!reference) {
    doubts.push('no purchase-order reference: matching this to an order needs the thread or the sender');
  }

  return {
    messageId: message.id,
    fact,
    confidence: reference && statusHit.text ? 0.85 : 0.5,
    because,
    doubts,
  };
}

function asShipment(
  message: Message,
  subject: string,
  body: string,
  because: string[],
  doubts: string[]
): Reading {
  const both = `${subject}\n${body}`;
  const reference = referenceOf(subject, body, REFERENCE, 'purchase-order-reference');

  const trackingHit = firstHit(both, TRACKING);
  const carrierHit = firstHit(both, CARRIER);
  const noteHit = firstHit(both, DELIVERY_NOTE);

  const fact: Fact = {
    kind: 'shipment',
    ...(reference ? { reference } : {}),
    ...(trackingHit
      ? { tracking: fromHit(clean(trackingHit.groups[0] ?? ''), 0.85, 'body', trackingHit, 'tracking-number') }
      : {}),
    ...(carrierHit
      ? { carrier: fromHit(carrierHit.text.toUpperCase(), 0.9, 'body', carrierHit, 'carrier-name') }
      : {}),
    ...(noteHit
      ? { note: fromHit(clean(noteHit.groups[0] ?? ''), 0.8, 'body', noteHit, 'delivery-note-number') }
      : {}),
  };

  if (!trackingHit && !noteHit) {
    doubts.push('neither a tracking number nor a delivery note: this may be a courtesy note');
  }

  return {
    messageId: message.id,
    fact,
    confidence: reference && (trackingHit || noteHit) ? 0.85 : 0.55,
    because,
    doubts,
  };
}

export { lineAround, hits, readDate };
