import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { CommandTransactionFailure, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { createAppResources } from '../packages/mistri/src/server/app/appResources.js';
import type { RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands, type BusinessCommandContext } from '../packages/mistri/src/server/commands/businessCommands.js';
import type { CommandResultReference } from '../packages/mistri/src/server/commands/scopedBusinessCommandAccess.js';
import { bindPolicyPublicIntake } from '../packages/mistri/src/server/policy/policyPublicIntake.js';
import { createAppPolicyDeployment } from '../packages/mistri/src/server/policy/appPolicyDeployment.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { parseTestApp } from './support/commandCatalog.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

const input = { name: { label: 'Name', type: 'text' }, desk: { label: 'Desk', type: 'number', integer: true } } as const;
const submission = (suffix = '1', desk = 1) => ({ input: { name: 'Visitor', desk }, submission: `intake-submission-${suffix}` });
const refusal =
  (code?: string, outcome = 'not_applied') =>
  (error: unknown) => {
    assert.ok(error instanceof BusinessCommandExecutionError);
    if (code) assert.equal(error.code, code);
    assert.equal(error.outcome, outcome);
    return true;
  };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-policy-intake-'));
  const file = join(directory, 'intake.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE desk(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE inbox(id INTEGER PRIMARY KEY, desk INTEGER NOT NULL REFERENCES desk(id), name TEXT NOT NULL);
    INSERT INTO desk VALUES(1, 'Allowed'), (2, 'Private');
    INSERT INTO inbox VALUES(1, 2, 'Private submission');`);
  migrateSqliteCommandJournal(file);
  const adapter = new SqliteAdapter(file);
  const mapped = createAppResources(adapter, await adapter.introspect());
  // Any accidental fallback to ordinary access must fail the fixture.
  mapped.adapter.transaction = async () => {
    throw new Error('Unscoped transaction');
  };
  mapped.adapter.query = async () => {
    throw new Error('Unscoped read');
  };
  const resources: RuntimeResources = {
    ...mapped,
    connections: ['data'],
    connectionFor: () => 'data',
    forConnection: () => mapped.adapter,
    toLogicalAt: (table) => table,
  };
  const app = parseTestApp(
    {
      id: 'policy-intake',
      name: 'Policy intake',
      sources: { main: { connection: 'data' } },
      auth: { rows: 'policy', roles: { staff: { read: true } } },
      resources: { desk: {}, inbox: { access: 'write' } },
      views: {
        inbox: { kind: 'list', from: 'inbox' },
        apply: { kind: 'form', public: true, label: 'Apply', command: { id: 'enrol', version: 1, input } },
      },
      home: 'inbox',
      nav: ['inbox'],
    },
    'policy intake fixture',
  );
  const control = {
    calls: 0,
    result: { reference: 'INBOX-001' } as { reference: string },
    handle: undefined as ((context: BusinessCommandContext) => Promise<void>) | undefined,
    references: [] as readonly CommandResultReference[],
    actors: [] as string[],
  };
  const registry = defineCommands({
    enrol: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'inbox',
      public: true,
      read: ['desk'],
      input,
      output: shape({ reference: text() }),
      async handle(context, value) {
        control.calls++;
        control.actors.push(JSON.stringify(context.actor));
        if (value.name === 'Visitor') {
          const desks = await context.tx.query({ table: 'desk', limit: 10, offset: 0 });
          assert.deepEqual(
            desks.rows.map((row) => row.id),
            [1],
          );
        }
        await context.tx.insert({ table: 'inbox', values: { name: value.name, desk: value.desk } });
        await control.handle?.(context);
        return control.result;
      },
    }),
  });
  const rows: RowScope = {
    desk: { groups: [[{ column: 'id', op: '=', value: 1 }]] },
    inbox: { groups: [[{ column: 'desk', op: '=', value: 1 }]] },
  };
  const bindings: Array<ReturnType<typeof bindPolicyPublicIntake>> = [];
  const bind = (scope = rows) => {
    const intake = bindPolicyPublicIntake({
      app,
      resources,
      registry,
      form: 'apply',
      rows: scope,
      resultReferences: (result) => {
        assert.ok(Object.isFrozen(result));
        return control.references;
      },
      writableConnection: () => true,
    });
    bindings.push(intake);
    return intake;
  };
  t.after(async () => {
    await Promise.all(bindings.map((binding) => binding.retire()));
    await adapter.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { bind, control, db, rows, app, registry, resources };
}

test('fixed policy intake inserts once and replays through a new binding without public read grants', async (t) => {
  const f = await fixture(t),
    intake = f.bind();
  const first = await intake.submit(submission());
  assert.equal(first.status, 'applied');
  assert.equal(first.replayed, false);
  assert.deepEqual(first.result, { reference: 'INBOX-001' });
  const replay = await intake.submit(submission());
  assert.equal(replay.receiptId, first.receiptId);
  assert.equal(replay.replayed, true);
  await intake.retire();
  assert.equal((await f.bind().submit(submission())).receiptId, first.receiptId);
  assert.equal(f.control.calls, 1);
  assert.deepEqual(JSON.parse(f.control.actors[0]), {
    id: 'public:apply',
    appId: 'policy-intake',
    roles: [],
    kind: 'public',
    form: 'apply',
  });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM inbox').get()!.n, 2);
  await assert.rejects(
    f.bind().submit({ ...submission(), input: { name: 'Changed', desk: 1 } }),
    refusal('idempotency_conflict', 'unknown'),
  );
});

test('intake cannot insert outside its fixed scope or reference a hidden parent', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.bind().submit(submission('wrong-scope', 2)), refusal());
  await assert.rejects(f.bind({ ...f.rows, inbox: true }).submit(submission('hidden-parent', 2)), refusal());
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM inbox').get()!.n, 1);
});

for (const operation of ['update', 'remove'] as const) {
  test(`caught ${operation} refusal still rolls back the earlier intake insert`, async (t) => {
    const f = await fixture(t);
    f.control.handle = async (context) => {
      try {
        if (operation === 'update') await context.tx.update({ table: 'inbox', key: { id: 2 }, values: { name: 'Changed' } });
        else await context.tx.remove({ table: 'inbox', key: { id: 2 } });
      } catch {
        /* Deliberately swallowed by a trusted handler. */
      }
    };
    await assert.rejects(f.bind().submit(submission()), refusal());
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM inbox').get()!.n, 1);
  });
}

test('public result references are refused before commit and rechecked on replay', async (t) => {
  const f = await fixture(t),
    intake = f.bind();
  f.control.references = [{ table: 'inbox', key: { id: 2 } }];
  await assert.rejects(intake.submit(submission()), refusal());
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM inbox').get()!.n, 1);
  f.control.references = [];
  await intake.submit(submission());
  f.control.references = [{ table: 'inbox', key: { id: 2 } }];
  await assert.rejects(intake.submit(submission()), refusal(undefined, 'unknown'));
  assert.equal(f.control.calls, 2);
});

test('a missing public reference rolls back instead of committing an unusable receipt', async (t) => {
  const f = await fixture(t);
  f.control.result = { message: 'Done' } as unknown as { reference: string };
  await assert.rejects(f.bind().submit(submission()), refusal('invalid_result'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM inbox').get()!.n, 1);
});

test('submission and fixed scope are captured before caller mutation', async (t) => {
  const f = await fixture(t),
    rows = structuredClone(f.rows),
    body = submission();
  const intake = f.bind(rows);
  (rows as Record<string, unknown>).inbox = true;
  const work = intake.submit(body);
  body.input.desk = 2;
  await work;
  assert.equal(f.db.prepare('SELECT desk FROM inbox WHERE id = 2').get()!.desk, 1);
  await assert.rejects(intake.submit(submission('second', 2)), refusal());
});

test('retirement drains in-flight work and prevents that work from committing', async (t) => {
  const f = await fixture(t),
    intake = f.bind();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.control.handle = async () => {
    entered();
    await held;
  };
  const work = intake.submit(submission());
  const rejected = assert.rejects(work, refusal());
  await started;
  let drained = false;
  const retirement = intake.retire().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  await assert.rejects(intake.submit(submission('new')), refusal('temporarily_unavailable'));
  release();
  await rejected;
  await retirement;
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM inbox').get()!.n, 1);
});

test('request cannot choose another command, actor, scope, or target', async (t) => {
  const f = await fixture(t),
    intake = f.bind();
  for (const field of ['command', 'actor', 'rows', 'key']) {
    await assert.rejects(intake.submit({ ...submission(), [field]: 'forged' }), refusal('invalid_input'));
  }
  assert.equal(f.control.calls, 0);
});

test('fixed intake refuses undeclared scopes and missing scoped transaction capability at bind time', async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.bind({ ...f.rows, unknown: true }));
  assert.throws(() => f.bind({ desk: true }));
  f.resources.forConnection('data').scopeCommandTransaction = undefined;
  assert.throws(() => f.bind());
});

test('a changed fixed destination does not relocate an already completed submission', async (t) => {
  const f = await fixture(t),
    first = f.bind();
  const receipt = await first.submit(submission());
  await first.retire();
  const next = f.bind({
    desk: { groups: [[{ column: 'id', op: '=', value: 2 }]] },
    inbox: { groups: [[{ column: 'desk', op: '=', value: 2 }]] },
  });
  const replay = await next.submit(submission());
  assert.equal(replay.receiptId, receipt.receiptId);
  assert.equal(replay.replayed, true);
  assert.equal(f.control.calls, 1);
  assert.equal(f.db.prepare('SELECT desk FROM inbox WHERE id = 2').get()!.desk, 1);
});

test('lost commit acknowledgment remains unknown and an exact retry recovers the receipt', async (t) => {
  const f = await fixture(t),
    adapter = f.resources.forConnection('data');
  const transaction = commandsOf(adapter).scopeCommandTransaction!.bind(adapter);
  let first = true;
  adapter.scopeCommandTransaction = async (rows, run) => {
    const result = await transaction(rows, run);
    if (first) {
      first = false;
      throw new CommandTransactionFailure(new Error('PRIVATE lost acknowledgment'), 'unknown');
    }
    return result;
  };
  const intake = f.bind();
  await assert.rejects(intake.submit(submission()), refusal('temporarily_unavailable', 'unknown'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM inbox').get()!.n, 2);
  const replay = await intake.submit(submission());
  assert.equal(replay.replayed, true);
  assert.equal(f.control.calls, 1);
});

test('deployment retains its source lease until a retired public submission drains', async (t) => {
  const f = await fixture(t);
  let released = false,
    entered!: () => void,
    unblock!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const deployed = await createAppPolicyDeployment({
    app: f.app,
    policy: {
      appId: f.app.id,
      resolveRows: () => f.rows,
      resultReferences: {},
      publicForms: { apply: { rows: f.rows, resultReferences: () => [] } },
    },
    verifySession: async () => {
      assert.fail('Public intake must not resolve a session');
    },
    acquire: async () => ({
      resources: f.resources,
      sourceConnections: new Map([['main', 'data']]),
      release: () => {
        released = true;
      },
    }),
    commands: { registry: f.registry, writableConnection: () => true },
  });
  f.control.handle = async () => {
    entered();
    await held;
  };
  const submission = deployed.submitPublicForm!('apply', { input: { name: 'Visitor', desk: 1 }, submission: 'deployment-intake-001' });
  const rejected = assert.rejects(submission, refusal());
  await started;
  const retirement = deployed.retire();
  assert.equal(released, false);
  unblock();
  await rejected;
  await retirement;
  assert.equal(released, true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM inbox').get()!.n, 1);
});
