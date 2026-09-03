/**
 * The IMAP client, against the invented mailbox.
 *
 * Two kinds of test, and the first is the one that matters.
 *
 * **Against a real server.** The client and the invented mailbox are started
 * and made to talk, over a socket, with a message written for the occasion.
 * Anything the two of them agree on and get wrong stays wrong — which is why
 * the fixture below is chosen to be awkward in the ways a real mailbox is
 * rather than in the ways this pair finds convenient.
 *
 * **The address parsing**, which is small, has no server in it, and is where a
 * password with a punctuation mark in it goes wrong quietly.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { fetchAll, mailboxFrom } from '../src/imap/client.js';

/**
 * The repository root, found rather than counted.
 *
 * These tests run from `packages/server/build/test`, not from where they are
 * written, so any fixed number of `..` is a number that is right in one of the
 * two places. Walking up until the thing being looked for appears is right in
 * both — and says what it is looking for.
 */
function rootHolding(what: string): string {
  let at = path.dirname(fileURLToPath(import.meta.url));

  for (let up = 0; up < 8; up += 1) {
    if (fs.existsSync(path.join(at, what))) return at;
    at = path.dirname(at);
  }

  throw new Error(`no ${what} above ${fileURLToPath(import.meta.url)}`);
}

const root = rootHolding(path.join('mail-server', 'imap.mjs'));

/**
 * A folder of messages built for this test, not the demonstration mailbox.
 *
 * The eleven invented messages are pure ASCII, where a count of characters and
 * a count of bytes agree — so a client that counted the wrong one would pass
 * against them and fail on the first real mailbox. These do not agree.
 */
const AWKWARD = [
  {
    name: '01-plain.eml',
    body: ['From: a@example.com', 'Subject: ordinary', '', 'Nothing unusual in here at all.', ''].join('\r\n'),
  },
  {
    name: '02-multi-byte.eml',
    // ü is one character and two bytes; € is one character and three. A literal
    // sized by String.length is short by four here, and the client would read
    // the closing parenthesis as the last four bytes of the message.
    body: ['From: b@example.com', 'Subject: Grüße', '', 'Total 1 250,00 € — mit Grüßen.', ''].join('\r\n'),
  },
  {
    name: '03-blank-lines-and-a-dot.eml',
    // A body with blank lines in it, and a line that is a single dot. A reader
    // that works line by line, or that borrowed SMTP's end-of-message rule,
    // stops in the middle of this one.
    body: [
      'From: c@example.com',
      'Subject: awkward',
      '',
      'One.',
      '',
      '.',
      '',
      'Three, after a line that was just a dot.',
      '',
    ].join('\r\n'),
  },
  {
    name: '04-long.eml',
    // Bigger than a socket chunk, so the reply arrives in pieces and the
    // reassembly is exercised rather than assumed.
    body: ['From: d@example.com', 'Subject: long', '', 'x'.repeat(120_000), ''].join('\r\n'),
  },
];

let folder = '';
let server: ChildProcess | null = null;
const PORT = 3994;

before(async () => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-test-'));
  for (const one of AWKWARD) fs.writeFileSync(path.join(folder, one.name), one.body, 'utf8');

  server = spawn(process.execPath, [path.join(root, 'mail-server', 'imap.mjs'), '--port', String(PORT), '--folder', folder], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise<void>((done, fail) => {
    const giveUp = setTimeout(() => fail(new Error('the invented mailbox did not start')), 10_000);

    server!.stdout!.setEncoding('utf8');
    server!.stdout!.on('data', (chunk: string) => {
      if (chunk.includes('"listening"')) {
        clearTimeout(giveUp);
        done();
      }
    });

    server!.on('exit', (code) => {
      clearTimeout(giveUp);
      fail(new Error(`the invented mailbox exited with ${code}`));
    });
  });
});

after(() => {
  server?.kill();
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
});

const mailbox = () => mailboxFrom(`imap://anybody:anything@127.0.0.1:${PORT}/INBOX`);

describe('fetching mail over IMAP', () => {
  it('every message comes back, in order, with its uid', async () => {
    const fetched = await fetchAll(mailbox());

    assert.equal(fetched.length, AWKWARD.length);
    assert.deepEqual(
      fetched.map((one) => one.uid),
      [1, 2, 3, 4]
    );
  });

  it('a message with multi-byte characters comes back byte for byte', async () => {
    const fetched = await fetchAll(mailbox());
    const got = fetched.find((one) => one.uid === 2)!.raw;
    const expected = AWKWARD[1]!.body;

    // Both halves, on purpose. The characters must survive, and so must the
    // LENGTH: a literal sized in characters rather than bytes truncates by
    // exactly the number of extra bytes, and the last thing lost is the end of
    // the message, which is where nobody looks.
    assert.ok(got.includes('Grüße'), `the accents did not survive: ${JSON.stringify(got.slice(0, 120))}`);
    assert.ok(got.includes('€'), 'the euro sign did not survive');
    assert.equal(Buffer.byteLength(got, 'utf8'), Buffer.byteLength(expected, 'utf8'));
  });

  it('a body with blank lines and a bare dot in it is not cut short', async () => {
    const fetched = await fetchAll(mailbox());
    const got = fetched.find((one) => one.uid === 3)!.raw;

    assert.ok(
      got.includes('Three, after a line that was just a dot.'),
      'a reader that stops at a lone dot borrowed that rule from SMTP, where it belongs'
    );
  });

  it('a message larger than one socket chunk is reassembled', async () => {
    const fetched = await fetchAll(mailbox());
    const got = fetched.find((one) => one.uid === 4)!.raw;

    assert.equal(Buffer.byteLength(got, 'utf8'), Buffer.byteLength(AWKWARD[3]!.body, 'utf8'));
    assert.ok(got.endsWith('x\r\n') || got.endsWith('x'), 'the tail of a long message went missing');
  });

  it('the reply that ends a command is the tagged one, not the first line back', async () => {
    // SELECT answers with six untagged lines before its tagged OK. A client
    // that stopped at the first line would leave five in the buffer and hand
    // them to the next command as if they were its answer.
    const fetched = await fetchAll(mailbox());
    assert.equal(fetched.length, AWKWARD.length, 'a leftover line was read as part of the next reply');
  });

  it('a mailbox that is not there fails with a sentence, not a hang', async () => {
    const nowhere = mailboxFrom('imap://nobody:nothing@127.0.0.1:3891/INBOX');

    await assert.rejects(() => fetchAll(nowhere, { timeoutMs: 3000 }), (error: Error) => {
      assert.ok(error.message.length > 5, 'an error with nothing in it');
      return true;
    });
  });
});

describe('reading a mailbox address', () => {
  it('takes host, port, user, password and folder', () => {
    const one = mailboxFrom('imap://someone:secret@mail.example.com:1143/Archive', {});

    assert.equal(one.host, 'mail.example.com');
    assert.equal(one.port, 1143);
    assert.equal(one.user, 'someone');
    assert.equal(one.password, 'secret');
    assert.equal(one.folder, 'Archive');
    assert.equal(one.secure, false);
  });

  it('imaps means TLS, and 993 when no port is given', () => {
    const one = mailboxFrom('imaps://someone:secret@mail.example.com/INBOX', {});

    assert.equal(one.secure, true);
    assert.equal(one.port, 993);
  });

  it('and 143 for plain imap with no port', () => {
    assert.equal(mailboxFrom('imap://a:b@h/INBOX', {}).port, 143);
  });

  it('INBOX when no folder is named', () => {
    assert.equal(mailboxFrom('imap://a:b@h', {}).folder, 'INBOX');
    assert.equal(mailboxFrom('imap://a:b@h/', {}).folder, 'INBOX');
  });

  it('a password with punctuation in it survives the URL', () => {
    // %40 is an @. Unescaped it would end the credentials early and the host
    // would come out wrong, which reads as "the server is down".
    const one = mailboxFrom('imap://someone:p%40ss%3Aword@mail.example.com/INBOX', {});

    assert.equal(one.password, 'p@ss:word');
    assert.equal(one.host, 'mail.example.com');
  });

  it('the environment wins over the URL, which is where a password belongs', () => {
    const one = mailboxFrom('imap://someone:in-the-url@mail.example.com/INBOX', {
      IMAP_PASSWORD: 'from-the-environment',
    } as NodeJS.ProcessEnv);

    assert.equal(one.password, 'from-the-environment');
  });

  it('something that is not an IMAP address says so', () => {
    assert.throws(() => mailboxFrom('https://mail.example.com/INBOX', {}), /not an IMAP address/);
  });
});
