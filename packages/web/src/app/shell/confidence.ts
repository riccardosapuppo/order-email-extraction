/**
 * Confidence, said in words.
 *
 * A number between 0 and 1 next to a value is not information — nobody knows
 * whether 0.72 is good. What matters is the only decision the number is used
 * for anywhere in this system: does this go through, or does a person look at
 * it. `SURE_ENOUGH` is 0.7 in the core, and the three bands here are drawn
 * around that threshold so the screen says the same thing the code decided.
 *
 * The percentage is still shown, in small type, for anybody who wants it. The
 * word is what is read.
 */

export const SURE_ENOUGH = 0.7;

export type Band = 'sure' | 'likely' | 'doubtful';

export function bandOf(confidence: number): Band {
  if (confidence >= 0.9) return 'sure';
  if (confidence >= SURE_ENOUGH) return 'likely';
  return 'doubtful';
}

export function saidPlainly(confidence: number): string {
  switch (bandOf(confidence)) {
    case 'sure':
      return 'read outright';
    case 'likely':
      return 'read by a rule that can be wrong';
    default:
      return 'worth a person’s eye';
  }
}

export function asPercent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/** The stages, in the order an order goes through them. */
export const STAGE_WORDS: Record<string, string> = {
  ordered: 'Ordered',
  confirmed: 'Confirmed',
  partly_confirmed: 'Partly confirmed',
  refused: 'Refused',
  shipped: 'Shipped',
};

export const KIND_WORDS: Record<string, string> = {
  order: 'An order',
  confirmation: 'A confirmation',
  shipment: 'A shipment',
  acknowledgement: 'An acknowledgement',
  billing: 'An invoice',
  marketing: 'Marketing',
  unknown: 'Not understood',
};
