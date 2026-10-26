/**
 * Unlisted rows in a policy App (G110): `resolvePublicRows` hides a row from
 * signed-out visitors, and every public surface reads through that one
 * scope — the data reads, the labels another row shows for it, the
 * record's page head, the sitemap. An unlisted row is not reachable by
 * listing, counting, grouping or following a reference, and by its key it is
 * a row that is not there. (The tenant App's twin is tenant-public-reads.)
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { closeRecordBranding } from '../packages/mistri/src/server/http/recordBranding.js';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { retireDevClient } from '../packages/engine/src/server/devclient.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';

const HIDDEN = 'Unlisted Prototype';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-unlisted-'));
  const file = join(directory, 'lot.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE vehicle (id INTEGER PRIMARY KEY, title TEXT NOT NULL, price INTEGER NOT NULL, listed INTEGER NOT NULL);
    CREATE TABLE photo (id INTEGER PRIMARY KEY, vehicle_id INTEGER NOT NULL REFERENCES vehicle(id), caption TEXT NOT NULL);
    INSERT INTO vehicle VALUES (1, 'Listed Corolla', 15000, 1), (2, '${HIDDEN}', 99000, 0), (3, 'Listed Camry', 21000, 1);
    INSERT INTO photo VALUES (10, 1, 'Corolla front'), (20, 2, 'Prototype front'), (30, 3, 'Camry front');`);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'lot-data', name: 'Lot data', url: file, source: 'config' });
  const app = parseAppConfig(
    {
      id: 'lot',
      name: 'Lot',
      sources: { main: { connection: 'lot-data' } },
      resources: { vehicle: {}, photo: {} },
      auth: { rows: 'policy', roles: { admin: { read: true } }, public: { read: ['vehicle', 'photo'] } },
      views: {
        vehicles: { kind: 'list', from: 'vehicle', label: 'Vehicles' },
        photos: { kind: 'list', from: 'photo', label: 'Photos' },
      },
      home: [{ view: 'vehicles', signedOut: true }, { view: 'photos' }],
      nav: ['vehicles', 'photos'],
    },
    'unlisted fixture',
  );
  const pages = parsePagesConfig(
    { pages: [{ id: 'vehicle', label: 'Vehicle', base: 'vehicle', sections: [{ kind: 'fields', show: ['title', 'price'] }] }] },
    'unlisted pages',
  );
  const host: AppHost = {
    app: { path: 'lot.ts', app, pages, sources: {} },
    pages,
    auth: { spec: app.auth!, store: 'unused', handler: async () => {}, close() {}, session: async () => null },
  };
  const policyFile = join(directory, 'policy.mjs');
  // Staff read everything; a visitor reads the listed cars, and every photo — even one of an unlisted car.
  writeFileSync(
    policyFile,
    `export default {appId:'lot',resolveRows:()=>({vehicle:true,photo:true}),
      resolvePublicRows:()=>({vehicle:{groups:[[{column:'listed',op:'=',value:1}]]},photo:true})};`,
  );
  const policy = await loadHttpAppPolicy({ app, registry, file: policyFile, verifySession: host.auth!.session });
  const bound = { host: '127.0.0.1', port: 0 };
  const child = createApp({ registry, bound, apps: [host], policy });
  const server = createServer((req, res) => child.emit('request', req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await retireDevClient(child);
    await policy.retire?.();
    closeRecordBranding(registry);
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${bound.port}`;
  return (path: string, body?: unknown): Promise<{ status: number; text: string; body: any }> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify({ app: 'lot', ...(body as object) });
      const req = request(
        `${origin}${path}`,
        {
          method: payload ? 'POST' : 'GET',
          headers: {
            origin,
            'accept-encoding': 'identity',
            ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = undefined;
            }
            resolve({ status: res.statusCode!, text, body: parsed });
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
}

test('an unlisted row is absent from every public read, label, head and sitemap, and missing by its key', async (t) => {
  const ask = await fixture(t);
  const list = await ask('/api/query', { table: 'vehicle' });
  assert.equal(list.status, 200, list.text);
  assert.deepEqual((list.body.rows as Array<{ id: number }>).map((row) => row.id).sort(), [1, 3]);
  const count = await ask('/api/count', { table: 'vehicle' });
  assert.equal(count.body.count, 2, count.text);
  const run = await ask('/api/run', { q: 'vehicle' });
  assert.doesNotMatch(run.text, new RegExp(HIDDEN));
  const view = await ask('/api/view/run', { text: 'vehicle show id, title' });
  assert.equal(view.status, 200, view.text);
  assert.doesNotMatch(view.text, new RegExp(HIDDEN));
  const breakdown = await ask('/api/breakdown', { text: 'vehicle count by title' });
  assert.equal(breakdown.status, 200, breakdown.text);
  assert.doesNotMatch(breakdown.text, new RegExp(HIDDEN));
  // A visible photo of the unlisted car keeps its key, and shows no label for it.
  const photos = await ask('/api/run', { q: 'photo' });
  assert.equal(photos.status, 200, photos.text);
  assert.doesNotMatch(photos.text, new RegExp(HIDDEN));
  const byCar = await ask('/api/breakdown', { text: 'photo count by vehicle_id' });
  assert.equal(byCar.status, 200, byCar.text);
  assert.doesNotMatch(byCar.text, new RegExp(HIDDEN));
  // By its key: a row that is not there.
  const missing = await ask('/api/query', { table: 'vehicle', filter: { groups: [[{ column: 'id', op: '=', value: 2 }]] } });
  assert.deepEqual(missing.body.rows, []);
  const references = await ask('/api/references', { table: 'vehicle', key: { id: 2 } });
  const absent = await ask('/api/references', { table: 'vehicle', key: { id: 404 } });
  assert.equal(references.status, absent.status, `${references.text} / ${absent.text}`);
  assert.doesNotMatch(references.text, new RegExp(HIDDEN));
  const plan = await ask('/api/pages/plan', { page: 'vehicle', key: { id: 2 } });
  const planAbsent = await ask('/api/pages/plan', { page: 'vehicle', key: { id: 404 } });
  assert.equal(plan.status, planAbsent.status, `${plan.text} / ${planAbsent.text}`);
  assert.doesNotMatch(plan.text, new RegExp(HIDDEN));
  // The record's page (the one App is served at the root) names nothing of it, as no row; a listed one is titled.
  const page = await ask('/vehicles/2');
  assert.doesNotMatch(page.text, new RegExp(HIDDEN));
  const listed = await ask('/vehicles/1');
  assert.match(listed.text, /Listed Corolla/);
  const sitemap = await ask('/sitemap.xml');
  assert.equal(sitemap.status, 200, sitemap.text);
  assert.match(sitemap.text, /\/vehicles\/1</);
  assert.match(sitemap.text, /\/vehicles\/3</);
  assert.doesNotMatch(sitemap.text, /\/vehicles\/2</);
});
