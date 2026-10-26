import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal, COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import {
  executeBusinessCommand,
  lookupBusinessCommandStatus,
  registerCommandAnalytics,
  BusinessCommandExecutionError,
} from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import {
  defineCommand,
  defineCommands,
  type BusinessCommandActor,
  type BusinessCommandContext,
  type BusinessCommandAvailabilityContext,
} from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { refusalReasons } from '../packages/engine/src/shared/refusal.js';

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
/** The target's key, from the record the platform read for the handler. */
const keyOf = (context: BusinessCommandContext) => ({ tenant: String(context.record!.tenant), id: Number(context.record!.id) });

test('business availability gates fresh execution transactionally but does not rerun for an applied receipt', async () => {
  let allowed = false,
    checks = 0;
  await fixture(
    async (f) => {
      await assert.rejects(executeBusinessCommand(f.binding, actor, request()), errorCode('forbidden'));
      assert.equal(f.control.calls, 0);
      assert.equal(checks, 1);
      assert.equal(rows(f.db, 'assignment_history').length, 0);
      allowed = true;
      const result = await executeBusinessCommand(f.binding, actor, request());
      assert.equal(result.status, 'applied');
      assert.equal(f.control.calls, 1);
      allowed = false;
      const replay = await executeBusinessCommand(f.binding, actor, request());
      assert.equal(replay.replayed, true);
      assert.equal(checks, 2);
      assert.equal(f.control.calls, 1);
    },
    undefined,
    false,
    (context) => {
      checks++;
      assert.equal('tx' in context, false);
      assert.equal('update' in context.db.loan, false);
      return context.records.map(() => allowed);
    },
  );
});

test("the App's analytics recorder is told once per admitted request, ran or refused, and not again for a replay", async () => {
  const told: unknown[] = [];
  const off = registerCommandAnalytics(actor.appId, (event) => {
    told.push(event);
  });
  try {
    await fixture(async (f) => {
      assert.equal((await executeBusinessCommand(f.binding, actor, request())).status, 'applied');
      assert.equal((await executeBusinessCommand(f.binding, actor, request())).replayed, true);
      await assert.rejects(
        executeBusinessCommand(f.binding, { ...actor, roles: [] }, request({ idempotencyKey: 'assignment-request-0002' })),
        BusinessCommandExecutionError,
      );
    });
  } finally {
    off();
  }
  assert.deepEqual(told, [
    { command: 'assign-reviewer', outcome: 'ran', unit: 'account-a' },
    { command: 'assign-reviewer', outcome: 'refused', unit: 'account-a' },
  ]);
});

async function fixture(
  run: (f: {
    db: DatabaseSync;
    path: string;
    app: ReturnType<typeof parseAppConfig>;
    readonly registry: Registry;
    readonly binding: ReturnType<typeof bindBusinessCommands>;
    control: { calls: number; invalidOutput: boolean; attackTable?: string; delay: number };
    reopen(): Promise<void>;
    rebind(): Promise<void>;
  }) => Promise<void>,
  handler?: (context: BusinessCommandContext, input: { reviewer: string; note: string }) => Promise<unknown>,
  secondary = false,
  availability?: (context: BusinessCommandAvailabilityContext) => readonly boolean[] | Promise<readonly boolean[]>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-execution-'));
  const path = join(directory, 'loans.db');
  const db = new DatabaseSync(path);
  let registry = new Registry();
  try {
    if (secondary) {
      const directoryDb = new DatabaseSync(join(directory, 'directory.db'));
      try {
        directoryDb.exec('CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT)');
      } finally {
        directoryDb.close();
      }
    }
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE loans (tenant TEXT NOT NULL, id INTEGER NOT NULL, version INTEGER NOT NULL,
        assignee TEXT NOT NULL, confidential_note TEXT NOT NULL, PRIMARY KEY (tenant, id));
      CREATE TABLE assignment_history (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL,
        loan_id INTEGER NOT NULL, reviewer TEXT NOT NULL, note TEXT NOT NULL,
        FOREIGN KEY (tenant, loan_id) REFERENCES loans (tenant, id));
      INSERT INTO loans VALUES ('retail', 1, 0, 'Unassigned', 'Private untouched loan detail');
    `);
    await migrateSqliteCommandJournal(path);
    const app = parseAppConfig(
      {
        id: actor.appId,
        name: 'Loan workspace',
        sources: {
          ...(secondary ? { directory: { connection: 'private-directory', default: true } } : {}),
          operations: { connection: 'private-loans' },
        },
        resources: Object.fromEntries(
          [
            ['loan', 'loans'],
            ['assignment_history', 'assignment_history'],
          ].map(([name, physical]) => [secondary ? `operations.${name}` : name, { physical, access: 'write' }]),
        ),
        auth: { roles: { reviewer: { read: true, commands: ['assign-reviewer'] }, viewer: { read: true } } },
        views: { loans: { kind: 'list', from: secondary ? 'operations.loan' : 'loan' } },
        home: 'loans',
      },
      'execution fixture',
    );
    const control = { calls: 0, invalidOutput: false, attackTable: undefined as string | undefined, delay: 0 };
    const commands = defineCommands({
      'assign-reviewer': defineCommand({
        source: 'operations',
        target: 'loan',
        write: ['assignment_history'],
        ...(availability ? { availability } : {}),
        // A required reviewer, trimmed, and a note: the declaration's parser checks both.
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
        async handle(context, input) {
          control.calls++;
          assert.deepEqual(Object.keys(context.tx).sort(), ['count', 'insert', 'query', 'remove', 'update']);
          if (handler) return handler(context, input);
          if (control.delay) await new Promise((resolve) => setTimeout(resolve, control.delay));
          if (control.attackTable) await context.tx.query({ table: control.attackTable, limit: 1, offset: 0 });
          // The raw transaction on purpose: this suite proves the escape hatch keeps the footprint, audit and conflict rules.
          const { record } = context,
            version = Number(record.version);
          await context.tx.update({
            table: 'loan',
            key: keyOf(context),
            expected: { assignee: String(record.assignee), version },
            values: { assignee: input.reviewer, version: version + 1 },
          });
          await context.tx.insert({
            table: 'assignment_history',
            values: {
              tenant: String(record.tenant),
              loan_id: Number(record.id),
              reviewer: input.reviewer,
              note: input.note,
            },
          });
          return control.invalidOutput ? { privateError: 'Must not persist' } : { reviewer: input.reviewer, version: version + 1 };
        },
      }),
    });
    let binding: ReturnType<typeof bindBusinessCommands>;
    const register = () => {
      if (secondary)
        registry.add({
          id: 'private-directory',
          name: 'Read-only directory',
          url: join(directory, 'directory.db'),
          writable: false,
          source: 'config',
        });
      registry.add({ id: 'private-loans', name: 'Private loans', url: path, writable: true, source: 'config' });
    };
    const rebind = async () => {
      const resources = await loadAppRuntimeResources(registry, app, secondary ? 'private-directory' : 'private-loans');
      binding = bindBusinessCommands({
        app,
        registry: commands,
        resources,
        writableConnection: (id) => registry.configOf(id)?.writable === true,
      });
    };
    register();
    await rebind();
    await run({
      db,
      path,
      app,
      control,
      get registry() {
        return registry;
      },
      get binding() {
        return binding;
      },
      rebind,
      reopen: async () => {
        await registry.closeAll();
        registry = new Registry();
        register();
        await rebind();
      },
    });
  } finally {
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function rows(db: DatabaseSync, table: string) {
  // A table by name, or a subquery (a receipt's targets, support/commandTargets.ts).
  return db.prepare(`SELECT * FROM ${table.startsWith('(') ? `${table} a` : `"${table.replaceAll('"', '""')}"`}`).all();
}

function errorCode(code: string, outcome = 'not_applied') {
  return (error: unknown) => {
    assert.ok(error instanceof BusinessCommandExecutionError);
    assert.equal(error.code, code);
    assert.equal(error.outcome, outcome);
    assert.doesNotMatch(error.message, /Private validator|Private output|SELECT|UPDATE|loans\.db/);
    return true;
  };
}

/* Where the App hides nothing from this caller, an integrity rule the engine
   names is a permanent conflict — told to retry it, a caller retried forever.
   A scoped invocation keeps the value-free answer instead; tenant-commands
   pins that side. */
for (const [name, values, code] of [
  [
    'a duplicate key is a conflict',
    { tenant: 'retail', id: 1, version: 0, assignee: 'Ada', confidential_note: 'Second' },
    'duplicate_record',
  ],
  [
    'a reference to nothing is an ineligible state',
    { tenant: 'retail', loan_id: 404, reviewer: 'Ada', note: 'Orphan' },
    'ineligible_state',
  ],
] as const) {
  test(`unscoped commands: ${name}, not an outage to retry`, async () => {
    await fixture(
      async (f) => {
        await assert.rejects(executeBusinessCommand(f.binding, actor, request()), errorCode(code));
        assert.equal(rows(f.db, 'loans')[0].version, 0);
        assert.equal(rows(f.db, 'assignment_history').length, 0);
        assert.equal(rows(f.db, COMMAND_JOURNAL_TABLES.receipt).length, 0);
      },
      async (context) => {
        await context.tx.insert({ table: 'loan_id' in values ? 'assignment_history' : 'loan', values });
        return { version: 1 };
      },
    );
  });
}

test('unscoped commands: a constraint on a column the input carries marks that field (UX-5)', async () => {
  await fixture(
    async (f) => {
      await assert.rejects(executeBusinessCommand(f.binding, actor, request()), (error: unknown) => {
        assert.ok(errorCode('invalid_input')(error));
        assert.equal((error as BusinessCommandExecutionError).field, 'reviewer');
        return true;
      });
    },
    // The engine's own refusal, as SQLite raises it for a NOT NULL column (the writer refuses a null before it).
    async () => {
      throw Object.assign(new Error('NOT NULL constraint failed: assignment_history.reviewer'), { errcode: 1299 });
    },
  );
  // A column the input does not carry is no field of the form: the refusal names none.
  await fixture(
    async (f) => {
      await assert.rejects(executeBusinessCommand(f.binding, actor, request()), (error: unknown) => {
        assert.ok(errorCode('invalid_input')(error));
        assert.equal((error as BusinessCommandExecutionError).field, undefined);
        return true;
      });
    },
    async () => {
      throw Object.assign(new Error('NOT NULL constraint failed: assignment_history.tenant'), { errcode: 1299 });
    },
  );
});

test('a command commits domain writes, one durable receipt and audit together', async () => {
  await fixture(async (f) => {
    const result = await executeBusinessCommand(f.binding, actor, request(), {
      requestId: 'verified-request',
      now: () => new Date('2026-09-07T12:00:00Z'),
    });
    assert.equal(result.status, 'applied');
    assert.equal(result.command, 'assign-reviewer');
    assert.equal(result.resource, 'loan');
    assert.deepEqual({ ...result.key }, { tenant: 'retail', id: 1 });
    assert.deepEqual(result.result, { reviewer: 'Ada', version: 1 });
    assert.equal(result.replayed, false);
    assert.equal(typeof result.receiptId, 'string');
    assert.ok(result.receiptId.length > 0);
    assert.deepEqual(
      { ...rows(f.db, 'loans')[0] },
      { tenant: 'retail', id: 1, version: 1, assignee: 'Ada', confidential_note: 'Private untouched loan detail' },
    );
    assert.equal(rows(f.db, 'assignment_history').length, 1);
    const receipts = rows(f.db, COMMAND_JOURNAL_TABLES.receipt);
    const audit = rows(f.db, sqliteAuditRows);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].id, result.receiptId);
    assert.equal(receipts[0].app_id, actor.appId);
    assert.equal(receipts[0].actor_id, actor.id);
    assert.equal(receipts[0].command_id, 'assign-reviewer');
    assert.equal(receipts[0].command_version, 1);
    assert.equal(receipts[0].request_id, 'verified-request');
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
    assert.doesNotMatch(JSON.stringify(audit), /Private untouched loan detail|confidential_note|SELECT |UPDATE /);
    assert.equal(f.control.calls, 1);
  });
});

test('duplicate delivery replays the receipt without repeating the handler; changed payload conflicts', async () => {
  await fixture(async (f) => {
    const first = await executeBusinessCommand(f.binding, actor, request());
    const replay = await executeBusinessCommand(f.binding, actor, request());
    assert.deepEqual(replay, { ...first, replayed: true });
    await assert.rejects(
      executeBusinessCommand(f.binding, actor, request({ input: { reviewer: 'Grace', note: 'Different' } })),
      errorCode('idempotency_conflict'),
    );
    await assert.rejects(executeBusinessCommand(f.binding, actor, request({ expectedVersion: 1 })), errorCode('idempotency_conflict'));
    assert.equal(f.control.calls, 1);
    assert.equal(rows(f.db, 'assignment_history').length, 1);
    assert.equal(rows(f.db, COMMAND_JOURNAL_TABLES.receipt).length, 1);
  });
});

test('status requires an exact authorized fingerprint and missing receipts always mean unknown', async () => {
  await fixture(async (f) => {
    assert.deepEqual(await lookupBusinessCommandStatus(f.binding, actor, request()), { status: 'not_found', outcome: 'unknown' });
    assert.equal(f.control.calls, 0);
    const result = await executeBusinessCommand(f.binding, actor, request());
    assert.equal(result.commandVersion, 1);
    await f.reopen();
    assert.deepEqual(await lookupBusinessCommandStatus(f.binding, actor, request()), { ...result, replayed: true });
    await assert.rejects(
      lookupBusinessCommandStatus(f.binding, actor, request({ expectedVersion: 2 })),
      errorCode('idempotency_conflict', 'unknown'),
    );
    await assert.rejects(
      lookupBusinessCommandStatus(f.binding, { ...actor, roles: ['viewer'] }, request()),
      errorCode('forbidden', 'unknown'),
    );
    await assert.rejects(
      lookupBusinessCommandStatus(f.binding, actor, { command: 'assign-reviewer' }),
      errorCode('invalid_input', 'unknown'),
    );
    await assert.rejects(lookupBusinessCommandStatus(f.binding, { ...actor, id: '' }, request()), errorCode('forbidden', 'unknown'));
    assert.deepEqual(await lookupBusinessCommandStatus(f.binding, { ...actor, id: 'other-account' }, request()), {
      status: 'not_found',
      outcome: 'unknown',
    });
    assert.equal(f.control.calls, 1);
  });
});

test('a retained command version cannot silently execute or look up under a new version', async () => {
  await fixture(async (f) => {
    for (const commandVersion of [2, 3]) {
      await assert.rejects(
        executeBusinessCommand(f.binding, actor, request({ commandVersion })),
        errorCode('command_version_mismatch', 'unknown'),
      );
      await assert.rejects(
        lookupBusinessCommandStatus(f.binding, actor, request({ commandVersion })),
        errorCode('command_version_mismatch', 'unknown'),
      );
    }
    assert.equal(f.control.calls, 0);
  });
});

test('status after a revoked command grant cannot disclose a prior receipt or imply rollback', async () => {
  await fixture(async (f) => {
    await executeBusinessCommand(f.binding, actor, request());
    f.app.auth!.roles!.reviewer.commands = [];
    await f.rebind();
    await assert.rejects(lookupBusinessCommandStatus(f.binding, actor, request()), errorCode('forbidden', 'unknown'));
    assert.equal(f.control.calls, 1);
  });
});

test('canonical validated input and reordered composite keys produce the same replay identity', async () => {
  await fixture(async (f) => {
    const first = await executeBusinessCommand(f.binding, actor, request());
    const replay = await executeBusinessCommand(
      f.binding,
      actor,
      request({
        key: { id: 1, tenant: 'retail' },
        input: { note: 'Review assignment', reviewer: '  Ada  ' },
      }),
    );
    assert.equal(replay.receiptId, first.receiptId);
    assert.equal(replay.replayed, true);
    assert.equal(f.control.calls, 1);
  });
});

/* invalid_result, and nothing anywhere saying why, was what a Buffer handed
   to db.insert and a change past the audit's bound both earned. The caller
   still hears the one code; the operator reads the reason recorded on it. */
for (const [name, note, reason] of [
  ['a binary value', new Uint8Array([1, 2, 3]), /wrote bytes to assignment_history\.note, which is not a file resource it writes/],
  ['a change past the audit bound', 'x'.repeat(70_000), /changes to assignment_history are over the 64 KiB its audit keeps for one target/],
] as const) {
  test(`${name} the audit cannot keep is invalid_result, with its reason recorded for the operator`, async () => {
    await fixture(
      async (f) => {
        const refused: unknown = await executeBusinessCommand(f.binding, actor, request()).then(
          () => undefined,
          (error: unknown) => error,
        );
        errorCode('invalid_result')(refused);
        assert.match(refusalReasons(refused).join('\n'), reason);
        assert.equal(rows(f.db, 'assignment_history').length, 0);
      },
      async (context) => {
        // A Buffer is what a handler reading a file hands over; the declaration types a value as JSON.
        await context.tx.insert({
          table: 'assignment_history',
          values: { tenant: 'retail', loan_id: 1, reviewer: 'Ada', note: note as string },
        });
        return { version: 1 };
      },
    );
  });
}

test('invalid input is rejected before the handler and invalid output rolls all writes back', async () => {
  await fixture(async (f) => {
    await assert.rejects(executeBusinessCommand(f.binding, actor, request({ input: { reviewer: 2 } })), errorCode('invalid_input'));
    assert.equal(f.control.calls, 0);
    f.control.invalidOutput = true;
    await assert.rejects(executeBusinessCommand(f.binding, actor, request()), errorCode('invalid_result'));
    assert.equal(f.control.calls, 1);
    assert.equal(rows(f.db, 'loans')[0].version, 0);
    for (const table of ['assignment_history', COMMAND_JOURNAL_TABLES.receipt, sqliteAuditRows]) assert.equal(rows(f.db, table).length, 0);
    f.control.invalidOutput = false;
    const retry = await executeBusinessCommand(f.binding, actor, request());
    assert.equal(retry.replayed, false);
  });
});

/* A handler that imported @mistriwork/mistri/commands from another copy of the
   package — dist/ beside a server running from src/, or its own bundled
   tablewalk — throws classes that fail `instanceof` here. The registered
   brand is what the classification reads, so the outcome is the native
   one; an unbranded look-alike is still an unexpected failure. */
const foreignErrorBrand = Symbol.for('mistri.businessCommandExecutionError');
const foreignConflictBrand = Symbol.for('mistri.writeConflict');
class ForeignExecutionError extends Error {
  readonly [foreignErrorBrand] = true;
  constructor(
    readonly code: string,
    readonly outcome: 'not_applied' | 'unknown' = 'not_applied',
  ) {
    super('foreign copy');
    this.name = 'BusinessCommandExecutionError';
  }
}
class ForeignWriteConflict extends Error {
  readonly [foreignConflictBrand] = true;
  constructor() {
    super('foreign conflict');
    this.name = 'WriteConflict';
  }
}
class UnbrandedLookAlike extends Error {
  constructor(
    readonly code: string,
    readonly outcome = 'not_applied',
  ) {
    super('impostor');
    this.name = 'BusinessCommandExecutionError';
  }
}

for (const [name, thrown, code] of [
  ['a branded foreign execution error keeps its code', new ForeignExecutionError('forbidden'), 'forbidden'],
  ['a branded foreign stale_record keeps its code', new ForeignExecutionError('stale_record'), 'stale_record'],
  ['a branded foreign write conflict is a stale record', new ForeignWriteConflict(), 'stale_record'],
  ['a same-named error without the brand is an unexpected failure', new UnbrandedLookAlike('forbidden'), 'temporarily_unavailable'],
  ['a branded error with an unknown code is an unexpected failure', new ForeignExecutionError('drop_tables'), 'temporarily_unavailable'],
] as const) {
  test(`foreign classes: ${name}, exactly as the native class would`, async () => {
    await fixture(
      async (f) => {
        assert.ok(!(thrown instanceof BusinessCommandExecutionError));
        await assert.rejects(executeBusinessCommand(f.binding, actor, request()), errorCode(code));
        assert.equal(rows(f.db, 'loans')[0].version, 0);
        assert.equal(rows(f.db, COMMAND_JOURNAL_TABLES.receipt).length, 0);
      },
      async () => {
        throw thrown;
      },
    );
  });
}

test('foreign classes: a branded unknown outcome is reported as unknown, like the native class', async () => {
  await fixture(
    async (f) => {
      await assert.rejects(executeBusinessCommand(f.binding, actor, request()), errorCode('stale_record', 'unknown'));
    },
    async () => {
      throw new ForeignExecutionError('stale_record', 'unknown');
    },
  );
  await fixture(
    async (f) => {
      await assert.rejects(executeBusinessCommand(f.binding, actor, request()), errorCode('stale_record', 'unknown'));
    },
    async () => {
      throw new BusinessCommandExecutionError('stale_record', 'unknown');
    },
  );
});

test('stale versions roll back without issuing a receipt and a distinct request can apply later', async () => {
  await fixture(async (f) => {
    await assert.rejects(executeBusinessCommand(f.binding, actor, request({ expectedVersion: 3 })), errorCode('stale_record'));
    assert.equal(rows(f.db, 'loans')[0].version, 0);
    assert.equal(rows(f.db, COMMAND_JOURNAL_TABLES.receipt).length, 0);
    await executeBusinessCommand(f.binding, actor, request({ idempotencyKey: 'fresh-assignment-request' }));
    assert.equal(rows(f.db, 'loans')[0].version, 1);
  });
});

test('authorization precedes receipt replay, including revoked command grants', async () => {
  await fixture(async (f) => {
    await executeBusinessCommand(f.binding, actor, request());
    await assert.rejects(executeBusinessCommand(f.binding, { ...actor, roles: ['viewer'] }, request()), errorCode('forbidden'));
    await assert.rejects(executeBusinessCommand(f.binding, { ...actor, appId: 'other-app' }, request()), errorCode('forbidden'));
    f.app.auth!.roles!.reviewer.commands = [];
    await f.rebind();
    await assert.rejects(executeBusinessCommand(f.binding, actor, request()), errorCode('forbidden'));
    assert.equal(f.control.calls, 1);
    assert.equal(rows(f.db, COMMAND_JOURNAL_TABLES.receipt).length, 1);
  });
});

test('a pre-aborted request cannot enter the handler or write receipts', async () => {
  await fixture(async (f) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(executeBusinessCommand(f.binding, actor, request(), { signal: controller.signal }), errorCode('cancelled'));
    assert.equal(f.control.calls, 0);
    assert.equal(rows(f.db, 'loans')[0].version, 0);
    assert.equal(rows(f.db, COMMAND_JOURNAL_TABLES.receipt).length, 0);
  });
});

test('receipts are owned by the verified actor, not just a shared idempotency key', async () => {
  await fixture(async (f) => {
    const first = await executeBusinessCommand(f.binding, actor, request());
    const secondActor = { ...actor, id: 'account-b' };
    await assert.rejects(executeBusinessCommand(f.binding, secondActor, request()), errorCode('stale_record'));
    const second = await executeBusinessCommand(f.binding, secondActor, request({ expectedVersion: 1 }));
    assert.equal(second.replayed, false);
    assert.notEqual(second.receiptId, first.receiptId);
    assert.deepEqual(
      rows(f.db, COMMAND_JOURNAL_TABLES.receipt)
        .map((row) => row.actor_id)
        .sort(),
      ['account-a', 'account-b'],
    );
    assert.equal(rows(f.db, 'loans')[0].version, 2);
  });
});

test('journal tables are hidden from catalogs and cannot be queried by command handlers or aliased as app resources', async () => {
  await fixture(async (f) => {
    const opened = await f.registry.open('private-loans');
    const resources = await loadAppRuntimeResources(f.registry, f.app, 'private-loans');
    for (const table of Object.values(COMMAND_JOURNAL_TABLES)) {
      assert.equal(
        opened.schema.tables.some((entry) => entry.id === table),
        true,
      );
      assert.equal(
        resources.schema.tables.some((entry) => entry.id === table),
        false,
      );
      f.control.attackTable = table;
      await assert.rejects(executeBusinessCommand(f.binding, actor, request()), errorCode('forbidden'));
    }
    assert.equal(rows(f.db, 'loans')[0].version, 0);
    assert.equal(rows(f.db, COMMAND_JOURNAL_TABLES.receipt).length, 0);
    f.app.resources = {
      ...f.app.resources,
      [f.app.sources!.operations.default ? 'leaked_receipt' : 'operations.leaked_receipt']: {
        source: 'operations',
        physical: COMMAND_JOURNAL_TABLES.receipt,
      },
    };
    await assert.rejects(f.rebind());
  });
});

test('concurrent duplicate deliveries execute exactly once', async () => {
  await fixture(async (f) => {
    f.control.delay = 15;
    const results = await Promise.all([
      executeBusinessCommand(f.binding, actor, request()),
      executeBusinessCommand(f.binding, actor, request()),
    ]);
    assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
    assert.equal(results[0].receiptId, results[1].receiptId);
    assert.equal(f.control.calls, 1);
    assert.equal(rows(f.db, 'assignment_history').length, 1);
    assert.equal(rows(f.db, COMMAND_JOURNAL_TABLES.receipt).length, 1);
    assert.equal(rows(f.db, sqliteAuditRows).length, 1);
  });
});

test('receipt replay survives registry disposal and reopening the same database', async () => {
  await fixture(async (f) => {
    const first = await executeBusinessCommand(f.binding, actor, request());
    await f.reopen();
    const replay = await executeBusinessCommand(f.binding, actor, request());
    assert.deepEqual(replay, { ...first, replayed: true });
    assert.equal(f.control.calls, 1);
    assert.equal(rows(f.db, 'loans')[0].version, 1);
    assert.equal(rows(f.db, 'assignment_history').length, 1);
  });
});

test('secondary-source results and audit targets retain the full logical resource identity', async () => {
  await fixture(
    async (f) => {
      const result = await executeBusinessCommand(f.binding, actor, request());
      assert.equal(result.resource, 'operations.loan');
      assert.equal(rows(f.db, sqliteAuditRows)[0].target, 'operations.loan');
      assert.equal(rows(f.db, 'loans')[0].version, 1);
      assert.equal(rows(f.db, 'assignment_history').length, 1);
      assert.equal(f.registry.configOf('private-directory')?.writable, false);
      const replay = await executeBusinessCommand(f.binding, actor, request());
      assert.equal(replay.replayed, true);
      assert.equal(replay.resource, 'operations.loan');
      assert.equal(f.control.calls, 1);
    },
    undefined,
    true,
  );
});

test('queued operation requests snapshot tables, keys, expected values and nested read filters at acceptance', async () => {
  await fixture(
    async (f) => {
      await executeBusinessCommand(f.binding, actor, request());
      assert.equal(rows(f.db, 'loans')[0].assignee, 'Ada');
      assert.equal(rows(f.db, 'loans')[0].version, 1);
      assert.equal(rows(f.db, 'assignment_history').length, 0);
      const changes = JSON.parse(String(rows(f.db, sqliteAuditRows)[0].changes_json));
      assert.deepEqual(changes, [
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
        { operation: 'delete', resource: 'assignment_history', key: { id: 1 } },
      ]);
    },
    async (context, input) => {
      const read = {
        table: 'loan',
        columns: ['assignee'],
        limit: 1,
        offset: 0,
        filter: { groups: [[{ column: 'id', op: '=' as const, value: 1 }]] },
      };
      const reading = context.tx.query(read);
      read.table = 'assignment_history';
      read.columns[0] = 'reviewer';
      read.filter.groups[0][0].value = 999;
      assert.deepEqual((await reading).rows, [{ assignee: 'Unassigned' }]);
      const filter = { groups: [[{ column: 'id', op: '=' as const, value: 1 }]] };
      const counting = context.tx.count('loan', filter);
      filter.groups[0][0].value = 999;
      assert.equal(await counting, 1);

      const update = {
        table: 'loan',
        key: keyOf(context),
        expected: { assignee: 'Unassigned', version: 0 },
        values: { assignee: input.reviewer, version: 1 },
      };
      const updating = context.tx.update(update);
      update.table = 'assignment_history';
      update.key.id = 999;
      update.expected.version = 77;
      update.values.assignee = 'Mutated queued update';
      await updating;

      const insert = { table: 'assignment_history', values: { tenant: 'retail', loan_id: 1, reviewer: input.reviewer, note: input.note } };
      const inserting = context.tx.insert(insert);
      insert.table = 'loan';
      insert.values.loan_id = 999;
      insert.values.reviewer = 'Mutated queued insert';
      const inserted = await inserting;

      const remove = { table: 'assignment_history', key: { ...inserted.key } };
      const removing = context.tx.remove(remove);
      remove.table = 'loan';
      remove.key.id = 999;
      await removing;
      return { version: 1 };
    },
  );
});

test('later mutations of write results and request keys cannot rewrite committed audit entries', async () => {
  await fixture(
    async (f) => {
      await executeBusinessCommand(f.binding, actor, request());
      assert.equal(rows(f.db, 'loans')[0].assignee, 'Ada');
      assert.equal(rows(f.db, 'loans')[0].version, 1);
      assert.equal(rows(f.db, 'assignment_history').length, 0);
      const changes = JSON.parse(String(rows(f.db, sqliteAuditRows)[0].changes_json));
      assert.deepEqual(changes, [
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
        { operation: 'delete', resource: 'assignment_history', key: { id: 1 } },
      ]);
    },
    async (context, input) => {
      const update = {
        table: 'loan',
        key: keyOf(context),
        expected: { assignee: 'Unassigned', version: 0 },
        values: { assignee: input.reviewer, version: 1 },
      };
      const updated = await context.tx.update(update);
      update.key.id = 999;
      update.key.tenant = 'Forged audit tenant';
      update.values.assignee = 'Forged request value';
      updated.applied.assignee = 'Forged returned value';
      updated.applied.version = 999;

      const insert = { table: 'assignment_history', values: { tenant: 'retail', loan_id: 1, reviewer: input.reviewer, note: input.note } };
      const inserted = await context.tx.insert(insert);
      const insertedKey = { ...inserted.key };
      insert.values.reviewer = 'Forged insert request';
      inserted.applied.reviewer = 'Forged insert result';
      inserted.key.id = 999;
      const remove = { table: 'assignment_history', key: insertedKey };
      await context.tx.remove(remove);
      remove.key.id = 888;
      return { version: 1 };
    },
  );
});
