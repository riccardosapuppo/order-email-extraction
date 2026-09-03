/**
 * Runs the server.
 *
 *     npm start
 *     npm run server -- --folder ./mail --port 3200
 *     npm run server -- --imap imap://anybody:anything@127.0.0.1:3993/INBOX
 *
 * Localhost only, with no default that reaches further: this reads somebody's
 * email, and a tool that serves that on every interface the moment it starts
 * has made a decision on their behalf.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from './api.js';
import { sourceFrom } from './source.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1]! : undefined;
}

const folder = argument('folder', path.join(here, '..', '..', '..', '..', 'mail'));

/**
 * Where the mail comes from.
 *
 * A folder of `.eml` files by default, because that is what a mail client
 * exports and it needs nothing running. `--imap` is what the original actually
 * did, and it speaks the real protocol — see `imap/client.ts`. `IMAP_URL` is
 * the same thing from the environment, which is where a deployment keeps it.
 */
const source = sourceFrom({ imap: flag('imap') ?? process.env.IMAP_URL, folder });

/**
 * 3200, and not 3000.
 *
 * 3000 and 4200 are the ports every project on a machine uses in turn, and the
 * time lost to that is not hypothetical: another project left a server on 3000
 * and this one talked to it quite happily, answering questions about a system
 * it has nothing to do with. Worse, a browser remembers things per ORIGIN —
 * service workers, storage, permissions — so two projects sharing a port share
 * state neither knows about.
 *
 * A port nobody else defaults to costs nothing and removes the whole class of
 * confusion. The interface is on 4300 for the same reason.
 */
const port = Number(argument('port', '3200'));
const host = argument('host', '127.0.0.1');

const { api, reload } = build({
  source,
  settings: {
    // Which domains are suppliers, so their replies are read as answers
    // rather than as new orders. In a real deployment this comes from the
    // supplier list; here it is the demonstration mailbox's one supplier.
    supplierDomains: argument('suppliers', 'medisupply.example').split(','),
  },
});

/**
 * Fetch once, before listening.
 *
 * Not after. A server that accepts requests while its first sync is still
 * running answers the first few with an empty mailbox, and whoever is looking
 * concludes there is no mail rather than that there is not mail *yet*.
 *
 * A mailbox that cannot be reached is fatal here, and only here. At startup it
 * means the address or the password is wrong and there is nothing to serve. On
 * a later `POST /api/reload` it means a blip, and the right answer there is to
 * keep the previous snapshot and say so — which is what the API does.
 */
try {
  const mailbox = await reload();
  console.log(`read ${mailbox.entries.length} messages from ${source.describes}`);
} catch (error) {
  console.error(`Could not read ${source.describes}: ${(error as Error).message}`);
  console.error('If that is an IMAP address: check the host, the port, and IMAP_PASSWORD.');
  console.error('The invented mailbox is started by `npm run mailbox`.');
  process.exit(1);
}

api.listen(port, host, () => {
  console.log(`http://${host}:${port}/api/orders`);
});
