import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { WriteConflict, type Filter } from '../packages/engine/src/adapters/adapter.js';
import { parseViewQuery, type ViewDef } from '../packages/engine/src/shared/view.js';
import type { BreakdownDef } from '../packages/engine/src/shared/breakdown.js';

async function withCatalog(run: (adapter: SqliteAdapter) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-sqlite-booleans-'));
  let adapter: SqliteAdapter | undefined;
  try {
    const file = join(directory, 'catalog.db');
    const db = new DatabaseSync(file);
    try {
      db.exec(`
        CREATE TABLE catalog_item (
          id INTEGER PRIMARY KEY, name TEXT, category_id INTEGER,
          active BOOLEAN, approval_required BOOLEAN, note TEXT
        );
        INSERT INTO catalog_item VALUES
          (1, 'Software subscription', 3, 1, 1, NULL),
          (2, 'Retired software', 3, 0, 0, NULL),
          (3, 'Hardware', 1, 1, 1, NULL),
          (4, 'Unspecified software', 3, NULL, NULL, NULL);
      `);
    } finally {
      db.close();
    }
    adapter = new SqliteAdapter(file);
    await run(adapter);
  } finally {
    await adapter?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const active of [true, false]) {
  test(`SQLite binds active=${active} across catalog reads, counts, summaries and explain`, async () => {
    await withCatalog(async (adapter) => {
      const schema = await adapter.introspect();
      const parsed = parseViewQuery(schema, 'catalog_item', `category_id = 3 and active = ${active}`);
      assert.deepEqual(parsed.errors, []);
      const filter: Filter = {
        groups: parsed.filter.groups.map((group) =>
          group.map(({ path, ...condition }) => ({
            column: path,
            ...condition,
          })),
        ),
      };
      const before = structuredClone(filter);
      const expectedId = active ? 1 : 2;
      const result = await adapter.query({ table: 'catalog_item', filter, limit: 100, offset: 0 });
      assert.deepEqual(
        result.rows.map((row) => row.id),
        [expectedId],
      );
      assert.equal(await adapter.count('catalog_item', filter), 1);
      assert.deepEqual(result.sql.params.slice(0, 2), [3, active]);
      assert.deepEqual(filter, before, 'binding does not mutate the portable query');

      const view: ViewDef = {
        id: 'catalog',
        name: 'Catalog',
        base: 'catalog_item',
        columns: [{ path: 'id' }, { path: 'name' }],
        filter: parsed.filter,
      };
      assert.deepEqual(
        (await adapter.runView(view)).rows.map((row) => row.id),
        [expectedId],
      );
      assert.equal(await adapter.countView(view), 1);

      const breakdown: BreakdownDef = {
        base: 'catalog_item',
        by: [{ path: 'category_id' }],
        measures: [{ fn: 'count', alias: 'items' }],
        filter: parsed.filter,
      };
      assert.deepEqual((await adapter.runBreakdown(breakdown)).rows, [{ category_id: 3, items: 1 }]);
      assert.equal(await adapter.countBreakdown(breakdown), 1);
      assert.ok((await adapter.explainSql(result.sql)).plan.length > 0);
    });
  });
}

test('SQLite binds boolean inserts and updates without weakening optimistic guards', async () => {
  await withCatalog(async (adapter) => {
    const inserted = await adapter.insert({
      table: 'catalog_item',
      values: { name: 'New software', category_id: 3, active: true, approval_required: 'false', note: null },
    });
    assert.ok(inserted.row);
    assert.equal(inserted.row.active, 1);
    assert.equal(inserted.row.approval_required, 0);
    assert.equal(inserted.row.note, null);
    assert.equal(inserted.applied.active, true);
    assert.equal(inserted.applied.approval_required, false);

    const updated = await adapter.update({
      table: 'catalog_item',
      key: inserted.key,
      values: { active: false, approval_required: 'true' },
      expected: { active: true, approval_required: false },
    });
    assert.equal(updated.affected, 1);
    await assert.rejects(
      adapter.update({
        table: 'catalog_item',
        key: inserted.key,
        values: { active: true },
        expected: { active: true },
      }),
      WriteConflict,
    );
    const saved = await adapter.query({
      limit: 100,
      offset: 0,
      table: 'catalog_item',
      filter: { groups: [[{ column: 'id', op: '=', value: inserted.key.id }]] },
    });
    assert.equal(saved.rows[0].active, 0);
    assert.equal(saved.rows[0].approval_required, 1);
    assert.equal((await adapter.remove({ table: 'catalog_item', key: inserted.key })).affected, 1);
  });
});
