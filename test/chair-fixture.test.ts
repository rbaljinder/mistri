/**
 * The Chair fixture (test/fixtures/apps/chair), loaded as `mistri` loads an App from its directory and served: one
 * page two roles open, with a read only the dentist may make (`optionalReads`) and a loader that reads the notes above
 * the desk (`elevate`). The declarations are held by the loaders the server and `check` share, on real files.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { loadConfig, Registry } from '../packages/engine/src/server/connections.js';
import { loadApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { loaderElevations } from '../packages/mistri/src/server/build/checkCommands.js';
import { CONFIG_SECTIONS } from '../packages/mistri/src/server/serviceConnections.js';
import { connect } from '../packages/engine/src/adapters/connect.js';
import { createApp } from './support/createApp.js';
import { seed } from './fixtures/apps/chair/seed.mjs';

const APP = new URL('./fixtures/apps/chair', import.meta.url).pathname;

async function serve(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-chair-'));
  const file = seed(join(directory, 'chair.db')) as string;
  const registry = new Registry();
  for (const c of (await loadConfig(`${file}.json`, CONFIG_SECTIONS))!.connections) registry.add({ ...c, source: 'config' });
  const loaded = await loadApp(APP);
  const control = { identity: { id: 'dana', who: 'dana@example.test', role: 'desk' } as Identity | null };
  const host: AppHost = {
    app: loaded,
    pages: loaded.pages,
    auth: {
      spec: loaded.app.auth!,
      store: join(directory, 'sessions.db'),
      close: async () => {},
      session: async () => control.identity,
      handler: async () => {},
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, apps: [host], pages: loaded.pages, bound });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  t.after(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = async (path: string, body: object, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}?app=chair`, {
      signal: AbortSignal.timeout(5000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ app: 'chair', ...body }),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, any> };
  };
  return { loaded, control, call, file };
}

test('Chair loads from its directory with an optional read and an elevating loader, and serves each role its part', async (t) => {
  const f = await serve(t);
  const view = f.loaded.app.views.schedule as { roles?: string[]; page: { reads: string[]; optionalReads?: string[]; loader?: string } };
  assert.deepEqual(view.roles, ['dentist', 'desk']);
  assert.deepEqual(view.page, { ...view.page, reads: ['visit'], optionalReads: ['note'], loader: 'followUps' });
  assert.deepEqual(f.loaded.loaders?.followUps?.elevate, { read: ['note'] });
  const catalog = connect(f.file);
  t.after(() => catalog.close());
  assert.deepEqual(loaderElevations(f.loaded.app, f.loaded.loaders, await catalog.introspect()), [
    'loader "followUps" (page "schedule") reads "note" under its own authority, for role "desk"',
  ]);

  const page = { 'x-mistri-page': 'schedule' };
  // The desk: the page's loader hands it the follow-up asks, and its own read of the notes is refused.
  const loaded = await f.call('/api/pages/load', { page: 'schedule' });
  assert.equal(loaded.status, 200, loaded.text);
  assert.deepEqual(loaded.body.data, { followUps: [{ visit: 1, ask: 'Recall in 6 months' }] });
  assert.doesNotMatch(loaded.text, /Crown|sensitive|Routine/);
  const refused = await f.call('/api/view/run', { view: { base: 'note' }, count: 'none' }, page);
  assert.equal(refused.status, 403, refused.text);
  assert.equal(refused.body.code, 'forbidden');
  assert.doesNotMatch(refused.text, /Crown|Routine/);
  assert.equal((await f.call('/api/view/run', { view: { base: 'visit' }, count: 'none' }, page)).status, 200);

  // The dentist: the same page, and the notes with it.
  f.control.identity = { id: 'lee', who: 'lee@example.test', role: 'dentist' };
  const notes = await f.call('/api/view/run', { view: { base: 'note' }, count: 'none' }, page);
  assert.equal(notes.status, 200, notes.text);
  assert.match(notes.text, /Crown on 14, sensitive/);
});
