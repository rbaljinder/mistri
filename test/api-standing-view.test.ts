import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { tabSlug } from '../packages/engine/src/shared/addressParams.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { checkApiReadCatalog } from '../packages/mistri/src/server/api/apiReadCatalog.js';

function fixture(extra: Record<string, unknown> = {}, segments: Record<string, unknown> = {}) {
  const schema: DatabaseSchema = {
    dialect: 'sqlite',
    label: 'Logical',
    readAt: '2000-01-01',
    foreignKeys: [],
    tables: [
      {
        id: 'item',
        name: 'item',
        schema: '',
        isView: false,
        columns: ['id', 'amount', 'status', 'created_on'].map((name) => ({
          name,
          type: name === 'status' ? 'TEXT' : name === 'created_on' ? 'DATE' : 'INTEGER',
          primaryKey: name === 'id',
          nullable: false,
        })),
      },
    ],
  };
  const app = parseAppConfig(
    {
      name: 'Views',
      resources: {
        item: {
          segments: {
            small: 'amount < 10',
            large: 'amount >= 10',
            created_today: { query: 'created_on = today', label: 'Today' },
            ...segments,
          },
        },
      },
      auth: { roles: { reader: { read: true } } },
      views: {
        items: {
          kind: 'list',
          from: 'item',
          query: 'status = open or status = working',
          sort: 'amount desc',
          filters: ['amount'],
          tabs: ['small', { segment: 'large', sort: 'id asc' }],
          ...extra,
        },
      },
      home: 'items',
      api: {
        version: 1,
        roles: ['reader'],
        resources: { item: { fields: ['id', 'amount', 'status', 'created_on'], filters: ['status'], sorts: ['id', 'amount'] } },
        views: ['items'],
      },
    },
    'fixture',
  );
  const read = () => checkApiReadCatalog(app.api!, app, schema).operations.find((operation) => operation.kind === 'view')!;
  return { schema, app, read };
}

test('standing metadata preserves base AND tab questions, first-tab default and effective order', () => {
  const f = fixture(),
    operation = f.read(),
    standing = operation.standing!;
  assert.equal(standing.query, 'status = open or status = working');
  assert.equal(standing.defaultTab, 'small');
  assert.equal(standing.clock, 'request-required');
  assert.deepEqual(standing.order, [{ path: 'amount', direction: 'desc' }]);
  assert.deepEqual(standing.tabs, [
    {
      id: 'small',
      label: 'Small',
      // A tab over a segment is the segment's word: the API's catalog expands it where the question is run.
      query: '(status = open or status = working) and small',
      order: [{ path: 'amount', direction: 'desc' }],
    },
    {
      id: 'large',
      label: 'Large',
      query: '(status = open or status = working) and large sort id asc',
      order: [{ path: 'id', direction: 'asc' }],
    },
  ]);
  assert.deepEqual(operation.filters, ['status']);
  assert.deepEqual(standing.filters, ['amount']); // Authored view metadata cannot grant this API filter.
  assert.deepEqual(operation.dependencies, [{ resource: 'item', fields: ['amount', 'created_on', 'id', 'status'] }]);
});

test('relative dates stay authored and request-clock-bound rather than frozen catalog dates', () => {
  const f = fixture({ query: 'created_on >= last 30 days', tabs: ['created_today'] });
  const standing = f.read().standing!;
  assert.equal(standing.query, 'created_on >= last 30 days');
  assert.equal(standing.tabs[0].query, 'created_on >= last 30 days and created_today');
  // Its id is the segment's name, the word `?tab=` says in the App's address and `?segment=` in the API's, never its label's slug.
  assert.equal(standing.tabs[0].id, 'created_today');
  assert.equal(standing.defaultTab, 'created_today');
  assert.doesNotMatch(JSON.stringify(standing), /2000-|1999-/);
  assert.equal(Object.hasOwn(standing, 'filter'), false);
});

test('standing query/order metadata is detached and recursively immutable', () => {
  const f = fixture(),
    standing = f.read().standing!,
    before = structuredClone(standing);
  const view = f.app.views.items as { query: string; sort: string; filters: string[]; tabs: { label: string; query: string }[] };
  view.query = '';
  view.sort = 'id';
  view.filters.push('status');
  view.tabs[0].query = '';
  view.tabs[0].label = 'Changed';
  assert.deepEqual(standing, before);
  assert.ok(
    Object.isFrozen(standing) &&
      Object.isFrozen(standing.tabs) &&
      Object.isFrozen(standing.tabs[0]) &&
      Object.isFrozen(standing.tabs[0].order) &&
      Object.isFrozen(standing.tabs[0].order[0]) &&
      Object.isFrozen(standing.filters),
  );
});

test('tab address spellings match existing browser behavior and ambiguous IDs refuse', () => {
  assert.equal(tabSlug('Hybrid and electric'), 'hybrid-and-electric');
  assert.equal(tabSlug('  OPEN!  '), 'open');
  assert.equal(tabSlug('Réview'), 're-view');
  for (const tabs of [[{ label: 'Open!' }, { label: 'Open' }], [{ label: '!!!' }], [{ label: 'constructor' }]]) {
    assert.throws(() => fixture({ tabs }).read(), /address identifiers/);
  }
});

test('standing limits refuse instead of disappearing; no tabs retain the base question', () => {
  // A segment holds conditions only, so a clause is refused where it is declared rather than where a tab reads it.
  for (const [extra, segments, refusal] of [
    [{ query: 'amount > 1 limit 10' }, {}, /limit clause/],
    [{ tabs: ['limited'] }, { limited: 'limit 2' }, /"segments" "limited" has a "query" with a clause \("limit 2"\)/],
  ] as const) {
    assert.throws(() => fixture(extra, segments).read(), refusal);
  }
  const standing = fixture({ tabs: [] }).read().standing!;
  assert.equal(standing.defaultTab, null);
  assert.deepEqual(standing.tabs, []);
  assert.equal(standing.query, 'status = open or status = working');
});
