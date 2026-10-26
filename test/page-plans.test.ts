import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPageSections } from '../packages/engine/src/shared/pagePlans.js';
import { breakdownPlan, listView, metricView, sectionQuery, type PageDef } from '../packages/engine/src/shared/page.js';
import type { DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';
import { viewToTextWithSchema } from '../packages/engine/src/shared/viewtext.js';
import { SECTION_TRAITS, type SectionTraits } from '../packages/engine/src/shared/pageModel.js';

const table = (id: string, columns: string[]): TableMeta => ({
  id,
  name: id,
  schema: '',
  isView: false,
  columns: columns.map((name) => ({ name, type: name === 'at' ? 'DATE' : 'INTEGER', primaryKey: name === 'id', nullable: false })),
});
const schema: DatabaseSchema = {
  dialect: 'sqlite',
  label: 'page plans',
  readAt: '',
  tables: [table('parent', ['id', 'site_id']), table('child', ['id', 'parent_id', 'site_id', 'amount', 'at']), table('site', ['id'])],
  foreignKeys: [
    { name: 'child_parent', from: { table: 'child', columns: ['parent_id'] }, to: { table: 'parent', columns: ['id'] } },
    { name: 'parent_site', from: { table: 'parent', columns: ['site_id'] }, to: { table: 'site', columns: ['id'] } },
    { name: 'child_site', from: { table: 'child', columns: ['site_id'] }, to: { table: 'site', columns: ['id'] } },
  ],
};
const page = (sections: PageDef['sections']): PageDef => ({ id: 'detail', name: 'Parent', base: 'parent', sections });
const key = { id: 7 };
const now = new Date(2024, 3, 5, 12);
const relation = { from: 'child', path: 'parent_id' };

test('every section retains its index, planner payload and HTTP shaping', () => {
  const definition = page([
    { kind: 'fields', paths: ['id'] },
    { kind: 'list', ...relation, columns: ['id', 'amount'], limit: 6 },
    { kind: 'metric', ...relation, fn: 'count' },
    { kind: 'metric', ...relation, fn: 'sum', column: 'amount' },
    { kind: 'breakdown', ...relation, by: 'amount', limit: 4 },
    { kind: 'timeline', streams: [{ ...relation, at: 'at', show: 'id', detail: 'id' }] },
  ]);
  const before = structuredClone({ schema, definition, key });
  const plans = planPageSections(schema, definition, key, {}, now);
  assert.deepEqual(
    plans.map((p) => [p.index, p.kind]),
    definition.sections.map((s, i) => [i, s.kind]),
  );
  assert.deepEqual(plans[0], { index: 0, kind: 'fields' });
  for (const index of [1, 2, 3]) {
    const section = definition.sections[index];
    assert.ok(section.kind === 'list' || section.kind === 'metric');
    const built =
      section.kind === 'list'
        ? listView(schema, definition, section, key, index, now, {})
        : metricView(schema, definition, section, key, index, now, {});
    assert.deepEqual(plans[index], {
      index,
      kind: section.kind,
      view: built.view,
      empty: built.empty,
      counts: 'counts' in built ? built.counts : undefined,
      query: sectionQuery(built.view),
      viewText: viewToTextWithSchema(schema, built.view!),
      error: built.error,
    });
  }
  const breakdown = definition.sections[4];
  assert.equal(breakdown.kind, 'breakdown');
  const built = breakdownPlan(schema, definition, breakdown, key, 4, now, {});
  assert.deepEqual(plans[4], { index: 4, kind: 'breakdown', breakdown: built.def, empty: built.empty, error: built.error });
  const timeline = plans[5];
  assert.equal(timeline.kind, 'timeline');
  assert.deepEqual(timeline.streams[0].view?.columns, [{ path: 'at' }, { path: 'id' }]);
  assert.deepEqual(timeline.streams[0].view?.orderBy, [{ path: 'at', direction: 'desc' }]);
  assert.equal(timeline.streams[0].view?.limit, 20);
  assert.deepEqual({ schema, definition, key }, before);
});

test('one supplied date resolves relative filters for lists, metrics, breakdowns and streams', () => {
  const filtered = { ...relation, filter: 'at = today' };
  const plans = planPageSections(
    schema,
    page([
      { kind: 'list', ...filtered },
      { kind: 'metric', ...filtered, fn: 'count' },
      { kind: 'breakdown', ...filtered, by: 'amount' },
      { kind: 'timeline', limit: 9, streams: [{ ...filtered, at: 'at', show: 'id' }] },
    ]),
    key,
    {},
    now,
  );
  const filters = plans.map((plan) => {
    if (plan.kind === 'breakdown') return plan.breakdown?.filter;
    if (plan.kind === 'timeline') {
      assert.equal(plan.streams[0].view?.limit, 9);
      return plan.streams[0].view?.filter;
    }
    assert.ok(plan.kind === 'list' || plan.kind === 'metric');
    return plan.view?.filter;
  });
  assert.ok(filters[0]);
  for (const filter of filters) assert.deepEqual(filter, filters[0]);
  assert.match(JSON.stringify(filters[0]), /2024-04-05/);
});

test('resolved about keys and null references are consumed without a root read', () => {
  const definition = page([
    { kind: 'list', from: 'child', path: 'site_id', of: 'site_id' },
    { kind: 'metric', from: 'child', path: 'site_id', of: 'site_id', fn: 'count' },
    { kind: 'breakdown', from: 'child', path: 'site_id', of: 'site_id', by: 'amount' },
  ]);
  for (const plan of planPageSections(schema, definition, key, { site_id: null }, now)) {
    assert.ok(plan.kind === 'list' || plan.kind === 'metric' || plan.kind === 'breakdown');
    assert.equal(plan.empty, true);
    assert.equal(plan.error, undefined);
    if (plan.kind === 'metric') assert.equal(plan.counts, true);
  }
  const ofKeys = { site_id: { id: 21 } };
  const before = structuredClone(ofKeys);
  const [plan] = planPageSections(schema, definition, key, ofKeys, now);
  assert.equal(plan.kind, 'list');
  assert.deepEqual(plan.view?.filter?.groups, [[{ path: 'site_id', op: '=', value: 21 }]]);
  assert.deepEqual(ofKeys, before);
});

test('bad section and stream paths retain local errors without dropping siblings', () => {
  const plans = planPageSections(
    schema,
    page([
      { kind: 'list', from: 'child', path: 'missing' },
      { kind: 'metric', ...relation, fn: 'count' },
      {
        kind: 'timeline',
        streams: [
          { from: 'child', path: 'missing', at: 'at', show: 'id' },
          { ...relation, at: 'at', show: 'id' },
        ],
      },
    ]),
    key,
    {},
    now,
  );
  assert.equal(plans[0].kind, 'list');
  assert.match(plans[0].error!, /missing/);
  assert.equal(plans[0].view, undefined);
  assert.equal(plans[0].query, undefined);
  assert.equal(plans[1].kind, 'metric');
  assert.ok(plans[1].view);
  assert.equal(plans[2].kind, 'timeline');
  assert.match(plans[2].streams[0].error!, /missing/);
  assert.ok(plans[2].streams[1].view);
});

test('empty pages produce no plans', () => {
  assert.deepEqual(planPageSections(schema, page([]), key, {}, now), []);
});

test('a section the traits say reads nothing of its own, or only the record, is planned as nothing', () => {
  /* One section of each kind that plans nothing, named by the traits table rather than by a list of its own. */
  const quiet = (Object.entries(SECTION_TRAITS) as Array<[PageDef['sections'][number]['kind'], SectionTraits]>)
    .filter(([, traits]) => traits.reads !== 'rows')
    .map(([kind]) => kind);
  assert.deepEqual(quiet.sort(), ['diagram', 'fields', 'flows', 'history', 'note']);
  const sections = quiet.map((kind) => ({ kind, ...(kind === 'note' ? { text: 'Hello' } : {}) })) as PageDef['sections'];
  assert.deepEqual(
    planPageSections(schema, page(sections), key, {}, now),
    quiet.map((kind, index) => ({ index, kind })),
  );
});
