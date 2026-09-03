/**
 * The README, checked against the repository it describes.
 *
 * A README is the one file everybody reads and nothing verifies, so it rots in
 * a particular way: the code moves and the prose stays, and the first person to
 * notice is a stranger typing the first command.
 *
 * A sweep across the ten repositories in this portfolio found that in every one
 * that stated a count, the count had drifted — 50 that was 58, 41 that was 49,
 * 22 that was 30 — and every one of those numbers had been true when it was
 * written. The two here happen to still be right. This is what keeps them so.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The top of the repository, found by looking rather than by counting.
 *
 * `../../..` is right from the source and wrong from `build/test/`, which is
 * where this actually runs — the package compiles before `node --test` sees it,
 * so a relative path counted from the source resolves one level short and opens
 * `packages/README.md`, which does not exist. Walking up until the workspace
 * root appears is right from either.
 */
function topOfTheRepository(from: string): string {
  for (let here = from, up = 0; up < 8; up += 1, here = path.dirname(here)) {
    const manifest = path.join(here, 'package.json');

    if (fs.existsSync(manifest) && fs.existsSync(path.join(here, 'README.md'))) {
      const read = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { workspaces?: unknown };
      if (read.workspaces) return here;
    }
  }

  throw new Error(`no workspace root above ${from}`);
}

const root = topOfTheRepository(path.dirname(fileURLToPath(import.meta.url)));
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
  engines?: { node?: string };
};

/**
 * The three numbers out of the sentence that states them.
 *
 * Throws rather than returning nothing if the sentence has been rewritten: a
 * check that shrugs when its pattern stops matching is a check that reports
 * success for ever afterwards.
 */
function whatTheReadmeSays(): { total: number; core: number; server: number } {
  const found = readme.match(/`npm test` is (\d+) tests: (\d+) over[\s\S]*?and (\d+) over/);

  assert.ok(found, 'the README no longer states its test counts in the form this check reads');

  return { total: Number(found[1]), core: Number(found[2]), server: Number(found[3]) };
}

/** Every `it(` in one workspace's tests, which is what `node --test` counts. */
function casesIn(workspace: string): number {
  const from = path.join(root, 'packages', workspace, 'test');
  if (!fs.existsSync(from)) return 0;

  return fs
    .readdirSync(from)
    .filter((one) => one.endsWith('.test.ts'))
    .reduce((all, one) => all + (fs.readFileSync(path.join(from, one), 'utf8').match(/^\s*(?:it|test)\(/gm) ?? []).length, 0);
}

describe('the numbers the README states about its own tests', () => {
  it('are still stated in a form this can read', () => {
    assert.ok(whatTheReadmeSays().total > 0);
  });

  it('add up to what they say they add up to', () => {
    const said = whatTheReadmeSays();

    assert.equal(said.core + said.server, said.total, `${said.core} + ${said.server} is not ${said.total}`);
  });

  it('and each half is the number of tests that half really has', () => {
    const said = whatTheReadmeSays();

    assert.equal(casesIn('core'), said.core, `the README says ${said.core} in core; there are ${casesIn('core')}`);
    assert.equal(casesIn('server'), said.server, `the README says ${said.server} in server; there are ${casesIn('server')}`);
  });
});

describe('everything else the README points at', () => {
  it('is a command that exists', () => {
    const commands = [...new Set([...readme.matchAll(/\bnpm run [a-z0-9:-]+/g)].map((one) => one[0]))];

    assert.ok(commands.length >= 3, `only found ${commands.length} commands — has the pattern stopped matching?`);

    const missing = commands.filter((one) => !Object.hasOwn(manifest.scripts ?? {}, one.replace('npm run ', '')));
    assert.deepEqual(missing, [], `named in the README, absent from package.json: ${missing.join(', ')}`);
  });

  it('and every file it links to is on disk', () => {
    const links = [...readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)]
      .map((one) => String(one[1] ?? ''))
      .filter((one) => one !== '' && !/^(https?:|mailto:|#)/.test(one));

    const broken = links.filter((one) => !fs.existsSync(path.join(root, one.split('#')[0] ?? one)));

    assert.deepEqual(broken, [], `the README links to files that are not there: ${broken.join(', ')}`);
  });

  it('and the Node version it promises is the one package.json enforces', () => {
    // These had drifted apart: the README said "Node 20.11 or newer, checked by
    // engines in package.json", and engines said >=20. A README that cites a
    // check is worse than one that does not, because it sounds verified.
    const declared = manifest.engines?.node?.match(/(\d+(?:\.\d+)?)/)?.[1];

    assert.ok(declared, 'package.json declares no engines.node at all');

    const promised = [...readme.matchAll(/Node\s+(\d+(?:\.\d+)?)\s+or newer/g)].map((one) => String(one[1] ?? ''));

    for (const one of promised) {
      assert.equal(
        Number.parseFloat(one),
        Number.parseFloat(String(declared)),
        `the README promises Node ${one}; package.json enforces ${declared}`
      );
    }
  });
});
