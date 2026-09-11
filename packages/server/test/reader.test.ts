import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { build } from '../src/api.js';

/**
 * Switching reader, over HTTP, against the real folder.
 *
 * None of this needs a key and none of it reaches the network: what is asserted
 * is the part that is ours -- that the endpoint refuses what it should refuse,
 * says why in words a screen can show, and never sends a key back.
 *
 * The one case worth having is the wrong key, and it is checked without one: a
 * reader that cannot read anything has to come back as an error with the reason
 * in it, not as a successful switch to a mailbox that has gone empty. That was
 * the first shape of this endpoint and it would have reported a bad key as
 * "read again: 0 orders".
 *
 * That last check is the only thing here that touches the outside: with a
 * network it makes one refused authentication per message, and without one the
 * requests fail at the socket. Both produce the same shape, which is the point
 * -- it asserts what this code does with a reader that returns nothing, and
 * that is true whichever way the reader failed.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIL = path.join(here, '..', '..', '..', '..', 'mail');

let base: string;
let close: () => void;

before(async () => {
  const { api, reload } = build({ folder: MAIL, settings: { supplierDomains: ['medisupply.example'] } });
  await reload();

  const server = api.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));

  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

after(() => close());

function ask(body: unknown) {
  return fetch(`${base}/api/reader`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('choosing who reads, over HTTP', () => {
  it('starts on the rules and says so', async () => {
    const health = (await (await fetch(`${base}/api/health`)).json()) as {
      readerName: string;
      couldBeAModel: boolean;
    };

    assert.equal(health.readerName, 'rules');
    assert.equal(health.couldBeAModel, true);
  });

  it('refuses a reader it does not have', async () => {
    const answer = await ask({ reader: 'telepathy' });
    assert.equal(answer.status, 400);

    const said = (await answer.json()) as { error: string };
    assert.match(said.error, /rules.*model/);
  });

  it('refuses the model with no key, and says which one is missing', async () => {
    const answer = await ask({ reader: 'model' });
    assert.equal(answer.status, 400);

    const said = (await answer.json()) as { error: string };
    assert.match(said.error, /ANTHROPIC_API_KEY/);
  });

  it('reads the mailbox again when asked for the rules, and counts what it found', async () => {
    const answer = await ask({ reader: 'rules' });
    assert.equal(answer.status, 200);

    const now = (await answer.json()) as { readerName: string; messages: number; orders: number; doubts: number };
    assert.equal(now.readerName, 'rules');
    assert.equal(now.messages, 11);
    assert.ok(now.orders > 0, 'the folder has orders in it');
    assert.equal(typeof now.doubts, 'number');
  });

  it('never sends a key back, whatever it is given', async () => {
    const answer = await ask({ reader: 'rules', key: 'sk-ant-not-a-real-key' });
    const text = await answer.text();

    assert.ok(!text.includes('sk-ant-not-a-real-key'), text);
  });

  it('comes back to the rules when a reader can read nothing', async () => {
    // A key-shaped string that is not a key. Every message fails, which must
    // read as a broken reader and not as an empty mailbox -- and the rules have
    // to be reading again afterwards, so the screen is not left dead.
    const answer = await ask({ reader: 'model', key: 'sk-ant-this-will-not-authenticate' });

    assert.equal(answer.status, 502);

    const said = (await answer.json()) as { error: string; detail: string };
    assert.match(said.error, /could not read anything/);
    assert.ok(said.detail.length > 0, 'the reason the API gave, not just a status');

    const health = (await (await fetch(`${base}/api/health`)).json()) as { readerName: string };
    assert.equal(health.readerName, 'rules');
  });
});
