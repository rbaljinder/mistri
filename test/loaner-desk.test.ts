/** The public example's real seed, App and handlers, through HTTP over an owned SQLite file. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { seed } from '../test/fixtures/databases/loaner-desk/seed.mjs';
import { COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { loadApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { loadBusinessCommands, validateBusinessCommandStartup } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';

const appDir = resolve('test/fixtures/apps/loaner-desk');
const account: Identity = { id: 'loaner-staff', who: 'staff@example.test', role: 'staff' };
const today = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const checkout = (idempotencyKey: string, borrower = 'ada', expectedVersion = 0) => ({
  command: 'checkoutEquipment',
  commandVersion: 1,
  key: { id: 'camera' },
  expectedVersion,
  idempotencyKey,
  input: { borrower, due_on: tomorrow() },
});
const returning = (id: number, idempotencyKey: string, expectedVersion = 0) => ({
  command: 'returnEquipment',
  commandVersion: 1,
  key: { id },
  expectedVersion,
  idempotencyKey,
  input: {},
});

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-loaner-desk-test-'));
  const file = seed(join(directory, 'loans.db'));
  const db = new DatabaseSync(file, { timeout: 5000 });
  db.exec('PRAGMA foreign_keys = ON');
  const registry = new Registry();
  let server: ReturnType<typeof createApp> | undefined;
  t.after(async () => {
    try {
      if (server) {
        const closed = new Promise<void>((done) => server!.close(() => done()));
        server.closeAllConnections();
        await closed;
      }
      await registry.closeAll();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  registry.add({ id: 'loaner-desk', name: 'loaner-desk', url: file, writable: true, source: 'config' });
  const loaded = await loadApp(appDir);
  const commands = await loadBusinessCommands(join(appDir, 'commands.ts'));
  let current: Identity | null = account;
  const host: AppHost = {
    app: loaded,
    pages: loaded.pages,
    auth: {
      spec: loaded.app.auth!,
      store: join(directory, 'auth.db'),
      close() {},
      handler: async () => {},
      session: async () => current,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  server = createApp({ registry, bound, apps: [host], commands: { appId: loaded.app.id, registry: commands } });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const base = `http://${bound.host}:${bound.port}`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-mistri-account': account.id },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() };
  };
  const snapshot = () => ({
    equipment: db.prepare('SELECT * FROM equipment ORDER BY id').all(),
    loans: db.prepare('SELECT * FROM equipment_loan ORDER BY id').all(),
    borrowers: db.prepare('SELECT * FROM borrower ORDER BY id').all(),
    receipts: db.prepare(`SELECT * FROM "${COMMAND_JOURNAL_TABLES.receipt}" ORDER BY id`).all(),
    audits: db.prepare(`SELECT * FROM ${sqliteAuditRows} a ORDER BY receipt_id`).all(),
  });
  const execute = (body: unknown) => post('/api/commands/execute', body);
  const prepare = (command = 'checkoutEquipment', key: { id: string | number } = { id: 'camera' }) =>
    post('/api/commands/prepare', { command, commandVersion: 1, key });
  return {
    directory,
    file,
    db,
    registry,
    loaded,
    commands,
    post,
    execute,
    prepare,
    snapshot,
    role: (role: string | null) => {
      current = role === null ? null : { ...account, role };
    },
  };
}

test('Loaner Desk seed refuses replacement and writes an absolute writable config', async (t) => {
  const f = await fixture(t);
  const before = f.snapshot();
  assert.throws(() => seed(f.file), /Refusing to replace/);
  assert.deepEqual(JSON.parse(readFileSync(`${f.file}.json`, 'utf8')), {
    connections: [{ name: 'loaner-desk', url: f.file, writable: true }],
  });
  assert.deepEqual(f.snapshot(), before);
});

test('Loaner Desk concurrent distinct checkouts have one effect and replay the winning receipt', async (t) => {
  const f = await fixture(t);
  const attempts = [checkout('loaner-checkout-race-ada', 'ada'), checkout('loaner-checkout-race-ben', 'ben')];
  for (const attempt of attempts) {
    const prepared = await f.prepare();
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    attempt.expectedVersion = prepared.body.expectedVersion;
    assert.equal(attempt.expectedVersion, 0);
  }
  const beforeDay = today();
  const replies = await Promise.all(attempts.map((attempt) => f.execute(attempt)));
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409], JSON.stringify(replies));
  const winner = replies.findIndex((reply) => reply.status === 200);
  const loser = replies[1 - winner];
  assert.equal(loser.body.code, 'stale_record');
  assert.equal(loser.body.outcome, 'not_applied');
  const stored = f.snapshot();
  assert.equal(stored.loans.length, 1);
  assert.deepEqual(
    { ...stored.loans[0] },
    {
      id: 1,
      equipment_id: 'camera',
      borrower_id: attempts[winner].input.borrower,
      status: 'open',
      checked_out_on: stored.loans[0].checked_out_on,
      due_on: attempts[winner].input.due_on,
      returned_on: null,
      version: 0,
    },
  );
  assert.ok([beforeDay, today()].includes(String(stored.loans[0].checked_out_on)));
  assert.deepEqual({ ...stored.equipment[0] }, { id: 'camera', name: 'Camera kit', status: 'checked_out', version: 1 });
  assert.deepEqual({ ...stored.equipment[1] }, { id: 'projector', name: 'Projector', status: 'available', version: 0 });
  assert.equal(stored.receipts.length, 1);
  assert.equal(stored.audits.length, 1);
  const replay = await f.execute(attempts[winner]);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.receiptId, replies[winner].body.receiptId);
  assert.deepEqual(f.snapshot(), stored);
  const missing = await f.post('/api/commands/status', attempts[1 - winner]);
  assert.equal(missing.body.status, 'not_found');
  const ineligible = await f.execute(checkout('loaner-current-but-unavailable', 'ada', 1));
  assert.equal(ineligible.body.code, 'ineligible_state');
  assert.equal(ineligible.body.outcome, 'not_applied');
  assert.deepEqual(f.snapshot(), stored);
});

test('Loaner Desk returns atomically, rechecks out, and an old return cannot free a new loan', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.execute(checkout('loaner-lifecycle-checkout'))).status, 200);
  const prepared = await f.prepare('returnEquipment', { id: 1 });
  assert.equal(prepared.body.expectedVersion, 0);
  const request = returning(1, 'loaner-lifecycle-return');
  const beforeReturnDay = today();
  const result = await f.execute(request);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const returned = f.snapshot();
  assert.equal(returned.loans[0].status, 'returned');
  assert.ok([beforeReturnDay, today()].includes(String(returned.loans[0].returned_on)));
  assert.equal(returned.loans[0].version, 1);
  assert.equal(returned.equipment[0].status, 'available');
  assert.equal(returned.equipment[0].version, 2);
  const replay = await f.execute(request);
  assert.equal(replay.body.receiptId, result.body.receiptId);
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(f.snapshot(), returned);
  assert.equal((await f.execute(checkout('loaner-lifecycle-again', 'ben', 2))).status, 200);
  const again = f.snapshot();
  assert.equal(again.loans.length, 2);
  assert.equal(again.loans.filter((row) => row.returned_on === null).length, 1);
  assert.equal(again.equipment[0].status, 'checked_out');
  assert.equal(again.equipment[0].version, 3);
  for (const [version, code] of [
    [0, 'stale_record'],
    [1, 'ineligible_state'],
  ] as const) {
    const refused = await f.execute(returning(1, `loaner-old-return-${version}`, version));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, code);
    assert.equal(refused.body.outcome, 'not_applied');
    assert.deepEqual(f.snapshot(), again);
  }
});

test('Loaner Desk invalid input and current eligibility refusals change nothing', async (t) => {
  const f = await fixture(t),
    before = f.snapshot();
  const inputs = [
    [{ borrower: 'ada' }, 'invalid_input'],
    [{ borrower: 'ada', due_on: 'not-a-date' }, 'invalid_input'],
    [{ borrower: 'ada', due_on: '2026-02-30' }, 'invalid_input'],
    [{ borrower: 'ada', due_on: '2000-01-01' }, 'ineligible_state'],
    [{ borrower: 'missing', due_on: tomorrow() }, 'ineligible_state'],
    [{ borrower: 'casey', due_on: tomorrow() }, 'ineligible_state'],
    [{ due_on: tomorrow() }, 'invalid_input'],
  ] as const;
  for (const [i, [input, code]] of inputs.entries()) {
    const result = await f.execute({ ...checkout(`loaner-invalid-${i}`), input });
    assert.equal(result.status, code === 'invalid_input' ? 400 : 409, JSON.stringify(result.body));
    assert.equal(result.body.code, code);
    assert.equal(result.body.outcome, 'not_applied');
    assert.deepEqual(f.snapshot(), before);
  }
  // A borrower eligible when the form opened can become inactive before execution.
  assert.equal((await f.prepare()).status, 200);
  f.db.exec("UPDATE borrower SET active = 0 WHERE id = 'ada'");
  const inactive = f.snapshot();
  const denied = await f.execute(checkout('loaner-borrower-changed'));
  assert.equal(denied.status, 409);
  assert.equal(denied.body.message, 'Choose an active borrower before checking out this item.');
  assert.deepEqual(f.snapshot(), inactive);
});

test('Loaner Desk database constraints protect external writers and allow closed history', async (t) => {
  const f = await fixture(t);
  const insert = f.db.prepare(`INSERT INTO equipment_loan(equipment_id, borrower_id, status, checked_out_on, due_on, returned_on)
    VALUES (?, ?, ?, ?, ?, ?)`);
  insert.run('camera', 'ada', 'open', '2026-09-01', '2026-09-10', null);
  let before = f.snapshot();
  const conflict = await f.execute(checkout('loaner-existing-open-loan'));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.message, 'This item already has an open loan. Return that loan before checking it out again.');
  assert.deepEqual(f.snapshot(), before);
  assert.throws(() => insert.run('camera', 'ben', 'open', '2026-09-01', '2026-09-10', null), /UNIQUE/);
  assert.deepEqual(f.snapshot(), before);
  for (const args of [
    ['projector', 'missing', 'open', '2026-09-01', '2026-09-10', null],
    ['missing', 'ada', 'open', '2026-09-01', '2026-09-10', null],
    ['projector', 'ada', 'returned', '2026-09-01', '2026-09-10', null],
    ['projector', 'ada', 'open', '2026-09-01', '2026-09-10', '2026-09-02'],
    ['projector', 'ada', 'other', '2026-09-01', '2026-09-10', null],
    ['projector', 'ada', 'open', '2026-09-10', '2026-09-01', null],
    ['projector', 'ada', 'returned', '2026-09-10', '2026-09-11', '2026-09-01'],
    ['projector', 'ada', 'open', '2026-02-30', '2026-09-10', null],
    ['projector', 'ada', 'open', '2026-09-01', 'not-a-date', null],
    ['projector', 'ada', 'returned', '2026-09-01', '2026-09-10', 'not-a-date'],
  ]) {
    assert.throws(() => insert.run(...args), /constraint failed/);
    assert.deepEqual(f.snapshot(), before);
  }
  for (const sql of [
    "UPDATE equipment_loan SET status = 'returned' WHERE id = 1",
    "UPDATE equipment_loan SET returned_on = '2026-09-02' WHERE id = 1",
  ]) {
    assert.throws(() => f.db.exec(sql), /CHECK/);
    assert.deepEqual(f.snapshot(), before);
  }
  f.db.exec("UPDATE equipment_loan SET status = 'returned', returned_on = '2026-09-02' WHERE id = 1");
  insert.run('camera', 'ben', 'returned', '2026-09-03', '2026-09-10', '2026-09-04');
  insert.run('camera', 'ada', 'open', '2026-09-05', '2026-09-10', null);
  before = f.snapshot();
  assert.equal(before.loans.length, 3);
  assert.equal(before.loans.filter((row) => row.returned_on === null).length, 1);
  // Availability is maintained by commands, not a cross-table SQL CHECK.
  assert.equal(before.equipment[0].status, 'available');
});

for (const operation of ['checkout', 'return'] as const) {
  test(`Loaner Desk ${operation} rolls back its first write when the second write fails`, async (t) => {
    const f = await fixture(t);
    if (operation === 'return') assert.equal((await f.execute(checkout('loaner-before-failed-return'))).status, 200);
    const before = f.snapshot();
    f.db.exec(
      operation === 'checkout'
        ? "CREATE TRIGGER reject_second BEFORE INSERT ON equipment_loan BEGIN SELECT RAISE(ABORT, 'test second write'); END"
        : "CREATE TRIGGER reject_second BEFORE UPDATE ON equipment WHEN NEW.status = 'available' BEGIN SELECT RAISE(ABORT, 'test second write'); END",
    );
    const request = operation === 'checkout' ? checkout('loaner-failed-checkout') : returning(1, 'loaner-failed-return');
    try {
      const result = await f.execute(request);
      assert.equal(result.status, 503, JSON.stringify(result.body));
      assert.equal(result.body.code, 'temporarily_unavailable');
      assert.equal(result.body.outcome, 'not_applied');
      assert.deepEqual(f.snapshot(), before);
    } finally {
      f.db.exec('DROP TRIGGER reject_second');
    }
    // It was the database fault, not an invalid request: the same envelope now commits.
    const recovered = await f.execute(request);
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.replayed, false);
    assert.equal(f.snapshot().receipts.length, before.receipts.length + 1);
  });
}

test('Loaner Desk viewer cannot command; staff and admin cannot bypass commands with CRUD', async (t) => {
  const f = await fixture(t),
    before = f.snapshot();
  for (const role of ['viewer', null]) {
    f.role(role);
    if (role === 'viewer') {
      const read = await f.post('/api/run', { app: 'loaner-desk', q: 'equipment', exactCount: true });
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.match(JSON.stringify(read.body), /Camera kit/);
    }
    const result = await f.execute(checkout(`loaner-denied-${role}`));
    assert.equal(result.status, role === null ? 401 : 403);
    assert.equal(result.body.outcome, 'not_applied');
    assert.deepEqual(f.snapshot(), before);
  }
  for (const role of ['staff', 'admin']) {
    f.role(role);
    for (const [path, body] of [
      [
        '/api/insert',
        {
          table: 'equipment_loan',
          values: { equipment_id: 'camera', borrower_id: 'ada', status: 'open', checked_out_on: today(), due_on: tomorrow() },
        },
      ],
      ['/api/update', { table: 'equipment', key: { id: 'camera' }, values: { status: 'checked_out' } }],
      ['/api/delete', { table: 'equipment', key: { id: 'camera' } }],
    ] as const) {
      const result = await f.post(path, { app: 'loaner-desk', ...body });
      assert.equal(result.status, 403, `${role} ${path}: ${JSON.stringify(result.body)}`);
      assert.deepEqual(f.snapshot(), before);
    }
  }
  // Admin is also command-only, not an implicit unrestricted database editor.
  assert.equal((await f.execute(checkout('loaner-admin-command'))).status, 200);
  const checkedOut = f.snapshot();
  for (const role of ['staff', 'admin']) {
    f.role(role);
    for (const [path, body] of [
      ['/api/update', { table: 'equipment_loan', key: { id: 1 }, values: { status: 'returned', returned_on: today() } }],
      ['/api/delete', { table: 'equipment_loan', key: { id: 1 } }],
    ] as const) {
      const result = await f.post(path, { app: 'loaner-desk', ...body });
      assert.equal(result.status, 403, JSON.stringify(result.body));
      assert.deepEqual(f.snapshot(), checkedOut);
    }
  }
  f.role('viewer');
  const returned = await f.execute(returning(1, 'loaner-viewer-return'));
  assert.equal(returned.status, 403);
  assert.deepEqual(f.snapshot(), checkedOut);
});

test('Loaner Desk unrestricted status editing is diagnosed from its declared command footprint', async (t) => {
  const f = await fixture(t);
  const app = {
    ...f.loaded.app,
    auth: {
      ...f.loaded.app.auth!,
      roles: {
        ...f.loaded.app.auth!.roles,
        staff: { read: true as const, write: true as const, commands: ['checkoutEquipment', 'returnEquipment'] },
      },
    },
  };
  const resources = await loadAppRuntimeResources(f.registry, app, 'loaner-desk');
  await assert.rejects(
    validateBusinessCommandStartup(app, f.commands, resources, () => true),
    /\[command-and-edit\]/,
  );
});
