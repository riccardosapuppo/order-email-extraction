import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { locate } from '../src/read/locate.js';

/**
 * The property everything above this depends on: a span points into the message
 * a person will be shown. If `text.slice(from, to)` is not what was found, the
 * highlight is on the wrong words and the whole argument of the project fails
 * quietly.
 */
function pointsAtItself(text: string, quote: string): boolean {
  const found = locate(text, quote);
  return found !== null && text.slice(found.from, found.to) === found.text;
}

describe('finding the words a reader claims to have read', () => {
  const body = 'Please supply 12 boxes of nitrile gloves against PO-4471.\nWanted by 14 March.';

  it('finds an exact quote and points at the message, not at the quote', () => {
    const found = locate(body, '12 boxes');

    assert.equal(found?.from, 14);
    assert.equal(found?.to, 22);
    assert.equal(found?.text, '12 boxes');
    assert.ok(pointsAtItself(body, '12 boxes'));
  });

  it('forgives whitespace, because a model folds a line break into a space', () => {
    // The quote as a model would give it back: one line, single spaces. The
    // span still has to land on the message's own characters, newline and all.
    const found = locate(body, 'against PO-4471. Wanted by 14 March.');

    assert.ok(found, 'the words are in the message, spelled the same way');
    assert.equal(body.slice(found.from, found.to), 'against PO-4471.\nWanted by 14 March.');
  });

  it('refuses a quote whose letters are not there', () => {
    // The case this exists for. "14 boxes" is a plausible thing to say about
    // this email and it is not what the email says.
    assert.equal(locate(body, '14 boxes'), null);
    assert.equal(locate(body, 'PO-4472'), null);
  });

  it('refuses an empty quote rather than matching everything', () => {
    assert.equal(locate(body, ''), null);
    assert.equal(locate(body, '   \n  '), null);
  });

  it('says when the quote is ambiguous instead of hiding it', () => {
    // A bare number is the classic. The span returned is the first, and the
    // caller is told there were others so it can say so rather than present a
    // guess as a fact.
    const twice = 'Order 12 units. Previous order was 12 units.';

    assert.equal(locate(twice, '12')?.occurrences, 2);
    assert.equal(locate(twice, '12 units')?.occurrences, 2);
    assert.equal(locate(twice, 'Previous')?.occurrences, 1);
  });

  it('does not let a whitespace difference change which characters are claimed', () => {
    const spaced = 'Quantity:    12\n\n   boxes';

    assert.ok(pointsAtItself(spaced, 'Quantity: 12 boxes'));
    assert.equal(locate(spaced, 'Quantity: 12 boxes')?.text, 'Quantity:    12\n\n   boxes');
  });
});
