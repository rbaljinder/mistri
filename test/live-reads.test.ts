/**
 * The `mistri-reads` header's tables (liveReads.ts): a superset of what a
 * read answers from, never a table outside the served schema, and nothing at
 * all where the read's base is not served.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { READS_HEADER, readTables, trackingReads } from '../packages/mistri/src/server/live/liveReads.js';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import { captureTenantData } from '../packages/engine/src/server/evidence.js';
import type { ServerResponse } from 'node:http';

test('a read names its base, the paths it walks, the records its labels name and the rows that point at it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-live-reads-'));
  const path = join(dir, 'data.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE region(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE customer(id INTEGER PRIMARY KEY, name TEXT, region_id INTEGER REFERENCES region(id));
    CREATE TABLE invoice(id INTEGER PRIMARY KEY, total REAL, customer_id INTEGER REFERENCES customer(id));
    CREATE TABLE invoice_line(id INTEGER PRIMARY KEY, invoice_id INTEGER REFERENCES invoice(id), amount REAL);
    CREATE TABLE audit(id INTEGER PRIMARY KEY, note TEXT);`);
  db.close();
  const adapter = new SqliteAdapter(path);
  try {
    const schema = await adapter.introspect();
    // Its own columns: the base, the customer its label names, the lines an aggregate or `has` may count.
    assert.deepEqual(readTables(schema, 'invoice', { table: 'invoice', columns: ['id', 'total'] }), [
      'customer',
      'invoice',
      'invoice_line',
    ]);
    // A path two references deep names every table it walks.
    assert.deepEqual(readTables(schema, 'invoice', { table: 'invoice', columns: ['customer_id.region_id.name'] }), [
      'customer',
      'invoice',
      'invoice_line',
      'region',
    ]);
    // An unrelated table is never named; an unserved base names nothing, and the page falls back to its family's rule.
    assert.ok(!readTables(schema, 'invoice', null)!.includes('audit'));
    assert.deepEqual(readTables(schema, 'audit', { filter: { groups: [[{ column: 'note', op: '=', value: 'a.b' }]] } }), ['audit']);
    assert.equal(readTables(schema, 'missing', null), undefined);
    // Only what the reader is served: the same read against a schema without the customer table does not name it.
    const narrowed = {
      ...schema,
      tables: schema.tables.filter((table) => table.id !== 'customer'),
      foreignKeys: schema.foreignKeys.filter((fk) => fk.from.table !== 'customer' && fk.to.table !== 'customer'),
    };
    assert.deepEqual(readTables(narrowed, 'invoice', null), ['invoice', 'invoice_line']);
    /* Over a captured catalog (a tenant's served one) the answer is kept by its names: the same answer again, each
       caller its own list, and a narrower capture answered for itself. */
    const captured = captureTenantData(schema),
      capturedNarrow = captureTenantData(narrowed),
      asked = { table: 'invoice', columns: ['customer_id.region_id.name'] };
    const once = readTables(captured, 'invoice', asked)!;
    once.push('audit');
    assert.deepEqual(readTables(captured, 'invoice', asked), ['customer', 'invoice', 'invoice_line', 'region']);
    assert.deepEqual(readTables(capturedNarrow, 'invoice', null), ['invoice', 'invoice_line']);
    assert.deepEqual(readTables(captured, 'invoice', null), ['customer', 'invoice', 'invoice_line']);
  } finally {
    await adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a frozen reader, as a row policy hands out, is read through and its reads are filed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-live-reads-'));
  const path = join(dir, 'data.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE vehicle(id INTEGER PRIMARY KEY, make TEXT); INSERT INTO vehicle(make) VALUES ('Toyota');`);
  db.close();
  const adapter = new SqliteAdapter(path);
  try {
    const schema = await adapter.introspect();
    /* appPolicyContext.ts freezes the policy's data; a proxy standing on it had to return each method as it is, so
       wrapping one threw ("read-only and non-configurable data property") and every public read was a 500. */
    const frozen = Object.freeze({
      query: (request: Parameters<Adapter['query']>[0]) => adapter.query(request),
      runView: () => Promise.resolve({ rows: [{ id: 1 }] }),
    }) as unknown as Adapter;
    const headers = new Map<string, string>();
    const reply = {
      headersSent: false,
      setHeader: (name: string, value: string) => headers.set(name, value),
      removeHeader: (name: string) => headers.delete(name),
    } as unknown as ServerResponse;
    const reader = trackingReads(frozen, schema, reply);
    const page = await reader.query({ table: 'vehicle', columns: ['id', 'make'] } as Parameters<Adapter['query']>[0]);
    assert.equal(page.rows.length, 1);
    assert.deepEqual(await reader.runView!({ base: 'vehicle' } as never, 0), { rows: [{ id: 1 }] });
    assert.equal(headers.get(READS_HEADER), 'vehicle');
    assert.ok('query' in reader);
    assert.deepEqual(Object.keys(reader).sort(), ['query', 'runView']);
  } finally {
    await adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
