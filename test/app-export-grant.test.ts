import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { appExportable } from '../packages/mistri/src/shared/appAccess.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

/* Export is a grant of its own: a person exports a table any of their roles writes or lists in `export`, a visitor
   never, and an App without role grants keeps its one switch. The server refuses the file, not only the menu. */
const connection = 'export-grant-database';
const appId = 'export-atlas';
const person = (role: string): Identity => ({
  id: `account-${role}`,
  who: `${role}@example.test`,
  role,
});
const sessions: Record<string, Identity> = {
  writer: person('writer'),
  auditor: person('auditor'),
  reader: person('reader'),
  both: person('writer,auditor'),
};

const appOver = (ui?: Record<string, unknown>) =>
  parseAppConfig(
    {
      id: appId,
      name: 'Export Atlas',
      connection,
      resources: { incident: { access: 'write' }, service: {} },
      auth: {
        providers: ['email'],
        defaultRole: 'reader',
        roles: {
          writer: { read: ['incident', 'service'], write: ['incident'] },
          // Reads both tables, and may take the services out as a file.
          auditor: { read: ['incident', 'service'], export: ['service'] },
          reader: { read: ['incident', 'service'] },
        },
        public: { read: ['service'] },
      },
      views: {
        incidents: { kind: 'list', from: 'incident', label: 'Incidents' },
        services: { kind: 'list', from: 'service', label: 'Services' },
      },
      home: 'incidents',
      ...(ui ? { ui } : {}),
    },
    'export grant fixture',
  );
const app = appOver();

async function served(run: (base: string) => Promise<void>, over = app, more = '') {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-export-grant-'));
  const path = join(directory, 'atlas.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE service (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE incident (id INTEGER PRIMARY KEY, name TEXT NOT NULL, service_id INTEGER REFERENCES service(id));
    INSERT INTO service VALUES (1, 'Identity service');
    INSERT INTO incident VALUES (1, 'Allowed incident', 1);
    ${more}
  `);
  db.close();
  const registry = new Registry();
  registry.add({
    id: connection,
    name: 'Atlas',
    url: path,
    source: 'config',
    writable: true,
  });
  const pages = parsePagesConfig({ pages: [] }, 'export grant pages');
  const host: AppHost = {
    app: { path: '/operator/app.ts', app: over, pages, sources: {} },
    pages: [],
    ...(over.auth
      ? {
          auth: {
            spec: over.auth!,
            store: '/operator/sessions.db',
            handler: async () => {},
            close: async () => {},
            session: async (req: { headers: { cookie?: string } }) => sessions[req.headers.cookie?.replace(/^session=/, '') ?? ''] ?? null,
          },
        }
      : {}),
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(`http://${bound.host}:${address.port}`);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
}

const exportOf = async (base: string, who: string | undefined, q: string) => {
  const response = await fetch(`${base}/api/export`, {
    method: 'POST',
    signal: AbortSignal.timeout(3_000),
    headers: {
      ...(who ? { Cookie: `session=${who}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ app: appId, q, format: 'ndjson' }),
  });
  await response.text();
  return response.status;
};

test('a writer exports what they write, a listed reader what is listed, any other reader nothing, a visitor nothing', async () => {
  await served(async (base) => {
    assert.equal(await exportOf(base, 'writer', 'incident'), 200, 'a writer exports their table');
    assert.equal(await exportOf(base, 'writer', 'service'), 403, 'and not one they only read');
    assert.equal(await exportOf(base, 'auditor', 'service'), 200, 'a reader exports the table export lists');
    assert.equal(await exportOf(base, 'auditor', 'incident'), 403, 'and not another');
    assert.equal(await exportOf(base, 'reader', 'incident'), 403, 'a reader who is granted nothing is refused');
    assert.equal(await exportOf(base, 'reader', 'service'), 403);
    assert.equal(await exportOf(base, 'both', 'incident'), 200, "any of a person's roles will do");
    assert.equal(await exportOf(base, 'both', 'service'), 200);
    // The sign-in gate stops a visitor (401) before the grant is asked; the payload test below holds that none is offered.
    assert.equal(await exportOf(base, undefined, 'service'), 401, 'a signed-out visitor never exports');
  });
});

test('the app payload offers Export only for the tables the person may export', async () => {
  await served(async (base) => {
    const tables = async (who?: string) => {
      const response = await fetch(`${base}/api/app`, {
        headers: who ? { Cookie: `session=${who}` } : {},
      });
      assert.equal(response.status, 200);
      const { app } = (await response.json()) as {
        app: { ui: { export?: boolean }; exportableTables?: string[] };
      };
      return {
        exportOff: app.ui.export === false,
        exportable: app.exportableTables?.sort(),
      };
    };
    assert.deepEqual(await tables('writer'), {
      exportOff: false,
      exportable: ['incident'],
    });
    assert.deepEqual(await tables('auditor'), {
      exportOff: false,
      exportable: ['service'],
    });
    assert.deepEqual(await tables('both'), {
      exportOff: false,
      exportable: ['incident', 'service'],
    });
    assert.deepEqual(await tables('reader'), {
      exportOff: true,
      exportable: [],
    });
    assert.deepEqual(await tables(), { exportOff: true, exportable: [] });
  });
});

test('appExportable: role export is inherited through extends, and an App without role grants has no per-table rule', () => {
  const schema = {
    tables: [{ id: 'incident' }, { id: 'service' }],
  } as unknown as DatabaseSchema;
  const extending = parseAppConfig(
    {
      id: appId,
      name: 'Export Atlas',
      connection,
      resources: { incident: { access: 'write' }, service: {} },
      auth: {
        providers: ['email'],
        roles: {
          auditor: { read: ['incident', 'service'], export: ['service'] },
          lead: { extends: 'auditor', write: ['incident'] },
        },
      },
      views: {
        incidents: { kind: 'list', from: 'incident', label: 'Incidents' },
      },
      home: 'incidents',
    },
    'export grant extends',
  );
  assert.deepEqual([...appExportable(extending, schema, ['lead'], true)!].sort(), ['incident', 'service']);
  const open = parseAppConfig(
    {
      id: appId,
      name: 'Open',
      connection,
      resources: { incident: {} },
      views: { i: { kind: 'list', from: 'incident' } },
      home: 'i',
    },
    'export grant open',
  );
  assert.equal(appExportable(open, schema, [], false), undefined);
});

test('export names a table the role reads', () => {
  const grant = (roleGrant: Record<string, unknown>) =>
    parseAppConfig(
      {
        id: appId,
        name: 'Export Atlas',
        connection,
        resources: { incident: { access: 'write' }, service: {} },
        auth: {
          providers: ['email'],
          roles: { a: { read: ['incident'], ...roleGrant } },
        },
        views: {
          incidents: { kind: 'list', from: 'incident', label: 'Incidents' },
        },
        home: 'incidents',
      },
      'export grant names',
    );
  assert.throws(() => grant({ export: ['service'] }), /"export" names "service", which the role does not read/);
  assert.throws(() => grant({ export: 'incident' }), /"export" must be a list/);
  assert.ok(grant({ export: ['incident'] }));
});

test('a role that may export incident but not service cannot take service columns through a reference path', async () => {
  await served(async (base) => {
    assert.equal(await exportOf(base, 'writer', 'incident show id, name'), 200);
    assert.equal(
      await exportOf(base, 'writer', 'incident show id, name, service_id.name'),
      403,
      'a column from a table the role may not export',
    );
    assert.equal(
      await exportOf(base, 'writer', 'incident show id where service_id.name = "Identity service"'),
      403,
      'nor a filter that reads it',
    );
    assert.equal(await exportOf(base, 'writer', 'service show id, name'), 403);
    assert.equal(await exportOf(base, 'both', 'incident show id, name, service_id.name'), 200, 'a role that may export both is served');
    assert.equal(await exportOf(base, 'auditor', 'service show id, name'), 200);
  });
});

test('ui.export: false refuses the file for a writer, and for an App without role grants', async () => {
  await served(
    async (base) => {
      assert.equal(await exportOf(base, 'writer', 'incident'), 403, 'the switch is a ceiling over the role grants');
      assert.equal(await exportOf(base, 'both', 'service'), 403);
    },
    appOver({ export: false }),
  );
  const open = parseAppConfig(
    {
      id: appId,
      name: 'Export Open',
      connection,
      resources: { incident: {}, service: {} },
      views: {
        incidents: { kind: 'list', from: 'incident', label: 'Incidents' },
      },
      home: 'incidents',
      ui: { export: false },
    },
    'export grant open off',
  );
  await served(async (base) => {
    assert.equal(await exportOf(base, undefined, 'incident'), 403);
  }, open);
});

test('a rollup carries the table it counts into the file, and the export grant holds it', async () => {
  const over = parseAppConfig(
    {
      id: appId,
      name: 'Export Atlas',
      connection,
      resources: {
        incident: { access: 'write', computed: { doubled: { type: 'number', value: 'id * 2' } } },
        service: { rollups: { incidents: { fn: 'count', from: 'incident' } } },
      },
      auth: {
        providers: ['email'],
        defaultRole: 'reader',
        roles: {
          writer: { read: ['incident', 'service'], write: ['incident'] },
          auditor: { read: ['incident', 'service'], export: ['service'] },
        },
      },
      views: { incidents: { kind: 'list', from: 'incident', label: 'Incidents' } },
      home: 'incidents',
    },
    'export grant rollups',
  );
  await served(async (base) => {
    assert.equal(await exportOf(base, 'auditor', 'service show id, name'), 200);
    assert.equal(await exportOf(base, 'auditor', 'service show id, name, incidents'), 403, "a count of incident's rows is incident's");
    assert.equal(await exportOf(base, 'auditor', 'service show id where incidents > 0'), 403, 'and so is a filter on one');
    assert.equal(await exportOf(base, 'writer', 'incident show id, name'), 200);
    // A computed column is held to the tables its reads reach; one over the record's own columns is the record's.
    assert.equal(await exportOf(base, 'writer', 'incident show id, doubled'), 200);
    assert.equal(await exportOf(base, 'both', 'service show id, incidents'), 200, 'a role that may export both is served');
  }, over);
});

test('a list read of a table its reader may not export answers a screen, never a file', async () => {
  const many = `WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < 2600)
    INSERT INTO incident SELECT i, 'Incident ' || i, 1 FROM n;`;
  await served(
    async (base) => {
      const rows = async (who: string) => {
        const response = await fetch(`${base}/api/run`, {
          method: 'POST',
          headers: { Cookie: `session=${who}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ app: appId, q: 'incident', limit: 100_000, count: 'none' }),
        });
        assert.equal(response.status, 200);
        return ((await response.json()) as { rows: unknown[] }).rows.length;
      };
      assert.equal(await rows('reader'), 2_000, 'a reader who may not export incident reads at most a screen of it');
      assert.equal(await rows('writer'), 2_600, 'a writer, who exports incident, reads it whole');
    },
    app,
    many,
  );
});
