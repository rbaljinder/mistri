import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import {
  COMMAND_JOURNAL_TABLES as tables,
  CommandTransactionFailure,
  migrateSqliteCommandJournal,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.js';
import { createAppResources } from '../packages/mistri/src/server/app/appResources.js';
import type { RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import type { AuthorizedBusinessCommand, BusinessCommandBinding } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import {
  BusinessCommandExecutionError,
  executeBusinessCommand,
  lookupBusinessCommandStatus,
} from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands, type BusinessCommandContext } from '../packages/mistri/src/server/commands/businessCommands.js';
import {
  bindScopedBusinessCommands,
  type CommandResultReference,
} from '../packages/mistri/src/server/commands/scopedBusinessCommandAccess.js';
import { commandCatalog } from '../packages/mistri/src/server/commands/commandDb.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

const actor = { id: 'actor-a', appId: 'scoped-app', roles: ['manager'] };
const request = () => ({
  command: 'assign',
  commandVersion: 1,
  key: { id: 1 },
  expectedVersion: 0,
  idempotencyKey: 'scoped-attempt-0001',
  input: { reviewerId: 1 },
});
const rowScope = (): RowScope => ({ item: true, reviewer: { groups: [[{ column: 'visible', op: '=', value: 1 }]] } });
type Result = { reviewerId: number; version: number; detail: { message: string } };
/* The fixture's tables as the command's catalog reads them: the hand-built
   binding below carries a catalog, as every real one does. */
const catalogSchema: DatabaseSchema = {
  label: 'data',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'item',
      schema: 'main',
      name: 'item',
      isView: false,
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'version', type: 'INTEGER', nullable: false, primaryKey: false },
        { name: 'reviewer_id', type: 'INTEGER', nullable: false, primaryKey: false },
      ],
    },
    {
      id: 'reviewer',
      schema: 'main',
      name: 'reviewer',
      isView: false,
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'visible', type: 'INTEGER', nullable: false, primaryKey: false },
      ],
    },
  ],
};
/** The target's key, from the record the platform read. */
const itemKey = (context: BusinessCommandContext) => ({ id: Number(context.record!.id) });

function fixture(t: TestContext, scoped = true) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-scoped-execution-'));
  const path = join(directory, 'data.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE item (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, reviewer_id INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE reviewer (id INTEGER PRIMARY KEY, visible INTEGER NOT NULL);
    INSERT INTO item (id, version) VALUES (1, 0);
    INSERT INTO reviewer VALUES (1, 1), (2, 0);
  `);
  migrateSqliteCommandJournal(path);
  let adapter = new SqliteAdapter(path);
  t.after(async () => {
    try {
      await adapter.close();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const events: string[] = [];
  const control = {
    calls: 0,
    parses: 0,
    denyGrant: false,
    denyTarget: false,
    denyResult: false,
    lookupError: false,
    commitError: false,
    validate: (value: unknown): unknown => value,
    afterResult: undefined as (() => void | Promise<void>) | undefined,
    handle: undefined as ((context: BusinessCommandContext) => Promise<unknown>) | undefined,
  };
  const command = defineCommand({
    source: 'data',
    target: 'item',
    read: ['item', 'reviewer'],
    write: ['item'],
    input: { reviewerId: { label: 'Reviewer', type: 'number', integer: true } },
    output: {
      parse(value: unknown) {
        control.parses++;
        return control.validate(value);
      },
    },
    async handle(context, input) {
      events.push('handle');
      control.calls++;
      if (control.handle) return control.handle(context);
      const version = Number(context.record.version);
      await context.tx.update({ table: 'item', key: itemKey(context), expected: { version }, values: { version: version + 1 } });
      return { reviewerId: input.reviewerId, version: version + 1, detail: { message: 'Assigned.' } };
    },
  });
  const visible = async (records: WriteTransaction, table: string, key: Readonly<Record<string, string | number>>) => {
    const result = await records.query({
      table,
      columns: Object.keys(key),
      limit: 2,
      offset: 0,
      filter: { groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
    });
    if (result.rows.length !== 1) throw new AppAccessDenied();
  };
  const authorized: AuthorizedBusinessCommand = {
    command,
    resource: 'item',
    actor,
    keyColumns: ['id'],
    versionField: 'version',
    catalog: commandCatalog(catalogSchema, command.read, (local) => local)!,
    transaction: (run) => adapter.transaction(run),
    commandTransaction: (run) =>
      commandsOf(adapter).scopeCommandTransaction(rowScope(), async (records, journal) => {
        return run(records, {
          find: (scope) => {
            events.push('find');
            if (control.lookupError) throw new Error('PRIVATE lookup details');
            return journal.find(scope);
          },
          commit: (receipt, audit) => {
            events.push('commit');
            if (control.commitError) throw new Error('PRIVATE commit details');
            return journal.commit(receipt, audit);
          },
        });
      }),
    ...(scoped
      ? {
          async assertTarget(records: WriteTransaction, key: Readonly<Record<string, string | number>>) {
            events.push('target');
            if (control.denyTarget) throw new AppAccessDenied();
            await visible(records, 'item', key);
          },
          async assertResult(records: WriteTransaction, key: Readonly<Record<string, string | number>>, value: unknown) {
            events.push('result');
            assert.ok(Object.isFrozen(key));
            assert.ok(Object.isFrozen(value));
            const result = value as Result;
            assert.ok(Object.isFrozen(result.detail));
            assert.throws(() => {
              result.detail.message = 'PRIVATE mutation';
            }, TypeError);
            if (control.denyResult) throw new AppAccessDenied();
            await visible(records, 'reviewer', { id: result.reviewerId });
            await control.afterResult?.();
          },
        }
      : {}),
  };
  const binding: BusinessCommandBinding = {
    ...(scoped ? { scoped: true as const } : {}),
    authorize() {
      if (control.denyGrant) throw new AppAccessDenied();
      return authorized;
    },
  };
  return {
    db,
    path,
    binding,
    authorized,
    control,
    events,
    async realBinding(
      scope = rowScope(),
      assertActive = () => {},
      references: (result: unknown) => readonly CommandResultReference[] = (result) => [
        { table: 'reviewer', key: { id: (result as Result).reviewerId } },
      ],
    ) {
      const app = parseAppConfig(
        {
          id: actor.appId,
          name: 'Scoped commands',
          sources: { data: { connection: 'private-data' } },
          resources: { item: { access: 'write' }, reviewer: {} },
          auth: { roles: { manager: { read: true, commands: ['assign'] } } },
          views: { items: { kind: 'list', from: 'item' } },
          home: 'items',
        },
        'scoped execution fixture',
      );
      const mapped = createAppResources(adapter, await adapter.introspect());
      const resources: RuntimeResources = {
        ...mapped,
        connections: ['private-data'],
        connectionFor: () => 'private-data',
        toLogicalAt: (table) => mapped.toLogical(table),
        forConnection: () => mapped.adapter,
      };
      return bindScopedBusinessCommands({
        app,
        resources,
        registry: defineCommands({ assign: command }),
        writableConnection: () => true,
        resultReferences: { assign: references },
      }).withScope(scope, assertActive);
    },
    reopen: async () => {
      await adapter.close();
      adapter = new SqliteAdapter(path);
    },
    version: () => db.prepare('SELECT version FROM item WHERE id = 1').get()?.version,
    receipts: () => db.prepare(`SELECT * FROM "${tables.receipt}"`).all(),
    audits: () => db.prepare(`SELECT * FROM ${sqliteAuditRows} a`).all(),
  };
}

function refused(code: string, outcome: 'not_applied' | 'unknown') {
  return (error: unknown) => {
    assert.ok(error instanceof BusinessCommandExecutionError);
    assert.equal(error.code, code);
    assert.equal(error.outcome, outcome);
    assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE|SELECT|reviewerId|Assigned\./);
    return true;
  };
}

test('scoped fresh result is immutable and authorized before its atomic receipt; replay/status recheck', async (t) => {
  const f = fixture(t);
  const first = await executeBusinessCommand(f.binding, actor, request());
  assert.deepEqual(f.events, ['target', 'find', 'handle', 'result', 'target', 'commit']);
  assert.equal(f.version(), 1);
  assert.equal(f.receipts().length, 1);
  assert.equal(f.audits().length, 1);
  await f.reopen();
  for (const execute of [executeBusinessCommand, lookupBusinessCommandStatus]) {
    f.events.length = 0;
    assert.deepEqual(await execute(f.binding, actor, request()), { ...first, replayed: true });
    assert.deepEqual(f.events, ['target', 'find', 'result', 'target']);
  }
  assert.equal(f.control.calls, 1);
  assert.equal(f.control.parses, 3);
});

for (const denial of ['denyGrant', 'denyTarget', 'lookupError'] as const) {
  test(`scoped ${denial} before established receipt absence remains unknown`, async (t) => {
    const f = fixture(t);
    f.control[denial] = true;
    await assert.rejects(
      executeBusinessCommand(f.binding, actor, request()),
      refused(denial === 'lookupError' ? 'temporarily_unavailable' : 'forbidden', 'unknown'),
    );
    assert.equal(f.control.calls, 0);
    assert.equal(f.receipts().length, 0);
    if (denial !== 'lookupError') assert.ok(!f.events.includes('find'));
  });
}

for (const denial of ['denyGrant', 'denyTarget', 'denyResult', 'lookupError'] as const) {
  for (const status of [false, true]) {
    test(`scoped ${status ? 'status' : 'replay'} ${denial} conceals a committed result without claiming rollback`, async (t) => {
      const f = fixture(t);
      await executeBusinessCommand(f.binding, actor, request());
      const before = f.receipts();
      f.control[denial] = true;
      await assert.rejects(
        (status ? lookupBusinessCommandStatus : executeBusinessCommand)(f.binding, actor, request()),
        refused(denial === 'lookupError' ? 'temporarily_unavailable' : 'forbidden', 'unknown'),
      );
      assert.equal(f.control.calls, 1);
      assert.equal(f.version(), 1);
      assert.deepEqual(f.receipts(), before);
    });
  }
}

test('hidden non-target result dependency rolls back fresh business writes, receipt and audit', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    executeBusinessCommand(f.binding, actor, { ...request(), input: { reviewerId: 2 } }),
    refused('forbidden', 'not_applied'),
  );
  assert.equal(f.version(), 0);
  assert.equal(f.receipts().length, 0);
  assert.equal(f.audits().length, 0);
  assert.ok(!f.events.includes('commit'));
});

test('a historical dependency becoming hidden blocks replay even while target remains visible', async (t) => {
  const f = fixture(t);
  await executeBusinessCommand(f.binding, actor, request());
  f.db.exec('UPDATE reviewer SET visible = 0 WHERE id = 1');
  await assert.rejects(executeBusinessCommand(f.binding, actor, request()), refused('forbidden', 'unknown'));
  await assert.rejects(lookupBusinessCommandStatus(f.binding, actor, request()), refused('forbidden', 'unknown'));
  assert.equal(f.control.calls, 1);
  assert.equal(f.receipts().length, 1);
});

// A row action may delete its own row. Its ceiling is judged just before the removal, not after it.
test('handler deletion of target is judged before the removal and applies', async (t) => {
  const f = fixture(t);
  f.control.handle = async (context) => {
    f.events.push('remove');
    await context.tx.remove({ table: 'item', key: itemKey(context) });
    return { reviewerId: 1, version: 1, detail: { message: 'Assigned.' } };
  };
  const result = await executeBusinessCommand(f.binding, actor, request());
  assert.equal(result.status, 'applied');
  assert.equal(f.version(), undefined);
  assert.equal(f.receipts().length, 1);
  const removing = f.events.indexOf('remove');
  assert.equal(f.events[removing + 1], 'target', 'the target is judged between the handler asking and the row going');
  assert.equal(f.events.slice(removing + 2).includes('target'), false, 'a removed target is not looked for afterwards');
});

test('handler deletion of a target its ceiling refuses at the removal rolls back', async (t) => {
  const f = fixture(t);
  f.control.handle = async (context) => {
    f.control.denyTarget = true;
    await context.tx.remove({ table: 'item', key: itemKey(context) });
    return { reviewerId: 1, version: 1, detail: { message: 'Assigned.' } };
  };
  await assert.rejects(executeBusinessCommand(f.binding, actor, request()), refused('forbidden', 'not_applied'));
  assert.equal(f.version(), 0);
  assert.equal(f.receipts().length, 0);
  assert.equal(f.audits().length, 0);
});

for (const [label, validate] of [
  ['drop a field', (value: unknown) => ({ reviewerId: (value as Result).reviewerId })],
  ['add a field', (value: unknown) => ({ ...(value as Result), extra: true })],
  [
    'mutate validator input',
    (value: unknown) => {
      (value as Result).detail.message = 'PRIVATE changed';
      return value;
    },
  ],
  [
    'throw details',
    () => {
      throw new Error('PRIVATE validator details');
    },
  ],
  ['return a promise', (value: unknown) => Promise.resolve(value)],
] as const) {
  test(`scoped saved output cannot ${label}`, async (t) => {
    const f = fixture(t);
    await executeBusinessCommand(f.binding, actor, request());
    const saved = f.receipts();
    f.control.validate = validate;
    for (const execute of [executeBusinessCommand, lookupBusinessCommandStatus]) {
      await assert.rejects(execute(f.binding, actor, request()), refused('invalid_result', 'unknown'));
    }
    assert.deepEqual(f.receipts(), saved);
    assert.equal(f.control.calls, 1);
  });
}

test('saved validator may reorder keys but cannot rewrite stored serialization', async (t) => {
  const f = fixture(t);
  await executeBusinessCommand(f.binding, actor, request());
  const saved = f.receipts();
  f.control.validate = (value) => {
    const result = value as Result;
    return { version: result.version, reviewerId: result.reviewerId, detail: result.detail };
  };
  assert.equal((await executeBusinessCommand(f.binding, actor, request())).replayed, true);
  assert.deepEqual(f.receipts(), saved);
});

test('invalid fresh output and receipt-write failure prove not_applied after rollback', async (t) => {
  const f = fixture(t);
  f.control.validate = () => {
    throw new Error('PRIVATE invalid result');
  };
  await assert.rejects(executeBusinessCommand(f.binding, actor, request()), refused('invalid_result', 'not_applied'));
  f.control.validate = (value) => value;
  f.control.commitError = true;
  await assert.rejects(executeBusinessCommand(f.binding, actor, request()), refused('temporarily_unavailable', 'not_applied'));
  assert.equal(f.version(), 0);
  assert.equal(f.receipts().length, 0);
  assert.equal(f.audits().length, 0);
});

test('final target refusal after asynchronous result checks rolls back and reveals no result', async (t) => {
  const f = fixture(t);
  f.control.afterResult = async () => {
    await Promise.resolve();
    f.control.denyTarget = true;
  };
  await assert.rejects(executeBusinessCommand(f.binding, actor, request()), refused('forbidden', 'not_applied'));
  assert.equal(f.version(), 0);
  assert.equal(f.receipts().length, 0);
});

test('cancellation during replay result checks stays unknown; fresh checks can prove rollback', async (t) => {
  const f = fixture(t);
  const fresh = new AbortController();
  f.control.afterResult = () => fresh.abort();
  await assert.rejects(executeBusinessCommand(f.binding, actor, request(), { signal: fresh.signal }), refused('cancelled', 'not_applied'));
  assert.equal(f.version(), 0);
  f.control.afterResult = undefined;
  await executeBusinessCommand(f.binding, actor, request());
  const replay = new AbortController();
  f.control.afterResult = () => replay.abort();
  await assert.rejects(executeBusinessCommand(f.binding, actor, request(), { signal: replay.signal }), refused('cancelled', 'unknown'));
  assert.equal(f.control.calls, 2);
});

test('missing status is unknown and never invokes handler/result checks', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await lookupBusinessCommandStatus(f.binding, actor, request()), { status: 'not_found', outcome: 'unknown' });
  assert.deepEqual(f.events, ['target', 'find']);
  assert.equal(f.control.calls, 0);
});

test('scoped conflict remains unknown and does not validate or expose the saved result', async (t) => {
  const f = fixture(t);
  await executeBusinessCommand(f.binding, actor, request());
  f.events.length = 0;
  await assert.rejects(
    executeBusinessCommand(f.binding, actor, { ...request(), expectedVersion: 1 }),
    refused('idempotency_conflict', 'unknown'),
  );
  assert.deepEqual(f.events, ['target', 'find']);
  assert.equal(f.control.calls, 1);
});

test('scoped bindings fail closed if either mandatory authorization hook is missing', async (t) => {
  const f = fixture(t);
  for (const hook of ['assertTarget', 'assertResult'] as const) {
    const binding: BusinessCommandBinding = { scoped: true, authorize: () => ({ ...f.authorized, [hook]: undefined }) };
    await assert.rejects(executeBusinessCommand(binding, actor, request()), refused('forbidden', 'unknown'));
  }
  assert.equal(f.events.length, 0);
});

test('legacy replay retains saved-output behavior and original authorization outcomes', async (t) => {
  const f = fixture(t, false);
  const first = await executeBusinessCommand(f.binding, actor, request());
  f.control.validate = () => {
    throw new Error('PRIVATE changed legacy validator');
  };
  assert.deepEqual(await executeBusinessCommand(f.binding, actor, request()), { ...first, replayed: true });
  assert.equal(f.control.parses, 1);
  f.control.denyGrant = true;
  await assert.rejects(executeBusinessCommand(f.binding, actor, request()), refused('forbidden', 'not_applied'));
});

test('concurrent scoped duplicates execute once and preserve the captured request', async (t) => {
  const f = fixture(t);
  const raw = request();
  const first = executeBusinessCommand(f.binding, actor, raw);
  raw.key.id = 2;
  raw.input.reviewerId = 2;
  const second = executeBusinessCommand(f.binding, actor, request());
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
  assert.equal(results[0].receiptId, results[1].receiptId);
  assert.equal(f.control.calls, 1);
  assert.equal(f.receipts().length, 1);
});

test('uncertain acknowledgment after an actual commit remains unknown and resolves by exact replay', async (t) => {
  const f = fixture(t);
  const binding: BusinessCommandBinding = {
    scoped: true,
    authorize: () => ({
      ...f.authorized,
      async commandTransaction(run) {
        await commandsOf(f.authorized).commandTransaction!(run);
        throw new CommandTransactionFailure(new Error('PRIVATE lost acknowledgment'), 'unknown');
      },
    }),
  };
  await assert.rejects(executeBusinessCommand(binding, actor, request()), refused('temporarily_unavailable', 'unknown'));
  assert.equal(f.version(), 1);
  assert.equal(f.receipts().length, 1);
  assert.equal((await executeBusinessCommand(f.binding, actor, request())).replayed, true);
  assert.equal(f.control.calls, 1);
});

test('real scoped binder executes, replays and authorizes historical dependencies with fresh scopes', async (t) => {
  const f = fixture(t);
  const binding = await f.realBinding();
  const first = await executeBusinessCommand(binding, actor, request());
  assert.deepEqual(await lookupBusinessCommandStatus(binding, actor, request()), { ...first, replayed: true });
  const denied = await f.realBinding({ item: true, reviewer: false });
  for (const execute of [executeBusinessCommand, lookupBusinessCommandStatus]) {
    await assert.rejects(execute(denied, actor, request()), refused('forbidden', 'unknown'));
  }
  assert.equal(f.control.calls, 1);
  assert.equal(f.receipts().length, 1);
  assert.equal(f.audits().length, 1);
});

test('real replay checks the historic reviewer even after the target points to a different visible reviewer', async (t) => {
  const f = fixture(t);
  const binding = await f.realBinding();
  await executeBusinessCommand(binding, actor, request());
  f.db.exec('UPDATE item SET reviewer_id = 2 WHERE id = 1; UPDATE reviewer SET visible = CASE id WHEN 1 THEN 0 ELSE 1 END');
  for (const execute of [executeBusinessCommand, lookupBusinessCommandStatus]) {
    await assert.rejects(execute(binding, actor, request()), refused('forbidden', 'unknown'));
  }
  assert.equal(f.db.prepare('SELECT reviewer_id FROM item WHERE id = 1').get()?.reviewer_id, 2);
  assert.equal(f.control.calls, 1);
  assert.equal(f.receipts().length, 1);
});

test('real scoped binder rolls back writes whose result references a hidden reviewer', async (t) => {
  const f = fixture(t);
  const binding = await f.realBinding();
  await assert.rejects(
    executeBusinessCommand(binding, actor, { ...request(), input: { reviewerId: 2 } }),
    refused('forbidden', 'not_applied'),
  );
  assert.equal(f.version(), 0);
  assert.equal(f.receipts().length, 0);
  assert.equal(f.audits().length, 0);
});

test('real scoped grant and target revocation remain unknown before lookup', async (t) => {
  const f = fixture(t);
  const binding = await f.realBinding();
  await executeBusinessCommand(binding, actor, request());
  await assert.rejects(executeBusinessCommand(binding, { ...actor, roles: [] }, request()), refused('forbidden', 'unknown'));
  const denied = await f.realBinding({ item: false, reviewer: true });
  await assert.rejects(executeBusinessCommand(denied, actor, request()), refused('forbidden', 'unknown'));
  assert.equal(f.control.calls, 1);
});

test('real binder lets a command delete its own visible target', async (t) => {
  const f = fixture(t);
  const binding = await f.realBinding(
    rowScope(),
    () => {},
    () => [],
  );
  f.control.handle = async (context) => {
    await context.tx.remove({ table: 'item', key: itemKey(context) });
    return { reviewerId: 1, version: 1, detail: { message: 'Removed.' } };
  };
  assert.equal((await executeBusinessCommand(binding, actor, request())).status, 'applied');
  assert.equal(f.version(), undefined);
  assert.equal(f.receipts().length, 1);
});

for (const [label, references] of [
  ['undeclared resource', () => [{ table: 'private', key: { id: 1 } }]],
  ['incomplete PK', () => [{ table: 'reviewer', key: {} }]],
  ['extra PK field', () => [{ table: 'reviewer', key: { id: 1, visible: 1 } }]],
  ['qualified resource', () => [{ table: 'data.reviewer', key: { id: 1 } }]],
  ['oversized references', () => Array.from({ length: 65 }, () => ({ table: 'reviewer', key: { id: 1 } }))],
] as const) {
  test(`real executor rejects ${label} result declarations before commit`, async (t) => {
    const f = fixture(t);
    const binding = await f.realBinding(rowScope(), () => {}, references);
    await assert.rejects(executeBusinessCommand(binding, actor, request()), refused('forbidden', 'not_applied'));
    assert.equal(f.version(), 0);
    assert.equal(f.receipts().length, 0);
  });
}

test('real binding lifetime expiry after a handler write forces rollback', async (t) => {
  const f = fixture(t);
  let active = true;
  const binding = await f.realBinding(rowScope(), () => {
    if (!active) throw new AppAccessDenied();
  });
  f.control.handle = async (context) => {
    await context.tx.update({ table: 'item', key: itemKey(context), values: { version: 1 } });
    active = false;
    return { reviewerId: 1, version: 1, detail: { message: 'Assigned.' } };
  };
  await assert.rejects(executeBusinessCommand(binding, actor, request()), refused('forbidden', 'not_applied'));
  assert.equal(f.version(), 0);
  assert.equal(f.receipts().length, 0);
});

test('real binding lifetime expiry during replay authorization preserves the original receipt', async (t) => {
  const f = fixture(t);
  const firstBinding = await f.realBinding();
  await executeBusinessCommand(firstBinding, actor, request());
  let active = true;
  const replayBinding = await f.realBinding(
    rowScope(),
    () => {
      if (!active) throw new AppAccessDenied();
    },
    () => {
      active = false;
      return [{ table: 'reviewer', key: { id: 1 } }];
    },
  );
  await assert.rejects(executeBusinessCommand(replayBinding, actor, request()), refused('forbidden', 'unknown'));
  assert.equal(f.version(), 1);
  assert.equal(f.receipts().length, 1);
  assert.equal(f.control.calls, 1);
});

test('real binder drains caught unawaited handler failures before result authorization or commit', async (t) => {
  const f = fixture(t);
  const binding = await f.realBinding();
  f.control.handle = async (context) => {
    await context.tx.update({ table: 'item', key: itemKey(context), values: { version: 1 } });
    void context.tx.query({ table: 'private', limit: 1, offset: 0 }).catch(() => {});
    return { reviewerId: 1, version: 1, detail: { message: 'Assigned.' } };
  };
  await assert.rejects(executeBusinessCommand(binding, actor, request()), refused('forbidden', 'not_applied'));
  assert.equal(f.version(), 0);
  assert.equal(f.receipts().length, 0);
});

for (const nested of [false, true]) {
  test(`scoped ${nested ? 'nested' : 'request'} getters are never invoked and caught capture refusal rolls back earlier writes`, async (t) => {
    const f = fixture(t);
    const binding = await f.realBinding();
    let getterCalls = 0;
    f.control.handle = async (context) => {
      await context.tx.update({ table: 'item', key: itemKey(context), values: { version: 1 } });
      const attack = nested
        ? {
            table: 'item',
            key: { id: 1 },
            values: {
              get version() {
                getterCalls++;
                return 2;
              },
            },
          }
        : {
            get table() {
              getterCalls++;
              return 'item';
            },
            key: { id: 1 },
            values: { version: 2 },
          };
      await context.tx.update(attack).catch(() => {});
      return { reviewerId: 1, version: 1, detail: { message: 'Assigned.' } };
    };
    await assert.rejects(executeBusinessCommand(binding, actor, request()), refused('temporarily_unavailable', 'not_applied'));
    assert.equal(getterCalls, 0);
    assert.equal(f.version(), 0);
    assert.equal(f.receipts().length, 0);
    assert.equal(f.audits().length, 0);
  });
}
