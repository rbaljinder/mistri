import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parsePagesConfig,
  sectionConfig,
  type PageBreakdown,
  type PageChart,
  type PageSection,
} from '../packages/engine/src/shared/page.js';
import { parseAppConfig, type AppDashboardView } from '../packages/mistri/src/shared/app.js';

/**
 * What a record page's chart, breakdown and sections say that a dashboard's already did: a line's `curve`, a donut's
 * `total`, `empty: 'hide'`, and a mark before any section's heading; and a dashboard chart's `sort`. Each is read,
 * spelled back, and refused where it can mean nothing.
 */
const pageOf = (sections: unknown[]) =>
  parsePagesConfig({ pages: [{ id: 'project', label: 'Project', base: 'project', sections }] }, 'pages')[0];
const chart = { kind: 'chart', from: 'sprint', whose: 'project_id', by: 'month starts_on' };
const spelled = (section: PageSection) => pageOf([sectionConfig(section)]).sections[0];

test("a page chart's curve and a donut's total are read and spelled back, and refused where they draw nothing", () => {
  const [line, donut] = pageOf([
    { ...chart, curve: 'smooth' },
    { ...chart, by: 'state', shape: 'donut', total: ' Sprints ' },
  ]).sections as PageChart[];
  assert.equal(line.curve, 'smooth');
  assert.equal(donut.total, 'Sprints');
  assert.deepEqual(spelled(line), line);
  assert.deepEqual(spelled(donut), donut);
  assert.throws(() => pageOf([{ ...chart, shape: 'bar', curve: 'smooth' }]), /only a line has a "curve"/);
  assert.throws(() => pageOf([{ ...chart, curve: 'wavy' }]), /"smooth" or "straight"/);
  assert.throws(() => pageOf([{ ...chart, total: 'Sprints' }]), /not a donut/);
  assert.throws(() => pageOf([{ ...chart, shape: 'donut', total: 'x'.repeat(41) }]), /at most 40 characters/);
});

test("empty: 'hide' on a page chart and breakdown is kept and spelled back; nothing else is taken", () => {
  const [drawn, counted] = pageOf([
    { ...chart, empty: 'hide' },
    { kind: 'breakdown', from: 'sprint', whose: 'project_id', by: 'state', empty: 'hide' },
  ]).sections as [PageChart, PageBreakdown];
  assert.equal(drawn.emptyMode, 'hide');
  assert.equal(counted.emptyMode, 'hide');
  assert.equal((sectionConfig(drawn) as { empty?: unknown }).empty, 'hide');
  assert.equal((sectionConfig(counted) as { empty?: unknown }).empty, 'hide');
  assert.deepEqual(spelled(drawn), drawn);
  assert.deepEqual(spelled(counted), counted);
  assert.throws(() => pageOf([{ ...chart, empty: 'collapse' }]), /takes 'hide'/);
  assert.throws(() => pageOf([{ kind: 'breakdown', from: 'sprint', whose: 'project_id', by: 'state', empty: true }]), /takes 'hide'/);
});

test('a page section takes an icon, and it is spelled back; an unknown mark is refused', () => {
  const page = pageOf([
    { kind: 'fields', show: ['name'], icon: 'info' },
    { kind: 'list', from: 'sprint', whose: 'project_id', icon: 'list' },
    { ...chart, icon: 'chart-line' },
    { kind: 'note', text: 'Mind the gap.', icon: 'info' },
  ]);
  assert.deepEqual(
    page.sections.map((section) => section.icon),
    ['info', 'list', 'chart-line', 'info'],
  );
  assert.deepEqual(pageOf(page.sections.map(sectionConfig)).sections, page.sections);
  assert.throws(() => pageOf([{ kind: 'fields', icon: 'not-a-mark' }]), /icon/);
  assert.equal(pageOf([{ kind: 'fields', show: ['name'] }]).sections[0].icon, undefined);
});

const dashboard = (sections: unknown[]) =>
  parseAppConfig(
    {
      name: 'Sort',
      resources: { task: {} },
      views: {
        tasks: { kind: 'list', from: 'task', show: ['title'] },
        overview: { kind: 'dashboard', label: 'Overview', sections },
      },
      home: 'tasks',
      nav: ['tasks', 'overview'],
    },
    'sort fixture',
  );

test("a dashboard chart's sort orders a bar's or donut's categories, and is refused on a line or with another word", () => {
  const parsed = dashboard([
    { kind: 'chart', title: 'By kind', from: 'task', by: 'kind', shape: 'bar', sort: 'category' },
    { kind: 'chart', title: 'Kinds', from: 'task', by: 'kind', shape: 'donut', sort: 'value' },
  ]);
  const [bar, donut] = (parsed.views.overview as AppDashboardView).sections;
  assert.equal(bar.sort, 'category');
  assert.equal(donut.sort, 'value');
  const refused = (extra: Record<string, unknown>) => dashboard([{ kind: 'chart', title: 'K', from: 'task', by: 'kind', ...extra }]);
  assert.throws(() => refused({ sort: 'value' }), /orders the categories of a bar chart or a donut/);
  assert.throws(() => refused({ shape: 'line', sort: 'value' }), /orders the categories of a bar chart or a donut/);
  assert.throws(() => refused({ shape: 'bar', sort: 'title' }), /Use "value" \(largest first\) or "category"/);
});
