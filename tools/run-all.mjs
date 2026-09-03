#!/usr/bin/env node
/**
 * One command: the mailbox, the server that reads it, and the interface.
 *
 *     npm start
 *     npm start -- --folder ./mail        read a folder instead of the mailbox
 *     npm start -- --imap imaps://…       read a real one
 *
 * Three processes, and until now they were three commands in three terminals.
 * Whoever is looking at this has a few minutes and a browser tab; a README
 * whose first instruction is a manoeuvre does not get followed, and the project
 * is then judged on how it is written about rather than on what it does.
 *
 * Each is still available on its own, and the README says so after this:
 *
 *     npm run mailbox     just the invented IMAP server
 *     npm run server      just the API, for pointing at a real mailbox
 *     npm run web         just the interface
 *
 * The middle one is the actual use. Somebody with a real account should not
 * have to start an invented mailbox first.
 *
 * ── The order matters, and so does waiting ───────────────────────────────────
 *
 * The server fetches once before it listens, so if the invented mailbox is not
 * up yet the server exits saying it could not connect — correctly, and
 * confusingly, because nothing was wrong. So each is waited for by reading what
 * it says, never by sleeping a guessed number of milliseconds on a machine that
 * may be slower than the one this was written on.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openInABrowser } from './open-a-browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const argv = process.argv.slice(2);
const wantsAFolder = argv.includes('--folder') || argv.includes('--imap');

const WEB = 'http://localhost:4300';
const running = [];
let closing = false;

/**
 * The invented mailbox, unless the caller named a source of their own.
 *
 * Starting an IMAP server nobody asked for, beside a real mailbox somebody did
 * ask for, would be two mailboxes and a coin toss about which was read.
 */
if (!wantsAFolder) {
  const mailbox = start('the mailbox', path.join(root, 'mail-server', 'imap.mjs'), []);
  await untilItSays(mailbox, /"message":"listening"/, 15_000, 'the invented mailbox');
}

const server = start(
  'the server',
  path.join(root, 'packages', 'server', 'build', 'src', 'main.js'),
  wantsAFolder ? argv : ['--imap', 'imap://anybody:anything@127.0.0.1:3993/INBOX', ...argv]
);

await untilItSays(server, /\/api\/orders/, 20_000, 'the server');

// The Angular development server, which proxies /api to the one above. Started
// through npm because its binary lives in the workspace, not here.
const web = start('the interface', null, ['run', 'web'], { npm: true });

await untilItSays(web, /localhost:4300|Local:\s+http/, 120_000, 'the interface');

const browser = openInABrowser(WEB, { argv });
console.error(`[both] ${browser.opened ? `opening ${WEB}` : `not opening a browser: ${browser.why}`}`);
console.error('[both] Ctrl+C stops all of them.');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => closeEverything(0));
}

// ---------------------------------------------------------------------------

function start(name, script, args, { npm = false } = {}) {
  const command = npm ? (process.platform === 'win32' ? 'npm.cmd' : 'npm') : process.execPath;
  const argv = npm ? args : [script, ...args];

  /**
   * `shell` for the `.cmd`, and only for it.
   *
   * Node stopped spawning `.cmd` and `.bat` files without a shell — the fix for
   * a command-injection hole in how Windows parses their arguments — and the
   * refusal is `Error: spawn EINVAL`, five words that say nothing about
   * batch files, npm or Windows. It cost a run to identify.
   *
   * A shell is acceptable here because every argument is written in this file
   * and none comes from anybody. Where the command is `process.execPath` there
   * is no shell, because there is no reason for one.
   */
  const child = spawn(command, argv, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: npm && process.platform === 'win32',
  });

  label(child.stdout, name);
  label(child.stderr, name);

  child.on('error', (error) => {
    console.error(`[${name}] would not start: ${error.message}`);
    closeEverything(1);
  });

  child.on('exit', (code) => {
    if (closing) return;
    console.error(`[${name}] stopped${code ? ` with code ${code}` : ''}, so this is stopping too.`);
    closeEverything(code ?? 0);
  });

  running.push({ name, child });
  return child;
}

/**
 * Prefix each line with which process said it.
 *
 * By line rather than by chunk: the server writes one JSON object per line, and
 * a chunk boundary lands wherever the pipe put it — routinely mid-object, which
 * would put the label inside a record and make the log unparseable.
 */
function label(stream, name) {
  if (!stream) return;

  let rest = '';

  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) process.stdout.write(`[${name}] ${line}\n`);
  });

  stream.on('end', () => {
    if (rest) process.stdout.write(`[${name}] ${rest}\n`);
  });
}

function untilItSays(child, pattern, ms, what) {
  return new Promise((done) => {
    let seen = '';

    const giveUp = setTimeout(() => {
      console.error(`[both] ${what} did not say it was ready within ${ms / 1000}s; carrying on anyway`);
      finish();
    }, ms);

    const look = (chunk) => {
      seen += chunk;
      if (pattern.test(seen)) finish();
    };

    function finish() {
      clearTimeout(giveUp);
      child.stdout?.off('data', look);
      child.stderr?.off('data', look);
      done();
    }

    child.stdout?.on('data', look);
    // The Angular server announces itself on stderr on some versions, which is
    // the sort of thing that makes a readiness check pass by timing out.
    child.stderr?.on('data', look);
  });
}

function closeEverything(code) {
  if (closing) return;
  closing = true;

  for (const one of running) {
    if (one.child.exitCode !== null || one.child.signalCode !== null) continue;

    // The tree, not the process. `npm run web` is a shell that starts Angular,
    // which starts a watcher; killing the shell alone leaves a development
    // server holding 4300 that the next run fights with.
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(one.child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {
        one.child.kill();
      });
    } else {
      one.child.kill();
    }
  }

  setTimeout(() => process.exit(code), 600);
}
