/**
 * `mistri shot --click <name>` when the name matches several elements: a visible, enabled one is pressed, and more
 * than one is refused as ambiguous rather than the first (often a hidden twin) being tried until it times out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { performSteps } from '../packages/mistri/src/server/build/shotSteps.js';

const PAGE = `<body>
  <button style="display:none" onclick="document.title='hidden'">Save</button>
  <button disabled onclick="document.title='disabled'">Save</button>
  <button onclick="document.title='real'"><span>Save</span></button>
  <button onclick="document.title='a'">Open</button><button onclick="document.title='b'">Open</button>
  <button style="display:none">Ghost</button>
</body>`;

/* Playwright puts its artifacts and the browser profile under os.tmpdir(), and a lane fails on a scratch folder it
   finds left behind. The browser gets a folder of its own for the run, removed whether or not it launched. */
async function withPage(run: (page: import('playwright').Page) => Promise<void>) {
  const own = mkdtempSync(join(tmpdir(), 'tw-shot-click-'));
  const was = process.env.TMPDIR;
  process.env.TMPDIR = own;
  let browser: Browser | undefined;
  try {
    try {
      browser = await chromium.launch();
    } catch {
      return 'skip';
    }
    const page = await browser.newPage();
    await page.setContent(PAGE);
    await run(page);
  } finally {
    await browser?.close();
    if (was === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = was;
    rmSync(own, { recursive: true, force: true });
  }
}

const refuse = (why: string): never => {
  throw new Error(why);
};
const settle = async () => {};

test('a click prefers the visible, enabled match over a hidden or disabled twin, and the text inside it is not a second match', async (t) => {
  const ran = await withPage(async (page) => {
    await performSteps(page, [{ kind: 'click', target: 'Save' }], '/x', settle, refuse);
    assert.equal(await page.title(), 'real');
  });
  if (ran === 'skip') t.skip('no browser');
});

test('two visible, enabled matches are refused as ambiguous', async (t) => {
  const ran = await withPage(async (page) => {
    await assert.rejects(
      performSteps(page, [{ kind: 'click', target: 'Open' }], '/x', settle, refuse),
      /ambiguous: 2 matches for "Open"; use a CSS selector/,
    );
  });
  if (ran === 'skip') t.skip('no browser');
});
