import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  COMMAND_JOURNAL_TABLES as tables,
  CommandTransactionFailure,
  migrateSqliteCommandJournal,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { AppRowPolicyDefinitionError } from '../packages/mistri/src/server/policy/appRowPolicy.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { refuse } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { authoringApp } from '../packages/engine/src/server/http/refusalReport.js';
import { setFieldCeilings } from './support/appCeilings.js';
import { parseTestApp } from './support/commandCatalog.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

const appId = 'scoped-command-http';
const owner = 'private-scoped-command-db';
const account: Identity = { id: 'desk-one', who: 'manager@example.test', role: 'manager' };
const prepare = (extra: Record<string, unknown> = {}) => ({ command: 'assign', commandVersion: 1, key: { id: 1 }, ...extra });
const attempt = (extra: Record<string, unknown> = {}) => ({
  ...prepare(),
  expectedVersion: 0,
  idempotencyKey: 'scoped-http-attempt-0001',
  input: { reviewerId: 1 },
  ...extra,
});
const references = 'resultReferences: { assign: result => [{ table: "reviewer", key: { id: result.reviewerId } }] },';
/* The command's one input declaration: the manifest's reference and the registration both read it. */
const assignInput = {
  reviewerId: { label: 'Reviewer', type: 'reference', from: 'reviewer', by: 'id', labelColumn: 'name', optional: true },
} as const;
const privateFree = (value: unknown) =>
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|HIDDEN|physical_|private-scoped-command|__mistri_command|"(?:sql|stack|cause|undo)"/);

async function fixture(t: TestContext, options: { defer?: boolean; migrated?: boolean; writable?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-row-policy-command-http-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  const registry = new Registry();
  const policies: HttpAppPolicy[] = [];
  const servers: Server[] = [];
  t.after(async () => {
    try {
      for (const server of servers) {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await closed;
      }
      for (const policy of policies) await policy.retire();
      await registry.closeAll();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`CREATE TABLE physical_loan(id INTEGER PRIMARY KEY, version INTEGER NOT NULL, desk INTEGER NOT NULL,
      reviewer_id INTEGER, name TEXT);
    CREATE TABLE physical_reviewer(id INTEGER PRIMARY KEY, desk INTEGER NOT NULL, name TEXT);
    CREATE TABLE physical_note(id INTEGER PRIMARY KEY, body TEXT);
    INSERT INTO physical_loan VALUES (1,0,1,NULL,'Visible loan'),(2,0,2,NULL,'HIDDEN loan');
    INSERT INTO physical_reviewer VALUES (1,1,'Ada'),(2,2,'HIDDEN reviewer'),(3,1,'Grace');
    INSERT INTO physical_note VALUES (1,'PRIVATE note');`);
  if (options.migrated !== false) migrateSqliteCommandJournal(file);
  registry.add({ id: owner, name: 'Private command source', url: file, writable: options.writable !== false, source: 'config' });
  const app = parseTestApp(
    {
      id: appId,
      name: 'Scoped commands',
      track: 'receipts',
      sources: { lending: { connection: owner } },
      resources: {
        loan: {
          physical: 'physical_loan',
          access: 'write',
          actions: {
            assign: {
              label: 'Assign',
              command: {
                id: 'assign',
                version: 1,
                target: 'loan',
                input: assignInput,
              },
            },
          },
        },
        reviewer: { physical: 'physical_reviewer' },
        note: { physical: 'physical_note', access: 'write' },
      },
      auth: {
        rows: 'policy',
        roles: {
          manager: { read: true, commands: ['assign'] },
          viewer: { read: ['loan', 'reviewer'] },
          incomplete: { read: ['loan'], commands: ['assign'] },
        },
      },
      views: { loans: { kind: 'list', from: 'loan' } },
      home: 'loans',
      nav: ['loans'],
    },
    'scoped command HTTP fixture',
  );
  const control = {
    identity: { ...account } as Identity | null,
    verified: undefined as Identity | null | undefined,
    calls: 0,
    verifications: 0,
    lookups: 0,
    commits: 0,
    fallbackCalls: 0,
    lookupFailure: false,
    lostAcknowledgment: false,
    businessFailure: false,
    writeUndeclared: false,
    readUndeclared: false,
    insertHidden: false,
  };
  const commands = defineCommands({
    assign: defineCommand({
      source: 'lending',
      target: 'loan',
      read: ['loan', 'reviewer'],
      write: ['loan'],
      input: assignInput,
      // The declaration takes a reviewer's key as text or a whole number; this command wants the number, always.
      validate(value) {
        if (!Number.isSafeInteger(value.reviewerId)) throw new Error('PRIVATE input');
        return { reviewerId: value.reviewerId as number };
      },
      output: {
        parse(value: unknown) {
          const result = value as { reviewerId: number; version: number; reviewerName: string };
          return { reviewerId: result.reviewerId, version: result.version, reviewerName: result.reviewerName };
        },
      },
      async handle(context, input) {
        control.calls++;
        const version = Number(context.record.version);
        await context.tx.update({
          table: 'loan',
          key: { id: Number(context.record.id) },
          expected: { version, reviewer_id: null },
          values: { version: version + 1, reviewer_id: input.reviewerId },
        });
        if (control.businessFailure) refuse('reviewer_unavailable');
        if (control.writeUndeclared) await context.tx.update({ table: 'reviewer', key: { id: 1 }, values: { name: 'PRIVATE change' } });
        if (control.readUndeclared) await context.tx.query({ table: 'note', limit: 1, offset: 0 });
        // A row the principal's rows do not admit: the scoped writer refuses it after the insert.
        if (control.insertHidden) await context.tx.insert({ table: 'loan', values: { id: 9, version: 0, desk: 2, name: 'x' } });
        // The explicit extractor must protect even a handler's unqueried result
        // dependency, including this historic name after the target is reassigned.
        return {
          reviewerId: input.reviewerId,
          version: version + 1,
          reviewerName: input.reviewerId === 1 ? 'Ada' : 'HIDDEN reviewer',
          sql: 'PRIVATE SQL',
        };
      },
    }),
  });
  const { adapter } = await registry.open(owner);
  const native = commandsOf(adapter).scopeCommandTransaction;
  assert.ok(native);
  const scoped = native.bind(adapter);
  adapter.scopeCommandTransaction = async (rows, run) => {
    const result = await scoped(rows, (records, journal, evidence) =>
      run(
        records,
        {
          find: (scope) => {
            control.lookups++;
            if (control.lookupFailure) throw new Error('PRIVATE lookup failure');
            return journal.find(scope);
          },
          commit: (receipt, audit) => {
            control.commits++;
            return journal.commit(receipt, audit);
          },
        },
        evidence,
      ),
    );
    if (control.lostAcknowledgment) throw new CommandTransactionFailure(new Error('PRIVATE lost acknowledgment'), 'unknown');
    return result;
  };
  // All public operations must use captured scoped capabilities. A successful
  // HTTP request plus these counters proves no legacy transaction/read fallback.
  const fallback = async (): Promise<never> => {
    control.fallbackCalls++;
    throw new Error('PRIVATE unscoped fallback');
  };
  adapter.query = fallback;
  adapter.count = fallback;
  adapter.transaction = fallback;
  adapter.commandTransaction = fallback;
  adapter.insert = fallback;
  adapter.update = fallback;
  adapter.remove = fallback;
  const host: AppHost = {
    app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: join(directory, 'auth.db'),
      close() {},
      handler: async () => {},
      session: async () => control.identity,
    },
  };
  let moduleNumber = 0;
  const moduleFile = (declaration = references) => {
    const module = join(directory, `policy-${moduleNumber++}.mjs`);
    writeFileSync(
      module,
      `export default { appId: ${JSON.stringify(appId)}, ${declaration}
      resolveRows(principal) {
        const desk = principal.id === 'desk-two' ? 2 : 1;
        const eq = { groups: [[{ column: 'desk', op: '=', value: desk }]] };
        return { loan: eq, reviewer: eq, note: true };
      }
    };`,
    );
    return module;
  };
  const load = async (overrides: Partial<Parameters<typeof loadHttpAppPolicy>[0]> = {}) => {
    const policy = await loadHttpAppPolicy({
      app,
      registry,
      commands,
      file: moduleFile(),
      verifySession: async () => {
        control.verifications++;
        return control.verified === undefined ? control.identity : control.verified;
      },
      ...overrides,
    });
    policies.push(policy);
    return policy;
  };
  let base = '';
  const bound = { host: '127.0.0.1', port: 0 };
  const start = async (provided?: HttpAppPolicy) => {
    const policy = provided ?? (await load());
    const server = createApp({ registry, bound, apps: [host], policy });
    servers.push(server);
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    base = `http://${bound.host}:${bound.port}`;
    return policy;
  };
  const request = async (
    path: string,
    body?: unknown,
    options: { headers?: Record<string, string>; raw?: string; method?: string } = {},
  ) => {
    const url = new URL(path, base);
    if (!url.searchParams.has('app')) url.searchParams.set('app', appId);
    const response = await fetch(url, {
      method: options.method ?? (body === undefined && options.raw === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', 'x-mistri-account': account.id, ...options.headers },
      ...(body !== undefined || options.raw !== undefined ? { body: options.raw ?? JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(3000),
    });
    const payload = await response.json();
    privateFree(payload);
    return { status: response.status, body: payload, headers: response.headers };
  };
  const command = (path: string, body: unknown = attempt(), options?: Parameters<typeof request>[2]) =>
    request(`/api/commands/${path}`, body, options);
  const loan = () => db.prepare('SELECT * FROM physical_loan WHERE id = 1').get()!;
  const receipts = () => db.prepare(`SELECT * FROM "${tables.receipt}"`).all();
  const audits = () => db.prepare(`SELECT * FROM ${sqliteAuditRows} a`).all();
  if (!options.defer) await start();
  return { db, registry, adapter, app, host, commands, bound, control, moduleFile, load, start, request, command, loan, receipts, audits };
}

function refused(
  response: { status: number; body: Record<string, unknown> },
  status: number,
  outcome: 'unknown' | 'not_applied',
  code?: string,
) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.outcome, outcome);
  if (code) assert.equal(response.body.code, code);
  assert.equal(Object.hasOwn(response.body, 'result'), false);
  assert.equal(Object.hasOwn(response.body, 'receiptId'), false);
}

test('public row-policy commands prepare, execute, replay and status use scoped SQLite receipts', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const target = prepare();
  const availability = await f.command('availability', {
    checks: [{ command: target.command, commandVersion: target.commandVersion, keys: [target.key, { id: 999 }] }],
  });
  assert.equal(availability.status, 200);
  assert.deepEqual(availability.body, {
    checks: [{ command: target.command, commandVersion: target.commandVersion, available: [true, false] }],
  });
  const ready = await f.command('prepare', prepare());
  assert.equal(ready.status, 200);
  assert.deepEqual(ready.body, { expectedVersion: 0 });
  assert.equal(ready.headers.get('x-mistri-app'), appId);
  assert.equal(ready.headers.get('x-mistri-account'), account.id);
  const missing = await f.command('status');
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.body, { status: 'not_found', outcome: 'unknown' });
  assert.equal(f.control.calls, 0);
  const first = await f.command('execute');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.replayed, false);
  assert.equal(first.body.commandVersion, 1);
  assert.deepEqual(first.body.result, { reviewerId: 1, version: 1, reviewerName: 'Ada' });
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const saved = f.receipts();
  for (const path of ['execute', 'status']) {
    const replay = await f.command(path);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, { ...first.body, replayed: true });
  }
  assert.deepEqual(f.receipts(), saved);
  assert.equal(saved.length, 1);
  assert.equal(f.audits().length, 1);
  assert.equal(f.loan().version, 1);
  assert.equal(f.control.calls, 1);
  assert.equal(f.control.commits, 1);
  assert.equal(f.control.fallbackCalls, 0);
});

test('hidden and absent targets reveal no prepare version and keep execution/status outcome unknown', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  for (const id of [2, 99]) {
    const ready = await f.command('prepare', prepare({ key: { id } }));
    assert.equal(ready.status, 404);
    assert.equal(ready.body.code, 'not_found');
    assert.equal(Object.hasOwn(ready.body, 'expectedVersion'), false);
    for (const path of ['execute', 'status']) refused(await f.command(path, attempt({ key: { id } })), 403, 'unknown', 'forbidden');
  }
  assert.equal(f.control.calls, 0);
  assert.equal(f.control.lookups, 0);
  assert.equal(f.receipts().length, 0);
  assert.equal(f.control.fallbackCalls, 0);
});

test('reviewer selector is scoped and a hidden result dependency rolls back fresh command writes', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const choices = await f.request('/api/query', { table: 'reviewer', columns: ['id', 'name'], limit: 10, offset: 0 });
  assert.equal(choices.status, 200);
  assert.deepEqual(choices.body.rows.map((row: { id: number }) => row.id).sort(), [1, 3]);
  refused(await f.command('execute', attempt({ input: { reviewerId: 2 } })), 403, 'not_applied', 'forbidden');
  assert.equal(f.control.calls, 1);
  assert.equal(f.control.lookups, 1, 'rollback follows authorized receipt absence');
  assert.equal(f.loan().version, 0);
  assert.equal(f.loan().reviewer_id, null);
  assert.equal(f.receipts().length, 0);
  assert.equal(f.audits().length, 0);
});

for (const hidden of ['target', 'historic reviewer'] as const) {
  test(`committed ${hidden} becoming hidden conceals replay/status without claiming rollback`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.command('execute')).status, 200);
    const saved = f.receipts();
    if (hidden === 'target') f.db.exec('UPDATE physical_loan SET desk = 2 WHERE id = 1');
    else f.db.exec('UPDATE physical_loan SET reviewer_id = 3 WHERE id = 1; UPDATE physical_reviewer SET desk = 2 WHERE id = 1');
    for (const path of ['execute', 'status']) refused(await f.command(path), 403, 'unknown', 'forbidden');
    assert.deepEqual(f.receipts(), saved);
    assert.equal(f.loan().version, 1);
    assert.equal(f.control.calls, 1);
    assert.equal(f.audits().length, 1);
  });
}

for (const role of ['viewer', 'incomplete', 'unknown']) {
  test(
    `current ${role} grants hide commands in metadata and deny fresh execution and committed receipts`,
    { timeout: 10_000 },
    async (t) => {
      const f = await fixture(t);
      const visible = await f.request('/api/app');
      assert.equal(visible.status, 200);
      assert.deepEqual(visible.body.app.grantedCommands, ['assign']);
      assert.deepEqual(visible.body.app.writableTables, []);
      assert.equal((await f.command('execute')).status, 200);
      f.control.identity = { ...account, role };
      for (const path of ['execute', 'status']) {
        refused(await f.command(path), 403, 'unknown', 'forbidden');
        refused(await f.command(path, attempt({ idempotencyKey: 'fresh-denied-attempt-0002' })), 403, 'unknown', 'forbidden');
      }
      assert.equal((await f.command('prepare', prepare())).status, 403);
      const manifest = await f.request('/api/app');
      assert.equal(manifest.status, 200);
      assert.deepEqual(manifest.body.app.grantedCommands, []);
      assert.deepEqual(manifest.body.app.writableTables, []);
      assert.ok(manifest.body.app.nav.every((entry: { actions?: unknown[] }) => !entry.actions?.length));
      assert.equal(f.control.calls, 1);
      assert.equal(f.receipts().length, 1);
    },
  );
}

test('command grants never enable generic CRUD, SQL or unknown command routes', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command('execute')).status, 200);
  const before = f.loan();
  // An App has no Undo: /api/revert answers that, whatever the grants (scopedWrites.ts).
  assert.equal((await f.request('/api/revert', { confirm: true, expectedId: 1 })).status, 404);
  for (const path of [
    '/api/insert',
    '/api/update',
    '/api/delete',
    '/api/undo',
    '/api/undo/prepare',
    '/api/sql',
    '/api/view/compile',
    '/api/commands/unknown',
  ]) {
    const response = await f.request(path, {
      table: 'loan',
      key: { id: 1 },
      values: { version: 99 },
      command: 'assign',
      text: 'UPDATE physical_loan SET version = 99',
    });
    assert.equal(response.status, 403, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(f.loan(), before);
  assert.equal(f.control.calls, 1);
  assert.equal(f.control.fallbackCalls, 0);
});

test('wrong App/connection, stale account and anonymous command requests deny before policy data work', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  for (const path of ['prepare', 'execute', 'status']) {
    const body = path === 'prepare' ? prepare() : attempt();
    for (const query of ['app=other-app', `conn=${owner}`]) {
      refused(await f.command(`${path}?${query}`, body), 403, 'unknown', 'forbidden');
    }
    refused(await f.command(path, body, { headers: { 'x-mistri-account': 'stale-account' } }), 409, 'unknown', 'stale_account');
    f.control.identity = null;
    refused(
      await f.command(path, body, { headers: { 'x-role': 'manager', 'x-forwarded-user': account.id } }),
      401,
      'unknown',
      'unauthenticated',
    );
    f.control.identity = { ...account };
  }
  assert.equal(f.control.verifications, 0);
  assert.equal(f.control.lookups, 0);
  assert.equal(f.control.calls, 0);
  assert.equal(f.control.fallbackCalls, 0);
});

for (const changed of ['identity', 'roles', 'signed out'] as const) {
  test(`verified ${changed} mismatch refuses command outcomes as unknown`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    f.control.verified =
      changed === 'signed out' ? null : { ...account, ...(changed === 'identity' ? { id: 'desk-two' } : { role: 'viewer' }) };
    for (const path of ['prepare', 'execute', 'status']) {
      refused(await f.command(path, path === 'prepare' ? prepare() : attempt()), 403, 'unknown', 'forbidden');
    }
    assert.equal(f.control.calls, 0);
    assert.equal(f.control.lookups, 0);
  });
}

test('strict scoped HTTP envelopes reject forged authority, keys, malformed JSON and byte limits', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  for (const path of ['prepare', 'execute', 'status']) {
    const body = path === 'prepare' ? prepare() : attempt();
    const payloads: unknown[] = [
      null,
      [],
      { ...body, commandVersion: undefined },
      { ...body, commandVersion: 0 },
      { ...body, actor: account },
      { ...body, app: appId },
      { ...body, source: 'lending' },
      { ...body, rows: { loan: true } },
      { ...body, sql: 'SELECT 1' },
      { ...body, key: {} },
      { ...body, key: { id: 1, extra: 2 } },
      { ...body, key: { other: 1 } },
    ];
    for (const payload of payloads) {
      const result = await f.command(path, payload);
      assert.equal(result.status, 400, `${path}: ${JSON.stringify(payload)}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.code, 'invalid_input');
      if (path !== 'prepare') assert.equal(result.body.outcome, 'unknown');
    }
    for (const raw of ['{', JSON.stringify({ ...body, padding: 'é'.repeat(33_000) })]) {
      refused(await f.command(path, body, { raw }), 400, 'unknown', 'invalid_input');
    }
    // Which member, so a caller is not left bisecting a dozen of them — and
    // never a member the sender invented, whose name is the sender's text.
    assert.equal((await f.command(path, { ...body, commandVersion: 0 })).body.field, 'commandVersion');
    assert.match(String((await f.command(path, { ...body, key: { other: 1 } })).body.field), /^key(\.[a-z_]+)?$/);
    const forged = await f.command(path, { ...body, sql: 'SELECT 1' });
    assert.equal(forged.body.field, undefined);
    assert.ok(!JSON.stringify(forged.body).includes('sql'), 'a refusal repeated a name the sender chose');
    assert.equal((await f.request(`/api/commands/${path}`, undefined, { method: 'GET' })).status, 403);
  }
  refused(await f.command('execute', attempt({ commandVersion: 2 })), 409, 'unknown', 'command_version_mismatch');
  assert.equal(f.control.calls, 0);
  assert.equal(f.receipts().length, 0);
});

test('lookup faults remain unknown; confirmed business rollback after receipt absence is not_applied', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  f.control.lookupFailure = true;
  for (const path of ['execute', 'status']) refused(await f.command(path), 503, 'unknown', 'temporarily_unavailable');
  assert.equal(f.control.calls, 0);
  f.control.lookupFailure = false;
  f.control.businessFailure = true;
  const rollback = await f.command('execute');
  refused(rollback, 409, 'not_applied', 'reviewer_unavailable');
  assert.equal(rollback.body.message, 'The selected reviewer is unavailable.');
  assert.equal(f.loan().version, 0);
  assert.equal(f.receipts().length, 0);
  assert.equal(f.audits().length, 0);
  assert.deepEqual((await f.command('status')).body, { status: 'not_found', outcome: 'unknown' });
});

test('lost acknowledgment after SQLite commit remains unknown and exact status/replay reconcile it', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  f.control.lostAcknowledgment = true;
  refused(await f.command('execute'), 503, 'unknown', 'temporarily_unavailable');
  assert.equal(f.loan().version, 1);
  assert.equal(f.receipts().length, 1);
  assert.equal(f.audits().length, 1);
  f.control.lostAcknowledgment = false;
  const status = await f.command('status');
  assert.equal(status.status, 200);
  assert.equal(status.body.replayed, true);
  assert.deepEqual((await f.command('execute')).body, status.body);
  refused(await f.command('execute', attempt({ expectedVersion: 1 })), 409, 'unknown', 'idempotency_conflict');
  assert.equal(f.control.calls, 1);
});

test('concurrent public duplicates share one atomic receipt and a fresh deployment can replay it', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { defer: true });
  const policy = await f.start();
  const responses = await Promise.all([f.command('execute'), f.command('execute')]);
  for (const response of responses) assert.equal(response.status, 200);
  assert.deepEqual(responses.map((response) => response.body.replayed).sort(), [false, true]);
  assert.equal(responses[0].body.receiptId, responses[1].body.receiptId);
  const saved = f.receipts();
  await policy.retire();
  await f.start();
  const status = await f.command('status');
  assert.equal(status.status, 200);
  assert.equal(status.body.receiptId, responses[0].body.receiptId);
  assert.equal(status.body.replayed, true);
  assert.deepEqual(f.receipts(), saved);
  assert.equal(f.control.calls, 1);
  assert.equal(f.audits().length, 1);
  assert.equal(f.control.fallbackCalls, 0);
});

test('current connection write revocation refuses fresh execution and historical receipt disclosure', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.command('execute')).status, 200);
  const saved = f.receipts();
  const config = f.registry.configOf(owner)!;
  config.writable = false;
  for (const path of ['execute', 'status']) {
    refused(await f.command(path), 403, 'unknown', 'forbidden');
    refused(await f.command(path, attempt({ idempotencyKey: 'revoked-writer-attempt-0002' })), 403, 'unknown', 'forbidden');
  }
  assert.equal((await f.command('prepare', prepare())).status, 403);
  assert.deepEqual(f.receipts(), saved);
  assert.equal(f.control.calls, 1);
  assert.equal(f.loan().version, 1);
  config.writable = true;
  assert.equal((await f.command('status')).status, 200);
});

test('prepare validates stored versions and execution rechecks a target hidden after preparation', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  for (const version of [-1, 1.5, 'PRIVATE version', Number.MAX_SAFE_INTEGER]) {
    f.db.prepare('UPDATE physical_loan SET version = ? WHERE id = 1').run(version);
    const invalid = await f.command('prepare', prepare());
    assert.equal(invalid.status, 503);
    assert.equal(invalid.body.code, 'invalid_result');
    assert.equal(Object.hasOwn(invalid.body, 'expectedVersion'), false);
  }
  f.db.exec('UPDATE physical_loan SET version = 0 WHERE id = 1');
  assert.deepEqual((await f.command('prepare', prepare())).body, { expectedVersion: 0 });
  f.db.exec('UPDATE physical_loan SET desk = 2 WHERE id = 1');
  refused(await f.command('execute'), 403, 'unknown', 'forbidden');
  assert.equal(f.control.calls, 0);
  assert.equal(f.control.lookups, 0);
  assert.equal(f.receipts().length, 0);
});

for (const operation of ['writeUndeclared', 'readUndeclared'] as const) {
  test(`command ${operation} refuses and rolls back earlier authorized writes`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    f.control[operation] = true;
    refused(await f.command('execute'), 403, 'not_applied', 'forbidden');
    assert.equal(f.loan().version, 0);
    assert.equal(f.receipts().length, 0);
    assert.equal(f.audits().length, 0);
  });
}

test('policy captures its registry and rejects ambiguous separate createApp command binding', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { defer: true });
  const policy = await f.load();
  assert.ok(policy.commands);
  assert.ok(Object.isFrozen(policy.commands));
  assert.deepEqual(Object.keys(policy.commands), ['assign']);
  assert.throws(() =>
    createApp({ registry: f.registry, bound: f.bound, apps: [f.host], policy, commands: { appId, registry: f.commands } }),
  );
  await f.start(policy);
  assert.equal((await f.command('execute')).status, 200);
  assert.equal(f.control.fallbackCalls, 0);
});

for (const [name, declaration] of [
  ['missing', ''],
  ['empty', 'resultReferences: {},'],
  ['extra', 'resultReferences: { assign: () => [], extra: () => [] },'],
  ['non-function', 'resultReferences: { assign: [] },'],
  ['array', 'resultReferences: [],'],
] as const) {
  test(`startup refuses ${name} resultReferences without running handlers or migrating`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t, { defer: true });
    const before = f.db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
    await assert.rejects(f.load({ file: f.moduleFile(declaration) }), AppRowPolicyDefinitionError);
    assert.deepEqual(f.db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), before);
    assert.equal(f.control.calls, 0);
    assert.equal(f.receipts().length, 0);
  });
}

for (const mode of ['missing journal', 'legacy capability only', 'read-only source'] as const) {
  test(`public command policy startup refuses ${mode} without migration or legacy fallback`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t, { defer: true, migrated: mode !== 'missing journal', writable: mode !== 'read-only source' });
    if (mode === 'legacy capability only') f.adapter.scopeCommandTransaction = undefined;
    const before = f.db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
    await assert.rejects(f.load(), AppRowPolicyDefinitionError);
    assert.deepEqual(f.db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), before);
    assert.equal(f.control.calls, 0);
    assert.equal(f.control.fallbackCalls, 0);
  });
}

for (const write of [true, ['loan']] as const) {
  test(
    `generic write grant ${JSON.stringify(write)} overlapping a command refuses even on an inactive role`,
    { timeout: 10_000 },
    async (t) => {
      const f = await fixture(t, { defer: true });
      f.app.auth!.roles!.inactive = { read: true, write: write === true ? true : [...write] };
      await assert.rejects(f.load(), AppRowPolicyDefinitionError);
      assert.equal(f.control.calls, 0);
    },
  );
}

for (const role of ['manager', 'inactive']) {
  test(`unrelated generic write grants on ${role} roles coexist with scoped commands`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t, { defer: true });
    f.app.auth!.roles![role] = { read: true, commands: ['assign'], write: ['note'] };
    await f.start();
    const manifest = await f.request('/api/app');
    assert.deepEqual(manifest.body.app.grantedCommands, ['assign']);
    assert.deepEqual(manifest.body.app.writableTables, role === 'manager' ? ['note'] : []);
    assert.equal((await f.command('execute')).status, 200);
    assert.equal(f.control.calls, 1);
    assert.equal(f.control.fallbackCalls, 0);
  });
}

/* A scoped write the row policy refused used to answer a bare 503 and log
   nothing: which check, which table, which row was anyone's guess. It is
   permanent for the request, so it is forbidden (403), naming no row. */
test(
  "a scoped refusal is said on the operator's console, and to the author at work, never in a caller's answer",
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    f.control.insertHidden = true;
    const said: string[] = [];
    const error = console.error;
    console.error = (...line: unknown[]) => {
      said.push(line.join(' '));
    };
    try {
      const refusal = await f.command('execute');
      refused(refusal, 403, 'not_applied', 'forbidden');
      assert.match(
        said.join('\n'),
        /POST \/api\/commands\/execute refused \(403 forbidden\)[^]*because: The "physical_loan" row id 9 is outside the principal's rows/,
      );
      assert.equal(f.loan().version, 0);
      // An ordinary account at the author's own server is told nothing more.
      authoringApp(f.host.app.path);
      const quiet = await f.command('execute', attempt({ idempotencyKey: 'scoped-http-attempt-0003' }));
      assert.equal(quiet.status, 403);
      // Its administrator, signed in on this machine at an App served from its source, reads the same reason.
      f.control.identity = { ...account, role: 'manager,admin' };
      const response = await fetch(`http://${f.bound.host}:${f.bound.port}/api/commands/execute?app=${appId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mistri-account': account.id },
        body: JSON.stringify(attempt({ idempotencyKey: 'scoped-http-attempt-0002' })),
      });
      assert.equal(response.status, 403);
      assert.match(String((await response.json()).cause), /row id 9 is outside the principal's rows/);
    } finally {
      console.error = error;
    }
  },
);

test('a root field rule on a command footprint starts, and the command still runs under the row policy', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { defer: true });
  setFieldCeilings(f.app, { reviewer: { read: ['id', 'desk'] } });
  await f.start();
  assert.equal((await f.command('execute')).status, 200);
  assert.equal(f.control.calls, 1);
});

test(
  'a role rule narrowing reads on a command footprint starts, and the command still runs under the row policy',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t, { defer: true });
    f.app.auth!.roles!.manager = { read: true, write: false, commands: ['assign'], fields: { reviewer: { read: ['id', 'desk'] } } };
    await f.start();
    assert.equal((await f.command('execute')).status, 200);
    assert.equal(f.control.calls, 1);
  },
);

test('unrelated field policy remains usable alongside a command and publishes no generic write grants', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { defer: true });
  setFieldCeilings(f.app, { note: { read: ['id'], write: [] } });
  await f.start();
  assert.equal((await f.command('execute')).status, 200);
  const manifest = await f.request('/api/app');
  assert.deepEqual(manifest.body.app.grantedCommands, ['assign']);
  assert.deepEqual(manifest.body.app.writableTables, []);
  assert.equal(f.control.fallbackCalls, 0);
});
