import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { provisionSqlitePublicPlacementJournal } from '../packages/mistri/src/adapters/commands/publicPlacementJournal.js';
import { CommandTransactionFailure, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { createAppResources } from '../packages/mistri/src/server/app/appResources.js';
import type { RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { defineCommand, defineCommands, type BusinessCommandContext } from '../packages/mistri/src/server/commands/businessCommands.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { literal, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { parseSubmission } from '../packages/mistri/src/server/commands/formHttp.js';
import {
  createPublicPlacementBindingIssuer,
  PublicPlacementBindingError,
} from '../packages/mistri/src/server/forms/publicPlacementBinding.js';
import {
  AppRowPolicyDefinitionError,
  defineAppRowPolicy,
  type AppRowPolicy,
  type PublicFormAdmission,
} from '../packages/mistri/src/server/policy/appRowPolicy.js';
import { createAppPolicyDeployment } from '../packages/mistri/src/server/policy/appPolicyDeployment.js';
import {
  bindPolicyPublicPlacement,
  bindPolicyPublicPlacementRecovery,
  type PolicyPublicPlacementOptions,
  type TrustedPublicPlacementSelection,
} from '../packages/mistri/src/server/policy/policyPublicPlacement.js';
import { createPolicyDb } from '../packages/mistri/src/server/policy/policyDb.js';
import { parseTestApp } from './support/commandCatalog.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

const input = { name: { label: 'Name', type: 'text' }, dealer: { label: 'Dealer', type: 'text' } } as const;
const selected = (tenant = 'north'): TrustedPublicPlacementSelection => ({
  appId: 'site',
  tenant,
  host: `${tenant}.example.com`,
  origin: `https://${tenant}.example.com`,
});
const body = (placement: { binding: string; submission: string }, dealer = 'north', name = 'Visitor') => ({
  input: { name, dealer },
  submission: placement.submission,
  placement: { version: 1, binding: placement.binding },
});
const code = (code: string, outcome?: string) => (error: unknown) => {
  assert.ok(error instanceof BusinessCommandExecutionError || error instanceof PublicPlacementBindingError);
  assert.equal(error.code, code);
  if (outcome !== undefined) {
    assert.ok(error instanceof BusinessCommandExecutionError);
    assert.equal(error.outcome, outcome);
  }
  return true;
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-placed-intake-')),
    file = join(directory, 'source.db');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE dealer(id TEXT PRIMARY KEY NOT NULL, active INTEGER NOT NULL);
    CREATE TABLE storefront(dealer TEXT PRIMARY KEY NOT NULL REFERENCES dealer(id), published INTEGER NOT NULL);
    CREATE TABLE lead(id INTEGER PRIMARY KEY, dealer TEXT NOT NULL REFERENCES dealer(id), name TEXT NOT NULL);
    INSERT INTO dealer VALUES('north',1),('south',1);
    INSERT INTO storefront VALUES('north',1),('south',1);`);
  provisionSqlitePublicPlacementJournal(file);
  migrateSqliteCommandJournal(file);
  const adapter = new SqliteAdapter(file),
    mapped = createAppResources(adapter, await adapter.introspect());
  const resources: RuntimeResources = {
    ...mapped,
    connections: ['data'],
    connectionFor: () => 'data',
    forConnection: () => mapped.adapter,
    toLogicalAt: (table) => table,
  };
  const app = parseTestApp(
    {
      id: 'site',
      name: 'Site',
      sources: { main: { connection: 'data' } },
      auth: { rows: 'policy', roles: { staff: { read: true } } },
      resources: { dealer: {}, storefront: {}, lead: { access: 'write' } },
      views: {
        leads: { kind: 'list', from: 'lead' },
        contact: { kind: 'form', public: true, label: 'Contact', command: { id: 'contact', version: 1, input } },
      },
      home: 'leads',
      nav: ['leads'],
    },
    'placed intake',
  );
  const control = {
    calls: 0,
    resolves: 0,
    now: Date.parse('2026-09-30T12:00:00Z'),
    reference: 'LEAD-001',
    handle: undefined as ((context: BusinessCommandContext) => Promise<void>) | undefined,
    afterResolve: undefined as ((value: PublicFormAdmission) => void | Promise<void>) | undefined,
    references: [] as readonly { table: string; key: Record<string, string | number> }[],
  };
  const registry = defineCommands({
    contact: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'lead',
      public: true,
      read: ['dealer'],
      input,
      output: shape({ reference: text(), message: literal('Thank you') }),
      async handle(context, value) {
        control.calls++;
        assert.deepEqual(context.actor, { id: 'public:contact', appId: 'site', roles: [], kind: 'public', form: 'contact' });
        assert.equal('tenant' in context, false);
        assert.equal('anchors' in context, false);
        assert.equal('policyDb' in context, false);
        const dealers = await context.tx.query({ table: 'dealer', limit: 10, offset: 0 });
        assert.equal(dealers.rows.length, 1);
        assert.deepEqual(context.placement, { tenantId: dealers.rows[0].id });
        assert.ok(Object.isFrozen(context.placement));
        assert.deepEqual(Object.keys(context.placement!), ['tenantId']);
        await context.tx.insert({ table: 'lead', values: { dealer: value.dealer, name: value.name } });
        await control.handle?.(context);
        return { reference: control.reference, message: 'Thank you' as const };
      },
    }),
  });
  const policy: AppRowPolicy = {
    appId: app.id,
    resolveRows: () => ({}),
    resolvePublicRows: () => ({}),
    resultReferences: {},
    publicForms: {
      contact: {
        kind: 'placement',
        source: 'main',
        resultReferences: (result) => {
          assert.ok(Object.isFrozen(result));
          return control.references;
        },
        async resolvePlacement(intent, { db }) {
          control.resolves++;
          assert.ok(Object.isFrozen(intent));
          const dealer = await db.dealer.find({ id: intent.tenant });
          const site = await db.storefront.find({ dealer: intent.tenant });
          if (!dealer || dealer.active !== 1 || !site || site.published !== 1) throw new Error('not published');
          const value: PublicFormAdmission = {
            rows: {
              dealer: { groups: [[{ column: 'id', op: '=', value: intent.tenant }]] },
              storefront: { groups: [[{ column: 'dealer', op: '=', value: intent.tenant }]] },
              lead: { groups: [[{ column: 'dealer', op: '=', value: intent.tenant }]] },
            },
            anchors: [
              { table: 'dealer', key: { id: intent.tenant }, expected: { active: 1 } },
              { table: 'storefront', key: { dealer: intent.tenant }, expected: { published: 1 } },
            ],
          };
          await control.afterResolve?.(value);
          return value;
        },
      },
    },
  };
  const issuer = createPublicPlacementBindingIssuer(
    { issuerId: 'site-family', activeKey: 'one', keys: [{ id: 'one', secret: randomBytes(32).toString('base64url'), issueFrom: 0 }] },
    () => control.now,
  );
  const options: PolicyPublicPlacementOptions = {
    app,
    policy,
    resources,
    registry,
    form: 'contact',
    sourceConnections: new Map([['main', 'data']]),
    sourceIdentity: 'original-database',
    epoch: 'epoch-1',
    formRevision: 'contract-1',
    issuer,
    policyContext: Object.freeze({ db: createPolicyDb(resources) }),
    writableConnection: () => true,
  };
  const bindings: Array<{ retire(): Promise<void> }> = [];
  const bind = (overrides: Partial<PolicyPublicPlacementOptions> = {}) => {
    const value = bindPolicyPublicPlacement({ ...options, ...overrides });
    bindings.push(value);
    return value;
  };
  const recoverOnly = (sources = new Map([['original-database', mapped.adapter]])) => {
    const value = bindPolicyPublicPlacementRecovery({ appId: app.id, form: 'contact', issuer, receiptSources: sources });
    bindings.push(value);
    return value;
  };
  t.after(async () => {
    await Promise.all(bindings.map((value) => value.retire()));
    await adapter.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    bind,
    recoverOnly,
    control,
    db,
    adapter,
    mapped,
    resources,
    options,
    policy,
    count: () => db.prepare('SELECT COUNT(*) AS n FROM lead').get()!.n,
  };
}

test('two placed dealers insert within their admitted rows; identical retry is one insert and a narrow receipt', async (t) => {
  const f = await fixture(t),
    intake = f.bind();
  const north = await intake.prepare(selected()),
    south = await intake.prepare(selected('south'));
  const first = await intake.submit(selected(), body(north));
  assert.deepEqual(Object.keys(first), ['reference', 'receipt']);
  assert.equal(first.reference, 'LEAD-001');
  assert.deepEqual(await intake.submit(selected(), body(north)), first);
  await intake.submit(selected('south'), body(south, 'south'));
  assert.equal(f.count(), 2);
  assert.equal(f.control.calls, 2);
  assert.deepEqual(
    f.db
      .prepare('SELECT dealer FROM lead ORDER BY id')
      .all()
      .map((row) => row.dealer),
    ['north', 'south'],
  );
  await assert.rejects(intake.submit(selected(), body(north, 'north', 'Changed')), code('idempotency_conflict', 'unknown'));
  assert.equal(f.count(), 2);
  assert.deepEqual(await intake.recover(north.binding, north.submission), first);
});

test('foreign input cannot transfer ownership, and a caught mutation poisons the transaction', async (t) => {
  const f = await fixture(t),
    intake = f.bind();
  const foreign = await intake.prepare(selected());
  await assert.rejects(intake.submit(selected(), body(foreign, 'south')), code('forbidden', 'not_applied'));
  assert.equal(f.count(), 0);
  f.control.handle = async (context) => {
    await context.tx.update({ table: 'lead', key: { id: 1 }, values: { name: 'changed' } }).catch(() => {});
  };
  const caught = await intake.prepare(selected());
  await assert.rejects(intake.submit(selected(), body(caught)), code('forbidden', 'not_applied'));
  assert.equal(f.count(), 0);
});

test('prepare is not a reservation: fresh resolution and writer-locked anchors both refuse unpublication', async (t) => {
  const f = await fixture(t),
    intake = f.bind(),
    prepared = await intake.prepare(selected());
  f.db.exec("UPDATE storefront SET published=0 WHERE dealer='north'");
  await assert.rejects(intake.submit(selected(), body(prepared)), code('forbidden', 'unknown'));
  f.db.exec("UPDATE storefront SET published=1 WHERE dealer='north'");
  const original = commandsOf(f.mapped.adapter).publicPlacementCommandTransaction!.bind(f.mapped.adapter);
  f.mapped.adapter.publicPlacementCommandTransaction = (rows, admission, run) => {
    f.db.exec("UPDATE storefront SET published=0 WHERE dealer='north'");
    return original(rows, admission, run);
  };
  const raced = f.bind();
  await assert.rejects(raced.submit(selected(), body(prepared)));
  assert.equal(f.control.calls, 0);
  assert.equal(f.count(), 0);
});

test('host remap, epoch and source changes refuse execution; recovery retains the original owner without a handler', async (t) => {
  const f = await fixture(t),
    first = f.bind(),
    prepared = await first.prepare(selected());
  const receipt = await first.submit(selected(), body(prepared));
  await first.retire();
  const next = f.bind({ epoch: 'epoch-2', sourceIdentity: 'replacement-database' });
  await assert.rejects(next.submit(selected(), body(prepared)), code('placement_changed'));
  await assert.rejects(next.submit({ ...selected(), tenant: 'south' }, body(prepared)), code('placement_changed'));
  await assert.rejects(next.recover(prepared.binding, prepared.submission), code('temporarily_unavailable', 'unknown'));
  // Neither current eligibility nor any command registry participates in recovery.
  f.db.exec('DROP TABLE lead; DROP TABLE storefront; DROP TABLE dealer;');
  const recovery = f.recoverOnly();
  assert.deepEqual(await recovery.recover(prepared.binding, prepared.submission), receipt);
  await assert.rejects(recovery.recover(prepared.binding, 'different-submission'), code('forbidden'));
});

test('expired execution remains recoverable, while an authentic absent receipt is only not_found', async (t) => {
  const f = await fixture(t),
    intake = f.bind(),
    prepared = await intake.prepare(selected()),
    absent = await intake.prepare(selected());
  const receipt = await intake.submit(selected(), body(prepared));
  f.control.now += 2 * 60 * 60 * 1000;
  await assert.rejects(intake.submit(selected(), body(prepared)), code('placement_expired'));
  assert.deepEqual(await intake.recover(prepared.binding, prepared.submission), receipt);
  assert.deepEqual(await intake.recover(absent.binding, absent.submission), { status: 'not_found' });
  f.control.now += 22 * 60 * 60 * 1000;
  await assert.rejects(intake.recover(prepared.binding, prepared.submission), code('forbidden'));
  assert.equal(f.control.calls, 1);
});

test('retirement stops admissions, drains the writer and rolls back an accepted paused handler', async (t) => {
  const f = await fixture(t),
    intake = f.bind(),
    prepared = await intake.prepare(selected());
  const entered = deferred(),
    release = deferred();
  f.control.handle = async () => {
    entered.resolve();
    await release.promise;
  };
  const work = intake.submit(selected(), body(prepared));
  const refused = assert.rejects(work, code('temporarily_unavailable', 'unknown'));
  await entered.promise;
  let drained = false;
  const retirement = intake.retire();
  assert.equal(intake.retire(), retirement);
  void retirement.then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  await assert.rejects(intake.prepare(selected()), code('temporarily_unavailable', 'unknown'));
  await assert.rejects(intake.submit(selected(), body(prepared)), code('temporarily_unavailable', 'unknown'));
  release.resolve();
  await refused;
  await retirement;
  assert.equal(f.count(), 0);
});

test('retirement suppresses late preparation and late receipt reads and drains both', async (t) => {
  const f = await fixture(t),
    intake = f.bind();
  const entered = deferred(),
    release = deferred();
  f.control.afterResolve = async () => {
    entered.resolve();
    await release.promise;
  };
  const preparing = assert.rejects(intake.prepare(selected()), code('temporarily_unavailable', 'unknown'));
  await entered.promise;
  let drained = false;
  const retiring = intake.retire().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  release.resolve();
  await preparing;
  await retiring;
  f.control.afterResolve = undefined;
  const writer = f.bind(),
    prepared = await writer.prepare(selected());
  await writer.submit(selected(), body(prepared));
  const readEntered = deferred(),
    readRelease = deferred();
  const original = commandsOf(f.mapped.adapter).publicPlacementReceipt!.bind(f.mapped.adapter);
  f.mapped.adapter.publicPlacementReceipt = async (owner, key) => {
    const value = await original(owner, key);
    readEntered.resolve();
    await readRelease.promise;
    return value;
  };
  const recovery = f.recoverOnly();
  const reading = assert.rejects(recovery.recover(prepared.binding, prepared.submission), code('temporarily_unavailable', 'unknown'));
  await readEntered.promise;
  let readDrained = false;
  const readRetiring = recovery.retire().then(() => {
    readDrained = true;
  });
  await Promise.resolve();
  assert.equal(readDrained, false);
  readRelease.resolve();
  await reading;
  await readRetiring;
});

test('lost commit acknowledgement stays unknown and both exact retry and receipt-only recovery find the commit', async (t) => {
  const f = await fixture(t);
  const original = commandsOf(f.mapped.adapter).publicPlacementCommandTransaction!.bind(f.mapped.adapter);
  let lose = true;
  f.mapped.adapter.publicPlacementCommandTransaction = async (rows, admission, run) => {
    const result = await original(rows, admission, run);
    if (lose) {
      lose = false;
      throw new CommandTransactionFailure(new Error('lost acknowledgement'), 'unknown');
    }
    return result;
  };
  const intake = f.bind(),
    prepared = await intake.prepare(selected());
  await assert.rejects(intake.submit(selected(), body(prepared)), code('temporarily_unavailable', 'unknown'));
  const recovered = await intake.recover(prepared.binding, prepared.submission);
  assert.deepEqual(await intake.submit(selected(), body(prepared)), recovered);
  assert.equal(f.control.calls, 1);
  assert.equal(f.count(), 1);
});

test('empty result references and bounded public reference are checked before receipt commit', async (t) => {
  const f = await fixture(t),
    intake = f.bind(),
    prepared = await intake.prepare(selected());
  f.control.references = [{ table: 'lead', key: { id: 1 } }];
  await assert.rejects(intake.submit(selected(), body(prepared)), code('forbidden', 'not_applied'));
  assert.equal(f.count(), 0);
  f.control.references = [];
  f.control.reference = 'x'.repeat(65);
  await assert.rejects(intake.submit(selected(), body(prepared)), code('invalid_result'));
  assert.equal(f.count(), 0);
  assert.deepEqual(await intake.recover(prepared.binding, prepared.submission), { status: 'not_found' });
});

test('the placed envelope cannot supply source, intent, actor or scope and cannot downgrade to legacy', async (t) => {
  const f = await fixture(t),
    intake = f.bind(),
    prepared = await intake.prepare(selected());
  for (const field of ['sourceIdentity', 'tenant', 'actor', 'rows', 'command']) {
    await assert.rejects(intake.submit(selected(), { ...body(prepared), [field]: 'forged' }), code('invalid_input', 'unknown'));
  }
  await assert.rejects(intake.submit(selected(), { input: {}, submission: prepared.submission }), code('invalid_input', 'unknown'));
  await assert.rejects(intake.submit(selected('south'), body(prepared)), code('forbidden'));
  await assert.rejects(intake.submit({ ...selected(), appId: 'other' }, body(prepared)), code('forbidden'));
  assert.throws(() => parseSubmission(body(prepared)));
  assert.deepEqual(parseSubmission({ input: {}, submission: prepared.submission }), {
    input: {},
    submission: prepared.submission,
    extra: {},
  });
  assert.equal(f.control.calls, 0);
});

test('source pins, public-read hook and placed enrollment are mandatory startup contracts', async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.bind({ sourceIdentity: '' }), AppRowPolicyDefinitionError);
  assert.throws(() => f.bind({ writableConnection: () => false }), AppRowPolicyDefinitionError);
  assert.throws(() => f.bind({ sourceConnections: new Map([['main', 'other']]) }), AppRowPolicyDefinitionError);
  const { resolvePublicRows: _unused, ...missingHook } = f.policy;
  assert.throws(() => defineAppRowPolicy(missingHook), AppRowPolicyDefinitionError);
  const captured = defineAppRowPolicy(f.policy);
  assert.ok(Object.isFrozen(captured.publicForms?.contact));
  assert.equal(f.control.resolves, 0);
  const fixed = defineAppRowPolicy({
    appId: 'site',
    resolveRows: () => ({}),
    publicForms: { contact: { rows: { dealer: true }, resultReferences: () => [] } },
  });
  assert.deepEqual(Object.keys(fixed.publicForms!.contact), ['rows', 'resultReferences']);
  let released = false;
  await assert.rejects(
    createAppPolicyDeployment({
      app: f.options.app,
      policy: f.policy,
      commands: { registry: f.options.registry, writableConnection: () => true },
      verifySession: async () => null,
      acquire: async () => ({
        resources: f.resources,
        sourceConnections: f.options.sourceConnections,
        release: () => {
          released = true;
        },
      }),
    }),
    AppRowPolicyDefinitionError,
  );
  assert.equal(released, true);
  assert.equal(f.control.resolves, 0);
});

test('synchronous admission and submitted answers are captured before queued caller mutations', async (t) => {
  const f = await fixture(t);
  const original = f.policy.publicForms!.contact;
  assert.ok('kind' in original);
  const policy: AppRowPolicy = {
    ...f.policy,
    publicForms: {
      contact: {
        ...original,
        resolvePlacement(intent) {
          const admission: PublicFormAdmission = {
            rows: {
              dealer: { groups: [[{ column: 'id', op: '=', value: intent.tenant }]] },
              lead: { groups: [[{ column: 'dealer', op: '=', value: intent.tenant }]] },
            },
            anchors: [{ table: 'dealer', key: { id: intent.tenant }, expected: { active: 1 } }],
          };
          queueMicrotask(() => {
            Object.assign(admission.rows, { dealer: true, lead: true });
            Object.assign(admission.anchors[0].expected, { active: 0 });
          });
          return admission;
        },
      },
    },
  };
  const intake = f.bind({ policy }),
    prepared = await intake.prepare(selected()),
    request = body(prepared);
  const work = intake.submit(selected(), request);
  request.input.dealer = 'south';
  await work;
  assert.equal(f.db.prepare('SELECT dealer FROM lead').get()!.dealer, 'north');
  const foreign = await intake.prepare(selected());
  await assert.rejects(intake.submit(selected(), body(foreign, 'south')), code('forbidden', 'not_applied'));
  assert.equal(f.count(), 1);
});

test('placed policy captures functions without invoking them and rejects mixed/extra fields and proxy callbacks', async (t) => {
  const f = await fixture(t),
    original = f.policy.publicForms!.contact;
  assert.ok('kind' in original);
  for (const entry of [
    { ...original, rows: {} },
    { ...original, extra: true },
    { ...original, kind: 'other' },
    { ...original, resolvePlacement: new Proxy(original.resolvePlacement, {}) },
  ]) {
    assert.throws(() => defineAppRowPolicy({ ...f.policy, publicForms: { contact: entry } } as AppRowPolicy), AppRowPolicyDefinitionError);
  }
  let read = 0;
  assert.throws(
    () =>
      defineAppRowPolicy({
        ...f.policy,
        publicForms: {
          contact: {
            ...original,
            get resolvePlacement() {
              read++;
              return original.resolvePlacement;
            },
          },
        },
      }),
    AppRowPolicyDefinitionError,
  );
  assert.equal(read, 0);
  assert.equal(f.control.resolves, 0);
  const intake = f.bind();
  Object.assign(original, {
    resolvePlacement() {
      throw new Error('replacement must not run');
    },
  });
  const prepared = await intake.prepare(selected());
  await intake.submit(selected(), body(prepared));
  assert.equal(f.count(), 1);
});

test('malformed resolver data, proxies, accessors and custom thenables cannot mint a placement', async (t) => {
  const f = await fixture(t),
    original = f.policy.publicForms!.contact;
  assert.ok('kind' in original);
  let touched = 0;
  const bad: unknown[] = [
    {
      // eslint-disable-next-line unicorn/no-thenable -- Deliberate hostile resolver output; it must never be assimilated.
      then() {
        touched++;
      },
    },
    {
      get rows() {
        touched++;
        return {};
      },
      anchors: [],
    },
    new Proxy(
      {},
      {
        ownKeys() {
          touched++;
          return [];
        },
      },
    ),
    { rows: {}, anchors: [] },
    { rows: { dealer: true, lead: true }, anchors: [{ table: 'dealer', key: { id: 'north' }, expected: {} }] },
    { rows: { dealer: true, lead: true }, anchors: [{ table: 'other-source.dealer', key: { id: 'north' }, expected: { active: 1 } }] },
  ];
  for (const value of bad) {
    const intake = f.bind({
      policy: {
        ...f.policy,
        publicForms: {
          contact: {
            ...original,
            resolvePlacement: () => value as PublicFormAdmission,
          },
        },
      },
    });
    await assert.rejects(intake.prepare(selected()), code('forbidden', 'unknown'));
  }
  assert.equal(touched, 0);
  assert.equal(f.control.calls, 0);
});

test('result-reference attestation is also enforced on execution replay', async (t) => {
  const f = await fixture(t),
    intake = f.bind(),
    prepared = await intake.prepare(selected());
  const receipt = await intake.submit(selected(), body(prepared));
  f.control.references = [{ table: 'lead', key: { id: 1 } }];
  await assert.rejects(intake.submit(selected(), body(prepared)), code('forbidden', 'unknown'));
  assert.deepEqual(await intake.recover(prepared.binding, prepared.submission), receipt);
  assert.equal(f.control.calls, 1);
  assert.equal(f.count(), 1);
});
