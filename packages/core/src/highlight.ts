/**
 * Cutting a piece of text into the parts that were read and the parts that
 * were not.
 *
 * This is what makes the claim of this project visible. Every field carries the
 * offsets it was read from; an interface that shows the email with those
 * offsets marked lets somebody check a value against the words it came from,
 * instead of being asked to trust a number.
 *
 * It lives here rather than in the interface because it is about provenance,
 * which is this package's subject, and because here it has tests. The rules
 * below are all cases that appear in the sample mailbox:
 *
 *   - **Spans arrive in whatever order the fields were read**, which is not
 *     the order they appear in the text. Sorted first.
 *   - **Spans can overlap.** An item's quantity and its unit sit beside each
 *     other and one rule reading a little too far is exactly the sort of
 *     defect this display should reveal — so an overlap is kept and marked,
 *     not silently dropped. The overlapping part belongs to the span that
 *     starts first; what remains of the second is still shown as its own.
 *   - **A span can be empty or backwards** if a rule miscounted. It is
 *     discarded rather than allowed to produce a segment that reverses the
 *     text.
 *   - **Offsets can point past the end** — the same miscount. Clamped.
 */

export interface Span {
  readonly from: number;
  readonly to: number;
  /** Whatever the caller needs to identify this span. Carried, never read. */
  readonly id: string;
}

export interface Segment {
  readonly text: string;
  /** The spans covering this segment. Empty for the text between them. */
  readonly ids: readonly string[];
}

/**
 * Splits `text` at every span boundary.
 *
 * The result concatenates back to exactly `text` — that is the property worth
 * relying on, because an interface rendering these segments in order must show
 * the message and not a version of it with a character missing.
 */
export function segments(text: string, spans: readonly Span[]): Segment[] {
  const usable = spans
    .filter((span) => Number.isInteger(span.from) && Number.isInteger(span.to))
    .map((span) => ({
      id: span.id,
      from: Math.max(0, Math.min(span.from, text.length)),
      to: Math.max(0, Math.min(span.to, text.length)),
    }))
    .filter((span) => span.to > span.from);

  if (usable.length === 0) return text.length > 0 ? [{ text, ids: [] }] : [];

  // Every offset where the set of covering spans can change. Sorted and
  // de-duplicated, so two spans that start at the same place do not produce an
  // empty segment between them.
  const edges = [...new Set([0, text.length, ...usable.flatMap((span) => [span.from, span.to])])]
    .filter((at) => at >= 0 && at <= text.length)
    .sort((a, b) => a - b);

  const out: Segment[] = [];

  for (let at = 0; at < edges.length - 1; at += 1) {
    const from = edges[at]!;
    const to = edges[at + 1]!;
    if (to <= from) continue;

    const ids = usable
      .filter((span) => span.from < to && span.to > from)
      .map((span) => span.id);

    out.push({ text: text.slice(from, to), ids });
  }

  return out;
}
