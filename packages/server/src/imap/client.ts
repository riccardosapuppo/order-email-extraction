/**
 * Fetching the mail from a mailbox, over IMAP, by hand.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The system this was rebuilt from did not read a folder of `.eml` files. It
 * **connected to the company mailbox**, pulled what was new, and read it. That
 * is the half a demonstration usually leaves out, and leaving it out makes the
 * project look like a parser with a folder of fixtures beside it.
 *
 * So it is here, and it speaks the real protocol. What it talks to in this
 * repository is an invented server (`mail-server/imap.mjs`) holding the same
 * eleven messages, because a public repository cannot ship somebody's mailbox
 * credentials — but the client does not know that, and pointing it at a real
 * account is a matter of `--imap imaps://user:pass@imap.example.com/INBOX`.
 *
 * ── Why by hand ──────────────────────────────────────────────────────────────
 *
 * The same reason the SNMP client in a sibling project is by hand: the awkward
 * part of IMAP is small, specific, and completely hidden by a library — and it
 * is the part worth showing.
 *
 * **Literals.** IMAP does not escape message bodies. It announces a length and
 * then sends exactly that many bytes, which may contain anything, `CRLF`
 * included:
 *
 *     * 1 FETCH (UID 1 BODY[] {2847}
 *     From: ...                       <- 2847 bytes, read by COUNT
 *     )
 *     a4 OK FETCH completed
 *
 * A reader that works line by line — the obvious way to read a text protocol —
 * falls apart on the first message containing a blank line, which is every
 * message. The parser below is therefore a small state machine over a buffer
 * rather than a loop over lines, and that is the whole trick.
 *
 * **The tagged reply ends the command, not the first line back.** Untagged
 * responses (`*`) arrive in any number before it, and a client that reads one
 * line and moves on is a client that puts the previous command's leftovers into
 * the next command's answer.
 */

import net from 'node:net';
import tls from 'node:tls';

export interface Mailbox {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly folder: string;
  readonly secure: boolean;
}

/**
 * `imap://user:pass@host:143/INBOX` or `imaps://…`.
 *
 * Credentials in a URL are convenient and are not a good way to hold a
 * password: it lands in shell history and in a process list. `IMAP_PASSWORD`
 * overrides whatever is in the URL, and that is what a real deployment uses.
 */
export function mailboxFrom(url: string, env: NodeJS.ProcessEnv = process.env): Mailbox {
  const parsed = new URL(url);

  if (parsed.protocol !== 'imap:' && parsed.protocol !== 'imaps:') {
    throw new Error(`not an IMAP address: ${url}`);
  }

  const secure = parsed.protocol === 'imaps:';

  return {
    host: parsed.hostname,
    port: Number(parsed.port || (secure ? 993 : 143)),
    user: env.IMAP_USER ?? decodeURIComponent(parsed.username),
    password: env.IMAP_PASSWORD ?? decodeURIComponent(parsed.password),
    folder: decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'INBOX',
    secure,
  };
}

export interface Fetched {
  readonly uid: number;
  readonly raw: string;
}

/**
 * Connects, logs in, and returns every message in the folder.
 *
 * Everything is read in one go rather than streamed. That is a decision about
 * size, not about taste: this reads a mailbox somebody can hold, the same
 * assumption the rest of the project makes, and it is written down here so the
 * place to change it is obvious.
 */
export async function fetchAll(mailbox: Mailbox, { timeoutMs = 20_000 } = {}): Promise<Fetched[]> {
  const session = await connect(mailbox, timeoutMs);

  try {
    await session.command(`LOGIN ${quoted(mailbox.user)} ${quoted(mailbox.password)}`);
    await session.command(`SELECT ${quoted(mailbox.folder)}`);

    const search = await session.command('UID SEARCH ALL');
    const uids = uidsIn(search.untagged);

    if (uids.length === 0) return [];

    // One FETCH for the lot. A round trip per message is the shape that makes
    // a sync of two thousand messages take a minute of latency and nothing
    // else — and `BODY.PEEK[]` rather than `BODY[]` because reading a mailbox
    // must not mark it read. That flag belongs to whoever owns the mailbox.
    const fetched = await session.command(`UID FETCH ${uids.join(',')} (UID BODY.PEEK[])`);

    /**
     * From bytes back into text, here and nowhere earlier.
     *
     * The socket is read as `binary` (latin1) on purpose: one byte becomes one
     * character, which is the only way `{n}` can be counted correctly, since
     * the number in a literal is a count of BYTES. Decoding as UTF-8 while
     * reading would make `ü` one character where the server said two, and the
     * parser would then stop two bytes short of the end of every message
     * containing one — losing the tail, which is where nobody looks.
     *
     * So the counting is done in bytes and the decoding afterwards. A test
     * puts `Grüße` and `€` through the whole path for exactly this reason; it
     * failed the first time this was written, in precisely this way.
     *
     * UTF-8 is assumed, which matches the folder adapter — it reads its files
     * as UTF-8 too, so the two sources agree. A message declaring another
     * charset in its headers is the `.eml` reader's problem, not the
     * transport's, and it is named here so the boundary is visible.
     */
    return fetched.messages.map((one) => ({
      uid: one.uid,
      raw: Buffer.from(one.raw, 'binary').toString('utf8'),
    }));
  } finally {
    // LOGOUT before the socket goes, so the server closes the mailbox rather
    // than timing the session out. Best effort: a mailbox that will not say
    // goodbye is not a reason to lose the mail already fetched.
    try {
      await session.command('LOGOUT');
    } catch {
      /* never mind */
    }

    session.end();
  }
}

// ---------------------------------------------------------------------------

interface Reply {
  readonly ok: boolean;
  readonly text: string;
  readonly untagged: string[];
  readonly messages: Fetched[];
}

interface Session {
  command(text: string): Promise<Reply>;
  end(): void;
}

function connect(mailbox: Mailbox, timeoutMs: number): Promise<Session> {
  return new Promise((done, fail) => {
    const socket = mailbox.secure
      ? tls.connect({ host: mailbox.host, port: mailbox.port, servername: mailbox.host })
      : net.connect({ host: mailbox.host, port: mailbox.port });

    socket.setEncoding('binary');
    socket.setTimeout(timeoutMs);

    let buffer = '';
    let waiting: ((reply: Reply) => void) | null = null;
    let failing: ((error: Error) => void) | null = null;
    let tag = '';
    let counter = 0;

    const stop = (error: Error) => {
      const tell = failing;
      waiting = null;
      failing = null;
      socket.destroy();
      tell?.(error);
      if (!tell) fail(error);
    };

    socket.on('error', (error) => stop(error));
    socket.on('timeout', () => stop(new Error(`the mailbox stopped answering after ${timeoutMs / 1000}s`)));
    socket.on('close', () => {
      if (waiting) stop(new Error('the mailbox closed the connection mid-command'));
    });

    socket.on('data', (chunk: string) => {
      buffer += chunk;

      // Nothing is attempted until the tagged line for the current command has
      // arrived whole. Anything else and a reply split across two packets — a
      // certainty on a real network — is parsed as a truncated one.
      const reply = takeReply(buffer, tag);
      if (!reply) return;

      buffer = reply.rest;
      const tell = waiting;
      waiting = null;
      failing = null;

      tell?.(reply.value);
    });

    // The greeting has no tag, so it is waited for with an empty one.
    waiting = () => {
      done({
        command(text) {
          return new Promise<Reply>((ok, no) => {
            counter += 1;
            tag = `a${counter}`;
            waiting = (reply) => (reply.ok ? ok(reply) : no(new Error(`${text.split(' ')[0]} refused: ${reply.text}`)));
            failing = no;
            socket.write(`${tag} ${text}\r\n`, 'binary');
          });
        },
        end() {
          socket.destroy();
        },
      });
    };

    failing = fail;
  });
}

/**
 * Reads one complete reply out of the buffer, or returns null if it is not all
 * there yet.
 *
 * This is the state machine the file exists for. It walks the buffer looking
 * for either a `{n}` literal — after which exactly `n` bytes are data, whatever
 * they contain — or the tagged line that ends the command.
 */
function takeReply(buffer: string, tag: string): { value: Reply; rest: string } | null {
  const untagged: string[] = [];
  const messages: Fetched[] = [];

  let at = 0;
  let pendingUid: number | null = null;

  for (;;) {
    const end = buffer.indexOf('\r\n', at);
    if (end === -1) return null;

    const line = buffer.slice(at, end);
    const literal = line.match(/\{(\d+)\}$/);

    if (literal) {
      const size = Number(literal[1]);
      const from = end + 2;
      // The whole literal has to be here before anything is decided about it.
      if (buffer.length < from + size) return null;

      const raw = buffer.slice(from, from + size);
      const uid = pendingUid ?? Number(line.match(/UID (\d+)/)?.[1] ?? 0);
      messages.push({ uid, raw });
      pendingUid = null;

      at = from + size;
      untagged.push(line);
      continue;
    }

    at = end + 2;

    // A tag with no greeting yet: the server's `* OK …` opening line.
    if (tag === '') {
      return {
        value: { ok: /^\* (OK|PREAUTH)/.test(line), text: line, untagged: [line], messages },
        rest: buffer.slice(at),
      };
    }

    if (line.startsWith(`${tag} `)) {
      const rest = line.slice(tag.length + 1);
      return {
        value: { ok: rest.startsWith('OK'), text: rest, untagged, messages },
        rest: buffer.slice(at),
      };
    }

    untagged.push(line);
    const uid = line.match(/UID (\d+)/);
    if (uid) pendingUid = Number(uid[1]);
  }
}

/** `* SEARCH 1 2 3` → [1, 2, 3]. */
function uidsIn(untagged: readonly string[]): number[] {
  for (const line of untagged) {
    const said = line.match(/^\* SEARCH(.*)$/);
    if (!said) continue;

    return said[1]!
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((one) => Number.isInteger(one) && one > 0);
  }

  return [];
}

/**
 * An IMAP quoted string.
 *
 * A password with a quote or a backslash in it is not exotic, and an unescaped
 * one turns a LOGIN into a syntax error — which the server reports as a failed
 * login, sending whoever owns the account looking for the wrong problem.
 */
function quoted(value: string): string {
  return `"${value.replace(/([\\"])/g, '\\$1')}"`;
}
