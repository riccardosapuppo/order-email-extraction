#!/usr/bin/env node
/**
 * The one claim this project makes, checked through the interface.
 *
 *     npm run check:screen
 *     npm run check:screen -- --show      with a visible browser
 *
 * The claim is that a value can be pointed back at the exact characters it was
 * read from. `npm run extract` proves the reading; this proves somebody can
 * follow it: that a mark sits over the right words, that picking a value marks
 * it and picking a mark selects the value, and that the message the interface
 * shows is the message that arrived and not a version of it.
 *
 * That last one is the reason a browser is needed at all. The marks are drawn
 * by cutting the body at every span boundary and reassembling it, so a defect
 * there does not throw — it quietly drops or duplicates characters in
 * somebody's email. Nothing but reading the rendered text catches that.
 *
 * It also walks the routes, because a route that only works when the router
 * navigates to it is broken for anybody who refreshes the page or opens a link.
 * `/messages/01-order.eml` was exactly that: fine from inside the application,
 * "Cannot GET" from the address bar, because a path ending in an extension
 * looks to a server like a request for a file.
 */

import { createRequire } from 'node:module';

import { startTheStack } from './with-the-stack.mjs';

const show = process.argv.includes('--show');

let chromium;
try {
  const require = createRequire(import.meta.url);
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is not installed here, so this check cannot run.');
  console.error('It is a check, not a dependency: install it where you keep such things.');
  process.exit(2);
}

let failures = 0;

function expect(what, condition, detail) {
  if (condition) {
    console.log(`  ok    ${what}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${what}`);
    if (detail) console.log(`        ${detail}`);
  }
}

// The mailbox, the server and the interface, started by running the same
// `npm start` a person runs -- and refused if any of those ports is already
// busy, because a check that borrows a stranger is a check that can go green
// having measured the wrong thing. See with-the-stack.mjs.
const stack = await startTheStack();
const BASE = stack.base;

const browser = await chromium.launch({ channel: 'msedge', headless: !show });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });

try {
  console.log(`Driving ${BASE} through the screen\n`);

  // ------------------------------------------------------------- the orders
  console.log('The orders the mailbox revealed');

  await page.goto(`${BASE}/orders`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const rows = page.locator('tbody tr');
  expect('orders are listed', (await rows.count()) > 0);

  const key = await page.locator('[data-order]').first().getAttribute('data-order');
  expect('and each one links to itself', Boolean(key), 'no order carried its key');

  // Somebody should be able to see, from the list alone, which order to open
  // first. Two separate questions, two separate answers.
  const heads = (await page.locator('thead th').allTextContents()).map((one) => one.trim());
  expect(
    'the list asks the two questions separately',
    heads.includes('Right order?') && heads.includes('Right values?'),
    heads.join(' | ')
  );

  // ------------------------------------------------------------- one order
  console.log('\nOne order, and where to start checking');

  await page.goto(`${BASE}/orders/${encodeURIComponent(key)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const weakest = page.locator('[data-weakest]');
  expect('it names the least certain value in it', (await weakest.count()) > 0);

  const path = await weakest.getAttribute('data-weakest');
  await weakest.click({ force: true });
  await page.waitForURL((url) => url.pathname.includes('/message'), { timeout: 10000 });
  await page.waitForTimeout(900);

  // ------------------------------------------------- the evidence, and the marks
  console.log('\nThe email, with the marks on it');

  const marks = page.locator('pre.body mark, dl.envelope mark');
  expect('the message is marked where values were read', (await marks.count()) > 0);

  const fields = page.locator('[data-field]');
  expect('and the values are listed beside it', (await fields.count()) > 0);

  expect(
    'including the one this order was weakest on',
    (await page.locator(`[data-field="${path}"]`).count()) > 0,
    `${path} was not among them`
  );

  // The claim, in one step: pick a value, and its own words light up.
  await page.locator(`[data-field="${path}"]`).click({ force: true });
  await page.waitForTimeout(400);

  const lit = page.locator('mark.picked');
  expect('picking a value marks the words it came from', (await lit.count()) > 0);
  expect(
    'and it is that value’s words, not another’s',
    ((await lit.first().getAttribute('data-marks')) ?? '').split(' ').includes(path),
    `the mark belongs to ${await lit.first().getAttribute('data-marks')}`
  );

  // And back the other way, because somebody reading the email is as likely to
  // start from a phrase that looks wrong as from a value in the list.
  await page.locator('mark').first().click({ force: true });
  await page.waitForTimeout(400);
  expect('and picking a mark selects the value', (await page.locator('li.picked').count()) > 0);

  // ------------------------------------------- the message must be the message
  //
  // The body is rebuilt from segments. A defect there does not throw; it drops
  // or repeats characters inside somebody's email, which is the one thing this
  // screen cannot be allowed to do. So the rendered text is compared against
  // what the API says the body is.
  const shown = await page.locator('pre.body').innerText();
  const file = new URL(page.url()).searchParams.get('of');
  const answer = await (await fetch(`${BASE}/api/messages/${encodeURIComponent(file)}`)).json();

  expect(
    'the message on screen is the message that arrived, character for character',
    shown.replace(/\r/g, '') === answer.body.replace(/\r/g, ''),
    `${shown.length} characters shown against ${answer.body.length} in the message`
  );

  // ------------------------------------------------ a link somebody was sent
  console.log('\nAnd the addresses work from outside the application');

  for (const where of ['/orders', `/orders/${encodeURIComponent(key)}`, `/message?of=${encodeURIComponent(file)}`, '/for-a-person']) {
    const response = await page.goto(`${BASE}${where}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    expect(
      `${where} opens when it is typed in`,
      response?.status() === 200 && (await page.locator('app-root').count()) > 0,
      `answered ${response?.status()}`
    );
  }

  console.log('');
  if (failures > 0) {
    console.log(`${failures} checks failed.`);
    process.exitCode = 1;
  } else {
    console.log('A value can be followed back to its words, through the screen.');
  }
} catch (error) {
  console.error(`\nThe journey stopped: ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await stack.stop();
}
