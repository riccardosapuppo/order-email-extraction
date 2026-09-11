/**
 * What is on a port, and whether it is ours.
 *
 * ── Why this is not just "is the port free" ──────────────────────────────────
 *
 * Three things here take a fixed port, and a run that finds one busy has two
 * bad options and one good one.
 *
 * Refusing to start is safe and useless: the usual reason a port is busy is a
 * previous run of this same project that did not let go, and telling somebody
 * to go and find it themselves is telling them to do the program's job. That is
 * what this used to do, and it is what somebody ran into: `npm start`, a build,
 * and then "Something is already listening on 127.0.0.1:3993", from a mailbox
 * this project had started ten minutes earlier.
 *
 * Killing whatever is there is worse. The port a development server uses is the
 * port every project on a machine uses in turn, and a tool that frees a port by
 * killing the process on it will one day kill something somebody was using.
 *
 * So it asks. Each of the three says something only it says: the invented
 * mailbox greets an IMAP client with its own name, the server answers
 * /api/health with the name of this project, and the interface serves a page
 * with this project's title in it. Something that answers with the right words
 * is ours and gets stopped. Something that answers with anything else is a
 * stranger and is left alone, and the run says what it saw rather than only
 * that the port was taken.
 *
 * A port that answers is not proof it is yours, and this is what asking the
 * question costs: one connection each.
 */

import { spawn } from 'node:child_process';
import net from 'node:net';

/** Who takes what, and the words each of them answers with. */
export const WHAT_GOES_WHERE = [
  { port: 3993, what: 'the invented mailbox', how: 'imap', marker: 'invented mailbox' },
  { port: 3200, what: 'the server', how: 'http', path: '/api/health', marker: 'order-email-extraction' },
  { port: 4300, what: 'the interface', how: 'http', path: '/', marker: 'Orders from email' },
];

/** Whether nothing at all answers. */
export function free(port) {
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
 * @returns {Promise<{state: 'free'|'ours'|'stranger', saw: string}>}
 *   `saw` is the first line of whatever answered, for the message a person
 *   reads. "Something is on 4300" sends them looking; "something on 4300 that
 *   calls itself Vite" tells them which window to close.
 */
export async function whoIsOn(one) {
  if (await free(one.port)) return { state: 'free', saw: '' };

  const saw = one.how === 'imap' ? await imapGreeting(one.port) : await firstLineOf(one.port, one.path);

  return { state: saw.includes(one.marker) ? 'ours' : 'stranger', saw: saw.trim() };
}

/**
 * Stop what is on the port, if it is ours.
 *
 * @returns {Promise<{cleared: boolean, why: string}>}
 */
export async function clearIfOurs(one) {
  const found = await whoIsOn(one);

  if (found.state === 'free') return { cleared: true, why: 'nothing was on it' };
  if (found.state === 'stranger') {
    return { cleared: false, why: found.saw ? `something else is there: ${short(found.saw)}` : 'something else is there' };
  }

  const pid = await pidOn(one.port);
  if (!pid) return { cleared: false, why: `it is ${one.what} from an earlier run, and nothing here could find its pid` };

  await stopTheTree(pid);

  // Asked rather than assumed. Everything else in this repository that kills
  // something and then reports success has been wrong at least once.
  for (let waited = 0; waited < 20; waited += 1) {
    if (await free(one.port)) return { cleared: true, why: `stopped ${one.what} from an earlier run (pid ${pid})` };
    await new Promise((done) => setTimeout(done, 250));
  }

  return { cleared: false, why: `${one.what} from an earlier run (pid ${pid}) would not stop` };
}

// ---------------------------------------------------------------------------

function imapGreeting(port) {
  return new Promise((done) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let said = '';

    const finish = () => {
      socket.destroy();
      done(said);
    };

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      said += chunk;
      if (said.includes('\n')) finish();
    });
    socket.once('error', finish);
    socket.setTimeout(2000, finish);
  });
}

async function firstLineOf(port, path) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path ?? '/'}`, {
      signal: AbortSignal.timeout(2500),
    });
    return await response.text();
  } catch (error) {
    return `did not answer HTTP: ${(error instanceof Error ? error.message : String(error))}`;
  }
}

/** The pid listening on a port, asked of the operating system. */
async function pidOn(port) {
  const [command, args] =
    process.platform === 'win32'
      ? ['netstat', ['-ano', '-p', 'TCP']]
      : ['lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']];

  const said = await output(command, args);
  if (said === null) return null;

  if (process.platform !== 'win32') {
    const first = said.split(/\s+/).filter(Boolean)[0];
    return first ? Number(first) : null;
  }

  for (const line of said.split(/\r?\n/)) {
    // The local address column, ending in the port, and only where it is
    // listening: an outgoing connection to this port is somebody else's.
    if (!/LISTENING/i.test(line)) continue;
    const columns = line.trim().split(/\s+/);
    const local = columns[1] ?? '';
    if (!local.endsWith(`:${port}`)) continue;
    const pid = Number(columns[columns.length - 1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }

  return null;
}

function stopTheTree(pid) {
  if (process.platform === 'win32') {
    return output('taskkill', ['/PID', String(pid), '/T', '/F']);
  }

  // The group where there is one, then the process. A development server keeps
  // a watcher under it, and killing only the top leaves the port held.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }

  return Promise.resolve('');
}

function output(command, args) {
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let said = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      said += chunk;
    });
    child.on('error', () => done(null));
    child.on('close', () => done(said));
  });
}

function short(text) {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 90 ? `${one.slice(0, 87)}...` : one;
}
