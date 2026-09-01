import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { domainOf, withoutQuoted } from '../src/message.js';

describe('the domain of an address', () => {
  it('is the part after the last at sign, lowercased', () => {
    assert.equal(domainOf('Anna@Example.COM'), 'example.com');
    assert.equal(domainOf({ email: 'anna@example.com', name: 'Anna' }), 'example.com');
  });

  it('is empty rather than wrong when there is no at sign', () => {
    // A supplier is recognised by their domain. Returning the whole string
    // here would make "unparseable" match itself and let one bad address
    // become a supplier nobody added.
    assert.equal(domainOf('not an address'), '');
  });

  it('takes the last at sign, not the first', () => {
    assert.equal(domainOf('"odd@name"@example.com'), 'example.com');
  });
});

describe('the part of a reply somebody actually wrote', () => {
  it('drops what the client quoted underneath', () => {
    const body = [
      'Yes, please send 4 more.',
      '',
      'On 12 March 2026 at 09:14, Anna <anna@example.com> wrote:',
      '> We have 6 boxes left.',
      '> Shall I order 12?',
    ].join('\n');

    assert.equal(withoutQuoted(body), 'Yes, please send 4 more.');
  });

  it('drops it in Italian too', () => {
    const body = [
      'Confermo.',
      'Il 12 marzo 2026 Anna <anna@example.com> ha scritto:',
      '> Ordine di 12 scatole',
    ].join('\n');

    assert.equal(withoutQuoted(body), 'Confermo.');
  });

  it('drops a forwarded block', () => {
    const body = 'Can you handle this one?\n\n--- Forwarded message ---\nFrom: someone@example.com';

    assert.equal(withoutQuoted(body), 'Can you handle this one?');
  });

  it('keeps a sentence that merely contains the word wrote', () => {
    // The markers are matched at the start of a line and as whole lines. A
    // substring match here silently truncates real messages, and the part it
    // throws away is the part after the interesting sentence.
    const body = 'She wrote: 12 boxes, not 6.\nPlease amend the order.';

    assert.equal(withoutQuoted(body), body);
  });

  it('keeps a reply written between quoted paragraphs', () => {
    // Some clients interleave. Stopping at the first quoted line would throw
    // away the second half of the answer, which is where the correction is.
    const body = ['> 6 boxes?', 'No, 12.', '> By Friday?', 'Yes.'].join('\n');

    assert.equal(withoutQuoted(body), 'No, 12.\nYes.');
  });

  it('leaves a message with nothing quoted alone', () => {
    assert.equal(withoutQuoted('  Two boxes please.  '), 'Two boxes please.');
  });
});
