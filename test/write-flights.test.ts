/**
 * What one save costs in database round trips, App by App, against a real
 * PostgreSQL (TABLEWALK_TEST_PG) behind a 10 ms relay.
 *
 * The shape a save should have: flight 1 is the BEGIN with everything sent
 * ahead of it, then one flight per awaited write or dependent read, then one
 * final flight (receipt, audit, live change and COMMIT). Each App's ordinary
 * write goes through its own HTTP routes, warm (an earlier write of the same
 * shape has cached the catalog and the attestation), and the flights its own
 * transaction takes are held to the budget below. The numbers are what is
 * measured now; they only come down.
 *
 * TABLEWALK_FLIGHTS_PRINT=1 prints each measured request's statements by flight.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';
import { copySqliteToPostgres } from './support/sqliteToPostgres.js';
import { byFlight, startRig, type Measured, type Rig } from './support/writeFlights.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const PRINT = process.env.TABLEWALK_FLIGHTS_PRINT === '1';
const DUMP = process.env.TABLEWALK_FLIGHTS_DUMP;

interface Budget {
  prepare?: number;
  execute: number;
}

/**
 * One entry per App: its write and the flights that write's own transaction may take.
 * Each line says what the flights are. Every write here is planned: the ahead report
 * shows statements sent behind its BEGIN and taken (`within` holds it to that), so a
 * write that falls back to one flight per statement fails here before it fails the budget.
 * Before the unscoped path sent ahead, they were tick 4, thread 6, compass 5, payday 3/12,
 * forecourt 1/10, depot 3/17 and commons 3/7. Before reads asked together left together, a held row
 * was read whole once (`widen`) and history's read after an update rode behind it, they were
 * payday 10, depot 15 and commons 4.
 */
const BUDGETS: Record<string, { write: string; budget: Budget }> = {
  // 3: BEGIN with the row's lock and row behind it, the UPDATE, COMMIT.
  tick: { write: 'update:complete', budget: { execute: 3 } },
  // 3: BEGIN with lock and row (which answers the guard: the record, in the state it moves from), the UPDATE, COMMIT.
  thread: { write: 'update:markReady', budget: { execute: 3 } },
  // 4: BEGIN with lock and row, the UPDATE, the row read back, COMMIT.
  compass: { write: 'update:startWorking', budget: { execute: 4 } },
  /* prepare 2: BEGIN with the row read behind it, COMMIT. execute 7: BEGIN with lock and row, the handler's balance
     read and its UPDATE (each awaited), the request read whole again once (the balance's write dropped what was kept;
     its lock keeps it from moving, so that one read answers the machine and history's before image), the request's
     UPDATE with history's read after it behind it, the inbox notice's recipient, the notice with COMMIT. */
  payday: { write: 'approveTimeOff', budget: { prepare: 2, execute: 7 } },
  /* prepare 1: a single read outside a transaction. execute 6 under the row policy: BEGIN with lock and scoped row,
     the guarded read (asked in its turn), the UPDATE with its read back, the activity INSERT, then its lock, its
     scoped read and its parent's lock and count sent together, COMMIT. */
  forecourt: { write: 'closeInquiry', budget: { prepare: 1, execute: 6 } },
  /* prepare 2 / execute 11, for a pick list of one line (it grows with the lines: each is awaited). The line's product
     and its stock levels are asked together and leave in one flight; the list's UPDATE carries history's read after it. */
  depot: { write: 'pickList', budget: { prepare: 2, execute: 11 } },
  // prepare 2 / execute 3: BEGIN with lock and row (which answers the guard), the UPDATE with history's read after it behind it, history with COMMIT.
  commons: { write: 'lockThread', budget: { prepare: 2, execute: 3 } },
  // Ignition is a tenant App (tenant store, membership fence): e2e/write-storm.spec.ts measures its Qualify lead save
  // (prepare 2 flights, execute 3), so it is not repeated here.
};

/* Every seed dates its rows back from today unless told otherwise, and what it makes on a given day differs: run on
   2026-10-26 the Depot seed left no single-line list to pick, where on 2026-10-25 it left two. Each seed's clock is
   pinned, so a test picks from the same rows whatever day it runs (Depot's 2026-10-21 leaves three to choose from). */
const SEED_CLOCKS = {
  MISTRI_CRM_TODAY: '2026-08-30',
  DEPOT_TODAY: '2026-10-21',
  COMMONS_TODAY: '2026-10-21',
  FORECOURT_TODAY: '2026-10-21',
};

const child = (script: string, ...args: string[]) =>
  execFileSync(process.execPath, ['--import', 'tsx', resolve(script), ...args], {
    stdio: 'pipe',
    env: { ...process.env, ...SEED_CLOCKS },
  });

/** Print and, for the report, dump a measured request. */
function show(app: string, label: string, measured: Measured) {
  const ahead =
    measured.ahead
      .map((report) => `sent ${report.sent} taken ${report.taken} answered ${report.answered} missed ${report.missed}`)
      .join('; ') || 'no report (fallback)';
  const text = `${app} ${label}: ${measured.flights} flights, ${measured.statements.length} statements, ahead: ${ahead}\n${byFlight(measured.statements)}\n`;
  if (PRINT) console.log(text);
  if (DUMP) {
    mkdirSync(DUMP, { recursive: true });
    writeFileSync(join(DUMP, `${app}.txt`), text, { flag: 'a' });
  }
}

function within(app: string, label: 'prepare' | 'execute', measured: Measured) {
  const budget = BUDGETS[app]!.budget[label];
  assert.ok(budget !== undefined, `${app} has no ${label} budget`);
  assert.ok(
    measured.flights <= budget,
    `${app} ${label} took ${measured.flights} flights, over the ${budget} budgeted:\n${byFlight(measured.statements)}`,
  );
  // Planned: what it opens with went behind its BEGIN and answered its own statements. A read outside a transaction has no BEGIN to send behind.
  if (measured.statements.some((statement) => /^\s*BEGIN/i.test(statement.text)))
    assert.ok(
      measured.ahead.some((report) => report.sent > 0 && report.taken > 0),
      `${app} ${label} fell back: nothing was sent behind its BEGIN, or nothing sent was taken:\n${byFlight(measured.statements)}`,
    );
}

/** A command, prepared then executed as the browser's form does, each request measured. */
async function command(server: Rig, id: string, key: number, input: Record<string, unknown>, measure = true) {
  const prepare = { command: id, commandVersion: 1, key: { id: key } };
  const prepared = measure
    ? await server.post('/api/commands/prepare', prepare)
    : { ...(await server.warm('/api/commands/prepare', prepare)), flights: 0, statements: [], ahead: [] };
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const body = { ...prepare, expectedVersion: prepared.body.expectedVersion, idempotencyKey: `flights-${randomUUID()}`, input };
  const executed = measure
    ? await server.post('/api/commands/execute', body)
    : { ...(await server.warm('/api/commands/execute', body)), flights: 0, statements: [], ahead: [] };
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  return { prepared: prepared as Measured, executed: executed as Measured };
}

describe('a save’s round trips, App by App, on PostgreSQL', { skip: liveSkip('postgres', LIVE) }, () => {
  const cleanups: Array<() => Promise<void>> = [];
  after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  });

  async function database(prefix: string) {
    const owned = await uuidPostgresDatabase(prefix);
    cleanups.push(owned.drop);
    const pg = await pgClient(owned.url);
    cleanups.push(() => pg.end());
    return { ...owned, pg };
  }
  async function rig(options: Parameters<typeof startRig>[0]): Promise<Rig> {
    const started = await startRig(options);
    cleanups.push(() => started.close());
    return started;
  }

  test('Compass: start working a lead', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-flights-crm-'));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const source = join(dir, 'crm.db');
    child('test/fixtures/databases/crm/make-crm-db.mjs', source);
    const db = await database('tw_flights_crm');
    child('test/fixtures/databases/crm/seed-postgres.mjs', db.url, source);
    const server = await rig({ appDir: 'test/fixtures/apps/crm', connection: 'crm', url: db.url });
    const fresh = (await db.pg.query(`SELECT id FROM lead WHERE status = 'new' ORDER BY id LIMIT 2`)).rows as Array<{ id: number }>;
    const update = (id: number) => ({ app: 'compass', table: 'lead', key: { id }, values: { status: 'working' } });
    const warmed = await server.warm('/api/update', update(fresh[0]!.id));
    assert.equal(warmed.status, 200, JSON.stringify(warmed.body));
    const measured = await server.post('/api/update', update(fresh[1]!.id));
    assert.equal(measured.status, 200, JSON.stringify(measured.body));
    show('compass', 'update', measured);
    assert.equal((await db.pg.query('SELECT status FROM lead WHERE id = $1', [fresh[1]!.id])).rows[0].status, 'working');
    within('compass', 'execute', measured);
  });
  test('Tick: complete a task', async () => {
    const db = await database('tw_flights_tick');
    await db.pg.query(`CREATE TABLE task (
      id integer PRIMARY KEY, name text NOT NULL, completed boolean NOT NULL DEFAULT false, due_on date, position double precision)`);
    await db.pg.query(`INSERT INTO task VALUES
      (1, 'Plan the week', false, '2026-09-07', 1024), (2, 'Water the plants', false, NULL, 2048),
      (3, 'Return the library book', false, '2026-09-10', 3072), (4, 'Clear the desk', true, NULL, 4096)`);
    const server = await rig({ appDir: 'examples/apps/tick', connection: 'tick', url: db.url });
    const complete = (id: number) => ({ app: 'tick', table: 'task', key: { id }, values: { completed: true } });
    assert.equal((await server.warm('/api/update', complete(1))).status, 200);
    const measured = await server.post('/api/update', complete(3));
    assert.equal(measured.status, 200, JSON.stringify(measured.body));
    show('tick', 'update', measured);
    assert.equal((await db.pg.query('SELECT completed FROM task WHERE id = 3')).rows[0].completed, true);
    within('tick', 'execute', measured);
  });

  test('Thread: mark an issue ready', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-flights-thread-'));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const source = join(dir, 'thread.db');
    child('test/fixtures/databases/thread/seed.mjs', source);
    const db = await database('tw_flights_thread');
    await copySqliteToPostgres(source, db.pg);
    const server = await rig({ appDir: 'test/fixtures/apps/thread', connection: 'thread', url: db.url });
    const backlog = (await db.pg.query(`SELECT id FROM issue WHERE status = 'backlog' ORDER BY id LIMIT 2`)).rows as Array<{ id: number }>;
    const ready = (id: number) => ({ app: 'thread', table: 'issue', key: { id }, values: { status: 'ready' } });
    const warmed = await server.warm('/api/update', ready(backlog[0]!.id));
    assert.equal(warmed.status, 200, JSON.stringify(warmed.body));
    const measured = await server.post('/api/update', ready(backlog[1]!.id));
    assert.equal(measured.status, 200, JSON.stringify(measured.body));
    show('thread', 'update', measured);
    assert.equal((await db.pg.query('SELECT status FROM issue WHERE id = $1', [backlog[1]!.id])).rows[0].status, 'ready');
    within('thread', 'execute', measured);
  });

  test('Payday: approve a time-off request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-flights-payday-'));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const source = join(dir, 'payday.db');
    child('test/fixtures/databases/payday/seed.mjs', source);
    const db = await database('tw_flights_payday');
    await copySqliteToPostgres(source, db.pg);
    const server = await rig({
      appDir: 'test/fixtures/apps/payday',
      connection: 'payday',
      url: db.url,
      identity: { id: 'payday-manager', who: 'manager@example.test', role: 'payroll_manager' },
      commands: true,
      stores: ['inbox'],
    });
    /* Requests the balance covers, so the approval is the ordinary one and not a refusal. */
    const pending = (
      await db.pg.query(
        `SELECT t.id FROM time_off t JOIN time_off_balance b ON b.employee_id = t.employee_id AND b.policy_id = t.policy_id
         WHERE t.status = 'pending' AND b.available_hours >= t.hours ORDER BY t.id LIMIT 2`,
      )
    ).rows as Array<{ id: number }>;
    assert.equal(pending.length, 2);
    const approve = (id: number, check: boolean) => command(server, 'approveTimeOff', id, {}, check);
    await approve(pending[0]!.id, false);
    const { prepared, executed } = await approve(pending[1]!.id, true);
    show('payday', 'prepare', prepared);
    show('payday', 'execute', executed);
    assert.equal((await db.pg.query('SELECT status FROM time_off WHERE id = $1', [pending[1]!.id])).rows[0].status, 'approved');
    within('payday', 'prepare', prepared);
    within('payday', 'execute', executed);
  });

  test('Forecourt: close an inquiry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-flights-forecourt-'));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const db = await database('tw_flights_fc');
    child('test/fixtures/databases/forecourt/seed-postgres.mjs', db.url, join(dir, 'forecourt.json'));
    const server = await rig({
      appDir: 'test/fixtures/apps/forecourt',
      connection: 'forecourt',
      url: db.url,
      identity: { id: 'staff-one', who: 'staff@example.test', role: 'staff' },
      commands: true,
      policy: 'test/fixtures/apps/forecourt/policy.ts',
    });
    const open = (await db.pg.query(`SELECT id FROM inquiry WHERE status IN ('new', 'replied') ORDER BY id LIMIT 2`)).rows as Array<{
      id: number;
    }>;
    assert.equal(open.length, 2);
    const close = (id: number, measure: boolean) => command(server, 'closeInquiry', id, { note: 'Resolved by phone.' }, measure);
    await close(open[0]!.id, false);
    const { prepared, executed } = await close(open[1]!.id, true);
    show('forecourt', 'prepare', prepared);
    show('forecourt', 'execute', executed);
    assert.equal((await db.pg.query('SELECT status FROM inquiry WHERE id = $1', [open[1]!.id])).rows[0].status, 'closed');
    within('forecourt', 'prepare', prepared);
    within('forecourt', 'execute', executed);
  });

  test('Depot: pick a pick list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-flights-depot-'));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const source = join(dir, 'depot.db');
    child('test/fixtures/databases/depot/seed.mjs', source);
    const db = await database('tw_flights_depot');
    child('test/fixtures/databases/depot/seed-postgres.mjs', db.url, source);
    const server = await rig({
      appDir: 'test/fixtures/apps/depot',
      connection: 'depot',
      url: db.url,
      identity: { id: 'depot-operator', who: 'operator@example.test', role: 'operator' },
      commands: true,
    });
    /* The shortest lists the stock covers, so the loop over lines is short and the count steady. */
    const lists = (
      await db.pg.query(
        `SELECT p.id FROM pick_list p JOIN order_line l ON l.sales_order_id = p.sales_order_id
         WHERE p.status = 'to_pick' GROUP BY p.id HAVING count(*) = 1 ORDER BY p.id LIMIT 12`,
      )
    ).rows as Array<{ id: number }>;
    const picked: number[] = [];
    let result: Awaited<ReturnType<typeof command>> | undefined;
    for (const list of lists) {
      /* A list the shelves cannot fill is refused; take the next. */
      try {
        const attempt = await command(server, 'pickList', list.id, {}, picked.length > 0);
        picked.push(list.id);
        result = attempt;
        if (picked.length === 2) break;
      } catch {
        continue;
      }
    }
    assert.equal(picked.length, 2, 'two single-line lists the stock covers');
    const { prepared, executed } = result!;
    show('depot', 'prepare', prepared);
    show('depot', 'execute', executed);
    assert.equal((await db.pg.query('SELECT status FROM pick_list WHERE id = $1', [picked[1]!])).rows[0].status, 'picked');
    within('depot', 'prepare', prepared);
    within('depot', 'execute', executed);
  });

  test('Commons: lock a thread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-flights-commons-'));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const db = await database('tw_flights_commons');
    child('test/fixtures/databases/commons/seed-postgres.mjs', db.url, join(dir, 'commons.json'));
    const server = await rig({
      appDir: 'test/fixtures/apps/commons',
      connection: 'commons',
      url: db.url,
      identity: { id: 'commons-moderator', who: 'moderator@example.test', role: 'moderator' },
      commands: true,
    });
    const open = (await db.pg.query(`SELECT id FROM thread WHERE status = 'open' ORDER BY id LIMIT 2`)).rows as Array<{ id: number }>;
    assert.equal(open.length, 2);
    await command(server, 'lockThread', open[0]!.id, {}, false);
    const { prepared, executed } = await command(server, 'lockThread', open[1]!.id, {});
    show('commons', 'prepare', prepared);
    show('commons', 'execute', executed);
    assert.equal((await db.pg.query('SELECT status FROM thread WHERE id = $1', [open[1]!.id])).rows[0].status, 'locked');
    within('commons', 'prepare', prepared);
    within('commons', 'execute', executed);
  });
});
