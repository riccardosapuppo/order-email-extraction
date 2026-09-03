#!/usr/bin/env node
/**
 * An invented mailbox, answering real IMAP.
 *
 *     npm run mailbox
 *     npm run mailbox -- --port 3993 --folder ./mail
 *
 * The client in `packages/server/src/imap/client.ts` speaks the protocol; this
 * is something for it to speak to. Between them the fetching half of the
 * project is demonstrated end to end, on one machine, with no account
 * anywhere — which is the only way it can be shown at all, because a public
 * repository cannot ship somebody's mailbox credentials.
 *
 * It implements the subset the client uses and refuses the rest by saying so,
 * rather than by pretending:
 *
 *     CAPABILITY  LOGIN  SELECT  UID SEARCH  UID FETCH  NOOP  LOGOUT
 *
 * ── The one thing worth reading ──────────────────────────────────────────────
 *
 * `{n}` literals, from the sending side. A message body is not escaped and not
 * quoted: its length is announced and then exactly that many bytes go down the
 * socket. Everything in this file that looks fussy about byte counts is fussy
 * on purpose — the length is a count of **bytes**, and an accented character is
 * one character and two bytes. Counting characters leaves the client waiting
 * for a byte that never comes, or reading the closing parenthesis as part of
 * the message.
 *
 * The eleven invented messages here happen to be pure ASCII, where the two
 * counts agree and the bug is invisible. So the test does not rely on them:
 * `packages/server/test/imap.test.ts` puts a message with `Grüße` and `€` in
 * it through this server and asserts it comes back byte for byte.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const PORT = Number(argument('port', process.env.IMAP_PORT ?? 3993));
const HOST = '127.0.0.1';
const FOLDER = path.resolve(argument('folder', path.join(here, '..', 'mail')));

/**
 * Anybody, with anything.
 *
 * This holds invented mail and listens on localhost only. A password check
 * would be theatre — and worse, theatre that somebody might mistake for a
 * security property. What is real is that it binds to 127.0.0.1 and nothing
 * else: a mail server on every interface is a thing found by strangers.
 */
const ACCEPTS_ANYBODY = true;

const messages = load();

function load() {
  const files = fs
    .readdirSync(FOLDER)
    .filter((name) => name.toLowerCase().endsWith('.eml'))
    .sort();

  return files.map((file, n) => ({
    uid: n + 1,
    file,
    // Read as bytes. Turning it into a string here and counting characters
    // later is precisely the bug this server exists to not have.
    raw: fs.readFileSync(path.join(FOLDER, file)),
  }));
}

const server = net.createServer((socket) => {
  let selected = false;
  let buffer = '';

  const send = (line) => socket.write(`${line}\r\n`, 'binary');

  socket.setEncoding('binary');
  send('* OK [CAPABILITY IMAP4rev1] invented mailbox, holding nothing real');

  socket.on('data', (chunk) => {
    buffer += chunk;

    for (;;) {
      const end = buffer.indexOf('\r\n');
      if (end === -1) return;

      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      handle(line);
    }
  });

  socket.on('error', () => socket.destroy());

  function handle(line) {
    const space = line.indexOf(' ');
    const tag = space === -1 ? line : line.slice(0, space);
    const rest = space === -1 ? '' : line.slice(space + 1);
    const verb = rest.split(' ')[0]?.toUpperCase() ?? '';

    if (verb === 'CAPABILITY') {
      send('* CAPABILITY IMAP4rev1');
      return send(`${tag} OK CAPABILITY completed`);
    }

    if (verb === 'LOGIN') {
      if (!ACCEPTS_ANYBODY) return send(`${tag} NO [AUTHENTICATIONFAILED] no`);
      return send(`${tag} OK LOGIN completed`);
    }

    if (verb === 'SELECT' || verb === 'EXAMINE') {
      selected = true;
      send(`* ${messages.length} EXISTS`);
      send('* 0 RECENT');
      send('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)');
      send(`* OK [UIDVALIDITY 1] UIDs are stable for the life of this process`);
      send(`* OK [UIDNEXT ${messages.length + 1}] the next one would be this`);
      return send(`${tag} OK [READ-ONLY] SELECT completed`);
    }

    if (verb === 'NOOP') return send(`${tag} OK NOOP completed`);

    if (verb === 'LOGOUT') {
      send('* BYE invented mailbox signing off');
      send(`${tag} OK LOGOUT completed`);
      return socket.end();
    }

    if (verb === 'UID') {
      if (!selected) return send(`${tag} BAD nothing is selected`);

      const what = rest.split(/\s+/)[1]?.toUpperCase() ?? '';

      if (what === 'SEARCH') {
        // Every message, in order. This server has no criteria and says so
        // rather than accepting `SINCE` and quietly ignoring it, which is how
        // a client comes to believe it has done an incremental sync.
        const criteria = rest.split(/\s+/).slice(2).join(' ').toUpperCase();

        if (criteria && criteria !== 'ALL') {
          return send(`${tag} NO this mailbox only understands SEARCH ALL, and will not pretend otherwise`);
        }

        send(`* SEARCH ${messages.map((one) => one.uid).join(' ')}`);
        return send(`${tag} OK UID SEARCH completed`);
      }

      if (what === 'FETCH') {
        const set = rest.split(/\s+/)[2] ?? '';
        const wanted = expand(set);

        for (const uid of wanted) {
          const message = messages.find((one) => one.uid === uid);
          if (!message) continue;

          // `Buffer.byteLength`, not `String.length`. The invented mail has
          // `Grüße` and `€` in it on purpose, and a count of characters is
          // wrong for both -- leaving the client either short of the body or
          // reading the closing parenthesis as part of it.
          const size = message.raw.length;

          socket.write(`* ${uid} FETCH (UID ${uid} BODY[] {${size}}\r\n`, 'binary');
          socket.write(message.raw);
          socket.write(')\r\n', 'binary');
        }

        return send(`${tag} OK UID FETCH completed`);
      }

      return send(`${tag} BAD this mailbox does not do UID ${what}`);
    }

    send(`${tag} BAD this mailbox does not understand ${verb || 'that'}`);
  }
});

/** `1,3:5` → [1, 3, 4, 5]. `*` means the last one. */
function expand(set) {
  const last = messages.at(-1)?.uid ?? 0;
  const out = [];

  for (const part of set.split(',')) {
    const [from, to] = part.split(':');
    const start = from === '*' ? last : Number(from);

    if (to === undefined) {
      if (Number.isInteger(start)) out.push(start);
      continue;
    }

    const end = to === '*' ? last : Number(to);
    for (let n = Math.min(start, end); n <= Math.max(start, end); n += 1) out.push(n);
  }

  return [...new Set(out)].filter((one) => Number.isInteger(one) && one > 0);
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Something is already listening on ${HOST}:${PORT}.`);
    console.error(`Try:  npm run mailbox -- --port ${PORT + 1}`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      message: 'listening',
      imap: `imap://anybody:anything@${HOST}:${PORT}/INBOX`,
      messages: messages.length,
      from: FOLDER,
      note: 'every message in here is invented',
    })
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
