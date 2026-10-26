#!/usr/bin/env node
/**
 * The home page's assistant picture (site/src/assets/home/tab-assistant.webp).
 *
 * scripts/docs-shots.mjs takes every other picture with `mistri shot`, which
 * opens a page and nothing more; this one needs a conversation first. So it
 * seeds Compass into a throwaway database, gives it the assistant's store,
 * serves it on a free port with a scripted model (MISTRI_ASSISTANT_SCRIPT,
 * site-assistant-shot.json beside this file: no API key, no network), asks
 * through the page as a person would, and takes the conversation at 2x on the
 * same pinned day as the other pictures.
 *
 *   node --import tsx scripts/site-assistant-shot.mjs            write the WebP
 *   node --import tsx scripts/site-assistant-shot.mjs --out dir  write there instead (to compare first)
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { ASSETS, TODAY } from './docs-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLOCK = `${TODAY}T16:00:00.000Z`;
const at = process.argv.indexOf('--out');
const target = join(at < 0 ? ASSETS : resolve(process.argv[at + 1]), 'home/tab-assistant.webp');

const work = mkdtempSync(join(tmpdir(), 'tablewalk-assistant-shot-'));
const db = join(work, 'crm.db');
const made = spawnSync(process.execPath, ['test/fixtures/databases/crm/make-crm-db.mjs', db], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, MISTRI_CRM_TODAY: TODAY },
});
if (made.status !== 0) throw new Error(`seeding Compass failed: ${made.stderr}`);
const { provisionSqliteAssistant } = await import('../packages/mistri/src/adapters/assistant/sqliteAssistant.ts');
provisionSqliteAssistant(db);
const config = join(work, 'crm.json');
writeFileSync(config, JSON.stringify({ connections: [{ name: 'crm', url: db, writable: true }] }));

const port = await new Promise((done, fail) => {
  const probe = createServer()
    .once('error', fail)
    .listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
});
const server = spawn(
  process.execPath,
  ['--import', 'tsx', 'packages/mistri/src/server/index.ts', '--config', config, '--app', 'test/fixtures/apps/crm', '--port', String(port)],
  {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: '',
      MISTRI_ASSISTANT_SCRIPT: join(ROOT, 'scripts/site-assistant-shot.json'),
      MISTRI_CLOCK: CLOCK,
      MISTRI_OPEN: '0',
      XDG_CONFIG_HOME: join(work, 'config'),
    },
  },
);
const origin = `http://127.0.0.1:${port}`;
let browser;
try {
  for (let tries = 0; ; tries++) {
    if (
      await fetch(`${origin}/healthz`).then(
        (answer) => answer.ok,
        () => false,
      )
    )
      break;
    if (tries > 240) throw new Error(`Compass did not start on ${origin}`);
    await new Promise((done) => setTimeout(done, 250));
  }
  browser = await (await import('playwright')).chromium.launch();
  const errors = [];
  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message.split('\n')[0]));
    await page.clock.setFixedTime(new Date(CLOCK));
    return page;
  };
  const settle = async (page) => {
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => globalThis.document.fonts.ready);
    await page.waitForTimeout(500);
  };
  const ask = async (page, words) => {
    const room = page.locator('#assistant-room');
    const sent = await room.locator('.assistant-person').count();
    const box = room.getByRole('textbox', { name: 'Message the assistant' });
    await box.fill(words);
    await box.press('Enter');
    await room.locator('.assistant-person').nth(sent).waitFor();
    await room.locator('.assistant-body[aria-busy="false"]').waitFor();
    await page.waitForTimeout(500);
  };

  /* Earlier conversations, so the rail reads as a week of use, each dated back. */
  const seed = await open();
  const earlier = {
    'Show stale deals': '2026-08-21T10:00:00.000Z',
    'Which leads are new this week?': '2026-09-01T15:20:00.000Z',
    'Pipeline by stage': '2026-09-03T09:12:00.000Z',
  };
  const ids = {};
  for (const words of Object.keys(earlier)) {
    await seed.goto(`${origin}/assistant`);
    await settle(seed);
    await ask(seed, words);
    ids[words] = seed.url().split('/').pop();
  }
  /* The one in the picture: a chart it drew, then a change it proposes and waits on. */
  await seed.goto(`${origin}/assistant`);
  await settle(seed);
  await ask(seed, 'How is the open pipeline split by stage?');
  await ask(seed, 'Start working Bronwyn');
  const conversation = seed.url();
  await seed.context().close();
  const handle = new DatabaseSync(db);
  for (const [words, when] of Object.entries(earlier))
    handle.prepare('UPDATE "__mistri_assistant_conversation" SET updated_at = ? WHERE id = ?').run(when, ids[words]);
  handle.close();

  const page = await open();
  await page.goto(conversation);
  await settle(page);
  /* Scrolled to its end, as a person returning to it sees it: the proposal and its buttons. */
  await page.evaluate(() => {
    for (const element of globalThis.document.querySelectorAll('#assistant-room *')) {
      const style = globalThis.getComputedStyle(element);
      if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 4)
        element.scrollTop = element.scrollHeight;
    }
  });
  await page.waitForTimeout(300);
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  if (errors.length) throw new Error(`the page threw: ${errors.join('; ')}`);
  mkdirSync(dirname(target), { recursive: true });
  await sharp(png).webp({ quality: 80, effort: 4 }).toFile(target);
  console.log(target);
} finally {
  await browser?.close();
  server.kill();
  rmSync(work, { recursive: true, force: true });
}
