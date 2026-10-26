import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal, history } from '../packages/engine/src/server/journal.js';
import { filtersPath, pagesPath, writeLayout } from '../packages/engine/src/server/layouts.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';

const connection = 'operator-private-database';
const appId = 'service-atlas';
const secret = 'CONFIDENTIAL-RESOURCE-CONTENT';
const identity = (role?: string): Identity => ({
  id: `account-${role ?? 'unassigned'}`,
  who: 'person@example.test',
  ...(role ? { role } : {}),
});
const sessions: Record<string, Identity> = {
  viewer: identity('viewer'),
  agent: identity('agent'),
  limited: identity('limited'),
  'other-agent': { ...identity('agent'), id: 'account-other-agent' },
  unknown: identity('unknown'),
  unassigned: identity(),
  invalid: { id: '', who: 'invalid@example.test', role: 'agent' },
};

function definition(viewerWritable = false, agentWritable = true) {
  return parseAppConfig(
    {
      id: appId,
      name: 'Service Atlas',
      connection,
      resources: { incident: { access: 'write' }, service: {}, private_owner: {}, private_note: {} },
      auth: {
        providers: ['email'],
        defaultRole: 'viewer',
        roles: {
          // A resource reads by default; the private ones are forbidden because no role reads them.
          viewer: { read: ['incident', 'service'], ...(viewerWritable ? { write: true } : {}) },
          agent: { read: ['incident', 'service'], ...(agentWritable ? { write: true } : {}) },
          limited: { read: ['service'] },
        },
      },
      views: {
        incidents: { kind: 'list', from: 'incident', label: 'Incidents' },
        services: { kind: 'list', from: 'service', label: 'Services' },
        'private-owners': { kind: 'list', from: 'private_owner', label: 'Private owners' },
        'private-notes': { kind: 'list', from: 'private_note', label: 'Private notes' },
      },
      home: 'incidents',
      nav: ['incidents', 'services', 'private-owners', 'private-notes'],
    },
    'access HTTP fixture',
  );
}

async function fixture(
  options: { noAuth?: boolean; secondApp?: boolean; writable?: boolean },
  run: (context: {
    base: string;
    db: DatabaseSync;
    registry: Registry;
    host: AppHost;
    calls: string[];
    opens: () => number;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-access-http-'));
  const previousConfig = process.env.XDG_CONFIG_HOME;
  const path = join(directory, 'private.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE service (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE private_owner (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE incident (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL,
      service_id INTEGER REFERENCES service(id), owner_id INTEGER REFERENCES private_owner(id)
    );
    CREATE TABLE private_note (id INTEGER PRIMARY KEY, name TEXT NOT NULL, incident_id INTEGER REFERENCES incident(id));
    INSERT INTO service VALUES (1, 'Identity service');
  `);
  db.prepare('INSERT INTO private_owner VALUES (1, ?)').run(secret);
  db.exec("INSERT INTO incident VALUES (1, 'Allowed incident', 1, 1)");
  db.prepare('INSERT INTO private_note VALUES (1, ?, 1)').run(secret);
  clearJournal(connection);
  const registry = new Registry();
  registry.add({ id: connection, name: 'Private operator connection', url: path, source: 'config', writable: options.writable !== false });
  const pages = parsePagesConfig(
    {
      pages: [
        { label: 'Incident', base: 'incident' },
        { label: 'Private notes', base: 'private_note' },
      ],
    },
    'access pages',
  );
  const manifest = definition();
  const host: AppHost = {
    app: { path: '/operator/private/app.ts', app: manifest, pages, sources: {} },
    pages: [],
    ...(!options.noAuth
      ? {
          auth: {
            spec: manifest.auth!,
            store: '/operator/private/sessions.db',
            handler: async () => {},
            close: async () => {},
            session: async (req: { headers: { cookie?: string } }) => sessions[req.headers.cookie?.replace(/^session=/, '') ?? ''] ?? null,
          },
        }
      : {}),
  };
  const calls: string[] = [];
  let openCount = 0;
  const observed = new WeakSet<Adapter>();
  const open = registry.open.bind(registry);
  registry.open = async (id) => {
    openCount++;
    const opened = await open(id);
    if (!observed.has(opened.adapter)) {
      observed.add(opened.adapter);
      for (const method of [
        'query',
        'count',
        'countEach',
        'estimateCount',
        'runView',
        'countView',
        'runBreakdown',
        'countBreakdown',
        'update',
        'insert',
        'remove',
      ] as const) {
        const original = opened.adapter[method];
        if (typeof original !== 'function') continue;
        Object.defineProperty(opened.adapter, method, {
          configurable: true,
          writable: true,
          value: (...args: unknown[]) => {
            calls.push(method);
            return Reflect.apply(original, opened.adapter, args);
          },
        });
      }
    }
    return opened;
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const other: AppHost = { app: { ...host.app, app: { ...manifest, id: 'other-app', auth: undefined } }, pages: [] };
  const server = createApp({
    registry,
    bound,
    apps: options.secondApp ? [host, other] : [host],
    pages,
    views: [{ id: 'private-view', name: 'Private view', base: 'private_note', columns: [{ path: 'name' }] }],
  });
  process.env.XDG_CONFIG_HOME = directory;
  try {
    for (const scope of [connection, appId]) {
      await writeLayout(scope, 'private_note', { title: secret });
      await writeLayout(scope, 'private-page', { id: 'private-page', name: secret, base: 'private_note', sections: [] }, pagesPath());
      await writeLayout(scope, 'private_note', [{ name: secret, query: 'name contains confidential' }], filtersPath());
    }
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    await run({ base: `http://${bound.host}:${bound.port}`, db, registry, host, calls, opens: () => openCount });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal(connection);
    db.close();
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    rmSync(directory, { recursive: true, force: true });
  }
}

async function request(base: string, path: string, body?: Record<string, unknown>, role = 'viewer', headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(3_000),
    headers: { Cookie: `session=${role}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { method: 'POST', body: JSON.stringify({ app: appId, ...body }) } : {}),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

function noDisclosure(value: unknown) {
  assert.doesNotMatch(
    JSON.stringify(value),
    /CONFIDENTIAL-RESOURCE-CONTENT|private_owner|private_note|operator-private-database|Private operator connection|\/operator\/private/,
  );
}

function denied(result: Awaited<ReturnType<typeof request>>) {
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body.error, 'Access to this resource is denied.');
}

test('App runtime uses authored app identity and rejects physical connection selectors', { timeout: 10_000 }, async () => {
  await fixture({}, async ({ base }) => {
    const runtime = await request(base, '/api/runtime');
    assert.equal(runtime.status, 200);
    assert.equal(runtime.body.active, appId);
    assert.deepEqual(
      runtime.body.apps.map((app: { id: string }) => app.id),
      [appId],
    );
    assert.equal(runtime.body.sources, undefined);
    noDisclosure(runtime.body);
    const schema = await request(base, `/api/schema?app=${appId}`);
    assert.equal(schema.status, 200);
    assert.equal(schema.headers.get('x-mistri-connection'), null);
    assert.equal((await request(base, `/api/schema?conn=${connection}`)).status, 400);
    assert.equal((await request(base, '/api/query', { conn: connection, table: 'incident' })).status, 400);
    assert.equal((await request(base, '/api/schema?app=missing')).status, 404);
    assert.equal((await request(base, '/api/query?app=another', { table: 'incident' })).status, 400);
  });
});

test(
  'access without initialized authentication and multi-app authentication fail before opening databases',
  { timeout: 10_000 },
  async () => {
    for (const options of [{ noAuth: true }, { secondApp: true }]) {
      await fixture(options, async ({ base, opens }) => {
        const result = await request(base, `/api/schema?app=${appId}`);
        assert.equal(result.status, 503, JSON.stringify(result.body));
        assert.equal(opens(), 0);
        noDisclosure(result.body);
      });
    }
  },
);

test('metadata removes forbidden resources, incoming relationships, and saved definitions', { timeout: 10_000 }, async () => {
  await fixture({}, async ({ base }) => {
    const schema = await request(base, `/api/schema?app=${appId}`);
    assert.equal(schema.status, 200);
    assert.deepEqual(schema.body.tables.map((table: { id: string }) => table.id).sort(), ['incident', 'service']);
    assert.equal(schema.body.foreignKeys.length, 1);
    noDisclosure(schema.body);
    for (const path of [
      '/api/app',
      '/api/views',
      '/api/pages',
      '/api/layouts',
      '/api/pages/saved',
      '/api/filters',
      '/api/pages/relations?table=incident',
      '/api/pages/suggested?table=incident',
    ]) {
      const result = await request(base, `${path}${path.includes('?') ? '&' : '?'}app=${appId}`);
      assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`);
      noDisclosure(result.body);
    }
    const manifest = await request(base, `/api/app?app=${appId}`);
    assert.deepEqual(
      Object.values(manifest.body.app.views).map((view) => (view as { table: string }).table),
      ['incident', 'service'],
    );
    assert.deepEqual(manifest.body.app.writableTables, []);
    const references = await request(base, '/api/references', { table: 'incident', key: { id: 1 } });
    assert.equal(references.status, 200);
    assert.deepEqual(references.body.references, []);
    noDisclosure(references.body);
  });
});

test('App users cannot bypass resource access through SQL, compilation, or agent diagnostics', { timeout: 10_000 }, async () => {
  await fixture({}, async ({ base, calls }) => {
    for (const [path, body] of [
      ['/api/sql', { text: 'SELECT * FROM private_note', writable: true }],
      ['/api/view/compile', { view: { id: 'private', name: 'Private', base: 'private_note', columns: [{ path: 'name' }] } }],
      ['/api/agent/call', { name: 'query', arguments: { table: 'private_note' } }],
      ['/api/layouts', { table: 'incident', layout: { title: 'Shared mutation' } }],
      ['/api/pages/save', { page: { id: 'shared', name: 'Shared mutation', base: 'incident', sections: [] } }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await request(base, path, body, 'agent');
      assert.equal(result.status, 403, JSON.stringify(result.body));
      noDisclosure(result.body);
    }
    const queries = await request(base, `/api/queries?app=${appId}`, undefined, 'agent');
    assert.equal(queries.status, 403);
    noDisclosure(queries.body);
    assert.deepEqual(calls, []);
  });
});

test('direct forbidden reads, counts, and mutations never reach a database adapter', { timeout: 10_000 }, async () => {
  await fixture({}, async ({ base, calls, db }) => {
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['/api/query', { table: 'private_note' }],
      ['/api/count', { table: 'private_note', exactCount: true }],
      ['/api/references', { table: 'private_note', key: { id: 1 } }],
      ['/api/update', { table: 'private_note', key: { id: 1 }, values: { name: 'forged' } }],
      ['/api/insert', { table: 'private_note', values: { name: 'forged', incident_id: 1 } }],
      ['/api/delete', { table: 'private_note', key: { id: 1 }, confirm: true }],
      ['/api/pages/plan', { page: { id: 'attempt', name: 'Attempt', base: 'private_note', sections: [] }, key: { id: 1 } }],
    ];
    for (const [path, body] of attempts) {
      calls.length = 0;
      denied(await request(base, path, body, 'agent'));
      assert.deepEqual(calls, [], path);
    }
    for (const path of ['/api/pages/relations', '/api/pages/suggested']) {
      denied(await request(base, `${path}?app=${appId}&table=private_note`, undefined, 'agent'));
    }
    assert.equal(db.prepare('SELECT name FROM private_note').get()?.name, secret);
    assert.deepEqual(history(connection), []);
  });
});

test('forward paths, related filters, reverse aggregates, search and export cannot read forbidden data', { timeout: 10_000 }, async () => {
  await fixture({}, async ({ base, registry, calls }) => {
    const physical = await registry.open(connection);
    const incoming = physical.schema.foreignKeys.find((fk) => fk.from.table === 'private_note')!;
    assert.ok(incoming);
    const view = { id: 'attempt', name: 'Attempt', base: 'incident', columns: [{ path: 'name' }] };
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['/api/run', { q: 'private_note show name', limit: 100_000 }],
      ['/api/run', { q: `private_note name contains ${secret}` }],
      ['/api/run', { q: 'incident show name, owner_id.name' }],
      ['/api/view/run', { view: { ...view, columns: [{ path: 'owner_id.name' }] } }],
      ['/api/view/run', { view: { ...view, filter: { groups: [[{ path: 'owner_id.name', op: '=', value: secret }]] } } }],
      ['/api/view/run', { view: { ...view, aggregates: [{ fn: 'count', via: incoming.name, alias: 'private_count' }] } }],
      ['/api/view/run', { view: { ...view, orderBy: [{ path: 'owner_id.name', direction: 'asc' }] } }],
      ['/api/view/run', { text: 'incident show name', query: `owner_id.name contains ${secret}` }],
      ['/api/breakdown', { text: 'private_note count' }],
      ['/api/breakdown', { text: 'incident count by owner_id.name' }],
      ['/api/breakdown', { def: { base: 'private_note', by: [], measures: [{ fn: 'count' }] } }],
      ['/api/breakdown', { def: { base: 'incident', by: [{ path: 'owner_id.name' }], measures: [{ fn: 'count' }] } }],
      [
        '/api/breakdown',
        {
          def: {
            base: 'incident',
            by: [],
            measures: [{ fn: 'count' }],
            filter: { groups: [[{ path: 'owner_id.name', op: '=', value: secret }]] },
          },
        },
      ],
    ];
    for (const [path, body] of attempts) {
      calls.length = 0;
      const result = await request(base, path, body);
      assert.ok([200, 400, 403].includes(result.status), `${path}: ${JSON.stringify(result.body)}`);
      assert.ok(result.body.error || result.body.errors?.length, JSON.stringify(result.body));
      assert.equal(result.body.rows, undefined);
      assert.equal(result.body.total, undefined);
      assert.deepEqual(calls, [], `${path}: ${JSON.stringify(body)}`);
    }
  });
});

test('batched counts, references and the streamed export read only granted resources', { timeout: 10_000 }, async () => {
  await fixture({}, async ({ base, calls }) => {
    /* A forbidden table in a batch is an error in its own item and never a
       statement; the granted items beside it are still counted. */
    calls.length = 0;
    const counts = await request(
      base,
      '/api/counts',
      { items: ['incident', 'private_note', `incident owner_id.name = "${secret}"`, 'service'] },
      'agent',
    );
    assert.equal(counts.status, 200, JSON.stringify(counts.body));
    const [incident, note, walked, service] = counts.body.results;
    assert.equal(incident.total, 1);
    assert.equal(service.total, 1);
    for (const refused of [note, walked]) {
      assert.equal(refused.total, undefined);
      assert.ok(refused.errors?.length, JSON.stringify(refused));
    }
    noDisclosure(counts.body.results.map((result: { total?: number }) => result.total));
    assert.ok(!calls.some((call) => call === 'query'), 'counting reads no rows');

    // The incident's incoming private notes are not one of its references.
    const references = await request(base, '/api/references', { table: 'incident', key: { id: 1 } }, 'agent');
    assert.equal(references.status, 200);
    noDisclosure(references.body);

    for (const body of [{ q: 'private_note' }, { q: 'incident show name, owner_id.name' }, { q: `private_note name contains ${secret}` }]) {
      calls.length = 0;
      const response = await fetch(`${base}/api/export`, {
        method: 'POST',
        signal: AbortSignal.timeout(3_000),
        headers: { Cookie: 'session=agent', 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: appId, ...body }),
      });
      const text = await response.text();
      assert.equal(response.headers.get('content-disposition'), null, `${JSON.stringify(body)}: ${text}`);
      assert.doesNotMatch(text, /CONFIDENTIAL-RESOURCE-CONTENT/);
      assert.deepEqual(calls, [], JSON.stringify(body));
    }
    const allowed = await fetch(`${base}/api/export`, {
      method: 'POST',
      signal: AbortSignal.timeout(3_000),
      headers: { Cookie: 'session=agent', 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: appId, q: 'incident', format: 'ndjson' }),
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual(
      (await allowed.text())
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      [{ id: 1, name: 'Allowed incident', service_id: 1, owner_id: 1 }],
    );
  });
});

test('revalidated metadata is keyed by principal, and a reload is a new validator', { timeout: 10_000 }, async () => {
  await fixture({}, async ({ base, host }) => {
    const tag = async (role: string, etag?: string) => {
      const response = await fetch(`${base}/api/app?app=${appId}`, {
        signal: AbortSignal.timeout(3_000),
        headers: { Cookie: `session=${role}`, ...(etag ? { 'If-None-Match': etag } : {}) },
      });
      await response.arrayBuffer();
      return {
        status: response.status,
        etag: response.headers.get('etag'),
        cache: response.headers.get('cache-control'),
        vary: response.headers.get('vary') ?? '',
      };
    };
    const agent = await tag('agent');
    assert.equal(agent.cache, 'private, no-cache');
    assert.match(agent.vary, /Cookie/);
    assert.equal((await tag('agent', agent.etag!)).status, 304);
    // Another principal never revalidates against the agent's copy.
    const limited = await tag('limited', agent.etag!);
    assert.equal(limited.status, 200);
    assert.notEqual(limited.etag, agent.etag);
    // A narrower definition after a reload: the old validator no longer answers.
    host.app.app = definition(false, false);
    assert.equal((await tag('agent', agent.etag!)).status, 200);
    host.app.app = definition();
  });
});

test('permitted forward relationships and aggregates remain usable under the access guard', { timeout: 10_000 }, async () => {
  await fixture({}, async ({ base }) => {
    const rows = await request(base, '/api/run', { q: 'incident show name' });
    assert.equal(rows.status, 200);
    assert.deepEqual(rows.body.rows, [{ name: 'Allowed incident' }]);
    const related = await request(base, '/api/view/run', { text: 'incident show name, service_id.name' });
    assert.equal(related.status, 200, JSON.stringify(related.body));
    assert.deepEqual(related.body.rows, [{ name: 'Allowed incident', 'service_id.name': 'Identity service' }]);
    const count = await request(base, '/api/count', { table: 'incident' });
    assert.equal(count.status, 200);
    assert.equal(count.body.count, 1);
    const breakdown = await request(base, '/api/breakdown', { text: 'incident count by service_id.name' });
    assert.equal(breakdown.status, 200, JSON.stringify(breakdown.body));
    assert.equal(breakdown.body.rows.length, 1);
    noDisclosure(breakdown.body);
  });
});

test('verified roles cannot be replaced by client flags and grants cannot exceed root ceilings', { timeout: 10_000 }, async () => {
  await fixture({}, async ({ base, calls, db }) => {
    const body = {
      table: 'incident',
      key: { id: 1 },
      values: { name: 'Changed' },
      writable: true,
      role: 'agent',
      user: { role: 'agent' },
      identity: identity('agent'),
      access: { read: true, write: true },
      permissions: { update: true },
      source: connection,
    };
    calls.length = 0;
    denied(await request(base, '/api/update?role=agent', body, 'viewer', { 'X-Role': 'agent', 'X-Mistri-Role': 'agent' }));
    assert.deepEqual(calls, []);
    denied(await request(base, '/api/update', { ...body, table: 'service' }, 'agent'));
    assert.equal(db.prepare('SELECT name FROM service').get()?.name, 'Identity service');
    const updated = await request(base, '/api/update', body, 'agent');
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.affected, 1);
    assert.equal(db.prepare('SELECT name FROM incident').get()?.name, 'Changed');
    // An App journals nothing: its writes have no Undo.
    assert.deepEqual(history(connection), []);
  });
});

test('unknown, unassigned, and invalid session identities cannot inherit the app permissions', { timeout: 10_000 }, async () => {
  await fixture({}, async ({ base, calls }) => {
    for (const role of ['unknown', 'unassigned', 'invalid']) {
      calls.length = 0;
      const result = await request(base, '/api/query', { table: 'incident', role: 'agent', writable: true }, role);
      assert.ok([401, 403].includes(result.status), `${role}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.rows, undefined);
      assert.deepEqual(calls, []);
    }
    assert.equal((await request(base, '/api/query', { table: 'incident' }, 'signed-out')).status, 401);
  });
});

test("an App's revert route says it has no Undo, to every principal, and reverts nothing", { timeout: 10_000 }, async () => {
  await fixture({}, async ({ base, db, calls }) => {
    const updated = await request(base, '/api/update', { table: 'incident', key: { id: 1 }, values: { name: 'Changed' } }, 'agent');
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.undoId, undefined);
    calls.length = 0;
    for (const role of ['agent', 'limited', 'other-agent'] as const) {
      for (const body of [{}, { confirm: true, expectedId: 1 }]) {
        const reply = await request(base, '/api/revert', body, role);
        assert.equal(reply.status, 404, JSON.stringify(reply.body));
        assert.doesNotMatch(JSON.stringify(reply.body), /incident|Changed|person@example/);
      }
    }
    assert.deepEqual(calls, []);
    assert.equal(db.prepare('SELECT name FROM incident').get()?.name, 'Changed');
  });
});

test('physical read-only connections remain read-only despite valid access write grants', { timeout: 10_000 }, async () => {
  await fixture({ writable: false }, async ({ base, db, calls }) => {
    const runtime = await request(base, '/api/runtime', undefined, 'agent');
    assert.equal(runtime.status, 200);
    assert.equal(runtime.body.apps[0].writable, false);
    const manifest = await request(base, `/api/app?app=${appId}`, undefined, 'agent');
    assert.equal(manifest.status, 200);
    assert.deepEqual(manifest.body.app.writableTables, []);
    const read = await request(base, '/api/query', { table: 'incident', columns: ['name'] }, 'agent');
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.rows, [{ name: 'Allowed incident' }]);
    calls.length = 0;
    for (const [path, body] of [
      ['/api/update', { key: { id: 1 }, values: { name: 'Read-only override' } }],
      ['/api/insert', { values: { name: 'Read-only override' } }],
      ['/api/delete', { key: { id: 1 }, confirm: true }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await request(
        base,
        path,
        { ...body, table: 'incident', writable: true, access: { write: true }, role: 'agent' },
        'agent',
      );
      assert.equal(result.status, 403, JSON.stringify(result.body));
      assert.deepEqual(calls, [], path);
    }
    assert.equal(db.prepare('SELECT name FROM incident').get()?.name, 'Allowed incident');
    assert.deepEqual(history(connection), []);
  });
});

test('per-role metadata stays isolated and policy reload does not reuse permissive cached payloads', { timeout: 10_000 }, async () => {
  await fixture({}, async ({ base, host }) => {
    const agent = await request(base, `/api/app?app=${appId}`, undefined, 'agent');
    assert.deepEqual(agent.body.app.writableTables, ['incident']);
    const limited = await request(base, `/api/app?app=${appId}`, undefined, 'limited');
    assert.deepEqual(
      Object.values(limited.body.app.views).map((view) => (view as { table: string }).table),
      ['service'],
    );
    assert.deepEqual(limited.body.app.writableTables, []);
    host.app.app = definition(true);
    const broader = await request(base, `/api/app?app=${appId}`);
    assert.deepEqual(broader.body.app.writableTables, ['incident']);
    host.app.app = definition();
    const narrowed = await request(base, `/api/app?app=${appId}`);
    assert.deepEqual(narrowed.body.app.writableTables, []);
    denied(await request(base, '/api/update', { table: 'incident', key: { id: 1 }, values: { name: 'Forbidden' } }));
  });
});

test('a pending request retains its verified policy snapshot when hot reload widens access', { timeout: 10_000 }, async () => {
  await fixture({}, async ({ base, registry, host, db }) => {
    let release!: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived!: () => void;
    const pending = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const open = registry.open.bind(registry);
    registry.open = async (id) => {
      arrived();
      await resume;
      return open(id);
    };
    const body = { table: 'incident', key: { id: 1 }, values: { name: 'Snapshot write' } };
    const result = request(base, '/api/update', body);
    try {
      const opened = await Promise.race([pending.then(() => true), result.then(() => false)]);
      if (!opened) {
        denied(await result);
        return;
      }
      host.app.app = definition(true);
      release();
      denied(await result);
      assert.equal(db.prepare('SELECT name FROM incident').get()?.name, 'Allowed incident');
      const next = await request(base, '/api/update', body);
      assert.equal(next.status, 200, JSON.stringify(next.body));
      assert.equal(next.body.affected, 1);
    } finally {
      release();
      await result.catch(() => {});
    }
  });
});
