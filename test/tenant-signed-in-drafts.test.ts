/**
 * A signed-in form saved on every step (`owner`) in a tenant App, over the tenant HTTP host: the draft is a root in
 * the member's own tenant, its owner column the member's row of that tenant's people (`auth.me` names the account
 * column), filled by the server on the tenant engine and never by the request. Every step, resume, review and
 * start-over finds it again by that owner, under the member's own grant, in the tenant's own rows.
 *
 * What is proved here: start, step, resume and submit work end to end; another member of the same tenant and an
 * account of another tenant can neither open, step, review, submit nor discard it (a 404, or nothing found), and the
 * draft is untouched by their attempts. A file beneath the draft is the owner's alone until it is submitted: to another
 * member of the tenant, whose grants read the file resource, it is as absent as a file that is not there.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { VerifiedSessionInstance } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { refuse } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { literal, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { commandEnvelope } from '../packages/mistri/src/server/testing/appRequests.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { parseTestApp } from './support/commandCatalog.js';

type Answer = { status: number; text: string; body: any };
type Context = { tabId: string; context: string; accountId: string; tenantId: string; revision: number };
const appId = 'people';
const binding = { appId, source: { id: 'business', connection: 'business-db' }, storeId: 'people-drafts-store' };

/* Eve and Ada are north's, Sam is south's: each a person row of their own tenant, found by account id. */
const TABLES = `
  CREATE TABLE person (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, account_id TEXT NOT NULL, name TEXT NOT NULL,
    UNIQUE (tenant_id, account_id));
  CREATE TABLE onboarding (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL,
    person_id TEXT NOT NULL REFERENCES person(id), full_name TEXT, plan TEXT, reference TEXT,
    resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT);
  CREATE TABLE contact (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, onboarding_id TEXT NOT NULL REFERENCES onboarding(id),
    label TEXT NOT NULL);
  CREATE TABLE document (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL,
    onboarding_id TEXT NOT NULL REFERENCES onboarding(id), file_name TEXT NOT NULL, data BLOB);
  INSERT INTO person VALUES ('north-eve', 'north', 'eve', 'Eve'), ('north-ada', 'north', 'ada', 'Ada'),
    ('south-sam', 'south', 'sam', 'Sam');`;

const nameInput = { full_name: { label: 'Full name', type: 'text', max: 60 } } as const;
const planInput = { plan: { label: 'Plan', type: 'text', max: 20 } } as const;
const contactInput = { contact_label: { label: 'Contact', type: 'text', max: 60 } } as const;
const submitInput = { consent: { label: 'These details are true', type: 'boolean' } } as const;
const reference = (id: string, input: object) => ({ id, version: 1, input });
const IDS = ['startOnboarding', 'savePlan', 'saveContact', 'submitOnboarding'];

const app = parseTestApp(
  {
    id: appId,
    name: 'People',
    auth: { rows: 'tenant', me: { from: 'person', column: 'account_id' }, roles: { member: { read: true, commands: IDS } } },
    sources: { business: { connection: binding.source.connection } },
    resources: {
      person: { owner: 'tenant' },
      onboarding: { owner: 'tenant', access: 'write' },
      contact: { owner: 'tenant', access: 'write' },
      document: { owner: 'tenant', access: 'write', file: { content: 'data', name: 'file_name' } },
    },
    views: {
      onboardings: { kind: 'list', from: 'onboarding' },
      onboard: {
        kind: 'form',
        label: 'Onboarding',
        command: reference('submitOnboarding', submitInput),
        steps: [
          { id: 'you', label: 'You', command: reference('startOnboarding', nameInput) },
          { id: 'plan', label: 'Plan', command: reference('savePlan', planInput) },
          { id: 'contact', label: 'Contact', command: reference('saveContact', contactInput) },
        ],
        resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress', after: '14 days' },
        draft: { status: 'in_progress' },
        owner: 'person_id',
      },
    },
    home: 'onboardings',
    nav: ['onboardings', 'onboard'],
  },
  'tenant signed-in drafts fixture',
);

const base = { targets: 'none', source: 'business', target: 'onboarding', read: ['onboarding', 'contact', 'person', 'document'] } as const;
// A step's file is a row of `document` beneath the draft, so the form writes there too and start-over removes it.
const WRITE = ['onboarding', 'contact', 'document'] as const;
const registry = defineCommands({
  startOnboarding: defineCommand({
    ...base,
    write: WRITE,
    input: nameInput,
    output: shape({ message: literal('Saved.') }),
    async handle({ db, draft }, input) {
      if (!draft) return refuse('forbidden');
      // The draft's start carries the owner: this member's row of the tenant's people, never a value of the request.
      if (draft.root) await db.onboarding.update(await db.onboarding.get(draft.root), input);
      // A tenant-owned table is keyed by one opaque text id, which the handler mints.
      else await db.onboarding.insert({ id: randomUUID(), ...input, ...draft.start });
      return { message: 'Saved.' as const };
    },
  }),
  savePlan: defineCommand({
    ...base,
    write: WRITE,
    input: planInput,
    output: shape({ message: literal('Saved.') }),
    async handle({ db, draft }, input) {
      await db.onboarding.update(await db.onboarding.get(draft!.root!), input);
      return { message: 'Saved.' as const };
    },
  }),
  saveContact: defineCommand({
    ...base,
    write: WRITE,
    input: contactInput,
    output: shape({ message: literal('Saved.') }),
    async handle({ db, draft }, input) {
      for (const row of await db.contact.where({})) await db.contact.remove(row);
      await db.contact.insert({ id: randomUUID(), label: input.contact_label, onboarding_id: draft!.root!.id as string });
      return { message: 'Saved.' as const };
    },
  }),
  submitOnboarding: defineCommand({
    ...base,
    write: WRITE,
    input: submitInput,
    output: shape({ reference: text() }),
    async handle({ db, draft }, input) {
      if (!input.consent) refuse('invalid_input', 'consent');
      const root = await db.onboarding.get(draft!.root!);
      const ref = `ONB-${String(root.id).slice(0, 8)}`;
      await db.onboarding.update(root, { status: 'submitted', reference: ref });
      return { reference: ref };
    },
  }),
});

const rows: RowScope = { person: true, onboarding: true, contact: true, document: true };
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId,
  storeId: binding.storeId,
  ownership: {
    person: { kind: 'tenant', column: 'tenant_id' },
    onboarding: { kind: 'tenant', column: 'tenant_id' },
    contact: { kind: 'tenant', column: 'tenant_id' },
    document: { kind: 'tenant', column: 'tenant_id' },
  },
  resolveMembershipRows: () => rows,
  resolveRows: () => rows,
  resultReferences: Object.fromEntries(IDS.map((id) => [id, () => []])),
});

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-tenant-drafts-'));
  const path = join(directory, 'business.db'),
    db = new DatabaseSync(path);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; ${TABLES}`);
  provisionSqliteTenantStore(path, binding);
  migrateSqliteCommandJournal(path);
  const operations = new TransactionOperations();
  db.exec('BEGIN IMMEDIATE');
  const admin = createSqliteTenantAdministration(db, operations, binding);
  for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
  for (const [tenantId, accountId] of [
    ['north', 'eve'],
    ['north', 'ada'],
    ['south', 'sam'],
  ])
    await admin.putMembership({
      tenantId,
      accountId,
      membershipId: `${tenantId}-${accountId}`,
      status: 'active',
      roles: ['member'],
      validUntil: Date.now() + 3_600_000,
      expectedVersion: null,
    });
  await operations.finish();
  db.exec('COMMIT');
  /** Who the session is, per request: a case switches accounts here. */
  const as = { account: 'eve' };
  const enrollment = await createTenantEnrollment<IncomingMessage>({
    app,
    pages: [],
    policy,
    source: { ...binding.source, existingPath: path },
    deployment: 'people-drafts-deployment',
    roles: ['member'],
    maxLifetimeMs: 300_000,
    commands: { registry },
    verifySession: async () => ({ id: as.account, who: `${as.account}@example.invalid` }),
  });
  const bound = { host: '127.0.0.1', port: 0 };
  const owner = createTenantHttpServer({
    app,
    enrollment,
    bound,
    verifySessionInstance: (): VerifiedSessionInstance => ({
      identity: { id: as.account, who: `${as.account}@example.invalid` },
      sessionId: `session-${as.account}`,
      expiresAt: Date.now() + 3_600_000,
    }),
  });
  t.after(async () => {
    const stopped = new Promise<void>((resolve) => owner.server.close(() => resolve()));
    owner.server.closeAllConnections();
    await stopped;
    await owner.retire();
    await enrollment.retire();
  });
  owner.server.listen(0, bound.host);
  await once(owner.server, 'listening');
  const address = owner.server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const call = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  };
  const select = (path: string, tenant: string) => `${path}?app=${appId}&tenant=${tenant}`;
  /** The account's lease on its tenant. */
  const open = async (account: string, tenant: string): Promise<Context> => {
    as.account = account;
    const reply = await call(select('/api/tenant/context/open', tenant), {});
    assert.equal(reply.status, 200, reply.text);
    return reply.body as Context;
  };
  const leased = (lease: Context, path: string, body: unknown) => {
    as.account = lease.accountId;
    return call(select(path, lease.tenantId), body, {
      'x-mistri-tab': lease.tabId,
      'x-mistri-context': lease.context,
      'x-mistri-lease-revision': String(lease.revision),
      'x-mistri-account': lease.accountId,
    });
  };
  const draft = (lease: Context, body: unknown) => leased(lease, '/api/commands/draft', body);
  const ids: Record<string, string> = { you: 'startOnboarding', plan: 'savePlan', contact: 'saveContact' };
  let n = 0;
  const envelope = (command: string, input: unknown) =>
    commandEnvelope({
      command,
      commandVersion: 1,
      key: {},
      expectedVersion: 0,
      input,
      idempotencyKey: `${command}-${String(++n).padStart(6, '0')}-tenant-draft`,
    });
  return {
    db,
    open,
    file: (lease: Context, id: string) => leased(lease, '/api/file/read', { table: 'document', key: { id } }),
    step: (lease: Context, step: string, input: unknown, hint?: string) =>
      draft(lease, {
        form: 'onboard',
        op: 'step',
        step,
        ...(hint === undefined ? {} : { draft: hint }),
        request: envelope(ids[step], input),
      }),
    op: (lease: Context, op: 'resume' | 'review' | 'discard', hint?: string) =>
      draft(lease, { form: 'onboard', op, ...(hint === undefined ? {} : { draft: hint }) }),
    submit: (lease: Context, version: string, hint?: string) =>
      draft(lease, {
        form: 'onboard',
        op: 'submit',
        version,
        ...(hint === undefined ? {} : { draft: hint }),
        request: envelope('submitOnboarding', { consent: true }),
      }),
    // As plain objects: SQLite's rows have no prototype, which deepStrictEqual counts.
    onboardings: () =>
      db
        .prepare('SELECT id, tenant_id, status, person_id, full_name, plan, reference FROM onboarding ORDER BY rowid')
        .all()
        .map((row) => ({ ...row })),
    contacts: () =>
      db
        .prepare('SELECT tenant_id, onboarding_id, label FROM contact ORDER BY rowid')
        .all()
        .map((row) => ({ ...row })),
  };
}

test("a member's draft is a root in their own tenant, owned by their row there: start, step, resume and submit", async (t) => {
  const f = await fixture(t);
  const eve = await f.open('eve', 'north');
  const first = await f.step(eve, 'you', { full_name: 'Eve Lane' });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.body.draft.saved, ['you']);
  assert.deepEqual(
    f.onboardings().map((row) => [row.tenant_id, row.status, row.person_id, row.full_name]),
    [['north', 'in_progress', 'north-eve', 'Eve Lane']],
    "the owner is the session's person row in north, written by the server on the tenant engine",
  );
  // The first step again saves into the same draft.
  assert.equal((await f.step(eve, 'you', { full_name: 'Eve M. Lane' })).status, 200);
  assert.equal(f.onboardings().length, 1);
  assert.equal((await f.step(eve, 'plan', { plan: 'team' })).status, 200);
  assert.equal((await f.step(eve, 'contact', { contact_label: 'eve@work.test' })).status, 200);
  assert.deepEqual(f.contacts(), [{ tenant_id: 'north', onboarding_id: first.body.draft.id, label: 'eve@work.test' }]);
  // Resumed on a fresh lease, as after closing the tab: the same draft, every step saved.
  const again = await f.open('eve', 'north');
  const resumed = await f.op(again, 'resume');
  assert.equal(resumed.status, 200, resumed.text);
  assert.equal(resumed.body.draft.id, first.body.draft.id);
  assert.deepEqual(resumed.body.draft.saved, ['you', 'plan', 'contact']);
  assert.equal(resumed.body.draft.reopen, null);
  const review = await f.op(again, 'review');
  assert.equal(review.status, 200, review.text);
  assert.match(review.body.version, /^[0-9a-f]{64}$/);
  const done = await f.submit(again, review.body.version);
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.result.reference, `ONB-${String(first.body.draft.id).slice(0, 8)}`);
  assert.deepEqual(
    f.onboardings().map((row) => [row.status, row.person_id, row.full_name, row.plan]),
    [['submitted', 'north-eve', 'Eve M. Lane', 'team']],
  );
  // A submitted application is no draft.
  assert.deepEqual((await f.op(again, 'resume')).body, { draft: null });
});

test('neither another member of the tenant nor an account of another tenant can open, step, submit or discard it', async (t) => {
  const f = await fixture(t);
  const eve = await f.open('eve', 'north');
  const first = await f.step(eve, 'you', { full_name: 'Eve Lane' });
  assert.equal(first.status, 200, first.text);
  assert.equal((await f.step(eve, 'plan', { plan: 'team' })).status, 200);
  const mine = first.body.draft.id as string;
  const before = f.onboardings();
  for (const [account, tenant] of [
    ['ada', 'north'],
    ['sam', 'south'],
  ]) {
    const other = await f.open(account, tenant);
    // Nothing of Eve's to resume, whatever is guessed.
    assert.deepEqual((await f.op(other, 'resume')).body, { draft: null }, account);
    assert.equal((await f.op(other, 'resume', mine)).status, 404, account);
    for (const reply of [
      await f.op(other, 'review', mine),
      await f.step(other, 'plan', { plan: 'solo' }, mine),
      await f.step(other, 'plan', { plan: 'solo' }),
      await f.submit(other, 'a'.repeat(64), mine),
    ])
      assert.equal(reply.status, 404, `${account}: ${reply.text}`);
    // Start over finds nothing of theirs to discard: Eve's id named is not found, and Eve's draft stays.
    assert.deepEqual((await f.op(other, 'discard')).body, { discarded: false }, account);
    assert.equal((await f.op(other, 'discard', mine)).status, 404, account);
    assert.deepEqual(f.onboardings(), before, `${account} left Eve's draft as it was`);
  }
  // A first step of Ada's is a draft of her own, owned by her row; Eve's id named on it is still not found.
  const ada = await f.open('ada', 'north');
  const hers = await f.step(ada, 'you', { full_name: 'Ada Byron' });
  assert.equal(hers.status, 200, hers.text);
  assert.notEqual(hers.body.draft.id, mine);
  assert.equal((await f.step(ada, 'plan', { plan: 'solo' }, mine)).status, 404);
  // Sam's draft is south's, owned by his row there.
  const sam = await f.open('sam', 'south');
  const his = await f.step(sam, 'you', { full_name: 'Sam Ortiz' });
  assert.equal(his.status, 200, his.text);
  assert.deepEqual(
    f.onboardings().map((row) => [row.tenant_id, row.person_id, row.full_name, row.plan]),
    [
      ['north', 'north-eve', 'Eve Lane', 'team'],
      ['north', 'north-ada', 'Ada Byron', null],
      ['south', 'south-sam', 'Sam Ortiz', null],
    ],
  );
  // Eve's own start-over discards only hers.
  const back = await f.open('eve', 'north');
  assert.deepEqual((await f.op(back, 'discard')).body, { discarded: true });
  assert.deepEqual(
    f.onboardings().map((row) => row.person_id),
    ['north-ada', 'south-sam'],
  );
});

test("a file beneath a member's draft is theirs alone until it is submitted, though the tenant's members read files", async (t) => {
  const f = await fixture(t);
  const eve = await f.open('eve', 'north');
  const first = await f.step(eve, 'you', { full_name: 'Eve Lane' });
  assert.equal(first.status, 200, first.text);
  const mine = first.body.draft.id as string;
  // As a step's staged file is taken in: a row beneath the draft's root, in Eve's tenant.
  f.db.prepare("INSERT INTO document VALUES ('doc-1', 'north', ?, 'passport.pdf', X'25504446')").run(mine);
  const own = await f.file(eve, 'doc-1');
  assert.equal(own.status, 200, own.text);
  assert.equal(own.body.name, 'passport.pdf');
  const ada = await f.open('ada', 'north');
  const guessed = await f.file(ada, 'doc-1');
  assert.equal(guessed.status, 404, guessed.text);
  assert.doesNotMatch(guessed.text, /passport|JVBERg/, 'nothing of the file is in the refusal');
  assert.equal((await f.file(await f.open('sam', 'south'), 'doc-1')).status, 404);
  // Submitted, the application's files follow the record's normal scope: a member of north reads them.
  assert.equal((await f.step(eve, 'plan', { plan: 'team' })).status, 200);
  assert.equal((await f.step(eve, 'contact', { contact_label: 'eve@work.test' })).status, 200);
  const back = await f.open('eve', 'north');
  const review = await f.op(back, 'review');
  assert.equal(review.status, 200, review.text);
  assert.equal((await f.submit(back, review.body.version)).status, 200);
  const after = await f.file(await f.open('ada', 'north'), 'doc-1');
  assert.equal(after.status, 200, after.text);
  assert.equal(after.body.name, 'passport.pdf');
});
