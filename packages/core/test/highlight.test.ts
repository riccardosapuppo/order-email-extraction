import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { segments, type Span } from '../src/highlight.js';

/** The property the interface depends on: nothing is lost and nothing moves. */
function rebuilt(text: string, spans: Span[]): string {
  return segments(text, spans)
    .map((piece) => piece.text)
    .join('');
}

describe('cutting a message into what was read and what was not', () => {
  const text = 'Please supply 12 boxes of gloves against PO-4471.';

  it('marks the piece a field was read from and leaves the rest alone', () => {
    const cut = segments(text, [{ from: 14, to: 16, id: 'quantity' }]);

    assert.deepEqual(
      cut.map((piece) => [piece.text, piece.ids]),
      [
        ['Please supply ', []],
        ['12', ['quantity']],
        [' boxes of gloves against PO-4471.', []],
      ]
    );
  });

  it('gives back the message exactly, whatever the spans', () => {
    // The one thing an interface cannot forgive. A missing character here is a
    // message shown to somebody that is not the message that arrived.
    const spans: Span[] = [
      { from: 41, to: 48, id: 'reference' },
      { from: 14, to: 16, id: 'quantity' },
      { from: 17, to: 22, id: 'unit' },
    ];

    assert.equal(rebuilt(text, spans), text);
  });

  it('takes the spans in the order they appear, not the order they were read', () => {
    // Fields come off a fact in the order the rules ran, which has nothing to
    // do with where they sit in the sentence.
    const cut = segments(text, [
      { from: 41, to: 48, id: 'reference' },
      { from: 14, to: 16, id: 'quantity' },
    ]);

    assert.deepEqual(
      cut.filter((piece) => piece.ids.length > 0).map((piece) => piece.text),
      ['12', 'PO-4471']
    );
  });

  it('shows an overlap as an overlap instead of hiding one of them', () => {
    // Two rules claiming the same characters is a defect worth seeing. If the
    // second span were dropped the display would look correct and the reading
    // would still be wrong.
    const cut = segments('12 boxes', [
      { from: 0, to: 6, id: 'quantity' },
      { from: 3, to: 8, id: 'unit' },
    ]);

    assert.deepEqual(
      cut.map((piece) => [piece.text, piece.ids]),
      [
        ['12 ', ['quantity']],
        ['box', ['quantity', 'unit']],
        ['es', ['unit']],
      ]
    );
  });

  it('does not produce an empty piece when two spans start together', () => {
    const cut = segments('12 boxes', [
      { from: 0, to: 2, id: 'a' },
      { from: 0, to: 8, id: 'b' },
    ]);

    assert.ok(cut.every((piece) => piece.text.length > 0));
    assert.equal(rebuilt('12 boxes', [{ from: 0, to: 2, id: 'a' }, { from: 0, to: 8, id: 'b' }]), '12 boxes');
  });

  it('discards a span that is empty or backwards rather than reversing the text', () => {
    assert.equal(rebuilt(text, [{ from: 20, to: 20, id: 'empty' }]), text);
    assert.equal(rebuilt(text, [{ from: 20, to: 10, id: 'backwards' }]), text);
  });

  it('clamps a span that points past the end', () => {
    // A miscounted offset must not silently produce a shorter message.
    assert.equal(rebuilt('short', [{ from: 2, to: 900, id: 'over' }]), 'short');
    assert.equal(rebuilt('short', [{ from: -5, to: 3, id: 'under' }]), 'short');
  });

  it('has nothing to show for an empty message', () => {
    assert.deepEqual(segments('', [{ from: 0, to: 5, id: 'nothing' }]), []);
  });

  it('returns the whole message as one unread piece when nothing was read', () => {
    assert.deepEqual(segments(text, []), [{ text, ids: [] }]);
  });
});
