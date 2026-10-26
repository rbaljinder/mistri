import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, type Adapter, type ScopedReads } from '../packages/engine/src/adapters/adapter.js';
import { COMMAND_JOURNAL_TABLES, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import {
  createAppPolicyContext,
  type AppPolicyContext,
  type AppPolicyContextOptions,
} from '../packages/mistri/src/server/policy/appPolicyContext.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import {
  BusinessCommandDefinitionError,
  defineCommand,
  withCommandVersions,
} from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { parseTestApp } from './support/commandCatalog.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

type Request = { role?: string; body?: unknown };
const request = (extra: Record<string, unknown> = {}) => ({
  command: 'assign',
  commandVersion: 1,
  key: { id: 1, part: 'a' },
  ...extra,
});
const executeRequest = (extra: Record<string, unknown> = {}) => ({
  ...request(),
  expectedVersion: 7,
  idempotencyKey: 'prepare-execute-request',
  input: {},
  ...extra,
});
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function commandError(code: string, outcome = 'not_applied') {
  return (error: unknown) => {
    assert.ok(error instanceof BusinessCommandExecutionError);
    assert.equal(error.code, code);
    assert.equal(error.outcome, outcome);
    return true;
  };
}

async function fixture(t: TestContext, secondary = false, migrated = true) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-prepare-'));
  const path = join(directory, 'commands.db');
  const db = new DatabaseSync(path);
  const registry = new Registry();
  t.after(async () => {
    try {
      await registry.closeAll();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`
    CREATE TABLE physical_loan (id INTEGER NOT NULL, part TEXT NOT NULL, desk INTEGER NOT NULL,
      version INTEGER NOT NULL, other_version INTEGER NOT NULL, assignee TEXT NOT NULL, PRIMARY KEY (id, part));
    CREATE TABLE physical_note (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    INSERT INTO physical_loan VALUES (1, 'a', 1, 7, 42, 'Original'), (1, 'b', 1, 9, 42, 'Sibling'),
      (2, 'a', 2, 13, 42, 'Hidden');
    INSERT INTO physical_note VALUES (1, 'Private dependency');
  `);
  if (migrated) await migrateSqliteCommandJournal(path);
  const journalBefore = migrated
    ? new Map(Object.values(COMMAND_JOURNAL_TABLES).map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()]))
    : new Map();
  const owner = 'private-command-owner';
  registry.add({ id: owner, name: 'Prepare fixture', url: path, writable: true, source: 'config' });
  if (secondary) {
    const corePath = join(directory, 'core.db');
    const core = new DatabaseSync(corePath);
    core.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY); INSERT INTO marker VALUES (1);');
    core.close();
    registry.add({ id: 'private-core-owner', name: 'Core fixture', url: corePath, source: 'config' });
  }
  const source = secondary ? 'lending' : 'operations';
  const logical = (local: string) => (secondary ? `lending.${local}` : local);
  const loan = logical('loan');
  const note = logical('note');
  const app = parseTestApp(
    {
      id: 'prepare-policy',
      name: 'Prepare policy',
      sources: {
        ...(secondary ? { operations: { connection: 'private-core-owner', default: true } } : {}),
        [source]: { connection: owner, ...(secondary ? {} : { default: true }) },
      },
      resources: {
        [loan]: {
          physical: 'physical_loan',
          access: 'write',
          actions: {
            assign: {
              label: 'Assign',
              command: {
                id: 'assign',
                version: 1,
                target: loan,
                input: {},
              },
            },
          },
        },
        [note]: { physical: 'physical_note' },
        ...(secondary ? { marker: {} } : {}),
      },
      auth: {
        roles: {
          manager: { read: true, commands: ['assign'] },
          viewer: { read: true },
          incomplete: { read: [loan], commands: ['assign'] },
        },
      },
      views: { loans: { kind: 'list', from: loan } },
      home: 'loans',
      nav: ['loans'],
    },
    'prepare fixture',
  );
  const loaded = await loadAppRuntimeResources(registry, app, secondary ? 'private-core-owner' : owner);
  const anchors = new Map(loaded.connections.map((connection) => [connection, loaded.forConnection(connection)]));
  const control = {
    calls: 0,
    parses: 0,
    transactions: 0,
    queries: [] as Parameters<ScopedReads['query']>[0][],
    writable: true,
    afterRead: undefined as (() => Promise<void>) | undefined,
    result: undefined as ((result: Awaited<ReturnType<ScopedReads['query']>>) => Awaited<ReturnType<ScopedReads['query']>>) | undefined,
  };
  const anchor = anchors.get(owner)!;
  const transaction = commandsOf(anchor).scopeCommandTransaction!.bind(anchor);
  anchor.scopeCommandTransaction = (scope, run) => {
    control.transactions++;
    return transaction(scope, run);
  };
  const unscoped = commandsOf(anchor).commandTransaction!.bind(anchor);
  anchor.commandTransaction = (run) => {
    control.transactions++;
    return unscoped(run);
  };
  const reads = loaded.adapter.scopeReads!.bind(loaded.adapter);
  const adapter: Adapter = {
    ...loaded.adapter,
    scopeReads: async (scope) => {
      const bound = await reads(scope);
      return {
        ...bound,
        query: async (query) => {
          control.queries.push(query);
          const result = await bound.query(query);
          await control.afterRead?.();
          return control.result?.(result) ?? result;
        },
      };
    },
  };
  const resources = { ...loaded, adapter, forConnection: (connection: string) => anchors.get(connection)! };
  const define = () =>
    defineCommand({
      source,
      target: 'loan',
      read: ['loan', 'note'],
      write: ['loan'],
      input: {},
      validate() {
        control.parses++;
      },
      output: {
        parse(value: unknown) {
          control.parses++;
          return value;
        },
      },
      async handle({ record, tx }) {
        control.calls++;
        const revision = Number(record.version);
        await tx.update({
          table: 'loan',
          key: { id: Number(record.id), part: String(record.part) },
          expected: { version: revision, assignee: 'Original' },
          values: { version: revision + 1, assignee: 'Assigned' },
        });
        return { version: revision + 1 };
      },
    });
  const command = define();
  const commands = { registry: { assign: command }, writableConnection: () => control.writable, resultReferences: { assign: () => [] } };
  const rows: RowScope = {
    [loan]: { groups: [[{ column: 'desk', op: '=', value: 1 }]] },
    [note]: true,
    ...(secondary ? { marker: true } : {}),
  };
  const options: AppPolicyContextOptions<Request> = {
    app,
    resources,
    commands,
    sourceConnections: new Map([[source, owner], ...(secondary ? [['operations', 'private-core-owner'] as const] : [])]),
    verifySession: async (req) => ({ id: 'verified', who: 'manager@example.test', role: req.role ?? 'manager' }),
    resolveRows: () => rows,
  };
  const issue = () => createAppPolicyContext(options);
  const untouched = () => {
    assert.equal(control.calls, 0);
    assert.equal(control.parses, 0);
    assert.equal(control.transactions, 0);
    assert.equal(db.prepare('SELECT assignee FROM physical_loan WHERE id = 1 AND part = ?').get('a')!.assignee, 'Original');
    if (migrated) {
      for (const [table, before] of journalBefore) {
        assert.deepEqual(db.prepare(`SELECT * FROM "${table}"`).all(), before);
      }
    } else {
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE '__mistri_command_%'").get()!.n, 0);
    }
  };
  return {
    issue,
    options,
    app,
    reference: app.resources![loan].actions![0].command!,
    resources,
    commands,
    define,
    control,
    db,
    rows,
    loan,
    untouched,
  };
}

for (const secondary of [false, true]) {
  test(`prepare reads the exact composite key through ${secondary ? 'a secondary source and alias' : 'a logical alias'}`, async (t) => {
    const f = await fixture(t, secondary);
    const issuer = f.issue();
    await issuer.withContext({ body: { actor: { roles: ['viewer'] } } }, async (context) => {
      assert.ok(Object.isFrozen(context.commands));
      assert.deepEqual(Reflect.ownKeys(context.commands!).sort(), ['availability', 'execute', 'prepare', 'status']);
      const { prepare } = context.commands!;
      assert.deepEqual(await prepare(request(), { requestId: 'trusted-prepare' }), { expectedVersion: 7 });
      assert.deepEqual(await prepare(request({ key: { id: '1', part: 'b' } })), { expectedVersion: 9 });
    });
    assert.deepEqual(
      f.control.queries.map((query) => [query.table, query.columns, query.limit]),
      [
        [f.loan, ['version'], 2],
        [f.loan, ['version'], 2],
      ],
    );
    f.untouched();
  });
}

test('prepare neither needs nor creates a journal and never invokes validators or a handler', async (t) => {
  const f = await fixture(t, false, false);
  assert.deepEqual(await f.issue().withContext({}, (context) => context.commands!.prepare(request())), { expectedVersion: 7 });
  f.untouched();
});

test('hidden and nonexistent targets produce identical not_found errors', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue();
  const errors: BusinessCommandExecutionError[] = [];
  for (const id of [2, 999]) {
    await assert.rejects(
      issuer.withContext({}, (context) => context.commands!.prepare(request({ key: { id, part: 'a' } }))),
      (error) => {
        commandError('not_found')(error);
        errors.push(error as BusinessCommandExecutionError);
        return true;
      },
    );
  }
  assert.equal(errors[0].message, errors[1].message);
  f.untouched();
});

for (const role of ['viewer', 'incomplete', 'unknown']) {
  test(`prepare requires verified command grants and the entire read footprint: ${role}`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.issue().withContext({ role, body: { roles: ['manager'] } }, (context) => context.commands!.prepare(request())),
      commandError('forbidden'),
    );
    assert.equal(f.control.queries.length, 0);
    f.untouched();
  });
}

test('prepare denies a command whose source becomes nonwritable', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue();
  f.control.writable = false;
  await assert.rejects(
    issuer.withContext({}, (context) => context.commands!.prepare(request())),
    commandError('forbidden'),
  );
  assert.equal(f.control.queries.length, 0);
  f.untouched();
});

test('prepare requires a validated public reference, while private execute/status remain available', async (t) => {
  const f = await fixture(t);
  // The resource's action is the public reference: without it, nothing may prepare the command.
  delete f.app.resources![f.loan].actions;
  const issuer = f.issue();
  await assert.rejects(
    issuer.withContext({}, (context) => context.commands!.prepare(request())),
    commandError('forbidden'),
  );
  f.untouched();
  const result = await issuer.withContext({}, (context) => context.commands!.execute(executeRequest()));
  assert.equal(result.status, 'applied');
  assert.deepEqual(await issuer.withContext({}, (context) => context.commands!.status(executeRequest())), { ...result, replayed: true });
  assert.equal(f.control.calls, 1);
});

test('issuer refuses a served command resolved at another version than its registration before accepting contexts', async (t) => {
  const f = await fixture(t);
  f.reference.version = 2;
  assert.throws(f.issue, BusinessCommandDefinitionError);
  f.untouched();
});

test('prepare refuses an unavailable command version before reading', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.issue().withContext({}, (context) => context.commands!.prepare(request({ commandVersion: 2 }))),
    commandError('command_version_mismatch', 'unknown'),
  );
  assert.equal(f.control.queries.length, 0);
  f.untouched();
});

const invalidRequests: [string, () => unknown][] = [
  ['missing fields', () => ({})],
  ['client roles', () => request({ roles: ['manager'] })],
  ['client actor', () => request({ actor: { id: 'forged', roles: ['manager'] } })],
  ['client source', () => request({ source: 'operations' })],
  ['execution envelope', () => executeRequest()],
  ['empty key', () => request({ key: {} })],
  ['partial key', () => request({ key: { id: 1 } })],
  ['extra key', () => request({ key: { id: 1, part: 'a', desk: 1 } })],
  ['wrong key', () => request({ key: { id: 1, wrong: 'a' } })],
  ['nonfinite key', () => request({ key: { id: NaN, part: 'a' } })],
  [
    'key accessor',
    () =>
      request({
        key: {
          get id() {
            return assert.fail('Getter executed');
          },
          part: 'a',
        },
      }),
  ],
  [
    'proxy',
    () =>
      new Proxy(request(), {
        ownKeys() {
          assert.fail('Proxy trap executed');
        },
      }),
  ],
];
for (const [name, raw] of invalidRequests) {
  test(`prepare strictly rejects ${name}`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.issue().withContext({}, (context) => context.commands!.prepare(raw())),
      commandError('invalid_input'),
    );
    assert.equal(f.control.queries.length, 0);
    f.untouched();
  });
}

for (const version of [-1, 1.5, 'private-version', Number.MAX_SAFE_INTEGER, 9007199254740992n]) {
  test(`prepare rejects invalid stored revision ${String(version)}`, async (t) => {
    const f = await fixture(t);
    f.db.prepare('UPDATE physical_loan SET version = ? WHERE id = 1 AND part = ?').run(version, 'a');
    await assert.rejects(
      f.issue().withContext({}, (context) => context.commands!.prepare(request())),
      commandError('invalid_result'),
    );
    f.untouched();
  });
}

for (const version of [0, Number.MAX_SAFE_INTEGER - 1]) {
  test(`prepare accepts revision boundary ${version}`, async (t) => {
    const f = await fixture(t);
    f.db.prepare('UPDATE physical_loan SET version = ? WHERE id = 1 AND part = ?').run(version, 'a');
    assert.deepEqual(await f.issue().withContext({}, (context) => context.commands!.prepare(request())), { expectedVersion: version });
    f.untouched();
  });
}

test('prepare rejects an ambiguous reader result', async (t) => {
  const f = await fixture(t);
  f.control.result = (result) => ({ ...result, rows: [...result.rows, ...result.rows] });
  await assert.rejects(
    f.issue().withContext({}, (context) => context.commands!.prepare(request())),
    commandError('invalid_result'),
  );
  f.untouched();
});

test('prepare sanitizes reader faults and caught failures still fail the invocation', async (t) => {
  const f = await fixture(t);
  f.control.afterRead = async () => {
    throw new Error('PRIVATE SQL credentials');
  };
  await assert.rejects(
    f.issue().withContext({}, async (context) => {
      await assert.rejects(context.commands!.prepare(request()), commandError('temporarily_unavailable'));
    }),
    commandError('temporarily_unavailable'),
  );
  f.untouched();
});

test('prepare snapshots the request, options, public reference and registry before awaits', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue();
  f.reference.version = 2;
  f.commands.registry.assign = withCommandVersions({ assign: f.define() }, () => 2).assign;
  const controller = new AbortController();
  const aborted = new AbortController();
  aborted.abort();
  await issuer.withContext({}, async (context) => {
    const raw = request();
    const options = { signal: controller.signal, requestId: 'original-options' };
    const pending = context.commands!.prepare(raw, options);
    raw.key.id = 2;
    raw.commandVersion = 2;
    options.signal = aborted.signal;
    options.requestId = 'invalid options!';
    assert.deepEqual(await pending, { expectedVersion: 7 });
  });
  f.untouched();
});

test('prepare rejects invalid server request IDs before reading', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.issue().withContext({}, (context) => context.commands!.prepare(request(), { requestId: 'invalid id' })),
    commandError('invalid_input'),
  );
  assert.equal(f.control.queries.length, 0);
  f.untouched();
});

test('prepare checks cancellation before the read and after the read settles', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue();
  for (const afterRead of [false, true]) {
    const controller = new AbortController();
    if (afterRead)
      f.control.afterRead = async () => {
        controller.abort();
      };
    else controller.abort();
    await assert.rejects(
      issuer.withContext({}, (context) => context.commands!.prepare(request(), { signal: controller.signal })),
      commandError('cancelled'),
    );
    assert.equal(f.control.queries.length, afterRead ? 1 : 0);
  }
  f.untouched();
});

test('retained prepare methods expire with their context and issuer', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue();
  let retained!: NonNullable<AppPolicyContext['commands']>['prepare'];
  await issuer.withContext({}, async (context) => {
    retained = context.commands!.prepare;
  });
  await assert.rejects(retained(request()), Refusal);
  await assert.rejects(
    issuer.withContext({}, async (context) => {
      issuer.retire();
      await context.commands!.prepare(request());
    }),
    Refusal,
  );
  assert.equal(f.control.queries.length, 0);
  f.untouched();
});

test('prepare rechecks lifetime when resuming after the guarded reader completes', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue();
  f.control.result = (result) => {
    queueMicrotask(() => queueMicrotask(() => issuer.retire()));
    return result;
  };
  await assert.rejects(
    issuer.withContext({}, (context) => context.commands!.prepare(request())),
    commandError('forbidden'),
  );
  f.untouched();
});

for (const reason of ['callback settlement', 'retirement', 'cancellation'] as const) {
  test(`prepare drains its accepted read and refuses a late result after ${reason}`, async (t) => {
    const f = await fixture(t);
    const entered = gate();
    const held = gate();
    f.control.afterRead = async () => {
      entered.release();
      await held.promise;
    };
    const issuer = f.issue();
    const controller = new AbortController();
    let operation!: Promise<unknown>;
    let settled = false;
    const pending = issuer.withContext({}, async (context) => {
      operation = context.commands!.prepare(request(), { signal: controller.signal });
      await entered.promise;
      if (reason === 'callback settlement') return;
      if (reason === 'retirement') issuer.retire();
      else controller.abort();
      await operation;
    });
    const rejected = assert.rejects(pending, commandError(reason === 'cancellation' ? 'cancelled' : 'forbidden'));
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await entered.promise;
      await turn();
      assert.equal(settled, false);
    } finally {
      held.release();
    }
    await rejected;
    await assert.rejects(operation, commandError(reason === 'cancellation' ? 'cancelled' : 'forbidden'));
    f.untouched();
  });
}

test('caught or unawaited invalid preparation poisons the owning invocation', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue();
  for (const caught of [false, true]) {
    await assert.rejects(
      issuer.withContext({}, async (context) => {
        const operation = context.commands!.prepare({});
        if (caught) await operation.catch(() => {});
      }),
      commandError('invalid_input'),
    );
  }
  f.untouched();
});

test('an unknown command is forbidden before reading', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.issue().withContext({}, (context) => context.commands!.prepare(request({ command: 'unknown' }))),
    commandError('forbidden'),
  );
  assert.equal(f.control.queries.length, 0);
  f.untouched();
});

test('prepare uses each invocation row scope and a fully hidden target is not_found', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue();
  await issuer.withContext({}, async (context) => {
    f.options.resolveRows = () => ({ ...f.rows, [f.loan]: true });
    assert.deepEqual(await context.commands!.prepare(request()), { expectedVersion: 7 });
  });
  // The captured resolver function still reads its original scope data.
  Object.assign(f.rows, { [f.loan]: false });
  await assert.rejects(
    issuer.withContext({}, (context) => context.commands!.prepare(request())),
    commandError('not_found'),
  );
  f.untouched();
});

test('preparation does not retain command grants for a later execution', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue();
  assert.deepEqual(await issuer.withContext({}, (context) => context.commands!.prepare(request())), { expectedVersion: 7 });
  await assert.rejects(
    issuer.withContext({ role: 'viewer' }, (context) => context.commands!.execute(executeRequest())),
    commandError('forbidden', 'unknown'),
  );
  f.untouched();
});

test('preparation is no reservation: execution rechecks revision and current visibility', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue();
  assert.deepEqual(await issuer.withContext({}, (context) => context.commands!.prepare(request())), { expectedVersion: 7 });
  f.untouched();
  f.db.exec("UPDATE physical_loan SET version = 8 WHERE id = 1 AND part = 'a'");
  await assert.rejects(
    issuer.withContext({}, (context) => context.commands!.execute(executeRequest())),
    commandError('stale_record'),
  );
  // The platform reads the target at the submitted revision before the handler runs, so a stale one never reaches it.
  assert.equal(f.control.calls, 0);
  f.db.exec("UPDATE physical_loan SET desk = 2 WHERE id = 1 AND part = 'a'");
  await assert.rejects(
    issuer.withContext({}, (context) => context.commands!.execute(executeRequest({ expectedVersion: 8 }))),
    commandError('forbidden', 'unknown'),
  );
  assert.equal(f.control.calls, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM "' + COMMAND_JOURNAL_TABLES.receipt + '"').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT assignee FROM physical_loan WHERE id = 1 AND part = ?').get('a')!.assignee, 'Original');
});
