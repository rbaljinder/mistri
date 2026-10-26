import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, TransactionOutcomeUnknown, type Adapter } from '../packages/engine/src/adapters/adapter.js';
import { COMMAND_JOURNAL_TABLES, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.js';
import type { AppPolicyContext } from '../packages/mistri/src/server/policy/appPolicyContext.js';
import { createAppPolicyDeployment } from '../packages/mistri/src/server/policy/appPolicyDeployment.js';
import { defineAppRowPolicy, AppRowPolicyDefinitionError } from '../packages/mistri/src/server/policy/appRowPolicy.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import {
  defineCommand,
  type BusinessCommandActor,
  type BusinessCommandContext,
} from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { resource } from './support/appCeilings.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';

interface Request {
  cookie?: string;
  body?: unknown;
}
type Options = Parameters<typeof createAppPolicyDeployment<Request>>[0];
type Deployment = Awaited<ReturnType<typeof createAppPolicyDeployment<Request>>>;
const owner = 'private-deployment-owner';
const archiveOwner = 'private-archive-owner';
const signedIn: Request = { cookie: 'manager-session' };
const secret = 'postgres://private-user:secret-password@private-host/internal_table';
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const commandRequest = () => ({
  command: 'assign',
  commandVersion: 1,
  key: { id: 1 },
  expectedVersion: 0,
  idempotencyKey: 'deployment-command-request',
  input: { assignee: 'Ada' },
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function sanitized(kind: typeof AppRowPolicyDefinitionError | typeof AppAccessDenied) {
  return (error: unknown) => {
    assert.ok(error instanceof kind);
    assert.equal(error.cause, undefined);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.ok(!`${error.stack}\n${JSON.stringify(error)}`.includes(secret));
    return true;
  };
}

async function fixture(t: TestContext, configuration: { commands?: boolean; journal?: boolean; readOnly?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-policy-deployment-'));
  const registry = new Registry();
  const databases = new Map<string, DatabaseSync>();
  const deployments: Deployment[] = [];
  t.after(async () => {
    try {
      await Promise.allSettled(deployments.map((deployment) => deployment.retire()));
      await registry.closeAll();
    } finally {
      for (const database of databases.values()) database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  for (const connection of [owner, archiveOwner]) {
    const path = join(directory, `${connection}.db`);
    const db = new DatabaseSync(path);
    databases.set(connection, db);
    db.exec(`
      CREATE TABLE physical_loan (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL,
        version INTEGER NOT NULL, assignee TEXT NOT NULL);
      CREATE TABLE physical_note (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL, body TEXT NOT NULL);
      INSERT INTO physical_loan VALUES (1, 1, 0, 'Unassigned'), (2, 2, 0, 'Hidden');
      INSERT INTO physical_note VALUES (1, 1, 'Visible'), (2, 2, 'Hidden');
    `);
    if (connection === owner && configuration.journal !== false) migrateSqliteCommandJournal(path);
    registry.add({
      id: connection,
      name: connection,
      url: path,
      writable: connection === owner && !configuration.readOnly,
      source: 'config',
    });
  }
  const ceiling = configuration.readOnly ? undefined : 'write';
  const app = parseAppConfig(
    {
      id: 'deployment-app',
      name: 'Deployment fixture',
      sources: {
        operations: { connection: owner, default: true },
        archive: { connection: archiveOwner },
      },
      resources: {
        loan: { physical: 'physical_loan', ...(ceiling ? { access: ceiling } : {}) },
        note: { physical: 'physical_note', ...(ceiling ? { access: ceiling } : {}) },
        'archive.note': { physical: 'physical_note' },
      },
      auth: {
        roles: {
          manager: {
            read: true,
            write: configuration.readOnly ? false : ['note'],
            ...(configuration.commands ? { commands: ['assign'] } : {}),
          },
          viewer: { read: true },
        },
      },
      views: { loans: { kind: 'list', from: 'loan' } },
      home: 'loans',
    },
    'deployment fixture',
  );
  const loaded = await loadAppRuntimeResources(registry, app, owner);
  const anchors = new Map(loaded.connections.map((connection) => [connection, loaded.forConnection(connection)]));
  const resources = {
    ...loaded,
    forConnection: (connection: string): Adapter => {
      const adapter = anchors.get(connection);
      if (!adapter) throw new Refusal('Unknown fixture owner');
      return adapter;
    },
  };
  const anchor = anchors.get(owner)!;
  const db = databases.get(owner)!;
  const control = {
    acquires: 0,
    releases: 0,
    verifications: 0,
    resolutions: 0,
    handlers: 0,
    extractors: 0,
    releaseError: undefined as Error | undefined,
    releaseHold: undefined as Promise<void> | undefined,
    actors: [] as BusinessCommandActor[],
  };
  const identities = new Map<string, Identity>([
    ['manager-session', { id: 'verified-manager', who: 'manager@example.test', role: 'manager' }],
    ['other-session', { id: 'other-manager', who: 'other@example.test', role: 'manager' }],
    ['viewer-session', { id: 'verified-viewer', who: 'viewer@example.test', role: 'viewer' }],
  ]);
  const rows: Record<string, RowScope[string]> = {
    loan: { groups: [[{ column: 'desk', op: '=', value: 1 }]] },
    note: { groups: [[{ column: 'desk', op: '=', value: 1 }]] },
    'archive.note': { groups: [[{ column: 'desk', op: '=', value: 2 }]] },
  };
  const resolveRows: Options['policy']['resolveRows'] = (principal) => {
    control.resolutions++;
    assert.ok(Object.isFrozen(principal));
    assert.equal(principal.appId, 'deployment-app');
    return rows;
  };
  // The declaration parses; `validate` is the rule left, captured at registration like every callback.
  const input = {
    fields: { assignee: { label: 'Assignee', type: 'text' } } as const,
    validate(value: { assignee: string }) {
      assert.ok(value && typeof value === 'object' && typeof value.assignee === 'string');
      return { assignee: value.assignee };
    },
  };
  const output = {
    parse(value: unknown) {
      const result = value as { id: number; version: number };
      assert.ok(result && Number.isSafeInteger(result.id) && Number.isSafeInteger(result.version));
      return { id: result.id, version: result.version };
    },
  };
  const assign = async (context: BusinessCommandContext, value: { assignee: string }) => {
    control.handlers++;
    control.actors.push(context.actor);
    const loan = context.record!,
      id = Number(loan.id),
      version = Number(loan.version);
    await context.tx.update({
      table: 'loan',
      key: { id },
      expected: { version, assignee: String(loan.assignee) },
      values: { assignee: value.assignee, version: version + 1 },
    });
    return { id, version: version + 1 };
  };
  // A replacement registration differs only in its handler, so capture tests can swap one in.
  const define = (handle: typeof assign | (() => never) = assign) =>
    defineCommand({
      source: 'operations',
      target: 'loan',
      read: ['loan'],
      write: ['loan'],
      input: input.fields,
      validate: input.validate,
      output,
      handle,
    });
  const command = define();
  const resultReferences = {
    assign: (_result: unknown) => {
      control.extractors++;
      return [];
    },
  };
  const policy = defineAppRowPolicy({ appId: app.id, resolveRows, ...(configuration.commands ? { resultReferences } : {}) });
  const commands = { registry: { assign: command }, writableConnection: (connection: string): boolean => connection === owner };
  const lease = {
    resources,
    sourceConnections: new Map([
      ['operations', owner],
      ['archive', archiveOwner],
    ]),
    release: async () => {
      control.releases++;
      if (control.releaseHold) await control.releaseHold;
      if (control.releaseError) throw control.releaseError;
    },
  };
  const options: Options = {
    app,
    policy,
    verifySession: async (request) => {
      control.verifications++;
      return identities.get(request.cookie ?? '') ?? null;
    },
    acquire: async () => {
      control.acquires++;
      return lease;
    },
    ...(configuration.commands ? { commands } : {}),
  };
  const deploy = async (extra: Partial<Options> = {}) => {
    const deployment = await createAppPolicyDeployment<Request>({ ...options, ...extra });
    deployments.push(deployment);
    return deployment;
  };
  const note = () => db.prepare('SELECT body FROM physical_note WHERE id = 1').get()!.body;
  const loan = () => db.prepare('SELECT assignee FROM physical_loan WHERE id = 1').get()!.assignee;
  return {
    app,
    policy,
    options,
    deploy,
    lease,
    resources,
    anchor,
    anchors,
    control,
    rows,
    identities,
    commands,
    define,
    resultReferences,
    input,
    output,
    db,
    note,
    loan,
  };
}

test('public placement passes frozen trusted intent to the server policy, preserves private reads and denies malformed scopes', async (t) => {
  const f = await fixture(t);
  const app = { ...f.app, auth: { ...f.app.auth!, public: { read: ['note'] } } };
  let calls = 0;
  const policy = defineAppRowPolicy({
    ...f.policy,
    resolvePublicRows(intent, context): RowScope {
      calls++;
      if (!intent) return {};
      assert.ok(Object.isFrozen(intent));
      assert.deepEqual({ ...intent }, { appId: app.id, tenant: '2' });
      assert.ok(context.db);
      return { note: { groups: [[{ column: 'desk', op: '=' as const, value: 2 }]] } };
    },
  });
  const deployment = await f.deploy({ app, policy, publicPlacement: () => ({ appId: app.id, tenant: '2' }) });
  await deployment.withContext({}, async (context) => {
    assert.deepEqual(
      (await context.data.query({ table: 'note', limit: 10, offset: 0 })).rows.map((row) => row.body),
      ['Hidden'],
    );
    assert.equal(context.commands, undefined);
  });
  await deployment.withContext(signedIn, async (context) => {
    assert.deepEqual(
      (await context.data.query({ table: 'note', limit: 10, offset: 0 })).rows.map((row) => row.body),
      ['Visible'],
    );
  });
  assert.equal(calls, 1);
  const unplaced = await f.deploy({ app, policy });
  await unplaced.withContext({}, async (context) => {
    assert.equal((await context.data.query({ table: 'note', limit: 10, offset: 0 })).rows.length, 0);
  });
  const foreign = await f.deploy({ app, policy, publicPlacement: () => ({ appId: 'other', tenant: '2' }) });
  await assert.rejects(
    foreign.withContext({}, async () => assert.fail('foreign placement admitted')),
    AppAccessDenied,
  );
  for (const resolvePublicRows of [
    () => {
      throw new Error(secret);
    },
    () => null as unknown as RowScope,
    () =>
      ({
        // eslint-disable-next-line unicorn/no-thenable -- Hostile policy results must be rejected without assimilation.
        then() {
          assert.fail('custom thenable ran');
        },
      }) as unknown as RowScope,
  ]) {
    const broken = await f.deploy({ app, policy: { ...policy, resolvePublicRows } });
    await assert.rejects(
      broken.withContext({}, async () => assert.fail('bad policy admitted')),
      sanitized(AppAccessDenied),
    );
  }
});

test('deployment exposes frozen private/public context readers and retire; startup invokes no application hooks', async (t) => {
  const f = await fixture(t, { commands: true });
  const deployment = await f.deploy();
  assert.ok(Object.isFrozen(deployment));
  assert.deepEqual(Reflect.ownKeys(deployment).sort(), [
    'retire',
    'services',
    'withAccount',
    'withContext',
    'withPublicContext',
    'withService',
  ]);
  assert.equal(f.control.acquires, 1);
  assert.equal(f.control.verifications, 0);
  assert.equal(f.control.resolutions, 0);
  assert.equal(f.control.handlers, 0);
  assert.equal(f.control.extractors, 0);
  assert.equal(f.control.releases, 0);
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${COMMAND_JOURNAL_TABLES.receipt}`).get()!.n, 0);
  assert.equal(f.note(), 'Visible');
  await deployment.retire();
  assert.equal(f.control.releases, 1);
});

test('App, policy and verifier are captured before acquire awaits', async (t) => {
  const f = await fixture(t);
  const entered = gate();
  const held = gate();
  const policy = { ...f.policy };
  const options: Options = {
    ...f.options,
    policy,
    acquire: async (app) => {
      assert.notEqual(app, f.app);
      assert.ok(Object.isFrozen(app));
      assert.ok(Object.isFrozen(app.auth!.roles!.manager));
      assert.ok(Object.isFrozen(app.resources!.note));
      entered.release();
      await held.promise;
      assert.equal(app.id, 'deployment-app');
      assert.equal(app.resources!.note.physical, 'physical_note');
      return f.lease;
    },
  };
  const pending = createAppPolicyDeployment<Request>(options);
  try {
    await entered.promise;
    f.app.id = 'replacement-app';
    f.app.auth!.roles!.manager.write = false;
    f.app.resources!.note.physical = 'physical_loan';
    options.verifySession = async () => {
      throw new Error(secret);
    };
    policy.resolveRows = () => {
      throw new Error(secret);
    };
    options.policy = defineAppRowPolicy({ appId: 'replacement-app', resolveRows: () => ({}) });
    options.acquire = async () => {
      throw new Error(secret);
    };
  } finally {
    held.release();
  }
  const deployment = await pending;
  try {
    await deployment.withContext(signedIn, async (context) => {
      assert.equal(context.principal.appId, 'deployment-app');
      assert.equal(await context.data.count('note'), 1);
      await context.data.update!({ table: 'note', key: { id: 1 }, values: { body: 'Captured' } });
    });
    assert.equal(f.note(), 'Captured');
  } finally {
    await deployment.retire();
  }
});

test('command registry, validators, references and writability function are captured before acquire awaits', async (t) => {
  const f = await fixture(t, { commands: true });
  const entered = gate();
  const held = gate();
  const references = { ...f.resultReferences };
  const options: Options = {
    ...f.options,
    policy: { ...f.policy, resultReferences: references },
    acquire: async () => {
      entered.release();
      await held.promise;
      return f.lease;
    },
  };
  const pending = createAppPolicyDeployment<Request>(options);
  const replaced = () => {
    throw new Error(secret);
  };
  try {
    await entered.promise;
    f.commands.registry.assign = f.define(replaced);
    f.commands.writableConnection = replaced;
    references.assign = replaced;
    f.input.validate = replaced;
    f.output.parse = replaced;
  } finally {
    held.release();
  }
  const deployment = await pending;
  try {
    const result = await deployment.withContext(signedIn, (context) => context.commands!.execute(commandRequest()));
    assert.equal(result.status, 'applied');
    assert.equal(f.loan(), 'Ada');
    assert.equal(f.control.handlers, 1);
  } finally {
    await deployment.retire();
  }
});

for (const property of ['auth', 'sources'] as const) {
  test(`deployment refuses an App missing ${property} before acquiring resources`, async (t) => {
    const f = await fixture(t);
    delete f.app[property];
    await assert.rejects(f.deploy(), sanitized(AppRowPolicyDefinitionError));
    assert.equal(f.control.acquires, 0);
    assert.equal(f.control.releases, 0);
  });
}

test('deployment refuses an App without a source of its own before acquiring resources', async (t) => {
  const f = await fixture(t);
  // Without a default the App's home is its first own source; with none of its own there is no home.
  for (const source of Object.values(f.app.sources!)) {
    source.default = false;
    source.realm = 'platform';
  }
  await assert.rejects(f.deploy(), sanitized(AppRowPolicyDefinitionError));
  assert.equal(f.control.acquires, 0);
  assert.equal(f.control.releases, 0);
});

test('policy must belong to the exact deployed App before acquisition', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.deploy({ policy: defineAppRowPolicy({ appId: 'another-app', resolveRows: () => ({}) }) }),
    sanitized(AppRowPolicyDefinitionError),
  );
  assert.equal(f.control.acquires, 0);
});

test('commands require exact result-reference declarations for every registered command', async (t) => {
  const declarations: Options['policy']['resultReferences'][] = [undefined, {}, { assign: () => [], dangling: () => [] }];
  for (const references of declarations) {
    const f = await fixture(t, { commands: true });
    const policy = defineAppRowPolicy({
      appId: f.app.id,
      resolveRows: f.policy.resolveRows,
      ...(references ? { resultReferences: references } : {}),
    });
    await assert.rejects(f.deploy({ policy }), sanitized(AppRowPolicyDefinitionError));
    assert.equal(f.control.handlers, 0);
    assert.equal(f.control.releases, f.control.acquires);
  }
});

test('result-reference declarations cannot dangle when commands are omitted', async (t) => {
  const f = await fixture(t);
  const policy = defineAppRowPolicy({ appId: f.app.id, resolveRows: f.policy.resolveRows, resultReferences: f.resultReferences });
  await assert.rejects(f.deploy({ policy }), sanitized(AppRowPolicyDefinitionError));
  assert.equal(f.control.releases, f.control.acquires);
});

test('inactive role command grants cannot dangle with or without a command registry', async (t) => {
  for (const commands of [false, true]) {
    const f = await fixture(t, { commands });
    f.app.auth!.roles!.inactive = { read: false, write: false, commands: ['unregistered'] };
    await assert.rejects(f.deploy(), sanitized(AppRowPolicyDefinitionError));
    assert.equal(f.control.releases, f.control.acquires);
  }
});

for (const fault of ['catalog', 'reader', 'writer', 'source binding'] as const) {
  test(`acquired resources release exactly once after invalid ${fault}`, async (t) => {
    const f = await fixture(t);
    if (fault === 'catalog') f.resources.schema.tables.length = 0;
    if (fault === 'reader') f.resources.adapter.scopeReads = undefined;
    if (fault === 'writer') f.anchor.scopeTransaction = undefined;
    if (fault === 'source binding') f.lease.sourceConnections.set('archive', owner);
    await assert.rejects(f.deploy(), sanitized(AppRowPolicyDefinitionError));
    assert.equal(f.control.acquires, 1);
    assert.equal(f.control.releases, 1);
    assert.equal(f.control.verifications, 0);
    assert.equal(f.control.resolutions, 0);
  });
}

test('acquisition faults are sanitized without claiming or releasing a lease', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.deploy({
      acquire: async () => {
        throw new Error(secret);
      },
    }),
    sanitized(AppRowPolicyDefinitionError),
  );
  assert.equal(f.control.releases, 0);
});

test('startup cleanup failures cannot expose either original fault or release cause', async (t) => {
  const f = await fixture(t);
  f.anchor.scopeTransaction = async () => {
    throw new Error(secret);
  };
  f.control.releaseError = new Error(secret);
  await assert.rejects(f.deploy(), sanitized(AppRowPolicyDefinitionError));
  assert.equal(f.control.releases, 1);
});

test('startup scoped-writer faults release the acquired lease and expose a generic definition error', async (t) => {
  const f = await fixture(t);
  f.anchor.scopeTransaction = async () => {
    throw new Error(secret);
  };
  await assert.rejects(f.deploy(), sanitized(AppRowPolicyDefinitionError));
  assert.equal(f.control.releases, 1);
});

for (const fault of ['missing', 'corrupt', 'capability'] as const) {
  test(`startup refuses ${fault} scoped command journal before handlers and releases once`, async (t) => {
    const f = await fixture(t, { commands: true, journal: fault !== 'missing' });
    if (fault === 'corrupt') f.db.exec(`ALTER TABLE ${COMMAND_JOURNAL_TABLES.receipt} ADD COLUMN unexpected TEXT`);
    if (fault === 'capability') f.anchor.scopeCommandTransaction = undefined;
    await assert.rejects(f.deploy(), sanitized(AppRowPolicyDefinitionError));
    assert.equal(f.control.releases, 1);
    assert.equal(f.control.handlers, 0);
    assert.equal(f.control.extractors, 0);
    assert.equal(f.loan(), 'Unassigned');
    if (fault === 'missing') {
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE '__mistri_command_%'").get()!.n, 0);
    }
  });
}

test('writer preflight uses an empty deny-all scoped transaction without record operations', async (t) => {
  const f = await fixture(t);
  const original = f.anchor.scopeTransaction!.bind(f.anchor);
  let preflights = 0;
  let operations = 0;
  f.anchor.scopeTransaction = (scope, run) => {
    preflights++;
    assert.ok(
      Object.values(scope).every((rule) => rule === false),
      'omitted or explicit false grants deny all rows',
    );
    return original(scope, (records, evidence) =>
      run(
        new Proxy(records, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              operations++;
              return Reflect.apply(value, target, args);
            };
          },
        }),
        evidence,
      ),
    );
  };
  await f.deploy();
  assert.ok(preflights > 0);
  assert.equal(operations, 0);
  assert.equal(f.note(), 'Visible');
});

test('writer preflight attests catalog evidence inside the scoped transaction', async (t) => {
  const f = await fixture(t);
  const original = f.anchor.scopeTransaction!.bind(f.anchor);
  let callbacks = 0;
  f.anchor.scopeTransaction = (scope, run) =>
    original(scope, (records, evidence) => {
      callbacks++;
      return run(records, { ...evidence, tables: [] });
    });
  await assert.rejects(f.deploy(), sanitized(AppRowPolicyDefinitionError));
  assert.equal(callbacks, 1);
  assert.equal(f.control.releases, 1);
});

test('read-only sources need only scoped readers and never fall back to ordinary writers', async (t) => {
  const f = await fixture(t, { readOnly: true });
  let fallback = 0;
  const ordinary = () => {
    fallback++;
    throw new Error(secret);
  };
  for (const adapter of [f.resources.adapter, ...f.anchors.values()]) {
    adapter.scopeTransaction = undefined;
    adapter.scopeCommandTransaction = undefined;
    adapter.transaction = ordinary;
    adapter.insert = ordinary;
    adapter.update = ordinary;
    adapter.remove = ordinary;
  }
  const deployment = await f.deploy();
  await deployment.withContext(signedIn, async (context) => {
    assert.equal(await context.data.count('note'), 1);
    assert.equal(await context.data.count('archive.note'), 1);
    assert.equal(context.data.update, undefined);
  });
  await assert.rejects(
    deployment.withContext(signedIn, (context) => context.transaction('operations', async () => {})),
    Refusal,
  );
  assert.equal(fallback, 0);
});

test('an unsupported secondary writer owner is refused even when only an inactive role grants it', async (t) => {
  const f = await fixture(t);
  let fallback = 0;
  resource(f.app, 'archive.note').access = 'write';
  f.app.auth!.roles!.inactive = { read: true, write: ['archive.note'] };
  const archive = f.anchors.get(archiveOwner)!;
  archive.scopeTransaction = undefined;
  archive.transaction = () => {
    fallback++;
    throw new Error(secret);
  };
  await assert.rejects(f.deploy(), sanitized(AppRowPolicyDefinitionError));
  assert.equal(f.control.releases, 1);
  assert.equal(fallback, 0);
});

test('verified identities scope reads and writes through expiring existing contexts', async (t) => {
  const f = await fixture(t);
  const deployment = await f.deploy();
  let retained!: AppPolicyContext;
  const result = await deployment.withContext(signedIn, async (context) => {
    retained = context;
    assert.ok(Object.isFrozen(context));
    assert.deepEqual(context.principal, {
      id: 'verified-manager',
      appId: 'deployment-app',
      roles: ['manager'],
      email: 'manager@example.test',
    });
    assert.deepEqual(
      (await context.data.query({ table: 'note', limit: 20, offset: 0 })).rows.map((row) => row.id),
      [1],
    );
    assert.deepEqual(
      (await context.data.query({ table: 'archive.note', limit: 20, offset: 0 })).rows.map((row) => row.id),
      [2],
    );
    await context.transaction('operations', (tx) => tx.update({ table: 'note', key: { id: 1 }, values: { body: 'Scoped' } }));
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(f.note(), 'Scoped');
  await assert.rejects(retained.data.count('note'), Refusal);
  await assert.rejects(
    deployment.withContext(signedIn, (context) => context.data.update!({ table: 'note', key: { id: 2 }, values: { body: 'Denied' } })),
    Refusal,
  );
  assert.equal(f.db.prepare('SELECT body FROM physical_note WHERE id = 2').get()!.body, 'Hidden');
});

/* A policy that must look a person up asks the App's own connections, read
   only: the desks come from a table, not from a pool the policy keeps. */
test("a row policy reads through a read-only db on the App's own sources", async (t) => {
  const f = await fixture(t);
  const looked: unknown[] = [];
  const policy = defineAppRowPolicy({
    appId: f.app.id,
    async resolveRows(_principal, { db }) {
      assert.ok(Object.isFrozen(db));
      for (const table of ['loan', 'note', 'archive.note']) {
        assert.equal('insert' in db[table], false);
        assert.equal('update' in db[table], false);
        assert.equal('remove' in db[table], false);
      }
      const assigned = await db.loan.where({ assignee: 'Hidden' });
      const archived = await db['archive.note'].count();
      looked.push(
        assigned.map((row) => row.desk),
        archived,
      );
      const desk = Number(assigned[0].desk);
      return {
        loan: { groups: [[{ column: 'desk', op: '=', value: desk }]] },
        note: { groups: [[{ column: 'desk', op: '=', value: desk }]] },
        'archive.note': false,
      };
    },
  });
  const deployment = await f.deploy({ policy });
  const seen = await deployment.withContext(signedIn, async (context) =>
    (await context.data.query({ table: 'note', limit: 20, offset: 0 })).rows.map((row) => row.id),
  );
  assert.deepEqual(seen, [2]);
  assert.deepEqual(looked, [[2], 2]);
});

test('request-supplied identity cannot replace verification and each invocation sees current roles', async (t) => {
  const f = await fixture(t);
  const deployment = await f.deploy();
  await assert.rejects(
    deployment.withContext({ body: { id: 'verified-manager', role: 'manager', rows: { note: true } } }, async () =>
      assert.fail('Unsigned callback'),
    ),
    sanitized(AppAccessDenied),
  );
  await deployment.withContext({ cookie: 'viewer-session', body: { role: 'manager' } }, async (context) => {
    assert.equal(context.principal.id, 'verified-viewer');
    assert.equal(context.data.update, undefined);
  });
  f.identities.set('manager-session', { id: 'verified-manager', who: 'manager@example.test', role: 'viewer' });
  await deployment.withContext(signedIn, async (context) => {
    assert.equal(context.data.update, undefined);
  });
  assert.equal(f.control.verifications, 3);
});

test('commands and receipts retain verified actor ownership and current row authorization', async (t) => {
  const f = await fixture(t, { commands: true });
  const deployment = await f.deploy();
  const applied = await deployment.withContext(signedIn, (context) => context.commands!.execute(commandRequest()));
  assert.equal(applied.status, 'applied');
  assert.equal(f.loan(), 'Ada');
  assert.deepEqual(f.control.actors, [
    { id: 'verified-manager', appId: 'deployment-app', roles: ['manager'], email: 'manager@example.test' },
  ]);
  assert.deepEqual(await deployment.withContext(signedIn, (context) => context.commands!.status(commandRequest())), {
    ...applied,
    replayed: true,
  });
  assert.deepEqual(await deployment.withContext({ cookie: 'other-session' }, (context) => context.commands!.status(commandRequest())), {
    status: 'not_found',
    outcome: 'unknown',
  });
  f.rows.loan = false;
  await assert.rejects(
    deployment.withContext(signedIn, (context) => context.commands!.status(commandRequest())),
    (error) => {
      assert.ok(error instanceof BusinessCommandExecutionError);
      assert.equal(error.code, 'forbidden');
      assert.equal(error.outcome, 'unknown');
      return true;
    },
  );
  assert.equal(f.control.handlers, 1);
});

/* Under a row policy the handler cannot read other desks' loans, so it
   cannot find their last number; the sequence counts past the row scope,
   and a refused command spends none. */
test('a command under a row policy numbers from a sequence the scope does not hide', async (t) => {
  const f = await fixture(t, { commands: true });
  f.db.exec(`INSERT INTO __mistri_sequence_number VALUES ('deployment-app', '', '', 'tenant', '', 'assignment', '1', 3),
    ('deployment-app', '', '', 'tenant', '', 'assignment', '2', 5)`);
  let refuse = false,
    desks: unknown[] = [];
  const handle = async (context: BusinessCommandContext) => {
    const loan = context.record!,
      id = Number(loan.id),
      version = Number(loan.version);
    desks = (await context.tx.query({ table: 'loan', limit: 10, offset: 0 })).rows.map((row) => row.desk);
    const number = await context.nextNumber('assignment', { per: Number(loan.desk) });
    if (refuse) throw new BusinessCommandExecutionError('ineligible_state');
    await context.tx.update({
      table: 'loan',
      key: { id },
      expected: { version, assignee: String(loan.assignee) },
      values: { assignee: `A-${number}`, version: version + 1 },
    });
    return { id, version: version + 1 };
  };
  const deployment = await f.deploy({ commands: { ...f.commands, registry: { assign: f.define(handle as never) } } });
  refuse = true;
  await assert.rejects(
    deployment.withContext(signedIn, (context) => context.commands!.execute(commandRequest())),
    BusinessCommandExecutionError,
  );
  refuse = false;
  const applied = await deployment.withContext(signedIn, (context) =>
    context.commands!.execute({ ...commandRequest(), idempotencyKey: 'deployment-command-numbered' }),
  );
  assert.equal(applied.status, 'applied');
  assert.deepEqual(desks, [1], 'the handler reads its own desk only');
  assert.equal(f.loan(), 'A-4');
  assert.deepEqual(
    f.db
      .prepare('SELECT per, value FROM __mistri_sequence_number ORDER BY per')
      .all()
      .map((row) => ({ ...row })),
    [
      { per: '1', value: 4 },
      { per: '2', value: 5 },
    ],
  );
});

for (const stage of ['verifier', 'policy'] as const) {
  test(`${stage} exceptions are sanitized to access denial without private causes`, async (t) => {
    const f = await fixture(t);
    const fail = () => {
      throw new Error(secret);
    };
    const deployment = await f.deploy(
      stage === 'verifier' ? { verifySession: async () => fail() } : { policy: defineAppRowPolicy({ appId: f.app.id, resolveRows: fail }) },
    );
    await assert.rejects(
      deployment.withContext(signedIn, async () => assert.fail('Failed verification reached callback')),
      sanitized(AppAccessDenied),
    );
    assert.equal(f.control.releases, 0);
    await deployment.retire();
    assert.equal(f.control.releases, 1);
  });
}

for (const stage of ['verifier', 'resolver', 'callback'] as const) {
  test(`retire rejects new work immediately and drains an accepted ${stage} before release`, async (t) => {
    const f = await fixture(t);
    const entered = gate();
    const held = gate();
    const wait = async () => {
      entered.release();
      await held.promise;
    };
    const deployment = await f.deploy({
      verifySession: async (request) => {
        if (stage === 'verifier') await wait();
        return f.options.verifySession(request);
      },
      policy: defineAppRowPolicy({
        appId: f.app.id,
        resolveRows: async (principal, context) => {
          if (stage === 'resolver') await wait();
          return f.policy.resolveRows(principal, context);
        },
      }),
    });
    let callbacks = 0;
    const invocation = deployment.withContext(signedIn, async (context) => {
      callbacks++;
      if (stage === 'callback') await wait();
      return context.data.count('note');
    });
    const rejected = assert.rejects(invocation, Refusal);
    let retirement!: Promise<void>;
    let settled = false;
    try {
      await entered.promise;
      retirement = deployment.retire();
      void retirement.then(() => {
        settled = true;
      });
      await assert.rejects(
        deployment.withContext(signedIn, async () => assert.fail('Retired deployment accepted new work')),
        Refusal,
      );
      await turn();
      assert.equal(settled, false);
      assert.equal(f.control.releases, 0);
    } finally {
      held.release();
    }
    await rejected;
    await retirement;
    assert.equal(callbacks, stage === 'callback' ? 1 : 0);
    assert.equal(f.control.releases, 1);
  });
}

test('concurrent retirement waits for one provider release without closing borrowed adapters', async (t) => {
  const f = await fixture(t);
  let closes = 0;
  for (const adapter of [f.resources.adapter, ...f.anchors.values()])
    adapter.close = async () => {
      closes++;
    };
  const deployment = await f.deploy();
  const held = gate();
  f.control.releaseHold = held.promise;
  let settled = 0;
  const retirements = Array.from({ length: 8 }, () =>
    deployment.retire().then(() => {
      settled++;
    }),
  );
  try {
    await turn();
    assert.equal(f.control.releases, 1);
    assert.equal(settled, 0);
    assert.equal(closes, 0);
  } finally {
    held.release();
  }
  await Promise.all(retirements);
  await deployment.retire();
  assert.equal(f.control.releases, 1);
  assert.equal(closes, 0);
});

test('retirement release faults stay sanitized and repeated retirement never retries release', async (t) => {
  const f = await fixture(t);
  const deployment = await f.deploy();
  f.control.releaseError = new Error(secret);
  await Promise.all(Array.from({ length: 4 }, () => assert.rejects(deployment.retire(), sanitized(AppRowPolicyDefinitionError))));
  await assert.rejects(deployment.retire(), sanitized(AppRowPolicyDefinitionError));
  await assert.rejects(
    deployment.withContext(signedIn, async () => assert.fail('Faulted retirement reopened deployment')),
    Refusal,
  );
  assert.equal(f.control.releases, 1);
});

test('application callback errors preserve object identity and do not release the live deployment', async (t) => {
  const f = await fixture(t);
  const deployment = await f.deploy();
  const failure = new Error('Application callback failure');
  await assert.rejects(
    deployment.withContext(signedIn, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(f.control.releases, 0);
  assert.equal(await deployment.withContext(signedIn, (context) => context.data.count('note')), 1);
});

test('retirement preserves postcommit unknown outcomes over callback and lifecycle failures', async (t) => {
  const f = await fixture(t);
  const original = f.anchor.scopeTransaction!.bind(f.anchor);
  const unknown = new TransactionOutcomeUnknown(new Error('Lost commit acknowledgment'));
  let inject = false;
  f.anchor.scopeTransaction = async (scope, run) => {
    const result = await original(scope, run);
    if (inject) throw unknown;
    return result;
  };
  const deployment = await f.deploy();
  inject = true;
  let retirement!: Promise<void>;
  await assert.rejects(
    deployment.withContext(signedIn, async (context) => {
      await assert.rejects(
        context.data.update!({ table: 'note', key: { id: 1 }, values: { body: 'Committed' } }),
        (error) => error === unknown,
      );
      retirement = deployment.retire();
      throw new Refusal('Callback must not mask unknown outcome');
    }),
    (error) => error === unknown,
  );
  await retirement;
  assert.equal(f.note(), 'Committed');
  assert.equal(f.control.releases, 1);
});

test('retirement drains an unawaited committed write after callback settlement without changing success', async (t) => {
  const f = await fixture(t);
  const original = f.anchor.scopeTransaction!.bind(f.anchor);
  const committed = gate();
  const held = gate();
  let inject = false;
  f.anchor.scopeTransaction = async (scope, run) => {
    const result = await original(scope, run);
    if (inject) {
      committed.release();
      await held.promise;
    }
    return result;
  };
  const deployment = await f.deploy();
  inject = true;
  const invocation = deployment.withContext(signedIn, async (context) => {
    void context.data.update!({ table: 'note', key: { id: 1 }, values: { body: 'Committed' } });
    await committed.promise;
    return 'finished';
  });
  let retirement!: Promise<void>;
  try {
    await committed.promise;
    await turn();
    retirement = deployment.retire();
    await turn();
    assert.equal(f.note(), 'Committed');
    assert.equal(f.control.releases, 0);
  } finally {
    held.release();
  }
  assert.equal(await invocation, 'finished');
  await retirement;
  assert.equal(f.control.releases, 1);
});

test('verifier identity and async resolver scope are captured on delivery before queued mutations', async (t) => {
  const f = await fixture(t);
  const identity: Identity = { id: 'verified-viewer', who: 'viewer@example.test', role: 'viewer' };
  const verify = () => {
    queueMicrotask(() => {
      identity.id = 'forged-manager';
      identity.role = 'manager';
    });
    return identity;
  };
  const deployment = await f.deploy({ verifySession: verify as unknown as Options['verifySession'] });
  await deployment.withContext(signedIn, async (context) => {
    assert.deepEqual(context.principal, {
      id: 'verified-viewer',
      appId: 'deployment-app',
      roles: ['viewer'],
      email: 'viewer@example.test',
    });
    assert.equal(context.data.update, undefined);
    assert.equal(await context.data.count('note'), 1);
  });
  assert.equal(identity.role, 'manager', 'queued mutation must actually have occurred');

  const entered = gate();
  let deliver!: (scope: RowScope) => void;
  const delivered = new Promise<RowScope>((resolve) => {
    deliver = resolve;
  });
  const scoped = await f.deploy({
    policy: defineAppRowPolicy({
      appId: f.app.id,
      resolveRows: () => {
        entered.release();
        return delivered;
      },
    }),
  });
  const invocation = scoped.withContext(signedIn, async (context) => {
    assert.equal(await context.data.count('note'), 1);
  });
  await entered.promise;
  deliver(f.rows);
  queueMicrotask(() => {
    f.rows.note = true;
  });
  await invocation;
  assert.equal(f.rows.note, true, 'queued scope mutation must actually have occurred');
});

test('reentrant verifier retirement drains its accepted invocation before releasing resources', async (t) => {
  const f = await fixture(t);
  const entered = gate();
  const held = gate();
  let deployment!: Deployment;
  let retirement!: Promise<void>;
  deployment = await f.deploy({
    verifySession: async (request) => {
      retirement = deployment.retire();
      entered.release();
      await held.promise;
      return f.options.verifySession(request);
    },
  });
  const invocation = assert.rejects(
    deployment.withContext(signedIn, async () => assert.fail('Retired verifier reached callback')),
    Refusal,
  );
  try {
    await entered.promise;
    await turn();
    assert.equal(f.control.releases, 0);
    await assert.rejects(
      deployment.withContext(signedIn, async () => assert.fail('Reentrant retirement accepted work')),
      Refusal,
    );
  } finally {
    held.release();
  }
  await invocation;
  await retirement;
  assert.equal(f.control.releases, 1);
});
