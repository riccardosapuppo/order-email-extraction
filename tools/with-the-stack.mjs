/**
 * Start the whole thing a check needs, and stop it again.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `check:screen` and `screenshots` used to open `http://localhost:4300` and
 * expect somebody to have started three processes first. Two failure modes, and
 * the second is much worse.
 *
 * On a clean machine they fail, which is honest — and means the publication
 * gate cannot run them, so they run only when somebody remembers.
 *
 * And on a machine where anything *is* on 4300, they pass against whatever that
 * is: a development server from an hour ago, on an older commit, serving an
 * older page. A green check that checked the wrong thing is worse than no
 * check, because no check leaves the doubt, and the doubt is what makes anybody
 * look.
 *
 * ── Why it takes the real ports rather than private ones ─────────────────────
 *
 * The interface proxies `/api` to `http://localhost:3200`, written down in
 * `proxy.conf.json`, so moving the server means a second proxy config that
 * exists only for checks — and a config only checks use is a config that drifts
 * from the one people use.
 *
 * So this takes 3993, 3200 and 4300, and **refuses to run if any of them is
 * already busy**. That is the same guarantee by a different route: it either
 * owns what it is testing or says it cannot test anything. What it never does
 * is quietly measure a stranger.
 *
 * It starts them by running `npm start`: the same command a person runs, which
 * is the only version of this that cannot drift from what it is checking.
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/** What `npm start` binds, and what this therefore needs to itself. */
export const PORTS = [
  { port: 3993, what: 'the invented mailbox' },
  { port: 3200, what: 'the server' },
  { port: 4300, what: 'the interface' },
];

export const WEB = 'http://localhost:4300';

/** `--against http://…`, when somebody means to check a running instance. */
export function against(argv = process.argv) {
  const at = argv.indexOf('--against');
  return at !== -1 && argv[at + 1] ? argv[at + 1] : null;
}

function free(port) {
  return new Promise((done) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      done(false);
    });
    socket.once('error', () => done(true));
    socket.setTimeout(1500, () => {
      socket.destroy();
      done(true);
    });
  });
}

/**
 * @returns {Promise<{base: string, stop: () => Promise<void>, mine: boolean}>}
 */
export async function startTheStack({ quiet = true } = {}) {
  const already = against();

  if (already) {
    console.log(`Against ${already}, which somebody else started.\n`);
    return { base: already, mine: false, stop: async () => {} };
  }

  for (const { port, what } of PORTS) {
    if (await free(port)) continue;

    console.error(`Something is already listening on 127.0.0.1:${port}, where ${what} goes.`);
    console.error('This check will not run against it: it has no way to know what that is.');
    console.error('Stop it and try again, or point this at it on purpose:');
    console.error(`  npm run check:screen -- --against ${WEB}`);
    process.exit(2);
  }

  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['start', '--', '--no-open'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    // `.cmd` files need a shell since Node closed a command-injection hole in
    // how Windows parses their arguments. Every argument here is written above.
    shell: process.platform === 'win32',
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let said = '';
  const watch = (chunk) => {
    said += chunk;
    if (!quiet) process.stderr.write(chunk);
  };

  child.stdout.on('data', watch);
  child.stderr.on('data', watch);

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      // The tree: `npm start` is a shell that starts a launcher that starts
      // three things. Killing the shell alone leaves all three.
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => child.kill());
      } else {
        child.kill();
      }
    }

    await new Promise((done) => setTimeout(done, 1200));
  };

  try {
    await untilItAnswers(`${WEB}/api/health`, 180_000, () => {
      if (child.exitCode !== null) throw new Error(`npm start exited with ${child.exitCode}. It said:\n${said}`);
    });

    return { base: WEB, mine: true, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function withTheStack(body, options = {}) {
  const stack = await startTheStack(options);

  try {
    return await body(stack.base);
  } finally {
    await stack.stop();
  }
}

/**
 * Poll until the interface answers *through its proxy*.
 *
 * Not until 4300 accepts a connection: the development server binds long before
 * it has compiled anything, and it will happily hold a request open while it
 * does. And not until 3200 answers either — what a check needs is the whole
 * path, which is the one thing neither process can confirm on its own.
 */
async function untilItAnswers(url, ms, stillAlive) {
  const until = Date.now() + ms;

  for (;;) {
    stillAlive();

    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }

    if (Date.now() > until) throw new Error(`${url} never answered within ${ms / 1000}s`);
    await new Promise((done) => setTimeout(done, 500));
  }
}
