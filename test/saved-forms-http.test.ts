/**
 * A public form saved on every step, end to end over HTTP on an ordinary App:
 * the first step inserts the application's root row in its draft state, the
 * later ones write the tables that reference it, and the submit finishes it in
 * one transaction. The applicant's place is an HttpOnly cookie whose hash
 * alone is on the root row.
 *
 * What is proved here is the write-only rule and the fence: no reply carries
 * a key, a hash or anything typed; a forged, stale or finished cookie finds
 * nothing and says so in one sentence; a step reaching for another
 * application's rows reads nothing and writes nothing; a status check answers
 * a state, alike for every wrong answer.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { COMMAND_JOURNAL_TABLES, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { type AppDef } from '../packages/mistri/src/shared/app.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { defineCommand, defineCommands, type BusinessCommandRegistry } from '../packages/mistri/src/server/commands/businessCommands.js';
import { refuse } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { literal, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { BODY_HOLD_MS } from '../packages/mistri/src/server/commands/businessCommandHttp.js';
import { parseTrustedProxies } from '../packages/engine/src/server/http/trust.js';
import { publicReference, publicReferencePattern } from '../packages/mistri/src/server/forms/publicReference.js';
import { resetStatusLockouts } from '../packages/mistri/src/server/forms/statusCheck.js';
import { publicFormProblems } from '../packages/mistri/src/server/forms/savedFormChecks.js';
import { withCondition } from '../packages/mistri/src/server/forms/savedFormLists.js';
import { publicPrefillProblems } from '../packages/mistri/src/server/forms/publicPrefill.js';
import type { PageDef } from '../packages/engine/src/shared/page.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { parseTestApp } from './support/commandCatalog.js';
import { defineChallenges } from '../packages/mistri/src/server/commands/challenges.js';

process.env.MISTRI_FORM_KEY ??= 'saved-forms-test-key-of-at-least-thirty-two-bytes';

const aboutInput = {
  first_name: { label: 'First name', type: 'text', max: 60 },
  last_name: { label: 'Last name', type: 'text', max: 60 },
  ssn_last4: { label: 'Last four of your SSN', type: 'text', pattern: '^\\d{4}$', sensitive: { keep: 'hash' } },
} as const;
const addressInput = {
  line1: { label: 'Street', type: 'text', max: 120 },
  city: { label: 'City', type: 'text', max: 60 },
} as const;
const coInput = {
  co_applicants: {
    label: 'Co-applicants',
    type: 'group',
    repeat: { max: 3 },
    fields: {
      name: { label: 'Name', type: 'text', max: 60 },
    },
  },
  // A probe, test-only: a position of another application the handler reaches for.
  probe: { label: 'Probe', type: 'number', integer: true, optional: true },
} as const;
const submitInput = { consent: { label: 'These details are true', type: 'boolean' } } as const;

const reference = (id: string, input: object) => ({ id, version: 1, input });
const savedForm = {
  kind: 'form',
  label: 'Apply',
  public: true,
  done: { title: 'Received' },
  command: reference('submitApplication', submitInput),
  steps: [
    { id: 'about-you', label: 'About you', command: reference('startApplication', aboutInput) },
    { id: 'address', label: 'Address', command: reference('saveAddress', addressInput) },
    { id: 'co-applicants', label: 'Co-applicants', command: reference('saveCoApplicants', coInput) },
  ],
  resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress', after: '14 days' },
  draft: { status: 'in_progress' },
  statusCheck: {
    receipt: 'reference',
    confirm: { last_name: 'Last name', ssn_last4: { label: 'Last four of your SSN', keyed: true } },
    show: ['status'],
    says: { status: { submitted: 'Received', in_review: 'In review' } },
  },
};

const ALL = ['application', 'address', 'co_applicant'] as const;
function registryFor(events: { steps: string[] }): BusinessCommandRegistry {
  return defineCommands({
    startApplication: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'application',
      read: ALL,
      write: ALL,
      public: true,
      input: aboutInput,
      output: shape({ message: literal('Saved.') }),
      async handle({ db, draft }, input) {
        events.steps.push('about-you');
        if (!draft) return refuse('forbidden');
        if (draft.root) await db.application.update(await db.application.get(draft.root), input);
        else await db.application.insert({ ...input, ...draft.start });
        return { message: 'Saved.' as const };
      },
    }),
    saveAddress: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'application',
      read: ['application', 'address'],
      write: ['application', 'address'],
      public: true,
      input: addressInput,
      output: shape({ message: literal('Saved.') }),
      async handle({ db, draft }, input) {
        events.steps.push('address');
        // Change from review overwrites: this application's rows, the only ones the fence shows.
        for (const row of await db.address.where({})) await db.address.remove(row);
        await db.address.insert({ ...input, application_id: draft!.root!.id as number });
        return { message: 'Saved.' as const };
      },
    }),
    saveCoApplicants: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'application',
      read: ['application', 'co_applicant'],
      write: ['application', 'co_applicant'],
      public: true,
      input: coInput,
      output: shape({}),
      async handle({ db, tx }, input) {
        events.steps.push('co-applicants');
        if (input.probe !== undefined) {
          // Another application's co-applicant, by its key: invisible, and refused on a write.
          const seen = await db.co_applicant.find({ id: input.probe });
          if (seen) throw new Error("the fence showed another application's row");
          await tx.update({ table: 'co_applicant', key: { id: input.probe }, values: { name: 'Overwritten' } });
        }
        for (const row of await db.co_applicant.where({})) await db.co_applicant.remove(row);
        for (const [index, row] of input.co_applicants.entries()) await db.co_applicant.insert({ name: row.name, position: index + 1 });
        return {};
      },
    }),
    submitApplication: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'application',
      read: ALL,
      write: ['application'],
      public: true,
      input: submitInput,
      output: shape({ reference: text({ pattern: publicReferencePattern('APP') }), message: literal('Application received.') }),
      async handle({ db, draft }, input) {
        events.steps.push('submit');
        if (!input.consent) refuse('invalid_input', 'consent');
        const root = await db.application.get(draft!.root!);
        // Re-validated as a whole, in the submit's one transaction.
        if (!root.first_name || !(await db.address.count({}))) refuse('ineligible_state');
        const receipt = publicReference('APP');
        await db.application.update(root, { status: 'submitted', reference: receipt });
        return { reference: receipt, message: 'Application received.' as const };
      },
    }),
  });
}

/** The App around the form; `form` replaces the saved form's declaration for a load check. */
const lendingConfig = (
  form: Record<string, unknown> = savedForm,
  auth: Record<string, unknown> = { roles: { officer: { read: true } } },
) => ({
  id: 'lending',
  name: 'Lending',
  auth,
  sources: { main: { connection: 'private-db' } },
  resources: {
    application: { access: 'write', segments: { submitted: 'status = submitted', in_progress: 'status = in_progress' } },
    address: { access: 'write' },
    co_applicant: { access: 'write' },
  },
  views: {
    applications: { kind: 'list', from: 'application' },
    triage: {
      kind: 'list',
      from: 'application',
      tabs: ['submitted', 'in_progress'],
    },
    apply: form,
  },
  home: 'applications',
  nav: ['applications', 'triage'],
});

interface Fixture {
  base: string;
  db: DatabaseSync;
  steps: string[];
  registry: Registry;
  app: AppDef;
  commands: BusinessCommandRegistry;
}

/* Every token the fixture's human check was asked about, in order. */
const verified: string[] = [];

/* A POST whose body goes as chunks, with no length: the server learns its size only by reading it. A trickle sends it a
   byte every half second until it is answered, so it is still arriving long after a person's would have. */
function chunkedPost(base: string, path: string, body: unknown, headers: Record<string, string>, pace: 'chunks' | 'trickle' = 'chunks') {
  return new Promise<{ status: number; body: any; headers: Record<string, unknown> }>((resolve, reject) => {
    const payload = JSON.stringify(body);
    let answered = false;
    const req = httpRequest(
      `${base}${path}`,
      { method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...headers } },
      (res) => {
        answered = true;
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined, headers: res.headers });
        });
      },
    );
    // An answer before the body ends closes the connection under the rest: not a failure.
    req.on('error', (error) => (answered ? undefined : reject(error)));
    if (pace === 'trickle') {
      let sent = 0;
      const drip = setInterval(() => {
        if (answered || req.destroyed) clearInterval(drip);
        else if (sent < payload.length) req.write(payload[sent++]);
        else {
          clearInterval(drip);
          req.end();
        }
      }, 500);
      req.write(payload[sent++]);
      return;
    }
    req.write(payload.slice(0, 1024));
    setTimeout(() => {
      if (!answered && !req.destroyed) req.end(payload.slice(1024));
    }, 20);
  });
}

async function fixture(
  run: (f: Fixture) => Promise<void>,
  options: { role?: string; commands?: (events: { steps: string[] }) => BusinessCommandRegistry; challenge?: boolean } = {},
) {
  resetPublicFormLimits();
  resetStatusLockouts();
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-saved-forms-'));
  const file = join(directory, 'apply.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE application(id INTEGER PRIMARY KEY, status TEXT NOT NULL, reference TEXT UNIQUE,
      first_name TEXT, last_name TEXT, ssn_last4 TEXT,
      resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT);
    CREATE TABLE address(id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES application(id), line1 TEXT NOT NULL, city TEXT NOT NULL);
    CREATE TABLE co_applicant(id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES application(id), position INTEGER NOT NULL, name TEXT NOT NULL);`);
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'private-db', name: 'Private', url: file, writable: true, source: 'config' });
  const app = parseTestApp(
    options.challenge ? lendingConfig(savedForm, { roles: { officer: { read: true } }, challenge: 'verifyHuman' }) : lendingConfig(),
    'saved forms fixture',
  );
  const steps: string[] = [];
  const commands = (options.commands ?? registryFor)({ steps });
  const host: AppHost = {
    app: {
      app,
      path: '/private/app.ts',
      pages: [],
      sources: {},
      ...(options.challenge
        ? {
            challenges: defineChallenges({
              verifyHuman: {
                verify: async (token: string) => {
                  verified.push(token);
                  return token.startsWith('person');
                },
              },
            }),
          }
        : {}),
    },
    pages: [],
    auth: {
      spec: app.auth!,
      store: '/private/auth.db',
      close() {},
      handler: async () => {},
      session: async () => (options.role ? { id: 'account-1', who: 'officer@example.test', role: options.role } : null),
    },
  };
  const bound = { host: '127.0.0.1', port: 0, trustedProxies: parseTrustedProxies([]).ranges };
  const server = createApp({ registry, bound, apps: [host], commands: { appId: 'lending', registry: commands } });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    await run({ base: `http://${bound.host}:${bound.port}`, db, steps, registry, app, commands });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
    resetPublicFormLimits();
    resetStatusLockouts();
  }
}

/** One browser's jar for the form's cookie: sent back as the browser would, on the form's own path. */
class Applicant {
  cookie: string | undefined;
  lastSetCookie: string | undefined;
  private n = 0;
  constructor(
    private readonly base: string,
    private readonly tag: string,
  ) {}
  async post(path: string, body: unknown, extra: Record<string, string> = {}) {
    const response = await fetch(`${this.base}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
      headers: {
        'content-type': 'application/json',
        origin: this.base,
        ...(this.cookie ? { cookie: `tw_form_apply=${this.cookie}` } : {}),
        ...extra,
      },
    });
    const raw = await response.text();
    const set = response.headers.get('set-cookie') ?? undefined;
    this.lastSetCookie = set;
    if (set) {
      const value = /^tw_form_apply=([^;]*)/.exec(set)?.[1];
      this.cookie = value || undefined;
    }
    return { status: response.status, body: JSON.parse(raw) as Record<string, unknown>, raw, set };
  }
  step(step: string, input: unknown) {
    return this.post(`/api/forms/apply/steps/${step}`, { input, submission: this.key() });
  }
  submit(input: unknown = { consent: true }) {
    return this.post('/api/forms/apply', { input, submission: this.key() });
  }
  resume() {
    return this.post('/api/forms/apply/resume', {});
  }
  key() {
    return `${this.tag}-submission-${String(++this.n).padStart(6, '0')}`;
  }
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const root = (f: Fixture, id: number) => f.db.prepare('SELECT * FROM application WHERE id = ?').get(id) as Record<string, unknown>;
const count = (f: Fixture, table: string) => Number((f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
/** Nothing typed, keyed, hashed or keyed-by-row is in any reply. */
function assertWriteOnly(raw: string, f: Fixture) {
  assert.doesNotMatch(raw, /Ada|Lovelace|1234|Analytical|London|Babbage/, 'no typed value comes back');
  for (const row of f.db.prepare('SELECT id, resume_token_hash FROM application').all() as Array<{
    id: number;
    resume_token_hash: string | null;
  }>) {
    if (row.resume_token_hash) assert.ok(!raw.includes(row.resume_token_hash), 'no token hash comes back');
  }
  // The command receipt's own id is the idempotency record's, never a row's; nothing else names anything.
  assert.doesNotMatch(raw.replace(/"receipt":\{"id":"[^"]+"/, ''), /"(id|key|application_id|root|token)"/, 'no key comes back');
}

const ABOUT = { first_name: 'Ada', last_name: 'Lovelace', ssn_last4: '1234' };
const ADDRESS = { line1: '12 Analytical Row', city: 'London' };
const CO = { co_applicants: [{ name: 'Charles Babbage' }, { name: 'Mary Somerville' }] };

test(
  'each step saves into the real tables and answers nothing typed; the submit finishes it in one go and clears the cookie',
  { timeout: 15_000 },
  async () => {
    await fixture(async (f) => {
      const served = (await fetch(`${f.base}/api/forms/apply`).then((response) => response.json())) as { form: Record<string, unknown> };
      // The page is told each step's questions and the submit's, and nothing of the commands or the tables.
      assert.deepEqual(
        (served.form.steps as Array<{ id: string; fields: string[] }>).map((step) => [step.id, step.fields]),
        [
          ['about-you', ['first_name', 'last_name', 'ssn_last4']],
          ['address', ['line1', 'city']],
          ['co-applicants', ['co_applicants', 'probe']],
        ],
      );
      assert.deepEqual(served.form.save, {
        submit: ['consent'],
        statusCheck: {
          confirm: [
            { name: 'last_name', label: 'Last name' },
            { name: 'ssn_last4', label: 'Last four of your SSN' },
          ],
        },
      });
      assert.doesNotMatch(JSON.stringify(served), /startApplication|resume_token_hash|in_progress|"version"/);

      const ada = new Applicant(f.base, 'ada');
      const first = await ada.step('about-you', ABOUT);
      assert.equal(first.status, 200, first.raw);
      assert.deepEqual(first.body, { saved: 'about-you' });
      assert.ok(first.set);
      assert.match(first.set, /HttpOnly/);
      assert.match(first.set, /SameSite=Strict/);
      assert.match(first.set, /Path=\/api\/forms\/apply(;|$)/);
      assert.match(first.set, /Max-Age=1209600/);
      assert.match(ada.cookie!, /^[A-Za-z0-9_-]{43}$/);
      // The root is in the App's own table, in its draft state, holding the cookie's hash and never the cookie.
      const created = root(f, 1);
      assert.equal(created.status, 'in_progress');
      assert.equal(created.resume_token_hash, hash(ada.cookie!));
      assert.equal(created.resume_progress, 'about-you');
      assert.ok(Date.parse(String(created.resume_expires_at)) > Date.now() + 13 * 86_400_000);
      // A keyed input is kept as its keyed hash only.
      assert.match(String(created.ssn_last4), /^keyed:[0-9a-f]{64}$/);
      assertWriteOnly(first.raw, f);

      assert.deepEqual((await ada.resume()).body, { saved: ['about-you'] });
      const second = await ada.step('address', ADDRESS);
      assert.equal(second.status, 200, second.raw);
      assert.equal(second.set, undefined, 'a later step sets no cookie');
      // Submitting before every step is saved is refused, and changes nothing.
      const early = await ada.submit();
      assert.equal(early.status, 409, early.raw);
      assert.equal(root(f, 1).status, 'in_progress');
      const third = await ada.step('co-applicants', CO);
      assert.equal(third.status, 200, third.raw);
      // Change from review: the first step again, with the cookie, overwrites the same root.
      const changed = await ada.step('about-you', { ...ABOUT, first_name: 'Augusta Ada' });
      assert.equal(changed.status, 200, changed.raw);
      assert.equal(count(f, 'application'), 1);
      assert.equal(root(f, 1).first_name, 'Augusta Ada');
      assert.deepEqual(
        f.db
          .prepare('SELECT application_id, position, name FROM co_applicant ORDER BY position')
          .all()
          .map((row) => ({ ...row })),
        [
          { application_id: 1, position: 1, name: 'Charles Babbage' },
          { application_id: 1, position: 2, name: 'Mary Somerville' },
        ],
      );
      assert.deepEqual((await ada.resume()).body, { saved: ['about-you', 'address', 'co-applicants'] });

      const done = await ada.submit();
      assert.equal(done.status, 200, done.raw);
      assert.match(String(done.body.reference), publicReferencePattern('APP'));
      assert.match(done.set!, /^tw_form_apply=;/);
      assert.match(done.set!, /Max-Age=0/);
      assert.equal(ada.cookie, undefined);
      const finished = root(f, 1);
      assert.equal(finished.status, 'submitted');
      assert.equal(finished.reference, done.body.reference);
      assert.equal(finished.resume_token_hash, null, 'the token dies with the submit');
      for (const reply of [second, third, changed, done, early]) assertWriteOnly(reply.raw, f);
      // History keeps every step as a command of its own, and its values out.
      const audit = f.db
        .prepare(`SELECT r.command_id, a.changes_json FROM ${sqliteAuditRows} a
      JOIN "${COMMAND_JOURNAL_TABLES.receipt}" r ON r.id = a.receipt_id ORDER BY r.rowid`)
        .all() as Array<{ command_id: string; changes_json: string }>;
      assert.deepEqual(
        [...new Set(audit.map((row) => row.command_id))],
        ['startApplication', 'saveAddress', 'saveCoApplicants', 'submitApplication'],
      );
      assert.doesNotMatch(audit.map((row) => row.changes_json).join('\n'), /Lovelace|1234|London|Babbage/);
    });
  },
);

async function applyThrough(applicant: Applicant, until: 'about-you' | 'address' | 'co-applicants' = 'co-applicants') {
  assert.equal((await applicant.step('about-you', ABOUT)).status, 200);
  if (until === 'about-you') return;
  assert.equal((await applicant.step('address', ADDRESS)).status, 200);
  if (until === 'address') return;
  assert.equal((await applicant.step('co-applicants', CO)).status, 200);
}

test(
  'a forged, missing or finished cookie finds nothing, alike, and is cleared; a stolen one is dead after the submit',
  { timeout: 15_000 },
  async () => {
    await fixture(async (f) => {
      const ada = new Applicant(f.base, 'ada');
      await applyThrough(ada, 'address');
      const before = f.db
        .prepare('SELECT * FROM application')
        .all()
        .map((row) => ({ ...row }));
      const gone = new Map<string, { status: number; body: Record<string, unknown> }>();
      // No cookie on a later step, a forged one, a malformed one, and the hash itself as a cookie.
      for (const [name, cookie] of [
        ['none', undefined],
        ['forged', 'A'.repeat(43)],
        ['malformed', 'not a token'],
        ['hash', root(f, 1).resume_token_hash as string],
      ] as const) {
        const other = new Applicant(f.base, `x-${name}`);
        other.cookie = cookie;
        const reply = await other.step('co-applicants', CO);
        gone.set(name, { status: reply.status, body: reply.body });
        assertWriteOnly(reply.raw, f);
        assert.deepEqual((await other.resume()).body, { saved: [] }, name);
        const submitted = await other.submit();
        assert.equal(submitted.status, reply.status, name);
      }
      const [answer] = [...gone.values()];
      assert.equal(answer.status, 404);
      for (const [name, reply] of gone) assert.deepEqual(reply, answer, `${name} answers as every other`);
      assert.deepEqual(
        f.db
          .prepare('SELECT * FROM application')
          .all()
          .map((row) => ({ ...row })),
        before,
        'nothing moved',
      );
      assert.equal(count(f, 'co_applicant'), 0);

      // A copy of the cookie works while the draft is open — the cookie is the applicant's place — and not after.
      // Five submissions a minute per address: a fresh budget for the second half, which is about the cookie, not the limit.
      resetPublicFormLimits();
      const thief = new Applicant(f.base, 'thief');
      const stolen = ada.cookie!;
      await applyThrough(ada, 'co-applicants');
      assert.equal((await ada.submit()).status, 200);
      for (const [step, input] of [
        ['about-you', ABOUT],
        ['address', ADDRESS],
        ['co-applicants', CO],
      ] as const) {
        thief.cookie = stolen;
        // The first step included: a dead cookie never starts a second application in its name.
        const late = await thief.step(step, input);
        assert.deepEqual({ status: late.status, body: late.body }, answer, step);
        assert.match(late.set ?? '', /Max-Age=0/, 'the dead cookie is cleared');
      }
      thief.cookie = stolen;
      assert.deepEqual({ status: (await thief.submit()).status }, { status: 404 });
      assert.deepEqual((await thief.resume()).body, { saved: [] });
      assert.equal(root(f, 1).status, 'submitted');
      assert.equal(count(f, 'application'), 1);
    });
  },
);

test(
  "a step sees and writes its own application only: another application's rows are never read or written",
  { timeout: 15_000 },
  async () => {
    await fixture(async (f) => {
      const ada = new Applicant(f.base, 'ada'),
        grace = new Applicant(f.base, 'grace');
      await applyThrough(ada);
      await applyThrough(grace, 'address');
      const adas = f.db.prepare('SELECT id FROM co_applicant WHERE application_id = 1 ORDER BY position').all() as Array<{ id: number }>;
      assert.equal(adas.length, 2);
      // Grace's handler reaches for Ada's co-applicant by its key: it reads nothing and its write is refused whole.
      const probe = await grace.step('co-applicants', { ...CO, probe: adas[0].id });
      assert.equal(probe.status, 403, probe.raw);
      assertWriteOnly(probe.raw, f);
      assert.deepEqual(
        f.db
          .prepare('SELECT name FROM co_applicant WHERE application_id = 1 ORDER BY position')
          .all()
          .map((row) => row.name),
        ['Charles Babbage', 'Mary Somerville'],
      );
      assert.equal(count(f, 'co_applicant'), 2, "nothing of Grace's landed either");
      // Replacing her own co-applicants removes hers alone: the handler's "every row" is this application's.
      assert.equal((await grace.step('co-applicants', { co_applicants: [{ name: "Grace's co-applicant" }] })).status, 200);
      assert.deepEqual(
        f.db
          .prepare('SELECT application_id, position FROM co_applicant ORDER BY application_id, position')
          .all()
          .map((row) => ({ ...row })),
        [
          { application_id: 1, position: 1 },
          { application_id: 1, position: 2 },
          { application_id: 2, position: 1 },
        ],
      );
      assert.deepEqual(
        f.db
          .prepare('SELECT application_id FROM address ORDER BY id')
          .all()
          .map((row) => row.application_id),
        [1, 2],
      );
    });
  },
);

test(
  'a step writes no platform column and never moves the draft state; a draft past its expiry cannot continue and is purged',
  { timeout: 15_000 },
  async () => {
    const hostile = (events: { steps: string[] }) => {
      const base = registryFor(events);
      return defineCommands({
        ...base,
        saveAddress: defineCommand({
          targets: 'none',
          source: 'main',
          target: 'application',
          read: ['application', 'address'],
          write: ['application', 'address'],
          public: true,
          input: addressInput,
          output: shape({ message: literal('Saved.') }),
          async handle({ db, draft }, input) {
            const row = await db.application.get(draft!.root!);
            // A step that tries to finish the application early, or to keep it alive past its expiry.
            if (input.city === 'Early') await db.application.update(row, { status: 'submitted' });
            if (input.city === 'Forever') await db.application.update(row, { resume_expires_at: '2999-01-01T00:00:00.000Z' });
            // Or files its row under another application's key.
            await db.address.insert({ ...input, ...(input.city === 'Elsewhere' ? { application_id: Number(draft!.root!.id) + 1 } : {}) });
            return { message: 'Saved.' as const };
          },
        }),
      });
    };
    await fixture(
      async (f) => {
        const ada = new Applicant(f.base, 'ada');
        await applyThrough(ada, 'about-you');
        for (const city of ['Early', 'Forever', 'Elsewhere']) {
          const refused = await ada.step('address', { line1: 'x', city });
          assert.equal(refused.status, 403, `${city}: ${refused.raw}`);
        }
        assert.equal(root(f, 1).status, 'in_progress');
        assert.equal(count(f, 'address'), 0);

        // Expired: the draft cannot continue, whatever its cookie, and the next applicant's first step removes it with its rows.
        assert.equal((await ada.step('address', ADDRESS)).status, 200);
        f.db.prepare('UPDATE application SET resume_expires_at = ? WHERE id = 1').run(new Date(Date.now() - 1000).toISOString());
        const late = await ada.step('co-applicants', CO);
        assert.equal(late.status, 404, late.raw);
        assert.equal(count(f, 'application'), 1, 'kept until a new application starts');
        const grace = new Applicant(f.base, 'grace');
        assert.equal((await grace.step('about-you', ABOUT)).status, 200);
        assert.deepEqual(
          f.db
            .prepare('SELECT status, resume_token_hash FROM application')
            .all()
            .map((row) => ({ ...row })),
          [{ status: 'in_progress', resume_token_hash: hash(grace.cookie!) }],
        );
        assert.equal(count(f, 'address'), 0, "the expired draft's rows went with it");
      },
      { commands: hostile },
    );
  },
);

test(
  'the status check answers a state for the right receipt and details, and one sentence for anything wrong, then locks',
  { timeout: 30_000 },
  async () => {
    await fixture(async (f) => {
      const ada = new Applicant(f.base, 'ada');
      await applyThrough(ada);
      const receipt = String((await ada.submit()).body.reference);
      const grace = new Applicant(f.base, 'grace');
      await applyThrough(grace);
      const check = (body: unknown) => new Applicant(f.base, 'checker').post('/api/forms/apply/status', body);
      const right = { receipt, confirm: { last_name: 'Lovelace', ssn_last4: '1234' } };
      const found = await check(right);
      assert.equal(found.status, 200, found.raw);
      assert.deepEqual(found.body, { status: { status: 'Received' } });
      // Case and spacing are the applicant's; the keyed value is compared as its keyed hash.
      assert.equal((await check({ receipt, confirm: { last_name: '  lovelace ', ssn_last4: '1234' } })).status, 200);
      f.db.prepare('UPDATE application SET status = ? WHERE reference = ?').run('in_review', receipt);
      assert.deepEqual((await check(right)).body, { status: { status: 'In review' } });
      f.db.prepare('UPDATE application SET status = ? WHERE reference = ?').run('internal_hold', receipt);
      assert.deepEqual((await check(right)).body, { status: { status: 'Received' } }, 'a state the author did not word reads as Received');
      resetPublicFormLimits();

      const wrong = [
        { receipt: publicReference('APP'), confirm: right.confirm },
        { receipt, confirm: { last_name: 'Lovelace', ssn_last4: '4321' } },
        { receipt, confirm: { last_name: 'Byron', ssn_last4: '1234' } },
      ];
      const answers = [];
      for (const body of wrong) {
        const started = Date.now();
        const reply = await check(body);
        answers.push({ status: reply.status, body: reply.body, elapsed: Date.now() - started });
        assertWriteOnly(reply.raw, f);
      }
      for (const answer of answers) {
        assert.deepEqual({ status: answer.status, body: answer.body }, { status: answers[0].status, body: answers[0].body });
        assert.ok(answer.elapsed >= 340, `held to the floor of time: ${answer.elapsed}ms`);
      }
      assert.equal(answers[0].status, 404);
      // A body missing a detail is refused by its shape alone.
      assert.equal((await check({ receipt, confirm: { last_name: 'Lovelace' } })).status, 400);
      resetPublicFormLimits();
      // Five failures lock the receipt for the hour, whoever makes them: the right details then read as wrong.
      for (let n = 0; n < 3; n++) assert.equal((await check(wrong[1])).status, 404);
      const locked = await check(right);
      assert.deepEqual({ status: locked.status, body: locked.body }, { status: answers[0].status, body: answers[0].body });
    });
  },
);

test('staff lists over the root leave drafts out unless a tab asks for them', { timeout: 10_000 }, async () => {
  await fixture(
    async (f) => {
      const response = await fetch(`${f.base}/api/app`, { headers: { origin: f.base } });
      const served = (await response.json()) as {
        app: {
          views: Record<string, { query?: string; tabs?: Array<{ label: string; query?: string; segment?: string; slug?: string }> }>;
        };
      };
      assert.equal(served.app.views.applications.query, 'status != in_progress');
      assert.deepEqual(served.app.views.triage.tabs, [
        // The draft-hiding condition rides on the tab beside the segment's word; the tab that names the draft state carries none.
        { label: 'Submitted', query: 'status != in_progress and submitted', segment: 'submitted', slug: 'submitted' },
        { label: 'In progress', query: 'in_progress', segment: 'in_progress', slug: 'in_progress' },
      ]);
      assert.equal(served.app.views.triage.query, undefined);
      // The menu counts the list, not its drafts' tab: its count leaves them out too.
      assert.equal((served.app.views.triage as { countQuery?: string }).countQuery, 'status != in_progress');
      assert.equal((served.app.views.applications as { countQuery?: string }).countQuery, undefined);
    },
    { role: 'officer' },
  );
});

test(
  'load refuses, by name, a public form that could echo, and a saved form whose tables cannot hold a draft',
  { timeout: 15_000 },
  async () => {
    await fixture(async (f) => {
      const leases: Array<() => void> = [];
      const { schema } = await loadAppRuntimeResources(f.registry, f.app, 'private-db', (owner) => leases.push(f.registry.lease(owner)));
      try {
        const problem = (commands: Partial<Record<string, unknown>>, app: AppDef = f.app) =>
          publicFormProblems(app, defineCommands({ ...f.commands, ...commands } as BusinessCommandRegistry), schema);
        assert.equal(problem({}), undefined);
        const base = f.commands;
        const variant = (id: string, change: Record<string, unknown>) => {
          const { version: _version, ...definition } = base[id];
          return { [id]: defineCommand({ ...definition, ...change } as never) };
        };
        // The submit answers a receipt and fixed words; a typed value or a custom parser could carry anything back.
        assert.match(problem(variant('submitApplication', { output: shape({ reference: text(), last_name: text() }) }))!, /write-only/);
        assert.match(problem(variant('submitApplication', { output: { parse: (value: unknown) => value } }))!, /write-only/);
        // A step answers words at most: the receipt is the submit's.
        assert.match(problem(variant('saveAddress', { output: shape({ reference: text() }) }))!, /answers nothing but an optional message/);
        // A later step fills columns that did not exist when the root was inserted: they must be nullable.
        assert.match(
          problem(variant('saveAddress', { input: { status: { type: 'text' } } }))!,
          /"application\.status" is filled by the step "address".*nullable/,
        );
        // Purge removes the children in the first step's transaction, so it writes them.
        assert.match(problem(variant('startApplication', { write: ['application'] }))!, /must list "(address|co_applicant)" in write/);
        const reparse = (change: Record<string, unknown>, auth?: Record<string, unknown>) =>
          parseTestApp(lendingConfig({ ...savedForm, ...change }, auth), 'variant');
        assert.match(
          problem({}, reparse({ resume: { token: 'nope', expires: 'resume_expires_at', progress: 'resume_progress' } }))!,
          /writes no table with the resume columns "nope"/,
        );
        // A resource's notice fires on the write: on a draft's rows only once it is submitted.
        const noticed = (table: string, rule: Record<string, unknown>) =>
          ({
            ...f.app,
            resources: {
              ...f.app.resources,
              [table]: { ...f.app.resources![table], notify: [{ on: 'insert', to: ['last_name'], title: 'New', ...rule }] },
            },
          }) as AppDef;
        assert.match(problem({}, noticed('application', {}))!, /notifies on a write a draft makes/);
        assert.match(problem({}, noticed('address', { when: 'status = submitted' }))!, /notifies on a write a draft makes/);
        assert.equal(problem({}, noticed('application', { on: 'update', when: 'status = submitted' })), undefined);
        // A step-up's code goes to a text column of the root, and what it opens is the root's.
        assert.equal(
          problem({}, reparse({ statusCheck: { ...savedForm.statusCheck, stepUp: { email: 'last_name', show: ['first_name'] } } })),
          undefined,
        );
        assert.match(
          problem({}, reparse({ statusCheck: { ...savedForm.statusCheck, stepUp: { email: 'id', show: ['first_name'] } } }))!,
          /not a text column/,
        );
        assert.match(
          problem({}, reparse({ statusCheck: { ...savedForm.statusCheck, stepUp: { email: 'last_name', show: ['nope'] } } }))!,
          /"nope", which is not a column/,
        );
        // A public form's link is prefilled only from what the public reads, into inputs the form names prefillable.
        const page = {
          id: 'application',
          name: 'Application',
          base: 'application',
          sections: [
            { kind: 'fields', fields: ['status'], actions: [{ label: 'Ask about it', view: 'ask', prefill: { note: 'last_name' } }] },
          ],
        } as unknown as PageDef;
        const ask = {
          kind: 'form',
          label: 'Ask',
          public: true,
          prefillable: ['note'],
          command: { id: 'ask', version: 1, input: [{ name: 'note', label: 'Note', type: 'text', required: true }] },
        };
        const opening = (fields?: string[], prefillable = ['note']) =>
          ({
            ...f.app,
            views: { ...f.app.views, ask: { ...ask, prefillable } },
            auth: { ...f.app.auth!, public: { read: ['application'], ...(fields ? { fields: { application: { read: fields } } } : {}) } },
          }) as unknown as AppDef;
        assert.deepEqual(publicPrefillProblems(opening(), [page], schema), []);
        assert.match(
          publicPrefillProblems(opening(['id', 'status']), [page], schema)[0].problem,
          /"last_name", which the public grant does not open/,
        );
        assert.match(publicPrefillProblems(opening(undefined, ['other']), [page], schema)[0].problem, /does not name prefillable/);
        assert.match(
          publicPrefillProblems({ ...opening(), auth: { ...f.app.auth! } } as AppDef, [page], schema)[0].problem,
          /does not open/,
        );
      } finally {
        for (const release of leases) release();
      }
    });
    // The declaration's own shape, before any table is read.
    const parse = (change: Record<string, unknown>) => () => parseTestApp(lendingConfig({ ...savedForm, ...change }), 'variant');
    assert.throws(parse({ public: undefined }), /which a public form does/);
    assert.throws(parse({ prefillable: ['first_name'] }), /takes no "prefillable": it starts blank/);
    assert.throws(
      parse({ steps: [...savedForm.steps, { id: 'again', label: 'Again', command: reference('saveAgain', { city: { type: 'text' } }) }] }),
      /asks "city", which step "address" asks too/,
    );
    assert.throws(parse({ statusCheck: { ...savedForm.statusCheck, show: ['ssn_last4'] } }), /answers a state, never a factor/);
    assert.throws(parse({ statusCheck: { receipt: 'reference', confirm: {} } }), /A receipt alone opens nothing/);
  },
);

test(
  'a step from another origin is refused before anything is counted or written, and the paths exist only on a saved form',
  { timeout: 10_000 },
  async () => {
    await fixture(async (f) => {
      const evil = new Applicant(f.base, 'evil');
      const refused = await evil.post(
        '/api/forms/apply/steps/about-you',
        { input: ABOUT, submission: evil.key() },
        { origin: 'https://elsewhere.example' },
      );
      assert.equal(refused.status, 403, refused.raw);
      assert.equal(refused.set, undefined);
      assert.equal(count(f, 'application'), 0);
      for (const path of ['/api/forms/apply/steps/nope', '/api/forms/apply/steps', '/api/forms/apply/resume/x']) {
        const missing = await evil.post(path, {});
        assert.ok([401, 404].includes(missing.status), `${path}: ${missing.status}`);
      }
      const get = await fetch(`${f.base}/api/forms/apply/resume`);
      assert.equal(get.status, 405);
    });
  },
);

test('the drafts condition goes on every alternative, before the sort; receipts are random and of their pattern', () => {
  assert.equal(withCondition(undefined, 'status != in_progress'), 'status != in_progress');
  assert.equal(withCondition('sort id', 'status != in_progress'), 'status != in_progress sort id');
  assert.equal(withCondition('a = 1 or b = 2 sort -id', 's != d'), 's != d and a = 1 or s != d and b = 2 sort -id');
  const seen = new Set(Array.from({ length: 200 }, () => publicReference('APP')));
  assert.equal(seen.size, 200);
  for (const value of seen) assert.match(value, publicReferencePattern('APP'));
  assert.throws(() => publicReference('app'), /prefix/);
});

test('guesses sent together are each counted before they are judged: the sixth is locked even when it is right', async () => {
  const { checkApplicationStatus, resetStatusLockouts } = await import('../packages/mistri/src/server/forms/statusCheck.js');
  resetStatusLockouts();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  // Every read waits at the gate, so all twenty attempts are in flight before any is judged.
  const records = {
    query: async () => {
      await gate;
      return { rows: [{ id: 1, receipt: 'R-1', status: 'submitted', last_name: 'Stone' }], columns: [] };
    },
    update: async () => ({ changes: 1 }),
  };
  const ask = (lastName: string) =>
    checkApplicationStatus({
      check: { receipt: 'receipt', confirm: [{ column: 'last_name', label: 'Last name' }], show: ['status'] },
      save: { draft: { column: 'status', value: 'draft' }, resume: { by: 'link' }, abandoned: 'purge' } as never,
      roots: ['application'],
      records: records as never,
      catalog: { application: { key: ['id'] } } as never,
      form: 'race',
      request: { receipt: 'R-1', confirm: { last_name: lastName } },
    });
  const answers = [...Array.from({ length: 19 }, (_, i) => ask(`Guess ${i}`)), ask('Stone')];
  open();
  const settled = await Promise.all(answers);
  assert.equal(settled.filter((answer) => answer.found).length, 0, 'the right answer, sent twentieth, is past the lock');
  resetStatusLockouts();
  assert.equal((await ask('Stone')).found, true, 'the same answer alone, before any lock, opens the status');
  resetStatusLockouts();
});

test("the App's human check guards a saved form's steps and its submit, as the stock form's submission", { timeout: 15_000 }, async () => {
  await fixture(
    async (f) => {
      const ada = new Applicant(f.base, 'guarded');
      const bare = await ada.step('about-you', ABOUT);
      assert.equal(bare.status, 403);
      assert.equal(bare.body.code, 'challenge_failed');
      assert.equal(count(f, 'application'), 0, 'refused before the body was read: no draft opened');
      const robot = await ada.post(
        '/api/forms/apply/steps/about-you',
        { input: ABOUT, submission: ada.key() },
        { 'x-mistri-challenge': 'robot' },
      );
      assert.equal(robot.status, 403);
      let n = 0;
      const token = () => ({ 'x-mistri-challenge': `person-${++n}` });
      const step = (id: string, input: unknown) => ada.post(`/api/forms/apply/steps/${id}`, { input, submission: ada.key() }, token());
      assert.equal((await step('about-you', ABOUT)).status, 200);
      assert.equal((await step('address', ADDRESS)).status, 200);
      assert.equal((await step('co-applicants', CO)).status, 200);
      const unguarded = await ada.submit();
      assert.equal(unguarded.status, 403, 'the submit asks it too');
      assert.equal(root(f, 1).status, 'in_progress');
      // Reading the draft back writes nothing, so it asks no check.
      assert.equal((await ada.resume()).status, 200);
      const done = await ada.post('/api/forms/apply', { input: { consent: true }, submission: ada.key() }, token());
      assert.equal(done.status, 200, done.raw);
      assert.equal(root(f, 1).status, 'submitted');
    },
    { challenge: true },
  );
});

test(
  'a body trickled past the hold deadline is answered 408 before the human check is asked; one sent whole is read as sent',
  { timeout: 30_000 },
  async () => {
    await fixture(
      async (f) => {
        const asked = verified.length;
        const path = '/api/forms/apply/steps/about-you';
        const started = Date.now();
        const slow = await chunkedPost(
          f.base,
          path,
          { input: ABOUT, submission: 'trickled-submission-000910' },
          { 'x-mistri-challenge': 'person-slow' },
          'trickle',
        );
        const took = Date.now() - started;
        assert.equal(slow.status, 408);
        assert.equal(slow.body.code, 'too_slow');
        assert.equal(slow.headers.connection, 'close');
        assert.ok(took >= BODY_HOLD_MS - 50 && took < BODY_HOLD_MS + 2_000, `answered after ${took} ms`);
        assert.equal(verified.length, asked, 'a body that never finished arriving never reaches the check');
        assert.equal(count(f, 'application'), 0);
        const whole = await new Applicant(f.base, 'whole').post(
          path,
          { input: ABOUT, submission: 'trickled-submission-000911' },
          { 'x-mistri-challenge': 'person-whole' },
        );
        assert.equal(whole.status, 200, whole.raw);
        assert.deepEqual(verified.slice(asked), ['person-whole']);
        assert.equal(count(f, 'application'), 1);
      },
      { challenge: true },
    );
  },
);

test(
  'a chunked body past 64 KB is refused 413 before the human check is asked; a chunked one inside it is read as sent',
  { timeout: 15_000 },
  async () => {
    await fixture(
      async (f) => {
        const asked = verified.length;
        const path = '/api/forms/apply/steps/about-you';
        const huge = await chunkedPost(
          f.base,
          path,
          { input: ABOUT, submission: 'chunked-submission-000900', pad: 'x'.repeat(70_000) },
          { 'x-mistri-challenge': 'person-big' },
        );
        assert.equal(huge.status, 413);
        assert.equal(huge.body.code, 'too_large');
        assert.equal(verified.length, asked, 'a body past the envelope never reaches the check');
        assert.equal(count(f, 'application'), 0);
        const small = await chunkedPost(
          f.base,
          path,
          { input: ABOUT, submission: 'chunked-submission-000901' },
          { 'x-mistri-challenge': 'person-small' },
        );
        assert.equal(small.status, 200, JSON.stringify(small.body));
        assert.deepEqual(verified.slice(asked), ['person-small']);
        assert.equal(count(f, 'application'), 1);
      },
      { challenge: true },
    );
  },
);
