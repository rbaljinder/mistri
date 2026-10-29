/**
 * A record's computed name says a stored code as the words its column's
 * display rule says it in a cell: a vocabulary value made words, the rule's
 * own `values`. The name is computed in the statement
 * (recordLabel.ts), so the words are too, in every list, picker and
 * breadcrumb that reads `$label` — and in a search of it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { POSTGRES_STYLE } from '../packages/engine/src/shared/filter.js';
import { parseAppConfig, resolveResources, withLabelTemplates } from '../packages/mistri/src/shared/app.js';
import { compileView, withViewLabels } from '../packages/engine/src/shared/view.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';
import { parseLabelTemplate } from '../packages/engine/src/shared/recordLabel.js';

async function clinic(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-label-words-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'clinic.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE patient (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE visit (id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patient(id),
      kind TEXT NOT NULL CHECK (kind IN ('annual physical', 'follow-up', 'telehealth')),
      room TEXT, stage TEXT, note TEXT);
    CREATE TABLE claim (id INTEGER PRIMARY KEY, visit_id INTEGER REFERENCES visit(id));
    INSERT INTO patient VALUES (1, 'Ada Park');
    INSERT INTO visit VALUES (1, 1, 'annual physical', 'DR', 'IN_REVIEW', 'x'), (2, 1, 'telehealth', 'OR', NULL, 'y');
    INSERT INTO claim VALUES (1, 1), (2, 2);
  `);
  db.close();
  const adapter = new SqliteAdapter(file, 'clinic');
  t.after(() => adapter.close());
  return { adapter, file, schema: await adapter.introspect() };
}

const app = (resources: Record<string, unknown>) =>
  parseAppConfig(
    { name: 'x', resources, views: { visits: { kind: 'list', from: 'visit' } }, home: 'visits', nav: ['visits'] },
    'test/app.json',
  );

test("a vocabulary and a rule's values reach the computed name as their words", async (t) => {
  const { adapter, schema } = await clinic(t);
  const served = withLabelTemplates(
    app({
      patient: {},
      visit: {
        recordLabel: '{patient_id.name} · {kind} in {room} ({stage}) {note}',
        display: { room: { values: { DR: "Doctor's room", OR: 'Other room' } }, stage: {} },
      },
      claim: {},
    }),
    schema,
  );
  const template = served.tables.find((table) => table.name === 'visit')!.labelTemplate!;
  const parsed = parseLabelTemplate(template);
  assert.ok(!('problem' in parsed));
  const parts = parsed.parts.filter((part): part is Extract<typeof part, { path: string }> => 'path' in part);
  assert.deepEqual(
    parts.map((part) => [part.path, part.words]),
    [
      ['patient_id.name', undefined],
      ['kind', { 'annual physical': 'Annual physical', 'follow-up': 'Follow-up', telehealth: 'Telehealth' }],
      ['room', { DR: "Doctor's room", OR: 'Other room' }],
      // Words for every value, over no finite set of values, have nothing to say in a statement.
      ['stage', undefined],
      // A free text column is said as stored.
      ['note', undefined],
    ],
  );
  assert.deepEqual(parsed.paths, ['patient_id.name', 'kind', 'room', 'stage', 'note'], "the paths are the author's");

  const view = withViewLabels(served, textToView(served, 'claim show id, visit_id.$label sort id').view!);
  const rows = (await adapter.runView(view)).rows;
  assert.deepEqual(
    rows.map((row) => row['visit_id.$label']),
    ["Ada Park · Annual physical in Doctor's room (IN_REVIEW) x", 'Ada Park · Telehealth in Other room () y'],
  );
  // Searching the name searches what it says.
  const found = withViewLabels(served, textToView(served, 'visit show id where $label contains "Annual"').view!);
  assert.deepEqual(
    (await adapter.runView(found)).rows.map((row) => row.id),
    [1],
  );

  const sql = (style: typeof POSTGRES_STYLE) =>
    compileView(served, { ...view, filter: undefined, orderBy: undefined, columns: [{ path: 'visit_id.$label' }] }, style).text;
  assert.match(sql(POSTGRES_STYLE), /CASE CAST\("visit_1"\."kind" AS TEXT\) WHEN 'annual physical' THEN 'Annual physical'/);
});

test("an authored template does not write words: that is the column's rule to say", async (t) => {
  const { schema } = await clinic(t);
  const words = encodeURIComponent(JSON.stringify({ a: 'A' }));
  assert.match(
    resolveResources(app({ patient: {}, visit: { recordLabel: `{kind|words:${words}}` }, claim: {} }), schema).problems.join('\n'),
    /writes a mask or words/,
  );
});

test('a words mark that is not a map of plain text is not a template', () => {
  assert.ok('problem' in parseLabelTemplate('{kind|words:%7B%22a%22%3A1%7D}'), 'a word that is not text');
  assert.ok('problem' in parseLabelTemplate('{kind|words:not-json}'));
  assert.ok(
    'problem' in parseLabelTemplate(`{kind|words:${encodeURIComponent(JSON.stringify({ a: 'back\\slash' }))}}`),
    'a backslash no engine reads alike',
  );
});

test("a record named by one column says that column's words, as its cell does, and a reference that reaches no row names nothing", async (t) => {
  const { adapter, file, schema } = await clinic(t);
  const served = withLabelTemplates(app({ patient: {}, visit: { recordLabel: 'kind' }, claim: {} }), schema);
  const visit = served.tables.find((table) => table.name === 'visit')!;
  const parsed = parseLabelTemplate(visit.labelTemplate!);
  assert.ok(!('problem' in parsed));
  assert.deepEqual(parsed.paths, ['kind']);
  const claims = withViewLabels(served, textToView(served, 'claim show id, visit_id.$label sort id').view!);
  assert.deepEqual(
    (await adapter.runView(claims)).rows.map((row) => row['visit_id.$label']),
    ['Annual physical', 'Telehealth'],
  );
  // A claim with no visit: no name, not the template's own words around nothing.
  const db = new DatabaseSync(file);
  try {
    db.exec('INSERT INTO claim VALUES (3, NULL)');
  } finally {
    db.close();
  }
  const kept = served.tables.find((table) => table.name === 'patient')!;
  assert.equal(kept.labelTemplate, undefined, 'a name column of its own is read as it is');
  const orphan = withLabelTemplates(app({ patient: {}, visit: { recordLabel: '{patient_id.name} · {kind}' }, claim: {} }), schema);
  const view = withViewLabels(orphan, textToView(orphan, 'claim show id, visit_id.$label sort id').view!);
  assert.deepEqual(
    (await adapter.runView(view)).rows.map((row) => row['visit_id.$label']),
    ['Ada Park · Annual physical', 'Ada Park · Telehealth', null],
  );
});
