/**
 * Row-scoped transactions on PostgreSQL, against a real server.
 *
 * `row-scope-transaction.test.ts` proves the scoped writer on SQLite, where
 * `BEGIN IMMEDIATE` makes "the row the scope checked is the row the write
 * changed" trivially true. This file proves the same contract where it is
 * not trivial: READ COMMITTED with explicit row locks, a catalog attested on
 * the writer inside the transaction after its tables are pinned against
 * DDL, fail-stop poisoning, the unknown-outcome rule, and scoped business
 * commands composed with the PostgreSQL journal.
 *
 * Live and opt-in like postgres-command-journal.test.ts: `TABLEWALK_TEST_PG`
 * names a disposable database this file may reset, and
 * `TABLEWALK_REQUIRE_LIVE=1` turns a missing server into a failure. It drops
 * and recreates its own tables in `public`, so point it at nothing you keep.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  Refusal,
  TransactionOutcomeUnknown,
  type Filter,
  type QueryRequest,
  type WriteTransaction,
} from '../packages/engine/src/adapters/adapter.js';
import {
  COMMAND_JOURNAL_TABLES as journal,
  CommandJournalUnavailable,
  CommandTransactionFailure,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { postgresAuditRows } from './support/commandTargets.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { PgConnectionManager, PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.js';
import { createAppResources } from '../packages/mistri/src/server/app/appResources.js';
import type { RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import {
  BusinessCommandExecutionError,
  executeBusinessCommand,
  lookupBusinessCommandStatus,
} from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { bindScopedBusinessCommands } from '../packages/mistri/src/server/commands/scopedBusinessCommandAccess.js';
import { parseAppConfig, physicalBindings } from '../packages/mistri/src/shared/app.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { assertScopeCatalog, mapScopeCatalog } from '../packages/engine/src/shared/scopeCatalog.js';
import { isRuntimeTable, runtimeName, runtimeSchema, runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { liveSkip } from './live.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
async function client(): Promise<Control> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
  const Client = (pg.Client ?? pg.default?.Client)!;
  const created = new Client({ connectionString: LIVE, statement_timeout: 10_000 });
  await created.connect();
  return created;
}

const ITEM = 'public.scoped_item';
const OWNER = 'public.scoped_owner';
const eq = (column: string, value: string | number | boolean): Filter => ({ groups: [[{ column, op: '=', value }]] });
const page = (table = ITEM, extra: Partial<QueryRequest> = {}): QueryRequest => ({ table, limit: 20, offset: 0, ...extra });
const rowsA = (): RowScope => ({ [ITEM]: eq('tenant', 'a'), [OWNER]: eq('tenant', 'a') });
const ids = new Map([
  [ITEM, ITEM],
  [OWNER, OWNER],
]);

const RESET = [
  `DROP TABLE IF EXISTS public.scoped_item, public.scoped_owner CASCADE`,
  `DROP SCHEMA IF EXISTS mistri CASCADE`,
  `DROP FUNCTION IF EXISTS public.scoped_noop()`,
];
const SETUP = [
  `CREATE TABLE public.scoped_owner (id integer PRIMARY KEY, tenant text NOT NULL, code text UNIQUE, name text)`,
  `CREATE TABLE public.scoped_item (
     id integer PRIMARY KEY, tenant text NOT NULL DEFAULT 'a', name text DEFAULT 'New',
     owner_id integer DEFAULT 1 REFERENCES public.scoped_owner (id), version integer NOT NULL DEFAULT 0,
     active boolean DEFAULT true)`,
  `INSERT INTO public.scoped_owner VALUES (1, 'a', 'A', 'Alice'), (2, 'b', 'B', 'Bob')`,
  `INSERT INTO public.scoped_item (id, tenant, name, owner_id) VALUES
     (1, 'a', 'Alpha', 1), (2, 'b', 'Beta', 2), (3, 'a', 'Hidden parent', 2)`,
  `CREATE FUNCTION public.scoped_noop() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`,
];

/** Whether a promise settles within the window; a lock that holds does not. */
async function settles(promise: Promise<unknown>, ms = 400): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('row-scoped transactions on PostgreSQL, against a real server', { skip: liveSkip('postgres', LIVE) }, () => {
  let control: Control;
  const item = async (id: number) => (await control.query('SELECT * FROM public.scoped_item WHERE id = $1', [id])).rows[0];
  const items = async () => (await control.query('SELECT id, tenant, name, owner_id, version FROM public.scoped_item ORDER BY id')).rows;
  // A table by name, or a subquery (the receipt's targets, test/support/commandTargets.ts).
  const count = async (table: string) =>
    Number(
      (
        await control.query(
          `SELECT count(*) AS n FROM ${table.startsWith('(') ? `${table} t` : isRuntimeTable(table) ? runtimeTable('postgres', table) : `public."${table}"`}`,
        )
      ).rows[0].n,
    );
  const reset = async () => {
    for (const statement of [...RESET, ...SETUP]) await control.query(statement);
  };

  before(async () => {
    control = await client();
  });
  after(async () => {
    for (const statement of RESET) await control.query(statement).catch(() => {});
    await control.end();
  });

  async function withAdapter<T>(run: (adapter: PostgresAdapter) => Promise<T>): Promise<T> {
    await reset();
    const adapter = new PostgresAdapter(LIVE!, 'scoped proof', ['public']);
    try {
      return await run(adapter);
    } finally {
      await adapter.close();
    }
  }

  /* ---------- the facade and its scope ---------- */

  test('scoped transactions expose only transaction methods, read through the scope and return the callback value', async () => {
    await withAdapter(async (adapter) => {
      assert.equal(typeof adapter.scopeTransaction, 'function');
      assert.equal(typeof commandsOf(adapter).scopeCommandTransaction, 'function');
      const result = await adapter.scopeTransaction(rowsA(), async (tx, evidence) => {
        assert.deepEqual(Object.keys(tx).sort(), ['count', 'insert', 'query', 'remove', 'update']);
        assert.ok(Object.isFrozen(evidence));
        assert.equal(evidence.dialect, 'postgres');
        assert.equal(await tx.count(ITEM), 2);
        assert.deepEqual((await tx.query(page(ITEM, { columns: ['id'], filter: eq('id', 2) }))).rows, []);
        assert.equal(await tx.count(OWNER, eq('id', 2)), 0);
        return { accepted: true };
      });
      assert.deepEqual(result, { accepted: true });
      assert.equal(await count('scoped_item'), 3);
    });
  });

  test('scoped update, insert and delete inside the scope commit, and reads inside see them', async () => {
    await withAdapter(async (adapter) => {
      await adapter.scopeTransaction(rowsA(), async (tx) => {
        const inserted = await tx.insert({ table: ITEM, values: { id: 4, name: 'Inserted' } });
        assert.deepEqual(inserted.key, { id: 4 });
        assert.equal(inserted.row?.tenant, 'a');
        const updated = await tx.update({ table: ITEM, key: { id: 1 }, values: { name: 'Renamed' }, expected: { name: 'Alpha' } });
        assert.equal(updated.affected, 1);
        assert.equal((await tx.remove({ table: ITEM, key: { id: 3 } })).affected, 1);
        assert.deepEqual((await tx.query(page(ITEM, { columns: ['id', 'name'], orderBy: [{ column: 'id', direction: 'asc' }] }))).rows, [
          { id: 1, name: 'Renamed' },
          { id: 4, name: 'Inserted' },
        ]);
        assert.equal(await tx.count(ITEM), 2);
      });
      assert.deepEqual(await items(), [
        { id: 1, tenant: 'a', name: 'Renamed', owner_id: 1, version: 0 },
        { id: 2, tenant: 'b', name: 'Beta', owner_id: 2, version: 0 },
        { id: 4, tenant: 'a', name: 'Inserted', owner_id: 1, version: 0 },
      ]);
    });
  });

  for (const [label, write] of [
    ['updating a hidden row', (tx: WriteTransaction) => tx.update({ table: ITEM, key: { id: 2 }, values: { name: 'Taken' } })],
    ['deleting a hidden row', (tx: WriteTransaction) => tx.remove({ table: ITEM, key: { id: 2 } })],
    ['inserting a row that escapes the scope', (tx: WriteTransaction) => tx.insert({ table: ITEM, values: { id: 5, tenant: 'b' } })],
    ['moving a visible row out of scope', (tx: WriteTransaction) => tx.update({ table: ITEM, key: { id: 1 }, values: { tenant: 'b' } })],
    [
      'pointing a visible row at a hidden parent',
      (tx: WriteTransaction) => tx.update({ table: ITEM, key: { id: 1 }, values: { owner_id: 2 } }),
    ],
    ['inserting under a hidden parent', (tx: WriteTransaction) => tx.insert({ table: ITEM, values: { id: 5, owner_id: 2 } })],
    ['deleting a parent with incoming keys', (tx: WriteTransaction) => tx.remove({ table: OWNER, key: { id: 1 } })],
    ['editing a referenced key column', (tx: WriteTransaction) => tx.update({ table: OWNER, key: { id: 1 }, values: { id: 1 } })],
  ] as const) {
    test(`${label} refuses, and a caught refusal poisons the transaction so earlier writes roll back`, async () => {
      await withAdapter(async (adapter) => {
        const before = await items();
        let later: Promise<unknown> | undefined;
        await assert.rejects(
          adapter.scopeTransaction(rowsA(), async (tx) => {
            await tx.insert({ table: ITEM, values: { id: 9, name: 'Rolled back' } });
            await assert.rejects(write(tx), Refusal);
            // The poisoned queue reports the failure that poisoned it.
            later = tx.query(page());
            await assert.rejects(later, Refusal);
            return 'must not commit';
          }),
          Refusal,
        );
        assert.deepEqual(await items(), before);
        assert.equal(await count('scoped_owner'), 2);
      });
    });
  }

  /* ---------- the current row under concurrency ---------- */

  test('a row another writer moved out of scope before the write is refused against its current version', async () => {
    await withAdapter(async (adapter) => {
      await assert.rejects(
        adapter.scopeTransaction(rowsA(), async (tx) => {
          assert.equal((await tx.query(page(ITEM, { filter: eq('id', 1) }))).rows.length, 1);
          await control.query(`UPDATE public.scoped_item SET tenant = 'b' WHERE id = 1`);
          await tx.update({ table: ITEM, key: { id: 1 }, values: { name: 'Stale' } });
        }),
        Refusal,
      );
      assert.deepEqual(await item(1), { id: 1, tenant: 'b', name: 'Alpha', owner_id: 1, version: 0, active: true });
    });
  });

  test('a write waits for a concurrent holder of its row, then checks the version that holder committed', async () => {
    await withAdapter(async (adapter) => {
      await control.query('BEGIN');
      await control.query(`UPDATE public.scoped_item SET tenant = 'b' WHERE id = 1`);
      const seen: string[] = [];
      const pending = adapter.scopeTransaction(rowsA(), async (tx) => {
        // Committed state still shows the row; the write must not trust that.
        assert.equal((await tx.query(page(ITEM, { filter: eq('id', 1) }))).rows.length, 1);
        seen.push('read');
        await tx.update({ table: ITEM, key: { id: 1 }, values: { name: 'Overwritten' } });
        seen.push('written');
      });
      assert.equal(await settles(pending), false, 'the scoped write must block on the held row');
      assert.deepEqual(seen, ['read']);
      await control.query('COMMIT');
      await assert.rejects(pending, Refusal);
      assert.deepEqual(seen, ['read']);
      assert.deepEqual(await item(1), { id: 1, tenant: 'b', name: 'Alpha', owner_id: 1, version: 0, active: true });
    });
  });

  test('a concurrent writer waits for the scoped row lock, and parents are held so they cannot leave the scope', async () => {
    await withAdapter(async (adapter) => {
      const hold = gate();
      let parentMove: Promise<unknown> | undefined;
      let targetMove: Promise<unknown> | undefined;
      const scoped = adapter.scopeTransaction(rowsA(), async (tx) => {
        await tx.update({ table: ITEM, key: { id: 1 }, values: { name: 'Held' } });
        await tx.insert({ table: ITEM, values: { id: 6, owner_id: 1 } });
        targetMove = control.query(`UPDATE public.scoped_item SET tenant = 'b' WHERE id = 1`);
        assert.equal(await settles(targetMove), false, 'the target row is locked until commit');
        await hold.promise;
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      // The target lock is held by `control` now, queued behind ours; a second
      // control statement would queue behind it, so the parent is proven with
      // a separate session.
      const other = await client();
      try {
        parentMove = other.query(`UPDATE public.scoped_owner SET tenant = 'b' WHERE id = 1`);
        assert.equal(await settles(parentMove), false, 'the checked parent is held until commit');
        hold.release();
        await scoped;
        await targetMove;
        await parentMove;
      } finally {
        await other.end();
      }
      assert.deepEqual(await item(1), { id: 1, tenant: 'b', name: 'Held', owner_id: 1, version: 0, active: true });
      assert.equal((await item(6)).owner_id, 1);
      assert.equal((await control.query('SELECT tenant FROM public.scoped_owner WHERE id = 1')).rows[0].tenant, 'b');
    });
  });

  /* ---------- attestation ---------- */

  test('the evidence is the deployed catalog, and every kind of mapped DDL drift refuses before the callback writes', async () => {
    const expected = await withAdapter(async (adapter) => mapScopeCatalog(await adapter.introspect(), ids));
    await withAdapter(async (adapter) => {
      await adapter.scopeTransaction(rowsA(), async (_tx, evidence) => {
        assertScopeCatalog(expected, mapScopeCatalog(evidence, ids));
      });
    });
    const drifts: Array<[string, string]> = [
      ['an added column', `ALTER TABLE public.scoped_item ADD COLUMN extra text`],
      ['a dropped column', `ALTER TABLE public.scoped_item DROP COLUMN active`],
      ['a changed type', `ALTER TABLE public.scoped_item ALTER COLUMN name TYPE varchar(20)`],
      ['a changed nullability', `ALTER TABLE public.scoped_item ALTER COLUMN name SET NOT NULL`],
      ['a changed default', `ALTER TABLE public.scoped_item ALTER COLUMN tenant SET DEFAULT 'b'`],
      ['a renamed column', `ALTER TABLE public.scoped_owner RENAME COLUMN code TO reference`],
      ['a dropped foreign key', `ALTER TABLE public.scoped_item DROP CONSTRAINT scoped_item_owner_id_fkey`],
      ['an added foreign key', `ALTER TABLE public.scoped_owner ADD COLUMN favourite integer REFERENCES public.scoped_item (id)`],
      [
        'a changed delete rule',
        `ALTER TABLE public.scoped_item DROP CONSTRAINT scoped_item_owner_id_fkey,
        ADD CONSTRAINT scoped_item_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.scoped_owner (id) ON DELETE CASCADE`,
      ],
      ['a dropped primary key', `ALTER TABLE public.scoped_owner DROP CONSTRAINT scoped_owner_pkey CASCADE`],
      ['a replaced table', `DROP TABLE public.scoped_item; CREATE TABLE public.scoped_item (id integer PRIMARY KEY, tenant text NOT NULL)`],
    ];
    for (const [name, ddl] of drifts) {
      await withAdapter(async (adapter) => {
        await control.query(ddl);
        let called = false;
        await assert.rejects(
          adapter.scopeTransaction(rowsA(), async (tx, evidence) => {
            assertScopeCatalog(expected, mapScopeCatalog(evidence, ids));
            called = true;
            await tx.update({ table: ITEM, key: { id: 1 }, values: { name: 'Drifted' } });
          }),
          Refusal,
          name,
        );
        assert.equal(called, false, name);
        assert.notEqual((await item(1))?.name, 'Drifted', name);
      });
    }
  });

  for (const [name, ddl] of [
    ['a trigger', `CREATE TRIGGER scoped_guard BEFORE UPDATE ON public.scoped_item FOR EACH ROW EXECUTE FUNCTION public.scoped_noop()`],
    ['a rule', `CREATE RULE scoped_rule AS ON DELETE TO public.scoped_item DO INSTEAD NOTHING`],
    ['row security', `ALTER TABLE public.scoped_item ENABLE ROW LEVEL SECURITY`],
    ['a policy', `CREATE POLICY scoped_policy ON public.scoped_item USING (true)`],
  ] as const) {
    test(`${name} on the target keeps attestation true but makes every write refuse`, async () => {
      const expected = await withAdapter(async (adapter) => mapScopeCatalog(await adapter.introspect(), ids));
      await withAdapter(async (adapter) => {
        await control.query(ddl);
        const before = await items();
        for (const write of [
          (tx: WriteTransaction) => tx.update({ table: ITEM, key: { id: 1 }, values: { name: 'Blocked' } }),
          (tx: WriteTransaction) => tx.insert({ table: ITEM, values: { id: 7 } }),
          (tx: WriteTransaction) => tx.remove({ table: ITEM, key: { id: 1 } }),
        ]) {
          await assert.rejects(
            adapter.scopeTransaction(rowsA(), async (tx, evidence) => {
              assertScopeCatalog(expected, mapScopeCatalog(evidence, ids));
              assert.equal(await tx.count(ITEM), 2, 'reads still work');
              await write(tx);
            }),
            Refusal,
          );
        }
        assert.deepEqual(await items(), before);
      });
    });
  }

  /* One adapter describes the catalog again only when the catalog digest has
     moved (PostgresAdapter.describeScoped). What must hold is that a change
     made after a transaction primed the kept description is still seen by
     the next one on the same adapter: every drift above, one adapter each
     time, after a transaction that kept the description it would refuse. */
  test('a kept catalog description is reused while nothing changed, and every mapped drift still refuses on the same adapter', async (t) => {
    const expected = await withAdapter(async (adapter) => mapScopeCatalog(await adapter.introspect(), ids));
    const proto = PostgresAdapter.prototype as unknown as { describe(db: PgQuery): Promise<unknown> };
    let described = 0;
    const original = proto.describe;
    t.mock.method(proto, 'describe', function (this: unknown, db: PgQuery) {
      described++;
      return original.call(this, db);
    });
    const primed = (adapter: PostgresAdapter) =>
      adapter.scopeTransaction(rowsA(), async (_tx, evidence) => {
        assertScopeCatalog(expected, mapScopeCatalog(evidence, ids));
      });
    await withAdapter(async (adapter) => {
      await primed(adapter);
      const first = described;
      await primed(adapter);
      await primed(adapter);
      assert.equal(described, first, 'an unchanged catalog is not described again');
      // ANALYZE and a comment move nothing the description is evidence of.
      await control.query(`ANALYZE public.scoped_item; COMMENT ON TABLE public.scoped_item IS 'still the same'`);
      await primed(adapter);
      assert.equal(described, first, 'nor do ANALYZE and a comment');
    });
    for (const ddl of [
      `ALTER TABLE public.scoped_item ADD COLUMN extra text`,
      `ALTER TABLE public.scoped_item ALTER COLUMN tenant SET DEFAULT 'b'`,
      `ALTER TABLE public.scoped_owner RENAME COLUMN code TO reference`,
      `ALTER TABLE public.scoped_item DROP CONSTRAINT scoped_item_owner_id_fkey`,
    ]) {
      await withAdapter(async (adapter) => {
        await primed(adapter);
        await control.query(ddl);
        let called = false;
        await assert.rejects(
          adapter.scopeTransaction(rowsA(), async (tx, evidence) => {
            assertScopeCatalog(expected, mapScopeCatalog(evidence, ids));
            called = true;
            await tx.update({ table: ITEM, key: { id: 1 }, values: { name: 'Drifted' } });
          }),
          Refusal,
          ddl,
        );
        assert.equal(called, false, ddl);
      });
    }
    // A trigger on the target is not a catalog drift but a reason to refuse the write; the kept description must not hide it.
    await withAdapter(async (adapter) => {
      await primed(adapter);
      await control.query(
        `CREATE TRIGGER scoped_guard BEFORE UPDATE ON public.scoped_item FOR EACH ROW EXECUTE FUNCTION public.scoped_noop()`,
      );
      await assert.rejects(
        adapter.scopeTransaction(rowsA(), (tx) => tx.update({ table: ITEM, key: { id: 1 }, values: { name: 'Blocked' } })),
        Refusal,
      );
    });
  });

  test('DDL on a scoped table waits for the transaction that pinned it', async () => {
    await withAdapter(async (adapter) => {
      const hold = gate();
      let trigger: Promise<unknown> | undefined;
      const scoped = adapter.scopeTransaction(rowsA(), async (tx) => {
        await tx.update({ table: ITEM, key: { id: 1 }, values: { name: 'Pinned' } });
        trigger = control.query(
          `CREATE TRIGGER scoped_late BEFORE UPDATE ON public.scoped_item FOR EACH ROW EXECUTE FUNCTION public.scoped_noop()`,
        );
        assert.equal(await settles(trigger), false, 'CREATE TRIGGER must wait for the pin');
        hold.release();
      });
      await hold.promise;
      await scoped;
      await trigger;
      assert.equal((await item(1)).name, 'Pinned');
      // The next transaction sees the trigger and refuses the table as a target.
      await assert.rejects(
        adapter.scopeTransaction(rowsA(), (tx) => tx.update({ table: ITEM, key: { id: 1 }, values: { name: 'After' } })),
        Refusal,
      );
    });
  });

  test('invalid scopes and reserved runtime resources refuse before the callback', async () => {
    await withAdapter(async (adapter) => {
      let called = false;
      const run = async () => {
        called = true;
      };
      await assert.rejects(adapter.scopeTransaction({ 'public.missing': true }, run), Refusal);
      await assert.rejects(adapter.scopeTransaction({ [ITEM]: { groups: [[{ column: 'nope', op: '=', value: 1 }]] } }, run), Refusal);
      await assert.rejects(
        commandsOf(adapter).scopeCommandTransaction(
          { [`${runtimeSchema('postgres')}.${runtimeName('postgres', journal.receipt)}`]: true },
          run,
        ),
        /runtime-only/,
      );
      assert.equal(called, false);
    });
  });

  /* ---------- outcomes ---------- */

  async function loseAcknowledgement(adapter: PostgresAdapter, statement: 'COMMIT' | 'ROLLBACK', cause: Error): Promise<() => void> {
    const manager = Reflect.get(adapter, 'connections') as PgConnectionManager;
    const original = manager.withWriteClient.bind(manager);
    manager.withWriteClient = ((run: (client: PgQuery) => Promise<unknown>, destroy?: boolean) =>
      original(
        (client) =>
          run({
            query: (async (...args: unknown[]) => {
              const result = await (client.query as (...a: unknown[]) => Promise<unknown>)(...args);
              if (args[0] === statement) throw cause;
              return result;
            }) as PgQuery['query'],
          }),
        destroy,
      )) as typeof manager.withWriteClient;
    return () => {
      manager.withWriteClient = original;
    };
  }

  test('a lost COMMIT acknowledgement is unknown and the write stands; a lost ROLLBACK acknowledgement is unknown too', async () => {
    await withAdapter(async (adapter) => {
      const cause = new Error('acknowledgement lost');
      let restore = await loseAcknowledgement(adapter, 'COMMIT', cause);
      try {
        await assert.rejects(
          adapter.scopeTransaction(rowsA(), (tx) => tx.update({ table: ITEM, key: { id: 1 }, values: { name: 'Committed' } })),
          (error: unknown) => error instanceof TransactionOutcomeUnknown && error.cause === cause,
        );
      } finally {
        restore();
      }
      assert.equal((await item(1)).name, 'Committed');
      restore = await loseAcknowledgement(adapter, 'ROLLBACK', cause);
      try {
        await assert.rejects(
          adapter.scopeTransaction(rowsA(), async (tx) => {
            await tx.update({ table: ITEM, key: { id: 1 }, values: { name: 'Abandoned' } });
            throw new Refusal('handler gave up');
          }),
          TransactionOutcomeUnknown,
        );
      } finally {
        restore();
      }
      assert.equal((await item(1)).name, 'Committed');
      // The uncertain client was discarded; the next transaction is sound.
      await adapter.scopeTransaction(rowsA(), (tx) => tx.update({ table: ITEM, key: { id: 1 }, values: { name: 'Afterwards' } }));
      assert.equal((await item(1)).name, 'Afterwards');
    });
  });

  /* ---------- scoped commands with the journal ---------- */

  test('a scoped command transaction attests the journal before any lock and hides runtime state from evidence and handlers', async () => {
    await withAdapter(async (adapter) => {
      let called = false;
      await assert.rejects(
        commandsOf(adapter).scopeCommandTransaction(rowsA(), async () => {
          called = true;
        }),
        (error: unknown) => {
          assert.ok(error instanceof CommandTransactionFailure);
          assert.equal(error.outcome, 'not_applied');
          assert.ok(error.cause instanceof CommandJournalUnavailable);
          return true;
        },
      );
      assert.equal(called, false);
      await migratePostgresCommandJournal(LIVE!);
      await commandsOf(adapter)
        .scopeCommandTransaction(rowsA(), async (records, _journal, evidence) => {
          assert.ok(evidence.tables.every((table) => !table.name.startsWith('__mistri_')));
          assert.ok(evidence.tables.some((table) => table.id === ITEM));
          await assert.rejects(
            records.query(page(`${runtimeSchema('postgres')}.${runtimeName('postgres', journal.receipt)}`)),
            /runtime-only/,
          );
        })
        .catch((error) => {
          assert.ok(error instanceof CommandTransactionFailure);
        });
      await commandsOf(adapter).scopeCommandTransaction(rowsA(), async (records) => {
        await records.update({ table: ITEM, key: { id: 1 }, values: { version: 1 } });
      });
      assert.equal((await item(1)).version, 1);
    });
  });

  test('a scoped business command journals and scopes in one transaction, replays, and refuses hidden targets, hidden results and revoked authority', async () => {
    await withAdapter(async (adapter) => {
      await migratePostgresCommandJournal(LIVE!);
      const actor = { id: 'actor-a', appId: 'scoped-pg', roles: ['manager'] };
      const request = (overrides: Record<string, unknown> = {}) => ({
        command: 'assign',
        commandVersion: 1,
        key: { id: 1 },
        expectedVersion: 0,
        idempotencyKey: 'pg-scoped-request-0001',
        input: { ownerId: 1 },
        ...overrides,
      });
      let calls = 0;
      const command = defineCommand({
        source: 'data',
        target: 'item',
        read: ['item', 'owner'],
        write: ['item'],
        input: { ownerId: { label: 'Owner', type: 'number', integer: true } },
        output: { parse: (value: unknown) => value },
        async handle({ tx, record }, input) {
          calls++;
          const version = Number(record.version);
          await tx.update({ table: 'item', key: { id: Number(record.id) }, expected: { version }, values: { version: version + 1 } });
          return { ownerId: input.ownerId, version: version + 1 };
        },
      });
      const app = parseAppConfig(
        {
          id: actor.appId,
          name: 'Scoped commands',
          sources: { data: { connection: 'private-data' } },
          resources: { item: { physical: ITEM, access: 'write' }, owner: { physical: OWNER } },
          auth: { roles: { manager: { read: true, commands: ['assign'] } } },
          views: { items: { kind: 'list', from: 'item' } },
          home: 'items',
        },
        'postgres scoped command fixture',
      );
      const mapped = createAppResources(adapter, await adapter.introspect(), physicalBindings(app, 'data'));
      assert.ok(
        !mapped.schema.tables.some((table) => table.id.startsWith('__mistri_') || table.id.startsWith(`${runtimeSchema('postgres')}.`)),
        'runtime tables stay out of the App catalog',
      );
      const resources: RuntimeResources = {
        ...mapped,
        connections: ['private-data'],
        connectionFor: () => 'private-data',
        toLogicalAt: (table) => mapped.toLogical(table),
        forConnection: () => mapped.adapter,
      };
      let active = true;
      const binding = bindScopedBusinessCommands({
        app,
        resources,
        registry: defineCommands({ assign: command }),
        writableConnection: () => true,
        resultReferences: { assign: (result) => [{ table: 'owner', key: { id: (result as { ownerId: number }).ownerId } }] },
      }).withScope({ item: eq('tenant', 'a'), owner: eq('tenant', 'a') }, () => {
        if (!active) throw new AppAccessDenied();
      });
      const refused = (code: string, outcome: 'not_applied' | 'unknown') => (error: unknown) => {
        assert.ok(error instanceof BusinessCommandExecutionError, String(error));
        assert.equal(error.code, code);
        assert.equal(error.outcome, outcome);
        return true;
      };

      const first = await executeBusinessCommand(binding, actor, request());
      assert.equal(first.replayed, false);
      assert.equal((await item(1)).version, 1);
      assert.equal(await count(journal.receipt), 1);
      assert.equal(await count(postgresAuditRows), 1);
      assert.deepEqual(await executeBusinessCommand(binding, actor, request()), { ...first, replayed: true });
      assert.equal((await lookupBusinessCommandStatus(binding, actor, request())).status, 'applied');
      assert.equal(calls, 1);

      // A hidden result dependency rolls back the effect, receipt and audit together.
      await assert.rejects(
        executeBusinessCommand(
          binding,
          actor,
          request({ expectedVersion: 1, idempotencyKey: 'pg-scoped-request-0002', input: { ownerId: 2 } }),
        ),
        refused('forbidden', 'not_applied'),
      );
      assert.equal((await item(1)).version, 1);
      assert.equal(await count(journal.receipt), 1);
      assert.equal(await count(postgresAuditRows), 1);
      // A hidden target never reaches the handler.
      await assert.rejects(
        executeBusinessCommand(binding, actor, request({ key: { id: 2 }, idempotencyKey: 'pg-scoped-request-0003' })),
        refused('forbidden', 'unknown'),
      );
      assert.equal((await item(2)).version, 0);
      assert.equal(calls, 2);
      // Revoked authority refuses the replay and any fresh execution.
      active = false;
      await assert.rejects(executeBusinessCommand(binding, actor, request()), refused('forbidden', 'unknown'));
      await assert.rejects(
        executeBusinessCommand(binding, actor, request({ expectedVersion: 1, idempotencyKey: 'pg-scoped-request-0004' })),
        refused('forbidden', 'unknown'),
      );
      assert.equal(calls, 2);
      assert.equal(await count(journal.receipt), 1);
    });
  });
});
