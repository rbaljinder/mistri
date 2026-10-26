/**
 * The decision store (adapters/decide/): provisioned once, attested exactly,
 * and every statement scoped to its App and tenant — on SQLite always and on
 * PostgreSQL when TABLEWALK_TEST_PG names a server (a database of its own,
 * dropped at the end). Values are never stored: a row holds input names and a
 * digest, the answer and its probability.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { DecisionStore } from '../packages/mistri/src/adapters/decide/decisionStore.js';
import { openPostgresDecisions, provisionPostgresDecisions } from '../packages/mistri/src/adapters/decide/postgresDecisions.js';
import { openSqliteDecisions, provisionSqliteDecisions } from '../packages/mistri/src/adapters/decide/sqliteDecisions.js';
import { isRuntimeTable, runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { reservedInText } from '../packages/engine/src/adapters/reservedSql.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

interface Engine {
  store: DecisionStore;
  /** Run DDL beside the store, as an operator by hand would. */
  exec(sql: string): Promise<void>;
  reopen(): Promise<DecisionStore>;
}

async function sqliteEngine(t: TestContext): Promise<Engine> {
  const directory = mkdtempSync(join(tmpdir(), 'tw-decide-store-'));
  const file = join(directory, 'app.db');
  const control = new DatabaseSync(file);
  control.exec('CREATE TABLE incident (id INTEGER PRIMARY KEY, category TEXT)');
  assert.deepEqual(provisionSqliteDecisions(file), { version: 1, provisioned: true });
  assert.deepEqual(provisionSqliteDecisions(file), { version: 1, provisioned: false });
  const opened: DecisionStore[] = [];
  t.after(async () => {
    for (const store of opened) await store.close();
    control.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const open = async () => {
    const store = openSqliteDecisions(file);
    opened.push(store);
    return store;
  };
  return { store: await open(), exec: async (sql) => control.exec(sql), reopen: open };
}

async function postgresEngine(t: TestContext): Promise<Engine> {
  const module = 'pg';
  const pg = (await import(module)) as {
    default: { Client: new (options: unknown) => { connect(): Promise<void>; query(sql: string): Promise<unknown>; end(): Promise<void> } };
  };
  const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 10000 });
  await control.connect();
  const name = `tw_decide_${randomUUID().replaceAll('-', '')}`;
  await control.query(`CREATE DATABASE "${name}"`);
  const url = new URL(LIVE!);
  url.pathname = `/${name}`;
  const own = new pg.default.Client({ connectionString: url.href, statement_timeout: 10000 });
  await own.connect();
  const opened: DecisionStore[] = [];
  t.after(async () => {
    for (const store of opened) await store.close();
    await own.end();
    await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await control.end();
  });
  assert.deepEqual(await provisionPostgresDecisions(url.href), { version: 1, provisioned: true });
  assert.deepEqual(await provisionPostgresDecisions(url.href), { version: 1, provisioned: false });
  const open = async () => {
    const store = await openPostgresDecisions(url.href);
    opened.push(store);
    return store;
  };
  return {
    store: await open(),
    exec: async (sql) => {
      await own.query(sql);
    },
    reopen: open,
  };
}

const ENGINES = [
  { name: 'sqlite', open: sqliteEngine, skip: false as const },
  { name: 'postgres', open: postgresEngine, skip: liveSkip('postgres', LIVE) },
];

const app = { app: 'desk', tenant: '' };
const start = (id: string, decision = 'triageCategory', recordKey = '{"id":1}') => ({
  id,
  decision,
  contractVersion: 1,
  resource: 'incident',
  recordKey,
  field: 'category',
  trigger: 'event:ticketOpened#e1',
  inputFields: ['short_description', 'caller_id.company_id.name'],
  createdAt: '2026-10-23T10:00:00.000Z',
});
const answered = (outcome: 'applied' | 'suggested' | 'below' | 'none', answer: unknown = 'network', probability: number | null = 0.9) => ({
  provider: 'jev',
  model: 'jev-1',
  modelVersion: 'jev-1-2026-10',
  inputsDigest: 'a'.repeat(64),
  choicesDigest: '',
  answer,
  probability,
  outcome,
  outcomeReason: '' as const,
  latencyMs: 120,
  costMicros: 300,
  units: 1,
  at: '2026-10-23T10:00:01.000Z',
});

test('the reserved __mistri_ prefix is runtime state everywhere __mistri_ is', () => {
  assert.equal(isRuntimeTable('__mistri_decision_record'), true);
  assert.equal(isRuntimeTable('__MISTRI_decision_usage'), true);
  assert.equal(isRuntimeTable('mistri_decision'), false);
  assert.match(reservedInText('SELECT * FROM __mistri_decision_record', 'sqlite') ?? '', /__mistri_decision_record/);
});

for (const engine of ENGINES) {
  test(`${engine.name}: a decision begins once, is answered once, and moves only as an outcome may`, { skip: engine.skip }, async (t) => {
    const { store } = await engine.open(t);
    const first = await store.begin(app, start('d1'));
    assert.equal(first.fresh, true);
    assert.equal(first.row.outcome, 'none');
    assert.equal(first.row.outcomeReason, 'pending');
    assert.deepEqual(first.row.inputFields, ['short_description', 'caller_id.company_id.name']);
    // A retry, or a second host, finds the row it began.
    const again = await store.begin(app, start('d1'));
    assert.equal(again.fresh, false);
    assert.equal(await store.answer(app, 'd1', answered('suggested')), true);
    assert.equal(await store.answer(app, 'd1', answered('applied')), false, 'answered once');
    const row = (await store.get(app, 'd1'))!;
    assert.equal(row.outcome, 'suggested');
    assert.equal(row.answer, 'network');
    assert.equal(row.probability, 0.9);
    assert.equal(row.modelVersion, 'jev-1-2026-10');
    // Another tenant does not find it, and cannot move it.
    assert.equal(await store.get({ app: 'desk', tenant: 'acme' }, 'd1'), null);
    assert.equal(await store.settle({ app: 'desk', tenant: 'acme' }, 'd1', { outcome: 'accepted', reason: '', by: 'x', at: 'y' }), false);
    assert.deepEqual(
      (await store.waiting(app, 'incident', ['{"id":1}', '{"id":2}'])).map((each) => each.id),
      ['d1'],
    );
    assert.equal(
      await store.settle(app, 'd1', { outcome: 'corrected', reason: '', correctedTo: 'hardware', by: 'ana@example.test', at: 'z' }),
      true,
    );
    const corrected = (await store.get(app, 'd1'))!;
    assert.deepEqual([corrected.outcome, corrected.correctedTo, corrected.outcomeBy], ['corrected', 'hardware', 'ana@example.test']);
    assert.equal(await store.settle(app, 'd1', { outcome: 'accepted', reason: '', by: 'x', at: 'y' }), false, 'a correction is final');
    assert.deepEqual(await store.waiting(app, 'incident', ['{"id":1}']), []);
    // A list answer is kept as its keys.
    await store.begin(app, start('d2', 'labels'));
    await store.answer(app, 'd2', answered('below', [3, 7], 0.4));
    assert.deepEqual((await store.get(app, 'd2'))!.answer, [3, 7]);
    assert.deepEqual((await store.ofRecord(app, 'incident', '{"id":1}', 10)).map((each) => each.id).sort(), ['d1', 'd2']);
  });

  test(
    `${engine.name}: usage counts calls per tenant and day; switches are per provider; a closing tenant's rows go`,
    { skip: engine.skip },
    async (t) => {
      const { store } = await engine.open(t);
      const acme = { app: 'desk', tenant: 'acme' };
      await Promise.all([
        store.spend(acme, '2026-10-23', 1, 300),
        store.spend(acme, '2026-10-23', 2, 500),
        store.spend(app, '2026-10-23', 1, 1),
      ]);
      assert.deepEqual(await store.calls(acme, '2026-10-23'), { tenant: 2, app: 3 });
      assert.deepEqual(await store.usage('desk', 'acme', '2026-10-01'), [
        { tenant: 'acme', day: '2026-10-23', calls: 2, units: 3, costMicros: 800 },
      ]);
      assert.equal((await store.usage('desk', undefined, '2026-10-01')).length, 2);
      await store.setSwitch('desk', 'acme', 'jev', true, 'DPA-17', '2026-10-23T00:00:00Z');
      await store.setSwitch('desk', 'acme', 'jev', false, 'DPA-17', '2026-10-24T00:00:00Z');
      await store.setSwitch('desk', 'acme', 'anthropic', true, 'DPA-18', '2026-10-24T00:00:00Z');
      assert.deepEqual(
        (await store.switches('desk', 'acme')).map(({ provider, enabled }) => [provider, enabled]),
        [
          ['anthropic', true],
          ['jev', false],
        ],
      );
      await store.begin(acme, start('a1'));
      assert.equal(await store.forgetTenant('desk', 'acme'), 1);
      assert.equal(await store.get(acme, 'a1'), null);
      assert.deepEqual(await store.switches('desk', 'acme'), []);
      assert.equal((await store.usage('desk', 'acme', '2026-10-01')).length, 1, 'usage rows stay, for the bill');
    },
  );

  test(`${engine.name}: retention removes old rows and ignores suggestions left past fourteen days`, { skip: engine.skip }, async (t) => {
    const { store } = await engine.open(t);
    await store.begin(app, { ...start('old'), createdAt: '2025-01-01T00:00:00.000Z' });
    await store.begin(app, { ...start('stale'), createdAt: '2026-10-01T00:00:00.000Z' });
    await store.answer(app, 'stale', answered('suggested'));
    await store.begin(app, start('fresh'));
    await store.answer(app, 'fresh', answered('suggested'));
    const swept = await store.purge('desk', '2025-10-23T00:00:00.000Z', '2026-10-09T00:00:00.000Z', '2026-10-23T12:00:00.000Z');
    assert.deepEqual(swept, { removed: 1, expired: 1 });
    assert.deepEqual([(await store.get(app, 'stale'))!.outcome, (await store.get(app, 'stale'))!.outcomeReason], ['ignored', 'expired']);
    assert.equal((await store.get(app, 'fresh'))!.outcome, 'suggested');
  });

  test(`${engine.name}: a store changed by hand is not opened`, { skip: engine.skip }, async (t) => {
    const fixture = await engine.open(t);
    await fixture.exec(
      engine.name === 'postgres'
        ? `CREATE INDEX decision_extra ON ${runtimeTable('postgres', '__mistri_decision_usage')} (day)`
        : 'CREATE INDEX __mistri_decision_extra ON __mistri_decision_usage (day)',
    );
    await assert.rejects(() => fixture.reopen(), { name: 'DecisionStoreUnavailable' });
  });
}
