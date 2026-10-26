import { parseTestApp as parseAppConfig } from './support/commandCatalog.js';
/**
 * A saved form's application added to an account, and its status check
 * telling staff, over HTTP on an ordinary App.
 *
 * What is proved: a link happens on proven control only — this browser's
 * claim, spent once by a signed-in Yes, or a signed-in status check — and
 * never twice; a claim is burned by No, by its expiry, by signing out and by
 * the next application; a claim in another browser, reused or expired finds
 * nothing; once linked, only the owner's session reads the application and
 * the anonymous check no longer answers for it. And the attempt that locks a
 * submitted application's receipt stamps its alert column, which the App's
 * own notify rule turns into a notice for staff, while every attempt is
 * logged with nothing typed in it.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionSqliteInbox } from '../packages/mistri/src/adapters/inbox/sqliteInbox.js';
import { INBOX_TABLES } from '../packages/mistri/src/adapters/inbox/inbox.js';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import { RECORD_HISTORY_TABLES } from '../packages/mistri/src/adapters/history/recordHistory.js';
import type { PageDef } from '../packages/engine/src/shared/pageModel.js';
import { WriteConflict } from '../packages/engine/src/adapters/adapter.js';
import { type AppDef } from '../packages/mistri/src/shared/app.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { defineCommand, defineCommands, type BusinessCommandRegistry } from '../packages/mistri/src/server/commands/businessCommands.js';
import { refuse } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { literal, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { parseTrustedProxies } from '../packages/engine/src/server/http/trust.js';
import { publicReference, publicReferencePattern } from '../packages/mistri/src/server/forms/publicReference.js';
import { resetStatusLockouts } from '../packages/mistri/src/server/forms/statusCheck.js';
import { publicFormProblems } from '../packages/mistri/src/server/forms/savedFormChecks.js';
import { linkByReceipt, type LinkForm } from '../packages/mistri/src/server/forms/formLink.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';

const aboutInput = {
  first_name: { label: 'First name', type: 'text', max: 60 },
  last_name: { label: 'Last name', type: 'text', max: 60 },
} as const;
const submitInput = { consent: { label: 'These details are true', type: 'boolean' } } as const;
const reference = (id: string, input: object) => ({ id, version: 1, input });
const statusCheck = {
  receipt: 'reference',
  confirm: { last_name: 'Last name' },
  show: ['status'],
  says: { status: { submitted: 'Received' } },
  alert: 'check_alert_at',
};
const link = {
  owner: 'account_id',
  at: 'linked_at',
  via: 'linked_via',
  sameDevice: { token: 'claim_token_hash', expires: 'claim_expires_at' },
  statusCheck: true,
};
const savedForm = {
  kind: 'form',
  label: 'Apply',
  public: true,
  command: reference('submitApplication', submitInput),
  steps: [{ id: 'about-you', label: 'About you', command: reference('startApplication', aboutInput) }],
  resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress' },
  draft: { status: 'in_progress' },
  statusCheck,
  link,
};
const alertRule = {
  on: { changes: 'check_alert_at' },
  when: 'status = submitted',
  to: 'officer_email',
  title: 'Repeated status checks on {reference}',
};
const lendingConfig = (form: Record<string, unknown> = savedForm, notify: unknown[] = [alertRule]) => ({
  id: 'lending',
  name: 'Lending',
  auth: { roles: { officer: { read: true } } },
  sources: { main: { connection: 'private-db' } },
  resources: { application: { access: 'write', ...(notify.length ? { notify } : {}) } },
  views: { applications: { kind: 'list', from: 'application' }, apply: form },
  home: 'applications',
  nav: ['applications'],
});

function commandsFor(): BusinessCommandRegistry {
  return defineCommands({
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
        await db.application.update(await db.application.get(draft!.root!), {
          status: 'submitted',
          reference: receipt,
          officer_email: 'officer@example.test',
        });
        return { reference: receipt, message: 'Received.' as const };
      },
    }),
  });
}

interface Fixture {
  base: string;
  db: DatabaseSync;
  registry: Registry;
  app: AppDef;
  commands: BusinessCommandRegistry;
  logs: string[];
}

async function fixture(run: (f: Fixture) => Promise<void>) {
  resetPublicFormLimits();
  resetStatusLockouts();
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-form-link-'));
  const file = join(directory, 'apply.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE application(id INTEGER PRIMARY KEY, status TEXT NOT NULL, reference TEXT UNIQUE, first_name TEXT, last_name TEXT,
    officer_email TEXT, resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT,
    account_id TEXT, linked_at TEXT, linked_via TEXT, claim_token_hash TEXT, claim_expires_at TEXT, check_alert_at TEXT)`);
  migrateSqliteCommandJournal(file);
  provisionSqliteInbox(file);
  provisionSqliteRecordHistory(file);
  const registry = new Registry();
  registry.add({ id: 'private-db', name: 'Private', url: file, writable: true, source: 'config' });
  const app = parseAppConfig(lendingConfig(), 'form link fixture');
  const commands = commandsFor();
  // Whoever the `session` cookie names is signed in; a sign-out answers as Better Auth does, clearing its own cookie.
  // A staff page with the application's history: the log a link is audited in.
  const pages: PageDef[] = [{ id: 'application', name: 'Application', base: 'application', sections: [{ kind: 'history' }] }];
  const host: AppHost = {
    app: { app, path: '/private/app.ts', pages, sources: {} },
    pages,
    auth: {
      spec: app.auth!,
      store: '/private/auth.db',
      close() {},
      handler: async (_req, res) => {
        res.setHeader('set-cookie', ['session=; Path=/; Max-Age=0']);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      },
      session: async (req) => {
        const id = /(?:^|;\s*)session=([a-z-]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
        return id ? { id, who: `${id}@example.test` } : null;
      },
    },
  };
  const bound = { host: '127.0.0.1', port: 0, trustedProxies: parseTrustedProxies([]).ranges };
  const server = createApp({ registry, bound, apps: [host], commands: { appId: 'lending', registry: commands } });
  const logs: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    logs.push(String(chunk));
    return (write as (...args: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    bound.port = (server.address() as { port: number }).port;
    await run({ base: `http://${bound.host}:${bound.port}`, db, registry, app, commands, logs });
  } finally {
    process.stderr.write = write;
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

/** One browser: its form cookies as the browser keeps them, and whoever is signed in. */
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
    const set = response.headers.getSetCookie();
    for (const line of set) {
      const [pair] = line.split(';');
      const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
      if (name === 'session') continue;
      if (!value || /Max-Age=0/.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return { status: response.status, body: JSON.parse(raw) as Record<string, unknown>, raw, set };
  }
  key() {
    return `${this.tag}-submission-${String(++this.n).padStart(6, '0')}`;
  }
  async apply(last = 'Lovelace'): Promise<string> {
    assert.equal(
      (await this.post('/api/forms/apply/steps/about-you', { input: { first_name: 'Ada', last_name: last }, submission: this.key() }))
        .status,
      200,
    );
    const done = await this.post('/api/forms/apply', { input: { consent: true }, submission: this.key() });
    assert.equal(done.status, 200, done.raw);
    return String(done.body.reference);
  }
  claim(answer?: 'yes' | 'no') {
    return this.post('/api/forms/apply/claim', answer ? { answer } : {});
  }
  check(receipt: string, last = 'Lovelace') {
    return this.post('/api/forms/apply/status', { receipt, confirm: { last_name: last } });
  }
  link(receipt: string, last = 'Lovelace') {
    return this.post('/api/forms/apply/link', { receipt, confirm: { last_name: last } });
  }
  mine() {
    return this.post('/api/forms/apply/mine', {});
  }
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const row = (f: Fixture, receipt: string) => ({
  ...(f.db.prepare('SELECT * FROM application WHERE reference = ?').get(receipt) as Record<string, unknown>),
});

test(
  'the submit leaves a claim this browser alone may spend, once, by a signed-in Yes; No, expiry, sign-out and the next application burn it',
  { timeout: 30_000 },
  async () => {
    await fixture(async (f) => {
      const ada = new Browser(f.base, 'ada');
      const receipt = await ada.apply();
      const token = ada.jar.get('tw_claim_apply');
      assert.match(token ?? '', /^[A-Za-z0-9_-]{43}$/, 'the claim rides beside the receipt');
      assert.equal(ada.jar.has('tw_form_apply'), false, "the draft's cookie is gone");
      assert.equal(row(f, receipt).claim_token_hash, hash(token!), 'only its hash is kept');
      assert.ok(Date.parse(String(row(f, receipt).claim_expires_at)) - Date.now() <= 30 * 60_000);

      // Signed out, the claim is not even read: the account screen asks who is adding it first.
      assert.equal((await ada.claim()).status, 401);
      ada.session = 'account-a';
      assert.deepEqual((await ada.claim()).body, { claim: { reference: receipt } });
      // Another browser signed in has no claim to spend, whatever it asks.
      const other = new Browser(f.base, 'other');
      other.session = 'account-b';
      assert.deepEqual((await other.claim()).body, { claim: null });
      assert.equal((await other.claim('yes')).status, 404);
      // A copy of the cookie in another browser works as the cookie would, so the copy is spent with the first Yes.
      const copy = new Browser(f.base, 'copy');
      copy.session = 'account-c';
      copy.jar.set('tw_claim_apply', token!);

      // Five link attempts a minute per address: every browser here shares one, so each part starts a fresh budget.
      resetPublicFormLimits();
      const yes = await ada.claim('yes');
      assert.equal(yes.status, 200, yes.raw);
      assert.deepEqual(yes.body, { linked: { reference: receipt } });
      assert.equal(ada.jar.has('tw_claim_apply'), false, 'spent: the cookie is cleared');
      const { account_id, linked_via, linked_at, claim_token_hash, claim_expires_at } = row(f, receipt);
      assert.deepEqual(
        { account_id, linked_via, claim_token_hash, claim_expires_at },
        { account_id: 'account-a', linked_via: 'same-device', claim_token_hash: null, claim_expires_at: null },
      );
      assert.ok(Math.abs(Date.parse(String(linked_at)) - Date.now()) < 60_000, 'when, for staff to see');
      assert.equal((await copy.claim('yes')).status, 404, 'a claim is spent once');
      assert.equal(row(f, receipt).account_id, 'account-a');

      // No burns it, signed in or not (the done screen's "This is a shared device").
      resetPublicFormLimits();
      const grace = new Browser(f.base, 'grace');
      const second = await grace.apply('Hopper');
      assert.ok(row(f, second).claim_token_hash);
      assert.deepEqual((await grace.claim('no')).body, { claim: null });
      assert.equal(row(f, second).claim_token_hash, null);
      grace.session = 'account-g';
      grace.jar.set('tw_claim_apply', 'A'.repeat(43));
      assert.equal((await grace.claim('yes')).status, 404);
      assert.equal(row(f, second).account_id, null);

      // Expired, it names nothing.
      resetPublicFormLimits();
      const late = new Browser(f.base, 'late');
      const third = await late.apply('Lamarr');
      f.db.prepare('UPDATE application SET claim_expires_at = ? WHERE reference = ?').run(new Date(Date.now() - 1000).toISOString(), third);
      late.session = 'account-l';
      assert.deepEqual((await late.claim()).body, { claim: null });
      assert.equal((await late.claim('yes')).status, 404);
      assert.equal(row(f, third).account_id, null);

      // The next application from this browser burns the claim the last one left.
      resetPublicFormLimits();
      const twice = new Browser(f.base, 'twice');
      const first = await twice.apply('Noether');
      assert.ok(row(f, first).claim_token_hash);
      const next = await twice.apply('Noether');
      assert.equal(row(f, first).claim_token_hash, null);
      assert.ok(row(f, next).claim_token_hash);

      // Signing out burns it too: the cookie is cleared beside the session's own.
      twice.session = 'account-t';
      const out = await fetch(`${f.base}/api/auth/sign-out`, {
        method: 'POST',
        headers: { origin: f.base, cookie: `session=account-t; tw_claim_apply=${twice.jar.get('tw_claim_apply')}` },
      });
      const cleared = out.headers.getSetCookie();
      assert.ok(
        cleared.some((line) => line.startsWith('session=;')),
        "Better Auth's own cookie is kept",
      );
      assert.ok(
        cleared.some((line) => /^tw_claim_apply=;.*Path=\/api\/forms\/apply.*Max-Age=0/.test(line)),
        cleared.join('\n'),
      );
    });
  },
);

test(
  'signed in, a passed status check adds the application to the account once; then only the owner reads it',
  { timeout: 30_000 },
  async () => {
    await fixture(async (f) => {
      const ada = new Browser(f.base, 'ada');
      const receipt = await ada.apply();
      const bea = new Browser(f.base, 'bea'),
        cal = new Browser(f.base, 'cal');
      assert.equal((await bea.link(receipt)).status, 401, 'a link names a signed-in account');
      assert.equal((await bea.mine()).status, 401);
      bea.session = 'account-b';
      cal.session = 'account-c';
      const wrong = await bea.link(receipt, 'Byron');
      const refused = await new Browser(f.base, 'anon').check(receipt, 'Byron');
      assert.deepEqual(
        { status: wrong.status, body: wrong.body },
        { status: refused.status, body: refused.body },
        "a wrong detail reads as the check's own refusal",
      );
      assert.equal(row(f, receipt).account_id, null);

      resetPublicFormLimits();
      const linked = await bea.link(receipt);
      assert.equal(linked.status, 200, linked.raw);
      assert.deepEqual(linked.body, { linked: { reference: receipt }, status: { status: 'Received' } });
      assert.equal(row(f, receipt).account_id, 'account-b');
      assert.equal(row(f, receipt).linked_via, 'status-check');
      // One-shot: again for the owner is refused, and for anyone else the application is simply not theirs to find.
      assert.equal((await bea.link(receipt)).status, 409);
      resetPublicFormLimits();
      const others = await cal.link(receipt);
      assert.deepEqual({ status: others.status, body: others.body }, { status: refused.status, body: refused.body });
      assert.equal(row(f, receipt).account_id, 'account-b');
      // Its claim went with the link: this browser can no longer add it anywhere.
      ada.session = 'account-a';
      assert.deepEqual((await ada.claim()).body, { claim: null });

      // Anonymous access ends: the right details signed out, or signed in as another, find nothing; the owner's session does.
      resetStatusLockouts();
      resetPublicFormLimits();
      const anonymous = await new Browser(f.base, 'anon2').check(receipt);
      assert.deepEqual({ status: anonymous.status, body: anonymous.body }, { status: refused.status, body: refused.body });
      assert.match(String(anonymous.body.message), /sign in to see it/);
      assert.equal((await cal.check(receipt)).status, 404);
      assert.equal((await bea.check(receipt)).status, 200);
      // The owner's reads are by the owner column alone.
      assert.deepEqual((await bea.mine()).body, { applications: [{ reference: receipt, status: { status: 'Received' } }] });
      assert.deepEqual((await cal.mine()).body, { applications: [] });
      assert.equal((await bea.post('/api/forms/apply/mine', { account: 'account-c' })).status, 400, 'a body naming an account is refused');
      // The history names who added it and how, as the account's own write.
      const audit = (
        f.db
          .prepare(`SELECT actor, via, action, changes_json FROM "${RECORD_HISTORY_TABLES.change}" WHERE action = 'Add to account'`)
          .all() as Array<{ actor: string; via: string; action: string; changes_json: string }>
      ).map(({ changes_json, ...entry }) => ({
        ...entry,
        changes: (JSON.parse(changes_json) as Array<{ c: string }>).map((change) => change.c).sort(),
      }));
      assert.deepEqual(audit, [
        {
          actor: 'account-b@example.test',
          via: 'app',
          action: 'Add to account',
          changes: ['account_id', 'claim_expires_at', 'claim_token_hash', 'linked_at', 'linked_via'],
        },
      ]);
      // A token's hash is the server's: the history says it changed, never what it held.
      assert.doesNotMatch(
        f.db.prepare(`SELECT group_concat(changes_json) AS all_changes FROM "${RECORD_HISTORY_TABLES.change}"`).get()!
          .all_changes as string,
        /[0-9a-f]{64}/,
      );
      // Every link is logged: who, how, the receipt's digest, never a detail.
      const links = f.logs.filter((line) => line.includes('"form.link"')).map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(
        links.map((entry) => [entry.account, entry.via, entry.outcome]),
        [
          ['account-b', 'status-check', 'linked'],
          ['account-b', 'status-check', 'owned'],
        ],
      );
      assert.doesNotMatch(f.logs.join(''), /Lovelace|Byron|APP-/);
    });
  },
);

test(
  "the attempt that locks a submitted application's receipt stamps its alert, and the App's notify rule tells staff",
  { timeout: 30_000 },
  async () => {
    await fixture(async (f) => {
      const ada = new Browser(f.base, 'ada');
      const receipt = await ada.apply();
      const guesser = new Browser(f.base, 'guesser');
      for (let n = 1; n <= 5; n++) {
        if (n === 4) resetPublicFormLimits();
        assert.equal((await guesser.check(receipt, `Wrong${'x'.repeat(n)}`)).status, 404);
        assert.equal(row(f, receipt).check_alert_at === null, n < 5, `alerted at the lock, not before (attempt ${n})`);
      }
      const notices = f.db
        .prepare(`SELECT recipient, title, resource FROM "${INBOX_TABLES.notice}"`)
        .all()
        .map((notice) => ({ ...notice }));
      assert.deepEqual(notices, [
        { recipient: 'officer@example.test', title: `Repeated status checks on ${receipt}`, resource: 'application' },
      ]);
      // Locked, further attempts tell nobody again; a receipt that names nothing alerts nobody at all.
      resetPublicFormLimits();
      assert.equal((await guesser.check(receipt)).status, 404);
      for (let n = 0; n < 5; n++) {
        if (n === 3) resetPublicFormLimits();
        await guesser.check(publicReference('APP'));
      }
      assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${INBOX_TABLES.notice}"`).get()!.n, 1);
      // Every attempt is in the log by its outcome and a digest of its receipt; nothing typed is.
      const attempts = f.logs
        .filter((line) => line.includes('"form.status_check"'))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(
        attempts.slice(0, 6).map((entry) => entry.outcome),
        ['refused', 'refused', 'refused', 'refused', 'alerted', 'locked'],
      );
      assert.equal(attempts.length, 11);
      assert.doesNotMatch(f.logs.join(''), /Wrong|Lovelace|APP-/);
    });
  },
);

test('a link is compare-and-set: a race that loses finds the application owned', async () => {
  const form = parseAppConfig(lendingConfig(), 'race').views.apply as unknown as LinkForm;
  const catalog = { application: { key: ['id'], meta: { columns: [] } } } as never;
  const records = {
    query: async () => ({
      rows: [
        {
          id: 1,
          status: 'submitted',
          reference: 'APP-1',
          account_id: null,
          linked_at: null,
          linked_via: null,
          claim_token_hash: null,
          claim_expires_at: null,
        },
      ],
      columns: [],
    }),
    update: async (request: { expected?: unknown }) => {
      assert.ok(request.expected, 'the write compares what it read');
      throw new WriteConflict();
    },
  } as never;
  assert.equal(await linkByReceipt(records, catalog, ['application'], form, 'APP-1', 'account-z', new Date()), 'owned');
});

test('load refuses a link or an alert the tables cannot hold, and one nobody would hear', { timeout: 15_000 }, async () => {
  await fixture(async (f) => {
    const leases: Array<() => void> = [];
    const { schema } = await loadAppRuntimeResources(f.registry, f.app, 'private-db', (owner) => leases.push(f.registry.lease(owner)));
    try {
      const problem = (form: Record<string, unknown>, notify: unknown[] = [alertRule]) =>
        publicFormProblems(parseAppConfig(lendingConfig(form, notify), 'variant'), f.commands, schema);
      assert.equal(problem(savedForm), undefined);
      assert.match(problem(savedForm, [])!, /no notify rule on "application" watches it, so nobody would be told/);
      assert.match(
        problem({ ...savedForm, link: { ...link, owner: 'nope' } })!,
        /link\.owner names "application\.nope", which is not a column/,
      );
      assert.match(
        problem({ ...savedForm, statusCheck: { ...statusCheck, alert: 'status_note' } })!,
        /statusCheck\.alert names "application\.status_note"/,
      );
    } finally {
      for (const release of leases) release();
    }
  });
  const parse = (change: Record<string, unknown>) => () => parseAppConfig(lendingConfig({ ...savedForm, ...change }), 'variant');
  assert.throws(parse({ link: { ...link, sameDevice: undefined, statusCheck: undefined } }), /names no way to link/);
  assert.throws(parse({ statusCheck: undefined }), /needs the form's "statusCheck"/);
  assert.throws(parse({ link: { ...link, owner: 'last_name' } }), /which the form asks for|keeps for something else/);
  assert.throws(parse({ link: { ...link, via: 'resume_progress' } }), /keeps for something else/);
  assert.throws(parse({ statusCheck: { ...statusCheck, alert: 'reference' } }), /"alert" names "reference"/);
});
