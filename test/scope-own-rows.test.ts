/**
 * A transaction that makes a parent and then its children, under a row scope
 * resolved before the parent existed (scopedTransaction.ts ScopeOwnRows).
 *
 * Lintel-shaped: a resident reads their own repairs (`resident_id = 1`) and the
 * messages on them (`request_id in [...]`, never the office's internal ones).
 * Filing a repair with its first message in one write used to be refused: the
 * message's request was not in the list resolved at the start. Proved on
 * SQLite, and on PostgreSQL when `TABLEWALK_TEST_PG` names a disposable one.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { Refusal, type Filter, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

interface Engine {
  scopeTransaction<T>(scope: RowScope, run: (tx: WriteTransaction) => Promise<T>): Promise<T>;
  count(table: string): Promise<number>;
}
type Tables = { resident: string; request: string; note: string; part: string };

/* The resident's rows as Lintel's policy resolves them: their repairs, and the messages and parts on the repairs
   that existed when the request began (only 10 here; 20 is a neighbor's). */
const household = (t: Tables, partRule: RowScope[string] = { groups: [[{ column: 'request_id', op: 'in', value: [10] }]] }): RowScope => ({
  [t.resident]: { groups: [[{ column: 'id', op: '=', value: 1 }]] },
  [t.request]: { groups: [[{ column: 'resident_id', op: '=', value: 1 }]] },
  [t.note]: {
    groups: [
      [
        { column: 'request_id', op: 'in', value: [10] },
        { column: 'kind', op: '!=', value: 'internal' },
      ],
    ],
  },
  [t.part]: partRule,
});
const key = (id: unknown): Filter => ({ groups: [[{ column: 'id', op: '=', value: id as number }]] });

function proofs(name: string, open: () => Promise<{ engine: Engine; tables: Tables; close(): Promise<void> }>) {
  describe(name, () => {
    const run = async (body: (engine: Engine, t: Tables) => Promise<void>) => {
      const { engine, tables, close } = await open();
      try {
        await body(engine, tables);
      } finally {
        await close();
      }
    };

    test('a repair and its first message, filed in one write, both land', () =>
      run(async (engine, t) => {
        await engine.scopeTransaction(household(t), async (tx) => {
          const request = await tx.insert({ table: t.request, values: { resident_id: 1, title: 'Sink drips' } });
          const note = await tx.insert({ table: t.note, values: { request_id: request.key.id, kind: 'resident', body: 'Since Monday' } });
          // The new message is the resident's to read back and correct in the same write.
          assert.equal((await tx.query({ table: t.note, filter: key(note.key.id), limit: 2, offset: 0 })).rows.length, 1);
          await tx.update({ table: t.note, key: note.key, values: { body: 'Since Sunday' } });
        });
        assert.equal(await engine.count(t.note), 3);
      }));

    test('every other condition of the child rule still holds: an internal note on the new repair is refused', () =>
      run(async (engine, t) => {
        await assert.rejects(
          engine.scopeTransaction(household(t), async (tx) => {
            const request = await tx.insert({ table: t.request, values: { resident_id: 1, title: 'Sink drips' } });
            await tx.insert({ table: t.note, values: { request_id: request.key.id, kind: 'internal', body: 'Tenant again' } });
          }),
          Refusal,
        );
        assert.equal(await engine.count(t.note), 2);
      }));

    test('a parent the principal did not make in this write gains nothing, and a rule of false stays false', () =>
      run(async (engine, t) => {
        // The neighbor's repair, made before: still outside.
        await assert.rejects(
          engine.scopeTransaction(household(t), async (tx) => {
            await tx.insert({ table: t.request, values: { resident_id: 1, title: 'Sink drips' } });
            await tx.insert({ table: t.note, values: { request_id: 20, kind: 'resident', body: 'Me too' } });
          }),
          Refusal,
        );
        // A table the policy closes is not opened by a new parent.
        await assert.rejects(
          engine.scopeTransaction(household(t, false), async (tx) => {
            const request = await tx.insert({ table: t.request, values: { resident_id: 1, title: 'Sink drips' } });
            await tx.insert({ table: t.part, values: { request_id: request.key.id, quantity: 1 } });
          }),
          Refusal,
        );
        // A parent made outside the principal's rows (the tenant bound's case) is not one of theirs.
        await assert.rejects(
          engine.scopeTransaction(household(t), async (tx) => {
            const request = await tx.insert({ table: t.request, values: { resident_id: 2, title: 'Not mine' } });
            await tx.insert({ table: t.note, values: { request_id: request.key.id, kind: 'resident', body: 'x' } });
          }),
          Refusal,
        );
        assert.equal(await engine.count(t.request), 2);
        assert.equal(await engine.count(t.note), 2);
      }));
  });
}

proofs('own rows on SQLite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-own-rows-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE resident (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE request (id INTEGER PRIMARY KEY, resident_id INTEGER NOT NULL REFERENCES resident(id), title TEXT NOT NULL);
    CREATE TABLE note (id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES request(id), kind TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE part (id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES request(id), quantity INTEGER NOT NULL);
    INSERT INTO resident VALUES (1, 'Ana'), (2, 'Ben');
    INSERT INTO request VALUES (10, 1, 'Heat'), (20, 2, 'Door');
    INSERT INTO note VALUES (100, 10, 'resident', 'Cold'), (200, 20, 'resident', 'Stuck');
  `);
  db.close();
  const adapter = new SqliteAdapter(file);
  return {
    tables: { resident: 'resident', request: 'request', note: 'note', part: 'part' },
    engine: {
      scopeTransaction: (scope, run) => adapter.scopeTransaction(scope, run),
      count: async (table) => adapter.count(table),
    },
    async close() {
      await adapter.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
});

describe('own rows on PostgreSQL', { skip: liveSkip('postgres', LIVE) }, () => {
  proofs('against a real server', async () => {
    const specifier = 'pg';
    const pg = (await import(specifier)) as { default?: { Client: never }; Client?: never };
    const Client = (pg.Client ?? pg.default?.Client)! as new (c: unknown) => {
      connect(): Promise<void>;
      query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
      end(): Promise<void>;
    };
    const control = new Client({ connectionString: LIVE, statement_timeout: 10_000 });
    await control.connect();
    const drop = 'DROP TABLE IF EXISTS public.own_part, public.own_note, public.own_request, public.own_resident CASCADE';
    await control.query(drop);
    await control.query(`
      CREATE TABLE public.own_resident (id integer PRIMARY KEY, name text NOT NULL);
      CREATE TABLE public.own_request (id serial PRIMARY KEY, resident_id integer NOT NULL REFERENCES public.own_resident (id), title text NOT NULL);
      CREATE TABLE public.own_note (id serial PRIMARY KEY, request_id integer NOT NULL REFERENCES public.own_request (id), kind text NOT NULL, body text NOT NULL);
      CREATE TABLE public.own_part (id serial PRIMARY KEY, request_id integer NOT NULL REFERENCES public.own_request (id), quantity integer NOT NULL);
      INSERT INTO public.own_resident VALUES (1, 'Ana'), (2, 'Ben');
      INSERT INTO public.own_request VALUES (10, 1, 'Heat'), (20, 2, 'Door');
      INSERT INTO public.own_note VALUES (100, 10, 'resident', 'Cold'), (200, 20, 'resident', 'Stuck');
      SELECT setval('public.own_request_id_seq', 100);
      SELECT setval('public.own_note_id_seq', 1000);
    `);
    const adapter = new PostgresAdapter(LIVE!, 'own rows proof', ['public']);
    return {
      tables: { resident: 'public.own_resident', request: 'public.own_request', note: 'public.own_note', part: 'public.own_part' },
      engine: {
        scopeTransaction: (scope, run) => adapter.scopeTransaction(scope, run),
        count: async (table) => Number((await control.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n),
      },
      async close() {
        await adapter.close();
        await control.query(drop);
        await control.end();
      },
    };
  });
});
