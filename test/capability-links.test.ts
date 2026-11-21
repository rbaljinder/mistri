/**
 * Capability links (shared/appLinks.ts, server/links/): a command mints one
 * on its record, the minting answer says its URL and the receipt only its
 * reference, and whoever holds it sees the declared columns of that one
 * record and runs the declared commands on it — behind a confirmation or a
 * one-time code where the link asks one. Whatever does not open answers the
 * same words on the same floor. SQLite here; the Postgres journal's link rows
 * are held by the layout test (postgres-command-journal-layout).
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { machine } from '@mistriwork/mistri/app';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournalSchema.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import type { EmailMessage, EmailTransport } from '../packages/mistri/src/server/email/email.js';
import { configureFormKey } from '../packages/mistri/src/server/forms/formKey.js';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import {
  configureLinkBase,
  LinkRef,
  LINK_OPEN_SECONDS,
  linkSession,
  linkToken,
  linkTokenId,
  linkTokenMatches,
  readLinkSession,
  renderLinkRefs,
} from '../packages/mistri/src/server/links/linkToken.js';
import { LINK_MISS, linkPage } from '../packages/mistri/src/server/links/linkPage.js';
import { FRAMEWORK_WORDS_ES } from '../packages/engine/src/shared/frameworkWordsEs.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { appLinkAdvisories, appLinkProblems } from '../packages/mistri/src/shared/appLinks.js';
import { relatedQuery } from '../packages/mistri/src/server/links/linkDoor.js';
import { linkHistoryWarnings } from '../packages/mistri/src/server/recordHistory.js';
import type { PageDef } from '../packages/engine/src/shared/pageModel.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { redactLinkTokens } from '../packages/engine/src/server/http/refusalReport.js';
import { Masker } from '../packages/mistri/src/server/observe/mask.js';
import { openIntegrationStore, provisionSqliteIntegrations } from '../packages/mistri/src/adapters/integrations/integrationStore.js';
import { captureIntegrations } from '../packages/mistri/src/server/integrations/integrationDeclaration.js';
import {
  createIntegrationRuntime,
  registerIntegrationRuntime,
  saveIntegrationSettings,
} from '../packages/mistri/src/server/integrations/integrationRuntime.js';
import { fakepay, provider, resetProvider } from './fixtures/integrations/fakepay/index.js';
import { createApp } from './support/createApp.js';
import { catalogOf } from './support/commandCatalog.js';

// The page carries random tokens (the style nonce, the link and its session) whose base64 can spell a
// name by chance; a CI run once failed on a nonce that read "ioAda9…". Leaks are looked for with them out.
const untokened = (html: string) => html.replace(/\b(?:nonce|data-base|data-session)="[^"]*"/g, '');

const SCHEMA = `CREATE TABLE application (id INTEGER PRIMARY KEY, applicant TEXT NOT NULL, status TEXT NOT NULL, zip TEXT, email TEXT, mobile TEXT, note TEXT);
  INSERT INTO application VALUES (1, 'Ada', 'submitted', '94110', 'ada@example.test', '+1 (555) 010-0001', 'private note'),
                                 (2, 'Bea', 'submitted', '10001', 'bea@example.test', NULL, 'another note');`;

const KEY = 'k'.repeat(40);
process.env.MISTRI_SECRETS_KEY ??= 'a-secrets-key-for-tests-that-is-long-enough';

const CONTRACTS = {
  invite: { target: 'application', input: { link: { type: 'text' } } },
  withdraw: { target: 'application', input: { reason: { type: 'text', optional: true } } },
  approve: { target: 'application' },
  revoke: { target: 'application' },
  discard: { target: 'application' },
  apply: { public: true, input: { applicant: { type: 'text', max: 80 } } },
  accept: { target: 'application' },
};

const RAW = {
  id: 'intake',
  name: 'Intake',
  sources: { main: { connection: 'intake-db', default: true } },
  resources: {
    application: {
      access: 'write',
      actions: {
        invite: { label: 'Invite', command: 'invite' },
        revoke: { label: 'Revoke', command: 'revoke' },
        approve: { label: 'Approve', command: 'approve' },
        discard: { label: 'Discard', command: 'discard' },
      },
      links: {
        status: { show: ['applicant', 'status'], says: { status: { submitted: 'Received' } }, commands: ['withdraw'] },
        once: { show: ['applicant'], uses: 1 },
        checked: { show: ['applicant'], confirm: { zip: 'ZIP code' } },
        stepped: { show: ['applicant'], stepUp: 'email' },
        texted: { show: ['applicant'], stepUp: { sms: 'mobile' } },
        brief: { show: ['applicant'], expires: '1 hour' },
      },
    },
  },
  auth: {
    providers: ['email'],
    roles: {
      clerk: { read: true, commands: ['invite', 'revoke', 'approve', 'discard'] },
      // Edits an application's note in place, and so may revoke its links from its page; its status is the commands'.
      editor: {
        read: true,
        write: ['application'],
        fields: { application: { read: ['id', 'applicant', 'status', 'note'], write: ['note'] } },
      },
      // Makes applications and edits none, so ends no link of one.
      intake: { read: true, create: ['application'] },
    },
  },
  views: {
    applications: { kind: 'list', from: 'application' },
    apply: { kind: 'form', label: 'Apply', public: true, done: { title: 'Thanks' }, command: 'apply' },
  },
  home: 'applications',
  nav: ['applications'],
};

/* A related list's fixture is its own App: a child table with a foreign key to application changes what the
   delete-and-revoke tests above may remove, so they keep the plain schema. */
const DOCUMENTS = `CREATE TABLE document (id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES application(id), title TEXT NOT NULL, secret TEXT);
  INSERT INTO document VALUES (1, 2, 'Pay stub', 's1'), (2, 2, 'Bank statement', 's2'), (3, 2, 'Lease', 's3');`;
/* A quote the customer accepts: `accept` is a verb of the machine and is granted to no role, so only a link moves it. */
const QUOTE_RAW = {
  ...RAW,
  resources: {
    application: {
      ...RAW.resources.application,
      machine: machine('status', { draft: { on: { send: 'sent' } }, sent: { on: { accept: 'accepted' } }, accepted: { final: true } }),
      links: { ...RAW.resources.application.links, quote: { show: ['applicant', 'status'], commands: ['accept'] } },
    },
  },
};
/* Withdrawn applications are frozen: the status link's own command is refused on one, though the link was minted before. */
const FROZEN_RAW = {
  ...RAW,
  resources: { application: { ...RAW.resources.application, frozen: 'status = withdrawn' } },
};
const RELATED_RAW = {
  ...RAW,
  resources: {
    application: {
      ...RAW.resources.application,
      links: {
        ...RAW.resources.application.links,
        dossier: { show: ['applicant'], confirm: { zip: 'ZIP code' }, related: { document: { show: ['title'], sort: '-id', most: 2 } } },
      },
    },
    document: { hidden: ['secret'] },
  },
};

const parse = (raw: unknown = RAW) => parseAppConfig(raw as typeof RAW, 'links', { commands: catalogOf(CONTRACTS) });

interface Answer {
  status: number;
  headers: Headers;
  text: string;
  body: any;
}

async function fixture(
  run: (f: {
    origin: string;
    mint: (name: string, id?: number) => Promise<{ url: string; answer: Answer }>;
    command: (name: 'invite' | 'revoke' | 'approve' | 'discard', id: number, input?: object) => Promise<Answer>;
    get: (path: string, headers?: Record<string, string>) => Promise<Answer>;
    post: (path: string, body: object, headers?: Record<string, string>) => Promise<Answer>;
    land: (url: string) => Promise<{ id: string; cookie: string; session: string; page: Answer }>;
    sql: DatabaseSync;
    mail: EmailMessage[];
    /** Signs the next requests in as this role (`clerk` until said). */
    as: (role: string) => void;
  }) => Promise<void>,
  options: {
    history?: boolean;
    related?: boolean;
    /** Application 1 is a sent quote and 2 a draft, under a machine whose `accept` verb only the `quote` link runs. */
    quote?: boolean;
    /** Applications are frozen once withdrawn (FROZEN_RAW). */
    frozen?: boolean;
    /** Runs after the adapter has answered a read of this table: where a test acts mid-render. */
    afterRead?: (table: string, sql: DatabaseSync) => void;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-links-'));
  const file = join(directory, 'intake.db');
  const setup = new DatabaseSync(file);
  setup.exec(options.related ? `${SCHEMA}\n${DOCUMENTS}` : SCHEMA);
  if (options.quote) setup.exec(`UPDATE application SET status = CASE id WHEN 1 THEN 'sent' ELSE 'draft' END`);
  setup.close();
  migrateSqliteCommandJournal(file);
  if (options.history) provisionSqliteRecordHistory(file);
  const registry = new Registry();
  registry.add({ id: 'intake-db', name: 'Intake', url: file, writable: true, source: 'config' });
  const actOn = options.afterRead && new DatabaseSync(file);
  if (options.afterRead) {
    const open = registry.open.bind(registry);
    registry.open = (async (id: string) => {
      const opened = await open(id);
      // The adapter's identity keys its command journal, so it is wrapped in place, once, and not proxied.
      const adapter = opened.adapter as any;
      if (!adapter.watched) {
        const query = adapter.query.bind(adapter);
        adapter.query = async (request: { table: string }) => {
          const result = await query(request);
          options.afterRead!(request.table, actOn!);
          return result;
        };
        adapter.watched = true;
      }
      return opened;
    }) as typeof registry.open;
  }
  const mail: EmailMessage[] = [];
  const transport: EmailTransport = { name: 'capture', send: async (message) => void mail.push(message) };
  registry.addService({ kind: 'email', name: transport.name, url: 'log:', from: 'Intake <no-reply@example.test>' });
  registry.serviceState('email', () => ({ transport: transport as EmailTransport | undefined }));
  const commands = defineCommands({
    invite: defineCommand({
      source: 'main',
      target: 'application',
      track: 'receipts',
      input: CONTRACTS.invite.input as never,
      output: shape({ link: text() }),
      async handle({ link }, input) {
        return { link: await link((input as { link: string }).link) };
      },
    }),
    accept: defineCommand({
      source: 'main',
      target: 'application',
      track: 'receipts',
      async handle({ tx, record }) {
        await tx.update({ table: 'application', key: { id: Number(record.id) }, values: { status: 'accepted' } });
      },
    }),
    withdraw: defineCommand({
      source: 'main',
      target: 'application',
      track: 'receipts',
      input: CONTRACTS.withdraw.input as never,
      async handle({ tx, record }, input) {
        await tx.update({
          table: 'application',
          key: { id: Number(record.id) },
          values: { status: 'withdrawn', note: (input as { reason?: string }).reason ?? null },
        });
      },
    }),
    approve: defineCommand({
      source: 'main',
      target: 'application',
      async handle({ tx, record }) {
        await tx.update({ table: 'application', key: { id: Number(record.id) }, values: { status: 'approved' } });
      },
    }),
    revoke: defineCommand({
      source: 'main',
      target: 'application',
      output: shape({ link: text() }),
      async handle({ revokeLinks }) {
        return { link: String(await revokeLinks()) };
      },
    }),
    discard: defineCommand({
      source: 'main',
      target: 'application',
      async handle({ tx, record }) {
        await tx.remove({ table: 'application', key: { id: Number(record.id) } });
      },
    }),
    /* A public command answers its visitor with a link to the application it made; asked before it has made one, or
       for a name the resource does not declare, it is refused. */
    apply: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'application',
      read: ['application'],
      write: ['application'],
      public: true,
      input: CONTRACTS.apply.input as never,
      output: shape({ reference: text(), link: text() }),
      async handle({ tx, link }, input) {
        const { applicant } = input as { applicant: string };
        if (applicant === 'early') await link('status');
        const made = await tx.insert({ table: 'application', values: { applicant, status: 'submitted' } });
        return { reference: `A-${made.key.id}`, link: await link(applicant === 'undeclared' ? 'nope' : 'status') };
      },
    }),
  });
  const app = parse(options.related ? RELATED_RAW : options.quote ? QUOTE_RAW : options.frozen ? FROZEN_RAW : RAW);
  const clerk: Identity = { id: 'account-clerk', who: 'clerk@example.test', role: 'clerk' };
  let role = 'clerk';
  const pages: PageDef[] = options.history
    ? [{ id: 'application', name: 'Application', base: 'application', sections: [{ kind: 'history' }] }]
    : [];
  const host: AppHost = {
    app: { app, path: '/private/intake/app.ts', pages, sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: '/private/intake/auth.db',
      close() {},
      handler: async () => {},
      session: async () =>
        role === 'clerk'
          ? clerk
          : { id: `account-${role}`, who: `${role}@example.test`, name: `${role[0].toUpperCase()}${role.slice(1)} Person`, role },
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [], commands: { appId: 'intake', registry: commands } });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  const origin = `http://${bound.host}:${bound.port}`;
  const disposers = [configureFormKey('intake', { MISTRI_FORM_KEY: KEY }), configureLinkBase('intake', origin)];
  resetPublicFormLimits();
  const answer = async (response: Response): Promise<Answer> => {
    const body = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    return { status: response.status, headers: response.headers, text: body, body: parsed };
  };
  const call = async (path: string, init: RequestInit = {}) =>
    answer(await fetch(`${origin}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(10_000), ...init }));
  let keys = 0;
  const command = async (name: 'invite' | 'revoke' | 'approve' | 'discard', id: number, input: object = {}) => {
    const headers = { 'content-type': 'application/json', 'x-mistri-account': clerk.id, origin };
    const prepared = await call('/api/commands/prepare?app=intake', {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: name, commandVersion: 1, key: { id } }),
    });
    assert.equal(prepared.status, 200, prepared.text);
    return call('/api/commands/execute?app=intake', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: name,
        commandVersion: 1,
        key: { id },
        expectedVersion: prepared.body.expectedVersion,
        idempotencyKey: `links-${name}-${id}-${++keys}`,
        input,
      }),
    });
  };
  const get = (path: string, headers: Record<string, string> = {}) => call(path, { headers });
  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    call(path, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(body) });
  const sql = new DatabaseSync(file);
  try {
    await run({
      origin,
      mint: async (name, id = 1) => {
        const minted = await command('invite', id, { link: name });
        assert.equal(minted.status, 200, minted.text);
        const url = /http:\/\/[^"]+\/l\/mstl1\.[A-Za-z0-9_.-]+/.exec(minted.text)?.[0];
        assert.ok(url, `the minting answer says the URL: ${minted.text}`);
        return { url, answer: minted };
      },
      command,
      get,
      post,
      land: async (url) => {
        const opened = await call(url.slice(origin.length));
        assert.equal(opened.status, 303, opened.text);
        const id = linkTokenId(url.slice(url.lastIndexOf('/') + 1))!;
        assert.equal(opened.headers.get('location'), `/l/${id}`);
        const cookie = opened.headers.get('set-cookie')!.split(';')[0];
        const page = await get(`/l/${id}`, { cookie });
        const session = /data-session="([^"]+)"/.exec(page.text)?.[1] ?? '';
        return { id, cookie, session, page };
      },
      sql,
      mail,
      as: (next) => {
        role = next;
      },
    });
  } finally {
    sql.close();
    actOn?.close();
    for (const dispose of disposers) dispose();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal('intake-db');
    resetPublicFormLimits();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a token is the id and a MAC over the grant; any other grant, key or id does not match it', () => {
  const dispose = configureFormKey('intake', { MISTRI_FORM_KEY: KEY });
  try {
    const row = { id: 'A'.repeat(22), tenant: '', resource: 'application', rowKey: '[["id","1"]]', name: 'status' };
    const token = linkToken('intake', row);
    assert.match(token, /^mstl1\.A{22}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(linkTokenId(token), row.id);
    assert.equal(linkTokenMatches('intake', token, row), true);
    for (const other of [{ rowKey: '[["id","2"]]' }, { name: 'once' }, { resource: 'other' }, { tenant: 't' }])
      assert.equal(linkTokenMatches('intake', token, { ...row, ...other }), false);
    assert.equal(linkTokenMatches('intake', token, undefined), false);
    assert.equal(linkTokenMatches('other', token, row), false);
    const at = token.length - 10;
    const flipped = token.slice(0, at) + (token[at] === 'A' ? 'B' : 'A') + token.slice(at + 1);
    assert.equal(linkTokenMatches('intake', flipped, row), false);
    assert.equal(linkTokenId('mstl1.short.mac'), undefined);
    // A session names its link and its gates, and expires.
    const now = Date.UTC(2026, 10, 11);
    const session = linkSession('intake', '', row.id, 1, now);
    assert.deepEqual(readLinkSession('intake', '', row.id, session, now), { gates: 1, opened: now / 1000 });
    assert.equal(readLinkSession('intake', '', 'B'.repeat(22), session, now), undefined);
    assert.equal(readLinkSession('intake', '', row.id, session.replace(/\.1\./, '.3.'), now), undefined, 'a gate is not added by hand');
    assert.equal(readLinkSession('intake', 't', row.id, session, now), undefined);
    assert.equal(readLinkSession('intake', '', row.id, session, now + 301_000), undefined);
    // Renewal slides the five minutes but keeps the first open, so one open ends half an hour in.
    let renewed = session;
    for (let at = now + 240_000; at < now + 1_800_000; at += 240_000) {
      const read = readLinkSession('intake', '', row.id, renewed, at);
      assert.ok(read, `still open at ${(at - now) / 60_000} minutes`);
      assert.equal(read.opened, now / 1000);
      renewed = linkSession('intake', '', row.id, read.gates, at, read.opened);
    }
    assert.equal(readLinkSession('intake', '', row.id, renewed, now + LINK_OPEN_SECONDS * 1000), undefined);
    assert.equal(
      readLinkSession('intake', '', row.id, session.replace(/\.(\d+)\.([A-Za-z0-9_-]{43})$/, `.${now / 1000 + 600}.$2`), now),
      undefined,
      'the first open is signed',
    );
  } finally {
    dispose();
  }
});

test('a log keeps a link’s id and never its MAC: the refusal report and the observer both cut a token down', () => {
  const id = 'A'.repeat(21) + 'b';
  const mac = 'M'.repeat(42) + 'x';
  const token = `mstl1.${id}.${mac}`;
  const session = `mstls1.${id}.1760000000000.1.1760000000000.${mac}`;
  for (const said of [
    redactLinkTokens(`GET /intake/l/${token} refused (404)`),
    new Masker().text(`/intake/l/${token}?x=1`),
    new Masker().text(`{"link":"http://127.0.0.1/intake/l/${token}"}`),
    redactLinkTokens(session),
  ]) {
    assert.ok(said.includes(id), said);
    assert.ok(!said.includes(mac), said);
    assert.match(said, /\[redacted\]/);
  }
  // A link's session header is masked whole, as a cookie is.
  assert.equal(new Masker().headers({ 'x-mistri-link': session })['x-mistri-link'], '[masked: credential]');
  // A path that holds no token is left alone.
  assert.equal(redactLinkTokens('/intake/l/abc/prepare'), '/intake/l/abc/prepare');
});

test('a reference renders as its URL, and a text holding one that does not render renders nothing', async () => {
  const id = 'C'.repeat(22);
  const ref = new LinkRef(id, 'shop');
  const said = String(ref);
  assert.match(said, new RegExp(`^mistri-link:${id}\\.[A-Za-z0-9_-]{22}$`), 'the reference carries its seal');
  assert.equal(JSON.stringify({ link: ref }), JSON.stringify({ link: said }));
  assert.equal(
    await renderLinkRefs(`Open ${ref} or ${ref}`, 'shop', async (link) => `https://x.test/l/${link}`),
    `Open https://x.test/l/${id} or https://x.test/l/${id}`,
  );
  assert.equal(await renderLinkRefs(`Open ${ref}`, 'shop', async () => undefined), undefined);
  assert.equal(await renderLinkRefs('nothing here', 'shop', async () => undefined), 'nothing here');
  // A look-alike, typed or made for another App, is the text it is: never rendered, never a failure.
  for (const typed of [`mistri-link:${id}`, `mistri-link:${id}.${'A'.repeat(22)}`, String(new LinkRef(id, 'other'))])
    assert.equal(await renderLinkRefs(`Open ${typed}`, 'shop', async () => undefined), `Open ${typed}`);
});

test('a declaration is judged as the App is parsed, and its columns once the catalog is read', () => {
  const withLink = (link: unknown, extra: Record<string, unknown> = {}) => ({
    ...RAW,
    ...extra,
    resources: { application: { ...RAW.resources.application, links: { x: link } } },
  });
  assert.throws(() => parse(withLink({ show: [] })), /needs "show"/);
  assert.throws(() => parse(withLink({ show: ['applicant'], expires: '1 year' })), /"expires"/);
  assert.throws(() => parse(withLink({ show: ['applicant'], uses: 0 })), /"uses"/);
  assert.throws(() => parse(withLink({ show: ['zip'], confirm: ['zip'] })), /never shows what it asks/);
  assert.throws(() => parse(withLink({ show: ['applicant'], commands: ['nope'] })), /does not register/);
  assert.throws(() => parse(withLink({ show: ['applicant'], surprise: true })), /surprise/);
  // A step-up's code goes to one address: one channel key, named like a channel, naming a column.
  assert.throws(() => parse(withLink({ show: ['applicant'], stepUp: {} })), /names no channel/);
  assert.throws(() => parse(withLink({ show: ['applicant'], stepUp: { email: 'email', sms: 'mobile' } })), /more than one channel/);
  assert.throws(() => parse(withLink({ show: ['applicant'], stepUp: { SMS: 'mobile' } })), /"SMS", which is not a channel/);
  assert.throws(() => parse(withLink({ show: ['applicant'], stepUp: { sms: ['mobile'] } })), /names the record's column/);
  assert.throws(() => parse(withLink({ show: ['applicant'], stepUp: 7 })), /email column, or \{ <channel>/);
  const schema = {
    dialect: 'sqlite',
    tables: [
      {
        id: 'application',
        name: 'application',
        columns: ['id', 'applicant', 'status', 'zip', 'email', 'mobile', 'note'].map((name) => ({
          name,
          type: 'TEXT',
          nullable: true,
          primaryKey: name === 'id',
        })),
      },
      {
        id: 'document',
        name: 'document',
        columns: ['id', 'application_id', 'title', 'secret'].map((name) => ({
          name,
          type: name.endsWith('id') ? 'INTEGER' : 'TEXT',
          nullable: name !== 'id',
          primaryKey: name === 'id',
        })),
      },
    ],
    foreignKeys: [{ from: { table: 'document', columns: ['application_id'] }, to: { table: 'application', columns: ['id'] } }],
  } as unknown as DatabaseSchema;
  assert.deepEqual(appLinkProblems(parse(), schema), []);
  // A related list: one hop to rows that point at the record, a said cap, and only behind a second factor.
  const related = (list: unknown, link: Record<string, unknown> = { confirm: { zip: 'ZIP code' } }) => ({
    ...RAW,
    resources: {
      ...RAW.resources,
      application: { ...RAW.resources.application, links: { x: { show: ['applicant'], ...link, related: list } } },
      document: { hidden: ['secret'] },
    },
  });
  const listed = { document: { show: ['title'], most: 5 } };
  assert.throws(() => parse(related(listed, {})), /"related" without a "stepUp" or a "confirm"/);
  assert.throws(() => parse(related(listed, { uses: 1 })), /"related" without a "stepUp" or a "confirm"/);
  assert.doesNotThrow(() => parse(related(listed, { stepUp: 'email' })));
  assert.throws(() => parse(related({})), /one to 4 resources/);
  const five = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((name) => [name, { show: ['title'], most: 1 }]));
  assert.throws(() => parse(related(five)), /one to 4 resources/);
  assert.throws(() => parse(related({ document: { show: ['title'] } })), /needs "most"/);
  assert.throws(() => parse(related({ document: { show: ['title'], most: 51 } })), /from 1 to 50/);
  assert.throws(() => parse(related({ document: { show: ['title'], most: 5, page: 2 } })), /page/);
  assert.deepEqual(appLinkProblems(parse(related(listed)), schema), []);
  assert.deepEqual(appLinkProblems(parse(related({ nope: { show: ['title'], most: 5 } })), schema), [
    'resources "application", links "x", "related.nope" names "nope", which is not a resource of the App.',
  ]);
  assert.match(
    appLinkProblems(parse(related({ document: { show: ['secret'], most: 5 } })), schema)[0]!,
    /"show" names "secret", which the resource hides; a link adds no read/,
  );
  assert.match(
    appLinkProblems(parse(related({ document: { show: ['title'], sort: 'missing', most: 5 } })), schema)[0]!,
    /"sort" names "missing", which is not a column of document/,
  );
  assert.match(
    appLinkProblems(parse(related({ document: { show: ['title'], by: 'title', most: 5 } })), schema)[0]!,
    /has no single-column foreign key "title" to application/,
  );
  const bytes = related({ document: { show: ['title', 'secret'], most: 5 } });
  const filed = parse({ ...bytes, resources: { ...bytes.resources, document: { file: { name: 'title', content: 'secret' } } } });
  assert.match(appLinkProblems(filed, schema)[0]!, /the file's bytes; a link lists text, not files/);
  assert.match(appLinkProblems(parse(withLink({ show: ['missing'] })), schema)[0], /"missing", which is not a column/);
  const hidden = parse({
    ...RAW,
    resources: { application: { ...RAW.resources.application, hidden: ['note'], links: { x: { show: ['note'] } } } },
  });
  assert.match(appLinkProblems(hidden, schema)[0], /the resource hides; a link adds no read/);
  const keyedL = parse({ ...RAW, views: { ...RAW.views, l: { kind: 'list', from: 'application' } } });
  assert.match(appLinkProblems(keyedL, schema)[0], /no view can be keyed "l"/);
  // The code's column holds an address for its channel: an email for email, a phone number for any other.
  assert.deepEqual(appLinkProblems(parse(withLink({ show: ['applicant'], stepUp: { email: 'email' } })), schema), []);
  assert.match(
    appLinkProblems(parse(withLink({ show: ['applicant'], stepUp: 'applicant' })), schema)[0],
    /links "x", "stepUp" sends its code by email to "applicant", which is not an email column/,
  );
  assert.match(
    appLinkProblems(parse(withLink({ show: ['applicant'], stepUp: { sms: 'email' } })), schema)[0],
    /"stepUp" sends its code by the "sms" channel to "email", which is not a phone column/,
  );
  // A missing column is said once, as missing.
  assert.deepEqual(appLinkProblems(parse(withLink({ show: ['applicant'], stepUp: { sms: 'cell_phone' } })), schema), [
    'resources "application", links "x", "stepUp" names "cell_phone", which is not a column of application.',
  ]);
  // The resource's display rule says it as surely as the name.
  const dressed = parse({
    ...RAW,
    resources: {
      application: {
        ...RAW.resources.application,
        display: { note: { format: 'phone' } },
        links: { x: { show: ['applicant'], stepUp: { sms: 'note' } } },
      },
    },
  });
  assert.deepEqual(appLinkProblems(dressed, schema), []);
});

test('a link is minted by its command, said once as a URL, and opens its one record behind a Lax cookie', () =>
  fixture(async ({ mint, land, get, post, sql, origin }) => {
    const { url } = await mint('status');
    // The receipt keeps the reference; the secret is nowhere in the journal.
    const receipts = JSON.stringify(sql.prepare(`SELECT * FROM ${COMMAND_JOURNAL_TABLES.receipt}`).all());
    assert.match(receipts, /mistri-link:[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}/);
    assert.doesNotMatch(receipts, /mstl1\./);
    const opened = await get(url.slice(origin.length));
    assert.equal(opened.status, 303);
    for (const [header, value] of [
      ['cache-control', 'no-store'],
      ['referrer-policy', 'no-referrer'],
      ['x-robots-tag', 'noindex, nofollow'],
    ])
      assert.equal(opened.headers.get(header), value);
    const cookie = opened.headers.get('set-cookie')!;
    assert.match(cookie, /^mstl_[A-Za-z0-9_-]{22}=mstls1\./);
    assert.match(cookie, /; Path=\/l\/; Max-Age=300; HttpOnly; SameSite=Lax; Secure$/);

    const { page, session, id } = await land(url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy')!, /script-src 'nonce-/);
    assert.match(page.text, /<dd>Ada<\/dd>/);
    assert.match(page.text, /<dd>Received<\/dd>/, 'a shown value in the author’s words');
    assert.doesNotMatch(page.text, /94110|private note|ada@example/, 'nothing the link does not show');
    assert.match(page.text, /data-command="withdraw"/);
    assert.doesNotMatch(page.text, /approve/);

    // The page itself takes no session from the address: without the cookie it is a miss.
    assert.equal((await get(`/l/${id}`)).status, 404);

    // The declared command runs on the record, as the link's principal.
    const headers = { 'x-mistri-link': session };
    const prepared = await post(`/l/${id}/prepare`, {}, headers);
    assert.equal(prepared.status, 200, prepared.text);
    const expectedVersion = prepared.body.commands.withdraw.expectedVersion;
    assert.ok(expectedVersion !== undefined);
    const ran = await post(
      `/l/${id}/run`,
      { command: 'withdraw', expectedVersion, idempotencyKey: 'withdraw-0000000001', input: { reason: 'moved' } },
      headers,
    );
    assert.equal(ran.status, 200, ran.text);
    assert.deepEqual(
      sql
        .prepare('SELECT id, status, note FROM application ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
      [
        { id: 1, status: 'withdrawn', note: 'moved' },
        { id: 2, status: 'submitted', note: 'another note' },
      ],
    );
    const actor = sql.prepare(`SELECT actor_id FROM ${COMMAND_JOURNAL_TABLES.receipt} WHERE command_id = 'withdraw'`).get() as {
      actor_id: string;
    };
    assert.equal(actor.actor_id, `link:${id}`);
  }));

test('the link principal runs only its declared commands, on its one record, from its own page', () =>
  fixture(async ({ mint, land, post, sql, origin }) => {
    const { url } = await mint('status', 1);
    const { id, session } = await land(url);
    const headers = { 'x-mistri-link': session };
    // An undeclared command, even one the App grants a person.
    const approve = await post(
      `/l/${id}/run`,
      { command: 'approve', expectedVersion: 1, idempotencyKey: 'approve-000000001', input: {} },
      headers,
    );
    assert.equal(approve.status, 403);
    // Another record: the key is the link's, never the request's.
    const prepared = await post(`/l/${id}/prepare`, {}, headers);
    const other = await post(
      `/l/${id}/run`,
      {
        command: 'withdraw',
        key: { id: 2 },
        expectedVersion: prepared.body.commands.withdraw.expectedVersion,
        idempotencyKey: 'withdraw-00000002',
        input: {},
      },
      headers,
    );
    assert.equal(other.status, 200, other.text);
    assert.deepEqual(
      sql
        .prepare('SELECT status FROM application ORDER BY id')
        .all()
        .map((row) => row.status),
      ['withdrawn', 'submitted'],
    );
    // From another origin, or with no session header, or with another link's session: refused.
    const crossOrigin = await post(`/l/${id}/prepare`, {}, { ...headers, origin: 'https://elsewhere.example' });
    assert.equal(crossOrigin.status, 403);
    assert.equal((await post(`/l/${id}/prepare`, {})).status, 404);
    const second = await land((await mint('status', 2)).url);
    assert.equal((await post(`/l/${id}/prepare`, {}, { 'x-mistri-link': second.session })).status, 404);
    // The cookie alone is no session for a POST.
    assert.equal((await post(`/l/${id}/prepare`, {}, { cookie: (await land(url)).cookie })).status, 404);
    // A link's principal is refused the generic command door outright.
    const generic = await fetch(`${origin}/api/commands/prepare?app=intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'x-mistri-link': session },
      body: JSON.stringify({ command: 'withdraw', commandVersion: 1, key: { id: 1 } }),
    });
    assert.notEqual(generic.status, 200);
  }));

test('a link runs nothing on a frozen row: 409 frozen, and the row is as it was', () =>
  fixture(
    async ({ mint, land, post, sql }) => {
      const { id, session } = await land((await mint('status', 1)).url);
      const headers = { 'x-mistri-link': session };
      const prepared = await post(`/l/${id}/prepare`, {}, headers);
      const version = prepared.body.commands.withdraw.expectedVersion;
      // The row freezes after the link was minted and opened, by a write outside the link.
      sql.exec("UPDATE application SET status = 'withdrawn' WHERE id = 1");
      const run = (key: string) =>
        post(`/l/${id}/run`, { command: 'withdraw', expectedVersion: version, idempotencyKey: key, input: { reason: 'Again' } }, headers);
      const refused = await run('withdraw-frozen-0001');
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.body.code, 'frozen');
      assert.equal(sql.prepare('SELECT note FROM application WHERE id = 1').get()!.note, 'private note');
      // A row the condition does not match still runs, on its own link.
      const other = await land((await mint('status', 2)).url);
      const ready = await post(`/l/${other.id}/prepare`, {}, { 'x-mistri-link': other.session });
      const done = await post(
        `/l/${other.id}/run`,
        {
          command: 'withdraw',
          expectedVersion: ready.body.commands.withdraw.expectedVersion,
          idempotencyKey: 'withdraw-frozen-0002',
          input: {},
        },
        { 'x-mistri-link': other.session },
      );
      assert.equal(done.status, 200, done.text);
    },
    { frozen: true },
  ));

test('every miss is one answer on one floor: unknown, wrong MAC, revoked, expired and spent', () =>
  fixture(async ({ mint, get, command, sql, origin }) => {
    const { url } = await mint('status');
    const path = url.slice(origin.length);
    const token = path.slice(path.lastIndexOf('/') + 1);
    const id = linkTokenId(token)!;
    const unknown = `/l/mstl1.${'Z'.repeat(22)}.${token.slice(-43)}`;
    // A MAC's last base64url character carries only four of its six bits, so
    // flipping its low bit can decode to the same MAC; change one inside it.
    const at = path.length - 10;
    const badMac = `${path.slice(0, at)}${path[at] === 'A' ? 'B' : 'A'}${path.slice(at + 1)}`;
    const misses: Answer[] = [];
    for (const each of [unknown, badMac, '/l/not-a-token', `/l/${'Y'.repeat(22)}`]) {
      const started = Date.now();
      const answer = await get(each);
      assert.ok(Date.now() - started >= 340, `${each} answered under the floor`);
      misses.push(answer);
    }
    const scrub = (text: string) => text.replace(/nonce-[^']+'/g, '').replace(/nonce="[^"]+"/g, '');
    for (const answer of misses) {
      assert.equal(answer.status, 404);
      assert.equal(answer.headers.get('set-cookie'), null);
      assert.equal(scrub(answer.text), scrub(misses[0].text));
      assert.match(answer.text, new RegExp(LINK_MISS.replace('.', '\\.')));
    }

    // Revoked by a command on the record: the URL opens nothing after.
    assert.equal((await command('revoke', 1)).status, 200);
    const revoked = await get(path);
    assert.equal(revoked.status, 404);
    assert.equal(scrub(revoked.text), scrub(misses[0].text));

    // Expired: the row says when.
    const brief = await mint('brief');
    sql
      .prepare(`UPDATE ${COMMAND_JOURNAL_TABLES.link} SET expires_at = ? WHERE id = ?`)
      .run(Date.now() - 1, linkTokenId(brief.url.slice(brief.url.lastIndexOf('/') + 1))!);
    assert.equal((await get(brief.url.slice(origin.length))).status, 404);
    const row = sql.prepare(`SELECT revoked_at, expires_at FROM ${COMMAND_JOURNAL_TABLES.link} WHERE id = ?`).get(id) as {
      revoked_at: number;
    };
    assert.ok(row.revoked_at > 0);
  }));

test('removing a row ends every link minted on it, in the removal’s own transaction', () =>
  fixture(async ({ mint, get, command, sql, origin }) => {
    const first = await mint('status');
    const second = await mint('brief');
    const other = await mint('status', 2);
    const live = () =>
      (
        sql.prepare(`SELECT id FROM ${COMMAND_JOURNAL_TABLES.link} WHERE revoked_at IS NULL ORDER BY created_at`).all() as {
          id: string;
        }[]
      ).map((row) => row.id);
    const idOf = (url: string) => linkTokenId(url.slice(url.lastIndexOf('/') + 1))!;
    assert.equal(live().length, 3);
    const discarded = await command('discard', 1);
    assert.equal(discarded.status, 200, discarded.text);
    // Both of row 1's links are revoked; row 2's is untouched and still opens.
    assert.deepEqual(live(), [idOf(other.url)]);
    for (const { url } of [first, second]) assert.equal((await get(url.slice(origin.length))).status, 404);
    assert.equal((await get(other.url.slice(origin.length))).status, 303);
  }));

test('a row removed outside any command closes its links the first time one is read, before its key names another row', () =>
  fixture(async ({ mint, land, get, sql, origin }) => {
    const first = await mint('status');
    const second = await mint('brief');
    const other = await mint('status', 2);
    const { id, cookie } = await land(first.url);
    const revokedAt = (url: string) =>
      (
        sql
          .prepare(`SELECT revoked_at FROM ${COMMAND_JOURNAL_TABLES.link} WHERE id = ?`)
          .get(linkTokenId(url.slice(url.lastIndexOf('/') + 1))!) as {
          revoked_at: number | null;
        }
      ).revoked_at;
    // Plain SQL, as a cascade would: no command runs, so nothing revokes yet.
    sql.prepare('DELETE FROM application WHERE id = 1').run();
    assert.equal(revokedAt(second.url), null);
    const page = await get(`/l/${id}`, { cookie });
    assert.equal(page.status, 404);
    // Every link to the row went with that read; the other row's did not.
    assert.ok(revokedAt(first.url)! > 0);
    assert.ok(revokedAt(second.url)! > 0);
    assert.equal(revokedAt(other.url), null);
    // The key comes back on a new row (rowid reuse): the links stay closed.
    sql.prepare("INSERT INTO application (id, applicant, status) VALUES (1, 'Cy', 'submitted')").run();
    assert.equal((await get(second.url.slice(origin.length))).status, 404);
    assert.equal((await get(other.url.slice(origin.length))).status, 303);
  }));

test('check advises where a link outlives its row: a cascade, and a SQLite key the database hands out again', () => {
  const columns = ['id', 'applicant', 'status', 'zip', 'email', 'mobile', 'note'].map((name) => ({
    name,
    type: 'TEXT',
    nullable: true,
    primaryKey: name === 'id',
  }));
  const schema = (extra: object, foreignKeys: unknown[] = []) =>
    ({
      dialect: 'sqlite',
      tables: [{ id: 'application', name: 'application', columns, ...extra }],
      foreignKeys,
    }) as unknown as DatabaseSchema;
  assert.deepEqual(appLinkAdvisories(parse(), schema({})), []);
  const cascade = {
    name: 'fk',
    onDelete: 'cascade',
    from: { table: 'application', columns: ['program_id'] },
    to: { table: 'program', columns: ['id'] },
  };
  const advice = appLinkAdvisories(
    parse(),
    schema({ reusesKeys: true }, [cascade, { ...cascade, onDelete: 'restrict', to: { table: 'cohort', columns: ['id'] } }]),
  );
  assert.equal(advice.length, 2);
  assert.match(
    advice[0],
    /^resources "application", "links" \[link-cascade\]: its rows are deleted with their "program" \(ON DELETE CASCADE\)/,
  );
  assert.match(advice[1], /\[link-key-reuse\]: application is keyed by an INTEGER PRIMARY KEY without AUTOINCREMENT/);
  // A resource that mints no link is not advised.
  const { links: _links, ...plain } = RAW.resources.application;
  assert.deepEqual(appLinkAdvisories(parse({ ...RAW, resources: { application: plain } }), schema({ reusesKeys: true }, [cascade])), []);
});

test('check advises where a record page revokes links and the record keeps no history to say who did', () => {
  const page = (sections: object[]) => [{ label: 'Application', base: 'application', sections }] as unknown as PageDef[];
  const [advice, ...more] = linkHistoryWarnings(parse(), page([]));
  assert.deepEqual(more, []);
  assert.match(advice, /^resources "application", "links" \[link-history\]: its record page can revoke its links/);
  // A history section keeps the log the revoke is noted in.
  assert.deepEqual(linkHistoryWarnings(parse(), page([{ kind: 'history' }])), []);
  // A resource that mints no link is not advised.
  const { links: _links, ...plain } = RAW.resources.application;
  assert.deepEqual(linkHistoryWarnings(parse({ ...RAW, resources: { application: plain } }), page([])), []);
});

test('a person who edits a record revokes its links from its page, and its history says who did', () =>
  fixture(
    async ({ mint, get, post, sql, as, origin }) => {
      const first = await mint('status');
      await mint('brief');
      await mint('status', 2);
      const record = { app: 'intake', table: 'application', key: { id: 1 } };
      const revokedAt = (url: string) =>
        (
          sql
            .prepare(`SELECT revoked_at FROM ${COMMAND_JOURNAL_TABLES.link} WHERE id = ?`)
            .get(linkTokenId(url.slice(url.lastIndexOf('/') + 1))!) as {
            revoked_at: number | null;
          }
        ).revoked_at;
      const offered = async () => (await get('/api/app?app=intake', { origin })).body?.app?.revokesLinks;
      // Running commands on the record, or only making new ones, is not editing it: neither counts nor revokes.
      for (const role of ['clerk', 'intake']) {
        as(role);
        assert.equal(await offered(), undefined, role);
        assert.equal((await post('/api/record-links', record)).status, 403, role);
        assert.equal((await post('/api/record-links/revoke', record)).status, 403, role);
      }
      assert.equal(revokedAt(first.url), null);
      as('editor');
      assert.deepEqual(await offered(), ['application']);
      const counted = await post('/api/record-links', record);
      assert.equal(counted.status, 200, counted.text);
      assert.deepEqual(counted.body, { live: 2 });
      // A record this reader cannot find, and a resource that declares no links, have none for them.
      assert.equal((await post('/api/record-links', { ...record, key: { id: 99 } })).status, 403);
      assert.equal((await post('/api/record-links', { ...record, table: 'nope' })).status, 403);
      const revoked = await post('/api/record-links/revoke', record);
      assert.equal(revoked.status, 200, revoked.text);
      assert.deepEqual(revoked.body, { revoked: 2 });
      assert.ok(Number(revokedAt(first.url)) > 0);
      assert.equal((await get(first.url.slice(origin.length))).status, 404);
      // The other application's link is its own; nothing is left on this one, and a revoke of none notes nothing.
      assert.deepEqual((await post('/api/record-links', { ...record, key: { id: 2 } })).body, { live: 1 });
      assert.deepEqual((await post('/api/record-links/revoke', record)).body, { revoked: 0 });
      const history = await post('/api/record-history', record);
      assert.equal(history.status, 200, history.text);
      const entries = history.body.entries as Array<Record<string, unknown>>;
      assert.deepEqual(
        entries.filter((entry) => String(entry.action ?? '').startsWith('Revoked')).map((entry) => [entry.action, entry.fields]),
        [['Revoked 2 links', []]],
        history.text,
      );
      assert.equal(entries.find((entry) => entry.action === 'Revoked 2 links')?.by, 'Editor Person');
      // Nothing about the record itself moved.
      assert.deepEqual(
        { ...sql.prepare('SELECT status, note FROM application WHERE id = 1').get() },
        { status: 'submitted', note: 'private note' },
      );
    },
    { history: true },
  ));

test('the SQLite catalog marks a rowid key that may be handed out again, and not one declared AUTOINCREMENT', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-links-keys-'));
  const file = join(directory, 'keys.db');
  const setup = new DatabaseSync(file);
  setup.exec(`CREATE TABLE reused (id INTEGER PRIMARY KEY, a TEXT);
    CREATE TABLE kept (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT);
    CREATE TABLE texted (id TEXT PRIMARY KEY, a TEXT);`);
  setup.close();
  const registry = new Registry();
  try {
    registry.add({ id: 'keys', name: 'Keys', url: file, source: 'config' });
    const { schema } = await registry.open('keys');
    const flag = (name: string) => schema.tables.find((table) => table.name === name)?.reusesKeys;
    assert.equal(flag('reused'), true);
    assert.equal(flag('kept'), undefined);
    assert.equal(flag('texted'), undefined);
  } finally {
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a public command answers its visitor with a link to the one row it made, once, and a decoy with one that opens nothing', () =>
  fixture(async ({ post, get, land, sql, origin }) => {
    const apply = (applicant: string, submission: string, extra: object = {}) =>
      post('/api/forms/apply', { input: { applicant }, submission, ...extra });
    const applied = await apply('Cy', 'apply-submission-0001');
    assert.equal(applied.status, 200, applied.text);
    assert.equal(applied.body.reference, 'A-3');
    assert.match(applied.body.link, new RegExp(`^${origin}/l/mstl1\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}$`));
    const receipts = JSON.stringify(sql.prepare(`SELECT * FROM ${COMMAND_JOURNAL_TABLES.receipt}`).all());
    assert.doesNotMatch(receipts, /mstl1\./, 'the journal keeps the reference, never the URL');
    const row = sql.prepare(`SELECT row_key, created_by FROM ${COMMAND_JOURNAL_TABLES.link}`).get() as Record<string, string>;
    assert.equal(row.created_by, 'public:apply');
    // It opens the row the command made, and shows what the link declares of it alone.
    const { page } = await land(applied.body.link);
    assert.equal(page.status, 200, page.text);
    assert.match(page.text, /Cy/);
    assert.doesNotMatch(untokened(page.text), /Ada|Bea|ada@example\.test/);

    // A replay of the same submission answers its reference again, and never the URL a second time.
    const replayed = await apply('Cy', 'apply-submission-0001');
    assert.equal(replayed.status, 200, replayed.text);
    assert.equal(replayed.body.reference, 'A-3');
    assert.equal(replayed.body.link, undefined);

    // A filled honeypot is answered with a link-shaped URL, and it opens to the one miss.
    const decoy = await apply('Dee', 'apply-submission-0002', { trap: 'filled' });
    assert.equal(decoy.status, 200, decoy.text);
    assert.match(decoy.body.link, new RegExp(`^${origin}/l/mstl1\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}$`));
    assert.equal((await get(decoy.body.link.slice(origin.length))).status, 404);
    assert.equal((sql.prepare('SELECT count(*) AS n FROM application').get() as { n: number }).n, 3, 'a decoy writes nothing');

    // Asked before it has made its row, or for a name the resource does not declare, the command is refused whole.
    for (const [applicant, n] of [
      ['early', 3],
      ['undeclared', 4],
    ] as const) {
      const refused = await apply(applicant, `apply-submission-000${n}`);
      assert.notEqual(refused.status, 200, refused.text);
      assert.doesNotMatch(refused.text, /mstl1\./);
    }
    assert.equal((sql.prepare('SELECT count(*) AS n FROM application').get() as { n: number }).n, 3);
    assert.equal((sql.prepare(`SELECT count(*) AS n FROM ${COMMAND_JOURNAL_TABLES.link}`).get() as { n: number }).n, 1);
  }));

test('a revoke from the page racing a link’s run leaves the run after it, or a miss that ran nothing', () =>
  fixture(async ({ mint, land, post, get, sql, as }) => {
    const { url } = await mint('status', 1);
    const { id, session } = await land(url);
    const headers = { 'x-mistri-link': session };
    const prepared = await post(`/l/${id}/prepare`, {}, headers);
    assert.equal(prepared.status, 200, prepared.text);
    as('editor');
    const status = () => (sql.prepare('SELECT status FROM application WHERE id = 1').get() as { status: string }).status;
    const [ran, revoked] = await Promise.all([
      post(
        `/l/${id}/run`,
        {
          command: 'withdraw',
          expectedVersion: prepared.body.commands.withdraw.expectedVersion,
          idempotencyKey: 'withdraw-race-0001',
          input: {},
        },
        headers,
      ),
      post('/api/record-links/revoke', { app: 'intake', table: 'application', key: { id: 1 } }),
    ]);
    assert.equal(revoked.status, 200, revoked.text);
    // Whichever side of the revoke the run fell on, the link is gone, and the revoke counted it.
    assert.deepEqual(revoked.body, { revoked: 1 });
    if (ran.status === 200) assert.equal(status(), 'withdrawn');
    else {
      // The miss the link's next request gets, never a command refusal: nothing ran.
      assert.equal(ran.status, 404, ran.text);
      assert.equal(status(), 'submitted');
    }
    assert.equal((await get(`/l/${id}`)).status, 404);
  }));

test('a link of one use opens once, however many ask at the same moment', () =>
  fixture(async ({ mint, get, origin }) => {
    const { url } = await mint('once');
    const answers = await Promise.all(Array.from({ length: 5 }, () => get(url.slice(origin.length))));
    assert.deepEqual(answers.map((answer) => answer.status).sort(), [303, 404, 404, 404, 404]);
    resetPublicFormLimits();
    assert.equal((await get(url.slice(origin.length))).status, 404);
  }));

test('a confirmation is typed before anything shows, and five wrong ones lock it', () =>
  fixture(async ({ mint, land, get, post }) => {
    const { url } = await mint('checked');
    const { id, page, session, cookie } = await land(url);
    assert.match(page.text, /data-gate="confirm"/);
    assert.match(page.text, /ZIP code/);
    assert.doesNotMatch(untokened(page.text), /Ada/);
    const headers = { 'x-mistri-link': session };
    // Commands wait behind the gate too.
    assert.equal((await post(`/l/${id}/prepare`, {}, headers)).status, 404);
    const wrong = await post(`/l/${id}/confirm`, { confirm: { zip: '00000' } }, headers);
    assert.equal(wrong.status, 403, wrong.text);
    const right = await post(`/l/${id}/confirm`, { confirm: { zip: ' 94110 ' } }, headers);
    assert.equal(right.status, 200, right.text);
    assert.match(right.headers.get('set-cookie')!, /^mstl_/);
    const passed = await get(`/l/${id}`, { cookie: right.headers.get('set-cookie')!.split(';')[0] });
    assert.match(passed.text, /<dd>Ada<\/dd>/);
    assert.doesNotMatch(passed.text, /94110/);
    // The old cookie still names the ungated session.
    assert.match((await get(`/l/${id}`, { cookie })).text, /data-gate="confirm"/);

    // The per-client budget is its own guard; this is the per-link lock, which holds across clients.
    resetPublicFormLimits();
    const locked = await land((await mint('checked', 2)).url);
    for (let attempt = 0; attempt < 5; attempt++)
      assert.equal((await post(`/l/${locked.id}/confirm`, { confirm: { zip: 'nope' } }, { 'x-mistri-link': locked.session })).status, 403);
    const late = await post(`/l/${locked.id}/confirm`, { confirm: { zip: '10001' } }, { 'x-mistri-link': locked.session });
    assert.equal(late.status, 429);

    // A burst is charged before it is judged: concurrent tries do not all slip under the count.
    resetPublicFormLimits();
    const burst = await land((await mint('checked', 2)).url);
    const tries = await Promise.all(
      Array.from({ length: 12 }, () => post(`/l/${burst.id}/confirm`, { confirm: { zip: 'nope' } }, { 'x-mistri-link': burst.session })),
    );
    assert.ok(tries.filter((t) => t.status === 403).length <= 5, tries.map((t) => t.status).join(','));
    assert.equal((await post(`/l/${burst.id}/confirm`, { confirm: { zip: '10001' } }, { 'x-mistri-link': burst.session })).status, 429);
  }));

test('a related list shows the record’s own children, its declared columns and no more than its most, behind the gate', () =>
  fixture(
    async ({ mint, land, get, post, sql }) => {
      const { url } = await mint('dossier', 2);
      const { id, page, session } = await land(url);
      assert.match(page.text, /data-gate="confirm"/);
      assert.doesNotMatch(untokened(page.text), /Pay stub|Bank statement|Lease/, 'nothing related shows before the gate');
      const right = await post(`/l/${id}/confirm`, { confirm: { zip: '10001' } }, { 'x-mistri-link': session });
      assert.equal(right.status, 200, right.text);
      const cookie = right.headers.get('set-cookie')!.split(';')[0];
      const passed = await get(`/l/${id}`, { cookie });
      // Newest first, two of three: the declared sort and cap, not the visitor's.
      assert.match(passed.text, /<td>Lease<\/td><\/tr><tr><td>Bank statement<\/td>/);
      assert.doesNotMatch(passed.text, /Pay stub/);
      assert.doesNotMatch(untokened(passed.text), /\bs[123]\b/, 'a hidden column is never drawn');
      // The address carries no paging, sort or filter the server reads.
      for (const query of ['?page=2', '?most=50', '?sort=id', '?offset=2', '?document.most=3'])
        assert.doesNotMatch((await get(`/l/${id}${query}`, { cookie })).text, /Pay stub/, query);

      // One hop from this record only: another application's link lists its own documents, here none, and draws no list.
      sql.exec("INSERT INTO document VALUES (4, 1, 'Ada passport', 's4')");
      const other = await land((await mint('dossier', 1)).url);
      const opened = await post(`/l/${other.id}/confirm`, { confirm: { zip: '94110' } }, { 'x-mistri-link': other.session });
      const own = await get(`/l/${other.id}`, { cookie: opened.headers.get('set-cookie')!.split(';')[0] });
      assert.match(own.text, /<td>Ada passport<\/td>/);
      assert.doesNotMatch(own.text, /Lease|Bank statement|Pay stub/);
      sql.exec('DELETE FROM document WHERE id = 4');
      const empty = await get(`/l/${other.id}`, { cookie: opened.headers.get('set-cookie')!.split(';')[0] });
      assert.match(empty.text, /<dd>Ada<\/dd>/);
      assert.doesNotMatch(empty.text, /<table>/, 'an empty list is not drawn');
    },
    { related: true },
  ));

test('a link page is said in the holder’s language, with a switch only where the App has two catalogs', () => {
  const page = {
    app: 'intake',
    nonce: 'n',
    state: 'confirm' as const,
    base: '/l/x',
    session: 's',
    title: 'Ada',
    confirm: [{ column: 'zip', label: 'Código postal' }],
  };
  const spanish = linkPage({
    ...page,
    words: FRAMEWORK_WORDS_ES,
    lang: 'es',
    languages: { offered: ['en', 'es'], current: 'es', cookie: 'mistri_locale_intake' },
  });
  assert.match(spanish, /<html lang="es">/);
  assert.match(spanish, new RegExp(FRAMEWORK_WORDS_ES['mistri.link.continue']));
  assert.match(spanish, /<nav aria-label="Idioma">/);
  assert.match(spanish, /<a href="\?locale=en"[^>]*>English<\/a> <a href="\?locale=es"[^>]*aria-current="true">Español<\/a>/);
  assert.match(spanish, /data-cookie="mistri_locale_intake"/);
  // One language has nothing to switch to; the miss page is one sentence in each language and still no switch.
  assert.doesNotMatch(linkPage({ ...page, languages: { offered: ['en'], current: 'en', cookie: 'c' } }), /<nav/);
  assert.equal(
    linkPage({ app: 'intake', nonce: 'n', state: 'miss', words: FRAMEWORK_WORDS_ES, lang: 'es' }).includes(
      FRAMEWORK_WORDS_ES['mistri.link.miss'],
    ),
    true,
  );
});

test('a step-up mails a code to the record’s address, and the code opens the record once', () =>
  fixture(async ({ mint, land, get, post, mail }) => {
    const { url } = await mint('stepped');
    const { id, page, session } = await land(url);
    assert.match(page.text, /data-gate="send"/);
    assert.doesNotMatch(untokened(page.text), /Ada|ada@example/);
    const headers = { 'x-mistri-link': session };
    const early = await post(`/l/${id}/stepup`, { code: '000000' }, headers);
    assert.equal(early.status, 403, early.text);
    const sent = await post(`/l/${id}/stepup`, { send: true }, headers);
    assert.equal(sent.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(mail.length, 1);
    assert.equal(mail[0].to, 'ada@example.test');
    const code = /code is (\S+?)\./.exec(mail[0].text ?? '')?.[1];
    assert.ok(code);
    const ok = await post(`/l/${id}/stepup`, { code }, headers);
    assert.equal(ok.status, 200, ok.text);
    const opened = await get(`/l/${id}`, { cookie: ok.headers.get('set-cookie')!.split(';')[0] });
    assert.match(opened.text, /<dd>Ada<\/dd>/);
    // Spent: the same code a second time is refused.
    assert.equal((await post(`/l/${id}/stepup`, { code }, headers)).status, 403);
  }));

test('a step-up on a channel texts the code to the record’s number under the App’s own key, and never says it', () =>
  fixture(async ({ mint, land, get, post, mail }) => {
    const directory = mkdtempSync(join(tmpdir(), 'mistri-links-sms-'));
    const path = join(directory, 'integrations.db');
    new DatabaseSync(path).close();
    provisionSqliteIntegrations(path);
    const store = await openIntegrationStore({ sqlite: path });
    const runtime = createIntegrationRuntime({
      appId: 'intake',
      declared: captureIntegrations({ use: [fakepay()] }, new Map(), (message) => {
        throw new Error(message);
      }),
      store,
    });
    const withdraw = registerIntegrationRuntime(runtime);
    resetProvider();
    try {
      await saveIntegrationSettings(runtime, '', 'clerk', {
        integration: 'fakepay',
        secrets: { apiKey: 'sk_intake', webhookSecret: 'whsec_intake_0123456789abcdef' },
      });
      const { url } = await mint('texted');
      const { id, page, session } = await land(url);
      assert.match(page.text, /data-gate="send"/);
      assert.doesNotMatch(untokened(page.text), /Ada|555/);
      const headers = { 'x-mistri-link': session };
      const sent = await post(`/l/${id}/stepup`, { send: true }, headers);
      assert.equal(sent.status, 200, sent.text);
      assert.deepEqual(sent.body.sent, true);
      const until = Date.now() + 2000;
      while (provider.texts.length < 1 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(provider.texts.length, 1);
      assert.equal(provider.texts[0].to, '+1 (555) 010-0001');
      assert.equal(provider.texts[0].apiKey, 'sk_intake');
      const code = /code is (\d+)\./.exec(provider.texts[0].text)?.[1];
      assert.ok(code, provider.texts[0].text);
      assert.ok(!sent.text.includes(code), 'the answer never says the code');
      assert.equal(mail.length, 0, 'a channel step-up sends no email');
      const ok = await post(`/l/${id}/stepup`, { code }, headers);
      assert.equal(ok.status, 200, ok.text);
      const opened = await get(`/l/${id}`, { cookie: ok.headers.get('set-cookie')!.split(';')[0] });
      assert.match(opened.text, /<dd>Ada<\/dd>/);
      assert.doesNotMatch(untokened(opened.text), /555/);
      assert.equal((await post(`/l/${id}/stepup`, { code }, headers)).status, 403);
      // A record with no number on file answers the same, and nothing is sent.
      const bea = await land((await mint('texted', 2)).url);
      const quiet = await post(`/l/${bea.id}/stepup`, { send: true }, { 'x-mistri-link': bea.session });
      assert.equal(quiet.status, 200, quiet.text);
      assert.deepEqual(quiet.body.sent, true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(provider.texts.length, 1);
    } finally {
      withdraw();
      resetProvider();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }));

/* ---------- review fixes: a related list's door ---------- */

test('a link revoked while its related list is read draws no rows', () => {
  let revoke = false;
  return fixture(
    async ({ mint, land, get, post, sql }) => {
      const { url } = await mint('dossier', 2);
      const { id, session } = await land(url);
      const right = await post(`/l/${id}/confirm`, { confirm: { zip: '10001' } }, { 'x-mistri-link': session });
      const cookie = right.headers.get('set-cookie')!.split(';')[0];
      assert.match((await get(`/l/${id}`, { cookie })).text, /Lease/, 'live, it lists');
      revoke = true;
      const page = await get(`/l/${id}`, { cookie });
      assert.doesNotMatch(untokened(page.text), /Lease|Bank statement|Pay stub/, 'revoked mid-render, no related rows');
      assert.ok((sql.prepare(`SELECT revoked_at FROM ${COMMAND_JOURNAL_TABLES.link} WHERE id = ?`).get(id) as any).revoked_at > 0);
    },
    {
      related: true,
      afterRead(table, sql) {
        if (revoke && table === 'document') sql.exec(`UPDATE ${COMMAND_JOURNAL_TABLES.link} SET revoked_at = 1`);
      },
    },
  );
});

test('a related list is read in its child’s key order when it names no sort, and a resource mapped by table name is read', () => {
  const schema = (id: string) =>
    ({
      dialect: 'sqlite',
      tables: [
        { id: 'application', name: 'application', columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }] },
        {
          id,
          name: 'document',
          columns: [
            { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
            { name: 'application_id', type: 'INTEGER', nullable: false },
            { name: 'title', type: 'TEXT', nullable: true },
          ],
        },
      ],
      foreignKeys: [{ from: { table: id, columns: ['application_id'] }, to: { table: 'application', columns: ['id'] } }],
    }) as unknown as DatabaseSchema;
  const list = { show: ['title'], most: 3 };
  for (const id of ['document', 'main.document']) {
    const query = relatedQuery(schema(id), 'application', 'document', list, { id: 2 });
    assert.deepEqual(query?.orderBy, [{ column: 'id', direction: 'asc' }], `default order, table ${id}`);
    assert.equal(query?.table, 'document');
  }
  assert.deepEqual(
    relatedQuery(schema('document'), 'application', 'document', { ...list, sort: { column: 'title', descending: true } }, { id: 2 })
      ?.orderBy,
    [{ column: 'title', direction: 'desc' }],
  );
});

test('a link’s related list is refused at load where its child audits its reads, in either kind of App', () => {
  const schema = {
    dialect: 'sqlite',
    tables: [
      {
        id: 'application',
        name: 'application',
        columns: ['id', 'applicant', 'zip'].map((name) => ({ name, type: 'TEXT', primaryKey: name === 'id' })),
      },
      {
        id: 'document',
        name: 'document',
        columns: ['id', 'application_id', 'title', 'body', 'obj', 'digest'].map((name) => ({
          name,
          type: name.endsWith('id') ? 'INTEGER' : 'TEXT',
          nullable: name !== 'id',
          primaryKey: name === 'id',
        })),
      },
    ],
    foreignKeys: [{ from: { table: 'document', columns: ['application_id'] }, to: { table: 'application', columns: ['id'] } }],
  } as unknown as DatabaseSchema;
  const asked =
    /"document" audits its reads \(audit\.reads\), and a link's related list is not audited yet; show it through a command, or drop the audit\./;
  const build = (tenant: boolean, document: Record<string, unknown>, parentAudit = false) =>
    parse({
      ...RAW,
      ...(tenant ? { auth: { ...RAW.auth, rows: 'tenant' } } : {}),
      resources: {
        application: {
          ...RAW.resources.application,
          ...(tenant ? { owner: 'tenant' } : {}),
          ...(parentAudit ? { audit: { reads: true } } : {}),
          links: { x: { show: ['applicant'], confirm: { zip: 'ZIP code' }, related: { document: { show: ['title'], most: 5 } } } },
        },
        document: { ...(tenant ? { owner: 'tenant' } : {}), ...document },
      },
    });
  for (const tenant of [false, true]) {
    const kind = tenant ? 'a tenant App' : 'an App without tenants';
    assert.deepEqual(appLinkProblems(build(tenant, {}), schema), [], kind);
    assert.match(appLinkProblems(build(tenant, { audit: { reads: true } }), schema).join('\n'), asked, kind);
    // The parent record is the link's own and is not judged by this rule.
    assert.deepEqual(appLinkProblems(build(tenant, {}, true), schema), [], `${kind}: the link's own parent may audit its reads`);
  }
  // A file's server-only columns are refused as its bytes are, each in its own words.
  for (const column of ['obj', 'digest']) {
    const raw = {
      ...RAW,
      resources: {
        application: {
          ...RAW.resources.application,
          links: { x: { show: ['applicant'], confirm: { zip: 'ZIP code' }, related: { document: { show: ['title', column], most: 5 } } } },
        },
        document: { file: { name: 'title', content: 'body', object: 'obj', hash: 'digest', storage: 'bucket', bucket: { name: 'files' } } },
      },
    };
    const problems = appLinkProblems(parse(raw), schema);
    assert.match(
      problems[0] ?? '',
      new RegExp(`"show" names "${column}", the file's ${column === 'obj' ? 'object' : 'hash'} column, which only the server reads`),
      column,
    );
  }
});

test('a link that names a machine verb moves a record along it, and the machine refuses it from any other state', () =>
  fixture(
    async ({ mint, land, post, sql }) => {
      const status = (id: number) => (sql.prepare('SELECT status FROM application WHERE id = ?').get(id) as { status: string }).status;
      const run = async (id: number, key: string) => {
        const { url } = await mint('quote', id);
        const { id: link, session } = await land(url);
        const headers = { 'x-mistri-link': session };
        const prepared = await post(`/l/${link}/prepare`, {}, headers);
        assert.equal(prepared.status, 200, prepared.text);
        return post(
          `/l/${link}/run`,
          { command: 'accept', expectedVersion: prepared.body.commands.accept?.expectedVersion, idempotencyKey: key, input: {} },
          headers,
        );
      };
      // sent -> accepted, on the link door, as the link's principal: no role holds the command.
      const sent = await run(1, 'accept-sent-000001');
      assert.equal(sent.status, 200, sent.text);
      assert.equal(status(1), 'accepted');
      const actor = sql.prepare(`SELECT actor_id FROM ${COMMAND_JOURNAL_TABLES.receipt} WHERE command_id = 'accept'`).get() as {
        actor_id: string;
      };
      assert.match(actor.actor_id, /^link:/);
      // draft: the machine's own refusal, as a person would hear it.
      const draft = await run(2, 'accept-draft-00001');
      assert.equal(draft.status, 409, draft.text);
      assert.equal(draft.body.code, 'ineligible_state', 'the answer a person running the verb would hear');
      assert.equal(status(2), 'draft');
    },
    { quote: true },
  ));
