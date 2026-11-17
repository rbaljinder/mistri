/**
 * A field report: `mistri shot --theme X` drew the tenant's own look, because a tenant's branding replaces the App's
 * theme on the page whatever look was picked. A look asked for by name is now drawn over it: the shot's window drops
 * the branding from the App's answer and from the page's head. Driven with a stand-in browser, which records what
 * the window installs and answers /api/app the way a tenant App does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright';
import { shotContext, type ShotLook } from '../packages/mistri/src/server/build/shot.js';

function standIn() {
  const seen = { scripts: [] as string[], route: undefined as undefined | ((route: unknown) => Promise<void>) };
  const context = {
    on() {},
    addInitScript: async (script: { content: string }) => void seen.scripts.push(script.content),
    route: async (_pattern: RegExp, handler: (route: unknown) => Promise<void>) => void (seen.route = handler),
  };
  const browser = { newContext: async () => context } as unknown as Browser;
  return { seen, browser };
}

const look: ShotLook = { app: 'desk', theme: 'mono', own: false, label: 'Mono' };

test('a look shot by name is drawn over the tenant branding in the App answer and the page head', async () => {
  const { seen, browser } = standIn();
  await shotContext(browser, 'http://localhost', { viewport: { width: 800, height: 600 }, dark: false, look });
  assert.match(seen.scripts.join('\n'), /mistri-branding/);
  const payload = { app: { ui: { theme: { preset: 'tenant', branding: { theme: { id: 'tenant' } } }, shell: {} } } };
  let answered: { json?: typeof payload } = {};
  await seen.route!({
    fetch: async () => ({ json: async () => payload }),
    fulfill: async (reply: typeof answered) => void (answered = reply),
  });
  assert.equal('branding' in answered.json!.app.ui.theme, false);
  assert.equal(answered.json!.app.ui.theme.preset, 'tenant');
});

test('a window with no look asked for leaves the App answer alone', async () => {
  const { seen, browser } = standIn();
  await shotContext(browser, 'http://localhost', { viewport: { width: 800, height: 600 }, dark: false });
  assert.equal(seen.route, undefined);
  assert.deepEqual(seen.scripts, []);
});
