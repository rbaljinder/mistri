/**
 * A signed-in form saved on every step (`owner`), end to end over HTTP on an ordinary App: the draft is a person's —
 * the root carries the session's `me` in its owner column, filled by the server — and every step and the submit find
 * it again by that owner, in the step's own transaction, under the person's own grant of the form's commands.
 *
 * What is proved here: nobody else can list, open, step or submit it (a guessed id is a 404, never a 403); a grant lost
 * between steps refuses the next step and leaves the draft as it is; what was reviewed is what is submitted (a change
 * from another tab refuses the submit as stale and writes nothing); a step or a submit sent twice writes once; and a
 * resume reopens at the first step today's rules refuse. The public saved form's suite (saved-forms-http) is the
 * other kind of draft and runs untouched beside this.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { defineCommand, defineCommands, type BusinessCommandRegistry } from '../packages/mistri/src/server/commands/businessCommands.js';
import { refuse } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { literal, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { commandEnvelope } from '../packages/mistri/src/server/testing/appRequests.js';
import { parseTestApp } from './support/commandCatalog.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { publicFormProblems, signedInDraftProblems } from '../packages/mistri/src/server/forms/savedFormChecks.js';
import type { AppDef } from '../packages/mistri/src/shared/app.js';

const nameInput = { full_name: { label: 'Full name', type: 'text', max: 60 } } as const;
const planInput = { plan: { label: 'Plan', type: 'text', max: 20 } } as const;
const contactInput = { contact_label: { label: 'Contact', type: 'text', max: 60 } } as const;
const submitInput = { consent: { label: 'These details are true', type: 'boolean' } } as const;
const reference = (id: string, input: object) => ({ id, version: 1, input });

const form = {
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
};

const ALL = ['onboarding', 'contact', 'person'] as const;
const WRITE = ['onboarding', 'contact'] as const;
function commandsFor(read: readonly string[] = ALL): BusinessCommandRegistry {
  const base = { targets: 'none', source: 'main', target: 'onboarding', read: read as typeof ALL } as const;
  return defineCommands({
    startOnboarding: defineCommand({
      ...base,
      write: WRITE,
      input: nameInput,
      output: shape({ message: literal('Saved.') }),
      async handle({ db, draft }, input) {
        if (!draft) return refuse('forbidden');
        if (draft.root) await db.onboarding.update(await db.onboarding.get(draft.root), input);
        else await db.onboarding.insert({ ...input, ...draft.start });
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
        await db.contact.insert({ label: input.contact_label, onboarding_id: draft!.root!.id as number });
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
        const ref = `ONB-${String(root.id).padStart(4, '0')}`;
        await db.onboarding.update(root, { status: 'submitted', reference: ref });
        return { reference: ref };
      },
    }),
  });
}

const config = (
  saved: Record<string, unknown> = form,
  roles: Record<string, unknown> = { member: { read: true, commands: COMMAND_IDS } },
) => ({
  id: 'people',
  name: 'People',
  auth: { me: { from: 'person', column: 'email' }, roles },
  sources: { main: { connection: 'private-db' } },
  resources: { person: {}, onboarding: { access: 'write' }, contact: { access: 'write' } },
  views: { onboardings: { kind: 'list', from: 'onboarding' }, onboard: saved },
  home: 'onboardings',
  nav: ['onboardings', 'onboard'],
});
const COMMAND_IDS = ['startOnboarding', 'savePlan', 'saveContact', 'submitOnboarding'];

interface Fixture {
  base: string;
  db: DatabaseSync;
  /** Who the session is, per request: tests switch accounts and roles here. */
  as: { email: string; role: string };
  post(body: unknown): Promise<{ status: number; body: any }>;
  step(step: string, input: unknown, options?: { key?: string; draft?: number | string }): Promise<{ status: number; body: any }>;
  submit(options?: { version?: string; key?: string; draft?: number | string }): Promise<{ status: number; body: any }>;
  op(op: 'resume' | 'review' | 'discard', draft?: number | string): Promise<{ status: number; body: any }>;
  registry: Registry;
  app: AppDef;
}

async function fixture(run: (f: Fixture) => Promise<void>, options: { rules?: (db: DatabaseSync) => void } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-signed-in-drafts-'));
  const file = join(directory, 'people.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE person(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL);
    INSERT INTO person VALUES (1, 'ann@example.test'), (2, 'bob@example.test');
    CREATE TABLE onboarding(id INTEGER PRIMARY KEY, status TEXT NOT NULL, person_id INTEGER NOT NULL REFERENCES person(id),
      full_name TEXT, plan TEXT, reference TEXT, resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT);
    CREATE TABLE contact(id INTEGER PRIMARY KEY, onboarding_id INTEGER NOT NULL REFERENCES onboarding(id), label TEXT NOT NULL);`);
  options.rules?.(db);
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'private-db', name: 'Private', url: file, writable: true, source: 'config' });
  const app = parseTestApp(config(), 'signed-in drafts fixture');
  const as = { email: 'ann@example.test', role: 'member' };
  const host: AppHost = {
    app: { app, path: '/private/app.ts', pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: '/private/auth.db',
      close() {},
      handler: async () => {},
      session: async () => ({ id: `account-${as.email}`, who: as.email, role: as.role }),
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], commands: { appId: 'people', registry: commandsFor() } });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    const base = `http://${bound.host}:${bound.port}`;
    const post = async (body: unknown) => {
      const response = await fetch(`${base}/api/commands/draft`, {
        method: 'POST',
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json', origin: base },
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    const ids: Record<string, string> = { you: 'startOnboarding', plan: 'savePlan', contact: 'saveContact' };
    let n = 0;
    const f: Fixture = {
      base,
      db,
      as,
      registry,
      app,
      post,
      step: (step, input, o = {}) =>
        post({
          form: 'onboard',
          op: 'step',
          step,
          ...(o.draft === undefined ? {} : { draft: o.draft }),
          request: commandEnvelope({
            command: ids[step],
            commandVersion: 1,
            key: {},
            expectedVersion: 0,
            input,
            idempotencyKey: o.key ?? `step-${step}-${String(++n).padStart(6, '0')}-key`,
          }),
        }),
      submit: (o = {}) =>
        post({
          form: 'onboard',
          op: 'submit',
          ...(o.draft === undefined ? {} : { draft: o.draft }),
          ...(o.version === undefined ? {} : { version: o.version }),
          request: commandEnvelope({
            command: 'submitOnboarding',
            commandVersion: 1,
            key: {},
            expectedVersion: 0,
            input: { consent: true },
            idempotencyKey: o.key ?? `submit-${String(++n).padStart(6, '0')}-key`,
          }),
        }),
      op: (op, draft) => post({ form: 'onboard', op, ...(draft === undefined ? {} : { draft }) }),
    };
    await run(f);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const onboardings = (f: Fixture) => f.db.prepare('SELECT * FROM onboarding ORDER BY id').all() as Array<Record<string, unknown>>;
const contacts = (f: Fixture) => f.db.prepare('SELECT * FROM contact ORDER BY id').all() as Array<Record<string, unknown>>;

/** A person's draft through all three steps. */
async function fill(f: Fixture) {
  const first = await f.step('you', { full_name: 'Ann Lee' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal((await f.step('plan', { plan: 'team' })).status, 200);
  assert.equal((await f.step('contact', { contact_label: 'ann@work.test' })).status, 200);
  return first.body.draft as { id: number; saved: string[] };
}

test('the first step creates the person’s draft with the owner the server filled; each step saves into it', async () => {
  await fixture(async (f) => {
    const first = await f.step('you', { full_name: 'Ann Lee' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.draft.saved, ['you']);
    assert.deepEqual(
      onboardings(f).map((row) => [row.status, row.person_id, row.full_name, row.resume_progress, row.resume_token_hash]),
      [['in_progress', 1, 'Ann Lee', 'you', null]],
      "the owner is the signed-in person's row (ann is person 1), and no cookie token is kept",
    );
    // The first step again is the same draft saved again, not a second draft.
    assert.equal((await f.step('you', { full_name: 'Ann M. Lee' })).status, 200);
    assert.equal(onboardings(f).length, 1);
    assert.equal(onboardings(f)[0].full_name, 'Ann M. Lee');
    await f.step('plan', { plan: 'team' });
    await f.step('contact', { contact_label: 'ann@work.test' });
    const review = await f.op('review');
    assert.equal(review.status, 200, JSON.stringify(review.body));
    assert.match(review.body.version, /^[0-9a-f]{64}$/);
    const done = await f.submit({ version: review.body.version });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.result.reference, 'ONB-0001');
    assert.equal(onboardings(f)[0].status, 'submitted');
    // A submitted application is no draft: nothing to resume, and the draft is never found again.
    assert.deepEqual((await f.op('resume')).body, { draft: null });
  });
});

test('ownership: a second account cannot list, open, step, review, discard or submit another’s draft; a guessed id is a 404', async () => {
  await fixture(async (f) => {
    const mine = await fill(f);
    f.as.email = 'bob@example.test';
    // Bob has no draft: his resume is empty, whatever he guesses.
    assert.deepEqual((await f.op('resume')).body, { draft: null });
    for (const reply of [
      await f.op('review', mine.id),
      await f.op('review'),
      await f.step('plan', { plan: 'solo' }, { draft: mine.id }),
      await f.submit({ draft: mine.id, version: 'a'.repeat(64) }),
    ]) {
      assert.equal(reply.status, 404, JSON.stringify(reply.body));
    }
    assert.equal((await f.op('discard', mine.id)).status, 404);
    // Bob's first step is a draft of his own, never Ann's.
    const bobs = await f.step('you', { full_name: 'Bob Roe' });
    assert.equal(bobs.status, 200, JSON.stringify(bobs.body));
    assert.notEqual(bobs.body.draft.id, mine.id);
    // And Bob naming Ann's id on his own draft's step is still not found.
    assert.equal((await f.step('plan', { plan: 'solo' }, { draft: mine.id })).status, 404);
    assert.deepEqual(
      onboardings(f).map((row) => [row.id, row.person_id, row.plan]),
      [
        [mine.id, 1, 'team'],
        [bobs.body.draft.id, 2, null],
      ],
      "Ann's draft is untouched",
    );
    // Ann's own hint of her id is fine.
    f.as.email = 'ann@example.test';
    assert.equal((await f.op('review', mine.id)).status, 200);
    // A hint that is not her draft's is a 404, even to her.
    assert.equal((await f.op('review', 99_999)).status, 404);
    // Start over discards only her own.
    assert.deepEqual((await f.op('discard')).body, { discarded: true });
    assert.deepEqual(
      onboardings(f).map((row) => row.person_id),
      [2],
    );
    assert.equal(contacts(f).length, 0, 'the rows beneath the draft go with it');
  });
});

test('revocation: a grant lost between steps refuses the next step and leaves the draft as it is', async () => {
  await fixture(async (f) => {
    assert.equal((await f.step('you', { full_name: 'Ann Lee' })).status, 200);
    assert.equal((await f.step('plan', { plan: 'team' })).status, 200);
    const before = onboardings(f);
    // The role that ran the form is gone: the session still names a person, but no grant.
    f.as.role = 'nobody';
    const refused = await f.step('contact', { contact_label: 'ann@work.test' });
    assert.ok(refused.status === 403 || refused.status === 401, JSON.stringify(refused.body));
    assert.equal((await f.submit({ version: 'a'.repeat(64) })).status, 403);
    assert.equal((await f.op('resume')).status, 403);
    assert.deepEqual(onboardings(f), before, 'nothing was written');
    assert.equal(contacts(f).length, 0);
    // Granted again, the draft is as it was left.
    f.as.role = 'member';
    const resumed = await f.op('resume');
    assert.deepEqual(resumed.body.draft.saved, ['you', 'plan']);
  });
});

test('what is reviewed is what is submitted: a change from another tab refuses the submit as stale and writes nothing', async () => {
  await fixture(async (f) => {
    await fill(f);
    const tabA = await f.op('review');
    // Tab B changes step 2 after A reviewed.
    assert.equal((await f.step('plan', { plan: 'solo' })).status, 200);
    const stale = await f.submit({ version: tabA.body.version });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.code, 'stale_record');
    assert.match(stale.body.message, /Review it again/);
    assert.equal(onboardings(f)[0].status, 'in_progress', 'nothing was submitted');
    // A change to a row beneath the root moves the version as well.
    const reviewed = await f.op('review');
    assert.equal((await f.step('contact', { contact_label: 'other@work.test' })).status, 200);
    assert.equal((await f.submit({ version: reviewed.body.version })).status, 409);
    // A submit that carries no version is not a reviewed one: stale, the same as a changed draft.
    assert.equal((await f.submit()).status, 409);
    // Reviewing again and submitting what was shown goes through.
    const fresh = await f.op('review');
    assert.notEqual(fresh.body.version, tabA.body.version);
    const done = await f.submit({ version: fresh.body.version });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(onboardings(f)[0].plan, 'solo');
  });
});

test('idempotency: a step sent twice with one key writes once and answers the first outcome; a submit retry answers the receipt', async () => {
  await fixture(async (f) => {
    const first = await f.step('you', { full_name: 'Ann Lee' }, { key: 'step-you-retry-key-0001' });
    assert.equal(first.status, 200);
    await f.step('plan', { plan: 'team' });
    await f.step('contact', { contact_label: 'ann@work.test' });
    // Same key, same input, after the step ran once: the first outcome again, and the row is not re-saved.
    f.db.prepare("UPDATE onboarding SET full_name = 'changed elsewhere'").run();
    const again = await f.step('you', { full_name: 'Ann Lee' }, { key: 'step-you-retry-key-0001' });
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.receiptId, first.body.receiptId);
    assert.equal(onboardings(f)[0].full_name, 'changed elsewhere', 'the retry wrote nothing');
    // The same key with different input is a conflict, not a second write.
    assert.equal((await f.step('you', { full_name: 'Someone Else' }, { key: 'step-you-retry-key-0001' })).status, 409);

    const review = await f.op('review');
    const sent = await f.submit({ version: review.body.version, key: 'submit-retry-key-000001' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    // The reply was lost; the page asks again with the same key — after the draft is no draft any more.
    const retried = await f.submit({ version: review.body.version, key: 'submit-retry-key-000001' });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.replayed, true);
    assert.equal(retried.body.receiptId, sent.body.receiptId);
    assert.deepEqual(retried.body.result, sent.body.result);
    assert.equal(onboardings(f).length, 1);
  });
});

test('resume reopens at the first step today’s rules refuse; a draft past its expiry is gone', async () => {
  await fixture(async (f) => {
    const mine = await fill(f);
    const resumed = await f.op('resume');
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.deepEqual(resumed.body.draft, {
      id: mine.id,
      saved: ['you', 'plan', 'contact'],
      expiresAt: resumed.body.draft.expiresAt,
      reopen: null,
      values: { full_name: 'Ann Lee', plan: 'team' },
    });
    assert.ok(Date.parse(resumed.body.draft.expiresAt) > Date.now() + 13 * 86_400_000);
    // A rule tightened since the plan was saved (the stored answer is no longer one the step takes): reopen there.
    f.db.prepare("UPDATE onboarding SET plan = 'a plan name that is far too long for the step now'").run();
    assert.equal((await f.op('resume')).body.draft.reopen, 'plan');
    // The first failing step wins.
    f.db.prepare('UPDATE onboarding SET full_name = NULL').run();
    assert.equal((await f.op('resume')).body.draft.reopen, 'you');
    // Expired: absent to every operation, and the step is a 404, not a revival.
    f.db.prepare("UPDATE onboarding SET resume_expires_at = '2020-01-01T00:00:00.000Z'").run();
    assert.deepEqual((await f.op('resume')).body, { draft: null });
    assert.equal((await f.step('plan', { plan: 'team' })).status, 404);
    assert.equal((await f.op('review')).status, 404);
  });
});

test('the load check: a signed-in saved form names an owner that is a real person-keyed column no step asks for', async () => {
  await fixture(async (f) => {
    const resources = await loadAppRuntimeResources(f.registry, f.app, 'private-db', () => {});
    const problemOf = (patch: Record<string, unknown>, registry = commandsFor()) => {
      const app = parseTestApp(config({ ...form, ...patch }), 'owner check');
      return signedInDraftProblems(app, registry, resources.schema) ?? publicFormProblems(app, registry, resources.schema);
    };
    assert.equal(problemOf({}), undefined);
    assert.match(String(problemOf({ owner: 'nope' })), /"onboarding.nope", which is not a column/);
    assert.match(String(problemOf({ owner: 'full_name' })), /"onboarding.full_name" \(save.owner\) is TEXT, and a person's key/);
    // The person is found through the people table, so every command of the form reads it.
    assert.match(String(problemOf({}, commandsFor(['onboarding', 'contact']))), /does not read "person"/);
    // An owner a step asks for would let the page choose whose draft it is.
    const asking = defineCommands({
      ...Object.fromEntries(Object.entries(commandsFor())),
      savePlan: defineCommand({
        targets: 'none',
        source: 'main',
        target: 'onboarding',
        read: ALL,
        write: ['onboarding', 'contact'],
        input: { person_id: { type: 'number' } },
        output: shape({ message: literal('Saved.') }),
        async handle() {
          return { message: 'Saved.' as const };
        },
      }),
    } as never);
    const ask = parseTestApp(
      config({
        ...form,
        steps: [
          form.steps[0],
          { id: 'plan', label: 'Plan', command: reference('savePlan', { person_id: { type: 'number' } }) },
          form.steps[2],
        ],
      }),
      'owner asked',
    );
    assert.match(String(signedInDraftProblems(ask, asking, resources.schema)), /asks for "person_id", the draft's owner/);
    // Starting over removes the draft with its rows under the first step's command, so that command writes every
    // table a later step does, whatever `abandoned` says.
    const base = commandsFor() as unknown as Record<string, { version?: unknown } & Record<string, unknown>>;
    const { version: _version, ...start } = base.startOnboarding;
    const narrow = defineCommands({ ...base, startOnboarding: defineCommand({ ...start, write: ['onboarding'] } as never) } as never);
    assert.match(
      String(signedInDraftProblems(parseTestApp(config({ ...form, abandoned: 'keep' }), 'kept'), narrow, resources.schema)),
      /starting over removes a signed-in draft.*must list "contact" in write/,
    );
  });
});

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const insertDraft = (f: Fixture, person: number, name: string, expires: string, progress = 'you') =>
  Number(
    f.db
      .prepare(
        `INSERT INTO onboarding(status, person_id, full_name, resume_expires_at, resume_progress) VALUES ('in_progress', ?, ?, ?, ?)`,
      )
      .run(person, name, expires, progress).lastInsertRowid,
  );

test('two open drafts of one person are not a lock-out: the newest is found, a hint picks the other, discard clears both', async () => {
  await fixture(async (f) => {
    // Two tabs raced the first step: both inserted. The second expires later, so it is the newest.
    const older = insertDraft(f, 1, 'Older', inDays(10));
    const newer = insertDraft(f, 1, 'Newer', inDays(12));
    // A stranger's draft never joins them.
    const bobs = insertDraft(f, 2, 'Bob Roe', inDays(30));
    f.as.email = 'bob@example.test';
    assert.equal((await f.op('resume')).body.draft.id, bobs);
    f.as.email = 'ann@example.test';
    assert.equal((await f.op('resume')).body.draft.id, newer);
    assert.equal((await f.op('resume', older)).body.draft.id, older);
    // A hint that names none of her open drafts is gone, as a stranger's is.
    assert.equal((await f.op('resume', bobs)).status, 404);
    assert.equal((await f.op('resume', 9999)).status, 404);
    // A step with no hint lands in the newest.
    assert.equal((await f.step('plan', { plan: 'team' })).status, 200);
    assert.deepEqual(
      onboardings(f).map((row) => [row.id, row.plan]),
      [
        [older, null],
        [newer, 'team'],
        [bobs, null],
      ],
    );
    assert.deepEqual((await f.op('discard')).body, { discarded: true });
    assert.equal((await f.op('resume')).body.draft.id, older, 'the other is found once the newest is gone');
    assert.deepEqual((await f.op('discard')).body, { discarded: true });
    assert.deepEqual((await f.op('resume')).body, { draft: null });
    assert.deepEqual((await f.op('discard')).body, { discarded: false });
    // The second account still sees only its own, untouched.
    f.as.email = 'bob@example.test';
    assert.equal((await f.op('resume')).body.draft.id, bobs);
    f.as.email = 'ann@example.test';
    assert.equal((await f.op('review', bobs)).status, 404);
    assert.deepEqual(
      onboardings(f).map((row) => row.id),
      [bobs],
    );
  });
});

test('thirty expired drafts do not hide the open one', async () => {
  await fixture(async (f) => {
    for (let i = 0; i < 30; i++) insertDraft(f, 1, `Old ${i}`, inDays(-1 - i));
    const open = insertDraft(f, 1, 'Open', inDays(3));
    const resumed = await f.op('resume');
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.draft.id, open);
    assert.equal(resumed.body.draft.values.full_name, 'Open');
  });
});

test('resume and review return the saved values the steps ask for, only to the owner, and nothing the platform keeps', async () => {
  await fixture(async (f) => {
    const mine = await fill(f);
    const resumed = await f.op('resume');
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.draft.id, mine.id);
    // The root columns the steps' inputs name; `contact_label` lives in a row of another name and is not guessed at.
    assert.deepEqual(resumed.body.draft.values, { full_name: 'Ann Lee', plan: 'team' });
    const review = await f.op('review');
    assert.deepEqual(review.body.values, { full_name: 'Ann Lee', plan: 'team' });
    const text = JSON.stringify([resumed.body, review.body]);
    for (const kept of ['person_id', 'resume_token_hash', 'resume_expires_at', 'resume_progress', 'in_progress']) {
      assert.ok(!Object.keys(resumed.body.draft.values).includes(kept), kept);
    }
    assert.ok(!text.includes('"person_id"'), 'the owner column is never returned');
    // Another account gets no draft, and so no values.
    f.as.email = 'bob@example.test';
    assert.deepEqual((await f.op('resume')).body, { draft: null });
    const stranger = await f.op('review', mine.id);
    assert.equal(stranger.status, 404);
    assert.equal(stranger.body.values, undefined);
  });
});
