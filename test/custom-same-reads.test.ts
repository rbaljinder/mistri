/**
 * A custom section's rows may say `same`, as a related list does: the rows that share a column's value with the
 * record the page is on, the record itself left out. Planned from values the server reads off the record's row.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { parsePagesConfig, validatePage, type PageDef } from '../packages/engine/src/shared/page.js';
import { planPageSections } from '../packages/engine/src/shared/pagePlans.js';

const widget = { id: 'alike', module: './widgets/Alike.tsx', kind: 'section' };
const page = (rows: object): PageDef =>
  parsePagesConfig(
    { pages: [{ id: 'account', base: 'account', label: 'Account', sections: [{ kind: 'custom', component: widget, rows }] }] },
    'fixture',
  )[0];

async function database(t: { after(run: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-same-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'crm.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL, region TEXT);
    INSERT INTO account VALUES (1, 'Ada', 'east'), (2, 'Grace', 'east'), (3, 'Linus', 'west');`);
  db.close();
  const adapter = new SqliteAdapter(file, 'crm');
  t.after(() => adapter.close());
  return { adapter, schema: await adapter.introspect() };
}

test('a read says `same`: parsed beside no `whose`, held to a few different columns', () => {
  const read = page({ alike: { from: 'account', same: ['region'], show: ['name'] } }).sections[0] as unknown as {
    reads: Record<string, { similar?: { same: string[] }; path?: string }>;
  };
  assert.deepEqual(read.reads.alike.similar, { same: ['region'] });
  assert.equal(read.reads.alike.path, undefined);
  assert.throws(() => page({ a: { from: 'account', same: ['region'], whose: 'id', show: ['name'] } }), /"whose" beside "same"/);
  assert.throws(() => page({ a: { from: 'account', same: [], show: ['name'] } }), /"same" must be/);
  assert.throws(() => page({ a: { from: 'account', same: ['region', 'region'], show: ['name'] } }), /"same" must be/);
});

test("a read of `same` is judged against the catalog, then plans the rows that share the record's value without the record", async (t) => {
  const { adapter, schema } = await database(t);
  assert.match(validatePage(schema, page({ a: { from: 'account', same: ['regoin'], show: ['name'] } })).error ?? '', /rows "a".*"regoin"/);
  const definition = validatePage(schema, page({ alike: { from: 'account', same: ['region'], show: ['name'] } }));
  assert.equal(definition.error, undefined);
  const [plan] = planPageSections(schema, definition, { id: 1 }, {}, new Date(), { region: 'east' });
  const view = (plan as unknown as { reads: Record<string, { view?: Parameters<NonNullable<typeof adapter.runView>>[0]; error?: string }> })
    .reads.alike;
  assert.equal(view.error, undefined);
  const result = await adapter.runView!(view.view!);
  assert.deepEqual(
    result.rows.map((row) => row.name),
    ['Grace'],
  );
  // A record with no value to share leaves the read empty rather than matching everything.
  const [blank] = planPageSections(schema, definition, { id: 1 }, {}, new Date(), { region: null });
  assert.equal((blank as unknown as { reads: Record<string, { empty?: boolean }> }).reads.alike.empty, true);
});
