/**
 * Runs the server.
 *
 *     npm start
 *     npm start -- --folder ./mail --port 8080
 *
 * Localhost only, with no default that reaches further: this reads a folder of
 * somebody's email, and a tool that serves that on every interface the moment
 * it starts has made a decision on their behalf.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from './api.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
}

const folder = argument('folder', path.join(here, '..', '..', '..', '..', 'mail'));
const port = Number(argument('port', '3000'));
const host = argument('host', '127.0.0.1');

const api = build({
  folder,
  settings: {
    // Which domains are suppliers, so their replies are read as answers
    // rather than as new orders. In a real deployment this comes from the
    // supplier list; here it is the demonstration mailbox's one supplier.
    supplierDomains: argument('suppliers', 'medisupply.example').split(','),
  },
});

api.listen(port, host, () => {
  console.log(`reading ${path.resolve(folder)}`);
  console.log(`http://${host}:${port}/api/orders`);
});
