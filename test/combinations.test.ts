/** The combinations fixture, run: each case pairs two features that are
 * independently covered elsewhere, starts the real CLI over the composed App,
 * and proves both features still work *together* — reads still read, the
 * command still runs, the exposure is still the one the App declared.
 *
 * Every 0.5.x defect this exists for passed its own feature's tests and failed
 * only where two features met, so a case that proves one feature alone has
 * missed the point. test/support/combinations.ts says what a part is and why
 * this is not a sample App. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { createNativeAccount } from '../packages/mistri/src/server/auth/authAccounts.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { loadBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { provisionStores, type ProvisionStoresOptions, type StoresApp } from '../packages/mistri/src/server/maintenance.js';
import { pathToFileURL } from 'node:url';
import { issueSqliteApiCommandToken } from '../packages/mistri/src/server/auth/sqliteApiTokenMaintenance.js';
import { captureAuthStoreExclusion } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { spawn } from 'node:child_process';
import { childEnv, cliArgs, freePort, ROOT, runCli, SESSION_SECRET, serveApi } from './appApiCli.js';
import { scratch } from './support/scratch.js';
import { policyServer } from './support/policyServer.js';
import { draftPolicyServer } from './support/signedInDrafts.js';
import {
  apiReads,
  apiTouchCommand,
  auth,
  base,
  COMBO_STORE,
  inFeature,
  layoutDashboard,
  merge,
  platformRealm,
  RATE_ROWS,
  RATE_TABLE,
  seedCombination,
  settleJob,
  tallyCommand,
  tenancyWithRowPolicy,
  tenancy,
  touchAction,
  touchCommand,
  workflowPage,
  writeCombination,
  type Part,
} from './support/combinations.js';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { tokenCli } from './appApiCli.js';
import { VALIDATE } from './support/validation.js';

const storeId = '9f2c4d17-5b83-4e6a-9c02-7d41f8e3a5b6';

/** One combination, deployed the way an operator deploys: the App written from
 * its parts, its database seeded and journaled, a native account, a token
 * store, and the real CLI serving it. */
async function deploy(t: TestContext, part: Part) {
  const { directory, stopping } = scratch(t, 'tw-combination-');
  const business = join(directory, 'business.db'),
    authPath = join(directory, 'auth.db');
  // `auth()` names its store as a placeholder, because the path is only known
  // once the case has a directory; substituting here keeps a part pure data.
  const whole: Part = { ...part, root: JSON.parse(JSON.stringify(part.root).replaceAll('"AUTH-STORE"', JSON.stringify(authPath))) };
  seedCombination(business, whole);
  const { appDir, config, flags } = writeCombination(directory, whole, { business });
  const loaded = await loadApp(appDir, flags.includes('--commands') ? { commands: flags[flags.indexOf('--commands') + 1] } : {});
  writeFileSync(join(appDir, 'authority.lock'), loaded.authority!.report);

  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  process.env.BETTER_AUTH_SECRET = SESSION_SECRET;
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  try {
    (await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] })).close();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const accounts = new DatabaseSync(authPath);
  try {
    accounts
      .prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)')
      .run('operator', 'Operator', 'operator@example.test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'operator');
  } finally {
    accounts.close();
  }
  const exclusions = [captureAuthStoreExclusion(business)];
  provisionSqliteApiTokenStore(authPath, { appId: 'combo', storeId, exclusions });

  const registry = new Registry();
  registry.add({ id: 'data', name: 'data', url: business, writable: true, source: 'config' });
  let token: string;
  try {
    const resources = await loadAppRuntimeResources(registry, loaded.app, 'data');
    const evidence = { connectionFor: resources.connectionFor, writableConnection: () => true, transactionalConnection: () => true };
    const commandsFile = flags[flags.indexOf('--commands') + 1];
    // No registry is a combination in its own right, and an empty one is how
    // a token is issued for an App that runs no command.
    const declared = flags.includes('--commands') ? await loadBusinessCommands(commandsFile) : {};
    token = issueSqliteApiCommandToken(
      authPath,
      loaded.app,
      resources.schema,
      declared,
      evidence,
      {
        storeId,
        exclusions,
        subjectId: 'operator',
        actorId: 'operator',
        roles: ['operator'],
        label: 'combination',
        expiresAt: Date.now() + 600_000,
      },
      Date.now(),
    ).token;
  } finally {
    await registry.closeAll();
  }

  const commandsFlag = flags.includes('--commands') ? { commands: flags[flags.indexOf('--commands') + 1] } : {};
  const served = await serveApi(
    t,
    { config, appDir, ...commandsFlag },
    'combo',
    flags.filter((flag, index) => flag !== '--commands' && flags[index - 1] !== '--commands'),
  );
  stopping(async () => {
    if (served.child.exitCode === null && served.child.signalCode === null) served.child.kill('SIGTERM');
    await served.closed;
  });
  await served.started;
  return {
    base: served.base,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    revision: (id: string) => {
      const check = new DatabaseSync(business);
      try {
        return Number(check.prepare('SELECT version FROM item WHERE id = ?').get(id)!.version);
      } finally {
        check.close();
      }
    },
  };
}

/** Reads and a command registry in one App. The reading half is the `api`
 * block; the running half is `--commands`. Each is covered alone elsewhere;
 * what is proved here is that declaring both leaves both working. */
test('combination: api reads × a command registry', async (t) => {
  const f = await deploy(t, merge(base({ write: true }), auth('AUTH-STORE'), apiReads(), touchCommand(), apiTouchCommand()));

  const list = await fetch(`${f.base}/item?sort=id`, { headers: f.headers });
  const listed = (await list.json()) as { items: Array<Record<string, unknown>> };
  assert.equal(list.status, 200, JSON.stringify(listed));
  assert.deepEqual(
    listed.items.map((row) => row.id),
    ['north-1', 'north-2', 'south-1'],
  );

  const before = f.revision('north-1');
  const ran = await fetch(`${f.base}/item/north-1/commands/touch/v1`, {
    method: 'POST',
    headers: { ...f.headers, 'if-match': `"${before}"`, 'idempotency-key': 'combination-reads-0001' },
    body: '{}',
  });
  const answer = (await ran.json()) as Record<string, unknown>;
  assert.equal(ran.status, 200, JSON.stringify(answer));
  assert.equal(f.revision('north-1'), before + 1);
});

/** A narrowed resource (Preview) × the api block × a command on its table. The narrowed resource is a second name for
 * the table that `api.resources`, the token's catalog and the command host all see; what is proved here is that its
 * conditions hold through the real server — its list and item stand on them — while the table's own resource and the
 * command that writes it work as they did. */
test('combination: a narrowed resource × api reads × a command on its table', async (t) => {
  const narrowed: Part = {
    root: {
      resources: { fresh: { physical: 'item', query: 'status = new' } },
      api: { resources: { fresh: { fields: ['id', 'name', 'status'], sorts: ['id'] } } },
    },
    ddl: ["UPDATE item SET status = 'done' WHERE id = 'south-1'"],
  };
  const f = await deploy(t, merge(base({ write: true }), auth('AUTH-STORE'), apiReads(), touchCommand(), apiTouchCommand(), narrowed));
  const ids = async (path: string) => {
    const answer = await fetch(`${f.base}${path}`, { headers: f.headers });
    const body = (await answer.json()) as { items: Array<{ id: string }> };
    assert.equal(answer.status, 200, JSON.stringify(body));
    return body.items.map((row) => row.id);
  };
  assert.deepEqual(await ids('/fresh?sort=id'), ['north-1', 'north-2']);
  assert.equal((await fetch(`${f.base}/fresh/south-1`, { headers: f.headers })).status, 404, 'a row outside the query is no item');
  assert.deepEqual(await ids('/item?sort=id'), ['north-1', 'north-2', 'south-1']);

  const before = f.revision('north-1');
  const ran = await fetch(`${f.base}/item/north-1/commands/touch/v1`, {
    method: 'POST',
    headers: { ...f.headers, 'if-match': `"${before}"`, 'idempotency-key': 'combination-narrow-0001' },
    body: '{}',
  });
  assert.equal(ran.status, 200, await ran.text());
  assert.equal(f.revision('north-1'), before + 1);
  assert.deepEqual(await ids('/fresh?sort=id'), ['north-1', 'north-2']);
});

/** The same App, with the exposure declared through a feature rather than at
 * the root — the pair that shipped broken in 0.5.0, where `api.commands`
 * composed through a feature was refused although both halves passed alone. */
test('combination: api commands × feature composition', async (t) => {
  const f = await deploy(
    t,
    merge(base({ write: true }), auth('AUTH-STORE'), touchCommand(), inFeature('billing', merge(apiReads(), apiTouchCommand()))),
  );

  const list = await fetch(`${f.base}/item?sort=id`, { headers: f.headers });
  const listed = (await list.json()) as { items: Array<Record<string, unknown>> };
  assert.equal(list.status, 200, JSON.stringify(listed));
  assert.equal(listed.items.length, 3);

  const before = f.revision('south-1');
  const ran = await fetch(`${f.base}/item/south-1/commands/touch/v1`, {
    method: 'POST',
    headers: { ...f.headers, 'if-match': `"${before}"`, 'idempotency-key': 'combination-feature-0001' },
    body: '{}',
  });
  const answer = (await ran.json()) as Record<string, unknown>;
  assert.equal(ran.status, 200, JSON.stringify(answer));
  assert.equal(f.revision('south-1'), before + 1);
});

/** A command reference with no registry behind it. Each half is ordinary —
 * an App may refer to a command, and a deployment may run without commands —
 * and together they are an App whose action bar would offer a verb nothing
 * can run. The pair is proved by what the deployment does about it: it
 * refuses to start, and says which flag is missing. */
test('combination: a command reference × no registry refuses to start, by name', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tw-combination-refs-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const business = join(directory, 'business.db'),
    authPath = join(directory, 'auth.db');
  const named = (part: Part): Part => ({
    ...part,
    root: JSON.parse(JSON.stringify(part.root).replaceAll('"AUTH-STORE"', JSON.stringify(authPath))),
  });
  const refs = named(merge(base({ write: true }), auth('AUTH-STORE'), touchAction()));
  const withRegistry = named(merge(base({ write: true }), auth('AUTH-STORE'), touchAction(), touchCommand()));
  // Seeded for the half that runs commands: the journal is an operator's step
  // and its absence is a different refusal, which is not what this pair is about.
  seedCombination(business, withRegistry);
  const { appDir, config } = writeCombination(directory, refs, { business });

  const alone = await runCli(['--config', config, '--app', appDir, VALIDATE]);
  assert.notEqual(alone.code, 0, `A registry-less App with a command reference started: ${alone.out}${alone.err}`);
  assert.match(`${alone.out}${alone.err}`, /--commands/, 'The refusal must name the flag that is missing, not fail obscurely.');

  // The same App with its registry passes the same check: what is refused is
  // the pair, not the reference.
  const served = writeCombination(directory, withRegistry, { business });
  const together = await runCli(['--config', config, '--app', served.appDir, ...served.flags, VALIDATE]);
  assert.equal(together.code, 0, `${together.out}${together.err}`);
});

/** A tenant App that also exposes an `api` block. Tenancy is covered on its
 * own, and so is the `api` block; together they were the pair that stopped
 * Ignition starting at all — the tenant runtime loaded an App it could not
 * read. The proof is a deployment that starts and answers: a tenant token
 * reads its own tenant's rows through the API, and nobody else's.
 */
/** A tenant combination, deployed as an operator deploys one: the tenant
 * store with two tenants and Alice a member of north, the native accounts, a
 * token the real token CLI issues for her membership, and the real CLI
 * serving it. */
async function deployTenant(t: TestContext, part: Part) {
  const { directory, stopping } = scratch(t, 'tw-combination-tenant-');
  const business = join(directory, 'business.db'),
    authPath = join(directory, 'auth.db');
  const whole: Part = { ...part, root: JSON.parse(JSON.stringify(part.root).replaceAll('"AUTH-STORE"', JSON.stringify(authPath))) };
  seedCombination(business, whole);
  const { appDir, config, flags } = writeCombination(directory, whole, { business });

  // The tenant store, its two tenants and one membership each, as an operator
  // provisions them.
  const store = { appId: 'combo', source: { id: 'business', connection: 'data' }, storeId: COMBO_STORE };
  provisionSqliteTenantStore(business, store);
  const db = new DatabaseSync(business);
  try {
    const operations = new TransactionOperations();
    db.exec('BEGIN IMMEDIATE');
    const admin = createSqliteTenantAdministration(db, operations, store);
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putMembership({
      tenantId: 'north',
      accountId: 'alice',
      membershipId: 'm-alice',
      status: 'active',
      roles: ['operator'],
      validUntil: Date.now() + 3_600_000,
      expectedVersion: null,
    });
    await operations.finish();
    db.exec('COMMIT');
  } finally {
    db.close();
  }

  const commands = flags.includes('--commands') ? flags[flags.indexOf('--commands') + 1] : undefined;
  const loaded = await loadApp(appDir, commands ? { commands } : {});
  writeFileSync(join(appDir, 'authority.lock'), loaded.authority!.report);
  const saved = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = SESSION_SECRET;
  try {
    (await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] })).close();
  } finally {
    if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = saved;
  }
  const accounts = new DatabaseSync(authPath);
  try {
    for (const id of ['alice', 'operator']) {
      accounts
        .prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)')
        .run(id, id, `${id}@example.test`, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', null);
    }
  } finally {
    accounts.close();
  }

  // Issued by the real token CLI, bound to one membership.
  const policy = flags[flags.indexOf('--policy') + 1];
  const common = ['--app', appDir, '--config', config, '--store-id', storeId];
  const provisioned = await tokenCli(['provision', ...common]);
  assert.equal(provisioned.code, 0, provisioned.err);
  const issued = await tokenCli([
    'issue',
    ...common,
    '--tenant',
    'north',
    '--policy',
    policy,
    ...(commands ? ['--commands', commands] : []),
    '--subject',
    'alice',
    '--actor',
    'operator',
    '--role',
    'operator',
    '--label',
    'Combination',
    '--expires-at',
    new Date(Date.now() + 600_000).toISOString(),
  ]);
  assert.equal(issued.code, 0, issued.err);
  const { token } = (JSON.parse(issued.out) as { result: { token: string } }).result;

  const served = await serveApi(
    t,
    { config, appDir, ...(commands ? { commands } : {}) },
    'combo',
    flags.filter((flag, index) => flag !== '--commands' && flags[index - 1] !== '--commands'),
  );
  stopping(async () => {
    if (served.child.exitCode === null && served.child.signalCode === null) served.child.kill('SIGTERM');
    await served.closed;
  });
  await served.started;
  return { base: served.base, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } };
}

test('combination: an api block × the tenant runtime starts, and serves one tenant its own rows', async (t) => {
  const served = await deployTenant(t, merge(base({ write: true }), auth('AUTH-STORE'), apiReads(), tenancy()));
  const list = await fetch(`${served.base}/item?sort=id`, { headers: served.headers });
  const body = (await list.json()) as { items: Array<Record<string, unknown>> };
  assert.equal(list.status, 200, JSON.stringify(body));
  // North's rows, and only north's: the pair works and the boundary holds.
  assert.deepEqual(
    body.items.map((row) => row.id),
    ['north-1', 'north-2'],
  );
});

/** A command's aggregate in a tenant App under a row policy. Sums and groups
 * compile through the breakdown compiler, which reads under a scope its own
 * way (relations, not the row reader's filters); each is covered alone, and
 * what is proved here is that the tenant's bound and the policy inside it both
 * reach it: the command counts what its own `where` lists — north's `new`
 * items — and never south's row or north's archived one. */
test('combination: a command aggregate × a row policy × the tenant runtime counts only what its where reads', async (t) => {
  const served = await deployTenant(
    t,
    merge(base({ write: true }), auth('AUTH-STORE'), apiReads(), tallyCommand(), tenancyWithRowPolicy()),
  );
  const tally = async (status: string) => {
    const ran = await fetch(`${served.base}/item/commands/tally/v1`, {
      method: 'POST',
      headers: { ...served.headers, 'idempotency-key': `combination-tally-${status}` },
      body: JSON.stringify({ status }),
    });
    const answer = (await ran.json()) as { result?: Record<string, unknown> } & Record<string, unknown>;
    assert.equal(ran.status, 200, JSON.stringify(answer));
    return answer.result;
  };
  // South's new item would make three; north's archived one would make an archived group.
  assert.deepEqual(await tally('new'), { counted: 2, listed: 2, groups: 'new:2' });
  assert.deepEqual(await tally('archived'), { counted: 0, listed: 0, groups: 'new:2' });
});

/** An ordered workflow strip on a page of a tenant App. The strip is drawn
 * for plenty of Apps and tenancy is covered on its own; together they were
 * refused, and the App would not load at all. Proved where the pair lives: the
 * deployment validates, which is what `mistri check` answers, and the page the
 * App serves still carries the strip in the order the author wrote.
 */
test('combination: an ordered workflow strip × tenancy loads, and keeps its order', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tw-combination-workflow-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const business = join(directory, 'business.db'),
    authPath = join(directory, 'auth.db');
  const part = merge(base({ write: true }), auth('AUTH-STORE', { read: true, write: true }), workflowPage(), tenancy());
  const whole: Part = { ...part, root: JSON.parse(JSON.stringify(part.root).replaceAll('"AUTH-STORE"', JSON.stringify(authPath))) };
  seedCombination(business, whole);
  provisionSqliteTenantStore(business, { appId: 'combo', source: { id: 'business', connection: 'data' }, storeId: COMBO_STORE });
  const { appDir, config, flags } = writeCombination(directory, whole, { business });

  const checked = await runCli(['--config', config, '--app', appDir, ...flags, VALIDATE]);
  assert.equal(checked.code, 0, `${checked.out}${checked.err}`);

  // And the order survives the load: a strip whose steps arrive shuffled is a
  // different claim about the work than the one the author made.
  const loaded = await loadApp(appDir);
  const page = loaded.pages.find((candidate) => candidate.base === 'item');
  assert.ok(page, 'the tenant App kept no page at all');
  const section = page.sections.find((candidate) => candidate.kind === 'fields' && candidate.workflow);
  assert.ok(section && section.kind === 'fields' && section.workflow, 'the page kept no workflow strip');
  assert.equal(section.workflow.ordered, true);
  assert.deepEqual(
    section.workflow.steps.map((step) => step.value),
    ['new', 'working', 'done'],
  );
});

/** A tenant App served from its build. `mistri build` is covered, and so
 * is tenancy; together they were refused outright — the built deployment
 * carries a fact about itself that the tenant host's admission list did not
 * name, so production, which is the case a build exists for, was the one case
 * that could not start. Proved the only way that means anything: build it,
 * serve the build, and ask it something. */
test('combination: a build × tenancy serves', async (t) => {
  const { directory, stopping } = scratch(t, 'tw-combination-build-');
  const business = join(directory, 'business.db'),
    authPath = join(directory, 'auth.db');
  const part = merge(base(), auth('AUTH-STORE'), tenancy());
  const whole: Part = { ...part, root: JSON.parse(JSON.stringify(part.root).replaceAll('"AUTH-STORE"', JSON.stringify(authPath))) };
  seedCombination(business, whole);
  provisionSqliteTenantStore(business, { appId: 'combo', source: { id: 'business', connection: 'data' }, storeId: COMBO_STORE });
  const { appDir, config, flags } = writeCombination(directory, whole, { business });
  writeFileSync(join(appDir, 'authority.lock'), (await loadApp(appDir)).authority!.report);

  // Built into the case's own directory, so the build's `@mistriwork/mistri/policy`
  // resolves through the same node_modules link an authored App uses.
  const out = join(directory, 'built');
  const built = await runCli(['build', '--app', appDir, '--out', out, '--config', config, ...flags]);
  assert.equal(built.code, 0, `${built.out}${built.err}`);

  /* Served the way an operator serves a build: the App is the output
     directory and the policy is the build's own bundled module. No API here —
     what was broken was starting at all, and the tenant browser host is the
     surface the defect refused. */
  const port = await freePort();
  const child = spawn(
    process.execPath,
    cliArgs([
      '--config',
      config,
      '--app',
      out,
      '--policy',
      join(out, 'server', 'policy.mjs'),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ]),
    { cwd: ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let said = '';
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  stopping(async () => {
    child.kill('SIGTERM');
    await closed;
  });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`a served build never listened: ${said}`)), 60_000);
    const watch = (chunk: Buffer) => {
      said = (said + chunk.toString()).slice(-8000);
      if (said.includes('Listening on http://')) {
        clearTimeout(timer);
        done();
      }
    };
    child.stdout.on('data', watch);
    child.stderr.on('data', watch);
    child.once('close', () => {
      clearTimeout(timer);
      fail(new Error(`a served build closed before listening: ${said}`));
    });
  });
  assert.match(said, /served as built/, 'the deployment did not report itself as a build');

  // And it answers: a signed-out visitor meets the door rather than a stall.
  const asked = await fetch(`http://127.0.0.1:${port}/combo`);
  assert.ok(asked.status < 500, `a served build answered ${asked.status}`);
});

/** A job beside the App's own `api` block. Jobs are covered, and so is the
 * `api` block; the pair is what a deployment has to hold at once — a registry
 * two commands live in, a fact one of them commits, a job that starts on it,
 * and an exposure of the same App to tokens. A job that will not bind takes
 * the whole deployment down, which is how this class of defect is met: not as
 * a wrong answer, as a server that never listened. */
test('combination: a job × an api block binds, and the deployment says so', async (t) => {
  const { directory, stopping } = scratch(t, 'tw-combination-jobs-');
  const business = join(directory, 'business.db'),
    authPath = join(directory, 'auth.db');
  const part = merge(base({ write: true }), auth('AUTH-STORE'), apiReads(), settleJob());
  const whole: Part = { ...part, root: JSON.parse(JSON.stringify(part.root).replaceAll('"AUTH-STORE"', JSON.stringify(authPath))) };
  seedCombination(business, whole);
  const { appDir, config, flags } = writeCombination(directory, whole, { business });

  /* What a `--jobs` module needs on its source, derived exactly as the server
     derives it: the App's event store, each job's delivery destination and the
     job store. An operator's step, run with the server stopped — and the
     refusal when it is missing names this function, which is how the fixture
     found it. */
  const loaded = async (file: string) => ((await import(pathToFileURL(join(directory, file)).href)) as { default: unknown }).default;
  await provisionStores(
    { sqlite: business },
    {
      app: {
        id: 'combo',
        commands: (await loaded('jobs-commands.mts')) as NonNullable<StoresApp['commands']>,
      },
      jobs: (await loaded('jobs.mts')) as NonNullable<ProvisionStoresOptions['jobs']>,
    },
  );

  const port = await freePort();
  const child = spawn(
    process.execPath,
    cliArgs(['--config', config, '--app', appDir, ...flags, '--host', '127.0.0.1', '--port', String(port)]),
    { cwd: ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let said = '';
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  stopping(async () => {
    child.kill('SIGTERM');
    await closed;
  });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`a deployment with a job never listened: ${said}`)), 60_000);
    const watch = (chunk: Buffer) => {
      said = (said + chunk.toString()).slice(-8000);
      if (said.includes('Listening on http://')) {
        clearTimeout(timer);
        done();
      }
    };
    child.stdout.on('data', watch);
    child.stderr.on('data', watch);
    child.once('close', () => {
      clearTimeout(timer);
      fail(new Error(`a deployment with a job closed before listening: ${said}`));
    });
  });

  /* The deployment names its automation, which is the only way to know a job
     bound rather than was quietly dropped: the job, the fact it starts on,
     the command that commits that fact, the command it runs, and as whom. */
  assert.match(
    said,
    /settleTouched@1 on item\.touched@1 \(touch@1\) → settle@1 as settler/,
    `the deployment did not name its job: ${said}`,
  );
});

/** A platform command × a platform-only source. Two of the seven defects
 * lived here and both were startup failures: a platform-only source that
 * would not bind, and a platform command refused. Each half is ordinary — a
 * tenant App may have a source only its platform realm reads, and a command
 * may run in that realm — and the deployment has to hold both at once, with
 * every role, room and home rule saying whose context it serves. */
test('combination: a platform command × a platform-only source starts', async (t) => {
  const { directory, stopping } = scratch(t, 'tw-combination-platform-');
  const business = join(directory, 'business.db'),
    rates = join(directory, 'rates.db'),
    authPath = join(directory, 'auth.db');
  const part = platformRealm();
  const whole: Part = { ...part, root: JSON.parse(JSON.stringify(part.root).replaceAll('"AUTH-STORE"', JSON.stringify(authPath))) };
  seedCombination(business, whole);
  // The platform-only source is a database of its own: that is what makes it
  // one, and what the tenant realm never opens.
  seedCombination(rates, { ddl: [RATE_TABLE, RATE_ROWS] });
  const { appDir, config, flags } = writeCombination(directory, whole, { business });
  writeFileSync(
    config,
    JSON.stringify({
      connections: [
        { id: 'data', name: 'data', url: business, writable: true },
        { id: 'rates', name: 'rates', url: rates },
      ],
    }),
  );
  provisionSqliteTenantStore(business, { appId: 'combo', source: { id: 'business', connection: 'data' }, storeId: COMBO_STORE });

  const checked = await runCli(['--config', config, '--app', appDir, ...flags, VALIDATE]);
  assert.equal(checked.code, 0, `${checked.out}${checked.err}`);

  // And it serves: the realm's command is registered, not merely parsed.
  const port = await freePort();
  const child = spawn(
    process.execPath,
    cliArgs(['--config', config, '--app', appDir, ...flags, '--host', '127.0.0.1', '--port', String(port)]),
    { cwd: ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let said = '';
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  stopping(async () => {
    child.kill('SIGTERM');
    await closed;
  });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`a platform-realm deployment never listened: ${said}`)), 60_000);
    /* The tenant line, not the listening one: it is printed a moment after,
       and it is the one that says this is a tenant host rather than an
       ordinary App server. Waiting on "Listening" raced it. */
    const watch = (chunk: Buffer) => {
      said = (said + chunk.toString()).slice(-8000);
      if (said.includes('tenant membership isolation enabled')) {
        clearTimeout(timer);
        done();
      }
    };
    child.stdout.on('data', watch);
    child.stderr.on('data', watch);
    child.once('close', () => {
      clearTimeout(timer);
      fail(new Error(`a platform-realm deployment closed before listening: ${said}`));
    });
  });
});

/** Two logins, each in its own tenant, on one tenant host. A tenant request
 * asks for its session at every fence it crosses, so the host resolves the
 * cookie to a session once per request and keeps that for the request alone
 * (tenantAuthenticatedHttp.ts). Sessions are covered, and so is tenancy;
 * together they are the pair a cache keyed by anything wider than the
 * request would break — one tenant's login answering another's request, or a
 * signed-out cookie still reading. Proved over the real CLI: requests
 * interleaved, each login keeps its own rows, and one signing out is refused
 * while the other reads on. */
test('combination: two logins × tenancy keep their own sessions, and a sign-out is refused while the other reads on', async (t) => {
  const { directory, stopping } = scratch(t, 'tw-combination-sessions-');
  const business = join(directory, 'business.db'),
    authPath = join(directory, 'auth.db');
  const part = merge(base(), auth('AUTH-STORE'), tenancy());
  const whole: Part = { ...part, root: JSON.parse(JSON.stringify(part.root).replaceAll('"AUTH-STORE"', JSON.stringify(authPath))) };
  seedCombination(business, whole);
  const { appDir, config, flags } = writeCombination(directory, whole, { business });
  const loaded = await loadApp(appDir);
  writeFileSync(join(appDir, 'authority.lock'), loaded.authority!.report);

  const saved = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = SESSION_SECRET;
  const password = 'Combination-sessions-password-123!';
  const people = { north: 'north.person@example.test', south: 'south.person@example.test' } as const;
  const accountIds: Record<string, string> = {};
  try {
    const native = await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'], sessions: false });
    try {
      for (const [tenant, email] of Object.entries(people))
        accountIds[tenant] = await createNativeAccount(native, { email, name: tenant, password }, { by: 'maintenance' });
    } finally {
      native.close();
    }
  } finally {
    if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = saved;
  }

  const store = { appId: 'combo', source: { id: 'business', connection: 'data' }, storeId: COMBO_STORE };
  provisionSqliteTenantStore(business, store);
  const db = new DatabaseSync(business);
  try {
    const operations = new TransactionOperations();
    db.exec('BEGIN IMMEDIATE');
    const admin = createSqliteTenantAdministration(db, operations, store);
    for (const tenantId of ['north', 'south']) {
      await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      await admin.putMembership({
        tenantId,
        accountId: accountIds[tenantId],
        membershipId: `m-${tenantId}`,
        status: 'active',
        roles: ['operator'],
        validUntil: Date.now() + 3_600_000,
        expectedVersion: null,
      });
    }
    await operations.finish();
    db.exec('COMMIT');
  } finally {
    db.close();
  }

  const port = await freePort(),
    origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    cliArgs(['--config', config, '--app', appDir, ...flags, '--host', '127.0.0.1', '--port', String(port)]),
    { cwd: ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let said = '';
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  stopping(async () => {
    child.kill('SIGTERM');
    await closed;
  });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`a tenant deployment never listened: ${said}`)), 60_000);
    const watch = (chunk: Buffer) => {
      said = (said + chunk.toString()).slice(-8000);
      if (said.includes('tenant membership isolation enabled')) {
        clearTimeout(timer);
        done();
      }
    };
    child.stdout.on('data', watch);
    child.stderr.on('data', watch);
    child.once('close', () => {
      clearTimeout(timer);
      fail(new Error(`a tenant deployment closed before listening: ${said}`));
    });
  });

  const call = async (path: string, body: unknown, headers: Record<string, string>) => {
    const response = await fetch(origin + path, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const enter = async (tenant: keyof typeof people) => {
    const signedIn = await call('/api/auth/sign-in/email', { email: people[tenant], password }, {});
    assert.equal(signedIn.status, 200, signedIn.text);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const identity = { cookie, 'x-mistri-account': accountIds[tenant] };
    const opened = await call(`/api/tenant/context/open?app=combo&tenant=${tenant}`, {}, identity);
    assert.equal(opened.status, 200, opened.text);
    const lease = {
      ...identity,
      'x-mistri-tab': String(opened.body.tabId),
      'x-mistri-context': String(opened.body.context),
      'x-mistri-lease-revision': String(opened.body.revision),
    };
    return {
      read: () => call(`/api/run?app=combo&tenant=${tenant}`, { q: 'item' }, lease),
      signOut: () => call('/api/auth/sign-out', {}, { cookie }),
    };
  };
  const ids = (reply: Awaited<ReturnType<typeof call>>) => {
    assert.equal(reply.status, 200, reply.text);
    return (reply.body.rows as Array<Record<string, unknown>>).map((row) => row.id).sort();
  };
  const north = await enter('north'),
    south = await enter('south');
  for (let round = 0; round < 3; round++) {
    const [a, b, c, d] = await Promise.all([north.read(), south.read(), south.read(), north.read()]);
    assert.deepEqual(ids(a), ['north-1', 'north-2']);
    assert.deepEqual(ids(d), ['north-1', 'north-2']);
    assert.deepEqual(ids(b), ['south-1']);
    assert.deepEqual(ids(c), ['south-1']);
  }
  assert.equal((await north.signOut()).status, 200);
  const after = await north.read();
  assert.ok(after.status >= 400, after.text);
  assert.equal('rows' in after.body, false);
  assert.deepEqual(ids(await south.read()), ['south-1'], 'the other login reads on');
});

/** A layout beside the dashboard's other ways to narrow its sections. Each is read from the same section list an
 * `area` is a key of — a section's own `windows` name its period in the address by its title, `filters` reach the
 * sections by their tables, and a first run leads the dashboard outside the grid — and each was written without
 * a grid in mind. Loaded and checked against the database as an operator's `mistri check` does, then read back
 * from the loaded App: a layout that dropped a section's period or its place would still have loaded. */
test('combination: a layout × section windows × filters checks, and each keeps its own', async (t) => {
  const { directory } = scratch(t, 'tw-combination-layout-');
  const business = join(directory, 'business.db');
  const part = merge(base(), auth('AUTH-STORE'), layoutDashboard());
  const whole: Part = {
    ...part,
    root: JSON.parse(JSON.stringify(part.root).replaceAll('"AUTH-STORE"', JSON.stringify(join(directory, 'auth.db')))),
  };
  seedCombination(business, whole);
  const { appDir, config, flags } = writeCombination(directory, whole, { business });
  const checked = await runCli(['--config', config, '--app', appDir, ...flags, VALIDATE]);
  assert.equal(checked.code, 0, `${checked.out}${checked.err}`);

  const loaded = await loadApp(appDir);
  const board = loaded.app.views.board as {
    areas?: string[];
    filters?: string[];
    sections: Array<{ title?: string; area?: string; windowKey?: string; windows?: string[] }>;
  };
  assert.deepEqual(board.areas, ['kpis kpis', 'trend mix']);
  assert.deepEqual(board.filters, ['status']);
  // The section's own period is named by its title, in the address, as it is without a layout; its place is its area.
  const trend = board.sections.find((section) => section.title === 'Visits by day');
  assert.equal(trend?.windowKey, 'visits-by-day');
  assert.deepEqual(trend?.windows, ['last 7 days', 'last 30 days']);
  assert.deepEqual(
    board.sections.map((section) => section.area),
    ['kpis', 'kpis', 'trend', 'mix'],
  );
});

test('combination: a layout × a first run leads outside the grid, and takes no area', async (t) => {
  const { directory } = scratch(t, 'tw-combination-layout-first-run-');
  const steps = [{ label: 'Add an item', to: 'items' }];
  const run = (firstRun: object) =>
    merge(
      base(),
      auth('AUTH-STORE'),
      layoutDashboard({
        sections: [
          firstRun,
          { kind: 'metric', title: 'Items', from: 'item', area: 'kpis' },
          { kind: 'breakdown', title: 'By status', from: 'visit', by: 'status', area: 'mix' },
        ],
        areas: ['kpis mix'],
      }),
    );
  const deployed = async (part: Part, name: string) => {
    const where = join(directory, name);
    mkdirSync(where);
    const whole: Part = {
      ...part,
      root: JSON.parse(JSON.stringify(part.root).replaceAll('"AUTH-STORE"', JSON.stringify(join(where, 'auth.db')))),
    };
    seedCombination(join(where, 'business.db'), whole);
    const { appDir, config, flags } = writeCombination(where, whole, { business: join(where, 'business.db') });
    return { checked: await runCli(['--config', config, '--app', appDir, ...flags, VALIDATE]), appDir };
  };
  const led = await deployed(run({ kind: 'firstRun', title: 'Start', steps }), 'led');
  assert.equal(led.checked.code, 0, `${led.checked.out}${led.checked.err}`);
  const board = (await loadApp(led.appDir)).app.views.board as { sections: Array<{ kind: string; area?: string }> };
  assert.equal(board.sections.find((section) => section.kind === 'firstRun')?.area, undefined);
  assert.deepEqual(
    board.sections.filter((section) => section.kind !== 'firstRun').map((section) => section.area),
    ['kpis', 'mix'],
  );
  // Put into an area it would stand in the grid and not lead the dashboard: refused, by name.
  const placed = await deployed(run({ kind: 'firstRun', title: 'Start', steps, area: 'kpis' }), 'placed');
  assert.notEqual(placed.checked.code, 0);
  assert.match(`${placed.checked.out}${placed.checked.err}`, /first run, which leads the dashboard outside its areas/);
});

/** A relationship row scope (`via`) × live sync. The live filter cannot believe a via from the change alone (the
 * scope reads another table), so a probe asks the database as the reader: a row outside the relationship before and
 * after a change is told to no one, one that enters it is told by key, one that leaves it is not (a before image cannot judge a relationship), and none of it names a row
 * the reader may not see. Each feature is covered alone (row-scope-via.test.ts, live-sync-route.test.ts). */
test('combination: a via row scope × live sync tells a reader only of rows the relationship reaches', { timeout: 90_000 }, async (t) => {
  const server = await policyServer(t, {
    app: {
      id: 'spoke',
      name: 'Spoke',
      live: true,
      auth: {
        signUp: 'open',
        defaultRole: 'rider',
        rows: 'policy',
        roles: {
          admin: { label: 'Owner', read: true, write: true },
          rider: { label: 'Rider', read: ['job', 'bench'], write: ['job'], fields: { job: { write: ['title'] } } },
        },
      },
      resources: { job: { access: 'write' }, bench: { access: 'write' }, bench_access: { access: 'write' } },
      views: { jobs: { kind: 'list', from: 'job' } },
      home: 'jobs',
      nav: ['jobs'],
    },
    policy: `export default { appId: 'spoke', resolveRows(principal) {
      if (principal.roles.includes('admin')) return { job: true, bench: true, bench_access: true };
      const held = { resource: 'bench_access', column: 'bench_id' };
      return { bench_access: true, bench: { groups: [[{ column: 'id', op: 'in', via: held }]] },
        job: { groups: [[{ column: 'bench_id', op: 'in', via: held }]] } };
    } };`,
    sql: `CREATE TABLE bench(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE bench_access(id INTEGER PRIMARY KEY, bench_id INTEGER NOT NULL);
      CREATE TABLE job(id INTEGER PRIMARY KEY, title TEXT NOT NULL, bench_id INTEGER REFERENCES bench(id));
      INSERT INTO bench VALUES (1, 'Front'), (2, 'Back');
      INSERT INTO bench_access VALUES (1, 1);
      INSERT INTO job(id, title, bench_id) VALUES (1, 'Tune', 1), (2, 'Hidden', 2), (3, 'Leaving', 1);`,
    live: true,
  });
  const owner = await server.owner();
  const rider = await server.signUp('rider');
  const controller = new AbortController();
  const response = await fetch(`${server.origin}/api/live?app=spoke`, {
    headers: { origin: server.origin, cookie: rider },
    signal: controller.signal,
  });
  let text = '';
  const done = (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body!) text += decoder.decode(chunk as Uint8Array, { stream: true });
    } catch {
      /* aborted */
    }
  })();
  t.after(async () => {
    controller.abort();
    await done;
  });
  const told = () => [...text.matchAll(/event: change\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]).tables.job?.keys?.[0]?.id);
  const until = async (ok: () => boolean) => {
    for (let n = 0; n < 250 && !ok(); n++) await new Promise((done) => setTimeout(done, 20));
    assert.ok(ok(), text);
  };
  await until(() => text.includes('event: hello'));
  const update = async (id: number, values: object) =>
    assert.equal((await server.api('update', { table: 'job', key: { id }, values }, owner)).status, 200);

  // Outside the relationship before and after: told to no one, and no byte names it.
  await update(2, { title: 'Still hidden' });
  await new Promise((done) => setTimeout(done, 900));
  assert.deepEqual(told(), []);
  assert.doesNotMatch(text, /Hidden|"id":2/);
  // Leaves it by its own change: a before image cannot say whether another table's rows admitted it, so the
  // reader is not told (live sync fails closed, liveFilter.ts); their next refresh drops the row.
  await update(3, { bench_id: 2 });
  await new Promise((done) => setTimeout(done, 900));
  assert.deepEqual(told(), []);
  // Enters it: told, by key (the probe asks the database as the reader).
  await update(2, { bench_id: 1 });
  await until(() => told().length === 1);
  assert.deepEqual(told(), [2]);
  // Outside, then changed while outside: not told.
  await update(3, { title: 'Gone' });
  await new Promise((done) => setTimeout(done, 900));
  assert.equal(told().length, 1, text);
  assert.doesNotMatch(text, /Gone/);
});

/** Two readers whose `via` target rules differ by who they are (a per-user membership table). The scope's own filter
 * reads alike for both (`bench_id in via bench_access`), so a probe shared by that filter alone would answer one
 * rider's question with the other's membership: each is told only of the jobs their own membership reaches. */
test(
  'combination: a via row scope × live sync never shares a probe between readers whose target rules differ',
  { timeout: 90_000 },
  async (t) => {
    const server = await policyServer(t, {
      app: {
        id: 'spoke',
        name: 'Spoke',
        live: true,
        auth: {
          signUp: 'open',
          defaultRole: 'rider',
          rows: 'policy',
          roles: {
            admin: { label: 'Owner', read: true, write: true },
            rider: { label: 'Rider', read: ['job', 'bench'], write: ['job'], fields: { job: { write: ['title'] } } },
          },
        },
        resources: { job: { access: 'write' }, bench: { access: 'write' }, bench_access: { access: 'write' } },
        views: { jobs: { kind: 'list', from: 'job' } },
        home: 'jobs',
        nav: ['jobs'],
      },
      policy: `export default { appId: 'spoke', resolveRows(principal) {
      if (principal.roles.includes('admin')) return { job: true, bench: true, bench_access: true };
      const held = { resource: 'bench_access', column: 'bench_id' };
      return { bench_access: { groups: [[{ column: 'who', op: '=', value: principal.id }]] },
        bench: { groups: [[{ column: 'id', op: 'in', via: held }]] },
        job: { groups: [[{ column: 'bench_id', op: 'in', via: held }]] } };
    } };`,
      sql: `CREATE TABLE bench(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE bench_access(id INTEGER PRIMARY KEY, bench_id INTEGER NOT NULL, who TEXT NOT NULL);
      CREATE TABLE job(id INTEGER PRIMARY KEY, title TEXT NOT NULL, bench_id INTEGER REFERENCES bench(id));
      INSERT INTO bench VALUES (1, 'Front'), (2, 'Back');
            INSERT INTO job(id, title, bench_id) VALUES (1, 'Alice job', 1), (2, 'Bob job', 2);`,
      live: true,
    });
    const owner = await server.owner();
    const alice = await server.signUp('alice');
    const bob = await server.signUp('bob');
    // Each rider's membership names the verified account's id, so the two target rules differ by who is asking.
    const idOf = async (cookie: string) =>
      ((await server.call('/api/auth/get-session', undefined, cookie)).body as { user: { id: string } }).user.id;
    for (const [bench, cookie] of [
      [1, alice],
      [2, bob],
    ] as const)
      assert.equal(
        (await server.api('insert', { table: 'bench_access', values: { bench_id: bench, who: await idOf(cookie) } }, owner)).status,
        200,
      );
    const controller = new AbortController();
    const streams = [alice, bob].map((cookie) => {
      const seen = { text: '' };
      const open = fetch(`${server.origin}/api/live?app=spoke`, {
        headers: { origin: server.origin, cookie },
        signal: controller.signal,
      }).then(async (response) => {
        const decoder = new TextDecoder();
        try {
          for await (const chunk of response.body!) seen.text += decoder.decode(chunk as Uint8Array, { stream: true });
        } catch {
          /* aborted */
        }
      });
      return { seen, open };
    });
    t.after(async () => {
      controller.abort();
      await Promise.all(streams.map((stream) => stream.open));
    });
    const [a, b] = streams.map((stream) => stream.seen);
    const told = (seen: { text: string }) =>
      [...seen.text.matchAll(/event: change\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]).tables.job?.keys?.[0]?.id);
    const until = async (ok: () => boolean) => {
      for (let n = 0; n < 250 && !ok(); n++) await new Promise((done) => setTimeout(done, 20));
      assert.ok(ok(), a.text + b.text + server.log());
    };
    await until(() => a.text.includes('event: hello') && b.text.includes('event: hello'));
    const update = async (id: number, title: string) =>
      assert.equal((await server.api('update', { table: 'job', key: { id }, values: { title } }, owner)).status, 200);

    await update(1, 'Alice job, edited');
    await until(() => told(a).length === 1);
    await new Promise((done) => setTimeout(done, 900));
    assert.deepEqual(told(a), [1]);
    assert.deepEqual(told(b), []);
    await update(2, 'Bob job, edited');
    await until(() => told(b).length === 1);
    await new Promise((done) => setTimeout(done, 900));
    assert.deepEqual(told(b), [2]);
    assert.deepEqual(told(a), [1]);
  },
);

test(
  'combination: a signed-in draft × a narrowing row scope refuses the next step, leaves the draft as it was, and resumes once the scope is back',
  { timeout: 60_000 },
  async (t) => {
    const f = await draftPolicyServer(t);
    const ann = await f.signUp('ann');
    for (const step of ['you', 'plan']) assert.equal((await f.step(ann, step)).status, 200);

    // An operator moves ann out of region 1 between two steps: the draft's root is no longer in her rows.
    f.setRegion('ann@example.org', 2);
    const refused = await f.step(ann, 'contact');
    assert.ok([403, 404].includes(refused.status), JSON.stringify(refused.body));
    assert.deepEqual(f.contacts(), [], 'the refused step wrote nothing');
    assert.equal(f.onboardings()[0].resume_progress, 'you,plan', 'and the draft is intact');

    f.setRegion('ann@example.org', 1);
    const back = await f.op(ann, 'resume');
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.deepEqual(back.body.draft.saved, ['you', 'plan']);
    assert.equal((await f.step(ann, 'contact')).status, 200);
  },
);
