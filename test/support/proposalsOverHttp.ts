/**
 * The proposal routes over the App's own command door (server/commands/proposals.ts), as one scenario either engine
 * runs: a maker's proposal is judged by its command's declaration when it is made; a person granted the command lists
 * it and approves it, and the run is theirs, its receipt naming the proposal; a person without the grant is refused
 * and the proposal waits; two approvals at once decide it once; a run the command refuses marks it failed; a
 * dismissal is final; one past its window is gone; a conversation's cards are read back by id, whatever their state;
 * For review is offered to the reviewers alone and lists what a maker wrote that no one confirmed; and a person
 * confirms what a maker wrote. The engine brings the
 * App's tables (loan, assignment with a generated id, loans 1 and 2 at version 0) and a migrated journal.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { COMMAND_JOURNAL_TABLES as tables } from '../../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../../packages/mistri/src/server/app/apps.js';
import { loadAppRuntimeResources } from '../../packages/mistri/src/server/app/appRuntimeResources.js';
import type { Identity } from '../../packages/mistri/src/server/auth/auth.js';
import { bindBusinessCommands } from '../../packages/mistri/src/server/commands/businessCommandAccess.js';
import { defineCommand, defineCommands, type BusinessCommandActor } from '../../packages/mistri/src/server/commands/businessCommands.js';
import { refuse } from '../../packages/mistri/src/server/commands/commandErrors.js';
import { createProposal, markProvenance, type ProposalDraft } from '../../packages/mistri/src/server/commands/proposals.js';
import { Registry } from '../../packages/engine/src/server/connections.js';
import { createApp } from './createApp.js';
import { parseTestApp } from './commandCatalog.js';

const appId = 'lending';
const DAY = 24 * 60 * 60 * 1000;

export interface ProposalEngine {
  /** The App's connection, read by the server and the maker's binding alike. */
  url: string;
  /** A scratch folder for the host's paths. */
  directory: string;
  /** A journal table as this engine names it. */
  table(name: string): string;
  /** Rows of a statement written with `?` placeholders. */
  all(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
}

export async function proposalsOverHttp(engine: ProposalEngine): Promise<void> {
  const registry = new Registry();
  registry.add({ id: 'lending-db', name: 'Lending', url: engine.url, writable: true, source: 'config' });
  const app = parseTestApp(
    {
      id: appId,
      name: 'Lending',
      sources: { lending: { connection: 'lending-db', default: true } },
      resources: {
        loan: {
          access: 'write',
          actions: {
            assign: { label: 'Assign', command: { id: 'assign', version: 1, target: 'loan', input: { reviewer: { type: 'text' } } } },
          },
        },
        assignment: { access: 'write' },
      },
      auth: { roles: { reviewer: { read: true, commands: ['assign'] }, viewer: { read: true } } },
      views: { loans: { kind: 'list', from: 'loan' } },
      home: 'loans',
      nav: ['loans'],
    },
    'proposals fixture',
  );
  let runs = 0;
  const commands = defineCommands({
    // A maker's command: so For review is offered to whoever is granted it, and lists what a maker wrote on loans.
    assign: defineCommand({
      approval: 'ai',
      source: 'lending',
      target: 'loan',
      write: ['assignment'],
      track: 'receipts',
      input: { reviewer: { label: 'Reviewer', type: 'text' } },
      output: { parse: (value: unknown) => value as { assigned: string } },
      async handle({ db: rows, record }, input) {
        runs++;
        if (input.reviewer === 'nobody') refuse('Nobody reviews loans.');
        await rows.assignment.insert({ loan_id: record.id, reviewer: input.reviewer });
        return { assigned: input.reviewer };
      },
    }),
  });
  const people: Record<string, Identity> = {
    'account-ada': { id: 'account-ada', who: 'ada@example.test', role: 'reviewer' },
    'account-bo': { id: 'account-bo', who: 'bo@example.test', role: 'reviewer' },
    'account-cy': { id: 'account-cy', who: 'cy@example.test', role: 'viewer' },
  };
  const host: AppHost = {
    app: { app, path: join(engine.directory, 'app.ts'), pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: join(engine.directory, 'auth.db'),
      close() {},
      handler: async () => {},
      session: async (request: IncomingMessage) => people[String(request.headers['x-mistri-account'])] ?? null,
    },
  };
  // The maker's side: the same store, reached through a binding of its own, as an assistant or a job reaches it.
  const makers = new Registry();
  makers.add({ id: 'lending-db', name: 'Lending', url: engine.url, writable: true, source: 'config' });
  const binding = bindBusinessCommands({
    app,
    registry: commands,
    resources: await loadAppRuntimeResources(makers, app, 'lending-db'),
    writableConnection: (id) => makers.configOf(id)?.writable === true,
  });
  const ada: BusinessCommandActor = { id: 'account-ada', appId, roles: ['reviewer'] };
  const draft = (overrides: Partial<ProposalDraft> = {}): ProposalDraft => ({
    command: 'assign',
    key: { id: 1 },
    input: { reviewer: 'Dee' },
    maker: 'assistant',
    makerActor: 'assistant:triage',
    model: 'model-a',
    evidence: [{ kind: 'record', ref: 'loan/1', label: 'Corner shop' }],
    reason: 'Dee reviews shop loans.',
    ...overrides,
  });
  const proposalRow = async (id: string) =>
    (await engine.all(`SELECT state, decided_by, receipt_id FROM ${engine.table(tables.proposal)} WHERE id = ?`, [id]))[0] as
      | { state: string; decided_by: string | null; receipt_id: string | null }
      | undefined;

  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], commands: { appId, registry: commands } });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://${bound.host}:${address.port}`;
    const post = async (as: string, path: string, body: Record<string, unknown>) => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
        headers: { 'content-type': 'application/json', 'x-mistri-account': as },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };

    // Made: only by a maker this module admits, and only with input the command's declaration accepts.
    for (const maker of ['agent', 'person'] as const)
      await assert.rejects(
        createProposal(binding, ada, draft({ maker: maker as never })),
        (error: { code?: string }) => error.code === 'forbidden',
      );
    await assert.rejects(createProposal(binding, ada, draft({ input: {} })), (error: { code?: string }) => error.code === 'invalid_input');
    await assert.rejects(
      createProposal(binding, ada, draft({ key: { name: 'x' } })),
      (error: { code?: string }) => error.code === 'invalid_input',
    );
    const viewer: BusinessCommandActor = { id: 'account-cy', appId, roles: ['viewer'] };
    await assert.rejects(createProposal(binding, viewer, draft()));
    const made = await createProposal(binding, ada, draft());
    assert.equal(made.state, 'proposed');
    assert.equal(made.expiresAt - made.createdAt, 14 * DAY);

    // Listed for whoever is granted the command; nothing for a reader without it.
    const listed = await post('account-bo', '/api/commands/proposals', {});
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(
      listed.body.proposals.map((each: { id: string }) => each.id),
      [made.id],
    );
    const unlisted = await post('account-cy', '/api/commands/proposals', {});
    assert.ok(unlisted.status === 403 || (unlisted.status === 200 && unlisted.body.proposals.length === 0), JSON.stringify(unlisted.body));
    // For review is offered to a reader granted a command a maker proposes, and not to one granted none (appProjection.ts).
    const payload = async (as: string) => {
      const response = await fetch(`${base}/api/app?app=${appId}`, {
        signal: AbortSignal.timeout(5_000),
        headers: { 'x-mistri-account': as },
      });
      assert.equal(response.status, 200);
      return ((await response.json()) as { app: { review?: boolean } }).app;
    };
    assert.equal((await payload('account-bo')).review, true);
    assert.equal((await payload('account-cy')).review, undefined);

    // Refused without the grant: the proposal waits, and nothing ran.
    const forbidden = await post('account-cy', '/api/commands/proposals/approve', { id: made.id, command: 'assign' });
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
    assert.equal((await proposalRow(made.id))?.state, 'proposed');
    assert.equal(runs, 0);

    // Approved by Bo: the run is his, the receipt names the proposal, the proposal names the receipt.
    const approved = await post('account-bo', '/api/commands/proposals/approve', { id: made.id, command: 'assign', expectedVersion: 0 });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(runs, 1);
    const decided = (await proposalRow(made.id))!;
    assert.equal(decided.state, 'approved');
    assert.equal(decided.decided_by, 'account-bo');
    const receipt = (
      await engine.all(`SELECT id, actor_id, actor_kind, proposal_id FROM ${engine.table(tables.receipt)} WHERE proposal_id = ?`, [made.id])
    )[0] as { id: string; actor_id: string; actor_kind: string; proposal_id: string } | undefined;
    assert.ok(receipt, 'the receipt names the proposal');
    assert.equal(receipt.actor_id, 'account-bo');
    assert.equal(receipt.actor_kind, 'person');
    assert.equal(decided.receipt_id, receipt.id);
    assert.deepEqual(
      (await engine.all('SELECT loan_id, reviewer FROM assignment')).map((row) => ({
        loan_id: Number(row.loan_id),
        reviewer: row.reviewer,
      })),
      [{ loan_id: 1, reviewer: 'Dee' }],
    );
    const again = await post('account-ada', '/api/commands/proposals/approve', { id: made.id, command: 'assign' });
    assert.equal(again.status, 409, JSON.stringify(again.body));

    // Two approvals at once: one runs, the other is told it was decided.
    const raced = await createProposal(binding, ada, draft({ key: { id: 2 }, input: { reviewer: 'Eve' } }));
    const both = await Promise.all(
      ['account-ada', 'account-bo'].map((as) => post(as, '/api/commands/proposals/approve', { id: raced.id, command: 'assign' })),
    );
    assert.deepEqual(both.map((each) => each.status).sort(), [200, 409], JSON.stringify(both.map((each) => each.body)));
    assert.equal(Number((await engine.all("SELECT count(*) AS n FROM assignment WHERE reviewer = 'Eve'"))[0]!.n), 1);

    // A run the command refuses is the proposal's failure: marked failed, and the refusal is the answer.
    const doomed = await createProposal(binding, ada, draft({ input: { reviewer: 'nobody' } }));
    const refused = await post('account-ada', '/api/commands/proposals/approve', { id: doomed.id, command: 'assign' });
    assert.ok(refused.status >= 400 && refused.status < 500 && refused.status !== 403, JSON.stringify(refused.body));
    assert.equal((await proposalRow(doomed.id))?.state, 'failed');
    assert.equal((await proposalRow(doomed.id))?.decided_by, 'account-ada');

    // Dismissed once; a second dismissal and an approval after it are told it was decided.
    const unwanted = await createProposal(binding, ada, draft());
    const dismissed = await post('account-ada', '/api/commands/proposals/dismiss', { id: unwanted.id, command: 'assign' });
    assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
    assert.deepEqual(dismissed.body, { id: unwanted.id, state: 'dismissed' });
    assert.equal((await post('account-bo', '/api/commands/proposals/dismiss', { id: unwanted.id, command: 'assign' })).status, 409);
    assert.equal((await post('account-bo', '/api/commands/proposals/approve', { id: unwanted.id, command: 'assign' })).status, 409);
    assert.equal((await post('account-cy', '/api/commands/proposals/dismiss', { id: unwanted.id, command: 'assign' })).status, 403);
    assert.equal((await proposalRow(unwanted.id))?.decided_by, 'account-ada');
    // A conversation's cards, read back by id on reload: each in whatever state it is now, an unknown id skipped,
    // and none for a reader not granted the command (assistantRoutes.ts).
    const cards = await post('account-bo', '/api/commands/proposals', { ids: [made.id, unwanted.id, 'B'.repeat(22), made.id] });
    assert.equal(cards.status, 200, JSON.stringify(cards.body));
    assert.deepEqual(
      cards.body.proposals.map((each: { id: string; state: string }) => [each.id, each.state]),
      [
        [made.id, 'approved'],
        [unwanted.id, 'dismissed'],
      ],
    );
    const narrowed = await post('account-bo', '/api/commands/proposals', { ids: [made.id, unwanted.id], states: ['dismissed'] });
    assert.deepEqual(
      narrowed.body.proposals.map((each: { id: string }) => each.id),
      [unwanted.id],
    );
    const unseen = await post('account-cy', '/api/commands/proposals', { ids: [made.id] });
    assert.ok(unseen.status === 403 || (unseen.status === 200 && unseen.body.proposals.length === 0), JSON.stringify(unseen.body));
    for (const ids of [[], ['x'.repeat(129)], [1], Array.from({ length: 51 }, (_, at) => `id${at}`)])
      assert.equal((await post('account-bo', '/api/commands/proposals', { ids })).status, 400, JSON.stringify(ids));
    // A proposal another command names, or none at all, is not found.
    assert.equal((await post('account-ada', '/api/commands/proposals/dismiss', { id: 'A'.repeat(22), command: 'assign' })).status, 404);

    // Past its window: gone, for an approval and a dismissal alike, and listed as expired.
    const stale = await createProposal(binding, ada, draft(), () => new Date(Date.now() - 15 * DAY));
    const late = await post('account-ada', '/api/commands/proposals/approve', { id: stale.id, command: 'assign' });
    assert.equal(late.status, 410, JSON.stringify(late.body));
    assert.equal((await proposalRow(stale.id))?.state, 'expired');
    assert.equal((await post('account-ada', '/api/commands/proposals/dismiss', { id: stale.id, command: 'assign' })).status, 410);
    const swept = await createProposal(binding, ada, draft(), () => new Date(Date.now() - 15 * DAY));
    const open = await post('account-ada', '/api/commands/proposals', { states: ['proposed'] });
    assert.equal(open.status, 200, JSON.stringify(open.body));
    assert.deepEqual(open.body.proposals, []);
    assert.equal((await proposalRow(swept.id))?.state, 'expired');
    assert.equal(runs, 3, 'nothing but the two approvals and the refused run ran');

    // Provenance: a job's write stays unconfirmed until a person granted a command on the row confirms it.
    await assert.rejects(
      markProvenance(binding, ada, {
        command: 'assign',
        key: { id: 1 },
        field: 'title',
        maker: 'agent' as never,
        makerActor: 'x',
        evidence: [],
      }),
    );
    await markProvenance(binding, ada, {
      command: 'assign',
      key: { id: 1 },
      field: 'title',
      maker: 'job',
      makerActor: 'job:import',
      evidence: [],
    });
    const unmarked = async () =>
      Number((await engine.all(`SELECT count(*) AS n FROM ${engine.table(tables.provenance)} WHERE confirmed_by IS NULL`))[0]!.n);
    assert.equal(await unmarked(), 1);
    // For review's second section: the mark, with the command it is confirmed through; nothing for a reader without one.
    const review = await post('account-bo', '/api/commands/proposals', { unconfirmed: true });
    assert.equal(review.status, 200, JSON.stringify(review.body));
    assert.deepEqual(
      review.body.unconfirmed.map((each: { resource: string; field: string; actorKind: string; command: string }) => [
        each.resource,
        each.field,
        each.actorKind,
        each.command,
      ]),
      [['loan', 'title', 'job', 'assign']],
    );
    assert.equal((await post('account-bo', '/api/commands/proposals', {})).body.unconfirmed, undefined);
    assert.equal((await post('account-bo', '/api/commands/proposals', { unconfirmed: 'yes' })).status, 400);
    const blind = await post('account-cy', '/api/commands/proposals', { unconfirmed: true });
    assert.ok(blind.status === 403 || (blind.status === 200 && blind.body.unconfirmed.length === 0), JSON.stringify(blind.body));
    const confirm = { command: 'assign', resource: 'loan', key: { id: 1 }, field: 'title' };
    assert.equal((await post('account-cy', '/api/commands/provenance/confirm', confirm)).status, 403);
    assert.equal((await post('account-ada', '/api/commands/provenance/confirm', { ...confirm, resource: 'assignment' })).status, 403);
    assert.equal(await unmarked(), 1);
    const confirmed = await post('account-ada', '/api/commands/provenance/confirm', confirm);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.deepEqual(confirmed.body, { confirmed: 1, fields: ['title'] });
    assert.equal(await unmarked(), 0);
    assert.deepEqual((await post('account-bo', '/api/commands/proposals', { unconfirmed: true })).body.unconfirmed, []);
    assert.equal((await engine.all(`SELECT confirmed_by FROM ${engine.table(tables.provenance)}`))[0]!.confirmed_by, 'account-ada');
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    await makers.closeAll();
  }
}
