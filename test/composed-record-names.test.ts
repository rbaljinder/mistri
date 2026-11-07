/**
 * A record with no name of its own is titled by what it always has: the record it belongs to and the day it is for
 * ("Fix sticking door · Sep 13, 2026"). A column picked for being the first text, that the record may leave blank,
 * is no name: a visit's `summary`, written after the visit, titled every visit not yet made "(row)". The name is one
 * template computed in the statement, so the grid, the crumbs, the palette, a reference chip and an aside card all
 * read the same words.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { appLabelTemplates, parseAppConfig, resolveResources, withLabelTemplates } from '../packages/mistri/src/shared/app.js';
import { withViewLabels } from '../packages/engine/src/shared/view.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';
import { parseLabelTemplate, writesDay } from '../packages/engine/src/shared/recordLabel.js';

async function fixture(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-composed-names-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'f.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE job (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE crew (id INTEGER PRIMARY KEY, nickname TEXT);
    CREATE TABLE visit (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES job(id), starts_at TEXT NOT NULL,
      ends_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, summary TEXT);
    CREATE TABLE shift (id INTEGER PRIMARY KEY, crew_id INTEGER NOT NULL REFERENCES crew(id), created_at TEXT NOT NULL);
    CREATE TABLE line_item (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES job(id), quantity INTEGER NOT NULL);
    CREATE TABLE memo (id INTEGER PRIMARY KEY, remarks TEXT, team_id INTEGER NOT NULL REFERENCES job(id), sent_on TEXT NOT NULL);
    CREATE TABLE contact (id INTEGER PRIMARY KEY, name TEXT, met_on TEXT NOT NULL);
    INSERT INTO job VALUES (1, 'Fix sticking door');
    INSERT INTO crew VALUES (1, NULL);
    INSERT INTO visit VALUES (1, 1, '2026-09-13 14:00:00', '2026-09-13 16:00:00', '2026-09-01 08:00:00', '2026-12-31 08:00:00', NULL),
      (2, 1, '2026-01-02T09:30:00Z', NULL, '2025-12-01', '2026-12-31', 'Done'), (3, 1, 'not a day', NULL, 'x', 'x', NULL);
    INSERT INTO shift VALUES (1, 1, '2026-03-04 07:00:00');
    INSERT INTO line_item VALUES (1, 1, 4);
    INSERT INTO memo VALUES (1, NULL, 1, '2026-11-30');
    INSERT INTO contact VALUES (1, NULL, '2026-05-06');
  `);
  db.close();
  const adapter = new SqliteAdapter(file, 'f');
  t.after(() => adapter.close());
  return { adapter, schema: await adapter.introspect() };
}

const app = (resources: Record<string, unknown> = {}) =>
  parseAppConfig(
    {
      name: 'x',
      resources: { job: {}, crew: {}, visit: {}, shift: {}, line_item: {}, memo: {}, contact: {}, ...resources },
      views: { visits: { kind: 'list', from: 'visit' } },
      home: 'visits',
      nav: ['visits'],
    },
    'test/app.json',
  );

async function names(
  adapter: SqliteAdapter,
  schema: import('../packages/engine/src/shared/schema.js').DatabaseSchema,
  table: string,
  authored = app(),
) {
  const served = withLabelTemplates(authored, schema);
  const view = withViewLabels(served, textToView(served, `${table} show id, $label sort id`).view!);
  return (await adapter.runView(view)).rows.map((row) => row.$label);
}

test('a record whose only text may be blank is named by its parent and its day, the day said whole', async (t) => {
  const { adapter, schema } = await fixture(t);
  const template = appLabelTemplates(app(), schema).get('visit');
  /* The day it is for, not the day it was entered or touched. */
  assert.equal(template, '{job_id.title} · {starts_at|date}');
  assert.ok(template && writesDay(template));
  /* A zoned stamp says its date part; a value that is no date is said as stored, never a wrong day. */
  assert.deepEqual(await names(adapter, schema, 'visit'), [
    'Fix sticking door · Sep 13, 2026',
    'Fix sticking door · Jan 2, 2026',
    'Fix sticking door · not a day',
  ]);
});

test('with no parent that has a name, or no day, the noun and key name it, as before', async (t) => {
  const { adapter, schema } = await fixture(t);
  /* The crew's only name may be blank, so it names no shift; a day alone names a busy day's shifts alike. */
  assert.deepEqual(await names(adapter, schema, 'shift'), ['Shift #1']);
  /* A parent alone names forty lines alike. */
  assert.deepEqual(await names(adapter, schema, 'line_item'), ['Line item #1']);
  /* A parent whose own name is the App's template (here, its noun and key) is no name to say inside another. */
  assert.equal(appLabelTemplates(app({ job: { recordLabel: 'Job #{id}' } }), schema).get('visit'), 'Visit #{id}');
});

test('a blank-able text is passed over only where it was picked for being first, never a name, title or one declared', async (t) => {
  const { adapter, schema } = await fixture(t);
  assert.deepEqual(await names(adapter, schema, 'memo'), ['Fix sticking door · Nov 30, 2026']);
  /* A column called a name is the name, blank or not: its record says so. */
  assert.equal(appLabelTemplates(app(), schema).get('contact'), undefined);
  /* A declared label is the App's word, kept whatever it may hold. */
  assert.equal(appLabelTemplates(app({ visit: { recordLabel: 'summary' } }), schema).get('visit'), undefined);
  assert.equal(appLabelTemplates(app({ visit: { recordLabel: 'Visit {summary}' } }), schema).get('visit'), 'Visit {summary}');
});

test("the day mark is the platform's own: an authored template may not write it", async (t) => {
  const { schema } = await fixture(t);
  const parsed = parseLabelTemplate('{job_id.title} · {starts_at|date}');
  assert.ok(!('problem' in parsed));
  assert.deepEqual(
    parsed.parts.filter((part) => 'path' in part),
    [{ path: 'job_id.title' }, { path: 'starts_at', date: true }],
  );
  const bad = resolveResources(app({ visit: { recordLabel: '{starts_at|date}' } }), schema).problems.join('\n');
  assert.match(bad, /starts_at/);
});
