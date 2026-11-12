/**
 * `db.<table>.segment(name)` in a command's and a loader's `db` (commandDb.ts): the rows of one of the resource's
 * segments, read as any other read there is — a loader's through the reader's scoped reads, so its row policy and
 * field projection bound it — chained with `.where`, `.orderBy` and `.limit`, and refused by name for a segment the
 * resource does not have or one the handle cannot read.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import type { Condition } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { renamedAnyRows } from '../packages/engine/src/shared/filter.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { commandCatalog, createCommandDb } from '../packages/mistri/src/server/commands/commandDb.js';
import { runPageLoader } from '../packages/mistri/src/server/commands/pageLoaderRun.js';
import { defineLoader } from '../packages/mistri/src/server/commands/pageLoaders.js';

type Row = Record<string, unknown>;
interface Chain extends PromiseLike<Row[]> {
  where(more: unknown): Chain;
  orderBy(column: string, direction?: 'asc' | 'desc'): Chain;
  limit(count: number): Chain;
  first(): Promise<Row | undefined>;
  aggregate(measures: unknown): Promise<Row>;
}
interface Handle {
  segment(name: string): Chain;
  where(text: string): PromiseLike<Row[]>;
}

/* Tickets 1..6. Open: 1 (ana, 50), 2 (ben, 5), 4 (ana, 90), 6 (cy, 20). Urgent open: 1 and 6. Notes: ticket 1 has one. */
const STATEMENTS = [
  'CREATE TABLE ticket (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL, urgency INTEGER NOT NULL, secret TEXT)',
  'CREATE TABLE note (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES ticket (id), body TEXT)',
  "INSERT INTO ticket VALUES (1, 'ana', 'open', 3, 'a'), (2, 'ben', 'open', 1, 'b'), (3, 'ana', 'closed', 3, 'c'), (4, 'ana', 'open', 2, 'd'), (5, 'cy', 'closed', 1, 'e'), (6, 'cy', 'open', 3, 'f')",
  "INSERT INTO note VALUES (1, 1, 'x')",
];
const SEGMENTS = {
  open: 'status = open',
  urgent_open: 'open and urgency >= 3',
  noted: 'any note',
  own: 'owner = me',
  ranked: 'tickets_total > 2',
  broken: 'status = open and',
};

const ids = (rows: readonly Row[]) => rows.map((row) => Number(row.id));

describe('a segment read in a handler and in a loader', () => {
  let directory: string;
  let adapter: SqliteAdapter;
  let schema: DatabaseSchema;
  before(async () => {
    directory = mkdtempSync(join(tmpdir(), 'mistri-segment-reads-'));
    const file = join(directory, 'data.db');
    const db = new DatabaseSync(file);
    for (const statement of STATEMENTS) db.exec(statement);
    db.close();
    adapter = new SqliteAdapter(file, 'segments');
    const found = await adapter.introspect();
    /* The App's catalog carries each resource's segments on its table (appSegments.ts servedSegments). */
    schema = { ...found, tables: found.tables.map((table) => (table.id === 'ticket' ? { ...table, segments: SEGMENTS } : table)) };
  });
  after(async () => {
    await adapter.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /** A command's handles: the raw adapter, the footprint's tables only. */
  const commandDb = (reads: readonly string[]) => {
    const catalog = commandCatalog(schema, reads, (local) => local)!;
    const tx = {
      query: (request: { filter?: never }) =>
        adapter.query({ ...request, filter: renamedAnyRows(request.filter, (local) => local) } as never),
      count: (table: string, filter?: never) =>
        adapter.count(
          table,
          renamedAnyRows(filter, (local) => local),
        ),
      aggregate: (request: never) => adapter.aggregate!(request),
    };
    return createCommandDb({ tx: tx as never, catalog, read: reads, write: [], now: () => new Date() }) as unknown as Record<
      string,
      Handle
    >;
  };

  /** What a loader reads: through the reader's scoped reads, so a row policy and a column grant are already on it. */
  const loaded = async (reads: string[], scope: RowScope, load: (db: Record<string, Handle>) => unknown) => {
    const reader = await adapter.scopeReads(scope);
    return runPageLoader({
      name: 'board',
      loader: defineLoader({ reads, load: async ({ db }: { db: Record<string, Handle> }) => load(db) } as never) as never,
      reader: { query: reader.query, count: reader.count, aggregate: reader.aggregate },
      schema,
      params: {},
      viewer: { roles: [] },
      now: new Date(),
    });
  };

  test("a handler reads a segment's rows, the same rows as its conditions say", async () => {
    const db = commandDb(['ticket']);
    assert.deepEqual(ids(await db.ticket.segment('open')), [1, 2, 4, 6]);
    assert.deepEqual(ids(await db.ticket.where('status = open')), [1, 2, 4, 6]);
    // A segment naming another segment is written out as the language writes it.
    assert.deepEqual(ids(await db.ticket.segment('urgent_open')), [1, 6]);
  });

  test('it chains with where, order and limit, and measures like any read', async () => {
    const db = commandDb(['ticket']);
    assert.deepEqual(ids(await db.ticket.segment('open').where({ owner: 'ana' })), [1, 4]);
    assert.deepEqual(
      ids(
        await db.ticket
          .segment('open')
          .where('owner = ana')
          .where({ urgency: { gte: 3 } }),
      ),
      [1],
    );
    assert.deepEqual(ids(await db.ticket.segment('open').orderBy('urgency', 'desc').orderBy('id', 'desc').limit(3)), [6, 1, 4]);
    assert.equal((await db.ticket.segment('open').orderBy('id', 'desc').first())?.id, 6);
    assert.deepEqual(await db.ticket.segment('open').aggregate({ most: { measure: 'max', column: 'urgency' } }), { most: 3 });
    // A where that matches nothing narrows to nothing.
    assert.deepEqual(await db.ticket.segment('open').where({ owner: [] }), []);
  });

  test('an any in a segment reads the child its handle declares, and only that', async () => {
    assert.deepEqual(ids(await commandDb(['ticket', 'note']).ticket.segment('noted')), [1]);
    assert.throws(() => commandDb(['ticket']).ticket.segment('noted'), /"any note" asks about note, which is not among the tables/);
  });

  test('a name the resource does not have, a segment it cannot read here and a table not read are refused by name', async () => {
    const db = commandDb(['ticket']);
    assert.throws(() => db.ticket.segment('opn'), /"opn" is not a segment of ticket\. Its segments: .*Did you mean "open"\?/);
    assert.throws(() => commandDb(['note']).note.segment('open'), /"open" is not a segment of note\. It has none\./);
    assert.throws(() => db.ticket.segment('ranked'), /the segment "ranked" cannot be read here/);
    assert.throws(() => db.ticket.segment('own'), /the segment "own" cannot be read here/);
    assert.throws(() => db.ticket.segment('broken'), /the segment "broken" cannot be read here/);
    // A table the handle does not read has no handle at all.
    assert.equal((db as Record<string, unknown>).note, undefined);
  });

  test("a loader reads a segment through the reader's row policy, and cannot write through it", async () => {
    const everything: RowScope = { ticket: true, note: true };
    assert.deepEqual(ids((await loaded(['ticket'], everything, (db) => db.ticket.segment('open'))) as Row[]), [1, 2, 4, 6]);
    // The reader sees ana's tickets only: the segment is narrowed by it, never widened.
    const hers: RowScope = { ticket: { groups: [[{ column: 'owner', op: '=', value: 'ana' } as Condition]] } };
    assert.deepEqual(ids((await loaded(['ticket'], hers, (db) => db.ticket.segment('open'))) as Row[]), [1, 4]);
    assert.deepEqual(ids((await loaded(['ticket'], hers, (db) => db.ticket.segment('urgent_open'))) as Row[]), [1]);
    // An `any` in a segment is satisfied only by the child rows the reader may see.
    const noNotes: RowScope = { ticket: true, note: false };
    assert.deepEqual(ids((await loaded(['ticket', 'note'], everything, (db) => db.ticket.segment('noted'))) as Row[]), [1]);
    assert.deepEqual(ids((await loaded(['ticket', 'note'], noNotes, (db) => db.ticket.segment('noted'))) as Row[]), []);
    await assert.rejects(
      loaded(['ticket'], everything, (db) => db.ticket.segment('nope')),
      /is not a segment of ticket/,
    );
  });
});
