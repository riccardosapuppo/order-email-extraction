import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { addressesIn, decodeQuotedPrintable, decodeWords, readEml, stripTags } from '../src/mail/eml.js';

/** Written with real CRLF line endings, because that is what a file has. */
function eml(lines: string[]): string {
  return lines.join('\r\n');
}

describe('reading a .eml', () => {
  it('the ordinary case', () => {
    const message = readEml(
      eml([
        'From: Anna Smith <anna@customer.example>',
        'To: orders@supplier.example',
        'Subject: PO 4471',
        'Date: Thu, 12 Mar 2026 09:30:00 +0100',
        'Message-ID: <abc@customer.example>',
        '',
        'Please send 12 x gloves.',
      ]),
      'one'
    );

    assert.equal(message.from.email, 'anna@customer.example');
    assert.equal(message.from.name, 'Anna Smith');
    assert.equal(message.subject, 'PO 4471');
    assert.equal(message.receivedAt.getFullYear(), 2026);
    assert.ok(message.body.includes('12 x gloves'));
  });

  it('a header folded across lines', () => {
    // A long subject is wrapped by the client, and the continuation begins
    // with a space. Reading lines naively gives half a subject — and half a
    // subject is a reference that does not match.
    const message = readEml(
      eml([
        'From: a@b.example',
        'To: c@d.example',
        'Subject: Order confirmation for purchase order',
        ' 4471 - consumables',
        '',
        'Body.',
      ]),
      'two'
    );

    assert.equal(message.subject, 'Order confirmation for purchase order 4471 - consumables');
  });

  it('a thread is the first reference, not the immediate parent', () => {
    // In-Reply-To names the message just above, so it changes at every reply
    // and would not be a thread identifier at all.
    const message = readEml(
      eml([
        'From: a@b.example',
        'To: c@d.example',
        'Subject: Re: PO 1',
        'References: <first@x.example> <second@x.example>',
        'In-Reply-To: <second@x.example>',
        '',
        'Body.',
      ]),
      'three'
    );

    assert.equal(message.threadId, '<first@x.example>');
  });

  it('a message that starts a thread is its own thread', () => {
    const message = readEml(
      eml(['From: a@b.example', 'To: c@d.example', 'Message-ID: <mine@x.example>', '', 'Body.']),
      'four'
    );

    assert.equal(message.threadId, '<mine@x.example>');
  });

  it('an unreadable date does not lose the message', () => {
    // The epoch would sort it to the top of every mailbox for ever.
    const message = readEml(
      eml(['From: a@b.example', 'To: c@d.example', 'Date: yesterday afternoon', '', 'Body.']),
      'five'
    );

    assert.ok(message.receivedAt.getFullYear() >= 2020);
  });
});

describe('addresses', () => {
  it('several, with names', () => {
    const found = addressesIn('Anna <anna@a.example>, bob@b.example');

    assert.deepEqual(found, [
      { email: 'anna@a.example', name: 'Anna' },
      { email: 'bob@b.example' },
    ]);
  });

  it('a display name with a comma in it', () => {
    // "Smith, Anna" <anna@…> is what every corporate address book produces,
    // and splitting on every comma turns one address into two, the first of
    // which has no email at all.
    const found = addressesIn('"Smith, Anna" <anna@a.example>, bob@b.example');

    assert.equal(found.length, 2);
    assert.equal(found[0]?.email, 'anna@a.example');
    assert.equal(found[0]?.name, 'Smith, Anna');
  });
});

describe('bodies as they really arrive', () => {
  it('quoted-printable, including the soft line break', () => {
    // The `=` at the end of a line means the line continues. Handling `=XX`
    // and forgetting this leaves "confirmation" as "confir mation", and no
    // rule matches it.
    assert.equal(decodeQuotedPrintable('confir=\nmation'), 'confirmation');
    assert.equal(decodeQuotedPrintable('caf=C3=A8'), 'cafè');
  });

  it('base64', () => {
    const message = readEml(
      eml([
        'From: a@b.example',
        'To: c@d.example',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('Please send 4 x masks.').toString('base64'),
      ]),
      'six'
    );

    assert.ok(message.body.includes('4 x masks'));
  });

  it('multipart, taking the text part', () => {
    const message = readEml(
      eml([
        'From: a@b.example',
        'To: c@d.example',
        'Content-Type: multipart/alternative; boundary="XX"',
        '',
        '--XX',
        'Content-Type: text/html',
        '',
        '<p>The HTML one</p>',
        '--XX',
        'Content-Type: text/plain',
        '',
        'The text one',
        '--XX--',
      ]),
      'seven'
    );

    assert.ok(message.body.includes('The text one'));
    assert.ok(!message.body.includes('HTML'));
  });

  it('HTML only, kept as lines', () => {
    // An order written as a list has to stay a list: the item rules read
    // lines, and a table flattened onto one line reads as nothing at all.
    const message = readEml(
      eml([
        'From: a@b.example',
        'To: c@d.example',
        'Content-Type: text/html',
        '',
        '<p>Please send:</p><ul><li>12 x gloves</li><li>4 x aprons</li></ul>',
      ]),
      'eight'
    );

    const lines = message.body.split('\n').map((line) => line.trim()).filter(Boolean);
    assert.ok(lines.includes('12 x gloves'));
    assert.ok(lines.includes('4 x aprons'));
  });

  it('an encoded subject', () => {
    assert.equal(decodeWords('=?UTF-8?Q?Conferma_ordine?='), 'Conferma ordine');
    assert.equal(
      decodeWords(`=?UTF-8?B?${Buffer.from('Ordine 4471').toString('base64')}?=`),
      'Ordine 4471'
    );
  });

  it('attachment names, and only the names', () => {
    const message = readEml(
      eml([
        'From: a@b.example',
        'To: c@d.example',
        'Content-Type: multipart/mixed; boundary="YY"',
        '',
        '--YY',
        'Content-Type: text/plain',
        '',
        'See attached.',
        '--YY',
        'Content-Type: application/pdf',
        'Content-Disposition: attachment; filename="order-4471.pdf"',
        '',
        'JVBERi0=',
        '--YY--',
      ]),
      'nine'
    );

    assert.deepEqual(message.attachments, ['order-4471.pdf']);
    assert.ok(message.body.includes('See attached'));
  });
});

describe('HTML to words', () => {
  it('drops scripts and keeps the order of the text', () => {
    const text = stripTags('<div>One</div><script>ignore()</script><div>Two</div>');
    assert.equal(text, 'One\nTwo');
  });

  it('turns entities back into characters', () => {
    assert.equal(stripTags('<p>Smith &amp; Sons &#8212; 4 x masks</p>').trim(), 'Smith & Sons — 4 x masks');
  });
});
