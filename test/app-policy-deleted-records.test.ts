import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal } from '../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.js';
import { createAppPolicyContext, type AppPolicyContext } from '../packages/mistri/src/server/policy/appPolicyContext.js';
import { createAppPolicyDeployment } from '../packages/mistri/src/server/policy/appPolicyDeployment.js';
import {
  AppRowPolicyDefinitionError,
  defineAppRowPolicy,
  loadAppRowPolicy,
  type AppRowPolicy,
} from '../packages/mistri/src/server/policy/appRowPolicy.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import type { DeletedPolicyRecord, PolicyPrincipal } from '../packages/mistri/src/server/policy.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { parseTestApp } from './support/commandCatalog.js';

type Request = { session: string; principal?: unknown };
type Options = Parameters<typeof createAppPolicyContext<Request>>[0];
type Authorize = NonNullable<AppRowPolicy['authorizeDeletedRecord']>;
const signedIn = { session: 'editor' };
const record = (table = 'note'): DeletedPolicyRecord => ({
  table,
  key: { id: 1 },
  row: { id: 1, owner: 'alice', body: 'History', nullable: null },
});
const malformed = (value: unknown) => value as DeletedPolicyRecord;
const sanitized = (error: unknown) => {
  assert.ok(error instanceof AppAccessDenied);
  assert.equal(error.message, new AppAccessDenied().message);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.doesNotMatch(error.stack ?? '', /private callback secret/);
  return true;
};
const denied = (run: () => unknown) => assert.rejects(async () => run(), sanitized);
const definition = () => ({ appId: 'deleted-records', resolveRows: (): RowScope => ({ note: true }) });

async function fixture(t: TestContext, readonlySource = false) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-deleted-policy-'));
  const registry = new Registry();
  t.after(async () => {
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  });
  for (const source of ['operations', 'archive']) {
    const path = join(directory, `${source}.db`);
    const db = new DatabaseSync(path);
    try {
      db.exec(`
        CREATE TABLE physical_note (id INTEGER PRIMARY KEY, owner TEXT, body TEXT, nullable TEXT);
        CREATE TABLE physical_parent (id INTEGER PRIMARY KEY);
        CREATE TABLE physical_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES physical_parent(id));
        CREATE TABLE physical_composite (a TEXT, b INTEGER, body TEXT, PRIMARY KEY (a, b));
        CREATE TABLE physical_keyless (body TEXT);
        CREATE TABLE physical_loan (id INTEGER PRIMARY KEY, version INTEGER);
        CREATE VIEW physical_summary AS SELECT * FROM physical_note;
      `);
    } finally {
      db.close();
    }
    migrateSqliteCommandJournal(path);
    registry.add({
      id: `private-${source}`,
      name: source,
      url: path,
      source: 'config',
      writable: !(readonlySource && source === 'archive'),
    });
  }
  const aliases = {
    note: 'physical_note',
    parent: 'physical_parent',
    child: 'physical_child',
    composite: 'physical_composite',
    keyless: 'physical_keyless',
    loan: 'physical_loan',
    summary: 'physical_summary',
  };
  const tables = Object.keys(aliases).filter((name) => name !== 'loan');
  const all = [...tables, 'loan', 'archive.note'];
  const physical: Record<string, string> = { ...aliases, 'archive.note': 'physical_note' };
  const app = parseTestApp(
    {
      id: 'deleted-records',
      name: 'Deleted records',
      sources: { operations: { connection: 'private-operations', default: true }, archive: { connection: 'private-archive' } },
      resources: Object.fromEntries(all.map((name) => [name, { physical: physical[name], access: 'write' }])),
      auth: {
        roles: {
          editor: { read: all, write: [...tables, ...(readonlySource ? [] : ['archive.note'])] },
          reader: { read: all },
          denied: {},
          narrow: { read: ['note'], write: ['note'], fields: { note: { read: ['id', 'owner', 'body'], write: ['id', 'owner', 'body'] } } },
          limited: { read: ['note'], write: ['note'], fields: { note: { read: ['id', 'owner', 'body', 'nullable'], write: ['body'] } } },
          partA: { read: ['note'], write: ['note'], fields: { note: { read: ['id', 'owner'], write: ['id', 'owner'] } } },
          partB: { read: ['note'], write: ['note'], fields: { note: { read: ['id', 'body', 'nullable'], write: ['body', 'nullable'] } } },
          command: { read: ['loan'], commands: ['advance'] },
        },
      },
      views: { notes: { kind: 'list', from: 'note' } },
      home: 'notes',
    },
    'deleted records fixture',
  );
  const resources = await loadAppRuntimeResources(registry, app, 'private-operations');
  const identities = new Map<string, Identity>([
    ['editor', { id: 'alice', who: 'private@example.test', role: 'editor' }],
    ['bob', { id: 'bob', who: 'other@example.test', role: 'editor' }],
  ]);
  for (const role of ['reader', 'denied', 'narrow', 'limited', 'partA,partB', 'command']) {
    identities.set(role, { id: 'alice', who: 'private@example.test', role });
  }
  const rows: Record<string, RowScope[string]> = Object.fromEntries(all.map((table) => [table, true]));
  const options: Options = {
    app,
    resources,
    sourceConnections: new Map([
      ['operations', 'private-operations'],
      ['archive', 'private-archive'],
    ]),
    verifySession: async (request) => identities.get(request.session) ?? null,
    resolveRows: () => rows,
  };
  const issue = (authorizeDeletedRecord?: Authorize, extra: Partial<Options> = {}) =>
    createAppPolicyContext({
      ...options,
      ...(authorizeDeletedRecord === undefined ? {} : { authorizeDeletedRecord }),
      ...extra,
    });
  return { directory, options, issue, rows, app, resources, identities };
}

test('deleted policy declaration is optional and captures identity without startup invocation', () => {
  let calls = 0;
  const authorizeDeletedRecord = () => {
    calls++;
    return true;
  };
  const input = { ...definition(), authorizeDeletedRecord };
  const captured = defineAppRowPolicy(input);
  input.authorizeDeletedRecord = () => false;
  assert.equal(calls, 0);
  assert.equal(captured.authorizeDeletedRecord, authorizeDeletedRecord);
  assert.ok(Object.isFrozen(captured));
  assert.equal(Object.hasOwn(defineAppRowPolicy(definition()), 'authorizeDeletedRecord'), false);
  const asyncCallback = async () => true;
  assert.equal(
    defineAppRowPolicy({ ...definition(), authorizeDeletedRecord: asyncCallback as unknown as Authorize }).authorizeDeletedRecord,
    asyncCallback,
    'result validation is deferred until invocation',
  );
});

test('deleted policy definition rejects present nonfunctions and accessors without invocation', () => {
  for (const value of [undefined, null, true, false, 1, 'yes', {}, []]) {
    assert.throws(
      () => defineAppRowPolicy({ ...definition(), authorizeDeletedRecord: value } as AppRowPolicy),
      AppRowPolicyDefinitionError,
    );
  }
  let calls = 0;
  const input = Object.defineProperty(definition(), 'authorizeDeletedRecord', {
    enumerable: true,
    get() {
      calls++;
      return () => true;
    },
  });
  assert.throws(() => defineAppRowPolicy(input), AppRowPolicyDefinitionError);
  assert.equal(calls, 0);
});

test('loader captures the deleted callback and never invokes it while importing', async (t) => {
  const f = await fixture(t);
  const path = join(f.directory, 'policy.mjs');
  writeFileSync(
    path,
    `export default { appId: 'deleted-records', resolveRows: () => ({note:true}),
    authorizeDeletedRecord() { throw new Error('private callback secret'); } };`,
  );
  const policy = await loadAppRowPolicy(path);
  assert.equal(typeof policy.authorizeDeletedRecord, 'function');
  assert.equal(policy.authorizeDeletedRecord, (await loadAppRowPolicy(path)).authorizeDeletedRecord);
});

test('deployment forwards captured callback through acquisition without invoking at startup', async (t) => {
  const f = await fixture(t);
  // No command registry is installed in this deployment.
  delete f.app.auth!.roles!.command;
  let calls = 0;
  const policy = {
    ...definition(),
    authorizeDeletedRecord: () => {
      calls++;
      return true;
    },
  };
  const deployment = await createAppPolicyDeployment<Request>({
    app: f.app,
    policy,
    verifySession: f.options.verifySession,
    acquire: async () => {
      policy.authorizeDeletedRecord = () => false;
      return { resources: f.resources, sourceConnections: f.options.sourceConnections, release() {} };
    },
  });
  t.after(() => deployment.retire());
  assert.equal(calls, 0);
  await deployment.withContext(signedIn, async (context) => {
    assert.equal(await context.authorizeDeletedRecord!(record()), true);
  });
  assert.equal(calls, 1);
});

test('context exposes only an optional frozen helper and captures its configured identity', async (t) => {
  const f = await fixture(t);
  await f.issue().withContext(signedIn, async (context) => {
    assert.equal(Object.hasOwn(context, 'authorizeDeletedRecord'), false);
  });
  const options = { ...f.options, authorizeDeletedRecord: () => true };
  const issuer = createAppPolicyContext(options);
  options.authorizeDeletedRecord = () => false;
  await issuer.withContext(signedIn, async (context) => {
    assert.deepEqual(Reflect.ownKeys(context).sort(), [
      'authorizeDeletedRecord',
      'data',
      'principal',
      'readsAt',
      'schema',
      'sources',
      'transaction',
      'trial',
      'writeFields',
    ]);
    assert.ok(Object.isFrozen(context));
    assert.equal(await context.authorizeDeletedRecord!(record()), true);
  });
});

test('private context rejects malformed optional definitions before calling application code', async (t) => {
  const f = await fixture(t);
  for (const authorizeDeletedRecord of [undefined, null, {}, false]) {
    assert.throws(() => createAppPolicyContext({ ...f.options, authorizeDeletedRecord } as Options), AppAccessDenied);
  }
  let calls = 0;
  const options = Object.defineProperty({ ...f.options }, 'authorizeDeletedRecord', {
    enumerable: true,
    get() {
      calls++;
      return () => true;
    },
  });
  assert.throws(() => createAppPolicyContext(options), AppAccessDenied);
  assert.equal(calls, 0);
});

test('callback receives only verified immutable principal and complete detached logical data', async (t) => {
  const f = await fixture(t);
  const input = record();
  let captured!: DeletedPolicyRecord;
  let principal!: PolicyPrincipal;
  const issuer = f.issue((actual, value) => {
    principal = actual;
    captured = value;
    return true;
  });
  await issuer.withContext({ ...signedIn, principal: { id: 'forged', role: 'admin', source: 'archive' } }, async (context) => {
    assert.equal(await context.authorizeDeletedRecord!(input), true);
    assert.equal(principal, context.principal);
    assert.deepEqual(principal, { id: 'alice', appId: 'deleted-records', roles: ['editor'], email: 'private@example.test' });
    assert.notEqual(captured, input);
    assert.notEqual(captured.row, input.row);
    assert.notEqual(captured.key, input.key);
    assert.deepEqual(JSON.parse(JSON.stringify(captured)), input);
    for (const value of [principal, principal.roles, captured, captured.row, captured.key]) assert.ok(Object.isFrozen(value));
    (input.row as Record<string, unknown>).body = 'Changed';
    assert.equal(captured.row.body, 'History');
  });
});

test('principal ownership returns false and stays a successful invocation', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue((principal, value) => principal.id === value.row.owner);
  for (const [session, expected] of [
    ['editor', true],
    ['bob', false],
  ] as const) {
    assert.equal(await issuer.withContext({ session }, async (context) => context.authorizeDeletedRecord!(record())), expected);
  }
});

test('no session cannot invoke the callback', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await denied(() =>
    f
      .issue(() => {
        calls++;
        return true;
      })
      .withContext({ session: 'forged' }, async () => assert.fail()),
  );
  assert.equal(calls, 0);
});

test('current roles cannot borrow resource grants from inactive roles', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const issuer = f.issue(() => {
    calls++;
    return true;
  });
  for (const session of ['reader', 'denied']) {
    await denied(() => issuer.withContext({ session }, async (context) => context.authorizeDeletedRecord!(record())));
  }
  assert.equal(calls, 0);
});

test('full raw fields must be readable and writable even when the public catalog is projected', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const issuer = f.issue(() => {
    calls++;
    return true;
  });
  for (const session of ['narrow', 'limited']) {
    for (const input of [record(), { ...record(), row: { id: 1, owner: 'alice', body: 'History' } }]) {
      await denied(() => issuer.withContext({ session }, async (context) => context.authorizeDeletedRecord!(input)));
    }
  }
  assert.equal(calls, 0);
});

test('verified role unions can supply all full-row field grants', async (t) => {
  const f = await fixture(t);
  await f
    .issue(() => true)
    .withContext({ session: 'partA,partB' }, async (context) => {
      assert.equal(await context.authorizeDeletedRecord!(record()), true);
    });
});

test('command grants never widen generic deleted-record authorization', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const command = defineCommand({
    targets: 'none',
    source: 'operations',
    target: 'loan',
    read: ['loan'],
    write: ['loan'],
    input: {},
    output: { parse: () => ({}) },
    async handle() {
      return {};
    },
  });
  const issuer = f.issue(
    () => {
      calls++;
      return true;
    },
    {
      commands: {
        registry: { advance: command },
        writableConnection: () => true,
        resultReferences: { advance: () => [] },
      },
    },
  );
  await denied(() =>
    issuer.withContext({ session: 'command' }, async (context) => {
      assert.ok(context.commands);
      return context.authorizeDeletedRecord!({ table: 'loan', key: { id: 1 }, row: { id: 1, version: 0 } });
    }),
  );
  assert.equal(calls, 0);
});

test('secondary-source logical identity is exact and physical or default-qualified aliases refuse', async (t) => {
  const f = await fixture(t);
  const seen: string[] = [];
  const issuer = f.issue((_principal, value) => {
    seen.push(value.table);
    return true;
  });
  await issuer.withContext(signedIn, async (context) => {
    assert.equal(await context.authorizeDeletedRecord!(record('archive.note')), true);
  });
  for (const table of ['physical_note', 'operations.note', 'private-archive.note', 'missing', ' note', 'archive']) {
    await denied(() => issuer.withContext(signedIn, async (context) => context.authorizeDeletedRecord!(record(table))));
  }
  assert.deepEqual(seen, ['archive.note']);
});

test('read-only sources cannot authorize deleted history through a true callback', async (t) => {
  const f = await fixture(t, true);
  let calls = 0;
  await denied(() =>
    f
      .issue(() => {
        calls++;
        return true;
      })
      .withContext(signedIn, async (context) => context.authorizeDeletedRecord!(record('archive.note'))),
  );
  assert.equal(calls, 0);
});

test('explicit and omitted row denial return false without invoking the callback', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const issuer = f.issue(() => {
    calls++;
    return true;
  });
  f.rows.note = false;
  await issuer.withContext(signedIn, async (context) => assert.equal(await context.authorizeDeletedRecord!(record()), false));
  delete f.rows.note;
  await issuer.withContext(signedIn, async (context) => assert.equal(await context.authorizeDeletedRecord!(record()), false));
  assert.equal(calls, 0);
});

test('helper authorizes history without claiming absent candidates satisfy scoped writer predicates', async (t) => {
  const f = await fixture(t);
  f.rows.note = { groups: [[{ column: 'owner', op: '=', value: 'someone else' }]] };
  await assert.rejects(
    f
      .issue(() => true)
      .withContext(signedIn, async (context) => {
        assert.equal(await context.authorizeDeletedRecord!(record()), true);
        await assert.rejects(
          context.transaction('operations', (tx) => tx.insert({ table: 'note', values: { ...record().row } })),
          Refusal,
        );
      }),
    Refusal,
  );
});

test('non-keyed tables, views and incoming relationships refuse before callback', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const issuer = f.issue(() => {
    calls++;
    return true;
  });
  for (const value of [
    record('summary'),
    { table: 'keyless', key: {}, row: { body: 'History' } },
    { table: 'parent', key: { id: 1 }, row: { id: 1 } },
  ]) {
    await denied(() => issuer.withContext(signedIn, async (context) => context.authorizeDeletedRecord!(value)));
  }
  assert.equal(calls, 0);
});

test('envelope requires exactly table/key/row and never accepts caller provenance or grants', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const issuer = f.issue(() => {
    calls++;
    return true;
  });
  const invalid: unknown[] = [null, undefined, [], 'note', {}, { table: 'note', key: { id: 1 } }];
  for (const key of ['source', 'actor', 'scope', 'principal', 'extra']) invalid.push({ ...record(), [key]: 'forged' });
  for (const value of invalid) {
    await denied(() => issuer.withContext(signedIn, async (context) => context.authorizeDeletedRecord!(malformed(value))));
  }
  assert.equal(calls, 0);
});

test('strict plain records reject proxies and accessors without executing traps', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  let traps = 0;
  const trap = () => {
    traps++;
    throw new Error('private callback secret');
  };
  const issuer = f.issue(() => {
    calls++;
    return true;
  });
  for (const location of ['envelope', 'key', 'row']) {
    const base = location === 'envelope' ? record() : location === 'key' ? record().key : record().row;
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const part of [
      new Proxy(base, { ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap }),
      revoked.proxy,
      Object.assign(Object.create({ inherited: true }), base),
      Object.defineProperty({ ...base }, 'hidden', { value: true }),
      { ...base, [Symbol('secret')]: true },
      Object.defineProperty({ ...base }, Object.keys(base)[0], { enumerable: true, get: trap }),
    ]) {
      const value = location === 'envelope' ? part : { ...record(), [location]: part };
      await denied(() => issuer.withContext(signedIn, async (context) => context.authorizeDeletedRecord!(malformed(value))));
    }
  }
  assert.equal(calls, 0);
  assert.equal(traps, 0);
});

test('null-prototype records are accepted and snapshotted synchronously before microtasks', async (t) => {
  const f = await fixture(t);
  const input = Object.assign(Object.create(null), record());
  input.key = Object.assign(Object.create(null), input.key);
  input.row = Object.assign(Object.create(null), input.row);
  let captured!: DeletedPolicyRecord;
  await f
    .issue((_principal, value) => {
      captured = value;
      return true;
    })
    .withContext(signedIn, async (context) => {
      queueMicrotask(() => {
        input.row.body = 'microtask mutation';
      });
      const pending = context.authorizeDeletedRecord!(input);
      input.row.owner = 'bob';
      assert.equal(await pending, true);
      assert.equal(captured.row.body, 'History');
      assert.equal(captured.row.owner, 'alice');
    });
});

test('envelope bounds and scalar validation reject oversized, cyclic and nonfinite data', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue(() => assert.fail('Malformed data reached callback'));
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const invalid = [
    true,
    false,
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    {},
    [],
    new Date(),
    new Uint8Array([1]),
    cycle,
    'x'.repeat(1_048_577),
  ];
  for (const value of invalid) {
    await denied(() =>
      issuer.withContext(signedIn, async (context) =>
        context.authorizeDeletedRecord!(
          malformed({
            ...record(),
            row: { ...record().row, body: value },
          }),
        ),
      ),
    );
  }
  for (const part of ['key', 'row']) {
    const oversized = Object.fromEntries(Array.from({ length: 8193 }, (_, index) => [String(index), 1]));
    await denied(() =>
      issuer.withContext(signedIn, async (context) => context.authorizeDeletedRecord!(malformed({ ...record(), [part]: oversized }))),
    );
  }
});

test('full rows and complete actual scalar keys must match strictly without coercion', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const issuer = f.issue(() => {
    calls++;
    return true;
  });
  for (const key of [{}, { id: '1' }, { id: null }, { id: true }, { id: 1, owner: 'alice' }, { owner: 'alice' }]) {
    await denied(() => issuer.withContext(signedIn, async (context) => context.authorizeDeletedRecord!(malformed({ ...record(), key }))));
  }
  const invalidRows: Array<DeletedPolicyRecord['row']> = [
    { id: 1, owner: 'alice', body: 'History' },
    { ...record().row, extra: 1 },
    { ...record().row, id: 2 },
  ];
  for (const row of invalidRows) {
    await denied(() => issuer.withContext(signedIn, async (context) => context.authorizeDeletedRecord!({ ...record(), row })));
  }
  assert.equal(calls, 0);
});

test('composite keys and large textual keys preserve scalar identity', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue(() => true);
  const row = { a: '9007199254740993', b: 3, body: 'History' };
  await issuer.withContext(signedIn, async (context) => {
    assert.equal(await context.authorizeDeletedRecord!({ table: 'composite', key: { a: row.a, b: 3 }, row }), true);
  });
  const invalid: Array<DeletedPolicyRecord['key']> = [{ a: row.a }, { a: row.a, b: '3' }, { a: row.a, b: 4 }];
  for (const key of invalid) {
    await denied(() => issuer.withContext(signedIn, async (context) => context.authorizeDeletedRecord!({ table: 'composite', key, row })));
  }
});

test('false extractor result is a nonfatal history denial including unawaited operations', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue(() => false);
  assert.equal(
    await issuer.withContext(signedIn, async (context) => {
      assert.equal(await context.authorizeDeletedRecord!(record()), false);
      void context.authorizeDeletedRecord!(record());
      return 'no visible history';
    }),
    'no visible history',
  );
});

test('throws and invalid exact-boolean results sanitize and poison caught or unawaited invocations', async (t) => {
  const f = await fixture(t);
  const callbacks: Array<() => unknown> = [
    () => {
      throw new Error('private callback secret');
    },
    ...[undefined, null, 0, 1, '', 'true', [], {}, Object(true)].map((value) => () => value),
  ];
  for (const callback of callbacks) {
    const issuer = f.issue(callback as Authorize);
    await denied(() =>
      issuer.withContext(signedIn, async (context) => {
        await denied(() => context.authorizeDeletedRecord!(record()));
        return 'caught';
      }),
    );
    await denied(() =>
      issuer.withContext(signedIn, async (context) => {
        void context.authorizeDeletedRecord!(record());
      }),
    );
  }
});

test('native promises reject immediately without unhandled rejection and thenables are never assimilated', async (t) => {
  const f = await fixture(t);
  let thenCalls = 0;
  const callbacks: Array<() => unknown> = [
    () => Promise.resolve(true),
    () => Promise.resolve(false),
    () => Promise.reject(new Error('private callback secret')),
    () => new Promise(() => {}),
    () => ({
      // oxlint-disable-next-line unicorn/no-thenable -- hostile callback output must not be assimilated.
      then() {
        thenCalls++;
      },
    }),
    () =>
      // oxlint-disable-next-line unicorn/no-thenable -- even reading a hostile then accessor must be refused.
      Object.defineProperty({}, 'then', {
        get() {
          thenCalls++;
          throw new Error('private callback secret');
        },
      }),
  ];
  for (const callback of callbacks) {
    await denied(() => f.issue(callback as Authorize).withContext(signedIn, async (context) => context.authorizeDeletedRecord!(record())));
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(thenCalls, 0);
});

test('mutation attempts cannot change frozen callback data and escaping mutation errors are tracked', async (t) => {
  const f = await fixture(t);
  const input = record();
  await f
    .issue((principal, value) => {
      for (const target of [value, value.key, value.row, principal, principal.roles]) {
        assert.throws(() => Object.assign(target, { extra: 'forged' }), TypeError);
      }
      return true;
    })
    .withContext(signedIn, async (context) => assert.equal(await context.authorizeDeletedRecord!(input), true));
  await denied(() =>
    f
      .issue((_principal, value) => {
        Object.assign(value.row, { owner: 'bob' });
        return true;
      })
      .withContext(signedIn, async (context) => context.authorizeDeletedRecord!(input)),
  );
  assert.equal(input.row.owner, 'alice');
  assert.equal(Object.isFrozen(input.row), false);
});

test('retained helpers expire on settlement, callback failure, retirement and cross-context reuse', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const issuer = f.issue(() => {
    calls++;
    return true;
  });
  let retained!: AppPolicyContext;
  await issuer.withContext(signedIn, async (context) => {
    retained = context;
  });
  await denied(() => retained.authorizeDeletedRecord!(record()));
  await issuer.withContext({ session: 'bob' }, async (context) => {
    await denied(() => retained.authorizeDeletedRecord!.call(context, record()));
    assert.equal(await context.authorizeDeletedRecord!(record()), true);
  });
  await assert.rejects(
    issuer.withContext(signedIn, async (context) => {
      retained = context;
      throw new Error('callback failed');
    }),
  );
  await denied(() => retained.authorizeDeletedRecord!(record()));
  await denied(() =>
    issuer.withContext(signedIn, async (context) => {
      issuer.retire();
      return context.authorizeDeletedRecord!(record());
    }),
  );
  assert.equal(calls, 1);
});

test('reentrant retirement refuses callback success and current identity is refreshed per invocation', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue(() => {
    issuer.retire();
    return true;
  });
  await denied(() => issuer.withContext(signedIn, async (context) => context.authorizeDeletedRecord!(record())));
  let calls = 0;
  const live = f.issue(() => {
    calls++;
    return true;
  });
  await live.withContext(signedIn, async (context) => assert.equal(await context.authorizeDeletedRecord!(record()), true));
  f.identities.set('editor', { id: 'alice', who: 'private@example.test', role: 'reader' });
  await denied(() => live.withContext(signedIn, async (context) => context.authorizeDeletedRecord!(record())));
  assert.equal(calls, 1);
});
