/**
 * Finding the words something claims to have read, in the message it read them
 * from.
 *
 * ── Why a model is never asked for offsets ───────────────────────────────────
 *
 * A rule knows where it matched: the regular expression engine hands back the
 * index, and `extract/found.ts` carries it. A model does not. Ask one for
 * `from` and `to` and it will give you two plausible integers, because that is
 * what the question asked for, and they will be wrong often enough to be worse
 * than useless — a highlight three words off is read as the system having
 * understood something it did not.
 *
 * So a model is asked for the *text* it read a value out of, and the offsets
 * are found here, by looking for that text in the message. That turns "trust
 * the model" into "check the model", and it costs one search.
 *
 * A quote that cannot be found is the interesting case, and it is not an error
 * in this file: it is a value the model produced out of nothing, which is
 * exactly the thing this project exists to catch. What to do about it is
 * decided in `answer.ts`, where there is enough context to say it in words.
 *
 * ── Why the match is allowed to be inexact, and how far ──────────────────────
 *
 * Only in whitespace. A model reproducing a line out of an email will fold a
 * line break into a space, or lose the two spaces after a full stop, and
 * refusing those would refuse correct readings for a reason nobody could act
 * on. Every other difference is refused: if the letters are not the same
 * letters, it did not read this.
 */

/** Where in the message something was found, and how unambiguously. */
export interface Located {
  readonly from: number;
  readonly to: number;

  /** The message's own characters, never the quote that was searched for. */
  readonly text: string;

  /**
   * How many times the quote appears in this part of the message.
   *
   * More than one is a real problem and the caller is told rather than
   * protected from it: "12" appears in a message eleven times, and the span
   * this returns is the first of them, which is not necessarily the one a value
   * was read from. A rule never has this difficulty because it kept its index.
   */
  readonly occurrences: number;
}

/**
 * Locate `quote` in `text`.
 *
 * Returns null when the letters are not there. The span always points into
 * `text` as given, so `text.slice(from, to)` is what a person will be shown.
 */
export function locate(text: string, quote: string): Located | null {
  const wanted = quote.trim();
  if (wanted === '') return null;

  const exact = countAndFind(text, wanted);
  if (exact) return exact;

  // Whitespace only. The map carries each surviving character back to where it
  // came from, so the span returned still points into the original.
  const flat = flatten(text);
  const needle = flatten(wanted).text;
  if (needle === '') return null;

  const at = flat.text.indexOf(needle);
  if (at === -1) return null;

  let occurrences = 0;
  for (let look = at; look !== -1; look = flat.text.indexOf(needle, look + 1)) occurrences += 1;

  return {
    from: flat.map[at]!,
    to: flat.map[at + needle.length - 1]! + 1,
    text: text.slice(flat.map[at]!, flat.map[at + needle.length - 1]! + 1),
    occurrences,
  };
}

function countAndFind(text: string, wanted: string): Located | null {
  const at = text.indexOf(wanted);
  if (at === -1) return null;

  let occurrences = 0;
  for (let look = at; look !== -1; look = text.indexOf(wanted, look + 1)) occurrences += 1;

  return { from: at, to: at + wanted.length, text: text.slice(at, at + wanted.length), occurrences };
}

/**
 * The same text with every run of whitespace collapsed to one space, plus the
 * index in the original of each character kept.
 */
function flatten(text: string): { text: string; map: number[] } {
  let out = '';
  const map: number[] = [];
  let inSpace = false;

  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;

    if (/\s/.test(char)) {
      if (inSpace || out === '') continue;
      out += ' ';
      map.push(at);
      inSpace = true;
      continue;
    }

    out += char;
    map.push(at);
    inSpace = false;
  }

  // A trailing collapsed space would make every quote that ends a line fail to
  // match, which is most of them.
  while (out.endsWith(' ')) {
    out = out.slice(0, -1);
    map.pop();
  }

  return { text: out, map };
}
