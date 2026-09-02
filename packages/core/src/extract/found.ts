/**
 * Finding something in a message, and remembering where it was.
 *
 * Every rule in this package uses these two helpers, and that is deliberate:
 * a rule that returns a value without a span cannot be shown to anybody, and a
 * field that cannot be shown is a field nobody can check. Making the only easy
 * way to produce a value also produce its provenance is cheaper than reviewing
 * for it.
 */

import type { Field, Provenance } from '../facts.js';
import { field } from '../facts.js';

export type Where = 'subject' | 'body';

/** A match, with the span it came from. */
export interface Hit {
  readonly text: string;
  readonly from: number;
  readonly to: number;
  readonly groups: readonly string[];
}

/**
 * Every match of a pattern, with offsets.
 *
 * The pattern is applied to the text as given rather than to a lowercased
 * copy: the offsets have to point into the string a person will be shown, and
 * lowercasing first is how a highlight ends up three characters off on a line
 * that happened to contain a ligature.
 */
export function hits(text: string, pattern: RegExp): Hit[] {
  const all = pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + 'g');
  const found: Hit[] = [];

  for (const match of text.matchAll(all)) {
    if (match.index === undefined) continue;
    found.push({
      text: match[0],
      from: match.index,
      to: match.index + match[0].length,
      groups: match.slice(1).map((group) => group ?? ''),
    });
  }

  return found;
}

export function firstHit(text: string, pattern: RegExp): Hit | null {
  return hits(text, pattern)[0] ?? null;
}

/** A field from a hit, carrying the rule that found it. */
export function fromHit<T>(
  value: T,
  confidence: number,
  where: Where,
  hit: Hit,
  rule: string
): Field<T> {
  const provenance: Provenance = {
    where,
    from: hit.from,
    to: hit.to,
    text: hit.text,
    rule,
  };
  return field(value, confidence, provenance);
}

/**
 * The line a span falls on, for showing a person the sentence rather than the
 * fragment. A reference on its own means nothing; the line it was on usually
 * says what it is a reference to.
 */
export function lineAround(text: string, from: number, to: number): string {
  const start = text.lastIndexOf('\n', from) + 1;
  const end = text.indexOf('\n', to);
  return text.slice(start, end === -1 ? text.length : end).trim();
}
