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
import { anatomyPage, recordAnatomy, spanOf } from '../packages/engine/src/shared/pageAnatomy.js';
import { validatePage } from '../packages/engine/src/shared/page.js';
import { MAX_SECTIONS } from '../packages/engine/src/shared/pageModel.js';
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

test('the inferred page: a head, a classic form, every related table as a tab, the history last, the references beside', () => {
  const page = anatomyPage(schema, 'unit', { history: true })!;
  assert.equal(page.listTabs, true);
  assert.deepEqual(
    page.sections.map((section) => [section.kind, (section as { presentation?: string }).presentation ?? null, section.region ?? 'main']),
    [
      ['fields', 'header', 'main'],
      ['fields', 'properties', 'main'],
      ['list', null, 'main'],
      ['history', null, 'main'],
      ['fields', 'card', 'aside'],
      ['list', 'card', 'aside'],
    ],
  );
  const [head, form] = page.sections as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(head, { kind: 'fields', presentation: 'header', paths: ['property_id', 'rent', 'listed_on', 'beds'], status: 'status' });
  // One untitled group (no "Unit" heading over a unit): the parent its card says whole is left out, long text last.
  assert.deepEqual(form, {
    kind: 'fields',
    presentation: 'properties',
    columns: 2,
    emptyMode: 'show',
    paths: ['status', 'kind', 'rent', 'beds', 'listed_on', 'leases', 'notes'],
  });
  assert.ok(!page.sections.some((section) => (section as { title?: string }).title === 'Details'));
  assert.equal(validatePage(schema, page).error, undefined);
  // With no children, the form is the page and the parent's card stands beside it.
  const lease = anatomyPage(schema, 'lease')!;
  assert.deepEqual(
    lease.sections.map((section) => section.region ?? 'main'),
    ['main', 'main', 'aside'],
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

test('a record with a start and an end says them as one span in its head, and keeps both in its form', () => {
  const visit = {
    id: 'visit',
    name: 'visit',
    schema: '',
    isView: false,
    columns: [key('id'), column('starts_at', 'TIMESTAMP'), column('ends_at', 'TIMESTAMP'), column('summary', 'TEXT')],
  };
  const spanned: DatabaseSchema = { ...schema, tables: [...schema.tables, visit] };
  assert.deepEqual(spanOf(visit), { start: 'starts_at', end: 'ends_at' });
  assert.deepEqual(spanOf({ ...visit, columns: [key('id'), column('start_date', 'DATE'), column('end_date', 'DATE')] }), {
    start: 'start_date',
    end: 'end_date',
  });
  assert.deepEqual(spanOf({ ...visit, columns: [key('id'), column('shift_start', 'TIMESTAMP'), column('shift_end', 'TIMESTAMP')] }), {
    start: 'shift_start',
    end: 'shift_end',
  });
  // Two dates that are not a start and its end are no span: an end is never paired by guesswork.
  assert.equal(spanOf({ ...visit, columns: [key('id'), column('starts_at', 'TIMESTAMP'), column('due_on', 'DATE')] }), undefined);
  assert.equal(spanOf({ ...visit, columns: [key('id'), column('starts_at', 'TIMESTAMP'), column('ends_at', 'TEXT')] }), undefined);
  const [head, form] = anatomyPage(spanned, 'visit')!.sections as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(head.paths, ['starts_at']);
  assert.deepEqual(head.spans, { starts_at: 'ends_at' });
  // The form is where each end is read whole and set.
  assert.ok((form.paths as string[]).includes('starts_at') && (form.paths as string[]).includes('ends_at'));
  assert.equal(validatePage(spanned, anatomyPage(spanned, 'visit')!).error, undefined);
});

test("the inferred page reads the App's declarations: the form's groups, a status its machine moves, the name's second line", () => {
  const lease = anatomyPage(schema, 'lease', {
    moved: (_table, column) => column === 'status',
    groups: () => [{ label: 'Term', fields: ['starts_on', 'ends_on'] }, { fields: ['notes', 'rent'] }],
    subtitle: (_table, column) => (column === 'tenant' ? 'unit_id' : undefined),
  })!;
  // A reference's card is titled as the App calls its field.
  const captioned = anatomyPage(schema, 'lease', { caption: (_table, column) => (column === 'unit_id' ? 'Home' : undefined) })!;
  assert.equal((captioned.sections.find((section) => section.region === 'aside') as { title?: string }).title, 'Home');
  const fields = lease.sections.filter((section) => section.kind === 'fields') as unknown as Array<Record<string, unknown>>;
  // The head still says the status; the form does not offer what only the machine's verbs may set.
  assert.equal(fields[0].status, 'status');
  assert.equal(fields[0].subtitle, 'unit_id', "the name's column's display subtitle");
  assert.deepEqual(
    fields.slice(1).map((section) => [section.title ?? null, section.paths, section.region ?? 'main']),
    [
      [null, ['rent', 'notes'], 'main'],
      ['Term', ['starts_on', 'ends_on'], 'main'],
      ['Unit', ['unit_id', 'unit_id.status', 'unit_id.property_id'], 'aside'],
    ],
  );
  // Every table that points here is a tab, past the scaffold's four, and the page stays one screen of sections.
  const hub: DatabaseSchema = {
    ...schema,
    tables: [
      ...schema.tables,
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `note${i}`,
        name: `note${i}`,
        schema: '',
        isView: false,
        columns: [key('id'), column('vendor_id', 'INTEGER'), column('said', 'TEXT')],
      })),
    ],
    foreignKeys: [
      ...schema.foreignKeys,
      ...Array.from({ length: 30 }, (_, i) => ({
        name: `note${i}_vendor`,
        from: { table: `note${i}`, columns: ['vendor_id'] },
        to: { table: 'vendor', columns: ['id'] },
      })),
    ],
  } as DatabaseSchema;
  assert.equal(recordAnatomy(hub, 'vendor')!.related.length, 4, 'the scaffold keeps its four');
  const vendor = anatomyPage(hub, 'vendor')!;
  const lists = vendor.sections.filter((section) => section.kind === 'list');
  assert.equal(vendor.sections.length, MAX_SECTIONS);
  assert.deepEqual(
    lists.slice(0, 3).map((section) => (section as { from?: string }).from),
    ['note0', 'note1', 'note2'],
    'in the order the schema declares them',
  );
  assert.equal(validatePage(hub, vendor).error, undefined);
});

test("served: an App's resource with no page opens on the anatomy, in the App's words, and plans as it is served", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-anatomy-'));
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
