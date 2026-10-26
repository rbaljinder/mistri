/**
 * A row-policy App's jobs (CX2): a job at times, an `at` timer and an inbound
 * endpoint each run their command as the jobs module's principal, under the
 * rows the policy gives `service:<name>` — a write outside them is refused
 * and nothing of it is committed, a timer never finds a record outside them —
 * and a principal the policy's `services` does not name starts nothing.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { JOB_TABLES } from '../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import { AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.js';
import { hostAppCommands } from '../packages/mistri/src/server/cli/commandHost.js';
import { registryJobBinding } from '../packages/mistri/src/server/jobs/jobHost.js';
import { JobRejected } from '../packages/mistri/src/server/jobs/jobs.js';
import { loadBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { appCommandCatalog } from '../packages/mistri/src/server/commands/commandContracts.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { policyServiceFindings } from '../packages/mistri/src/server/policy/policyServiceChecks.js';
import { refusalReasons } from '../packages/engine/src/shared/refusal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const ROOT = resolve('.');
const src = (path: string) => JSON.stringify(pathToFileURL(join(ROOT, path)).href);
const SECRET = 'row-policy-inbound-secret';

const manifest = {
  id: 'desk',
  name: 'Desk',
  sources: { desk: { connection: 'desk', default: true } },
  resources: {
    item: { access: 'write', at: { due_at: { command: 'close', when: "status = 'open'" } } },
    stamp: { access: 'write' },
  },
  auth: { rows: 'policy', roles: { user: { read: true }, poster: { read: true, service: true, commands: ['close', 'stamp'] } } },
  views: { items: { kind: 'list', from: 'item' }, stamps: { kind: 'list', from: 'stamp' } },
  home: 'items',
  nav: ['items', 'stamps'],
};

async function fixture(t: TestContext, services = "['poster']") {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-row-policy-jobs-'));
  const file = join(directory, 'desk.db');
  const raw = new DatabaseSync(file);
  // Desk 1 is the service's; desk 2 is not. Both items are due.
  raw.exec(`CREATE TABLE item (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL, status TEXT NOT NULL, due_at TIMESTAMP,
      version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE stamp (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL, at TEXT NOT NULL);
    INSERT INTO item VALUES (1, 1, 'open', '2020-01-01 00:00:00', 0), (2, 2, 'open', '2020-01-01 00:00:00', 0),
      (3, 1, 'open', NULL, 0), (4, 2, 'open', NULL, 0);`);
  raw.close();
  migrateSqliteCommandJournal(file);
  writeFileSync(
    join(directory, 'commands.mjs'),
    `import { defineCommand, defineCommands, field } from ${src('packages/mistri/src/server/commands.ts')};
export default defineCommands({
  close: defineCommand({ source: 'desk', target: 'item', read: ['item'], write: ['item'],
    async handle({ db, record }) { await db.item.update(record, { status: 'closed' }); } }),
  stamp: defineCommand({ source: 'desk', target: 'stamp', targets: 'none', read: ['stamp'], write: ['stamp'], input: { desk: field.number() },
    async handle({ db, now }, input) { await db.stamp.insert({ desk: input.desk, at: now().toISOString() }); } }),
});
`,
  );
  writeFileSync(
    join(directory, 'jobs.mjs'),
    `import { defineInbound, defineJob, defineJobs, hmac } from ${src('packages/mistri/src/server/jobs.ts')};
export default defineJobs({
  mine: defineJob({ every: '* * * * *', runAs: 'poster', command: 'stamp', input: { desk: 1 } }),
  stray: defineJob({ every: '* * * * *', runAs: 'poster', command: 'stamp', input: { desk: 2 } }),
}, { principals: { poster: { roles: ['poster'] } }, store: { namespace: 'desk', maxAttempts: 3, backoffMs: { base: 50, cap: 100 } },
  inbound: { closed: defineInbound({ verify: hmac({ secret: 'DESK_SECRET', signature: { header: 'x-signature' },
    timestamp: { header: 'x-timestamp', window: '5 minutes' } }), runAs: 'poster', command: 'close',
    key: body => body.id, input: () => ({}), target: body => ({ id: body.item }) }) } });
`,
  );
  const policyFile = join(directory, 'policy.mjs');
  writeFileSync(
    policyFile,
    `const desk = (value) => ({ groups: [[{ column: 'desk', op: '=', value }]] });
export default { appId: 'desk', services: ${services},
  resultReferences: { close: () => [], stamp: () => [] },
  resolveRows(principal) {
    if (principal.kind === 'service') return principal.id === 'service:poster' ? { item: desk(1), stamp: desk(1) } : {};
    return { item: true, stamp: true };
  } };
`,
  );
  const commands = await loadBusinessCommands(join(directory, 'commands.mjs'));
  const jobs = (await import(pathToFileURL(join(directory, 'jobs.mjs')).href)).default;
  await provisionStores({ sqlite: file }, { app: { id: 'desk', commands }, jobs });
  const registry = new Registry();
  registry.add({ id: 'desk', name: 'desk', url: file, source: 'config', writable: true });
  const app = parseAppConfig(manifest, 'desk', { commands: appCommandCatalog(commands, manifest) });
  let policy: HttpAppPolicy | undefined;
  const hosted = await hostAppCommands({
    app,
    commands,
    registry,
    owner: 'desk',
    policy: () => policy,
    jobsFile: join(directory, 'jobs.mjs'),
    environment: { DESK_SECRET: SECRET },
    locate: (id) => registry.configOf(id)?.url,
    current: () => app,
  });
  let server: Server | undefined;
  t.after(async () => {
    if (server) {
      const closed = once(server, 'close');
      server.closeAllConnections();
      server.close();
      await closed;
    }
    await hosted.jobHost?.stop();
    await policy?.retire();
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  });
  const load = (named = hosted.jobPrincipals) =>
    loadHttpAppPolicy({ app, registry, file: policyFile, commands, verifySession: async () => null, services: named });
  const serve = async () => {
    server = createServer((req, res) => {
      void hosted.inbound!.handle(req, res, new URL(req.url!, 'http://localhost')).then((handled) => {
        if (!handled) res.writeHead(404).end();
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as { port: number };
    return (payload: object) => {
      const body = JSON.stringify(payload),
        timestamp = String(Math.floor(Date.now() / 1000));
      return fetch(`http://127.0.0.1:${port}/api/inbound/closed`, {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'x-timestamp': timestamp,
          'x-signature': createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex'),
        },
      });
    };
  };
  const read = new DatabaseSync(file, { readOnly: true });
  t.after(() => read.close());
  return {
    app,
    commands,
    registry,
    policyFile,
    hosted,
    load,
    serve,
    use: (loaded: HttpAppPolicy | undefined) => (policy = loaded),
    policy: () => policy,
    items: () =>
      read
        .prepare('SELECT id, status FROM item ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
    stamps: () =>
      read
        .prepare('SELECT desk FROM stamp ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
    jobs: () =>
      read
        .prepare(`SELECT job, state FROM "${JOB_TABLES.job}" ORDER BY job, idempotency_key`)
        .all()
        .map((row) => ({ ...row })),
  };
}

test(
  "a row-policy App's jobs, timers and inbound endpoints run as their service, in the policy's rows",
  { timeout: 120_000 },
  async (t) => {
    const desk = await fixture(t);
    assert.deepEqual([...desk.hosted.jobPrincipals.keys()], ['poster']);

    // While the policy is not serving (a save restarts it), an attempt is tried again later, never run unscoped.
    const bind = registryJobBinding({
      registry: desk.registry,
      app: () => desk.app,
      owner: 'desk',
      commands: desk.commands,
      policy: () => undefined,
    });
    await assert.rejects(
      bind(undefined, 'poster'),
      (error: unknown) => !(error instanceof JobRejected) && !(error instanceof AppAccessDenied),
    );

    desk.use(await desk.load());
    // A principal the policy does not name is refused for good.
    await assert.rejects(
      registryJobBinding({
        registry: desk.registry,
        app: () => desk.app,
        owner: 'desk',
        commands: desk.commands,
        policy: () => desk.policy(),
      })(undefined, 'stranger'),
      AppAccessDenied,
    );
    const deadline = Date.now() + 60_000;
    const states = () => desk.jobs().map((row) => `${row.job} ${row.state}`);
    // A slot a minute: a new minute may add a run of each, so what is asserted is every run's end, not their number.
    const settled = () =>
      ['mine succeeded', 'stray failed', 'at-item-due_at succeeded'].every((state) => states().includes(state)) &&
      desk.jobs().every((row) => row.state === 'succeeded' || row.state === 'failed');
    while (!settled() && Date.now() < deadline) {
      await desk.hosted.jobHost!.tick();
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.ok(settled(), JSON.stringify(states()));
    // The job inside the service's rows wrote; the one outside them was refused on each attempt, and wrote nothing.
    assert.ok(desk.stamps().length >= 1);
    assert.ok(
      desk.stamps().every((row) => row.desk === 1),
      JSON.stringify(desk.stamps()),
    );
    for (const row of desk.jobs()) assert.equal(row.state, row.job === 'stray' ? 'failed' : 'succeeded', JSON.stringify(states()));
    // The timer found the due item in the service's rows only: item 2 is due as well, and is not the service's.
    assert.deepEqual(desk.items().slice(0, 2), [
      { id: 1, status: 'closed' },
      { id: 2, status: 'open' },
    ]);

    // An inbound endpoint runs as its principal too: in its rows, and refused outside them.
    const deliver = await desk.serve();
    assert.equal((await deliver({ id: 'in-3', item: 3 })).status, 204);
    assert.notEqual((await deliver({ id: 'in-4', item: 4 })).status, 204);
    assert.deepEqual(desk.items().slice(2), [
      { id: 3, status: 'closed' },
      { id: 4, status: 'open' },
    ]);
  },
);

test('a principal the policy does not name starts nothing, and check says so', { timeout: 60_000 }, async (t) => {
  const desk = await fixture(t, "['ledger']");
  await assert.rejects(desk.load(), (error: unknown) => {
    assert.ok(
      refusalReasons(error).some((reason) => reason.includes('[policy-service-unnamed]') && reason.includes('"poster"')),
      JSON.stringify(refusalReasons(error)),
    );
    return true;
  });
  const findings = await policyServiceFindings({
    registry: desk.registry,
    app: desk.app,
    file: desk.policyFile,
    commands: desk.commands,
    principals: desk.hosted.jobPrincipals,
    runs: desk.hosted.serviceRuns,
  });
  assert.equal(findings.problems.length, 1);
  assert.match(findings.problems[0], /^\[policy-service-unnamed\] The jobs run as "poster"/);
  assert.match(findings.warnings[0], /^\[policy-service-unused\] The row policy's services name "ledger"/);
});

test('check warns of a service the policy gives no rows its commands reach', { timeout: 60_000 }, async (t) => {
  const desk = await fixture(t);
  const findings = await policyServiceFindings({
    registry: desk.registry,
    app: desk.app,
    file: desk.policyFile,
    commands: desk.commands,
    principals: desk.hosted.jobPrincipals,
    runs: new Map([['poster', new Set(['close', 'stamp'])]]),
  });
  assert.deepEqual(findings, { problems: [], warnings: [] });
  writeFileSync(
    desk.policyFile.replace(/policy\.mjs$/, 'narrow.mjs'),
    `export default { appId: 'desk', services: ['poster'], resultReferences: { close: () => [], stamp: () => [] },
  resolveRows: (principal) => (principal.kind === 'service' ? { item: true, stamp: false } : { item: true, stamp: true }) };
`,
  );
  const narrow = await policyServiceFindings({
    registry: desk.registry,
    app: desk.app,
    file: desk.policyFile.replace(/policy\.mjs$/, 'narrow.mjs'),
    commands: desk.commands,
    principals: desk.hosted.jobPrincipals,
    runs: new Map([['poster', new Set(['close', 'stamp'])]]),
  });
  assert.equal(narrow.warnings.length, 1);
  assert.match(narrow.warnings[0], /^\[policy-service-rows\] The row policy gives service "poster" no rows of "stamp"/);
});
