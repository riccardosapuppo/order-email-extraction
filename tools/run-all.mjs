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
import { WHAT_GOES_WHERE, clearIfOurs } from './lib/ports.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const argv = process.argv.slice(2);
const wantsAFolder = argv.includes('--folder') || argv.includes('--imap');

const WEB = 'http://localhost:4300';
const running = [];
let closing = false;

/*
 * The ports this needs, taken back from earlier runs of this same project.
 *
 * It used to stop here and say the port was busy. That is safe and useless: the
 * usual thing on it is a mailbox this project started and did not let go of, and
 * telling somebody to go and find it is telling them to do the program's job.
 *
 * It does not kill whatever is there either. 3993, 3200 and 4300 are ports like
 * any others, and a tool that frees a port by killing the process on it will one
 * day kill something somebody was using. So each one is asked what it is, and
 * only something that answers with this project's own words is stopped. See
 * tools/lib/ports.mjs.
 */
for (const one of WHAT_GOES_WHERE) {
  // A caller who named their own mailbox is not asking for the invented one, so
  // its port is none of this run's business.
  if (wantsAFolder && one.port === 3993) continue;

  const { cleared, why } = await clearIfOurs(one);

  if (cleared) {
    if (why !== 'nothing was on it') console.error(`[both] ${why}`);
    continue;
  }

  console.error(`[both] ${one.port} is taken, where ${one.what} goes: ${why}.`);
  console.error('[both] Nothing was started. Stop it, or start this somewhere else:');
  console.error(`[both]   npm run server -- --port 3201`);

  // 2, not 1: this did not fail, it could not run.
  process.exit(2);
}

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
start('the interface', null, ['run', 'web'], { npm: true });

/*
 * Waited for by asking it, not by reading what it says about itself.
 *
 * This used to watch the development server's output for a line matching
 * `localhost:4300` or `Local:  http`. On this machine that line never matched
 * inside the two minutes allowed, so the wait ended by timing out, said
 * "carrying on anyway", and opened the browser — two minutes after the command
 * was typed, on a page that had been ready for most of them. A person watching
 * a terminal for two minutes concludes that it does not open a browser, and
 * they are not wrong about the experience.
 *
 * A readiness check that can pass by timing out is not a readiness check. This
 * asks for a page through the interface's own proxy, which is the whole path:
 * the development server compiled, the proxy configured, the API answering.
 * None of the three can confirm that on its own, and the browser opens the
 * moment it is true rather than when a pattern happens to match.
 */
const ready = await untilItAnswers(`${WEB}/api/health`, 180_000);

if (!ready) {
  console.error(`[both] ${WEB} never answered within 180s. Opening it anyway; it may not be ready.`);
}

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

    // Its own process group, everywhere but Windows, so that Ctrl+C can take
    // down the whole tree and not just the shell at the top of it. Ctrl+C
    // reaches this process directly and it stops them itself, below.
    detached: process.platform !== 'win32',
  });

  label(child.stdout, name);
  label(child.stderr, name);

  // Said out loud, in a shape another program can read.
  //
  // Whatever started this has to be able to stop it, and on Windows the only
  // handle it has is this process, whose own tree walk breaks as soon as an
  // intermediate shell exits -- which is how two of these were once left
  // listening after a run that reported itself finished. Naming each one means
  // it can be stopped by name rather than by inference.
  console.error(`[both] ${name} is pid ${child.pid}`);

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

/**
 * Poll until something answers, or until the time runs out.
 *
 * @returns {Promise<boolean>} whether it answered, so the caller can say which
 *   happened. A wait that cannot tell "ready" from "gave up" is how a timeout
 *   gets reported as success.
 */
async function untilItAnswers(url, ms) {
  const until = Date.now() + ms;

  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }

    if (Date.now() > until) return false;
    await new Promise((done) => setTimeout(done, 500));
  }
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
    //
    // This said the same thing before and then killed the one process on every
    // system but Windows, where taskkill does the tree and hid it. A negative
    // pid is the process group, which is why each of them is started in one.
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(one.child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {
        one.child.kill();
      });
    } else {
      try {
        process.kill(-one.child.pid, 'SIGTERM');
      } catch {
        try {
          one.child.kill();
        } catch {
          /* already gone */
        }
      }
    }
  }

  setTimeout(() => process.exit(code), 600);
}
