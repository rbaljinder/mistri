/**
 * The record anatomy (pageAnatomy.ts): which columns of a table go where on
 * its default page — the status beside the name, the parent, a figure and a
 * date under it, the rollups as a summary, the children as tabs of at most
 * four columns, the rest as a rail — and the page an App serves for a
 * resource it wrote none for.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { anatomyPage, recordAnatomy } from '../packages/engine/src/shared/pageAnatomy.js';
import { validatePage } from '../packages/engine/src/shared/page.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const key = (name: string) => column(name, 'INTEGER', { primaryKey: true, nullable: false });
const schema: DatabaseSchema = {
  label: 'Homes',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    {
      id: 'property',
      name: 'property',
      schema: '',
      isView: false,
      columns: [key('id'), column('name', 'TEXT'), column('city', 'TEXT'), column('manager', 'TEXT')],
    },
    {
      id: 'unit',
      name: 'unit',
      schema: '',
      isView: false,
      columns: [
        key('id'),
        column('name', 'TEXT'),
        column('property_id', 'INTEGER'),
        column('status', 'TEXT', { allowed: ['vacant', 'occupied'] }),
        column('kind', 'TEXT', { allowed: ['flat', 'house'] }),
        column('rent', 'NUMERIC'),
        column('beds', 'INTEGER'),
        column('listed_on', 'DATE'),
        column('notes', 'TEXT'),
        column('password_hash', 'TEXT'),
      ],
      rollups: { leases: { fn: 'count', via: 'lease.unit_id', type: 'integer' } },
    },
    {
      id: 'lease',
      name: 'lease',
      schema: '',
      isView: false,
      columns: [
        key('id'),
        column('unit_id', 'INTEGER'),
        column('tenant', 'TEXT'),
        column('rent', 'NUMERIC'),
        column('starts_on', 'DATE'),
        column('ends_on', 'DATE'),
        column('status', 'TEXT', { allowed: ['active', 'ended'] }),
        column('notes', 'TEXT'),
      ],
    },
    {
      id: 'vendor',
      name: 'vendor',
      schema: '',
      isView: false,
      columns: [
        key('id'),
        column('name', 'TEXT'),
        column('trade', 'TEXT'),
        column('phone', 'TEXT'),
        column('email', 'TEXT'),
        column('bio', 'TEXT'),
      ],
    },
  ],
  foreignKeys: [
    { name: 'unit_property', from: { table: 'unit', columns: ['property_id'] }, to: { table: 'property', columns: ['id'] } },
    { name: 'lease_unit', from: { table: 'lease', columns: ['unit_id'] }, to: { table: 'unit', columns: ['id'] } },
  ],
} as DatabaseSchema;

test("the anatomy reads a table's columns into the page's places", () => {
  const unit = recordAnatomy(schema, 'unit')!;
  assert.equal(unit.status, 'status', 'named like a state; the other vocabulary is not one');
  assert.deepEqual(unit.facts, ['property_id', 'rent', 'listed_on', 'beds']);
  assert.deepEqual(unit.summary, ['leases'], 'the rollups the catalog serves');
  assert.deepEqual(unit.related, [
    { from: 'lease', whose: 'unit_id', show: ['tenant', 'rent', 'ends_on', 'status'], sort: 'ends_on desc' },
  ]);
  assert.deepEqual(unit.properties, ['kind', 'notes'], 'the rest, long text last, never a key or a secret');
  assert.equal(unit.noun, 'Unit', 'the rail is titled by the record, never "Details"');
  // Beside the tabs: the parent as a card of two of its fields, and the child still in play.
  assert.deepEqual(unit.parent, { title: 'Property', paths: ['property_id', 'property_id.city', 'property_id.manager'] });
  assert.deepEqual(unit.current, {
    title: 'Current lease',
    from: 'lease',
    whose: 'unit_id',
    show: ['rent', 'ends_on'],
    query: 'status = active',
    sort: 'ends_on desc',
  });
  // A record with no parent, figure or date still opens on a line of what it is.
  assert.deepEqual(recordAnatomy(schema, 'vendor')!.facts, ['trade', 'phone', 'email']);
  assert.equal(unit.history, false);
  // The caller's words: a status its tones name, money its display names, a list's title.
  const told = recordAnatomy(schema, 'unit', {
    status: (_t, c) => (c.name === 'kind' ? true : c.name === 'status' ? false : undefined),
    money: (_t, c) => (c.name === 'rent' ? false : undefined),
    title: () => 'Leases',
    history: true,
  })!;
  assert.equal(told.status, 'kind');
  assert.deepEqual(told.facts, ['property_id', 'listed_on', 'beds']);
  assert.equal(told.related[0].title, 'Leases');
  assert.equal(told.history, true);
  assert.equal(
    recordAnatomy({ ...schema, tables: [{ ...schema.tables[0], columns: [column('name', 'TEXT')] }] }, 'property'),
    null,
    'no key, no record',
  );
});

test('the anatomy is a page: header, summary, lists as tabs, the rail and the history beside them, and it validates', () => {
  const page = anatomyPage(schema, 'unit', { history: true })!;
  assert.equal(page.listTabs, true);
  assert.deepEqual(
    page.sections.map((section) => [section.kind, (section as { presentation?: string }).presentation ?? null, section.region ?? 'main']),
    [
      ['fields', 'header', 'main'],
      ['fields', 'summary', 'main'],
      ['list', null, 'main'],
      ['fields', 'card', 'aside'],
      ['list', 'card', 'aside'],
      ['fields', 'properties', 'aside'],
      ['history', null, 'aside'],
    ],
  );
  assert.ok(!page.sections.some((section) => (section as { title?: string }).title === 'Details'));
  assert.equal(validatePage(schema, page).error, undefined);
  // With no children, the fields are the page rather than a rail beside nothing.
  const lease = anatomyPage(schema, 'lease')!;
  assert.deepEqual(
    lease.sections.map((section) => section.region ?? 'main'),
    ['main', 'main'],
  );
  assert.equal(validatePage(schema, lease).error, undefined);
  // A record that is only its name still has a fields section to own it, so the head can edit it.
  const tagged: DatabaseSchema = {
    ...schema,
    tables: [...schema.tables, { id: 'tag', name: 'tag', schema: '', isView: false, columns: [key('id'), column('name', 'TEXT')] }],
  };
  const tag = anatomyPage(tagged, 'tag')!;
  assert.deepEqual(tag.sections, [{ kind: 'fields', presentation: 'header', paths: [] }]);
  assert.equal(validatePage(tagged, tag).error, undefined);
});

test("served: an App's resource with no page opens on the anatomy, in the App's words, and plans as it is served", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-anatomy-'));
  const path = join(directory, 'homes.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE unit (id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, rent NUMERIC);
    CREATE TABLE lease (id INTEGER PRIMARY KEY, unit_id INTEGER NOT NULL REFERENCES unit(id), tenant TEXT NOT NULL, ends_on DATE);
    INSERT INTO unit VALUES (1, 'B103', 'flat', 1450); INSERT INTO lease VALUES (1, 1, 'Ada', '2027-01-31');`);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'homes', name: 'Homes', url: path, source: 'config', writable: false });
  const manifest = parseAppConfig(
    {
      id: 'homes-app',
      name: 'Homes',
      connection: 'homes',
      resources: {
        unit: { display: { kind: { tone: { flat: 'info', house: 'good' } } } },
        lease: { noun: { one: 'tenancy', many: 'tenancies' } },
      },
      views: { units: { kind: 'list', from: 'unit' } },
      home: 'units',
      nav: ['units'],
    },
    'homes',
  );
  const host: AppHost = { app: { path: '/homes/app.ts', app: manifest, pages: [], sources: {} }, pages: [] };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [] });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    bound.port = (server.address() as { port: number }).port;
    const origin = `http://${bound.host}:${bound.port}`;
    const suggested = (await (await fetch(`${origin}/api/pages/suggested?table=unit&app=homes-app`)).json()) as {
      page: { sections: Array<Record<string, unknown>> };
    };
    const [head] = suggested.page.sections;
    const list = suggested.page.sections.find((section) => section.kind === 'list')!;
    assert.deepEqual([head.presentation, head.status], ['header', 'kind'], 'a column the App dresses in tones is its status');
    assert.equal(list.title, 'Tenancies', 'a list is called what its records are');
    // The plan of the same page is the same anatomy.
    const plan = (await (
      await fetch(`${origin}/api/pages/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: 'homes-app', page: 'suggested:unit', key: { id: 1 } }),
      })
    ).json()) as { page: { sections: Array<{ presentation?: string }> } };
    assert.equal(plan.page.sections[0].presentation, 'header');
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});
