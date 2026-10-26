import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { COMMAND_JOURNAL_TABLES as journal, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, text, literal } from '../packages/mistri/src/server/commands/commandShapes.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { validateBusinessCommandReferences } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { openBusinessCommandCalls, dispatchBusinessCommandHttp } from '../packages/mistri/src/server/commands/businessCommandHttp.js';
import { dispatchPublicFormHttp } from '../packages/mistri/src/server/commands/formHttp.js';
import { createCommandFlags, type CommandFlags, type CaptureCommandFlags } from '../packages/mistri/src/server/commands/commandFlags.js';
import { normalizeFlagCatalog } from '../packages/mistri/src/shared/appFlags.js';
import { createAppPolicyContext } from '../packages/mistri/src/server/policy/appPolicyContext.js';
import { bindPolicyPublicIntake } from '../packages/mistri/src/server/policy/policyPublicIntake.js';
import { jobHandlers } from '../packages/mistri/src/server/jobs/jobCommands.js';
import { defineJob, defineJobs, capturedJobModule, pinJobs } from '../packages/mistri/src/server/jobs/jobModule.js';
import type { JobContext } from '../packages/mistri/src/server/jobs/jobs.js';
import type { AppFormView } from '../packages/mistri/src/shared/app.js';
import { parseTestApp } from './support/commandCatalog.js';
import { openTenantEngine } from './support/tenantDialects.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { createTenantRequestRuntime } from '../packages/mistri/src/server/tenant/tenantRequestRuntime.js';
import { bindTenantCommands } from '../packages/mistri/src/server/tenant/tenantCommands.js';
import { bindPlatformCommands, bindPlatformRequestRuntime } from '../packages/mistri/src/server/tenant/tenantPlatformCommands.js';
import { bindTenantIntake } from '../packages/mistri/src/server/tenant/tenantIntake.js';
import { bindTenantJobs } from '../packages/mistri/src/server/tenant/tenantJobs.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { dispatchSavedFormHttp, type SavedForm } from '../packages/mistri/src/server/forms/savedFormHttp.js';

const catalog = normalizeFlagCatalog({ flags: { launch: { type: 'boolean', default: false, owner: 'team' } }, roles: [], audiences: {} });
const reader = (value: boolean) =>
  createCommandFlags(catalog, { evaluate: () => ({ value, reason: 'default', revision: 1, diagnostics: [] }) });
const enabledBy = { flag: 'launch', is: true };
const actor = { id: 'alice', appId: 'flag-owners', roles: ['staff'] };
const prepare = { command: 'change', commandVersion: 1, key: { id: 1 } };
const execute = { ...prepare, expectedVersion: 0, input: {}, idempotencyKey: 'owner-command-request-0001' };
const availability = { checks: [{ command: 'change', commandVersion: 1, keys: [{ id: 1 }] }] };
const signal = new AbortController().signal;
const publicInput = { name: { type: 'text' as const, label: 'Name' } };
function http(body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.method = 'POST';
  req.headers = {};
  const res = Object.assign(new EventEmitter(), { getHeader: () => undefined, destroyed: false }) as unknown as ServerResponse;
  return { req, res };
}

async function fixture(t: TestContext, publicly = false) {
  const directory = mkdtempSync(join(tmpdir(), 'flag-command-owners-')),
    path = join(directory, 'data.db');
  const db = new DatabaseSync(path),
    registry = new Registry();
  t.after(async () => {
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec('CREATE TABLE item(id INTEGER PRIMARY KEY, version INTEGER NOT NULL, note TEXT); INSERT INTO item VALUES(1,0,NULL);');
  migrateSqliteCommandJournal(path);
  registry.add({ id: 'data', name: 'Data', url: path, writable: true, source: 'config' });
  const control = { enabled: true, captures: 0, handles: 0, hooks: [] as CommandFlags[] };
  const captureFlags = () => {
    control.captures++;
    return reader(control.enabled);
  };
  const commands = publicly
    ? defineCommands({
        apply: defineCommand({
          source: 'main',
          target: 'item',
          targets: 'none',
          public: true,
          enabledBy,
          input: publicInput,
          output: shape({ reference: text(), message: literal('Received.') }),
          async handle({ flags, db }) {
            control.handles++;
            control.hooks.push(flags);
            await db.item.insert({ version: 0, note: 'public' });
            return { reference: 'REF-001', message: 'Received.' };
          },
        }),
      })
    : defineCommands({
        change: defineCommand({
          source: 'main',
          target: 'item',
          enabledBy,
          initial({ flags }) {
            control.hooks.push(flags);
            return {};
          },
          availability({ flags, records }) {
            control.hooks.push(flags);
            return records.map(() => flags.get('launch') === true);
          },
          async handle({ flags, db, record }) {
            control.handles++;
            control.hooks.push(flags);
            await db.item.update(record, { note: 'changed' });
          },
        }),
      });
  const app = parseTestApp(
    {
      id: actor.appId,
      name: 'Flags',
      flags: catalog.flags,
      track: 'receipts',
      sources: { main: { connection: 'data' } },
      resources: {
        item: {
          access: 'write',
          ...(!publicly
            ? {
                actions: {
                  change: { label: 'Change', command: { id: 'change', version: 1, target: 'item', input: {} } },
                },
              }
            : {}),
        },
      },
      auth: {
        roles: {
          staff: { read: true, ...(!publicly ? { commands: ['change'] } : {}) },
          viewer: { read: true },
          automation: { read: true, ...(!publicly ? { commands: ['change'] } : {}) },
        },
      },
      views: {
        items: { kind: 'list', from: 'item' },
        ...(publicly
          ? { apply: { kind: 'form', label: 'Apply', public: true, command: { id: 'apply', version: 1, input: publicInput } } }
          : {}),
      },
      home: 'items',
    },
    'flags fixture',
  );
  const resources = await loadAppRuntimeResources(registry, app, 'data');
  return { directory, db, registry, app, commands, resources, control, captureFlags };
}

test('ordinary owner shares one post-authorization reader across prepare and execute; new requests capture anew', async (t) => {
  const f = await fixture(t);
  const options = { ...f, connection: 'data', actor, signal };
  const calls = await openBusinessCommandCalls(options);
  t.after(() => calls.release());
  assert.equal(f.control.captures, 0);
  await calls.prepare(prepare);
  f.control.enabled = false;
  await calls.execute(execute);
  assert.equal(f.control.captures, 1);
  assert.equal(f.control.handles, 1);
  assert.ok(f.control.hooks.every((flags) => flags === f.control.hooks[0]));
  const denied = await openBusinessCommandCalls({ ...options, actor: { ...actor, roles: ['viewer'] } });
  t.after(() => denied.release());
  await assert.rejects(denied.execute(execute), { code: 'forbidden' });
  assert.equal(f.control.captures, 1);
  const fresh = await openBusinessCommandCalls(options);
  t.after(() => fresh.release());
  await assert.rejects(fresh.execute({ ...execute, idempotencyKey: 'fresh-owner-request-0001' }), { code: 'forbidden' });
  assert.equal(f.control.captures, 2);
});

test('ordinary owner captures its envelope before awaiting the trusted flag provider', async (t) => {
  const f = await fixture(t);
  const body = { ...execute, key: { id: 1 } };
  const calls = await openBusinessCommandCalls({
    ...f,
    connection: 'data',
    actor,
    signal,
    captureFlags() {
      body.key.id = 999;
      return f.captureFlags();
    },
  });
  t.after(() => calls.release());
  await calls.execute(body);
  assert.equal(f.control.handles, 1);
  assert.equal(f.db.prepare('SELECT note FROM item WHERE id = 1').get()!.note, 'changed');
});

test('ordinary HTTP dispatch availability/prepare/execute/status use the host port and missing or forged readers fail closed', async (t) => {
  const f = await fixture(t);
  const run = (path: string, body: unknown, captureFlags = f.captureFlags) =>
    dispatchBusinessCommandHttp({
      ...f,
      ...http(body),
      path: `/api/commands/${path}`,
      connection: 'data',
      actor,
      captureFlags,
    });
  f.control.enabled = false;
  assert.deepEqual(await run('availability', availability), { checks: [{ command: 'change', commandVersion: 1, available: [false] }] });
  await assert.rejects(run('prepare', prepare), { code: 'forbidden' });
  await assert.rejects(run('execute', execute), { code: 'forbidden' });
  await assert.rejects(
    run('execute', execute, () => ({ get: () => true })),
    { code: 'forbidden' },
  );
  await assert.rejects(
    dispatchBusinessCommandHttp({
      ...f,
      ...http(execute),
      path: '/api/commands/execute',
      connection: 'data',
      actor,
      captureFlags: undefined,
    }),
    { code: 'forbidden' },
  );
  f.control.enabled = true;
  const applied = (await run('execute', execute)) as { receiptId: string };
  f.control.enabled = false;
  assert.equal(((await run('status', execute)) as { receiptId: string }).receiptId, applied.receiptId);
  assert.equal(f.control.handles, 1);
});

test('policy context memoizes across concurrent advice, prepare and execute and retains its lifetime fences', async (t) => {
  const f = await fixture(t);
  const issuer = createAppPolicyContext<{ role?: string }>({
    app: { ...f.app, auth: { ...f.app.auth!, rows: 'policy' } },
    resources: f.resources,
    sourceConnections: new Map([['main', 'data']]),
    verifySession: async (request) => ({ id: 'alice', who: 'Alice', role: request.role ?? 'staff' }),
    resolveRows: () => ({ item: true }),
    commands: { registry: f.commands, resultReferences: { change: () => [] }, writableConnection: () => true },
    captureFlags: (principal) => {
      assert.deepEqual(principal.roles, ['staff']);
      return f.captureFlags();
    },
  });
  t.after(() => issuer.retire());
  await issuer.withContext({}, async (context) => {
    await Promise.all([context.commands!.availability!(availability), context.commands!.prepare(prepare)]);
    f.control.enabled = false;
    await context.commands!.execute(execute);
  });
  assert.equal(f.control.captures, 1);
  assert.equal(f.control.handles, 1);
  assert.ok(f.control.hooks.every((flags) => flags === f.control.hooks[0]));
  await assert.rejects(
    issuer.withContext({ role: 'viewer' }, (context) => context.commands!.execute(execute)),
    { code: 'forbidden' },
  );
  assert.equal(f.control.captures, 1);
  await assert.rejects(
    issuer.withContext({}, (context) => context.commands!.execute({ ...execute, idempotencyKey: 'policy-next-request-001' })),
    { code: 'forbidden' },
  );
  assert.equal(f.control.captures, 2);
  await issuer.withContext({}, async (context) => {
    assert.equal((await context.commands!.status(execute)).status, 'applied');
  });
});

test('ordinary public form and fixed policy intake capture no account identity and replay while off', async (t) => {
  for (const policy of [false, true]) {
    const f = await fixture(t, true);
    const captureFlags: CaptureCommandFlags = (actor) => {
      assert.equal(actor.kind, 'public');
      assert.deepEqual(actor.roles, []);
      assert.equal(actor.id, 'public:apply');
      return f.captureFlags();
    };
    const intake = policy
      ? bindPolicyPublicIntake({
          app: { ...f.app, auth: { ...f.app.auth!, rows: 'policy' } },
          resources: f.resources,
          registry: f.commands,
          form: 'apply',
          rows: { item: true },
          resultReferences: () => [],
          writableConnection: () => true,
          captureFlags,
        })
      : undefined;
    t.after(async () => {
      await intake?.retire();
    });
    const submit = (submission = 'public-owner-submission-001') =>
      intake
        ? intake.submit({ input: { name: 'Visitor' }, submission })
        : dispatchPublicFormHttp({
            ...f,
            ...http({ input: { name: 'Visitor' }, submission }),
            connection: 'data',
            key: 'apply',
            command: (f.app.views.apply as AppFormView).command,
            captureFlags,
          });
    f.control.enabled = false;
    await assert.rejects(submit(), { code: 'forbidden' });
    f.control.enabled = true;
    await submit();
    f.control.enabled = false;
    await submit();
    await assert.rejects(submit('public-owner-submission-002'), { code: 'forbidden' });
    assert.equal(f.control.handles, 1);
    assert.equal(f.control.captures, 4);
  }
});

test('saved public form steps pass one issued reader into the draft executor before any insert', async (t) => {
  const f = await fixture(t, true);
  await f.registry.closeAll();
  f.db.exec(`ALTER TABLE item ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
    ALTER TABLE item ADD COLUMN resume_token_hash TEXT;
    ALTER TABLE item ADD COLUMN resume_expires_at TEXT;
    ALTER TABLE item ADD COLUMN resume_progress TEXT;`);
  const savedRegistry = new Registry();
  savedRegistry.add({ ...f.registry.configOf('data')! });
  t.after(() => savedRegistry.closeAll());
  const submitInput = { consent: { type: 'boolean' as const, label: 'Confirm' } };
  const commands = defineCommands({
    apply: defineCommand({
      source: 'main',
      target: 'item',
      targets: 'none',
      public: true,
      input: submitInput,
      output: shape({ reference: text(), message: literal('Received.') }),
      handle: () => ({ reference: 'REF-001', message: 'Received.' }),
    }),
    start: defineCommand({
      source: 'main',
      target: 'item',
      targets: 'none',
      public: true,
      enabledBy,
      input: publicInput,
      output: shape({ message: literal('Saved.') }),
      async handle({ flags, db, draft }, input) {
        f.control.handles++;
        assert.equal(flags.get('launch'), true);
        assert.ok(draft?.start);
        await db.item.insert({ ...draft.start, version: 0, note: input.name });
        return { message: 'Saved.' };
      },
    }),
  });
  const app = parseTestApp(
    {
      id: f.app.id,
      name: 'Saved flags',
      flags: catalog.flags,
      sources: { main: { connection: 'data' } },
      resources: { item: { access: 'write' } },
      auth: { roles: { staff: { read: true } } },
      views: {
        items: { kind: 'list', from: 'item' },
        apply: {
          kind: 'form',
          label: 'Apply',
          public: true,
          command: { id: 'apply', version: 1, input: submitInput },
          steps: [{ id: 'first', label: 'First', command: { id: 'start', version: 1, input: publicInput } }],
          resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress', after: '14 days' },
          draft: { status: 'draft' },
        },
      },
      home: 'items',
    },
    'saved flags',
  );
  validateBusinessCommandReferences(app, commands, await loadAppRuntimeResources(savedRegistry, app, 'data'));
  const submit = (captureFlags?: CaptureCommandFlags) =>
    dispatchSavedFormHttp({
      ...http({ input: { name: 'Visitor' }, submission: 'saved-owner-step-0001' }),
      registry: savedRegistry,
      app,
      commands,
      connection: 'data',
      key: 'apply',
      form: app.views.apply as SavedForm,
      action: { kind: 'step', step: 'first' },
      secure: false,
      ...(captureFlags ? { captureFlags } : {}),
    });
  assert.equal((await submit()).status, 403);
  assert.equal(f.control.handles, 0);
  f.control.enabled = false;
  assert.equal((await submit(f.captureFlags)).status, 403);
  f.control.enabled = true;
  assert.equal((await submit(f.captureFlags)).status, 200);
  f.control.enabled = false;
  assert.equal((await submit(f.captureFlags)).status, 200);
  assert.equal(f.control.handles, 1);
  assert.equal(f.control.captures, 3);
});

test('job binding captures for each authorized attempt, sharing retry status/execution and preserving old receipts while off', async (t) => {
  const f = await fixture(t);
  const module = pinJobs(
    capturedJobModule(
      defineJobs(
        { changeLater: defineJob({ every: '@hourly', runAs: 'clock', command: 'change' }) },
        { principals: { clock: { roles: ['automation'] } } },
      ),
    ),
    f.commands,
  );
  const binding = bindBusinessCommands({ app: f.app, resources: f.resources, registry: f.commands, writableConnection: () => true });
  let releases = 0;
  const handlers = jobHandlers({
    module,
    appId: f.app.id,
    bind: async () => ({
      binding,
      captureFlags(actor) {
        assert.equal(actor.kind, 'service');
        assert.deepEqual(actor.roles, ['automation']);
        return f.captureFlags();
      },
      release() {
        releases++;
      },
    }),
  });
  const context = (attempt: number, event = 'event-001'): JobContext => ({
    jobId: 'job-001',
    attempt,
    maxAttempts: 3,
    job: 'changeLater',
    version: 1,
    provenance: { appId: f.app.id, actorId: 'original-actor', causationId: event, correlationId: 'correlation-001' },
    signal,
    now: Date.now,
    cancelRequested: async () => false,
    grant: { audience: 'mistri.jobs', job: 'changeLater', version: 1, appId: f.app.id, expiresAt: Date.now() + 60_000 },
  });
  const input = { key: { id: 1 }, input: {} };
  assert.equal(f.control.captures, 0);
  f.control.enabled = false;
  await assert.rejects(async () => handlers.changeLater.handle(context(1), input), { code: 'rejected' });
  f.control.enabled = true;
  const applied = await handlers.changeLater.handle(context(2), input);
  assert.equal(f.control.captures, 2, 'retry status and execution share one reader');
  f.control.enabled = false;
  assert.deepEqual(await handlers.changeLater.handle(context(3), input), { ...(applied as object), replayed: true });
  assert.equal(f.control.captures, 3);
  assert.equal(f.control.handles, 1);
  assert.equal(releases, 3);
  const noFlags = jobHandlers({ module, appId: f.app.id, bind: async () => ({ binding, release() {} }) });
  await assert.rejects(async () => noFlags.changeLater.handle(context(1, 'event-002'), input), { code: 'rejected' });
  const revoked = jobHandlers({
    module: { ...module, principals: new Map([['clock', ['viewer']]]) },
    appId: f.app.id,
    bind: async () => ({ binding, captureFlags: f.captureFlags, release() {} }),
  });
  await assert.rejects(async () => revoked.changeLater.handle(context(1, 'event-003'), input), { code: 'rejected' });
  assert.equal(f.control.captures, 3, 'revoked command authority never reaches the flag provider');
});

async function tenantFixture(t: TestContext, publicGated = true) {
  const owner = { appId: 'tenant-flag-owners', source: { id: 'main', connection: 'data' }, storeId: 'tenant-flag-owner-store' };
  const engine = await openTenantEngine('sqlite', {
    database: 'unused_sqlite_only',
    tables: ['item', 'dealer', 'triage'],
    postgres: '',
    sqlite: `
    PRAGMA journal_mode=WAL;
    CREATE TABLE dealer(id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, address TEXT);
    CREATE TABLE item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), version INTEGER NOT NULL, note TEXT);
    CREATE TABLE triage(id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, note TEXT);
    INSERT INTO dealer VALUES('north','North','north-public-address-AAAAAAAA');
    INSERT INTO item VALUES('row','north',0,NULL);`,
  });
  const retire: Array<() => Promise<void>> = [];
  t.after(async () => {
    await Promise.all(retire.map((close) => close()));
    await engine.close();
  });
  await engine.provisionStore(owner);
  await engine.migrateCommandJournal();
  await engine.maintenance(owner, async (admin) => {
    await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
    await admin.putMembership({
      tenantId: 'north',
      accountId: 'alice',
      membershipId: 'north-alice',
      roles: ['staff'],
      status: 'active',
      validUntil: 60_000,
      expectedVersion: null,
    });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    await admin.putPlatformMembership({
      accountId: 'alice',
      membershipId: 'platform-alice',
      roles: ['manager'],
      status: 'active',
      validUntil: 60_000,
      expectedVersion: null,
    });
  });
  const physicalSchema = await engine.physicalSchema(),
    resources = Object.fromEntries(['item', 'dealer', 'triage'].map((id) => [id, engine.id(id)]));
  const mapped = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    physicalSchema,
    schema: mapped.schema,
    resources,
    profile: 'dealer',
    ownership: { dealer: { kind: 'platform' }, item: { kind: 'tenant', column: 'tenant_id' }, triage: { kind: 'platform' } },
  });
  const sourceReader = await engine.openRead(ownership, owner, () => 1000),
    writer = await engine.openWrite(ownership, owner, () => 1000);
  retire.push(sourceReader.close, writer.close);
  const control = { enabled: true, captures: 0, handles: 0, roles: [] as readonly string[][], scopes: [] as Array<string | null> };
  const common = {
    source: 'main',
    target: 'item',
    enabledBy,
    initial({ flags }: { flags: CommandFlags }) {
      assert.equal(flags.get('launch'), true);
      return {};
    },
    availability({ flags, records }: { flags: CommandFlags; records: readonly unknown[] }) {
      assert.equal(flags.get('launch'), true);
      return records.map(() => true);
    },
  };
  const commands = defineCommands({
    change: defineCommand({
      ...common,
      async handle({ flags, db, record }) {
        control.handles++;
        assert.equal(flags.get('launch'), true);
        await db.item.update(record, { note: 'tenant' });
      },
    }),
    review: defineCommand({
      ...common,
      realm: 'platform',
      async handle({ flags, db, record }) {
        control.handles++;
        assert.equal(flags.get('launch'), true);
        await db.item.update(record, { note: 'platform' });
      },
    }),
    apply: defineCommand({
      source: 'main',
      target: 'item',
      write: ['triage'],
      targets: 'none',
      public: true,
      ...(publicGated ? { enabledBy } : {}),
      input: publicInput,
      output: shape({ reference: text(), message: literal('Received.') }),
      async handle({ flags, db, intake }, input) {
        control.handles++;
        if (publicGated) assert.equal(flags.get('launch'), true);
        await db[intake === 'tenant' ? 'item' : 'triage'].insert({ id: `public-${input.name}`, version: 0, note: input.name });
        return { reference: 'REF-001', message: 'Received.' };
      },
    }),
  });
  const app = parseTestApp(
    {
      id: owner.appId,
      name: 'Tenant flags',
      flags: catalog.flags,
      sources: { main: { connection: 'data' } },
      resources: {
        dealer: { owner: 'platform' },
        triage: { access: 'write', owner: 'platform' },
        item: {
          access: 'write',
          owner: 'tenant',
          actions: {
            change: { label: 'Change', command: { id: 'change', version: 1, target: 'item', input: {} } },
            review: { label: 'Review', command: { id: 'review', version: 1, target: 'item', input: {}, realm: 'platform' } },
          },
        },
      },
      auth: {
        rows: 'tenant',
        tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Platform' } },
        roles: {
          staff: { realm: 'tenant', read: true, commands: ['change'] },
          manager: { realm: 'platform', read: true, commands: ['review'] },
        },
      },
      views: {
        items: { kind: 'list', from: 'item' },
        dealers: { kind: 'list', from: 'dealer' },
        apply: { kind: 'form', public: true, label: 'Apply', command: { id: 'apply', version: 1, input: publicInput } },
      },
      nav: [
        { id: 'tenant', label: 'Tenant', realm: 'tenant', children: ['items'] },
        { id: 'platform', label: 'Platform', realm: 'platform', children: ['dealers'] },
      ],
      home: 'items',
    },
    'tenant flags',
  );
  const options = {
    app,
    reader: sourceReader,
    writer,
    deployment: 'flags-generation',
    roles: ['staff', 'manager'],
    maxLifetimeMs: 5000,
    now: () => 1000,
    verifySession: (request: { admitted: boolean }) => (request.admitted ? { id: 'alice', who: 'Alice', role: 'global-admin' } : null),
  };
  const runtime = createTenantRequestRuntime({
    ...options,
    resolveMembershipRows: () => ({ item: true }),
    resolveRows: () => ({ item: true }),
  });
  const platformRuntime = bindPlatformRequestRuntime({
    ...options,
    roles: ['manager'],
    resolvePlatformRows: () => ({ dealer: true, item: true, triage: true }),
  });
  const resultReferences = { change: () => [], review: () => [], apply: () => [] };
  const captureFlags = (principal: { roles: readonly string[]; tenantId?: string | null }) => {
    control.captures++;
    control.roles = [...control.roles, [...principal.roles]];
    control.scopes.push(principal.tenantId ?? null);
    return reader(control.enabled);
  };
  const intake = bindTenantIntake({
    app,
    reader: sourceReader,
    writer,
    deployment: 'flags-generation',
    maxLifetimeMs: 5000,
    now: () => 1000,
    column: 'address',
    registry: commands,
    resultReferences,
    captureFlags(actor, placement) {
      assert.equal(actor.kind, 'public');
      assert.deepEqual(actor.roles, []);
      return captureFlags({ roles: [], ...(placement.tenantId ? { tenantId: placement.tenantId } : {}) });
    },
  });
  retire.splice(0, retire.length, intake.retire, platformRuntime.retire, runtime.retire);
  return {
    control,
    intake,
    runtime,
    platformRuntime,
    config: { registry: commands, resultReferences },
    captureFlags,
    app,
    owner,
    engine,
    sourceReader,
    writer,
    retire,
  };
}

test('tenant and platform command owners use only admitted realm roles and share their reader across gates and hooks', async (t) => {
  const f = await tenantFixture(t),
    request = { admitted: true };
  const tenant = bindTenantCommands(f.runtime, { ...f.config, captureFlags: f.captureFlags });
  const platform = bindPlatformCommands(f.platformRuntime, { ...f.config, captureFlags: f.captureFlags });
  for (const realm of ['tenant', 'platform'] as const) {
    const command = realm === 'tenant' ? 'change' : 'review';
    const target = { command, commandVersion: 1, key: { id: 'row' } };
    const body = { ...target, expectedVersion: realm === 'tenant' ? 0 : 1, input: {}, idempotencyKey: `flag-${realm}-request-001` };
    const check = { checks: [{ command, commandVersion: 1, keys: [{ id: 'row' }] }] };
    const noFlags = realm === 'tenant' ? bindTenantCommands(f.runtime, f.config) : bindPlatformCommands(f.platformRuntime, f.config);
    if (realm === 'tenant') await assert.rejects((noFlags as typeof tenant).execute(request, ['north'], body), { code: 'forbidden' });
    else await assert.rejects((noFlags as typeof platform).execute(request, body), { code: 'forbidden' });
    const before = f.control.captures;
    if (realm === 'tenant') await assert.rejects(tenant.execute({ admitted: false }, ['north'], body));
    else await assert.rejects(platform.execute({ admitted: false }, body));
    assert.equal(f.control.captures, before);
    f.control.enabled = false;
    const unavailable =
      realm === 'tenant' ? await tenant.availability(request, ['north'], check) : await platform.availability(request, check);
    assert.deepEqual(unavailable.checks[0].available, [false]);
    if (realm === 'tenant') await assert.rejects(tenant.prepare(request, ['north'], target), { code: 'forbidden' });
    else await assert.rejects(platform.prepare(request, target), { code: 'forbidden' });
    f.control.enabled = true;
    if (realm === 'tenant') await tenant.prepare(request, ['north'], target);
    else await platform.prepare(request, target);
    const applied = realm === 'tenant' ? await tenant.execute(request, ['north'], body) : await platform.execute(request, body);
    f.control.enabled = false;
    const replay = realm === 'tenant' ? await tenant.execute(request, ['north'], body) : await platform.execute(request, body);
    assert.equal(replay.receiptId, applied.receiptId);
    assert.equal(replay.replayed, true);
    assert.equal(f.control.captures - before, 5, 'one capture per operation, not per gate or hook');
    assert.deepEqual(f.control.roles.at(-1), realm === 'tenant' ? ['staff'] : ['manager']);
    assert.equal(f.control.scopes.at(-1), realm === 'tenant' ? 'north' : null);
  }
  assert.equal(f.control.handles, 2);
});

test('tenant public intake captures only the admitted placement, with no visitor identity from submission tokens', async (t) => {
  const f = await tenantFixture(t);
  for (const address of ['north-public-address-AAAAAAAA', undefined]) {
    const name = address ? 'tenant' : 'platform';
    const body = { form: 'apply', address, input: { name }, submission: `public-flags-${name}-0001` };
    f.control.enabled = false;
    await assert.rejects(f.intake.submit(body), { code: 'forbidden' });
    f.control.enabled = true;
    const applied = await f.intake.submit(body);
    f.control.enabled = false;
    const replay = await f.intake.submit(body);
    assert.equal(replay.receiptId, applied.receiptId);
    assert.equal(replay.replayed, true);
    assert.equal(f.control.scopes.at(-1), address ? 'north' : null);
    assert.deepEqual(f.control.roles.at(-1), []);
  }
  assert.equal(f.control.handles, 2);
  assert.equal(f.control.captures, 6);
});

test('unconfigured intake flags preserve transactional rerouting after address rotation', async (t) => {
  for (const bridge of [false, true])
    await t.test(bridge ? 'installed bridge returns undefined' : 'no capture callback', async (t) => {
      const f = await tenantFixture(t, false);
      let captures = 0,
        rotated = false;
      const intake = bindTenantIntake({
        app: f.app,
        reader: f.sourceReader,
        writer: f.writer,
        deployment: 'flags-generation',
        maxLifetimeMs: 5000,
        now: () => 1000,
        column: 'address',
        ...f.config,
        ...(bridge
          ? {
              captureFlags: () => {
                captures++;
                return undefined;
              },
            }
          : {}),
      });
      f.retire.unshift(intake.retire);
      f.engine.intercept(t, {
        match: (statement) => !statement.writer && statement.sql.includes('address') && statement.sql.includes('LIMIT 2'),
        after: () => {
          if (rotated) return;
          rotated = true;
          f.engine.sqlite().prepare("UPDATE dealer SET address = 'rotated-address-BBBBBBBBB' WHERE id = 'north'").run();
        },
      });
      const result = await intake.submit({
        form: 'apply',
        address: 'north-public-address-AAAAAAAA',
        input: { name: 'moved' },
        submission: 'unconfigured-moved-0001',
      });
      assert.equal(rotated, true);
      assert.equal(result.status, 'applied');
      assert.equal(captures, bridge ? 1 : 0, 'no recapture on the second writer attempt');
      assert.equal(f.control.handles, 1);
      assert.deepEqual(await f.engine.all("SELECT id FROM item WHERE id = 'public-moved'"), []);
      assert.deepEqual(await f.engine.all('SELECT id FROM triage'), [{ id: 'public-moved' }]);
      assert.deepEqual(await f.engine.all(`SELECT realm, tenant_id FROM "${journal.receipt}"`), [{ realm: 'platform', tenant_id: '' }]);
    });
});

test('absent, undefined and forged intake readers cannot bypass a command gate', async (t) => {
  for (const mode of ['absent', 'undefined', 'forged'] as const)
    await t.test(mode, async (t) => {
      const f = await tenantFixture(t);
      const intake = bindTenantIntake({
        app: f.app,
        reader: f.sourceReader,
        writer: f.writer,
        deployment: 'flags-generation',
        maxLifetimeMs: 5000,
        now: () => 1000,
        column: 'address',
        ...f.config,
        ...(mode === 'absent' ? {} : { captureFlags: () => (mode === 'undefined' ? undefined : { get: () => true }) }),
      });
      f.retire.unshift(intake.retire);
      await assert.rejects(
        intake.submit({
          form: 'apply',
          address: 'north-public-address-AAAAAAAA',
          input: { name: 'blocked' },
          submission: 'missing-intake-flags-0001',
        }),
        { code: 'forbidden' },
      );
      assert.equal(f.control.handles, 0);
      assert.deepEqual(await f.engine.all("SELECT id FROM item WHERE id = 'public-blocked'"), []);
      assert.deepEqual(await f.engine.all('SELECT id FROM triage'), []);
      assert.deepEqual(await f.engine.all(`SELECT realm FROM "${journal.receipt}"`), []);
    });
});

test('intake cannot reuse one tenant snapshot after placement moves; the next request captures the new destination', async (t) => {
  const f = await tenantFixture(t);
  const scopes: Array<string | null> = [];
  const intake = bindTenantIntake({
    app: f.app,
    reader: f.sourceReader,
    writer: f.writer,
    deployment: 'flags-generation',
    maxLifetimeMs: 5000,
    now: () => 1000,
    column: 'address',
    ...f.config,
    async captureFlags(_actor, placement) {
      scopes.push(placement.tenantId);
      if (scopes.length === 1) await f.engine.exec("UPDATE dealer SET address = 'rotated-address-BBBBBBBBB' WHERE id = 'north'");
      return reader(true);
    },
  });
  f.retire.unshift(intake.retire);
  const body = { form: 'apply', address: 'north-public-address-AAAAAAAA', input: { name: 'moved' }, submission: 'moved-intake-flags-0001' };
  await assert.rejects(intake.submit(body), { code: 'temporarily_unavailable' });
  assert.deepEqual(scopes, ['north']);
  assert.equal(f.control.handles, 0);
  assert.deepEqual(await f.engine.all("SELECT id FROM item WHERE id = 'public-moved'"), []);
  assert.deepEqual(await f.engine.all('SELECT id FROM triage'), []);
  assert.deepEqual(await f.engine.all(`SELECT realm FROM "${journal.receipt}"`), []);
  await intake.submit(body);
  assert.deepEqual(scopes, ['north', null]);
  assert.equal(f.control.handles, 1);
  assert.deepEqual(await f.engine.all('SELECT id FROM triage'), [{ id: 'public-moved' }]);
  assert.deepEqual(await f.engine.all(`SELECT realm, tenant_id FROM "${journal.receipt}"`), [{ realm: 'platform', tenant_id: '' }]);
});

test('tenant job attempts capture after real anchor admission with service roles and retain replay while disabled', async (t) => {
  const f = await tenantFixture(t);
  const event = defineEvent('item.changed', shape({ id: text() }));
  const registry = defineCommands({
    ...f.config.registry,
    emit: defineCommand({
      source: 'main',
      target: 'item',
      output: shape({ id: text() }),
      events: { changed: defineEventProjection(event, (value: { id: string }) => value) },
      handle() {
        return { id: 'row' };
      },
    }),
  });
  const module = capturedJobModule(
    defineJobs(
      {
        tenantJob: defineJob({
          on: { event, command: 'emit' },
          command: 'change',
          runAs: 'tenant-clock',
          schedule: () => ({ key: { id: 'row' } }),
        }),
        platformJob: defineJob({
          on: { event, command: 'emit' },
          command: 'review',
          runAs: 'platform-clock',
          schedule: () => ({ key: { id: 'row' } }),
        }),
      },
      { principals: { 'tenant-clock': { roles: ['staff'] }, 'platform-clock': { roles: ['manager'] } }, store: { namespace: 'flag-jobs' } },
    ),
  );
  const jobs = bindTenantJobs({
    app: f.app,
    reader: f.sourceReader,
    writer: f.writer,
    deployment: 'flags-generation',
    registry,
    resultReferences: { ...f.config.resultReferences, emit: () => [] },
    module,
    target: { sqlite: f.engine.path! },
    now: () => 1000,
    captureFlags(principal) {
      assert.equal(principal.realm, 'service');
      assert.equal(principal.tenantId, 'north');
      assert.deepEqual(principal.roles, principal.place === 'tenant' ? ['staff'] : ['manager']);
      return f.captureFlags(principal);
    },
  });
  f.retire.unshift(jobs.retire);
  const handlers = jobHandlers({ module: jobs.module, appId: f.app.id, bind: jobs.bind });
  for (const job of ['tenantJob', 'platformJob']) {
    const context = (attempt: number): JobContext => ({
      jobId: `${job}-001`,
      job,
      version: 1,
      attempt,
      maxAttempts: 3,
      provenance: {
        appId: f.app.id,
        tenantId: 'north',
        actorId: 'original-member',
        causationId: `${job}-event`,
        correlationId: 'correlation-001',
      },
      signal,
      now: () => 1000,
      cancelRequested: async () => false,
      grant: { audience: 'mistri.jobs', appId: f.app.id, job, version: 1, expiresAt: 6000 },
    });
    const run = async (attempt: number) => {
      const ctx = context(attempt);
      assert.equal(await jobs.admit({ audience: 'mistri.jobs', ...ctx }), true);
      return handlers[job].handle(ctx, { key: { id: 'row' }, input: {} });
    };
    const before = f.control.captures;
    await assert.rejects(async () => handlers[job].handle(context(1), { key: { id: 'row' }, input: {} }));
    assert.equal(f.control.captures, before, 'unadmitted attempt does not evaluate');
    f.control.enabled = false;
    await assert.rejects(run(1), { code: 'rejected' });
    f.control.enabled = true;
    const applied = await run(2);
    f.control.enabled = false;
    assert.deepEqual(await run(3), { ...(applied as object), replayed: true });
    assert.equal(f.control.captures - before, 3);
  }
  assert.equal(f.control.handles, 2);
});
