import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { createAppResources } from '../packages/mistri/src/server/app/appResources.js';
import { createAppSourceAdapter } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';

for (const mode of ['logical', 'default', 'secondary'] as const) {
  test(`${mode}: scoped validation and reverse paths ignore later presentation-catalog mutation`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-scope-catalog-lifetime-'));
    const adapters: SqliteAdapter[] = [];
    t.after(async () => {
      await Promise.all(adapters.map((adapter) => adapter.close()));
      rmSync(directory, { recursive: true, force: true });
    });
    const source = async (name: string) => {
      const path = join(directory, `${name}.db`);
      const db = new DatabaseSync(path);
      db.exec(`CREATE TABLE raw_person(id INTEGER PRIMARY KEY, name TEXT, desk INTEGER);
        CREATE TABLE raw_ticket(id INTEGER PRIMARY KEY, owner INTEGER REFERENCES raw_person(id), desk INTEGER);
        INSERT INTO raw_person VALUES(1, 'Visible', 1), (2, 'Hidden', 2);
        INSERT INTO raw_ticket VALUES(1, 1, 1), (2, 1, 2);`);
      db.close();
      const adapter = new SqliteAdapter(path, name);
      adapters.push(adapter);
      return { adapter, schema: await adapter.introspect(), writable: true, resources: { person: 'raw_person', ticket: 'raw_ticket' } };
    };
    const operations = await source('operations');
    const inventory = await source('inventory');
    const single = createAppResources(operations.adapter, operations.schema, operations.resources);
    const combined = createAppSourceAdapter({ operations, inventory }, 'operations');
    const adapter = mode === 'logical' ? single.adapter : mode === 'default' ? combined.adapter : combined.forSource('inventory');
    const prefix = mode === 'secondary' ? 'inventory.' : '';
    const person = `${prefix}person`;
    const ticket = `${prefix}ticket`;
    const catalog = mode === 'logical' ? single.schema : combined.schema;
    const filter = { groups: [[{ column: 'desk', op: '=' as const, value: 1 }]] };
    const scope = { [person]: filter, [ticket]: filter };
    const view: ViewDef = {
      id: 'scoped',
      name: 'Scoped',
      base: person,
      columns: [{ path: 'id' }],
      aggregates: [{ fn: 'count', via: `${ticket}.owner`, alias: 'tickets' }],
    };
    // The capability is created before public metadata is modified; it may
    // still bind readers lazily after that modification.
    catalog.tables.find((table) => table.id === person)!.columns.length = 0;
    catalog.foreignKeys.length = 0;
    if (mode !== 'logical')
      for (const local of combined.catalogs.values()) {
        local.schema.foreignKeys.length = 0;
        local.schema.tables.find((table) => table.id === 'person')!.columns.length = 0;
      }
    const reads = await adapter.scopeReads!(scope);
    assert.deepEqual((await reads.query({ table: person, limit: 10, offset: 0, columns: ['name'] })).rows, [{ name: 'Visible' }]);
    assert.equal(await reads.count(person), 1);
    assert.deepEqual((await reads.runView(view)).rows, [{ id: 1, tickets: 1 }]);
    assert.equal(await reads.countView(view), 1);
    const grouped = { base: ticket, by: [{ path: 'owner.name' }], measures: [{ fn: 'count' as const }] };
    assert.deepEqual((await reads.runBreakdown(grouped)).rows, [{ 'owner.name': 'Visible', count: 1 }]);
    assert.equal(await reads.countBreakdown(grouped), 1);
  });
}
