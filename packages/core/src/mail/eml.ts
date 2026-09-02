/**
 * Reading a `.eml` file — the thing every mail client exports.
 *
 * This exists so the extractor can be pointed at messages nobody here wrote.
 * A demonstration that only ever runs against its own examples proves that the
 * examples work, and every project in this portfolio has been caught by that
 * at least once. Real mail is where the surprises are: quoted-printable that
 * breaks a word across a soft line break, base64 bodies, an HTML-only message,
 * a header folded across three lines, a charset that is not UTF-8.
 *
 * Written by hand rather than with a library, and the reason is narrow: this
 * has to read what a client exports, and nothing more. It does not build MIME,
 * does not decode attachments, does not follow references. About two hundred
 * lines against a dependency that also does S/MIME, calendar parts and
 * address-book lookups — and would still need the same care about which part
 * of a multipart message is the one a person actually wrote.
 *
 * What it does not do is written down at the bottom, because a parser whose
 * limits are undiscovered is a parser that fails quietly on the first real
 * mailbox.
 */

import type { Address, Message } from '../message.js';

interface Part {
  readonly headers: Map<string, string>;
  readonly body: string;
}

/** A message from the contents of a `.eml` file. */
export function readEml(raw: string, id: string): Message {
  const top = split(raw.replace(/\r\n/g, '\n'));

  const from = addressesIn(header(top, 'from'))[0] ?? { email: '' };
  const to = addressesIn(header(top, 'to'));

  return {
    id,
    ...(threadOf(top) ? { threadId: threadOf(top)! } : {}),
    from,
    to,
    subject: decodeWords(header(top, 'subject')),
    receivedAt: dateOf(header(top, 'date')),
    body: plainTextOf(top),
    attachments: attachmentsIn(top),
  };
}

/** Headers and body, at the first blank line. */
function split(raw: string): Part {
  const at = raw.indexOf('\n\n');
  const headText = at === -1 ? raw : raw.slice(0, at);
  const body = at === -1 ? '' : raw.slice(at + 2);

  const headers = new Map<string, string>();

  // Unfolded first: a header may continue on the next line if that line starts
  // with a space or a tab, and a long Subject routinely does.
  const unfolded = headText.replace(/\n[ \t]+/g, ' ');

  for (const line of unfolded.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    // The first wins. A Received chain has many, and re-sending a message adds
    // a second Subject; the one at the top is the one the client shows.
    if (!headers.has(name)) headers.set(name, value);
  }

  return { headers, body };
}

function header(part: Part, name: string): string {
  return part.headers.get(name) ?? '';
}

/**
 * The conversation this belongs to.
 *
 * The first message id in References, which is the one that started the
 * thread. In-Reply-To names the immediate parent instead, so a long thread
 * would give a different answer at every message and would not be a thread id
 * at all.
 */
function threadOf(part: Part): string | null {
  const references = header(part, 'references');
  const first = references.match(/<[^>]+>/);
  if (first) return first[0];

  const inReplyTo = header(part, 'in-reply-to').match(/<[^>]+>/);
  if (inReplyTo) return inReplyTo[0];

  // A message that starts a thread is its own thread.
  const own = header(part, 'message-id').match(/<[^>]+>/);
  return own ? own[0] : null;
}

function dateOf(written: string): Date {
  const parsed = new Date(written);
  // An unparseable Date header is not a reason to lose the message. The epoch
  // would sort it to the beginning of every mailbox, so now is used and the
  // ordering stays sane.
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/** `Anna Smith <anna@example.com>, bob@example.com` */
export function addressesIn(header: string): Address[] {
  if (!header.trim()) return [];

  const found: Address[] = [];

  // Split on commas that are not inside quotes: a display name may contain
  // one, and "Smith, Anna" <anna@…> is a single address written by every
  // corporate address book there is.
  let current = '';
  let quoted = false;

  for (const character of header) {
    if (character === '"') quoted = !quoted;
    if (character === ',' && !quoted) {
      found.push(oneAddress(current));
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) found.push(oneAddress(current));

  return found.filter((address) => address.email !== '');
}

function oneAddress(text: string): Address {
  const angled = text.match(/<([^>]+)>/);
  const email = (angled?.[1] ?? text).trim().toLowerCase();

  // A name only when the address was written in angle brackets. Without that
  // check, `bob@b.example` on its own has everything outside the (absent)
  // brackets taken as a display name — so the address becomes its own name,
  // and anything showing "name, or else email" shows it twice.
  const name = angled
    ? decodeWords(text.replace(/<[^>]*>/, '').replace(/"/g, '').trim())
    : '';

  return name ? { email, name } : { email };
}

/**
 * The part a person actually wrote.
 *
 * A multipart/alternative carries the same message twice, as text and as
 * HTML, and the text part is the one to read. When there is only HTML, the
 * tags are stripped — badly, and deliberately so: a full renderer is a
 * different project, and what the extractor needs is the words in order.
 */
function plainTextOf(part: Part): string {
  const raw = header(part, 'content-type');
  const contentType = raw.toLowerCase();

  if (contentType.startsWith('multipart/')) {
    // From the original header and not the lowercased copy. The media type is
    // case-insensitive and the boundary is not: `boundary="XX"` lowercased
    // sends the parser looking for `--xx`, which appears nowhere, so the whole
    // message comes back as a single part with the boundaries still in it.
    const boundary = raw.match(/boundary="?([^";]+)"?/i)?.[1];
    if (!boundary) return decodeBody(part);

    // `(^|\n)` and not just `\n`: the first boundary sits at the very start of
    // the body, with no line break before it, so a pattern anchored on the
    // newline misses it — and the whole message comes back as one piece with
    // the boundaries still in the text.
    const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pieces = part.body
      .split(new RegExp(`(?:^|\\n)--${escaped}(?:--)?\\n?`))
      .filter((piece) => piece && piece.trim() !== '' && piece !== '--');

    const parsed = pieces.map((piece) => split(piece));

    const text = parsed.find((one) =>
      header(one, 'content-type').toLowerCase().startsWith('text/plain')
    );
    if (text) return decodeBody(text);

    // A nested multipart/alternative inside a multipart/mixed: common the
    // moment anybody attaches anything.
    const nested = parsed.find((one) =>
      header(one, 'content-type').toLowerCase().startsWith('multipart/')
    );
    if (nested) return plainTextOf(nested);

    const html = parsed.find((one) =>
      header(one, 'content-type').toLowerCase().startsWith('text/html')
    );
    if (html) return stripTags(decodeBody(html));

    return parsed.length > 0 ? decodeBody(parsed[0]!) : '';
  }

  if (contentType.startsWith('text/html')) return stripTags(decodeBody(part));

  return decodeBody(part);
}

function decodeBody(part: Part): string {
  const encoding = header(part, 'content-transfer-encoding').toLowerCase();
  const body = part.body;

  if (encoding === 'base64') {
    try {
      return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8');
    } catch {
      return body;
    }
  }

  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body);

  return body;
}

/**
 * Quoted-printable, including the soft line break.
 *
 * `=` at the end of a line means the line continues, and it is how a mail
 * client breaks a long word. Handling `=XX` and forgetting the soft break
 * leaves the word split in two — so "confirmation" arrives as "confir mation"
 * and no rule matches it.
 */
export function decodeQuotedPrintable(text: string): string {
  const joined = text.replace(/=\n/g, '');
  const bytes: number[] = [];

  for (let at = 0; at < joined.length; at += 1) {
    const character = joined[at]!;
    if (character === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(at + 1, at + 3))) {
      bytes.push(parseInt(joined.slice(at + 1, at + 3), 16));
      at += 2;
      continue;
    }
    // Anything else goes through as its own bytes, so accented characters that
    // were never encoded survive.
    for (const byte of Buffer.from(character, 'utf8')) bytes.push(byte);
  }

  return Buffer.from(bytes).toString('utf8');
}

/**
 * `=?UTF-8?Q?…?=` in a header.
 *
 * Subjects with an accent in them arrive encoded, and a subject nobody can
 * read is a reference nobody can match.
 */
export function decodeWords(text: string): string {
  return text.replace(
    /=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g,
    (whole, charset: string, kind: string, payload: string) => {
      try {
        if (kind.toLowerCase() === 'b') {
          return Buffer.from(payload, 'base64').toString(asNode(charset));
        }
        return decodeQuotedPrintable(payload.replace(/_/g, ' '));
      } catch {
        return whole;
      }
    }
  );
}

function asNode(charset: string): BufferEncoding {
  const name = charset.toLowerCase();
  if (name === 'utf-8' || name === 'utf8') return 'utf8';
  if (name === 'iso-8859-1' || name === 'latin1' || name === 'windows-1252') return 'latin1';
  return 'utf8';
}

/** File names only. Nothing here opens one. */
function attachmentsIn(part: Part): string[] {
  const found: string[] = [];
  const disposition = /filename="?([^";\n]+)"?/gi;

  for (const match of part.body.matchAll(disposition)) {
    if (match[1]) found.push(decodeWords(match[1]));
  }

  return [...new Set(found)];
}

/**
 * HTML to words, roughly.
 *
 * Block tags become line breaks so that an order written as a list keeps its
 * lines — the item rules read lines, and a table flattened onto one line reads
 * as nothing at all.
 */
export function stripTags(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * What this does not do, so nobody finds out the hard way:
 *
 *   - it does not verify signatures, and an S/MIME message will read as its
 *     own envelope rather than its contents;
 *   - it does not decode attachments, only their names;
 *   - charsets other than UTF-8 and Latin-1 are read as UTF-8;
 *   - a message with no plain-text part gets its HTML stripped, which loses
 *     table structure;
 *   - it trusts the headers. Nothing here is a security boundary: a From line
 *     is what the sender wrote, and if a link is ever made on the strength of
 *     one, that is where to look first.
 */
