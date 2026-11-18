/**
 * Proposals and provenance marks at the journal boundary (commandProposals.ts), on SQLite always and on a live
 * PostgreSQL server when TABLEWALK_TEST_PG names one: a proposal is created and read back in its tenant only, leaves
 * 'proposed' once however many decide it at once, expires after its window, and a mark stays unconfirmed until a
 * person confirms it.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import {
  CommandTransactionFailure,
  createSqliteCommandJournal,
  migrateSqliteCommandJournal,
  type CommandJournal,
  type CommandJournalTenant,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { CommandProposalRow, ProvenanceRow } from '../packages/mistri/src/adapters/commands/commandJournalTypes.js';
import {
  createPostgresCommandJournal,
  migratePostgresCommandJournal,
} from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { liveSkip } from './live.js';

const owner = (tenantId: string): CommandJournalTenant => ({
  appId: 'app',
  storeId: 'store',
  sourceId: 'business',
  tenantId,
  actorId: 'alice',
  membershipId: `grant-${tenantId}`,
  membershipVersion: '1',
  tenantVersion: '1',
  roles: ['editor'],
  deployment: 'deployment',
});
const north = owner('north'),
  south = owner('south');
const NOW = Date.UTC(2026, 10, 17, 12);
const DAY = 24 * 60 * 60 * 1000;
const newId = () => randomBytes(16).toString('base64url');

const proposal = (overrides: Partial<CommandProposalRow> = {}): CommandProposalRow => ({
  id: newId(),
  app: 'app',
  tenant: 'north',
  command: 'assign',
  target: '{"id":1}',
  input: { reviewer: 'bo' },
  actorKind: 'assistant',
  actor: 'assistant:triage',
  model: 'model-a',
  modelVersion: '2026-11',
  costMicros: 1200,
  evidence: [{ kind: 'record', ref: 'loans/1', label: 'Loan 1', quote: 'needs a reviewer' }],
  reason: 'Bo reviews this kind of loan.',
  state: 'proposed',
  decidedBy: null,
  decidedAt: null,
  receiptId: null,
  createdAt: NOW,
  expiresAt: NOW + 14 * DAY,
  ...overrides,
});
const mark = (overrides: Partial<ProvenanceRow> = {}): ProvenanceRow => ({
  id: newId(),
  app: 'app',
  tenant: 'north',
  resource: 'loans',
  rowKey: '{"id":1}',
  field: 'assignee',
  actorKind: 'job',
  actor: 'job:nightly',
  evidence: [],
  createdAt: NOW,
  confirmedBy: null,
  confirmedAt: null,
  ...overrides,
});

type Run = <T>(bound: CommandJournalTenant, work: (journal: CommandJournal) => Promise<T>) => Promise<T>;
/** A journal member by name: they are optional on the interface, and present on both engines. */
const at = <K extends keyof CommandJournal>(journal: CommandJournal, key: K) => {
  const found = journal[key];
  assert.ok(found, `${String(key)} is a member`);
  return found as NonNullable<CommandJournal[K]>;
};
const refusedFor = (error: unknown) => (error instanceof CommandTransactionFailure ? (error.cause ?? error) : error);

/** The cases both engines answer alike. */
function journalCases(engine: string, run: () => Run, reset: () => Promise<void>) {
  test(`${engine}: a proposal reads back whole in its tenant and is listed by command and state, newest first`, async () => {
    await reset();
    const first = proposal({ createdAt: NOW - 1000 }),
      second = proposal({ createdAt: NOW, command: 'close', target: null }),
      third = proposal({ createdAt: NOW + 1000, actorKind: 'flow', actor: 'flow:intake' });
    await run()(north, async (journal) => {
      for (const row of [first, second, third]) await at(journal, 'createProposal')(row);
    });
    const read = await run()(north, (journal) => at(journal, 'readProposal')('app', first.id));
    assert.deepEqual(read, first);
    const listed = await run()(north, (journal) => at(journal, 'listProposals')('app', { commands: ['assign'], limit: 10 }));
    assert.deepEqual(
      listed.map((row) => row.id),
      [third.id, first.id],
    );
    const both = await run()(north, (journal) =>
      at(journal, 'listProposals')('app', { commands: ['assign', 'close'], states: ['proposed'], limit: 2 }),
    );
    assert.deepEqual(
      both.map((row) => row.id),
      [third.id, second.id],
    );
    assert.deepEqual(await run()(north, (journal) => at(journal, 'listProposals')('app', { commands: [], limit: 10 })), []);
    assert.deepEqual(
      await run()(north, (journal) => at(journal, 'listProposals')('app', { commands: ['assign'], states: ['approved'], limit: 10 })),
      [],
    );
    assert.equal(await run()(north, (journal) => at(journal, 'readProposal')('app', 'not-an-id')), undefined);
  });

  test(`${engine}: a malformed proposal, or one for another tenant or App, is refused and nothing is written`, async () => {
    await reset();
    for (const bad of [
      proposal({ tenant: 'south' }),
      proposal({ app: 'other' }),
      proposal({ id: 'short' }),
      proposal({ actorKind: 'person' as never }),
      proposal({ state: 'pending' as never }),
      proposal({ evidence: [{ kind: 'rumour', ref: 'x', label: 'x' }] as never }),
      proposal({ reason: 'x'.repeat(4096) }),
      proposal({ input: [] as never }),
    ])
      await assert.rejects(run()(north, (journal) => at(journal, 'createProposal')(bad)));
    assert.deepEqual(await run()(north, (journal) => at(journal, 'listProposals')('app', { commands: ['assign'], limit: 10 })), []);
  });

  test(`${engine}: a decision takes a live proposal once; a second is told it was taken; another command's is missing`, async () => {
    await reset();
    const row = proposal();
    await run()(north, (journal) => at(journal, 'createProposal')(row));
    assert.equal(
      await run()(north, (journal) => at(journal, 'decideProposal')('app', row.id, 'close', 'approved', 'bo', NOW + 1)),
      'missing',
    );
    assert.equal(
      await run()(north, (journal) => at(journal, 'decideProposal')('app', row.id, 'assign', 'approved', 'bo', NOW + 1)),
      'decided',
    );
    assert.equal(
      await run()(north, (journal) => at(journal, 'decideProposal')('app', row.id, 'assign', 'dismissed', 'cy', NOW + 2)),
      'taken',
    );
    assert.equal(
      await run()(north, (journal) => at(journal, 'decideProposal')('app', newId(), 'assign', 'approved', 'bo', NOW + 2)),
      'missing',
    );
    const decided = await run()(north, (journal) => at(journal, 'readProposal')('app', row.id));
    assert.equal(decided?.state, 'approved');
    assert.equal(decided?.decidedBy, 'bo');
    assert.equal(decided?.decidedAt, NOW + 1);
    // The receipt is settled once, and only on an approved proposal.
    assert.equal(await run()(north, (journal) => at(journal, 'settleProposal')('app', row.id, 'receipt-1')), true);
    assert.equal(await run()(north, (journal) => at(journal, 'settleProposal')('app', row.id, 'receipt-2')), false);
    assert.equal((await run()(north, (journal) => at(journal, 'readProposal')('app', row.id)))?.receiptId, 'receipt-1');
    const open = proposal();
    await run()(north, (journal) => at(journal, 'createProposal')(open));
    assert.equal(await run()(north, (journal) => at(journal, 'settleProposal')('app', open.id, 'receipt-3')), false);
  });

  test(`${engine}: a proposal past its window expires; a sweep marks the rest, and a failed run still records`, async () => {
    await reset();
    const late = proposal({ expiresAt: NOW + 10 }),
      swept = proposal({ expiresAt: NOW + 10 }),
      live = proposal(),
      running = proposal({ expiresAt: NOW + 10 });
    await run()(north, async (journal) => {
      for (const row of [late, swept, live, running]) await at(journal, 'createProposal')(row);
    });
    assert.equal(
      await run()(north, (journal) => at(journal, 'decideProposal')('app', late.id, 'assign', 'approved', 'bo', NOW + 10)),
      'expired',
    );
    assert.equal((await run()(north, (journal) => at(journal, 'readProposal')('app', late.id)))?.state, 'expired');
    assert.equal(
      await run()(north, (journal) => at(journal, 'decideProposal')('app', late.id, 'assign', 'approved', 'bo', NOW + 11)),
      'expired',
    );
    // A refused approval is recorded as failed even when the window closed while it ran.
    assert.equal(
      await run()(north, (journal) => at(journal, 'decideProposal')('app', running.id, 'assign', 'failed', 'bo', NOW + 20)),
      'decided',
    );
    assert.equal(await run()(north, (journal) => at(journal, 'expireProposals')('app', NOW + 20)), 1);
    const states = await run()(north, (journal) => at(journal, 'listProposals')('app', { commands: ['assign'], limit: 10 }));
    assert.deepEqual(
      new Map(states.map((row) => [row.id, row.state])),
      new Map([
        [late.id, 'expired'],
        [swept.id, 'expired'],
        [live.id, 'proposed'],
        [running.id, 'failed'],
      ]),
    );
  });

  test(`${engine}: a mark stays unconfirmed until a person confirms its field, or the row`, async () => {
    await reset();
    const row = mark({ field: null, createdAt: NOW - 1 }),
      assignee = mark(),
      note = mark({ field: 'note', actorKind: 'decision', actor: 'decision:route' }),
      other = mark({ rowKey: '{"id":2}' });
    await run()(north, async (journal) => {
      for (const each of [row, assignee, note, other]) await at(journal, 'markProvenance')(each);
    });
    const unconfirmed = () => run()(north, (journal) => at(journal, 'unconfirmedProvenance')('app', 'loans', '{"id":1}'));
    assert.deepEqual(
      await unconfirmed(),
      [row, assignee, note].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    );
    // Confirming a field confirms the row's own mark with it.
    assert.equal(
      await run()(north, (journal) => at(journal, 'confirmProvenance')('app', 'loans', '{"id":1}', 'assignee', 'bo', NOW + 5)),
      2,
    );
    assert.deepEqual(
      (await unconfirmed()).map((each) => each.id),
      [note.id],
    );
    assert.equal(
      await run()(north, (journal) => at(journal, 'confirmProvenance')('app', 'loans', '{"id":1}', undefined, 'bo', NOW + 6)),
      1,
    );
    assert.deepEqual(await unconfirmed(), []);
    assert.equal(
      await run()(north, (journal) => at(journal, 'confirmProvenance')('app', 'loans', '{"id":1}', undefined, 'bo', NOW + 7)),
      0,
    );
    assert.equal((await run()(north, (journal) => at(journal, 'unconfirmedProvenance')('app', 'loans', '{"id":2}'))).length, 1);
    await assert.rejects(run()(north, (journal) => at(journal, 'markProvenance')(mark({ actorKind: 'person' as never }))));
    await assert.rejects(run()(north, (journal) => at(journal, 'markProvenance')(mark({ tenant: 'south' }))));
  });

  test(`${engine}: a journal bound to one tenant reads, decides, sweeps and confirms nothing of another's`, async () => {
    await reset();
    const theirs = proposal({ tenant: 'south', expiresAt: NOW + 10 }),
      theirMark = mark({ tenant: 'south' });
    await run()(south, async (journal) => {
      await at(journal, 'createProposal')(theirs);
      await at(journal, 'markProvenance')(theirMark);
    });
    await run()(north, async (journal) => {
      assert.equal(await at(journal, 'readProposal')('app', theirs.id), undefined);
      assert.deepEqual(await at(journal, 'listProposals')('app', { commands: ['assign'], limit: 10 }), []);
      assert.equal(await at(journal, 'decideProposal')('app', theirs.id, 'assign', 'approved', 'bo', NOW + 1), 'missing');
      assert.equal(await at(journal, 'settleProposal')('app', theirs.id, 'receipt'), false);
      assert.equal(await at(journal, 'expireProposals')('app', NOW + 20), 0);
      assert.deepEqual(await at(journal, 'unconfirmedProvenance')('app', 'loans', '{"id":1}'), []);
      assert.equal(await at(journal, 'confirmProvenance')('app', 'loans', '{"id":1}', undefined, 'bo', NOW + 1), 0);
    });
    // A journal for another App reaches nothing of this one's either.
    await assert.rejects(
      run()(south, (journal) => at(journal, 'readProposal')('other', theirs.id)),
      (error) => !!refusedFor(error),
    );
    const still = await run()(south, (journal) => at(journal, 'readProposal')('app', theirs.id));
    assert.equal(still?.state, 'proposed');
    assert.equal(still?.decidedBy, null);
    assert.equal((await run()(south, (journal) => at(journal, 'unconfirmedProvenance')('app', 'loans', '{"id":1}'))).length, 1);
  });
}

describe('proposals on SQLite', () => {
  let directory: string, db: DatabaseSync;
  before(() => {
    directory = mkdtempSync(join(tmpdir(), 'mistri-command-proposals-'));
  });
  after(() => {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const reset = async () => {
    db?.close();
    const path = join(directory, `${randomUUID()}.db`);
    db = new DatabaseSync(path);
    migrateSqliteCommandJournal(path);
  };
  const run: Run = async (bound, work) => {
    const operations = new TransactionOperations();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = await work(createSqliteCommandJournal(db, operations, bound));
      await operations.finish();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      await operations.finish().catch(() => {});
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };
  journalCases('sqlite', () => run, reset);
});

/** Whether the live half runs: the skip decision, and nothing else. */
const LIVE = process.env.TABLEWALK_TEST_PG;
/* Each run works in a database of its own, created and dropped by the hooks below, so its reset drops only its own
   journal. */
const DATABASE = `tw_cmd_proposals_${randomUUID().replaceAll('-', '')}`;

interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
async function client(target: string): Promise<Control> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
  const Client = (pg.Client ?? pg.default?.Client)!;
  const created = new Client({ connectionString: target });
  await created.connect();
  return created;
}

describe('proposals on PostgreSQL, against a real server', { skip: liveSkip('postgres', LIVE) }, () => {
  let url: string, control: Control;
  before(async () => {
    const server = await client(LIVE!);
    try {
      await server.query(`CREATE DATABASE "${DATABASE}"`);
    } finally {
      await server.end();
    }
    const target = new URL(LIVE!);
    target.pathname = `/${DATABASE}`;
    url = target.href;
    control = await client(url);
  });
  after(async () => {
    await control?.end();
    const server = await client(LIVE!);
    try {
      await server.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
    } finally {
      await server.end();
    }
  });
  const reset = async () => {
    await control.query('DROP SCHEMA IF EXISTS mistri CASCADE');
    await migratePostgresCommandJournal(url);
  };
  /** One journal over its own transaction on its own client; `held` keeps the transaction open until it settles. */
  const open = async (bound: CommandJournalTenant) => {
    const connection = await client(url);
    const operations = new TransactionOperations();
    await connection.query('BEGIN');
    return {
      journal: createPostgresCommandJournal(connection, operations, bound) as CommandJournal,
      async commit() {
        try {
          await operations.finish();
          await connection.query('COMMIT');
        } finally {
          await connection.end();
        }
      },
      async rollback() {
        await operations.finish().catch(() => {});
        await connection.query('ROLLBACK').catch(() => {});
        await connection.end();
      },
    };
  };
  const run: Run = async (bound, work) => {
    const opened = await open(bound);
    let result;
    try {
      result = await work(opened.journal);
    } catch (error) {
      await opened.rollback();
      throw error;
    }
    await opened.commit();
    return result;
  };
  journalCases('postgres', () => run, reset);

  test('postgres: two approvals at once decide a proposal once; the second waits on the first and is told it was taken', async () => {
    await reset();
    const row = proposal();
    await run(north, (journal) => at(journal, 'createProposal')(row));
    const first = await open(north),
      second = await open(north);
    try {
      assert.equal(await at(first.journal, 'decideProposal')('app', row.id, 'assign', 'approved', 'bo', NOW + 1), 'decided');
      // The second UPDATE waits on the first's row lock, then re-reads the guard and changes nothing.
      const racing = at(second.journal, 'decideProposal')('app', row.id, 'assign', 'approved', 'cy', NOW + 2);
      const settled = await Promise.race([racing.then(() => 'answered'), new Promise((resolve) => setTimeout(resolve, 200, 'waiting'))]);
      assert.equal(settled, 'waiting');
      await first.commit();
      assert.equal(await racing, 'taken');
      await second.commit();
    } catch (error) {
      await first.rollback().catch(() => {});
      await second.rollback().catch(() => {});
      throw error;
    }
    const decided = await run(north, (journal) => at(journal, 'readProposal')('app', row.id));
    assert.equal(decided?.decidedBy, 'bo');
  });

  test('postgres: an approval rolled back leaves the proposal open for the next', async () => {
    await reset();
    const row = proposal();
    await run(north, (journal) => at(journal, 'createProposal')(row));
    const first = await open(north);
    assert.equal(await at(first.journal, 'decideProposal')('app', row.id, 'assign', 'approved', 'bo', NOW + 1), 'decided');
    await first.rollback();
    assert.equal(
      await run(north, (journal) => at(journal, 'decideProposal')('app', row.id, 'assign', 'approved', 'cy', NOW + 2)),
      'decided',
    );
  });
});

test('sqlite: an approval rolled back leaves the proposal open for the next', async (t: TestContext) => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-command-proposals-rollback-')),
    path = join(directory, 'data.db');
  const db = new DatabaseSync(path);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  migrateSqliteCommandJournal(path);
  const row = proposal();
  const within = async <T>(commit: boolean, work: (journal: CommandJournal) => Promise<T>) => {
    const operations = new TransactionOperations();
    db.exec('BEGIN IMMEDIATE');
    const result = await work(createSqliteCommandJournal(db, operations, north));
    await operations.finish();
    db.exec(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  };
  await within(true, (journal) => at(journal, 'createProposal')(row));
  assert.equal(
    await within(false, (journal) => at(journal, 'decideProposal')('app', row.id, 'assign', 'approved', 'bo', NOW + 1)),
    'decided',
  );
  assert.equal(
    await within(true, (journal) => at(journal, 'decideProposal')('app', row.id, 'assign', 'approved', 'cy', NOW + 2)),
    'decided',
  );
  assert.equal((await within(true, (journal) => at(journal, 'readProposal')('app', row.id)))?.decidedBy, 'cy');
});
