#!/usr/bin/env node
/**
 * The pictures in the README, taken from the running application.
 *
 *     npm run screenshots
 *
 * They are in the repository as a script rather than as files somebody cropped
 * by hand, for the same reason the favicon is drawn and not exported: a picture
 * made once drifts from the thing it is a picture of, and a README showing a
 * screen that no longer exists is worse than a README with no pictures. Re-run
 * this after changing anything anybody can see.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const BASE = process.env.ORDERS_URL || 'http://localhost:4300';
const here = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(here, '..', 'docs');

let chromium;
try {
  const require = createRequire(import.meta.url);
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is not installed here, so the pictures cannot be retaken.');
  process.exit(2);
}

fs.mkdirSync(DOCS, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge' });

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 980 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });

  const say = (name) => console.log(`  docs/${name}`);

  // ------------------------------------------------------------- the orders
  await page.goto(`${BASE}/orders`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  await page.screenshot({ path: path.join(DOCS, 'orders.png') });
  say('orders.png');

  const key = await page.locator('[data-order]').first().getAttribute('data-order');

  // --------------------------------------------------------------- one order
  await page.goto(`${BASE}/orders/${encodeURIComponent(key)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(DOCS, 'order.png') });
  say('order.png');

  // ------------------------------------------------------------- the evidence
  //
  // With a value picked, because the picture of this screen with nothing
  // selected shows the marks but not the gesture the screen exists for.
  const weakest = page.locator('[data-weakest]');
  const file = new URL(await weakest.getAttribute('href'), BASE).searchParams.get('of');

  await page.goto(`${BASE}/message?of=${encodeURIComponent(file)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(DOCS, 'message.png') });
  say('message.png');

  await page.locator('[data-field]').first().click({ force: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(DOCS, 'picked.png') });
  say('picked.png');

  // ------------------------------------------------------------ the refusals
  await page.goto(`${BASE}/for-a-person`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(DOCS, 'for-a-person.png') });
  say('for-a-person.png');
  await page.close();

  // ------------------------------------------------------------------- a phone
  const phone = await browser.newPage({
    viewport: { width: 390, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  await phone.goto(`${BASE}/message?of=${encodeURIComponent(file)}`, { waitUntil: 'networkidle' });
  await phone.waitForTimeout(900);
  await phone.screenshot({ path: path.join(DOCS, 'phone-message.png') });
  say('phone-message.png');
  await phone.close();

  console.log('\nThe pictures in the README are of the application as it is now.');
} catch (error) {
  console.error(`\nThe pictures could not be retaken: ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
