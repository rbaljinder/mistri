/**
 * The read audit (`audit: { reads: true }`): its store, the one row each
 * door writes, the refusal when a row cannot be written, coalescing, the
 * tenant and support rows, the CLI, and what it costs a request.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { QueryResult } from '../packages/engine/src/shared/reads.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { TenantUnavailableError } from '../packages/engine/src/server/evidence.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { resolveAppAccess } from '../packages/mistri/src/shared/appAccess.js';
import { authorizeResources } from '../packages/mistri/src/server/app/appAccess.js';
import { appEntrypoint } from '../packages/mistri/src/server/app/appEntrypoint.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import {
  appendSqliteReadAudit,
  readSqliteReadAudit,
  sqliteReadAuditReady,
} from '../packages/mistri/src/adapters/readAudit/sqliteReadAudit.js';
import type { ReadAuditRow } from '../packages/mistri/src/adapters/readAudit/readAudit.js';
import {
  auditQueryRead,
  currentReadRoute,
  forgetReadAuditCoalescing,
  readRouteOf,
  ReadAuditFailed,
  withoutReadAudit,
  withReadKind,
  withReadRoute,
  type AuditedAccess,
  type ReadAuditSink,
} from '../packages/mistri/src/server/readAudit.js';
import { ensureAppReadAudit, readAppReadAudit, withReadAuditSink } from '../packages/mistri/src/server/readAuditStore.js';
import { withTenantReadAudit } from '../packages/mistri/src/server/tenant/tenantReadAudit.js';
import { runAuditCommand, sinceInstant } from '../packages/mistri/src/server/cli/auditCommand.js';
import { renderApiReadOpenApi } from '../packages/mistri/src/server/api/apiReadOpenApi.js';
import { tenantBatchRequest } from '../packages/mistri/src/shared/tenantBoot.js';
import { createApp } from './support/createApp.js';
import { statementsOf } from './support/statements.js';

const connection = 'audited-database';
const appId = 'audited-desk';
const viewer: Identity = { id: 'account-viewer', who: 'viewer@example.test', role: 'viewer' };

const manifest = parseAppConfig(
  {
    id: appId,
    name: 'Audited desk',
    connection,
    resources: { incident: { audit: { reads: true } }, service: {} },
    auth: {
      providers: ['email'],
      defaultRole: 'viewer',
      roles: { viewer: { read: ['incident', 'service'], export: ['incident', 'service'] } },
    },
    views: {
      incidents: { kind: 'list', from: 'incident', label: 'Incidents' },
      services: { kind: 'list', from: 'service', label: 'Services' },
    },
    home: 'incidents',
    nav: ['incidents', 'services'],
  },
  'read audit fixture',
);

function database(directory: string): string {
  const path = join(directory, 'desk.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE service (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE incident (id INTEGER PRIMARY KEY, name TEXT NOT NULL, service_id INTEGER REFERENCES service(id));
    INSERT INTO service VALUES (1, 'Identity'), (2, 'Billing');
    INSERT INTO incident VALUES (1, 'Sign-in is slow', 1), (2, 'Invoices doubled', 2), (3, 'Password reset fails', 1);
  `);
  db.close();
  return path;
}

interface Context {
  base: string;
  path: string;
  registry: Registry;
  host: AppHost;
  rows: () => ReturnType<typeof readSqliteReadAudit>;
  post: (path: string, body: Record<string, unknown>, headers?: Record<string, string>) => Promise<{ status: number; text: string }>;
}

async function fixture(run: (context: Context) => Promise<void>, provision = true) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-read-audit-'));
  const path = database(directory);
  if (provision) await provisionStores({ sqlite: path }, { only: ['read-audit'] });
  const registry = new Registry();
  registry.add({ id: connection, name: 'Audited database', url: path, source: 'config' });
  const host: AppHost = {
    app: { path: join(directory, 'app.ts'), app: manifest, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: manifest.auth!,
      store: join(directory, 'sessions.db'),
      handler: async () => {},
      close: async () => {},
      session: async (req: { headers: { cookie?: string } }) => (req.headers.cookie === 'session=viewer' ? viewer : null),
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [], views: [] });
  const reader = new DatabaseSync(path);
  forgetReadAuditCoalescing();
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    const base = `http://${bound.host}:${bound.port}`;
    await run({
      base,
      path,
      registry,
      host,
      rows: () => readSqliteReadAudit(reader, { app: appId, limit: 100 }),
      post: async (route, body, headers = {}) => {
        const response = await fetch(`${base}${route}`, {
          signal: AbortSignal.timeout(5_000),
          method: 'POST',
          headers: { Cookie: 'session=viewer', 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ app: appId, ...body }),
        });
        return { status: response.status, text: await response.text() };
      },
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    reader.close();
    forgetReadAuditCoalescing();
    rmSync(directory, { recursive: true, force: true });
  }
}

const byId = (key: number) => ({ groups: [[{ column: 'id', op: '=', value: key }]] });

test('the store: provisioned only when asked, append-only, and a tampered layout is refused', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-read-audit-store-'));
  try {
    const path = database(directory);
    const db = new DatabaseSync(path);
    assert.equal(sqliteReadAuditReady(db), false, 'opening a database makes no store');
    const first = await provisionStores({ sqlite: path }, { only: ['read-audit'] });
    assert.equal(first.stores['read-audit']?.provisioned, true);
    const again = await provisionStores({ sqlite: path }, { only: ['read-audit'] });
    assert.equal(again.stores['read-audit']?.provisioned, false, 'the same layout again changes nothing');
    assert.equal(sqliteReadAuditReady(db), true);

    const row: ReadAuditRow = {
      at: new Date().toISOString(),
      app: appId,
      tenant: '',
      actor: 'account-1',
      resource: 'incident',
      route: 'page',
      record: '1',
    };
    appendSqliteReadAudit(db, row);
    assert.throws(() => db.exec(`UPDATE "__mistri_read_audit_row" SET actor = 'someone-else'`), /append-only/);
    assert.throws(() => db.exec(`DELETE FROM "__mistri_read_audit_row"`), /append-only/);
    assert.equal(readSqliteReadAudit(db, { limit: 10 }).length, 1);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO "__mistri_read_audit_row" (at, app, tenant, actor, resource, route) VALUES (?, ?, '', 'a', 'incident', 'page')`,
          )
          .run(row.at, appId),
      /CHECK/,
      'a row is either one record or a query',
    );

    /* The layout check counts the triggers: one dropped is a store refused, not one quietly writable. */
    db.exec('DROP TRIGGER "__mistri_read_audit_row_no_delete"');
    assert.equal(sqliteReadAuditReady(db), false);
    assert.throws(() => appendSqliteReadAudit(db, row), /read audit store/i);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an App that audits reads refuses to start on a database without the store, naming the command', async () => {
  await fixture(async ({ registry, host }) => {
    await assert.rejects(ensureAppReadAudit(registry, host), /mistri migrate stores up/);
  }, false);
});

test('each door writes one row before its rows leave, and an unaudited resource writes none', async () => {
  await fixture(async ({ registry, host, post, rows }) => {
    await ensureAppReadAudit(registry, host);

    const list = await post('/api/query', { table: 'incident', limit: 50 });
    assert.equal(list.status, 200, list.text);
    let written = rows();
    assert.equal(written.length, 1);
    assert.equal(written[0].route, 'page');
    assert.equal(written[0].actor, 'account-viewer');
    assert.equal(written[0].resource, 'incident');
    assert.equal(written[0].tenant, '');
    assert.equal(written[0].count, 3);
    assert.deepEqual(JSON.parse(written[0].ids!).sort(), ['1', '2', '3']);
    assert.equal(written[0].record, undefined);
    assert.ok(!JSON.stringify(written[0]).includes('Sign-in is slow'), 'a field value is never stored');

    const one = await post('/api/query', { table: 'incident', filter: byId(1), limit: 1 });
    assert.equal(one.status, 200, one.text);
    written = rows();
    assert.equal(written.length, 2);
    assert.equal(written[0].record, '1');
    assert.equal(written[0].query, undefined);

    const picker = await post('/api/query', { table: 'incident', filter: byId(2), limit: 1 }, { 'x-mistri-read': 'picker' });
    assert.equal(picker.status, 200, picker.text);
    assert.equal(rows()[0].route, 'picker');

    const related = await post(
      '/api/query',
      { table: 'incident', filter: { groups: [[{ column: 'service_id', op: '=', value: 1 }]] }, limit: 20 },
      {
        'x-mistri-read': 'related',
      },
    );
    assert.equal(related.status, 200, related.text);
    written = rows();
    assert.equal(written[0].route, 'related');
    assert.deepEqual(JSON.parse(written[0].ids!).sort(), ['1', '3']);

    const exported = await post('/api/export', { q: 'incident', format: 'ndjson' });
    assert.equal(exported.status, 200, exported.text);
    assert.equal(rows()[0].route, 'export');

    const before = rows().length;
    const unaudited = await post('/api/query', { table: 'service', limit: 50 });
    assert.equal(unaudited.status, 200, unaudited.text);
    assert.equal(rows().length, before, 'a resource that does not audit its reads writes nothing');

    /* Coalescing: the same read again inside the minute is the one row; another page of it is a new read. */
    const again = await post('/api/query', { table: 'incident', limit: 50 });
    assert.equal(again.status, 200);
    assert.equal(rows().length, before);
    const nextPage = await post('/api/query', { table: 'incident', limit: 50, offset: 1 });
    assert.equal(nextPage.status, 200);
    assert.equal(rows().length, before + 1);
    const sameQueryOtherRoute = await post('/api/query', { table: 'incident', limit: 50 }, { 'x-mistri-read': 'related' });
    assert.equal(sameQueryOtherRoute.status, 200);
    assert.equal(rows().length, before + 2, 'a new route always writes');

    const listed = await readAppReadAudit(registry, host, { resource: 'incident', record: '1' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].record, '1');
  });
});

test('a row that cannot be written stops the read: 503 and no body', async () => {
  await fixture(async ({ registry, host, path, post }) => {
    await ensureAppReadAudit(registry, host);
    const db = new DatabaseSync(path);
    db.exec('DROP TABLE "__mistri_read_audit_row"');
    db.close();
    const refused = await post('/api/query', { table: 'incident', limit: 50 });
    assert.equal(refused.status, 503);
    assert.equal(refused.text, '');
    const unaudited = await post('/api/query', { table: 'service', limit: 50 });
    assert.equal(unaudited.status, 200, 'an unaudited resource is not held hostage by the audit store');
  });
});

test('the doors: api, mcp and assistant actors, every address, and a read by no door', async () => {
  const schema = {
    tables: [{ id: 'incident', columns: [{ name: 'id', primaryKey: true }, { name: 'name' }] }],
  } as unknown as DatabaseSchema;
  const appended: ReadAuditRow[] = [];
  const sink: ReadAuditSink = { app: appId, tenant: '', actor: 'account-7', append: async (row) => void appended.push(row) };
  const access = { audited: new Map([['incident', 'incident']]), readAudit: sink };
  const result = { columns: ['id', 'name'], rows: [{ id: 4, name: 'x' }] } as unknown as QueryResult;
  const read = (offset = 0) => auditQueryRead(access, schema, connection, { table: 'incident', offset } as never, result);
  forgetReadAuditCoalescing();

  await withReadRoute('api', () => read(), 'api-token:12');
  await withReadRoute('mcp', () => read(), 'api-token:13');
  await withReadRoute('assistant', () => read());
  assert.deepEqual(
    appended.map((row) => [row.route, row.actor]),
    [
      ['api', 'api-token:12'],
      ['mcp', 'api-token:13'],
      ['assistant', 'assistant:account-7'],
    ],
  );
  assert.ok(
    appended.every((row) => !JSON.stringify(row).includes('"x"')),
    'no field value',
  );

  await assert.rejects(read(1), ReadAuditFailed, 'a read by no door is refused');
  await withoutReadAudit(() => read(2));
  assert.equal(appended.length, 3, "the server's own read writes nothing");
  await assert.rejects(
    withReadRoute('page', () =>
      auditQueryRead({ audited: access.audited }, schema, connection, { table: 'incident', offset: 3 } as never, result),
    ),
    ReadAuditFailed,
    'a grant nobody gave a sink is refused',
  );
  const failing: ReadAuditSink = { ...sink, append: async () => Promise.reject(new Error('disk full')) };
  await assert.rejects(
    withReadRoute('page', () =>
      auditQueryRead({ ...access, readAudit: failing }, schema, connection, { table: 'incident', offset: 4 } as never, result),
    ),
    ReadAuditFailed,
  );
  /* A failed row is not remembered as written: the same read tries again. */
  await withReadRoute('page', () => read(4));
  assert.equal(appended.length, 4);

  assert.equal(readRouteOf('/api/query'), 'page');
  assert.equal(readRouteOf('/api/record'), 'page');
  assert.equal(readRouteOf('/api/query', { 'x-mistri-read': 'picker' }), 'picker');
  assert.equal(readRouteOf('/api/query', { 'x-mistri-read': 'related' }), 'related');
  assert.equal(readRouteOf('/api/query', { 'x-mistri-page': 'board' }), 'custom-page');
  assert.equal(readRouteOf('/api/pages/load'), 'custom-page');
  assert.equal(readRouteOf('/api/references'), 'picker');
  assert.equal(readRouteOf('/api/export'), 'export');
  /* A header refines a page's read only: it cannot relabel an export or an API read in the log. */
  assert.equal(readRouteOf('/api/export', { 'x-mistri-read': 'picker' }), 'export');
  assert.equal(readRouteOf('/api/v1/leads', { 'x-mistri-page': 'board' }), 'api');
  assert.equal(readRouteOf('/api/assistant/turn'), 'assistant');
  assert.equal(readRouteOf('/mcp'), 'mcp');
  assert.equal(readRouteOf('/api/v1/incidents'), 'api');
  /* `/api/view/run` is the shell's own list/related read, not the versioned API: it is a page read the header refines. */
  assert.equal(readRouteOf('/api/view/run'), 'page');
  assert.equal(readRouteOf('/api/view/run', { 'x-mistri-read': 'related' }), 'related');
  assert.equal(readRouteOf('/api/v1'), 'api');

  /* A batched read says what it is on its item (`POST /api/boot` with `reads`): audited by that door, the same vocabulary,
     and only a page's read is refined, as a header refines it. */
  const doorOf = (path: string, kind: string | undefined, route: Parameters<typeof withReadRoute>[0] = 'page') =>
    withReadRoute(route, () => withReadKind(path, kind, () => currentReadRoute()));
  assert.equal(doorOf('/api/query', 'picker'), 'picker');
  assert.equal(doorOf('/api/query', 'related'), 'related');
  assert.equal(doorOf('/api/query', undefined), 'page');
  assert.equal(doorOf('/api/query', 'export'), 'page', 'a word the header does not know says nothing');
  assert.equal(doorOf('/api/export', 'picker'), 'export');
  assert.equal(doorOf('/api/query', 'picker', 'assistant'), 'assistant', 'a request that came by another door keeps it');
});

test('a batch item says only what a picker or related read would have said', () => {
  const item = { method: 'POST', path: '/api/query', body: { table: 'item' } };
  assert.equal(tenantBatchRequest({ reads: [{ ...item, read: 'picker' }] })?.[0].read, 'picker');
  assert.equal(tenantBatchRequest({ reads: [{ ...item, read: 'related' }] })?.[0].read, 'related');
  assert.equal(tenantBatchRequest({ reads: [item] })?.[0].read, undefined);
  for (const read of ['export', 'custom-page', 'page', '', 1, null])
    assert.equal(tenantBatchRequest({ reads: [{ ...item, read }] }), undefined);
});

test('a tenant row carries its tenant, a support visit its operator, and one tenant never reads another', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-read-audit-tenant-'));
  try {
    const path = database(directory);
    await provisionStores({ sqlite: path }, { only: ['read-audit'] });
    const db = new DatabaseSync(path);
    const schema = { tables: [{ id: 'incident', columns: [{ name: 'id', primaryKey: true }] }] } as unknown as DatabaseSchema;
    const result = { columns: ['id'], rows: [{ id: 1 }] } as unknown as QueryResult;
    const audited: AuditedAccess = { audited: new Map([['incident', 'incident']]) };
    const append = async (row: ReadAuditRow) => appendSqliteReadAudit(db, row);
    forgetReadAuditCoalescing();

    const memberA = withTenantReadAudit(audited, { app: appId, tenant: 'a', actor: 'account-a' }, append);
    const memberB = withTenantReadAudit(audited, { app: appId, tenant: 'b', actor: 'account-b' }, append);
    const support = withTenantReadAudit(audited, { app: appId, tenant: 'a', actor: 'support:operator-1', visit: 'visit-9' }, append);
    for (const access of [memberA, memberB, support])
      await withReadRoute('page', () =>
        auditQueryRead(access, schema, connection, { table: 'incident', filter: byId(1) } as never, result),
      );

    const a = readSqliteReadAudit(db, { tenant: 'a', limit: 10 });
    assert.deepEqual(a.map((row) => [row.tenant, row.actor, row.visit ?? null, row.record]).sort(), [
      ['a', 'account-a', null, '1'],
      ['a', 'support:operator-1', 'visit-9', '1'],
    ]);
    const b = readSqliteReadAudit(db, { tenant: 'b', limit: 10 });
    assert.deepEqual(
      b.map((row) => row.actor),
      ['account-b'],
      "tenant b's log holds none of a's rows",
    );

    const unwired = withTenantReadAudit(audited, { app: appId, tenant: 'a', actor: 'account-a' }, undefined);
    await assert.rejects(unwired.readAudit!.append({ ...a[0], at: new Date().toISOString() }, connection), TenantUnavailableError);
    const broken = withTenantReadAudit(audited, { app: appId, tenant: 'a', actor: 'account-a' }, () =>
      Promise.reject(new Error('writer paused')),
    );
    await assert.rejects(broken.readAudit!.append({ ...a[0] }, connection), TenantUnavailableError);
    assert.equal(
      withTenantReadAudit<AuditedAccess>({ audited: new Map() }, { app: appId, tenant: 'a', actor: 'x' }, append).readAudit,
      undefined,
      'nothing audited, no sink',
    );
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mistri audit reads: --since, and its refusals', async () => {
  const now = Date.parse('2026-11-09T12:00:00.000Z');
  assert.equal(sinceInstant('24h', now), '2026-11-08T12:00:00.000Z');
  assert.equal(sinceInstant('30m', now), '2026-11-09T11:30:00.000Z');
  assert.equal(sinceInstant('2026-11-01T00:00:00Z', now), '2026-11-01T00:00:00.000Z');
  assert.equal(sinceInstant('yesterday', now), undefined);

  const lines: string[] = [];
  const write = (line: string) => void lines.push(line);
  const errors: string[] = [];
  const error = console.error;
  console.error = (line: string) => void errors.push(line);
  try {
    assert.equal(await runAuditCommand([], write), 1);
    assert.equal(await runAuditCommand(['--help'], write), 0);
    assert.match(lines.at(-1)!, /mistri audit reads/);
    assert.equal(await runAuditCommand(['writes'], write), 1);
    assert.equal(await runAuditCommand(['reads', '--since', 'soon'], write), 1);
    assert.equal(await runAuditCommand(['reads', '--limit', '0'], write), 1);
    assert.equal(await runAuditCommand(['reads', '--resource'], write), 1);
    assert.equal(await runAuditCommand(['reads', '--app', join(tmpdir(), 'no-such-app-dir-mistri')], write), 1);
  } finally {
    console.error = error;
  }
  assert.ok(errors.some((line) => /not an audit command/.test(line)));
  assert.ok(errors.some((line) => /--since takes/.test(line)));
});

test('what it costs: one statement for an audited read, none for an unaudited one', async () => {
  await fixture(async ({ registry, host }) => {
    const releases: Array<() => void> = [];
    try {
      const resources = await loadAppRuntimeResources(registry, manifest, appEntrypoint(host, registry)!, (owner) =>
        releases.push(registry.lease(owner)),
      );
      const { adapter } = await registry.open(connection);
      const access = withReadAuditSink(
        resolveAppAccess(manifest, resources.schema, ['viewer']),
        { app: appId, tenant: '', actor: 'account-viewer' },
        adapter,
        connection,
      );
      const facade = authorizeResources(resources, access);
      const read = (table: string, offset: number) =>
        withReadRoute('page', () => facade.adapter.query({ table, limit: 50, offset } as never));
      /* Warm: the first read attests the store and prepares its statements. */
      await read('incident', 0);
      await read('service', 0);
      const audited = await statementsOf(() => read('incident', 1));
      const plain = await statementsOf(() => read('service', 1));
      const appends = audited.statements.filter((sql) => /__mistri_read_audit_row/.test(sql));
      assert.equal(appends.length, 1, audited.statements.join('\n'));
      assert.equal(
        audited.total - plain.total,
        1,
        `audited ${audited.total} vs unaudited ${plain.total}:\n${audited.statements.join('\n')}`,
      );
      assert.ok(!plain.statements.some((sql) => /__mistri_read_audit/.test(sql)));
    } finally {
      for (const release of releases.reverse()) release();
    }
  });
});

test('the App API says which reads are audited, and that one it cannot record answers 503', () => {
  const definition = parseAppConfig(
    {
      id: 'directory',
      name: 'Directory',
      resources: { person: { audit: { reads: true } }, team: {} },
      auth: { roles: { reader: { read: true } } },
      home: 'people',
      views: { people: { kind: 'list', from: 'person' }, teams: { kind: 'list', from: 'team' } },
      api: { version: 1, roles: ['reader'], resources: { person: { fields: ['id', 'name'] }, team: { fields: ['id', 'name'] } } },
    },
    'openapi',
  );
  const table = (id: string) => ({
    id,
    name: id,
    schema: '',
    isView: false,
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
      { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
    ],
  });
  const catalog: DatabaseSchema = {
    label: 'Logical',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [table('person'), table('team')],
  };
  const { paths } = renderApiReadOpenApi(definition, catalog, { integers: 'number' }).document as unknown as {
    paths: Record<string, { get: Record<string, unknown> }>;
  };
  const operations = Object.values(paths).map((path) => path.get);
  const person = operations.filter(
    (operation) => String(operation.summary).includes('person') || String(operation.summary).includes('people'),
  );
  const team = operations.filter((operation) => String(operation.summary).includes('team'));
  assert.ok(person.length && team.length, JSON.stringify(Object.keys(paths)));
  assert.ok(person.every((operation) => operation['x-mistri-read-audit'] === true && /503/.test(String(operation.description))));
  assert.ok(team.every((operation) => operation['x-mistri-read-audit'] === undefined));
});
