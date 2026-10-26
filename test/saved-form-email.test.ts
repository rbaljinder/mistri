import { parseTestApp } from './support/commandCatalog.js';
/**
 * A saved form's email: the status check's step-up and an application found
 * by a verified email, over HTTP on an ordinary App, with the log transport.
 *
 * What is proved: a step-up code goes only to the address on the
 * application, after the check's own details, and opens the declared details
 * once — a wrong, reused or expired code is one refusal, and three codes an
 * hour is the most an application is sent. An account's email finds nothing
 * until the sign-in store says it is verified; then an application that
 * captured the same address is offered and linked only by its Yes, unless the
 * applicant proved that address with a code in the form, when it links
 * without asking. A planted application (someone else's typing of your
 * address) is never linked silently.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { refuse } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { literal, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { parseTrustedProxies } from '../packages/engine/src/server/http/trust.js';
import { publicReference, publicReferencePattern } from '../packages/mistri/src/server/forms/publicReference.js';
import { resetStatusLockouts } from '../packages/mistri/src/server/forms/statusCheck.js';
import { issueCode, resetOneTimeCodes, spendCode } from '../packages/mistri/src/server/forms/oneTimeCode.js';
import { resetStepUpSessions } from '../packages/mistri/src/server/forms/statusStepUp.js';
import { emailConnectionOf } from '../packages/mistri/src/server/email/email.js';

const aboutInput = {
  first_name: { label: 'First name', type: 'text', max: 60 },
  last_name: { label: 'Last name', type: 'text', max: 60 },
  email: { label: 'Email', type: 'text', max: 200 },
} as const;
const submitInput = { consent: { label: 'These details are true', type: 'boolean' } } as const;
const reference = (id: string, input: object) => ({ id, version: 1, input });
const savedForm = {
  kind: 'form',
  label: 'Apply',
  public: true,
  command: reference('submitApplication', submitInput),
  steps: [{ id: 'about-you', label: 'About you', command: reference('startApplication', aboutInput) }],
  resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress' },
  draft: { status: 'in_progress' },
  statusCheck: {
    receipt: 'reference',
    confirm: { last_name: 'Last name' },
    show: ['status'],
    says: { status: { submitted: 'Received' } },
    stepUp: { email: 'email', show: ['first_name'] },
  },
  link: {
    owner: 'account_id',
    at: 'linked_at',
    via: 'linked_via',
    statusCheck: true,
    email: { column: 'email', verified: 'email_verified' },
  },
};

const commands = defineCommands({
  startApplication: defineCommand({
    targets: 'none',
    source: 'main',
    target: 'application',
    read: ['application'],
    write: ['application'],
    public: true,
    input: aboutInput,
    output: shape({ message: literal('Saved.') }),
    async handle({ db, draft }, input) {
      if (!draft) return refuse('forbidden');
      if (draft.root) await db.application.update(await db.application.get(draft.root), input);
      else await db.application.insert({ ...input, ...draft.start });
      return { message: 'Saved.' as const };
    },
  }),
  submitApplication: defineCommand({
    targets: 'none',
    source: 'main',
    target: 'application',
    read: ['application'],
    write: ['application'],
    public: true,
    input: submitInput,
    output: shape({ reference: text({ pattern: publicReferencePattern('APP') }), message: literal('Received.') }),
    async handle({ db, draft }) {
      const receipt = publicReference('APP');
      await db.application.update(await db.application.get(draft!.root!), { status: 'submitted', reference: receipt });
      return { reference: receipt, message: 'Received.' as const };
    },
  }),
});

interface Fixture {
  base: string;
  db: DatabaseSync;
  mail: () => Array<{ to: string; subject: string; text: string }>;
  verified: Set<string>;
}

async function fixture(run: (f: Fixture) => Promise<void>) {
  resetPublicFormLimits();
  resetStatusLockouts();
  resetOneTimeCodes();
  resetStepUpSessions();
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-form-email-'));
  const file = join(directory, 'apply.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE application(id INTEGER PRIMARY KEY, status TEXT NOT NULL, reference TEXT UNIQUE, first_name TEXT, last_name TEXT, email TEXT,
    email_verified TEXT, resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT, account_id TEXT, linked_at TEXT, linked_via TEXT)`);
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'private-db', name: 'Private', url: file, writable: true, source: 'config' });
  registry.addService(
    emailConnectionOf({ name: 'mail', kind: 'email', url: 'log:mail.log', from: 'Lending <no-reply@example.test>' }, 'test', directory),
  );
  const app = parseTestApp(
    {
      id: 'lending',
      name: 'Lending',
      auth: { roles: { officer: { read: true } } },
      sources: { main: { connection: 'private-db' } },
      resources: { application: { access: 'write' } },
      views: { applications: { kind: 'list', from: 'application' }, apply: savedForm },
      home: 'applications',
      nav: ['applications'],
    },
    'form email fixture',
  );
  // Whoever the `session` cookie names is signed in, as `<id>@example.test`; the set says whose email the sign-in store has verified.
  const verified = new Set<string>();
  const host: AppHost = {
    app: { app, path: '/private/app.ts', pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: '/private/auth.db',
      close() {},
      handler: async (_req, res) => {
        res.writeHead(200);
        res.end('{}');
      },
      session: async (req) => {
        const id = /(?:^|;\s*)session=([a-z-]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
        return id ? { id, who: `${id}@example.test`, ...(verified.has(id) ? { emailVerified: true as const } : {}) } : null;
      },
    },
  };
  const bound = { host: '127.0.0.1', port: 0, trustedProxies: parseTrustedProxies([]).ranges };
  const server = createApp({ registry, bound, apps: [host], commands: { appId: 'lending', registry: commands } });
  const log = join(directory, 'mail.log');
  const mail = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    bound.port = (server.address() as { port: number }).port;
    await run({ base: `http://${bound.host}:${bound.port}`, db, mail, verified });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
    resetPublicFormLimits();
    resetStatusLockouts();
    resetOneTimeCodes();
    resetStepUpSessions();
  }
}

class Browser {
  jar = new Map<string, string>();
  session: string | undefined;
  private n = 0;
  constructor(
    private readonly base: string,
    readonly tag: string,
  ) {}
  async post(path: string, body: unknown) {
    const cookies = [...this.jar].map(([name, value]) => `${name}=${value}`);
    if (this.session) cookies.push(`session=${this.session}`);
    const response = await fetch(`${this.base}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
      headers: { 'content-type': 'application/json', origin: this.base, ...(cookies.length ? { cookie: cookies.join('; ') } : {}) },
    });
    const raw = await response.text();
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
      if (!value || /Max-Age=0/.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return { status: response.status, body: JSON.parse(raw) as Record<string, any>, raw };
  }
  key() {
    return `${this.tag}-submission-${String(++this.n).padStart(6, '0')}`;
  }
  start(email: string) {
    return this.post('/api/forms/apply/steps/about-you', {
      input: { first_name: 'Ada', last_name: 'Lovelace', email },
      submission: this.key(),
    });
  }
  async submit(): Promise<string> {
    const done = await this.post('/api/forms/apply', { input: { consent: true }, submission: this.key() });
    assert.equal(done.status, 200, done.raw);
    return String(done.body.reference);
  }
  async apply(email: string): Promise<string> {
    assert.equal((await this.start(email)).status, 200);
    return this.submit();
  }
}

const codeIn = (message: { text: string } | undefined) => /\b(\d{6})\b/.exec(message?.text ?? '')?.[1];

test(
  'a step-up code goes to the address on the application, after its details, and opens the declared details once',
  { timeout: 30_000 },
  async () => {
    await fixture(async (f) => {
      const ada = new Browser(f.base, 'ada');
      const receipt = await ada.apply('ada@example.test');
      const visitor = new Browser(f.base, 'visitor');
      // Wrong details: the status check's own refusal, word for word, and no mail.
      const wrong = await visitor.post('/api/forms/apply/stepup', { receipt, confirm: { last_name: 'Byron' } });
      const plain = await visitor.post('/api/forms/apply/status', { receipt, confirm: { last_name: 'Byron' } });
      assert.equal(wrong.status, 404);
      assert.deepEqual(wrong.body, plain.body);
      assert.equal(f.mail().length, 0);

      // Right details: a code, to the application's own address, whatever the request might say.
      assert.equal(
        (await visitor.post('/api/forms/apply/stepup', { receipt, confirm: { last_name: 'Lovelace' }, to: 'mallory@example.test' })).status,
        400,
      );
      const asked = await visitor.post('/api/forms/apply/stepup', { receipt, confirm: { last_name: 'Lovelace' } });
      assert.deepEqual(asked.body, { sent: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const [message] = f.mail();
      assert.equal(message.to, 'ada@example.test');
      const code = codeIn(message);
      assert.ok(code, 'the code is in the message');
      assert.doesNotMatch(asked.raw, new RegExp(code!), 'and never in the reply');

      // A wrong code, and the right code with the wrong details, open nothing. (Five status guesses a minute per address: a fresh budget.)
      resetPublicFormLimits();
      const other = code === '000000' ? '111111' : '000000';
      const refused = await visitor.post('/api/forms/apply/stepup', { receipt, confirm: { last_name: 'Lovelace' }, code: other });
      assert.equal(refused.status, 404);
      assert.equal(refused.body.code, 'code_refused');
      assert.equal((await visitor.post('/api/forms/apply/stepup', { receipt, confirm: { last_name: 'Byron' }, code })).status, 404);

      resetPublicFormLimits();
      const opened = await visitor.post('/api/forms/apply/stepup', { receipt, confirm: { last_name: 'Lovelace' }, code });
      assert.equal(opened.status, 200, opened.raw);
      assert.deepEqual(opened.body, { status: { status: 'Received' }, details: { first_name: 'Ada' } });
      assert.match(visitor.jar.get('tw_stepup_apply') ?? '', /^[A-Za-z0-9_-]{43}$/);
      // Used once: the same code again is the one refusal.
      const again = await visitor.post('/api/forms/apply/stepup', { receipt, confirm: { last_name: 'Lovelace' }, code });
      assert.equal(again.body.code, 'code_refused');

      // The session shows the details while it lives, in this browser only.
      assert.deepEqual((await visitor.post('/api/forms/apply/details', {})).body, {
        status: { status: 'Received' },
        details: { first_name: 'Ada' },
      });
      const stranger = new Browser(f.base, 'stranger');
      assert.equal((await stranger.post('/api/forms/apply/details', {})).status, 404);
    });
  },
);

test(
  'three codes an hour is the most an application is sent, and a code expires and burns after five wrong tries',
  { timeout: 30_000 },
  async () => {
    await fixture(async (f) => {
      const ada = new Browser(f.base, 'ada');
      const receipt = await ada.apply('ada@example.test');
      for (let i = 0; i < 3; i++) {
        resetPublicFormLimits();
        assert.equal((await ada.post('/api/forms/apply/stepup', { receipt, confirm: { last_name: 'Lovelace' } })).status, 200);
      }
      resetPublicFormLimits();
      const fourth = await ada.post('/api/forms/apply/stepup', { receipt, confirm: { last_name: 'Lovelace' } });
      assert.equal(fourth.status, 429);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(f.mail().length, 3);
    });
    resetOneTimeCodes();
    const now = Date.parse('2026-09-25T12:00:00.000Z');
    const issued = issueCode('subject', now) as { code: string };
    assert.equal(spendCode('subject', issued.code, now + 10 * 60_000), false, 'ten minutes, then gone');
    const second = issueCode('subject', now) as { code: string };
    const wrong = second.code === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) assert.equal(spendCode('subject', wrong, now), false);
    assert.equal(spendCode('subject', second.code, now), false, 'five wrong tries burn it');
    const bound = issueCode('bound', now, 'ada@example.test') as { code: string };
    assert.equal(spendCode('bound', bound.code, now, 'mallory@example.test'), false, 'a code proves the address it was sent to');
    resetOneTimeCodes();
  },
);

test(
  "an account's email finds applications only once verified, each linked by its own Yes; a proved address links without asking",
  { timeout: 30_000 },
  async () => {
    await fixture(async (f) => {
      // Someone typed Ada's address into their own application: a plant.
      const planted = await new Browser(f.base, 'mallory').apply('ada@example.test');
      // Ada's own, where she proved the address with a code in the form.
      const ada = new Browser(f.base, 'ada');
      assert.equal((await ada.start('Ada@Example.test')).status, 200);
      assert.deepEqual((await ada.post('/api/forms/apply/verify-email', { email: 'ada@example.test' })).body, { sent: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const proof = f.mail().at(-1)!;
      assert.equal(proof.to, 'ada@example.test');
      assert.equal(
        (await ada.post('/api/forms/apply/verify-email', { email: 'bob@example.test', code: codeIn(proof) })).status,
        404,
        'the code proves the address it went to, no other',
      );
      assert.deepEqual((await ada.post('/api/forms/apply/verify-email', { email: 'ada@example.test', code: codeIn(proof) })).body, {
        verified: true,
      });
      const proved = await ada.submit();

      resetPublicFormLimits();
      const account = new Browser(f.base, 'account');
      account.session = 'ada';
      // Not verified yet: nothing matches, and the page is told to verify.
      assert.deepEqual((await account.post('/api/forms/apply/found', {})).body, { linked: [], found: [], verify: true });
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM application WHERE account_id IS NOT NULL').get()!.n, 0);

      f.verified.add('ada');
      const found = await account.post('/api/forms/apply/found', {});
      assert.equal(found.status, 200, found.raw);
      assert.deepEqual(found.body, { linked: [proved], found: [planted] });
      const row = (receipt: string) => ({
        ...(f.db.prepare('SELECT account_id, linked_via FROM application WHERE reference = ?').get(receipt) as object),
      });
      assert.deepEqual(row(proved), { account_id: 'ada', linked_via: 'email' });
      assert.deepEqual(row(planted), { account_id: null, linked_via: null }, 'a plant waits for a Yes');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(
        f.mail().some((message) => message.to === 'ada@example.test' && message.subject.includes(proved)),
        'the account is told of the link',
      );

      // Another verified account, another address: nothing of Ada's.
      const bob = new Browser(f.base, 'bob');
      bob.session = 'bob';
      f.verified.add('bob');
      assert.deepEqual((await bob.post('/api/forms/apply/found', {})).body, { linked: [], found: [] });
      assert.equal((await bob.post('/api/forms/apply/found', { reference: planted })).status, 404);

      // Yes: that one is Ada's to take, once.
      resetPublicFormLimits();
      const yes = await account.post('/api/forms/apply/found', { reference: planted });
      assert.deepEqual(yes.body, { linked: { reference: planted } });
      assert.deepEqual(row(planted), { account_id: 'ada', linked_via: 'email' });
      assert.equal((await account.post('/api/forms/apply/found', { reference: planted })).status, 409);
      assert.deepEqual((await account.post('/api/forms/apply/found', {})).body, { linked: [], found: [] });
    });
  },
);
