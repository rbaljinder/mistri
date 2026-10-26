/**
 * Business commands on PostgreSQL, against a real server.
 *
 * The SQLite suites prove the execution contract on the engine that had it
 * first; this file proves the same contract on PostgreSQL, through the real
 * `executeBusinessCommand`, with the PostgreSQL journal and adapter under it:
 * effects, receipt and audit commit or roll back together, an exact retry
 * replays, a changed retry conflicts, revoked authority is refused before a
 * write, a lost COMMIT acknowledgement stays `unknown`, and two independent
 * connections delivering the same command settle to one receipt.
 *
 * Live and opt-in exactly like postgres.test.ts: `TABLEWALK_TEST_PG` names
 * a disposable database this file may reset, and `TABLEWALK_REQUIRE_LIVE=1`
 * turns a missing server into a failure. It drops and recreates its own
 * tables in `public` before each test, so point it at nothing you keep.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import {
  COMMAND_JOURNAL_TABLES as tables,
  CommandJournalUnavailable,
  CommandTransactionFailure,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { CommandJournalTenant, StoredCommandReceipt } from '../packages/mistri/src/adapters/commands/commandJournalTypes.js';
import {
  assertPostgresCommandJournal,
  createPostgresCommandJournal,
  migratePostgresCommandJournal,
} from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import {
  COMMAND_EVENT_TABLES as eventTables,
  CommandEventStoreUnavailable,
} from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import type { CommandEventBatch } from '../packages/mistri/src/adapters/events/commandEventTypes.js';
import { provisionPostgresCommandEventStore } from '../packages/mistri/src/adapters/events/postgresCommandEventStore.js';
import type { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { PgConnectionManager, PgQuery, PgWriteClientSource } from '../packages/engine/src/adapters/postgresPool.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import {
  BusinessCommandExecutionError,
  executeBusinessCommand,
  lookupBusinessCommandStatus,
  refuse,
} from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands, type BusinessCommandActor } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { isRuntimeTable, runtimeName, runtimeSchema, runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { liveSkip } from './live.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';
import { postgresAuditRows } from './support/commandTargets.js';
import { postgresPruneDb, pruneAll, prunes } from '../packages/mistri/src/adapters/retention/pruner.js';
import { retentionMs } from '../packages/mistri/src/shared/appRetention.js';

/** Whether the live half runs: the skip decision, and nothing else. */
const LIVE = process.env.TABLEWALK_TEST_PG;
/* This file's RESET drops the journal and event tables in `public`, so it works
   in a database of this run's own, created and dropped by the hooks below. Two
   runs on one server then reset only their own tables. */
const DATABASE = `tw_cmd_journal_${randomUUID().replaceAll('-', '')}`;
let url: string;

interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
/** This run's own database by default; the server's only for the hooks that
 * create and drop that database. */
async function client(target = url): Promise<Control> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
  const Client = (pg.Client ?? pg.default?.Client)!;
  const created = new Client({ connectionString: target });
  await created.connect();
  return created;
}

const actor: BusinessCommandActor = { id: 'account-a', appId: 'loan-workspace', roles: ['reviewer'] };
const request = (overrides: Record<string, unknown> = {}) => ({
  command: 'assign-reviewer',
  commandVersion: 1,
  key: { tenant: 'retail', id: 1 },
  input: { reviewer: 'Ada', note: 'Review assignment' },
  expectedVersion: 0,
  idempotencyKey: 'assignment-request-0001',
  ...overrides,
});
const CONNECTION = 'pg-loans';

/* Everything this file creates, dropped before each test so one test's
   journal cannot stand in for the next one's migration. */
const RESET = [
  `DROP TABLE IF EXISTS public.assignment_history, public.loans CASCADE`,
  `DROP SCHEMA IF EXISTS mistri CASCADE`,
  `DROP SCHEMA IF EXISTS tablewalk_collision CASCADE`,
];
const SETUP = [
  `CREATE TABLE public.loans (tenant text NOT NULL, id integer NOT NULL, version integer NOT NULL,
     assignee text NOT NULL, confidential_note text NOT NULL, PRIMARY KEY (tenant, id))`,
  `CREATE TABLE public.assignment_history (id serial PRIMARY KEY, tenant text NOT NULL, loan_id integer NOT NULL,
     reviewer text NOT NULL, note text NOT NULL, FOREIGN KEY (tenant, loan_id) REFERENCES public.loans (tenant, id))`,
  `INSERT INTO public.loans VALUES ('retail', 1, 0, 'Unassigned', 'Private untouched loan detail')`,
];

function errorCode(code: string, outcome = 'not_applied') {
  return (error: unknown) => {
    assert.ok(error instanceof BusinessCommandExecutionError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.outcome, outcome);
    assert.doesNotMatch(error.message, /Private validator|Private output|SELECT|UPDATE|postgres:/);
    return true;
  };
}

describe('business commands on PostgreSQL, against a real server', { skip: liveSkip('postgres', LIVE) }, () => {
  let control: Control;
  /* A table by name, or a subquery (the receipt's targets, test/support/commandTargets.ts). */
  const count = async (table: string, where = 'true') =>
    Number(
      (
        await control.query(
          `SELECT count(*) AS n FROM ${table.startsWith('(') ? `${table} t` : isRuntimeTable(table) ? runtimeTable('postgres', table) : `public."${table}"`} WHERE ${where}`,
        )
      ).rows[0].n,
    );
  const loan = async () => (await control.query('SELECT version, assignee, confidential_note FROM public.loans WHERE id = 1')).rows[0];
  const reset = async (migrate = true) => {
    for (const statement of [...RESET, ...SETUP]) await control.query(statement);
    if (migrate) assert.deepEqual(await migratePostgresCommandJournal(url), { version: 1, migrated: true });
  };

  before(async () => {
    const server = await client(LIVE!);
    try {
      await server.query(`CREATE DATABASE "${DATABASE}"`);
    } finally {
      await server.end();
    }
    const target = new URL(LIVE!);
    target.pathname = `/${DATABASE}`;
    url = target.href;
    control = await client();
  });
  after(async () => {
    for (const statement of RESET) await control.query(statement).catch(() => {});
    await control.end();
    const server = await client(LIVE!);
    try {
      await server.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
    } finally {
      await server.end();
    }
  });

  /* The execution fixture from business-command-execution.test.ts, on a
     PostgreSQL registry entry. Each call builds its own registry, so two
     fixtures are two independent connection pools. */
  async function fixture(
    run: (f: {
      app: ReturnType<typeof parseAppConfig>;
      readonly registry: Registry;
      readonly binding: ReturnType<typeof bindBusinessCommands>;
      control: { calls: number; invalidOutput: boolean; fail: boolean; delay: number };
      adapter(): Promise<PostgresAdapter>;
      rebind(): Promise<void>;
    }) => Promise<void>,
    options: { migrate?: boolean; keep?: boolean } = {},
  ) {
    if (!options.keep) await reset(options.migrate ?? true);
    const registry = new Registry();
    try {
      const app = parseAppConfig(
        {
          id: actor.appId,
          name: 'Loan workspace',
          sources: { operations: { connection: CONNECTION } },
          resources: { loan: { physical: 'public.loans', access: 'write' }, assignment_history: { access: 'write' } },
          auth: { roles: { reviewer: { read: true, commands: ['assign-reviewer'] }, viewer: { read: true } } },
          views: { loans: { kind: 'list', from: 'loan' } },
          home: 'loans',
        },
        'postgres execution fixture',
      );
      const state = { calls: 0, invalidOutput: false, fail: false, delay: 0 };
      const commands = defineCommands({
        'assign-reviewer': defineCommand({
          source: 'operations',
          target: 'loan',
          write: ['assignment_history'],
          // A reviewer, trimmed and present, and a note: the declaration parses both.
          input: {
            reviewer: { label: 'Reviewer', type: 'text' },
            note: { label: 'Note', type: 'textarea' },
          },
          output: {
            parse(value: unknown) {
              if (!value || typeof value !== 'object' || typeof (value as { version?: unknown }).version !== 'number')
                throw new Error('Private output validator details');
              return value;
            },
          },
          async handle({ db, record }, input) {
            state.calls++;
            if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
            // Guarded on the revision and assignee the platform read: a concurrent writer refuses this one.
            const { version } = await db.loan.update(record, { assignee: input.reviewer });
            await db.assignment_history.insert({ tenant: record.tenant, loan_id: record.id, reviewer: input.reviewer, note: input.note });
            if (state.fail) refuse('reviewer_unavailable');
            return state.invalidOutput ? { privateError: 'Must not persist' } : { reviewer: input.reviewer, version };
          },
        }),
      });
      registry.add({ id: CONNECTION, name: 'Private loans', url: url, writable: true, source: 'config' });
      let binding: ReturnType<typeof bindBusinessCommands>;
      const rebind = async () => {
        const resources = await loadAppRuntimeResources(registry, app, CONNECTION);
        binding = bindBusinessCommands({
          app,
          registry: commands,
          resources,
          writableConnection: (id) => registry.configOf(id)?.writable === true,
        });
      };
      await rebind();
      await run({
        app,
        control: state,
        get registry() {
          return registry;
        },
        get binding() {
          return binding;
        },
        rebind,
        adapter: async () => (await registry.open(CONNECTION)).adapter as PostgresAdapter,
      });
    } finally {
      await registry.closeAll();
    }
  }

  /* ---------- migration and attestation ---------- */

  test('migration is explicit, idempotent, refuses a foreign layout unchanged and needs a postgres URL', async () => {
    await reset(false);
    assert.equal(
      (await control.query(`SELECT count(*) AS n FROM pg_class WHERE relname LIKE '\\_\\_mistri\\_command\\_%'`)).rows[0].n,
      '0',
    );
    assert.deepEqual(await migratePostgresCommandJournal(url), { version: 1, migrated: true });
    assert.deepEqual(await migratePostgresCommandJournal(url), { version: 1, migrated: false });
    await assertPostgresCommandJournal(control);
    assert.equal(await count(tables.meta), 1);
    await assert.rejects(migratePostgresCommandJournal('sqlite:./loans.db'), /postgres:\/\/ URL/);

    for (const statement of RESET) await control.query(statement);
    await control.query(`CREATE SCHEMA IF NOT EXISTS mistri`);
    await control.query(`CREATE TABLE ${runtimeTable('postgres', tables.receipt)} (unrelated text)`);
    await control.query(`INSERT INTO ${runtimeTable('postgres', tables.receipt)} VALUES ('keep')`);
    await assert.rejects(migratePostgresCommandJournal(url), CommandJournalUnavailable);
    assert.deepEqual((await control.query(`SELECT * FROM ${runtimeTable('postgres', tables.receipt)}`)).rows, [{ unrelated: 'keep' }]);
    assert.equal(
      (await control.query(`SELECT count(*) AS n FROM pg_class WHERE relname = '${runtimeName('postgres', tables.meta)}'`)).rows[0].n,
      '0',
    );
  });

  test('attestation refuses missing, altered, extended, triggered and colliding journal tables', async () => {
    const alterations: Array<[string, string[]]> = [
      ['a missing table', [`DROP TABLE ${runtimeTable('postgres', tables.receipt)}`]],
      ['an added column', [`ALTER TABLE ${runtimeTable('postgres', tables.receipt)} ADD COLUMN extra text`]],
      [
        'a dropped constraint',
        [
          `ALTER TABLE ${runtimeTable('postgres', tables.receipt)} DROP CONSTRAINT "${runtimeName('postgres', tables.receipt)}_app_id_store_id_source_id_realm_tenant_id_a_key"`,
        ],
      ],
      [
        'a changed collation',
        [`ALTER TABLE ${runtimeTable('postgres', tables.receipt)} ALTER COLUMN actor_id TYPE text COLLATE "default"`],
      ],
      ['an extra index', [`CREATE INDEX unexpected ON ${runtimeTable('postgres', tables.receipt)} (fingerprint)`]],
      [
        'a trigger',
        [
          `CREATE FUNCTION public.tablewalk_noop() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`,
          `CREATE TRIGGER unexpected BEFORE INSERT ON ${runtimeTable('postgres', tables.receipt)} FOR EACH ROW EXECUTE FUNCTION public.tablewalk_noop()`,
        ],
      ],
      ['a rule', [`CREATE RULE unexpected AS ON DELETE TO ${runtimeTable('postgres', tables.receipt)} DO INSTEAD NOTHING`]],
      ['row security', [`ALTER TABLE ${runtimeTable('postgres', tables.receipt)} ENABLE ROW LEVEL SECURITY`]],
      [
        // Attestation reads the runtime schema alone, so a look-alike has to sit in it (upper-cased, it
        // still lower-cases into the journal's prefix).
        'a look-alike in the runtime schema',
        [`CREATE SCHEMA IF NOT EXISTS mistri`, `CREATE TABLE mistri."${runtimeName('postgres', tables.meta).toUpperCase()}" (x int)`],
      ],
      ['a missing meta row', [`DELETE FROM ${runtimeTable('postgres', tables.meta)}`]],
    ];
    for (const [name, statements] of alterations) {
      await reset();
      for (const statement of statements) await control.query(statement);
      await assert.rejects(assertPostgresCommandJournal(control), CommandJournalUnavailable, name);
      await assert.rejects(migratePostgresCommandJournal(url), CommandJournalUnavailable, `migration with ${name}`);
      // The adapter refuses before its callback, with SQLite's classification.
      await fixture(
        async (f) => {
          let called = false;
          await assert.rejects(
            commandsOf(await f.adapter()).commandTransaction(async () => {
              called = true;
            }),
            (error) => {
              assert.ok(error instanceof CommandTransactionFailure, `${name}: ${String(error)}`);
              assert.equal(error.outcome, 'not_applied');
              assert.ok(error.cause instanceof CommandJournalUnavailable);
              return true;
            },
          );
          assert.equal(called, false);
          await assert.rejects(executeBusinessCommand(f.binding, actor, request()), errorCode('temporarily_unavailable'));
          assert.equal(f.control.calls, 0);
        },
        { keep: true },
      );
      await control.query(`DROP FUNCTION IF EXISTS public.tablewalk_noop CASCADE`);
    }
  });

  /* ---------- execution through the real runtime ---------- */

  test('a command commits domain writes, one durable receipt and audit together', async () => {
    await fixture(async (f) => {
      const result = await executeBusinessCommand(f.binding, actor, request(), {
        requestId: 'verified-request',
        now: () => new Date('2026-09-09T12:00:00Z'),
      });
      assert.equal(result.status, 'applied');
      assert.equal(result.resource, 'loan');
      assert.deepEqual(result.result, { reviewer: 'Ada', version: 1 });
      assert.equal(result.replayed, false);
      assert.deepEqual(await loan(), { version: 1, assignee: 'Ada', confidential_note: 'Private untouched loan detail' });
      assert.equal(await count('assignment_history'), 1);
      const receipts = (
        await control.query(
          `SELECT *, to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS completed FROM ${runtimeTable('postgres', tables.receipt)}`,
        )
      ).rows;
      const audit = (await control.query(`SELECT * FROM ${postgresAuditRows} a`)).rows;
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].id, result.receiptId);
      assert.equal(receipts[0].app_id, actor.appId);
      assert.equal(receipts[0].actor_id, actor.id);
      assert.equal(receipts[0].command_version, 1);
      assert.equal(receipts[0].request_id, 'verified-request');
      assert.equal(receipts[0].completed, '2026-09-09T12:00:00.000Z');
      assert.equal(audit.length, 1);
      assert.equal(audit[0].receipt_id, result.receiptId);
      assert.equal(audit[0].target, 'loan');
      assert.deepEqual(JSON.parse(String(audit[0].key_json)), { tenant: 'retail', id: 1 });
      assert.deepEqual(JSON.parse(String(audit[0].changes_json)), [
        {
          operation: 'update',
          resource: 'loan',
          key: { tenant: 'retail', id: 1 },
          before: { assignee: 'Unassigned', version: 0 },
          after: { assignee: 'Ada', version: 1 },
        },
        {
          operation: 'insert',
          resource: 'assignment_history',
          key: { id: 1 },
          after: { tenant: 'retail', loan_id: 1, reviewer: 'Ada', note: 'Review assignment' },
        },
      ]);
      assert.doesNotMatch(JSON.stringify(audit), /Private untouched loan detail|confidential_note/);
      assert.equal(f.control.calls, 1);
      // Retention dates the receipt by its timestamptz: kept inside the window, forgotten past it.
      const db = postgresPruneDb({
        withWriteClient: (use: (client: Control) => unknown) => use(control),
      } as unknown as PgWriteClientSource);
      const rules = prunes().filter((each) => each.id === 'command-receipts');
      const at = (now: number) => ({ now: () => now, sleep: async () => {} });
      const windows = retentionMs({ commands: '30 days' });
      assert.deepEqual(await pruneAll(db, rules, windows, at(Date.UTC(2026, 9, 1))), [{ id: 'command-receipts', deleted: 0 }]);
      assert.deepEqual(await pruneAll(db, rules, windows, at(Date.UTC(2026, 9, 25))), [{ id: 'command-receipts', deleted: 1 }]);
      assert.equal(await count(tables.receipt), 0);
    });
  });

  test('an exact retry replays the receipt; a changed payload or expected version conflicts', async () => {
    await fixture(async (f) => {
      const first = await executeBusinessCommand(f.binding, actor, request());
      const replay = await executeBusinessCommand(
        f.binding,
        actor,
        request({ key: { id: 1, tenant: 'retail' }, input: { note: 'Review assignment', reviewer: '  Ada  ' } }),
      );
      assert.deepEqual(replay, { ...first, replayed: true });
      assert.deepEqual(await lookupBusinessCommandStatus(f.binding, actor, request()), { ...first, replayed: true });
      await assert.rejects(
        executeBusinessCommand(f.binding, actor, request({ input: { reviewer: 'Grace', note: 'Different' } })),
        errorCode('idempotency_conflict'),
      );
      await assert.rejects(executeBusinessCommand(f.binding, actor, request({ expectedVersion: 1 })), errorCode('idempotency_conflict'));
      await assert.rejects(
        lookupBusinessCommandStatus(f.binding, actor, request({ expectedVersion: 2 })),
        errorCode('idempotency_conflict', 'unknown'),
      );
      assert.equal(f.control.calls, 1);
      assert.equal(await count('assignment_history'), 1);
      assert.equal(await count(tables.receipt), 1);
      // Another actor with the same key is another scope: the row is stale for it, then it applies.
      const other = { ...actor, id: 'account-b' };
      await assert.rejects(executeBusinessCommand(f.binding, other, request()), errorCode('stale_record'));
      const second = await executeBusinessCommand(f.binding, other, request({ expectedVersion: 1 }));
      assert.notEqual(second.receiptId, first.receiptId);
      assert.equal((await loan()).version, 2);
      assert.equal(await count(tables.receipt), 2);
    });
  });

  test('a business failure or invalid output rolls back effects, receipt and audit', async () => {
    await fixture(async (f) => {
      f.control.fail = true;
      await assert.rejects(executeBusinessCommand(f.binding, actor, request()), errorCode('reviewer_unavailable'));
      f.control.fail = false;
      f.control.invalidOutput = true;
      await assert.rejects(executeBusinessCommand(f.binding, actor, request()), errorCode('invalid_result'));
      f.control.invalidOutput = false;
      await assert.rejects(executeBusinessCommand(f.binding, actor, request({ expectedVersion: 3 })), errorCode('stale_record'));
      // The stale revision is the platform's refusal, read before the handler runs: it never reached it.
      assert.equal(f.control.calls, 2);
      assert.equal((await loan()).version, 0);
      for (const table of ['assignment_history', tables.receipt]) assert.equal(await count(table), 0, table);
      assert.deepEqual(await lookupBusinessCommandStatus(f.binding, actor, request()), { status: 'not_found', outcome: 'unknown' });
      const retry = await executeBusinessCommand(f.binding, actor, request());
      assert.equal(retry.replayed, false);
      assert.equal((await loan()).version, 1);
    });
  });

  test('revoked or missing authority is refused before any write, and cannot read a prior receipt', async () => {
    await fixture(async (f) => {
      await assert.rejects(executeBusinessCommand(f.binding, { ...actor, roles: ['viewer'] }, request()), errorCode('forbidden'));
      await assert.rejects(executeBusinessCommand(f.binding, { ...actor, appId: 'other-app' }, request()), errorCode('forbidden'));
      assert.equal(f.control.calls, 0);
      assert.equal(await count(tables.receipt), 0);
      await executeBusinessCommand(f.binding, actor, request());
      f.app.auth!.roles!.reviewer.commands = [];
      await f.rebind();
      await assert.rejects(executeBusinessCommand(f.binding, actor, request()), errorCode('forbidden'));
      await assert.rejects(lookupBusinessCommandStatus(f.binding, actor, request()), errorCode('forbidden', 'unknown'));
      assert.equal(f.control.calls, 1);
      assert.equal(await count(tables.receipt), 1);
      assert.equal((await loan()).version, 1);
    });
  });

  test('journal tables are hidden from the App catalog and refused to handlers', async () => {
    await fixture(async (f) => {
      const opened = await f.registry.open(CONNECTION);
      const resources = await loadAppRuntimeResources(f.registry, f.app, CONNECTION);
      for (const table of Object.values(tables)) {
        assert.equal(
          opened.schema.tables.some((entry) => entry.id === `${runtimeSchema('postgres')}.${runtimeName('postgres', table)}`),
          false,
          table,
        );
        assert.equal(
          resources.schema.tables.some((entry) => entry.id === `${runtimeSchema('postgres')}.${runtimeName('postgres', table)}`),
          false,
          table,
        );
      }
      f.app.resources = {
        ...f.app.resources,
        leaked_receipt: { source: 'operations', physical: `${runtimeSchema('postgres')}.${runtimeName('postgres', tables.receipt)}` },
      };
      await assert.rejects(f.rebind());
    });
  });

  /* ---------- the crash window ---------- */

  /* The SQLite test wraps the handle's `exec`; here the leased client's
     `query` is wrapped through the connection manager, which is the one
     place a command's client passes through. */
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

  test('a lost COMMIT acknowledgement is unknown, and the committed receipt is found afterwards', async () => {
    await fixture(async (f) => {
      const cause = new Error('acknowledgement lost');
      const restore = await loseAcknowledgement(await f.adapter(), 'COMMIT', cause);
      try {
        await assert.rejects(executeBusinessCommand(f.binding, actor, request()), errorCode('temporarily_unavailable', 'unknown'));
      } finally {
        restore();
      }
      assert.equal(f.control.calls, 1);
      assert.equal((await loan()).version, 1);
      assert.equal(await count('assignment_history'), 1);
      assert.equal(await count(tables.receipt), 1);
      assert.equal(await count(postgresAuditRows), 1);
      // Reconciliation with the same request key finds the receipt on a fresh connection.
      const status = await lookupBusinessCommandStatus(f.binding, actor, request());
      assert.equal(status.status, 'applied');
      assert.equal((status as { replayed?: boolean }).replayed, true);
      const replay = await executeBusinessCommand(f.binding, actor, request());
      assert.equal(replay.replayed, true);
      assert.equal(f.control.calls, 1);
    });
  });

  test('a lost ROLLBACK acknowledgement is unknown rather than a claim that nothing was written', async () => {
    await fixture(async (f) => {
      const cause = new Error('acknowledgement lost');
      f.control.fail = true;
      const restore = await loseAcknowledgement(await f.adapter(), 'ROLLBACK', cause);
      try {
        await assert.rejects(executeBusinessCommand(f.binding, actor, request()), errorCode('reviewer_unavailable', 'unknown'));
      } finally {
        restore();
      }
      f.control.fail = false;
      assert.equal((await loan()).version, 0);
      assert.equal(await count(tables.receipt), 0);
      // The uncertain client was destroyed; the next command gets a sound one.
      const applied = await executeBusinessCommand(f.binding, actor, request());
      assert.equal(applied.replayed, false);
      assert.equal((await loan()).version, 1);
    });
  });

  /* ---------- concurrency across independent connections ---------- */

  test('concurrent duplicate deliveries on two independent pools execute once and settle to one receipt', async () => {
    await fixture(async (first) => {
      await fixture(
        async (second) => {
          first.control.delay = 150;
          second.control.delay = 150;
          const results = await Promise.all([
            executeBusinessCommand(first.binding, actor, request()),
            executeBusinessCommand(second.binding, actor, request()),
          ]);
          assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
          assert.equal(results[0].receiptId, results[1].receiptId);
          assert.equal(first.control.calls + second.control.calls, 1);
          assert.equal((await loan()).version, 1);
          assert.equal(await count('assignment_history'), 1);
          assert.equal(await count(tables.receipt), 1);
          assert.equal(await count(postgresAuditRows), 1);

          // Same key, different payloads, at once: one applies and the other conflicts; never two effects.
          await reset();
          const settled = await Promise.allSettled([
            executeBusinessCommand(first.binding, actor, request({ idempotencyKey: 'assignment-request-raced-0002' })),
            executeBusinessCommand(
              second.binding,
              actor,
              request({ idempotencyKey: 'assignment-request-raced-0002', input: { reviewer: 'Grace', note: 'Different' } }),
            ),
          ]);
          assert.deepEqual(
            settled.map((result) => result.status).sort(),
            ['fulfilled', 'rejected'],
            settled
              .map((result) =>
                result.status === 'rejected' ? `${(result.reason as Error).message} [${(result.reason as { code?: string }).code}]` : 'ok',
              )
              .join(' | '),
          );
          const rejected = settled.find((result) => result.status === 'rejected') as PromiseRejectedResult;
          assert.ok(errorCode('idempotency_conflict')(rejected.reason));
          assert.equal(await count('assignment_history'), 1);
          assert.equal(await count(tables.receipt), 1);
          assert.equal((await loan()).version, 1);
        },
        { keep: true },
      );
    });
  });

  /* ---------- the event batch ---------- */

  const tenant: CommandJournalTenant = {
    appId: 'ignition',
    storeId: 'event-store',
    sourceId: 'business',
    tenantId: 'north',
    actorId: 'alice',
    membershipId: 'member',
    membershipVersion: '1',
    tenantVersion: '1',
    roles: ['manager'],
    deployment: 'first',
  };
  const binding = { appId: tenant.appId, storeId: tenant.storeId, sourceId: tenant.sourceId };
  const receipt: StoredCommandReceipt = {
    id: 'receipt',
    appId: tenant.appId,
    actorId: tenant.actorId,
    commandId: 'assign',
    commandVersion: 2,
    idempotencyKey: 'assignment-0000001',
    fingerprint: 'fingerprint',
    resultJson: '{"assigned":true}',
    requestId: 'request',
    completedAt: '2026-09-09T12:00:00.000Z',
  };
  const audit = { target: 'application', keyJson: '{"id":1}', changesJson: '[]' };
  const manifest = [{ name: 'application.reviewer-assigned', version: 1 }];
  const batch: CommandEventBatch = [{ ...manifest[0], payloadJson: '{"applicationId":1,"reviewerId":"reviewer-one"}' }];
  const scope = {
    appId: receipt.appId,
    actorId: receipt.actorId,
    commandId: receipt.commandId,
    commandVersion: receipt.commandVersion,
    idempotencyKey: receipt.idempotencyKey,
  };

  /* The tenant runtime that issues event batches is still SQLite-only host
     code, so the batch is proven at the journal boundary: an owner-bound
     journal over its own transaction on a plain client. */
  async function journalRun<T>(
    owner: CommandJournalTenant | undefined,
    work: (journal: ReturnType<typeof createPostgresCommandJournal>) => Promise<T>,
  ): Promise<T> {
    const connection = await client();
    const operations = new TransactionOperations();
    try {
      await connection.query('BEGIN');
      const result = await work(createPostgresCommandJournal(connection, operations, owner));
      await operations.finish();
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await operations.finish().catch(() => {});
      await connection.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await connection.end();
    }
  }

  test('a journal on a client outside a transaction block refuses, though its probe goes in one message', async () => {
    await reset();
    const connection = await client();
    const operations = new TransactionOperations();
    try {
      const journal = createPostgresCommandJournal(connection, operations);
      await assert.rejects(journal.commit(receipt, audit), CommandJournalUnavailable);
      await operations.finish().catch(() => {});
      assert.equal(await count(tables.receipt), 0, 'nothing was written in autocommit');
    } finally {
      await connection.end();
    }
  });

  test('an owner-bound journal commits its event batch with the receipt and validates it on lookup', async () => {
    await reset();
    await assert.rejects(
      journalRun(tenant, (journal) => journal.commit(receipt, audit, batch)),
      CommandEventStoreUnavailable,
    );
    assert.equal(await count(tables.receipt), 0);
    assert.deepEqual(await provisionPostgresCommandEventStore(url, binding), { version: 1, provisioned: true });
    assert.deepEqual(await provisionPostgresCommandEventStore(url, binding), { version: 1, provisioned: false });
    await assert.rejects(provisionPostgresCommandEventStore(url, { ...binding, sourceId: 'other' }), CommandEventStoreUnavailable);
    // An invalid batch fails the whole operation: the receipt written before it is rolled back too.
    await assert.rejects(journalRun(tenant, (journal) => journal.commit(receipt, audit, [])));
    assert.equal(await count(tables.receipt), 0);
    await assert.rejects(
      journalRun(undefined, (journal) => journal.commit(receipt, audit, batch)),
      CommandJournalUnavailable,
    );
    assert.equal(await count(tables.receipt), 0);

    await journalRun(tenant, (journal) => journal.commit(receipt, audit, batch));
    assert.equal(await count(tables.receipt), 1);
    assert.equal(await count(tables.receipt, 'manifest_json IS NOT NULL'), 1);
    assert.equal(await count(eventTables.event), 1);
    const found = await journalRun(tenant, (journal) => journal.find(scope, manifest));
    assert.deepEqual(found, receipt);
    const stored = (await control.query(`SELECT envelope_json FROM ${runtimeTable('postgres', eventTables.event)}`)).rows[0];
    const envelope = JSON.parse(String(stored.envelope_json));
    assert.equal(envelope.receiptId, receipt.id);
    assert.equal(envelope.tenantId, tenant.tenantId);
    assert.equal(envelope.scope, 'tenant');
    assert.equal(envelope.envelopeVersion, 2);
    assert.equal(envelope.payloadJson, batch[0].payloadJson);
    for (const field of ['membershipId', 'roles', 'deployment']) assert.equal(Object.hasOwn(envelope, field), false);
    // Renewed grants find the same receipt; another tenant or store does not.
    const renewed = { ...tenant, membershipId: 'new-grant', membershipVersion: '2', roles: ['reader'], deployment: 'second' };
    assert.deepEqual(await journalRun(renewed, (journal) => journal.find(scope, manifest)), receipt);
    assert.equal(await journalRun({ ...tenant, tenantId: 'south' }, (journal) => journal.find(scope, manifest)), undefined);
    await assert.rejects(
      journalRun({ ...tenant, storeId: 'other' }, (journal) => journal.find(scope, manifest)),
      CommandEventStoreUnavailable,
    );
    // A receipt with a batch is not one without; a changed declaration is refused.
    await assert.rejects(
      journalRun(tenant, (journal) => journal.find(scope)),
      CommandEventStoreUnavailable,
    );
    await assert.rejects(
      journalRun(tenant, (journal) => journal.find(scope, [{ ...manifest[0], version: 2 }])),
      CommandEventStoreUnavailable,
    );
    await assert.rejects(journalRun(tenant, (journal) => journal.commit(receipt, audit, batch)));
    assert.equal(await count(eventTables.event), 1);
    // A missing or altered association refuses replay rather than regenerating events.
    for (const sql of [
      `UPDATE ${runtimeTable('postgres', tables.receipt)} SET event_count = 2`,
      `UPDATE ${runtimeTable('postgres', tables.receipt)} SET digest = '${'f'.repeat(64)}'`,
      `UPDATE ${runtimeTable('postgres', eventTables.event)} SET ordinal = 1`,
      `UPDATE ${runtimeTable('postgres', eventTables.event)} SET event_id = '00000000-0000-4000-8000-000000000000'`,
      `DELETE FROM ${runtimeTable('postgres', eventTables.event)}`,
    ]) {
      await reset();
      await provisionPostgresCommandEventStore(url, binding);
      await journalRun(tenant, (journal) => journal.commit(receipt, audit, batch));
      await control.query(sql);
      await assert.rejects(
        journalRun(tenant, (journal) => journal.find(scope, manifest)),
        CommandEventStoreUnavailable,
        sql,
      );
    }
  });
});
