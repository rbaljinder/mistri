/**
 * A record's name may fall back: `{nickname ?? name ?? company_id.name}` is the first of its paths with a value, an
 * empty text counting as none. It is computed in the statement like the rest of a template, so a list, a picker and
 * a breadcrumb all read the same answer, and every path in the chain is checked as a lone field is.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { parseAppConfig, resolveResources, withLabelTemplates } from '../packages/mistri/src/shared/app.js';
import { withViewLabels } from '../packages/engine/src/shared/view.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';
import { parseLabelTemplate } from '../packages/engine/src/shared/recordLabel.js';

async function fixture(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-label-fallback-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'f.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE company (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE contact (id INTEGER PRIMARY KEY, nickname TEXT, full_name TEXT, company_id INTEGER REFERENCES company(id));
    CREATE TABLE note (id INTEGER PRIMARY KEY, contact_id INTEGER REFERENCES contact(id));
    INSERT INTO company VALUES (1, 'Acme');
    INSERT INTO contact VALUES (1, 'Bee', 'Beatrice', 1), (2, '', 'Carl', 1), (3, NULL, NULL, 1);
    INSERT INTO note VALUES (1, 1), (2, 2), (3, 3);
  `);
  db.close();
  const adapter = new SqliteAdapter(file, 'f');
  t.after(() => adapter.close());
  return { adapter, schema: await adapter.introspect() };
}

const app = (resources: Record<string, unknown>) =>
  parseAppConfig(
    { name: 'x', resources, views: { notes: { kind: 'list', from: 'note' } }, home: 'notes', nav: ['notes'] },
    'test/app.json',
  );

test('a name falls back to the first path with a value, through a reference too', async (t) => {
  const { adapter, schema } = await fixture(t);
  const authored = app({ company: {}, contact: { recordLabel: '{nickname ?? full_name ?? company_id.name}' }, note: {} });
  const served = withLabelTemplates(authored, schema);
  const view = withViewLabels(served, textToView(served, 'note show id, contact_id.$label sort id').view!);
  assert.deepEqual(
    (await adapter.runView(view)).rows.map((row) => row['contact_id.$label']),
    ['Bee', 'Carl', 'Acme'],
  );
});

test('every path in a chain is checked', async (t) => {
  const { schema } = await fixture(t);
  const bad = resolveResources(app({ company: {}, contact: { recordLabel: '{nickname ?? nope}' }, note: {} }), schema).problems.join('\n');
  assert.match(bad, /nope/);
  const parsed = parseLabelTemplate('{a ?? b ?? c.d} of {e}');
  assert.ok(!('problem' in parsed));
  assert.deepEqual(parsed.paths, ['a', 'b', 'c.d', 'e']);
  assert.ok('problem' in parseLabelTemplate('{a ?? }'));
});
