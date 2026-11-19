/**
 * A field report: a table keyed by text with no default, whose New form leaves the key out, could not be saved —
 * the form sent no key, the store filled none, and the database's NOT NULL came back as a "required value" naming
 * nothing. A tenant App's store fills such a key with a fresh UUID (test/tenant-http.test.ts); an App that is not
 * tenant-owned fills nothing, with roles or without, and keeps a key the caller sends.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

for (const signed of [true, false]) {
  test(`a New record with no text key is refused where the App is not tenant-owned, and a sent key is kept (${signed ? 'with roles' : 'no sign-in'})`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mistri-filled-key-'));
    const file = join(directory, 'desk.db');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE ticket (id TEXT NOT NULL PRIMARY KEY, title TEXT NOT NULL);`);
    const registry = new Registry();
    registry.add({ id: 'desk-db', name: 'Desk', url: file, source: 'config', writable: true });
    const definition = parseAppConfig(
      {
        id: 'desk',
        name: 'Desk',
        connection: 'desk-db',
        resources: { ticket: { access: 'write', form: { show: ['title'] } } },
        ...(signed ? { auth: { roles: { staff: { read: true, write: true } } } } : {}),
        views: { tickets: { kind: 'list', from: 'ticket', show: ['title'] } },
        home: 'tickets',
        nav: ['tickets'],
      },
      'filled key fixture',
    );
    const host = {
      app: { path: 'desk-fixture.ts', app: definition, pages: [], sources: {} },
      pages: [],
      ...(signed
        ? {
            auth: {
              spec: definition.auth!,
              store: 'not-used',
              handler: async () => {},
              close: async () => {},
              session: async () => ({ id: 'account-ann', who: 'ann@example.test', role: 'staff', name: 'Ann' }),
            },
          }
        : {}),
    } as unknown as AppHost;
    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, bound, apps: [host], pages: [] });
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    const insert = async (values: Record<string, unknown>) => {
      const response = await fetch(`http://${bound.host}:${bound.port}/api/insert`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: 'desk', table: 'ticket', values }),
      });
      const body = await response.json();
      return { status: response.status, key: body.key?.id === undefined ? undefined : String(body.key.id) };
    };
    try {
      const keyless = await insert({ title: 'Printer jam' });
      assert.notEqual(keyless.status, 200, 'no key was filled');
      assert.equal(db.prepare('SELECT count(*) AS n FROM ticket').get()!.n, 0);
      assert.deepEqual(await insert({ id: 'T-1', title: 'Chosen' }), { status: 200, key: 'T-1' });
    } finally {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await registry.closeAll();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
