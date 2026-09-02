/**
 * Dates, said the way somebody reads them.
 *
 * One locale, fixed, and it is the language everything else on the screen is
 * written in. The browser's own locale was tried first and it produced
 * "An order, from Anna, lunedì 2 marzo 2026 alle ore 09:12" — half an English
 * sentence finished in Italian, because the machine it was read on is set to
 * Italian. Following the reader's locale is right for a product that has been
 * translated. This one has not, so it would only ever be a seam.
 *
 * `toISOString().slice(0, 10)` appears nowhere here on purpose. It converts to
 * UTC first, so anywhere east of it the early hours report yesterday — a defect
 * this portfolio has now produced twice.
 */

const SPOKEN = 'en-GB';

/** True of a value the API sent as a Date and JSON turned into a string. */
const LOOKS_LIKE_A_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export function shortWhen(iso: string | null): string {
  const when = parse(iso);
  if (!when) return '—';

  return when.toLocaleString(SPOKEN, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function longWhen(iso: string | null): string {
  const when = parse(iso);
  if (!when) return 'with no date on it';

  return `on ${when.toLocaleString(SPOKEN, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

export function day(iso: string | null): string {
  const when = parse(iso);
  if (!when) return '—';

  return when.toLocaleDateString(SPOKEN, {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * A value read out of an email, shown as somebody would write it.
 *
 * The fields come back with their types flattened by JSON, so a date arrives as
 * `2026-03-15T23:00:00.000Z` — which is what was on screen for a while, beside
 * a quotation of the email saying "16/03/2026". Two different-looking answers
 * to the same question is the one thing this screen must never do: it is here
 * to let somebody check a value against its source.
 */
export function asShown(value: string | number | boolean | null): string {
  if (value === null) return '—';
  if (typeof value !== 'string') return String(value);
  return LOOKS_LIKE_A_DATE.test(value) ? day(value) : value;
}

function parse(iso: string | null): Date | null {
  if (!iso) return null;
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? null : when;
}
