import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { AppRowPolicyDefinitionError } from '../packages/mistri/src/server/policy/appRowPolicy.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { setFirstPaintBudget } from '../packages/engine/src/server/http/firstPaint.js';
import { parseAppConfig, type AppDef } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';

const appId = 'row-policy-http';
const owner = 'private-http-operations';
const archiveOwner = 'private-http-archive';
const hidden = 'HIDDEN_HTTP_ROW_SENTINEL';
const secret = 'PRIVATE_HTTP_FIELD_SENTINEL';
const failure = 'postgres://private-user:private-password@private-host/physical_ticket';
const account: Identity = { id: 'desk-one', who: 'reader@example.test', role: 'reader' };
const equal = (column: string, value: string | number) => ({ groups: [[{ column, op: '=', value }]] });
const confidential =
  /HIDDEN_HTTP_ROW_SENTINEL|PRIVATE_HTTP_FIELD_SENTINEL|private-http-|private-password|private-host|(?:postgres(?:ql)?|sqlite):\/\/|tablewalk-row-policy-http-/;
const relationIdentifiers = new Set(['physical_note_fk_0', 'physical_note_fk_1', 'physical_ticket_fk_0']);

function privateFree(value: unknown, location = 'response'): void {
  assert.doesNotMatch(JSON.stringify(value), confidential);
  assert.doesNotMatch(JSON.stringify(value), /physical_/, `Physical identifier at ${location}`);
}

function publicData(value: unknown, path: string[] = []): void {
  if (!value || typeof value !== 'object') {
    // Constraint identities and paths built from them are public API addresses.
    // Exempt only declared, complete FK tokens at these exact relation fields;
    // physical table IDs, credentials and record values remain forbidden.
    if (
      /^(?:foreignKeys\.\d+\.name|references\.\d+\.constraint|(?:references\.\d+\.)?relations\.\d+\.(?:path|aliases\.\d+)|page\.sections\.\d+\.path)$/.test(
        path.join('.'),
      )
    ) {
      assert.equal(typeof value, 'string');
      privateFree(
        (value as string)
          .split('.')
          .map((token) => (relationIdentifiers.has(token) ? 'declared-fk' : token))
          .join('.'),
        path.join('.'),
      );
    } else privateFree(value, path.join('.'));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['sql', 'explain', 'params', 'stack', 'cause'].includes(key), `Private diagnostic key: ${key}`);
    privateFree(key);
    publicData(child, [...path, key]);
  }
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-row-policy-http-'));
  const registry = new Registry();
  const databases: DatabaseSync[] = [];
  const policies: HttpAppPolicy[] = [];
  const servers: Server[] = [];
  t.after(async () => {
    try {
      for (const server of servers) {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await closed;
      }
      // Deployment leases must drain before registry shutdown can close SQLite.
      for (const policy of policies) await policy.retire();
      await registry.closeAll();
    } finally {
      for (const db of databases) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  // The registry's active source deliberately differs from the App default.
  for (const connection of [archiveOwner, owner]) {
    const file = join(directory, `${connection}.db`);
    const db = new DatabaseSync(file);
    databases.push(db);
    db.exec(`
      CREATE TABLE physical_desk (id INTEGER PRIMARY KEY, name TEXT, private_note TEXT);
      CREATE TABLE physical_ticket (id INTEGER PRIMARY KEY, desk_id INTEGER REFERENCES physical_desk(id),
        name TEXT, private_note TEXT);
      CREATE TABLE physical_note (id INTEGER PRIMARY KEY, desk_id INTEGER REFERENCES physical_desk(id),
        ticket_id INTEGER REFERENCES physical_ticket(id), body TEXT);
      CREATE TABLE physical_vault (id INTEGER PRIMARY KEY, name TEXT);
    `);
    const archive = connection === archiveOwner;
    const desk = db.prepare('INSERT INTO physical_desk VALUES (?, ?, ?)');
    desk.run(1, archive ? hidden : 'Visible desk', secret);
    desk.run(2, archive ? 'Archive desk' : hidden, secret);
    const ticket = db.prepare('INSERT INTO physical_ticket VALUES (?, ?, ?, ?)');
    ticket.run(1, 1, archive ? hidden : 'Visible ticket', secret);
    ticket.run(2, 2, archive ? 'Archive ticket A' : hidden, secret);
    ticket.run(3, 2, archive ? 'Archive ticket B' : hidden, secret);
    const note = db.prepare('INSERT INTO physical_note VALUES (?, ?, ?, ?)');
    note.run(1, 1, 1, 'Visible note');
    // A hidden child points at a visible parent: references must count only one.
    note.run(2, 2, 1, hidden);
    // The inverse boundary also matters: this readable child has a hidden root.
    note.run(3, 1, 2, 'Visible child of hidden ticket');
    db.prepare('INSERT INTO physical_vault VALUES (1, ?)').run(hidden);
    registry.add({ id: connection, name: connection, url: file, source: 'config', writable: true });
  }
  const granted = ['desk', 'ticket', 'note', 'archive.ticket'];
  const app = parseAppConfig(
    {
      id: appId,
      name: 'Row policy HTTP',
      track: 'receipts',
      sources: {
        operations: { connection: owner, default: true },
        archive: { connection: archiveOwner },
      },
      // The vault is declared and never granted: no role reads it.
      resources: {
        desk: { physical: 'physical_desk', fields: { read: ['id', 'name'] } },
        ticket: { physical: 'physical_ticket', fields: { read: ['id', 'desk_id', 'name'] } },
        note: { physical: 'physical_note' },
        vault: { physical: 'physical_vault' },
        'archive.ticket': { physical: 'physical_ticket', fields: { read: ['id', 'desk_id', 'name'] } },
      },
      auth: { rows: 'policy', roles: { reader: { read: granted }, auditor: { read: granted } } },
      views: {
        ticket: { kind: 'list', from: 'ticket' },
        'archive-ticket': { kind: 'list', from: 'archive.ticket' },
        vault: { kind: 'list', from: 'vault' },
      },
      home: 'ticket',
      nav: ['ticket', 'archive-ticket', 'vault'],
    },
    'row policy HTTP fixture',
  );
  const pages = parsePagesConfig(
    {
      pages: [
        {
          label: 'Ticket',
          base: 'ticket',
          sections: [
            { kind: 'fields', show: ['name'] },
            { kind: 'list', from: 'note', whose: 'ticket_id', show: ['body'] },
          ],
        },
        { label: 'Hidden vault', base: 'vault' },
        { label: 'Hidden field', base: 'ticket', sections: [{ kind: 'fields', show: ['private_note'] }] },
      ],
    },
    'row policy HTTP pages',
  );
  const control = {
    identity: { ...account } as Identity | null,
    policyIdentity: undefined as Identity | null | undefined,
    authCalls: 0,
    policyCalls: 0,
    authHandlers: 0,
  };
  const verifySession = async (_request: IncomingMessage) => {
    control.policyCalls++;
    return control.policyIdentity === undefined ? control.identity : control.policyIdentity;
  };
  const host: AppHost = {
    app: { path: join(directory, 'app.ts'), app, pages, sources: {} },
    pages,
    auth: {
      spec: app.auth!,
      store: join(directory, 'sessions.db'),
      close: async () => {},
      session: async () => {
        control.authCalls++;
        return control.identity;
      },
      handler: async (_req, res) => {
        control.authHandlers++;
        res.writeHead(204);
        res.end();
      },
    },
  };
  let moduleNumber = 0;
  const moduleFile = (source: string) => {
    const file = join(directory, `policy-${moduleNumber++}.mjs`);
    writeFileSync(file, source);
    return file;
  };
  const file = moduleFile(`export default {
    appId: ${JSON.stringify(appId)},
    resolveRows(principal) {
      if (principal.id === 'policy-failure') throw new Error(${JSON.stringify(failure)});
      if (principal.id === 'invalid-scope') return { ticket: { groups: 'invalid' } };
      const desk = principal.id === 'desk-two' ? 2 : 1;
      const eq = (column, value) => ({ groups: [[{ column, op: '=', value }]] });
      return { desk: eq('id', desk), ticket: eq('desk_id', desk), note: eq('desk_id', desk),
        'archive.ticket': eq('desk_id', 2) };
    }
  };`);
  const load = async (overrides: Partial<Parameters<typeof loadHttpAppPolicy>[0]> = {}) => {
    const policy = await loadHttpAppPolicy({ app, registry, file, verifySession, ...overrides });
    policies.push(policy);
    return policy;
  };
  let pageAt = async (_path: string): Promise<{ status: number; headers: Headers; html: string }> => {
    throw new Error('Not started.');
  };
  const start = async (policy: HttpAppPolicy) => {
    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, apps: [host], policy, pages, bound });
    servers.push(server);
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    /* A page, as a browser asks for it: no selector added, the HTML as sent. */
    pageAt = async (path: string) => {
      const response = await fetch(`http://${bound.host}:${bound.port}${path}`, { signal: AbortSignal.timeout(45_000) });
      return { status: response.status, headers: response.headers, html: await response.text() };
    };
    return async (path: string, body?: object, options: { headers?: Record<string, string>; method?: string } = {}) => {
      const url = new URL(path, `http://${bound.host}:${bound.port}`);
      if (!url.searchParams.has('app')) url.searchParams.set('app', appId);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(3000),
        method: options.method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { 'Content-Type': 'application/json', ...options.headers },
        ...(body === undefined ? {} : { body: JSON.stringify({ app: appId, ...body }) }),
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
    };
  };
  return {
    app,
    host,
    registry,
    databases,
    control,
    file,
    directory,
    verifySession,
    moduleFile,
    load,
    start,
    page: (path: string) => pageAt(path),
  };
}

type Call = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['start']>>;
async function read(call: Call, path: string, body?: object) {
  const result = await call(path, body);
  assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`);
  assert.ok(!result.body.errors?.length, `${path}: ${JSON.stringify(result.body)}`);
  assert.equal(result.headers.get('cache-control'), 'no-store', path);
  assert.equal(result.headers.get('x-mistri-account'), account.id, path);
  publicData(result.body);
  return result.body;
}

test('row-policy HTTP startup requires exactly one matching authenticated App and deployment', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const policy = await f.load();
  const options = { registry: f.registry, apps: [f.host], policy, bound: { host: '127.0.0.1', port: 0 } };
  assert.equal(policy.appId, appId);
  assert.equal(policy.matches(f.app), true, 'The exact parsed App used to load the deployment must match');
  assert.equal(policy.matches(structuredClone(f.app)), true);
  for (const invalid of [
    { ...options, policy: undefined },
    { ...options, apps: [] },
    { ...options, apps: [f.host, f.host] },
    { ...options, apps: [{ ...f.host, auth: undefined }] },
    { ...options, apps: [{ ...f.host, app: { ...f.host.app, app: { ...f.app, name: 'Changed' } } }] },
  ])
    assert.throws(() => createApp(invalid), /policy|deployment|authenticated/i);
  assert.equal(f.control.authCalls + f.control.policyCalls, 0);
});

test(
  'row-policy HTTP deployment rejects legacy writes, grants outside ceilings and commands without a registry',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const policy = await f.load();
    const variants: AppDef[] = [
      { ...f.app, auth: { ...f.app.auth!, roles: { reader: { read: true, write: ['ticket'] } } } },
      { ...f.app, auth: { ...f.app.auth!, roles: { reader: { read: true, write: false, commands: ['assign'] } } } },
    ];
    for (const app of variants) {
      await assert.rejects(() => f.load({ app }), AppRowPolicyDefinitionError);
      assert.throws(() =>
        createApp({
          registry: f.registry,
          policy,
          apps: [{ ...f.host, app: { ...f.host.app, app } }],
          bound: { host: '127.0.0.1', port: 0 },
        }),
      );
    }
    const ceilingOnly: AppDef = { ...f.app, resources: { ...f.app.resources, ticket: { ...f.app.resources!.ticket, access: 'write' } } };
    assert.equal(
      (await f.load({ app: ceilingOnly })).matches(ceilingOnly),
      true,
      'a root write ceiling without role grants is valid enrollment',
    );
  },
);

test('row-policy HTTP loader refuses missing, invalid and mismatched local default modules privately', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  for (const file of [
    '',
    join(f.directory, 'missing.mjs'),
    f.moduleFile('export const resolveRows = () => ({});'),
    f.moduleFile('export default { appId: "wrong-app", resolveRows: () => ({}) };'),
    f.moduleFile('export default { appId: "row-policy-http", resolveRows: true };'),
    f.moduleFile(`throw new Error(${JSON.stringify(failure)});`),
    f.moduleFile('export default { invalid syntax'),
  ])
    await assert.rejects(
      () => f.load({ file }),
      (error) => {
        assert.ok(error instanceof AppRowPolicyDefinitionError);
        assert.equal(error.cause, undefined);
        privateFree({ message: error.message, stack: error.stack });
        assert.ok(!error.message.includes(f.directory));
        return true;
      },
    );
});

test('row-policy HTTP metadata is field-pruned, row-scoped and verified for every request', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const call = await f.start(await f.load());
  const schema = await read(call, '/api/schema');
  assert.deepEqual(schema.tables.map((table: { id: string }) => table.id).sort(), ['archive.ticket', 'desk', 'note', 'ticket']);
  assert.deepEqual(schema.foreignKeys.map((fk: { name: string }) => fk.name).sort(), [...relationIdentifiers].sort());
  assert.doesNotMatch(JSON.stringify(schema), /private_note|vault/);
  const app = await read(call, '/api/app');
  assert.deepEqual(app.app.writableTables, []);
  assert.deepEqual(app.app.grantedCommands, []);
  const runtime = await read(call, '/api/runtime');
  assert.equal(runtime.apps[0].writable, false, 'Writable SQLite bindings alone cannot advertise policy writes');
  for (const path of [
    '/api/whoami',
    '/api/views',
    '/api/pages',
    '/api/pages/relations?table=ticket',
    '/api/pages/suggested?table=ticket',
    '/api/layouts',
    '/api/pages/saved',
    '/api/filters',
  ]) {
    const before = [f.control.authCalls, f.control.policyCalls];
    const body = await read(call, path);
    assert.doesNotMatch(JSON.stringify(body), /private_note|vault|Hidden field/);
    assert.deepEqual(
      [f.control.authCalls, f.control.policyCalls],
      before.map((n) => n + 1),
      path,
    );
  }
  // Rows scoped by a policy: nothing to keep saved views in, and nothing offered.
  const saved = await read(call, '/api/filters');
  assert.equal(saved.store, 'none');
  assert.deepEqual(saved.filters, {});
});

test('row-policy HTTP query, run, view and exact counts agree across aliases and named sources', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const call = await f.start(await f.load());
  const query = await read(call, '/api/query', { table: 'ticket' });
  assert.deepEqual(query.rows, [{ id: 1, desk_id: 1, name: 'Visible ticket' }]);
  const run = await read(call, '/api/run', { q: 'ticket show id, name', exactCount: true });
  assert.deepEqual(run.rows, [{ id: 1, name: 'Visible ticket' }]);
  assert.equal(run.total, 1);
  const view = await read(call, '/api/view/run', { text: 'ticket show id, name, desk_id.name' });
  assert.deepEqual(view.rows, [{ id: 1, name: 'Visible ticket', 'desk_id.name': 'Visible desk' }]);
  assert.equal(view.total, 1);
  const archive = await read(call, '/api/run', { q: 'archive.ticket show id, name sort id asc' });
  assert.deepEqual(archive.rows, [
    { id: 2, name: 'Archive ticket A' },
    { id: 3, name: 'Archive ticket B' },
  ]);
  assert.equal(archive.total, 2);
  for (const [table, count] of [
    ['ticket', 1],
    ['archive.ticket', 2],
  ] as const) {
    for (const exactCount of [false, true]) {
      const result = await read(call, '/api/count', { table, exactCount });
      assert.equal(result.count, count);
      assert.equal(result.exact, true);
    }
  }
  const groups = await read(call, '/api/breakdown', {
    def: {
      base: 'ticket',
      by: [{ path: 'desk_id', alias: 'desk' }],
      measures: [{ fn: 'count', alias: 'tickets' }],
    },
  });
  assert.deepEqual(groups.rows, [{ desk: 1, tickets: 1 }]);
  assert.equal(groups.total, 1);
  assert.equal(f.control.authCalls, f.control.policyCalls);
});

test('row-policy HTTP runtime and whoami reject connection and foreign App query selectors', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const call = await f.start(await f.load());
  for (const endpoint of ['/api/runtime', '/api/whoami', '/api/schema', '/api/app']) {
    for (const selector of [`conn=${owner}`, `conn=${archiveOwner}`, 'app=other-app']) {
      const result = await call(`${endpoint}?${selector}`);
      assert.equal(result.status, 400, `${endpoint}?${selector}: ${JSON.stringify(result.body)}`);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      publicData(result.body);
    }
  }
  assert.equal(f.control.policyCalls, 0, 'Invalid selectors must not acquire policy contexts');
});

test('row-policy HTTP detail, planned child lists and references never include hidden rows or counts', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const call = await f.start(await f.load());
  for (const id of [2, 999]) {
    const detail = await read(call, '/api/query', { table: 'ticket', filter: equal('id', id), limit: 1 });
    assert.deepEqual(detail.rows, []);
    assert.equal((await read(call, '/api/count', { table: 'ticket', filter: equal('id', id) })).count, 0);
  }
  const refs = await read(call, '/api/references', { table: 'ticket', key: { id: 1 } });
  assert.deepEqual(
    refs.references.map((ref: { table: string; count: number }) => [ref.table, ref.count]),
    [['note', 1]],
  );
  const schema = await read(call, '/api/schema');
  const relation = schema.foreignKeys.find(
    (fk: { from: { table: string }; to: { table: string } }) => fk.from.table === 'note' && fk.to.table === 'ticket',
  );
  assert.ok(relation);
  assert.equal(refs.references[0].constraint, relation.name);
  assert.deepEqual(refs.references[0].columns, relation.from.columns);
  assert.deepEqual(refs.references[0].toColumns, relation.to.columns);
  const relations = await read(call, '/api/pages/relations?table=ticket');
  const childRelation = relations.relations.find((entry: { from: string }) => entry.from === 'note');
  assert.equal(childRelation.path, relation.from.columns.join('+'));
  assert.ok(childRelation.aliases.includes(relation.name));
  const suggested = await read(call, '/api/pages/suggested?table=ticket');
  assert.equal(suggested.page.sections.find((section: { from?: string }) => section.from === 'note').path, relation.from.columns.join('+'));
  const plan = await read(call, '/api/pages/plan', { page: f.host.pages[0].id, key: { id: 1 } });
  const child = plan.plans.find((entry: { kind: string }) => entry.kind === 'list');
  assert.ok(child?.view);
  assert.ok(!child.error);
  const notes = await read(call, '/api/view/run', { view: child.view });
  assert.equal(notes.total, 1);
  assert.equal(notes.rows.length, 1);
  assert.ok(JSON.stringify(notes.rows).includes('Visible note'));
});

test(
  'row-policy HTTP composes a record page in one policy context, each part as its own request answers it',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const call = await f.start(await f.load());
    const page = f.host.pages[0].id;
    const composed = await read(call, '/api/pages/compose', { page, key: { id: 1 } });
    assert.equal(composed.planned, true);
    const plan = await read(call, '/api/pages/plan', { page, key: { id: 1 } });
    assert.deepEqual(composed.plans, plan.plans);
    assert.ok(composed.reads.length > 0);
    const timeless = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(timeless)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .filter(([key]) => key !== 'ms')
                .map(([key, item]) => [key, timeless(item)]),
            )
          : value;
    for (const part of composed.reads) assert.deepEqual(timeless(part.reply), timeless(await read(call, part.path, part.body)), part.path);
    assert.ok(JSON.stringify(composed.reads).includes('Visible note'));
    // A record outside the principal's rows composes nothing of it.
    const outside = await call('/api/pages/compose', { page, key: { id: 2 } });
    assert.equal(outside.status, 200);
    publicData(outside.body);
    assert.deepEqual(outside.body, { planned: false });
  },
);

test(
  'row-policy HTTP first page carries each read as its own request answers it, one policy context each',
  { timeout: 120_000 },
  async (t) => {
    setFirstPaintBudget(30_000);
    t.after(() => setFirstPaintBudget(1500));
    const f = await fixture(t);
    const call = await f.start(await f.load());
    for (const path of ['/ticket', '/ticket/1']) {
      const served = await f.page(path);
      assert.equal(served.status, 200, path);
      // Never kept: every row-policy reply is `no-store`, and so is a page that carries one.
      assert.match(served.headers.get('cache-control') ?? '', /no-store/);
      const block = /<script type="application\/json" id="mistri-first-paint">([\s\S]*?)<\/script>/.exec(served.html);
      assert.ok(block, path);
      const data = JSON.parse(block[1]) as { reads: Record<string, { body: unknown; account?: string }>; items: Record<string, unknown> };
      const asked = Object.keys(data.reads).map((key) => key.split('\u0000')[0].split(' ')[1].split('?')[0]);
      assert.ok(
        asked.includes('/api/app') &&
          asked.includes('/api/schema') &&
          asked.includes(path === '/ticket' ? '/api/run' : '/api/pages/compose'),
        `${path}: ${asked}`,
      );
      const timeless = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(timeless)
          : value && typeof value === 'object'
            ? Object.fromEntries(
                Object.entries(value)
                  .filter(([key]) => key !== 'ms')
                  .map(([key, item]) => [key, timeless(item)]),
              )
            : value;
      for (const [key, read] of Object.entries(data.reads)) {
        const [head, payload] = key.split('\u0000');
        const url = head.split(' ')[1];
        const alone = await call(url, payload ? JSON.parse(payload) : undefined);
        assert.equal(alone.status, 200, key);
        assert.deepEqual(timeless(read.body), timeless(alone.body), key);
        assert.equal(read.account ?? null, alone.headers.get('x-mistri-account'), key);
        publicData(read.body);
      }
      assert.doesNotMatch(served.html, confidential, path);
      assert.ok(!served.html.includes(hidden), `${path}: a row outside the principal's rows is never carried`);
    }
    assert.ok((await f.page('/ticket')).html.includes('Visible ticket'));
  },
);

test(
  'row-policy HTTP batched tab counts, bounded totals and revalidation stay inside the principal scope',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const call = await f.start(await f.load());
    /* One batch across tables and sources: each is counted under the scope,
     never as one statement over the physical tables (the scoped reader has
     no countEach, so readCounts counts each under its own CTE). */
    const counts = await read(call, '/api/counts', {
      items: ['ticket', 'note', 'archive.ticket', 'note body = "Visible note"', 'ticket id = 2'],
    });
    assert.deepEqual(
      counts.results.map((result: { total: number }) => result.total),
      [1, 2, 2, 1, 0],
    );
    // A hidden field is no more a count filter than a list filter.
    const hiddenField = await read(call, '/api/counts', { items: [`ticket private_note = "${secret}"`] });
    assert.equal(hiddenField.results[0].total, undefined);
    assert.ok(hiddenField.results[0].errors?.length);
    // A filtered total defaults to a bound and still counts only scoped rows.
    const run = await read(call, '/api/run', { q: 'note ticket_id = 1' });
    assert.equal(run.total, 1);
    // Row-scoped metadata is never stored, so it carries no validator a cache could reuse.
    for (const path of ['/api/schema', '/api/app', '/api/pages', '/api/runtime']) {
      const result = await call(path);
      assert.equal(result.headers.get('cache-control'), 'no-store', path);
      assert.equal(result.headers.get('etag'), null, path);
    }
    // A stream cannot wait for the policy to settle: the export is refused, not unscoped.
    const exported = await call('/api/export', { q: 'ticket' });
    assert.equal(exported.status, 403);
    assert.equal(exported.headers.get('cache-control'), 'no-store');
    publicData(exported.body);
  },
);

for (const endpoint of ['/api/references', '/api/pages/plan']) {
  test(`row-policy HTTP ${endpoint} refuses a hidden parent even when its child is readable`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    const call = await f.start(await f.load());
    const child = await read(call, '/api/query', { table: 'note', filter: equal('id', 3) });
    assert.deepEqual(child.rows, [{ id: 3, desk_id: 1, ticket_id: 2, body: 'Visible child of hidden ticket' }]);
    assert.equal((await read(call, '/api/count', { table: 'note', filter: equal('ticket_id', 2) })).count, 1);
    assert.deepEqual((await read(call, '/api/query', { table: 'ticket', filter: equal('id', 2) })).rows, []);
    const results = [];
    for (const id of [2, 999]) {
      const result = await call(
        endpoint,
        endpoint === '/api/references' ? { table: 'ticket', key: { id } } : { page: f.host.pages[0].id, key: { id } },
      );
      assert.equal(result.status, 403, `${endpoint} must check root visibility: ${JSON.stringify(result.body)}`);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.equal(result.body.references, undefined);
      assert.equal(result.body.plans, undefined);
      publicData(result.body);
      results.push({ status: result.status, body: result.body });
    }
    assert.deepEqual(results[0], results[1], 'A hidden parent must be indistinguishable from a missing parent');
    for (const key of [
      undefined,
      null,
      {},
      [],
      { ticket_id: 1 },
      { id: null },
      { id: true },
      { id: [1] },
      { id: { value: 1 } },
      { id: 1, desk_id: 1 },
      { id: 1, private_note: 'probe' },
    ]) {
      const result = await call(endpoint, endpoint === '/api/references' ? { table: 'ticket', key } : { page: f.host.pages[0].id, key });
      assert.ok([400, 403].includes(result.status), `${endpoint} must require exactly the primary key: ${JSON.stringify(key)}`);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.equal(result.body.references, undefined);
      assert.equal(result.body.plans, undefined);
      publicData(result.body);
    }
    if (endpoint === '/api/pages/plan') {
      const inline = await call(endpoint, { page: f.host.pages[0], key: { id: 2 } });
      assert.equal(inline.status, 403, 'Inline pages must authorize the same root as named pages');
      assert.deepEqual(inline.body, results[0].body);
    }
  });
}

test(
  'row-policy HTTP similar lists match the record’s own values and still read only the principal’s rows',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    // The visible ticket's twin on the hidden desk, and one on the visible desk.
    const ticket = f.databases[1].prepare('INSERT INTO physical_ticket VALUES (?, ?, ?, ?)');
    ticket.run(4, 2, 'Visible ticket', secret);
    ticket.run(5, 1, 'Visible ticket', secret);
    const call = await f.start(await f.load());
    const like = (similar: object, id = 1) => ({
      page: {
        id: 'similar-ticket',
        name: 'Similar tickets',
        base: 'ticket',
        sections: [{ kind: 'list', from: 'ticket', path: '', similar, columns: ['id', 'name'] }],
      },
      key: { id },
    });
    const plan = await read(call, '/api/pages/plan', like({ same: ['name'] }));
    const view = plan.plans[0].view;
    assert.deepEqual(view.filter.groups, [
      [
        { path: 'name', op: '=', value: 'Visible ticket' },
        { path: 'id', op: '!=', value: 1 },
      ],
    ]);
    // The twin on the hidden desk shares the values and is still not the principal's to read.
    assert.deepEqual((await read(call, '/api/view/run', { view })).rows, [{ id: 5, name: 'Visible ticket' }]);
    // A hidden record plans nothing, and a hidden field is not a value to match on.
    const hidden = await call('/api/pages/plan', like({ same: ['name'] }, 2));
    assert.equal(hidden.status, 403, JSON.stringify(hidden.body));
    publicData(hidden.body);
    const field = await call('/api/pages/plan', like({ same: ['private_note'] }));
    assert.equal(field.status, 403, JSON.stringify(field.body));
    publicData(field.body);
  },
);

test(
  'row-policy HTTP hostile filters, hidden fields and forged role or source selectors cannot widen reads',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const call = await f.start(await f.load());
    const forged = {
      role: 'admin',
      roles: ['admin'],
      identity: { id: 'desk-two', role: 'admin' },
      rowPolicy: false,
      rows: { ticket: true },
      access: { read: true },
      writable: true,
    };
    const result = await read(call, '/api/query', {
      table: 'ticket',
      ...forged,
      filter: { groups: [...equal('desk_id', 2).groups, ...equal('id', 1).groups] },
    });
    assert.deepEqual(result.rows, [{ id: 1, desk_id: 1, name: 'Visible ticket' }]);
    assert.deepEqual((await read(call, '/api/query', { table: 'ticket', filter: equal('name', "' OR 1=1 --") })).rows, []);
    for (const [path, body] of [
      ['/api/query', { table: 'ticket', columns: ['private_note'] }],
      ['/api/query', { table: 'ticket', filter: equal('private_note', 'probe') }],
      ['/api/query', { table: 'ticket', orderBy: [{ column: 'private_note', direction: 'asc' }] }],
      ['/api/view/run', { text: 'ticket show desk_id.private_note' }],
      ['/api/breakdown', { text: 'ticket count by private_note' }],
      ['/api/query', { table: 'vault' }],
      ['/api/count', { table: 'vault' }],
      ['/api/references', { table: 'vault', key: { id: 1 } }],
      ['/api/query', { table: 'physical_ticket' }],
      ['/api/query', { table: 'ticket', conn: archiveOwner }],
      ['/api/query', { table: 'ticket', app: 'other-app' }],
    ] as const) {
      const denied = await call(path, { ...body, ...forged });
      assert.ok(denied.status >= 400 || denied.body.errors?.length, `${path}: ${JSON.stringify(denied.body)}`);
      assert.ok(!denied.body.rows?.length);
      assert.equal(denied.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(JSON.stringify(denied.body), /HIDDEN_HTTP_ROW_SENTINEL|PRIVATE_HTTP_FIELD_SENTINEL/);
    }
    f.control.identity = { ...account, role: 'unknown' };
    const denied = await call('/api/query', { table: 'ticket', ...forged }, { headers: { 'x-mistri-role': 'reader' } });
    assert.equal(denied.status, 403);
    publicData(denied.body);
  },
);

test('row-policy HTTP without write grants refuses mutations and unsupported API routes', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const call = await f.start(await f.load());
  const before = f.databases.map((db) => db.prepare('SELECT * FROM physical_ticket ORDER BY id').all());
  // An App has no Undo: /api/revert answers that, whatever the grants (scopedWrites.ts).
  assert.equal((await call('/api/revert', { confirm: true, expectedId: 1 })).status, 404);
  for (const path of [
    '/api/insert',
    '/api/update',
    '/api/delete',
    '/api/undo',
    '/api/undo/prepare',
    '/api/commands/prepare',
    '/api/commands/execute',
    '/api/commands/status',
    '/api/sql',
    '/api/view/compile',
    '/api/connections',
    '/api/connections/test',
    '/api/agent',
    '/api/agent/call',
    '/api/filters',
    '/api/filters/save',
    '/api/new-endpoint',
  ]) {
    const result = await call(path, {
      table: 'ticket',
      key: { id: 1 },
      values: { name: 'Forbidden' },
      command: 'assign',
      text: "UPDATE physical_ticket SET name = 'Forbidden'",
      writable: true,
    });
    assert.equal(result.status, 403, `${path}: ${JSON.stringify(result.body)}`);
    assert.equal(result.headers.get('cache-control'), 'no-store', path);
    publicData(result.body);
  }
  for (const path of ['/api/connections', '/api/agent/tools', '/api/ddl?table=ticket', '/api/history', '/api/queries']) {
    const result = await call(path);
    assert.equal(result.status, 403, path);
    assert.equal(result.headers.get('cache-control'), 'no-store', path);
    publicData(result.body);
  }
  assert.deepEqual(
    f.databases.map((db) => db.prepare('SELECT * FROM physical_ticket ORDER BY id').all()),
    before,
  );
});

test('row-policy HTTP rejects stale accounts and unauthenticated requests before data access', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const call = await f.start(await f.load());
  const stale = await call('/api/query', { table: 'ticket' }, { headers: { 'x-mistri-account': 'desk-two' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.headers.get('cache-control'), 'no-store');
  assert.equal(f.control.policyCalls, 0);
  publicData(stale.body);
  f.control.identity = null;
  const anonymous = await call('/api/query', { table: 'ticket', identity: account, role: 'reader' });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('cache-control'), 'no-store');
  assert.equal(f.control.policyCalls, 0);
  publicData(anonymous.body);
  const auth = await call('/api/auth/get-session');
  assert.equal(auth.status, 204);
  assert.equal(f.control.authHandlers, 1);
  assert.equal(f.control.policyCalls, 0);
});

test('row-policy HTTP checks both verified account and normalized roles before dispatch', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const call = await f.start(await f.load());
  for (const identity of [null, { ...account, id: 'desk-two' }, { ...account, role: 'auditor' }]) {
    f.control.policyIdentity = identity;
    const denied = await call('/api/query', { table: 'ticket' });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('cache-control'), 'no-store');
    publicData(denied.body);
  }
  f.control.identity = { ...account, role: 'reader, auditor,reader' };
  f.control.policyIdentity = { ...account, role: 'auditor,reader' };
  assert.deepEqual((await read(call, '/api/query', { table: 'ticket' })).rows, [{ id: 1, desk_id: 1, name: 'Visible ticket' }]);
  assert.equal(f.control.authCalls, 4);
  assert.equal(f.control.policyCalls, 4);
});

test('row-policy HTTP resolver exceptions and invalid scopes stay private and fail closed', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const call = await f.start(await f.load());
  for (const id of ['policy-failure', 'invalid-scope']) {
    f.control.identity = { ...account, id };
    for (const [path, body] of [
      ['/api/query', { table: 'ticket' }],
      ['/api/count', { table: 'ticket' }],
      ['/api/schema', undefined],
    ] as const) {
      const result = await call(path, body);
      assert.ok((id === 'invalid-scope' ? [400, 403] : [403]).includes(result.status), `${path}: ${JSON.stringify(result.body)}`);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      publicData(result.body);
      assert.ok(!JSON.stringify(result.body).includes(f.directory));
    }
  }
  f.control.identity = account;
  assert.equal((await read(call, '/api/count', { table: 'ticket' })).count, 1);
});

test('row-policy HTTP changed Apps and retired deployments return 503 without reusing captured access', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const policy = await f.load();
  const call = await f.start(policy);
  f.host.app.app = { ...f.app, name: 'Changed after startup' };
  assert.equal(policy.matches(f.host.app.app), false);
  for (const path of ['/api/query', '/api/count']) {
    const result = await call(path, { table: 'ticket' });
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    publicData(result.body);
  }
  assert.equal(f.control.policyCalls, 0);
  f.host.app.app = f.app;
  assert.equal((await read(call, '/api/count', { table: 'ticket' })).count, 1);
  await policy.retire();
  assert.equal(policy.matches(f.app), false);
  const retired = await call('/api/schema');
  assert.equal(retired.status, 503);
  publicData(retired.body);
  assert.equal(f.control.policyCalls, 1);
});
