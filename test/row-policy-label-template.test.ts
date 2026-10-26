/**
 * A record named by a one-column template (`recordLabel: '{title}'`) is named
 * the same to a reader a row policy scopes as to one it does not: its own
 * `$label`, and the one a reference to it reads. Lintel once named its repairs
 * by the column instead, on a report that the portal was served the key.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

test('a one-column record label reads the same under a row policy as without one', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-policy-label-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'homes.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE unit(id INTEGER PRIMARY KEY, code TEXT NOT NULL, title TEXT NOT NULL);
    CREATE TABLE request(id INTEGER PRIMARY KEY, unit_id INTEGER NOT NULL REFERENCES unit(id), subject TEXT NOT NULL);
    INSERT INTO unit VALUES (1, 'U1', 'Garden flat'), (2, 'U2', 'Top floor');
    INSERT INTO request VALUES (5, 1, 'Leak'), (6, 2, 'Draft');`);
  db.close();
  const identity = { id: 'resident', who: 'resident@example.test', role: 'resident' } as Identity;
  const policyFile = join(directory, 'policy.mjs');
  writeFileSync(
    policyFile,
    `export default { appId: 'homes', resolveRows() {
      return { unit: { groups: [[{ column: 'id', op: '=', value: 1 }]] }, request: { groups: [[{ column: 'unit_id', op: '=', value: 1 }]] } };
    } };`,
  );
  const read = async (scoped: boolean) => {
    const registry = new Registry();
    registry.onWarning = () => {};
    registry.add({ id: 'homes-db', name: 'homes-db', url: file, source: 'config', writable: false });
    const app = parseAppConfig(
      {
        id: 'homes',
        name: 'Homes',
        sources: { main: { connection: 'homes-db', default: true } },
        resources: { unit: { recordLabel: '{title}' }, request: {} },
        auth: { ...(scoped ? { rows: 'policy' } : {}), roles: { resident: { read: true, fields: { unit: { read: ['id', 'title'] } } } } },
        views: { requests: { kind: 'list', from: 'request' } },
        home: 'requests',
        nav: ['requests'],
      },
      'label fixture',
    );
    const host: AppHost = {
      app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
      pages: [],
      auth: {
        spec: app.auth!,
        store: join(directory, `auth-${scoped}.db`),
        close() {},
        handler: async () => {},
        session: async () => identity,
      },
    };
    const policy = scoped ? await loadHttpAppPolicy({ app, registry, file: policyFile, verifySession: async () => identity }) : undefined;
    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, bound, apps: [host], ...(policy ? { policy } : {}) });
    server.listen(0, bound.host);
    await once(server, 'listening');
    const { port } = server.address() as { port: number };
    const run = async (view: object) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/view/run?app=homes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mistri-account': identity.id },
        body: JSON.stringify({ view }),
      });
      assert.equal(response.status, 200);
      return ((await response.json()) as { rows: Record<string, unknown>[] }).rows;
    };
    try {
      return {
        own: await run({
          base: 'unit',
          columns: [{ path: 'id' }, { path: '$label' }],
          filter: { groups: [[{ path: 'id', op: '=', value: 1 }]] },
        }),
        reference: await run({
          base: 'request',
          columns: [{ path: 'id' }, { path: 'unit_id.$label' }],
          filter: { groups: [[{ path: 'id', op: '=', value: 5 }]] },
        }),
      };
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await policy?.retire();
      await registry.closeAll();
    }
  };
  const plain = await read(false);
  assert.deepEqual(plain, { own: [{ id: 1, $label: 'Garden flat' }], reference: [{ id: 5, 'unit_id.$label': 'Garden flat' }] });
  assert.deepEqual(await read(true), plain);
});
