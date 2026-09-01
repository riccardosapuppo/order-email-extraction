/**
 * An email, once somebody else has dealt with the envelope.
 *
 * Everything in this package works on this and never on a mailbox, a MIME
 * tree, or a Gmail response. Reading a `.eml` file and calling the Gmail API
 * are two different problems with two different failure modes, and neither of
 * them is what this project is about — so they live in adapters, and what
 * arrives here is four fields and an id.
 *
 * The body is plain text. HTML mail is converted before it gets here, because
 * an extractor that has to cope with both is an extractor with two of every
 * rule, and the second one is always the one nobody tested.
 */

/** Where a message came from, kept so a fact can be traced back to it. */
export interface Message {
  /** Stable across syncs. The Gmail message id, or the file name. */
  readonly id: string;

  /** The conversation it belongs to, when the source knows. */
  readonly threadId?: string;

  readonly from: Address;
  readonly to: readonly Address[];
  readonly subject: string;
  readonly receivedAt: Date;

  /** Plain text, with quoted replies still in it — see `withoutQuoted`. */
  readonly body: string;

  /** File names only. Nothing here opens an attachment. */
  readonly attachments: readonly string[];
}

export interface Address {
  readonly email: string;
  /** The display name, when there was one. Not to be trusted as an identity. */
  readonly name?: string;
}

/** The domain of an address, lowercased, or "" if it does not have one. */
export function domainOf(address: Address | string): string {
  const email = typeof address === 'string' ? address : address.email;
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).trim().toLowerCase();
}

/**
 * The part of a reply the sender actually wrote.
 *
 * A thread of six messages carries the previous five in every one of them. An
 * extractor reading the whole body finds the first order five times over and
 * dates it wrong every time, because the quoted copy of Monday's email is
 * still sitting inside Friday's reply.
 *
 * The markers are the ones mail clients actually produce. They are matched at
 * the start of a line only: a message body that mentions "wrote:" in the
 * middle of a sentence is a sentence, not a quote.
 */
export function withoutQuoted(body: string): string {
  const lines = body.split(/\r?\n/);
  const kept: string[] = [];

  for (const line of lines) {
    if (isQuoteHeader(line)) break;
    // A run of quoted lines is dropped, but does not end the message: some
    // clients interleave a reply between quoted paragraphs.
    if (line.startsWith('>')) continue;
    kept.push(line);
  }

  return kept.join('\n').trim();
}

const QUOTE_HEADERS = [
  /^-{2,}\s*(original message|forwarded message|messaggio originale)/i,
  /^_{5,}$/,
  /^on .{4,80}\bwrote:\s*$/i,
  /^il .{4,80}\bha scritto:\s*$/i,
  /^from:\s.+@/i,
  /^da:\s.+@/i,
  /^sent from my /i,
];

function isQuoteHeader(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  return QUOTE_HEADERS.some((marker) => marker.test(trimmed));
}
