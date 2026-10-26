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
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { deleteImpact } from '../packages/engine/src/server/impact.js';
import { appError } from '../packages/mistri/src/server/app/appErrors.js';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';

const appId = 'field-policy';
const owner = 'private-fields';
const secret = 'HIDDEN_VALUE_SENTINEL';
async function fixture(
  run: (f: {
    call: (path: string, body?: object) => Promise<{ status: number; body: any }>;
    db: DatabaseSync;
    host: AppHost;
    role: (role: string) => void;
    base: string;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-field-http-'));
  const file = join(directory, 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE lead (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'new', private_note TEXT DEFAULT '${secret}');
    CREATE TABLE activity (id INTEGER PRIMARY KEY, lead_id INTEGER REFERENCES lead(id), detail TEXT);
    INSERT INTO lead (id,name) VALUES (1,'First lead'); INSERT INTO activity VALUES (1,1,'Called');`);
  const registry = new Registry();
  registry.add({ id: owner, name: 'Private fields', url: file, source: 'config', writable: true });
  const definition = parseAppConfig(
    {
      id: appId,
      name: 'Field Policy',
      connection: owner,
      resources: {
        lead: {
          access: 'write',
          actions: {
            rename: { label: 'Rename', set: { name: 'Renamed' } },
            close: { label: 'Close', set: { status: 'closed' } },
            private: { label: 'Private', set: { private_note: secret } },
          },
        },
        activity: {},
      },
      auth: {
        roles: {
          operator: { read: true, write: true, fields: { lead: { read: ['id', 'name', 'status'], write: ['name'] } } },
          admin: { read: true, write: true },
        },
      },
      views: { leads: { kind: 'list', from: 'lead', label: 'Leads' } },
      home: 'leads',
      nav: ['leads'],
    },
    'fields fixture',
  );
  const pages = parsePagesConfig(
    {
      pages: [
        { label: 'Lead', base: 'lead', sections: [{ kind: 'fields', show: ['name'] }] },
        { label: 'Sensitive', base: 'lead', sections: [{ kind: 'fields', show: ['private_note'] }] },
        {
          label: 'Sensitive activity',
          base: 'lead',
          sections: [{ kind: 'list', from: 'activity', whose: 'lead_id', query: `lead_id.private_note = ${secret}` }],
        },
      ],
    },
    'fields pages',
  );
  let currentRole = 'operator';
  const host: AppHost = {
    app: { path: 'field-fixture.ts', app: definition, pages, sources: {} },
    pages,
    auth: {
      spec: definition.auth!,
      store: 'not-used',
      handler: async () => {},
      close: async () => {},
      session: async () => ({ id: 'same-account', who: 'person@example.test', role: currentRole }),
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  try {
    await run({
      db,
      host,
      base: `http://${bound.host}:${bound.port}`,
      role: (role) => {
        currentRole = role;
      },
      call: async (path, body) => {
        const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
          signal: AbortSignal.timeout(5000),
          headers: { 'Content-Type': 'application/json' },
          ...(body ? { method: 'POST', body: JSON.stringify({ app: appId, ...body }) } : {}),
        });
        return { status: response.status, body: await response.json() };
      },
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal(owner);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const privateFree = (value: unknown) => assert.doesNotMatch(JSON.stringify(value), /private_note|HIDDEN_VALUE_SENTINEL/);

test('App delete-impact errors are sanitized without treating a failed count as zero', async () => {
  const failure = new Error(secret);
  const adapter = {
    count: async () => {
      throw failure;
    },
  } as unknown as Adapter;
  const result = await deleteImpact(
    adapter,
    {
      label: '',
      dialect: 'sqlite',
      readAt: '',
      tables: [],
      foreignKeys: [{ name: 'activity_lead', from: { table: 'activity', columns: ['lead_id'] }, to: { table: 'lead', columns: ['id'] } }],
    },
    'lead',
    { id: 1 },
    (error) => appError(error, 'read').message,
  );
  assert.equal(result[0].count, -1);
  assert.doesNotMatch(JSON.stringify(result), /HIDDEN_VALUE_SENTINEL/);
});

test('field HTTP metadata removes hidden definitions and projects write affordances per role', async () => {
  await fixture(async ({ call, role }) => {
    const schema = await call('/api/schema');
    privateFree(schema.body);
    const lead = schema.body.tables.find((table: { id: string }) => table.id === 'lead');
    assert.deepEqual(
      lead.columns.map((column: { name: string; writable: boolean }) => [column.name, column.writable]),
      [
        ['id', false],
        ['name', true],
        ['status', false],
      ],
    );
    const app = await call('/api/app');
    privateFree(app.body);
    assert.deepEqual(
      app.body.app.resources.lead.actions.map((action: { label: string }) => action.label),
      ['Rename'],
    );
    const pages = await call('/api/pages');
    privateFree(pages.body);
    assert.deepEqual(
      pages.body.pages.map((page: { name: string }) => page.name),
      ['Lead'],
    );
    role('admin');
    const admin = await call('/api/app');
    assert.equal(admin.body.app.resources.lead.actions.length, 3);
    role('operator');
    privateFree((await call('/api/app')).body);
  });
});

test('field HTTP reads narrow defaults and refuse hidden projections, filters, sorts and relationship walks', async () => {
  await fixture(async ({ call }) => {
    const read = await call('/api/query', { table: 'lead' });
    assert.equal(read.status, 200);
    privateFree(read.body);
    assert.deepEqual(read.body.rows, [{ id: 1, name: 'First lead', status: 'new' }]);
    for (const body of [
      { columns: ['private_note'] },
      { filter: { groups: [[{ column: 'private_note', op: '=', value: secret }]] } },
      { orderBy: [{ column: 'private_note', direction: 'asc' }] },
    ])
      assert.ok([400, 403].includes((await call('/api/query', { table: 'lead', ...body })).status));
    for (const body of [
      { base: 'lead', columns: [{ path: 'private_note' }] },
      { base: 'activity', columns: [{ path: 'lead_id.private_note' }] },
    ]) {
      const result = await call('/api/view/run', { view: { id: 'forged', name: 'Forged', ...body } });
      assert.ok(result.status >= 400 || result.body.errors?.length, JSON.stringify(result));
      assert.doesNotMatch(JSON.stringify(result.body), /HIDDEN_VALUE_SENTINEL/);
    }
    const page = await call('/api/pages/plan', {
      key: { id: 1 },
      page: {
        id: 'forged',
        name: 'Forged',
        base: 'lead',
        source: 'saved',
        sections: [{ kind: 'fields', paths: ['private_note'] }],
      },
    });
    assert.equal(page.status, 403);
    privateFree(page.body);
  });
});

test('field HTTP writes protect readonly fields and project insert defaults', async () => {
  await fixture(async ({ call, db }) => {
    for (const values of [{ status: 'closed' }, { private_note: 'forged' }]) {
      assert.equal((await call('/api/update', { table: 'lead', key: { id: 1 }, values })).status, 403);
      assert.equal((await call('/api/insert', { table: 'lead', values: { name: 'Forbidden', ...values } })).status, 403);
    }
    const inserted = await call('/api/insert', { table: 'lead', values: { name: 'New lead' } });
    assert.equal(inserted.status, 200);
    privateFree(inserted.body);
    assert.equal(inserted.body.row.name, 'New lead');
    assert.equal(db.prepare('SELECT private_note FROM lead WHERE name=?').get('New lead')?.private_note, secret);
    assert.equal((await call('/api/delete', { table: 'lead', key: { id: 1 }, confirm: true })).status, 403);
    assert.ok(db.prepare('SELECT id FROM lead WHERE id=1').get());
    const saved = await call('/api/update', {
      table: 'lead',
      key: { id: 1 },
      values: { name: 'Changed' },
      expected: { name: 'First lead' },
    });
    assert.equal(saved.status, 200);
    assert.equal(db.prepare('SELECT name FROM lead WHERE id=1').get()?.name, 'Changed');
  });
});

test('field HTTP batched counts, the streamed export and revalidated metadata never reach a hidden field', async () => {
  await fixture(async ({ call, role, base }) => {
    const counts = await call('/api/counts', { items: ['lead', 'lead status = new', `lead private_note = ${secret}`] });
    assert.equal(counts.status, 200);
    assert.deepEqual(
      counts.body.results.slice(0, 2).map((result: { total: number }) => result.total),
      [1, 1],
    );
    /* A hidden field is no count filter: refused exactly as the list refuses
       it — the name the request itself sent, as a column that is not there. */
    const listed = await call('/api/run', { q: `lead private_note = ${secret}` });
    assert.equal(counts.body.results[2].total, undefined);
    assert.deepEqual(counts.body.results[2].errors, listed.body.errors);
    assert.doesNotMatch(JSON.stringify(counts.body), /HIDDEN_VALUE_SENTINEL/);

    const exported = await fetchExport(base, { q: 'lead' });
    assert.equal(exported.status, 200);
    assert.match(exported.type, /^text\/csv/);
    assert.doesNotMatch(exported.text, /private_note|HIDDEN_VALUE_SENTINEL/);
    assert.match(exported.text, /^﻿id,name,status\r\n1,First lead,new\r\n$/);
    for (const body of [
      { q: 'lead', columns: ['private_note'] },
      { q: `lead private_note = ${secret}` },
      { q: 'lead show private_note' },
    ]) {
      const refused = await fetchExport(base, body);
      assert.ok(refused.status >= 400 || /"errors":\[\{/.test(refused.text), `${JSON.stringify(body)}: ${refused.status} ${refused.text}`);
      assert.doesNotMatch(refused.text, /HIDDEN_VALUE_SENTINEL/);
    }

    /* The same account in two roles sees two App payloads: one's validator
       must never answer the other's request with a 304. */
    const first = await revalidate(base, '/api/app');
    assert.equal(first.status, 200);
    assert.match(first.cacheControl ?? '', /private/);
    assert.match(first.vary ?? '', /Cookie/);
    assert.equal((await revalidate(base, '/api/app', first.etag!)).status, 304);
    role('admin');
    const admin = await revalidate(base, '/api/app', first.etag!);
    assert.equal(admin.status, 200, 'another principal is sent its own payload');
    assert.notEqual(admin.etag, first.etag);
    role('operator');
  });
});

/* The fixture's `call` parses JSON; an export is a file. */
async function fetchExport(base: string, body: object) {
  const response = await fetch(`${base}/api/export`, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' },
    body: JSON.stringify({ app: appId, ...body }),
  });
  // The BOM is part of the file; `text()` would strip it.
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await response.arrayBuffer());
  return { status: response.status, type: response.headers.get('content-type') ?? '', text };
}

async function revalidate(base: string, path: string, etag?: string) {
  const response = await fetch(`${base}${path}?app=${appId}`, {
    signal: AbortSignal.timeout(5000),
    headers: etag ? { 'If-None-Match': etag } : {},
  });
  await response.arrayBuffer();
  return {
    status: response.status,
    etag: response.headers.get('etag'),
    cacheControl: response.headers.get('cache-control'),
    vary: response.headers.get('vary'),
  };
}
