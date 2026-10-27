// Takes README screenshots of the board in demo mode, using the installed Google Chrome.
// Run with `pnpm screenshots`; images go to docs/screenshots/.
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';
import { createDemoApp } from '../src/demo';
import { createServer } from '../src/server';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(out, { recursive: true });

const app = createDemoApp();
await app.poll();
const server = createServer(app, path.join(root, 'dist', 'web'));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

const browser = await chromium.launch({ channel: 'chrome' });

async function open(theme: 'light' | 'dark'): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, colorScheme: theme });
  // start every shot from the same view: no filters, lanes on, the chosen theme
  await page.addInitScript((t) => {
    localStorage.clear();
    localStorage.setItem('theme', JSON.stringify(t));
  }, theme);
  await page.goto(url);
  await page.waitForSelector('.card');
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  return page;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  console.log(`docs/screenshots/${name}.png`);
}

try {
  const dark = await open('dark');
  await shot(dark, 'board-dark');
  await dark.getByRole('button', { name: 'ABC', exact: true }).click();
  await shot(dark, 'filtered');
  await dark.getByRole('button', { name: 'ABC', exact: true }).click();
  await dark.getByRole('button', { name: '+ New session' }).click();
  await dark.waitForSelector('.dialog');
  await dark.screenshot({ path: path.join(out, 'new-session.png') });
  console.log('docs/screenshots/new-session.png');

  await shot(await open('light'), 'board-light');
} finally {
  await browser.close();
  server.close();
}
