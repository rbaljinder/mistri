/**
 * Where a breakdown, chart or matrix opens its groups: `to` names one of the App's lists, `false` keeps the groups
 * text, and check says what an unsaid `to` comes to (a table with no list, or with several).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseAppConfig, type AppDashboardView } from '../packages/mistri/src/shared/app.js';
import { appAdvisories, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { validationCode } from '../packages/mistri/src/server/build/checkProblems.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const table = (id: string) => ({
  id,
  name: id,
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'status', type: 'TEXT', nullable: true, primaryKey: false, allowed: ['open', 'won'] },
    { name: 'region', type: 'TEXT', nullable: true, primaryKey: false },
  ],
});
const schema: DatabaseSchema = {
  label: 'Sales',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [table('deal'), table('lead'), table('note')],
};

function app(sections: object[], lists: Record<string, object> = { deals: { kind: 'list', from: 'deal' } }) {
  return parseAppConfig(
    {
      name: 'Sales',
      resources: { deal: {}, lead: {}, note: {} },
      views: { ...lists, board: { kind: 'dashboard', label: 'Board', sections } },
      home: 'board',
      nav: ['board', ...Object.keys(lists)],
    },
    'drill',
  );
}
const sections = (parsed: ReturnType<typeof app>) => (parsed.views.board as unknown as AppDashboardView).sections;
const advice = (parsed: ReturnType<typeof app>) =>
  appAdvisories({ path: 'sales.ts', app: parsed, pages: [], sources: {} } as unknown as LoadedApp, schema).filter((line) =>
    /drill-/.test(line),
  );

describe("a section's `to`", () => {
  test('a breakdown, a chart and a matrix name the list their groups open, as a metric does', () => {
    const parsed = app([
      { kind: 'breakdown', from: 'deal', by: 'status', to: 'deals' },
      { kind: 'chart', from: 'deal', by: 'status', shape: 'donut', to: 'deals' },
      { kind: 'matrix', from: 'deal', by: 'status, region', to: 'deals' },
    ]);
    assert.deepEqual(
      sections(parsed).map((section) => section.view),
      ['deals', 'deals', 'deals'],
    );
  });

  test('false keeps the groups text', () => {
    const [section] = sections(app([{ kind: 'breakdown', from: 'deal', by: 'status', to: false }]));
    assert.equal(section.noDrill, true);
    assert.equal(section.view, undefined);
  });

  test('a list over another table, an unknown view and a non-view are refused', () => {
    const lists = { deals: { kind: 'list', from: 'deal' }, leads: { kind: 'list', from: 'lead' } };
    assert.throws(
      () => app([{ kind: 'breakdown', from: 'deal', by: 'status', to: 'leads' }], lists),
      /counts deal and opens "leads", a list of lead\. A group opens a list of the rows it counted/,
    );
    assert.throws(
      () => app([{ kind: 'chart', from: 'deal', by: 'status', to: 'nope' }]),
      /opens "nope", which is not a list view this App declares/,
    );
    assert.throws(
      () => app([{ kind: 'matrix', from: 'deal', by: 'status, region', to: 3 }]),
      /"to" that is not a list view's key or false/,
    );
  });

  test('a section that has no groups to open takes no `to`', () => {
    assert.throws(
      () => app([{ kind: 'rows', from: 'deal', to: 'deals' }]),
      /has "to", which only a metric or breakdown or chart or funnel or matrix carries/,
    );
  });
});

describe('what an unsaid `to` comes to, in check', () => {
  test('one list over the table is the doorway: nothing to say', () => {
    assert.deepEqual(advice(app([{ kind: 'breakdown', from: 'deal', by: 'status' }])), []);
  });

  test('no list over the table says so, and that the groups are text', () => {
    const lines = advice(app([{ kind: 'breakdown', title: 'Notes by status', from: 'note', by: 'status' }]));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[drill-none\].*breakdown "Notes by status" reads note, which has no list view.*to: false/);
    assert.equal(validationCode(lines[0]), 'drill-none');
  });

  test('several lists over the table say which to choose from', () => {
    const lists = { deals: { kind: 'list', from: 'deal' }, 'won-deals': { kind: 'list', from: 'deal', query: 'status = won' } };
    const lines = advice(app([{ kind: 'chart', title: 'Deals', from: 'deal', by: 'status', shape: 'donut' }], lists));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[drill-ambiguous\].*2 list views \(deals, won-deals\).*Say which one with to:/);
    assert.equal(validationCode(lines[0]), 'drill-ambiguous');
  });

  test('a `to`, a `to: false`, and a bucketed by (never a doorway) are not warned about', () => {
    const lists = { deals: { kind: 'list', from: 'deal' }, 'won-deals': { kind: 'list', from: 'deal', query: 'status = won' } };
    assert.deepEqual(
      advice(
        app(
          [
            { kind: 'breakdown', from: 'deal', by: 'status', to: 'won-deals' },
            { kind: 'breakdown', from: 'deal', by: 'region', to: false },
            { kind: 'chart', from: 'deal', by: 'month closed_on', over: 'closed_on' },
          ],
          lists,
        ),
      ),
      [],
    );
  });
});
