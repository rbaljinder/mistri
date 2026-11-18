/**
 * The makers' side of `approval: 'ai'` (proposals.ts): the declaration takes that one word and no other; the executor
 * refuses a run no person made unless it is an approved proposal's; a job asked to run such a command proposes it
 * instead, once however often it is retried; a job's write on any other command marks each field it set as the
 * job's until a person's write confirms it; and a command that keeps no receipt leaves the approved proposal's
 * receipt empty.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { COMMAND_JOURNAL_TABLES as tables, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands, type BusinessCommandActor } from '../packages/mistri/src/server/commands/businessCommands.js';
import { createProposal, onProposalApproved } from '../packages/mistri/src/server/commands/proposals.js';
import { jobHandlers } from '../packages/mistri/src/server/jobs/jobCommands.js';
import { capturedJobModule, defineJob, defineJobs, pinJobs } from '../packages/mistri/src/server/jobs/jobModule.js';
import type { JobContext } from '../packages/mistri/src/server/jobs/jobs.js';
import { serviceActor } from '../packages/mistri/src/server/jobs/jobAuthorization.js';
import { proposed } from '../packages/mistri/src/server/workflows/workflowHost.js';
import { StepPending, StepRefused } from '../packages/mistri/src/server/workflows/workflowModule.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { parseTestApp } from './support/commandCatalog.js';

const appId = 'lending';

test("a command's approval takes 'ai' and nothing else", () => {
  const base = { source: 'lending', target: 'loan', input: {}, async handle() {} };
  assert.equal(defineCommand({ ...base, approval: 'ai' }).approval, 'ai');
  for (const approval of ['always', true, 'AI', null])
    assert.throws(() => defineCommand({ ...base, approval } as never), /approval must be "ai"/);
});

test(
  'no person runs an AI-approved command without a proposal; a job proposes it, marks what it writes, and a person confirms',
  { timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mistri-command-proposal-makers-'));
    const file = join(directory, 'lending.db');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE loan (id INTEGER PRIMARY KEY, title TEXT NOT NULL, note TEXT, version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE assignment (id INTEGER PRIMARY KEY, loan_id INTEGER NOT NULL REFERENCES loan(id), reviewer TEXT NOT NULL);
    INSERT INTO loan (id, title) VALUES (1, 'Corner shop'), (2, 'Bakery');`);
    migrateSqliteCommandJournal(file);
    const registry = new Registry();
    registry.add({ id: 'lending-db', name: 'Lending', url: file, writable: true, source: 'config' });
    const commandIds = ['assign', 'retitle', 'quiet'];
    const app = parseTestApp(
      {
        id: appId,
        name: 'Lending',
        sources: { lending: { connection: 'lending-db', default: true } },
        resources: {
          loan: {
            access: 'write',
            actions: Object.fromEntries(
              commandIds.map((id) => [
                id,
                {
                  label: id,
                  command: {
                    id,
                    version: 1,
                    target: 'loan',
                    input: id === 'retitle' ? { title: { type: 'text' }, note: { type: 'text' } } : { reviewer: { type: 'text' } },
                  },
                },
              ]),
            ),
          },
          assignment: { access: 'write' },
        },
        auth: { roles: { reviewer: { read: true, commands: commandIds }, automation: { read: true, commands: commandIds } } },
        views: { loans: { kind: 'list', from: 'loan' } },
        home: 'loans',
        nav: ['loans'],
      },
      'proposal makers fixture',
    );
    let runs = 0;
    const assignment = (track: 'receipts' | 'none') =>
      defineCommand({
        source: 'lending',
        target: 'loan',
        write: ['assignment'],
        track,
        approval: 'ai',
        input: { reviewer: { label: 'Reviewer', type: 'text' } },
        async handle({ db: rows, record }, input) {
          runs++;
          await rows.assignment.insert({ loan_id: record.id, reviewer: input.reviewer });
        },
      });
    const commands = defineCommands({
      assign: assignment('receipts'),
      quiet: assignment('none'),
      retitle: defineCommand({
        source: 'lending',
        target: 'loan',
        track: 'receipts',
        input: { title: { label: 'Title', type: 'text' }, note: { label: 'Note', type: 'text', optional: true } },
        async handle({ db: rows, record }, input) {
          await rows.loan.update(record, { title: input.title, ...(input.note ? { note: input.note } : {}) });
        },
      }),
    });
    const people: Record<string, Identity> = { 'account-ada': { id: 'account-ada', who: 'ada@example.test', role: 'reviewer' } };
    const host: AppHost = {
      app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
      pages: [],
      auth: {
        spec: app.auth!,
        store: join(directory, 'auth.db'),
        close() {},
        handler: async () => {},
        session: async (request: IncomingMessage) => people[String(request.headers['x-mistri-account'])] ?? null,
      },
    };
    const makers = new Registry();
    makers.add({ id: 'lending-db', name: 'Lending', url: file, writable: true, source: 'config' });
    const binding = bindBusinessCommands({
      app,
      registry: commands,
      resources: await loadAppRuntimeResources(makers, app, 'lending-db'),
      writableConnection: (id) => makers.configOf(id)?.writable === true,
    });
    const ada: BusinessCommandActor = { id: 'account-ada', appId, roles: ['reviewer'] };
    const clock: BusinessCommandActor = { id: 'clock', appId, roles: ['automation'], kind: 'service' };
    let keys = 0;
    const request = (command: string, key: number, input: Record<string, unknown>) => ({
      command,
      commandVersion: 1,
      key: { id: key },
      input,
      idempotencyKey: `makers-request-${String(++keys).padStart(4, '0')}`,
    });
    const rows = <T>(sql: string, ...params: string[]) =>
      db
        .prepare(sql)
        .all(...params)
        .map((row) => ({ ...row })) as T[];

    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, bound, apps: [host], commands: { appId, registry: commands } });
    try {
      server.listen(0, bound.host);
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const post = async (path: string, body: Record<string, unknown>) => {
        const response = await fetch(`http://${bound.host}:${address.port}${path}`, {
          method: 'POST',
          signal: AbortSignal.timeout(5_000),
          headers: { 'content-type': 'application/json', 'x-mistri-account': 'account-ada' },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      };

      // The backstop: a run no person made, through any maker's door, is refused; a person's runs.
      for (const options of [
        { door: 'job' as const },
        { door: 'workflow' as const },
        { maker: 'assistant' as const },
        { maker: 'decision' as const },
      ])
        await assert.rejects(
          executeBusinessCommand(
            binding,
            options.door ? clock : ada,
            { ...request('assign', 1, { reviewer: 'Dee' }), expectedVersion: 0 },
            options,
          ),
          (error: { code?: string }) => error.code === 'forbidden',
          JSON.stringify(options),
        );
      assert.equal(runs, 0);
      await executeBusinessCommand(binding, ada, { ...request('assign', 2, { reviewer: 'Ada' }), expectedVersion: 0 });
      assert.equal(runs, 1);
      assert.deepEqual(rows(`SELECT actor_kind FROM "${tables.provenance}"`), [], "a person's own write is marked by nobody");

      // A job asked to run it proposes it instead, under its own name; its retry finds the same proposal.
      const module = pinJobs(
        capturedJobModule(
          defineJobs(
            {
              assignLater: defineJob({ every: '@hourly', runAs: 'clock', command: 'assign' }),
              retitleLater: defineJob({ every: '@hourly', runAs: 'clock', command: 'retitle' }),
            },
            { principals: { clock: { roles: ['automation'] } } },
          ),
        ),
        commands,
      );
      const handlers = jobHandlers({ module, appId, bind: async () => ({ binding, release() {} }) });
      const context = (job: string, attempt: number): JobContext => ({
        jobId: `job-${job}`,
        attempt,
        maxAttempts: 3,
        job,
        version: 1,
        provenance: { appId, actorId: 'clock', causationId: `event-${job}`, correlationId: 'correlation-001' },
        signal: new AbortController().signal,
        now: Date.now,
        cancelRequested: async () => false,
        grant: { audience: 'mistri.jobs', job, version: 1, appId, expiresAt: Date.now() + 60_000 },
      });
      const first = (await handlers.assignLater.handle(context('assignLater', 1), { key: { id: 1 }, input: { reviewer: 'Dee' } })) as {
        proposalId: string;
      };
      assert.match(first.proposalId, /^[A-Za-z0-9_-]{22}$/);
      const retried = (await handlers.assignLater.handle(context('assignLater', 2), { key: { id: 1 }, input: { reviewer: 'Dee' } })) as {
        proposalId: string;
      };
      assert.equal(retried.proposalId, first.proposalId);
      // The platform says why: the record the job ran on, and the job's name.
      assert.deepEqual(rows(`SELECT evidence, reason FROM "${tables.proposal}"`), [
        { evidence: '[{"kind":"record","ref":"loan/{\\"id\\":1}","label":"loan 1"}]', reason: 'The job "assignLater" proposed this.' },
      ]);
      assert.deepEqual(rows(`SELECT id, command, target, input, actor_kind, actor, state FROM "${tables.proposal}"`), [
        {
          id: first.proposalId,
          command: 'assign',
          target: '{"id":1}',
          input: '{"reviewer":"Dee"}',
          actor_kind: 'job',
          actor: 'job:assignLater',
          state: 'proposed',
        },
      ]);
      // The job's input is judged when the proposal is made, not when it is approved.
      await assert.rejects(
        async () => handlers.assignLater.handle(context('assignLater', 1), { key: { id: 1 }, input: {} }),
        (error: { code?: string }) => error.code !== undefined,
      );
      assert.equal(runs, 1, 'proposing ran nothing');

      // Approved, it runs as the approver; the receipt is the approver's and the job's mark is on what it wrote.
      const approved = await post('/api/commands/proposals/approve', { id: first.proposalId, command: 'assign', expectedVersion: 0 });
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal(runs, 2);

      // A job's write on a command any maker may run: one mark per field it set, each the job's, unconfirmed.
      await handlers.retitleLater.handle(context('retitleLater', 1), {
        key: { id: 2 },
        input: { title: 'Bakery & cafe', note: 'Imported' },
      });
      const marks = () =>
        rows<{ row_key: string; field: string; actor_kind: string; actor: string; confirmed_by: string | null }>(
          `SELECT row_key, field, actor_kind, actor, confirmed_by FROM "${tables.provenance}" WHERE resource = 'loan' AND row_key = '{"id":2}' ORDER BY field`,
        );
      assert.deepEqual(marks(), [
        { row_key: '{"id":2}', field: 'note', actor_kind: 'job', actor: 'job:retitleLater', confirmed_by: null },
        { row_key: '{"id":2}', field: 'title', actor_kind: 'job', actor: 'job:retitleLater', confirmed_by: null },
      ]);
      const receiptKinds = rows<{ actor_kind: string }>(`SELECT actor_kind FROM "${tables.receipt}" WHERE command_id = 'retitle'`);
      assert.deepEqual(receiptKinds, [{ actor_kind: 'job' }]);

      // A person's write of one field confirms that field's mark alone; the other waits.
      const version = (db.prepare('SELECT version FROM loan WHERE id = 2').get() as { version: number }).version;
      await executeBusinessCommand(binding, ada, { ...request('retitle', 2, { title: 'Bakery' }), expectedVersion: version });
      assert.deepEqual(
        marks().map((each) => [each.field, each.confirmed_by]),
        [
          ['note', null],
          ['title', 'account-ada'],
        ],
      );
      // Confirmed in place: the mark is stamped and a receipt with no changes records who vouched.
      const confirmed = await post('/api/commands/provenance/confirm', {
        command: 'retitle',
        resource: 'loan',
        key: { id: 2 },
        field: 'note',
      });
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      assert.deepEqual(confirmed.body, { confirmed: 1, fields: ['note'] });
      assert.deepEqual(
        marks().map((each) => each.confirmed_by),
        ['account-ada', 'account-ada'],
      );
      const vouched = rows<{ actor_id: string; actor_kind: string; idempotency_key: string; result_json: string }>(
        `SELECT actor_id, actor_kind, idempotency_key, result_json FROM "${tables.receipt}" WHERE idempotency_key LIKE 'provenance-confirm:%'`,
      );
      assert.equal(vouched.length, 1);
      assert.deepEqual([vouched[0].actor_id, vouched[0].actor_kind], ['account-ada', 'person']);
      // The receipt names the fields vouched for, not only how many.
      assert.deepEqual(JSON.parse(vouched[0].result_json), { confirmed: 1, field: 'note', fields: ['note'] });
      assert.deepEqual((await post('/api/commands/provenance/confirm', { command: 'retitle', resource: 'loan', key: { id: 2 } })).body, {
        confirmed: 0,
        fields: [],
      });

      // A command that keeps no receipt: approved, its proposal names none, since none exists.
      const quiet = await createProposal(binding, ada, {
        command: 'quiet',
        key: { id: 1 },
        input: { reviewer: 'Fay' },
        maker: 'job',
        makerActor: 'job:quiet',
        evidence: [],
        reason: 'Fay is free.',
      });
      const ran = await post('/api/commands/proposals/approve', {
        id: quiet.id,
        command: 'quiet',
        expectedVersion: (db.prepare('SELECT version FROM loan WHERE id = 1').get() as { version: number }).version,
      });
      assert.equal(ran.status, 200, JSON.stringify(ran.body));
      assert.deepEqual(rows(`SELECT state, decided_by, receipt_id FROM "${tables.proposal}" WHERE id = ?`, quiet.id), [
        { state: 'approved', decided_by: 'account-ada', receipt_id: null },
      ]);
      assert.equal(runs, 3);

      // Approved with the input corrected: it runs with the person's input, and a field they changed is theirs, not
      // marked as the maker's; the one they left as proposed is the maker's, as any approved proposal's is.
      const corrected = await createProposal(binding, ada, {
        command: 'retitle',
        key: { id: 2 },
        input: { title: 'Corner bakery', note: 'From the import' },
        maker: 'decision',
        makerActor: 'decision:title',
        evidence: [],
        reason: 'The import named it so.',
      });
      assert.equal(
        (await post('/api/commands/proposals/approve', { id: corrected.id, command: 'retitle', expectedVersion: 0, input: 'x' })).status,
        400,
      );
      const correctedRun = await post('/api/commands/proposals/approve', {
        id: corrected.id,
        command: 'retitle',
        expectedVersion: (db.prepare('SELECT version FROM loan WHERE id = 2').get() as { version: number }).version,
        input: { title: 'Corner Bakery & Cafe', note: 'From the import' },
      });
      assert.equal(correctedRun.status, 200, JSON.stringify(correctedRun.body));
      assert.deepEqual(rows(`SELECT title, note FROM loan WHERE id = 2`), [{ title: 'Corner Bakery & Cafe', note: 'From the import' }]);
      assert.deepEqual(
        // Marks are history rows: sorted here, so the assertion does not lean on the order rows of one field come back in.
        marks()
          .map((each) => [each.field, each.actor_kind, each.confirmed_by])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        [
          ['note', 'decision', null],
          ['note', 'job', 'account-ada'],
          ['title', 'job', 'account-ada'],
        ],
        'the corrected title has no decision mark; the note as proposed has one',
      );

      // A workflow's step proposes it and waits: the same step looked at again finds the same proposal.
      const flow = serviceActor(appId, 'clock', ['automation']);
      const t0 = Date.now();
      const pending: string[] = [];
      const step = (idempotencyKey: string, at: number) =>
        proposed(
          binding,
          flow,
          'lend',
          { step: 'assign', idempotencyKey },
          { command: 'assign', key: { id: 2 }, input: { reviewer: 'Gus' } },
          at,
          (id) => pending.push(id),
        );
      const waits = async (idempotencyKey: string, at: number) => {
        const error = await step(idempotencyKey, at).then(
          () => assert.fail('the step went on'),
          (thrown: unknown) => thrown,
        );
        assert.ok(error instanceof StepPending, String(error));
        return error.wakeAt;
      };
      const refused = async (idempotencyKey: string, at: number) => {
        const error = await step(idempotencyKey, at).then(
          () => assert.fail('the step went on'),
          (thrown: unknown) => thrown,
        );
        assert.ok(error instanceof StepRefused, String(error));
        return error.code;
      };
      assert.equal(await waits('flow-approved', t0), t0 + 60_000, 'a new proposal is looked at again after a minute');
      assert.equal(await waits('flow-approved', t0 + 5_000), t0 + 65_000);
      const flowed = rows<{ id: string; actor_kind: string; actor: string; state: string }>(
        `SELECT id, actor_kind, actor, state FROM "${tables.proposal}" WHERE actor_kind = 'flow'`,
      );
      assert.equal(flowed.length, 1);
      assert.deepEqual([flowed[0].actor, flowed[0].state], ['flow:lend', 'proposed']);
      assert.equal(runs, 3, 'waiting ran nothing');
      assert.deepEqual(pending, [flowed[0].id, flowed[0].id], 'each look that waits names the proposal it waits on');
      // Approving tells whoever waits in this process at once: how the flow's host wakes the step (workflowHost.ts).
      const told: unknown[] = [];
      const stopTelling = onProposalApproved(appId, (each) => told.push(each));
      const flowApproved = await post('/api/commands/proposals/approve', {
        id: flowed[0].id,
        command: 'assign',
        expectedVersion: (db.prepare('SELECT version FROM loan WHERE id = 2').get() as { version: number }).version,
      });
      assert.equal(flowApproved.status, 200, JSON.stringify(flowApproved.body));
      assert.equal(runs, 4);
      stopTelling();
      assert.deepEqual(told, [{ appId, id: flowed[0].id, command: 'assign' }]);
      const answered = (await step('flow-approved', t0 + 10_000)) as { proposal: string; state: string; receipt: string | null };
      assert.deepEqual([answered.proposal, answered.state], [flowed[0].id, 'approved']);
      assert.ok(answered.receipt, "the step answers with the approver's receipt");
      assert.equal(runs, 4, 'the approved step runs nothing again');

      // Dismissed, the step is refused; left past its fourteen days, it is refused as expired.
      await waits('flow-dismissed', t0);
      const dismissedId = rows<{ id: string }>(`SELECT id FROM "${tables.proposal}" WHERE actor_kind = 'flow' AND state = 'proposed'`)[0]
        .id;
      const dismissed = await post('/api/commands/proposals/dismiss', { id: dismissedId, command: 'assign' });
      assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
      assert.equal(await refused('flow-dismissed', t0 + 1_000), 'proposal_dismissed');
      await waits('flow-expired', t0);
      assert.equal(
        await waits('flow-expired', t0 + 13 * 86_400_000),
        t0 + 13 * 86_400_000 + 60 * 60_000,
        'an old proposal is looked at hourly',
      );
      assert.equal(await refused('flow-expired', t0 + 14 * 86_400_000), 'proposal_expired');
      assert.equal(runs, 4);
    } finally {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await registry.closeAll();
      await makers.closeAll();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
