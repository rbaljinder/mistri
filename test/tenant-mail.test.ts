/**
 * A tenant App's email, in and out, through a real enrollment on SQLite and,
 * when `TABLEWALK_TEST_PG` names a disposable server, PostgreSQL: the mail
 * webhook behind a node server, the send loop through a fake relay
 * (test/support/smtpRelay.ts), and the signed links it puts in a message.
 * The control connection reads what the database holds.
 *
 * 1. The webhook: a bad signature is 401, the same signed delivery twice is
 *    409, an address that is no active tenant's is 404, a message past the
 *    service's size is 413, noise (an auto-reply) is dropped and logged and
 *    never reaches the App, an attachment is checked by the App's file rule.
 * 2. A reply threads onto its ticket by In-Reply-To; the same Message-ID
 *    again writes nothing twice; one tenant's reply naming another tenant's
 *    message threads onto nothing of the other's.
 * 3. The send loop: the App's Message-ID, In-Reply-To and References are
 *    what goes out, DKIM verifies, a tenant's own domain sends as itself
 *    and any other From goes out as the service's; a refused recipient is
 *    recorded bounced (5xx) or failed (4xx).
 * 4. A signed link opens the App's view of its record; expired, revoked and
 *    another tenant's open nothing.
 * 5. What the declaration refuses.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { auditRows } from './support/commandTargets.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { openMailStore } from '../packages/mistri/src/adapters/mail/mailStore.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { generateDkimKey, dkimKey, dkimRecord } from '../packages/mistri/src/server/email/dkim.js';
import { emailConnectionOf } from '../packages/mistri/src/server/email/email.js';
import { issueMailLink, mailLinkKey } from '../packages/mistri/src/server/email/mailLinks.js';
import { capturedJobModule, defineJobs, JobDeclarationError, type JobModule } from '../packages/mistri/src/server/jobs/jobModule.js';
import { provisionStores, revokeTenantMailLinks } from '../packages/mistri/src/server/maintenance.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { assertTenantJobs, tenantJobDeployment, tenantMailRuntime } from '../packages/mistri/src/server/tenant/tenantJobs.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { readSqliteScopeCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { defaultMailInput, MAIL_INBOUND_PATH, openTenantMail, type TenantMail } from '../packages/mistri/src/server/tenant/tenantMail.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  type TenantStoreAdministration,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { liveSkip } from './live.js';
import { parseTestApp } from './support/commandCatalog.js';
import { verifyDkim } from './support/dkimVerify.js';
import { smtpRelay } from './support/smtpRelay.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';
import { postgresRuntimeSql } from './support/runtimeSql.js';

type Row = Record<string, unknown>;
type Dialect = 'sqlite' | 'postgres';
const LIVE = process.env.TABLEWALK_TEST_PG;
const binding = { appId: 'tenant-mail', source: { id: 'business', connection: 'mail-business' }, storeId: 'tenant-mail-store' };
const HOUR = 3_600_000;
const SECRET = 'inbound-secret-for-tests';
const LINK_SECRET = 'link-secret-for-tests';
process.env.TW_TEST_MAIL_INBOUND = SECRET;
process.env.TW_TEST_MAIL_LINKS = LINK_SECRET;

/* ---------- the App: a help desk's mailbox, tickets, messages and attachments ---------- */

const app = parseTestApp(
  {
    id: binding.appId,
    name: 'Tenant mail',
    sources: { business: { connection: binding.source.connection } },
    resources: {
      desk: { owner: 'platform' },
      mailbox: { owner: 'tenant' },
      ticket: { access: 'write', owner: 'tenant' },
      message: { access: 'write', owner: 'tenant' },
      attachment: {
        access: 'write',
        owner: 'tenant',
        file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', maxBytes: 1024 },
      },
    },
    auth: {
      rows: 'tenant',
      tenancy: { label: 'Desk', profile: 'desk', platform: { label: 'Operator' } },
      roles: {
        agent: { realm: 'tenant', read: true, commands: [] },
        intake: { realm: 'tenant', read: true, commands: ['receiveEmail'] },
        sender: { realm: 'tenant', read: true, commands: ['claimMail', 'recordMail'] },
        reader: { realm: 'tenant', read: true, commands: ['viewTicket', 'replyTicket'] },
        operator: { realm: 'platform', read: true, commands: [] },
      },
    },
    views: { tickets: { kind: 'list', from: 'ticket' } },
    home: 'tickets',
  },
  'tenant-mail.ts',
);

const tenantRows = { mailbox: true, ticket: true, message: true, attachment: true };
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId: binding.appId,
  storeId: binding.storeId,
  ownership: {
    desk: { kind: 'platform' },
    mailbox: { kind: 'tenant', column: 'tenant_id' },
    ticket: { kind: 'tenant', column: 'tenant_id' },
    message: { kind: 'tenant', column: 'tenant_id' },
    attachment: { kind: 'tenant', column: 'tenant_id' },
  },
  resolveMembershipRows: () => tenantRows,
  resolveRows: () => tenantRows,
  resolvePlatformRows: () => ({ desk: true, ...tenantRows }),
  resultReferences: { receiveEmail: () => [], claimMail: () => [], recordMail: () => [], viewTicket: () => [], replyTicket: () => [] },
});

const output = { parse: (value: unknown) => value as Record<string, unknown> };
let made = 0;
const id = (prefix: string) => `${prefix}-${process.pid}-${++made}`;
const optional = { type: 'text', optional: true } as const;
const commands = defineCommands({
  // A service desk's shape, and the routed mailbox and attachments beside it.
  receiveEmail: defineCommand({
    source: 'business',
    target: 'message',
    targets: 'none',
    write: ['ticket', 'message', 'attachment'],
    read: ['mailbox'],
    input: {
      mailbox: { type: 'text' },
      from: { type: 'text' },
      subject: { type: 'text' },
      body: { type: 'text' },
      message_id: { type: 'text' },
      in_reply_to: optional,
    },
    output,
    async handle({ db, files }, input) {
      const mailbox = await db.mailbox.find({ name: String(input.mailbox) });
      if (!mailbox) throw new Error('no such mailbox');
      // Threaded by In-Reply-To: a message of this tenant's, and only this tenant's, that the reply answers.
      const answered = input.in_reply_to ? await db.message.find({ message_id: String(input.in_reply_to) }) : undefined;
      let ticket = answered ? String(answered.ticket_id) : undefined;
      if (!ticket) {
        ticket = id('t');
        await db.ticket.insert({ id: ticket, subject: String(input.subject), requester: String(input.from), status: 'new' });
      }
      const message = id('m');
      await db.message.insert({
        id: message,
        ticket_id: ticket,
        direction: 'in',
        message_id: String(input.message_id),
        from_addr: String(input.from),
        to_addr: String(mailbox.address),
        subject: String(input.subject),
        body: String(input.body),
        status: 'received',
      });
      // The bytes go in through the file rule: its name, type and size columns are filled from the part.
      for (const file of files ?? []) await db.attachment.insertFile(file, { id: id('a'), message_id: message });
      return { ticket };
    },
  }),
  // Every queued outbound message, marked sending, as the platform sends it.
  claimMail: defineCommand({
    source: 'business',
    target: 'message',
    targets: 'none',
    read: ['mailbox', 'ticket'],
    input: {},
    output,
    async handle({ db }) {
      const messages = [];
      for (const row of await db.message.where({ direction: 'out', status: 'queued' })) {
        await db.message.update(row, { status: 'sending' });
        const mailbox = await db.mailbox.find({ address: String(row.from_addr) });
        messages.push({
          id: String(row.id),
          from: mailbox ? `${mailbox.from_name} <${mailbox.address}>` : String(row.from_addr),
          to: String(row.to_addr),
          subject: String(row.subject),
          text: `${row.body}\n\nSee it: {link}`,
          messageId: String(row.message_id),
          ...(row.in_reply_to ? { inReplyTo: String(row.in_reply_to) } : {}),
          ...(row.refs ? { references: String(row.refs) } : {}),
          link: { id: String(row.ticket_id) },
        });
      }
      return { messages };
    },
  }),
  recordMail: defineCommand({
    source: 'business',
    target: 'message',
    targets: 'none',
    input: { id: { type: 'text' }, status: { type: 'text' }, messageId: optional, error: optional },
    output,
    async handle({ db }, input) {
      const row = await db.message.find({ id: String(input.id) });
      if (row) await db.message.update(row, { status: String(input.status), error: input.error ? String(input.error) : null });
      return {};
    },
  }),
  // What a requester's link shows: the ticket's subject and status, nothing else.
  viewTicket: defineCommand({
    source: 'business',
    target: 'ticket',
    input: {},
    output,
    async handle({ record }) {
      return { subject: String(record.subject), status: String(record.status) };
    },
  }),
  // The link page's reply box: the requester's words, onto the ticket the link opened.
  replyTicket: defineCommand({
    source: 'business',
    target: 'ticket',
    read: ['ticket'],
    write: ['message'],
    input: { body: { type: 'textarea' } },
    output,
    async handle({ db, record }, input) {
      await db.message.insert({
        id: id('m'),
        ticket_id: String(record.id),
        direction: 'in',
        message_id: `<${id('reply')}@link>`,
        from_addr: String(record.requester),
        to_addr: 'desk',
        subject: `Re: ${String(record.subject)}`,
        body: String(input.body),
        status: 'received',
      });
      return {};
    },
  }),
});

const principals = {
  'mail-intake': { roles: ['intake'] },
  'mail-sender': { roles: ['sender'] },
  'requester-links': { roles: ['reader'] },
};
const mailModule = defineJobs(
  {},
  {
    principals,
    mail: {
      receive: {
        runAs: 'mail-intake',
        command: 'receiveEmail',
        attachments: 'attachment',
        input: (mail) => ({
          mailbox: mail.mailbox,
          from: mail.from.address,
          subject: mail.subject,
          body: mail.text,
          message_id: mail.messageId,
          ...(mail.inReplyTo ? { in_reply_to: mail.inReplyTo } : {}),
        }),
      },
      send: { runAs: 'mail-sender', claim: 'claimMail', record: 'recordMail', every: '1 minute' },
      links: { runAs: 'requester-links', command: 'viewTicket', reply: 'replyTicket' },
    },
  },
);

/* ---------- the engines ---------- */

const SCHEMA = {
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON;
    CREATE TABLE desk (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE mailbox (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES desk(id), name TEXT NOT NULL,
      address TEXT NOT NULL, from_name TEXT NOT NULL);
    CREATE TABLE ticket (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES desk(id), subject TEXT NOT NULL,
      requester TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES desk(id), ticket_id TEXT NOT NULL,
      direction TEXT NOT NULL, message_id TEXT NOT NULL, in_reply_to TEXT, refs TEXT, from_addr TEXT NOT NULL, to_addr TEXT NOT NULL,
      subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, error TEXT);
    CREATE TABLE attachment (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES desk(id), message_id TEXT NOT NULL,
      file_name TEXT NOT NULL, content_type TEXT NOT NULL, byte_size INTEGER NOT NULL, data BLOB);`,
  postgres: `
    CREATE TABLE public.desk (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.mailbox (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.desk(id), name text NOT NULL,
      address text NOT NULL, from_name text NOT NULL);
    CREATE TABLE public.ticket (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.desk(id), subject text NOT NULL,
      requester text NOT NULL, status text NOT NULL);
    CREATE TABLE public.message (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.desk(id), ticket_id text NOT NULL,
      direction text NOT NULL, message_id text NOT NULL, in_reply_to text, refs text, from_addr text NOT NULL, to_addr text NOT NULL,
      subject text NOT NULL, body text NOT NULL, status text NOT NULL, error text);
    CREATE TABLE public.attachment (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.desk(id), message_id text NOT NULL,
      file_name text NOT NULL, content_type text NOT NULL, byte_size integer NOT NULL, data bytea);`,
};
// Each tenant's mailbox is "help"; Acme sends from its own domain, Globex from one the service does not give it.
const ROWS = `
    INSERT INTO desk VALUES ('acme', 'Acme'), ('globex', 'Globex');
    INSERT INTO mailbox VALUES ('mb-acme', 'acme', 'help', 'help@acme.example', 'Acme Help'),
      ('mb-globex', 'globex', 'help', 'help@globex.example', 'Globex Support');
    INSERT INTO ticket VALUES ('t-acme-1', 'acme', 'Printer on fire', 'ann@example.org', 'open'),
      ('t-globex-1', 'globex', 'Invoice', 'bob@example.org', 'open');
    INSERT INTO message (id, tenant_id, ticket_id, direction, message_id, in_reply_to, refs, from_addr, to_addr, subject, body, status) VALUES
      ('m-acme-1', 'acme', 't-acme-1', 'in', '<CAF1@mail.example.org>', NULL, NULL, 'ann@example.org', 'help@acme.example',
        'Printer on fire', 'It is on fire.', 'received'),
      ('m-acme-2', 'acme', 't-acme-1', 'out', '<reply.1@acme.example>', '<CAF1@mail.example.org>', '<CAF1@mail.example.org>',
        'help@acme.example', 'ann@example.org', 'Re: Printer on fire', 'We are on it.', 'queued'),
      ('m-globex-1', 'globex', 't-globex-1', 'out', '<note.1@globex.example>', NULL, NULL,
        'help@globex.example', 'bob@example.org', 'Your invoice', 'Here it is.', 'queued');`;

interface Lab {
  readonly target: Readonly<{ sqlite: string }> | Readonly<{ postgres: string }>;
  readonly source: Readonly<{ id: string; connection: string; existingPath?: string; url?: string }>;
  readonly directory: string;
  rows(sql: string): Promise<Row[]>;
  admin(run: (admin: TenantStoreAdministration) => Promise<void>): Promise<void>;
  provision(module: JobModule): Promise<unknown>;
}

async function sqliteLab(t: TestContext, directory: string): Promise<Lab> {
  const path = join(directory, 'business.db'),
    db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec(SCHEMA.sqlite + ROWS);
  provisionSqliteTenantStore(path, binding);
  migrateSqliteCommandJournal(path);
  return {
    target: { sqlite: path },
    source: { ...binding.source, existingPath: path },
    directory,
    rows: async (sql) =>
      db
        .prepare(sql)
        .all()
        .map((row) => ({ ...row })),
    async admin(run) {
      const operations = new TransactionOperations();
      db.exec('BEGIN IMMEDIATE');
      try {
        await run(createSqliteTenantAdministration(db, operations, binding));
        await operations.finish();
        db.exec('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },
    provision: async (module) => provisionStores({ sqlite: path }, { app: { tenant: binding, commands }, jobs: module }),
  };
}

async function postgresLab(t: TestContext, directory: string): Promise<Lab> {
  const { url, drop } = await uuidPostgresDatabase('tw_tenant_mail');
  const control = await pgClient(url);
  t.after(async () => {
    await control.end().catch(() => {});
    await drop();
  });
  await control.query(SCHEMA.postgres + ROWS);
  await migratePostgresTenantStore(url, binding);
  await migratePostgresCommandJournal(url);
  return {
    target: { postgres: url },
    source: { ...binding.source, url },
    directory,
    rows: async (sql) => (await control.query(postgresRuntimeSql(sql))).rows.map((row) => ({ ...row })),
    async admin(run) {
      await control.query('BEGIN');
      const operations = new TransactionOperations();
      try {
        await run(createPostgresTenantAdministration(control, operations, binding));
        await operations.finish();
        await control.query('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        await control.query('ROLLBACK');
        throw error;
      }
    },
    provision: (module) => provisionStores({ postgres: url }, { app: { tenant: binding, commands }, jobs: module }),
  };
}

async function openLab(t: TestContext, dialect: Dialect): Promise<Lab> {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-mail-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lab = await (dialect === 'sqlite' ? sqliteLab(t, directory) : postgresLab(t, directory));
  await lab.provision(mailModule);
  await lab.admin(async (admin) => {
    for (const tenantId of ['acme', 'globex']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
  });
  writeFileSync(join(directory, 'dkim.pem'), DKIM_PEM, { mode: 0o600 });
  return lab;
}

const DKIM_PEM = generateDkimKey();

interface Desk {
  mail: TenantMail;
  clock: { now: number };
  post(body: unknown, headers?: Record<string, string>): Promise<number>;
  signed(body: unknown, at?: number): { text: string; headers: Record<string, string> };
  send(text: string, headers: Record<string, string>): Promise<number>;
  link(token: string): Promise<{ status: number; body: Record<string, unknown> }>;
  page(token: string, reply?: string): Promise<{ status: number; headers: Headers; html: string }>;
}

/** The lab enrolled, its mail opened over a relay, and a server answering the mail routes. */
async function openDesk(t: TestContext, lab: Lab, relayPort: number): Promise<Desk> {
  const enrollment = await createTenantEnrollment<{ account: string }>({
    app,
    policy,
    source: lab.source,
    deployment: 'generation-1',
    roles: ['agent', 'intake', 'sender', 'reader', 'operator'],
    maxLifetimeMs: 60_000,
    verifySession: (request) => ({ id: request.account, who: request.account }),
    commands: { registry: commands },
    jobs: { module: mailModule },
  });
  t.after(() => enrollment.retire());
  const runtime = tenantMailRuntime(enrollment);
  assert.ok(runtime, 'an enrollment whose jobs declare mail has a mail runtime');
  const service = emailConnectionOf(
    {
      name: 'mail',
      kind: 'email',
      url: `smtp://127.0.0.1:${relayPort}`,
      insecure: true,
      from: 'Help Desk <desk@tw.example>',
      inbound: { secret: '${TW_TEST_MAIL_INBOUND}', domain: 'in.tw.example', maxBytes: 4096 },
      links: { secret: '${TW_TEST_MAIL_LINKS}', ttl: '1 day' },
      dkim: { selector: 'tw1', key: 'dkim.pem' },
      domains: { 'acme.example': 'acme' },
      returnPath: 'bounce.tw.example',
    },
    'test',
    lab.directory,
  );
  const clock = { now: Date.now() };
  const mail = await openTenantMail({ runtime, service, baseURL: 'https://desk.example.com/', now: () => clock.now, warn: () => {} });
  t.after(() => mail.stop());
  const server: Server = createServer((req, res) => {
    void mail.handle(req, res, new URL(req.url!, 'http://desk.example.com')).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const signed = (body: unknown, at = Math.floor(clock.now / 1000)) => {
    const text = JSON.stringify(body);
    const signature = createHmac('sha256', SECRET).update(`${at}.${text}`).digest('hex');
    return {
      text,
      headers: { 'content-type': 'application/json', 'x-mistri-timestamp': String(at), 'x-mistri-signature': `v1=${signature}` },
    };
  };
  const send = async (text: string, headers: Record<string, string>) =>
    (await fetch(`${base}${MAIL_INBOUND_PATH}`, { method: 'POST', headers, body: text, signal: AbortSignal.timeout(10_000) })).status;
  return {
    mail,
    clock,
    signed,
    send,
    async post(body, headers = {}) {
      const delivery = signed(body);
      return send(delivery.text, { ...delivery.headers, ...headers });
    },
    async link(token) {
      const response = await fetch(`${base}/api/mail/link?token=${encodeURIComponent(token)}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    async page(token, reply) {
      const response = await fetch(`${base}/api/mail/link?token=${encodeURIComponent(token)}`, {
        redirect: 'manual',
        ...(reply === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ body: reply }).toString(),
            }),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, headers: response.headers, html: await response.text() };
    },
  };
}

const delivery = (fields: Record<string, unknown> = {}) => ({
  recipient: 'help+acme@in.tw.example',
  from: 'Ann Lee <ann@example.org>',
  to: ['Acme Help <help@acme.example>'],
  subject: 'Re: Printer on fire',
  messageId: `<${Math.random().toString(36).slice(2)}@mail.example.org>`,
  text: 'Still smoking.\n\nOn Mon, 5 Oct 2026, Acme Help <help@acme.example> wrote:\n> We are on it.',
  ...fields,
});

const ENGINES: ReadonlyArray<{ dialect: Dialect; skip: false | string }> = [
  { dialect: 'sqlite', skip: false },
  { dialect: 'postgres', skip: liveSkip('postgres', LIVE) },
];

for (const { dialect, skip } of ENGINES)
  describe(`tenant mail on ${dialect}`, { skip }, () => {
    test('the webhook: unsigned 401, replayed 409, no tenant 404, too large 413, noise dropped and logged', async (t) => {
      const lab = await openLab(t, dialect);
      const relay = await smtpRelay();
      t.after(() => relay.close());
      const desk = await openDesk(t, lab, relay.port);
      const before = await lab.rows('SELECT count(*) AS n FROM message');

      // A wrong secret, a stale timestamp, no signature: 401, and nothing read.
      const forged = desk.signed(delivery());
      assert.equal(await desk.send(forged.text.replace('Still', 'Stil'), forged.headers), 401);
      const stale = desk.signed(delivery(), Math.floor(desk.clock.now / 1000) - 600);
      assert.equal(await desk.send(stale.text, stale.headers), 401);
      assert.equal(await desk.send(forged.text, { 'content-type': 'application/json' }), 401);

      // The same signed delivery twice: the second is a replay.
      const once = desk.signed(delivery({ recipient: 'help+nobody@in.tw.example' }));
      assert.equal(await desk.send(once.text, once.headers), 404, 'no active tenant by that id');
      assert.equal(await desk.send(once.text, once.headers), 409);
      assert.equal(await desk.post(delivery({ recipient: 'help@elsewhere.example' })), 404);
      assert.equal(await desk.post(delivery({ text: 'x'.repeat(5000) })), 413);
      // An attachment past the App's file rule (1024 bytes), under the service's (4096): the file rule's 413.
      assert.equal(await desk.post(delivery({ attachments: [{ name: 'big.bin', content: Buffer.alloc(2000).toString('base64') }] })), 413);

      // An auto-reply, a list and our own mail come back: dropped, logged, never the App's.
      assert.equal(await desk.post(delivery(), {}), 204);
      const loud = delivery({ headers: { 'Auto-Submitted': 'auto-replied' } });
      assert.equal(await desk.post(loud), 202);
      assert.equal(await desk.post(delivery({ headers: { Precedence: 'list' } })), 202);
      assert.equal(await desk.post(delivery({ from: 'desk@tw.example' })), 202);
      const after = await lab.rows('SELECT count(*) AS n FROM message');
      assert.equal(Number(after[0].n), Number(before[0].n) + 1, 'only the one real message reached the App');
      const log = await lab.rows(`SELECT tenant_id, recipient, outcome, reason FROM "__mistri_mail_log" ORDER BY id`);
      assert.deepEqual(
        log.map((row) => [row.tenant_id ?? null, row.outcome]),
        [
          ['nobody', 'unrouted'],
          [null, 'unrouted'],
          ['acme', 'refused'],
          ['acme', 'applied'],
          ['acme', 'dropped'],
          ['acme', 'dropped'],
          ['acme', 'dropped'],
        ],
      );
      assert.deepEqual(
        log.filter((row) => row.outcome === 'dropped').map((row) => row.reason),
        ['Auto-Submitted: auto-replied', 'Precedence: list', "from this server's own sending address"],
      );
    });

    test("a reply threads onto its ticket by In-Reply-To, once, and never onto another tenant's", async (t) => {
      const lab = await openLab(t, dialect);
      const relay = await smtpRelay();
      t.after(() => relay.close());
      const desk = await openDesk(t, lab, relay.port);
      const reply = delivery({
        inReplyTo: '<reply.1@acme.example>',
        attachments: [{ name: 'smoke.txt', type: 'text/plain', content: Buffer.from('smoke').toString('base64') }],
      });
      assert.equal(await desk.post(reply), 204);
      // The provider retries the same message, signed afresh: the receipt replays, nothing is written twice.
      desk.clock.now += 1_000;
      assert.equal(await desk.post(reply), 204);
      const threaded = await lab.rows(`SELECT tenant_id, ticket_id, body FROM message WHERE message_id = '${reply.messageId}'`);
      assert.deepEqual(threaded, [{ tenant_id: 'acme', ticket_id: 't-acme-1', body: 'Still smoking.' }], 'the quoted history cut off');
      const files = await lab.rows(`SELECT tenant_id, file_name, content_type, byte_size, data FROM attachment`);
      assert.deepEqual(
        files.map((row) => ({ ...row, byte_size: Number(row.byte_size), data: Buffer.from(row.data as Uint8Array).toString() })),
        [{ tenant_id: 'acme', file_name: 'smoke.txt', content_type: 'text/plain', byte_size: 5, data: 'smoke' }],
      );
      // The audit names the file and its size, never its bytes.
      const audit = JSON.stringify(await lab.rows(`SELECT changes_json FROM ${auditRows(dialect)} a`));
      assert.match(audit, /smoke\.txt/, 'the audit names the file');
      assert.ok(
        !audit.includes(Buffer.from('smoke').toString('base64')) && !/[^.]smoke[^.]/.test(audit.replaceAll('smoke.txt', '')),
        'no content in the audit',
      );

      // Globex's help box gets a reply naming Acme's message: Globex cannot see it, so it is a new Globex ticket.
      const crossed = delivery({ recipient: 'help+globex@in.tw.example', inReplyTo: '<reply.1@acme.example>' });
      assert.equal(await desk.post(crossed), 204);
      const [row] = await lab.rows(`SELECT tenant_id, ticket_id FROM message WHERE message_id = '${crossed.messageId}'`);
      assert.equal(row.tenant_id, 'globex');
      assert.notEqual(row.ticket_id, 't-acme-1');
      const [ticket] = await lab.rows(`SELECT tenant_id FROM ticket WHERE id = '${row.ticket_id}'`);
      assert.equal(ticket.tenant_id, 'globex');
      assert.equal(Number((await lab.rows(`SELECT count(*) AS n FROM ticket WHERE tenant_id = 'acme'`))[0].n), 1);
    });

    test("the send loop keeps the App's threading headers, signs with DKIM, and sends only a tenant's own domain as itself", async (t) => {
      const lab = await openLab(t, dialect);
      const relay = await smtpRelay();
      t.after(() => relay.close());
      const desk = await openDesk(t, lab, relay.port);
      assert.deepEqual(await desk.mail.sendOnce(), { sent: 2, failed: 0 });
      assert.deepEqual(await desk.mail.sendOnce(), { sent: 0, failed: 0 }, 'nothing is sent twice');
      const statuses = await lab.rows(`SELECT id, status FROM message WHERE direction = 'out' ORDER BY id`);
      assert.deepEqual(statuses, [
        { id: 'm-acme-2', status: 'sent' },
        { id: 'm-globex-1', status: 'sent' },
      ]);
      const record = dkimRecord(dkimKey('tw1', DKIM_PEM));
      const byTo = Object.fromEntries(relay.messages.map((message) => [message.to[0], message]));

      const acme = byTo['ann@example.org'];
      assert.equal(acme.from, 'bounce+acme@bounce.tw.example');
      assert.match(acme.raw, /^From: "?Acme Help"? <help@acme\.example>\r$/m);
      assert.match(acme.raw, /^Message-ID: <reply\.1@acme\.example>\r$/m);
      assert.match(acme.raw, /^In-Reply-To: <CAF1@mail\.example\.org>\r$/m);
      assert.match(acme.raw, /^References: <CAF1@mail\.example\.org>\r$/m);
      assert.match(acme.raw, /^Auto-Submitted: auto-generated\r$/m);
      const acmeDkim = verifyDkim(acme.raw, record);
      assert.ok(acmeDkim.ok, 'DKIM verifies');
      assert.equal(acmeDkim.tags.d, 'acme.example');

      // Globex's From is not a domain the service gives it: sent From the service, Reply-To Globex.
      const globex = byTo['bob@example.org'];
      assert.match(globex.raw, /^From: "?Globex Support"? <desk@tw\.example>\r$/m);
      assert.match(globex.raw, /^Reply-To: help@globex\.example\r$/m);
      assert.match(globex.raw, /^Message-ID: <note\.1@globex\.example>\r$/m);
      const globexDkim = verifyDkim(globex.raw, record);
      assert.ok(globexDkim.ok);
      assert.equal(globexDkim.tags.d, 'tw.example');
    });

    for (const [reply, recorded] of [
      ['550 5.1.1 no such user', 'bounced'],
      ['451 4.3.0 try later', 'failed'],
    ] as const)
      test(`a relay that answers ${reply.slice(0, 3)} is recorded ${recorded}`, async (t) => {
        const lab = await openLab(t, dialect);
        const relay = await smtpRelay({ rcpt: reply });
        t.after(() => relay.close());
        const desk = await openDesk(t, lab, relay.port);
        assert.deepEqual(await desk.mail.sendOnce(), { sent: 0, failed: 2 });
        const rows = await lab.rows(`SELECT status, error FROM message WHERE direction = 'out' ORDER BY id`);
        assert.deepEqual(
          rows.map((row) => row.status),
          [recorded, recorded],
        );
        assert.ok(rows.every((row) => String(row.error).length > 0));
      });

    test("a signed link opens the App's view of its record; expired, revoked and another tenant's open nothing", async (t) => {
      const lab = await openLab(t, dialect);
      const relay = await smtpRelay();
      t.after(() => relay.close());
      const desk = await openDesk(t, lab, relay.port);
      await desk.mail.sendOnce();
      const tokens = relay.messages.map((message) => {
        const text = Buffer.from(message.raw.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\s+/g, ''), 'base64').toString('utf8');
        const found = /https:\/\/desk\.example\.com\/api\/mail\/link\?token=([A-Za-z0-9_.-]+)/.exec(text);
        assert.ok(found, 'the link is where the words said {link}');
        return [message.to[0], found[1]] as const;
      });
      const acme = tokens.find(([to]) => to === 'ann@example.org')![1];
      const globex = tokens.find(([to]) => to === 'bob@example.org')![1];
      assert.deepEqual(await desk.link(acme), {
        status: 200,
        body: { resource: 'ticket', key: { id: 't-acme-1' }, view: { subject: 'Printer on fire', status: 'open' }, reply: true },
      });
      // A person gets a page: the record as the command answered it, no script, nothing from elsewhere, no Referer.
      const page = await desk.page(acme);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type')!, /^text\/html/);
      assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
      assert.match(page.headers.get('content-security-policy')!, /default-src 'none'; style-src 'nonce-[^']+'; form-action 'self'/);
      assert.match(page.html, /<h1>Printer on fire<\/h1>/);
      assert.match(page.html, /<dt>Status<\/dt><dd>open<\/dd>/);
      assert.match(page.html, /<form method="post">/);
      assert.doesNotMatch(page.html, /<script|<link |https?:\/\//, 'nothing loads, nothing names another origin');
      // The reply box runs the link's reply command on its record, then sends the person back to the page (post, then get).
      const replied = await desk.page(acme, 'Still smoking, please hurry.');
      assert.equal(replied.status, 303, replied.html);
      assert.match(replied.headers.get('location')!, /^link\?token=[^&]+&sent=1$/);
      const [reply] = await lab.rows(`SELECT tenant_id, ticket_id, body FROM message WHERE body = 'Still smoking, please hurry.'`);
      assert.deepEqual({ ...reply }, { tenant_id: 'acme', ticket_id: 't-acme-1', body: 'Still smoking, please hurry.' });
      const empty = await desk.page(acme, '   ');
      assert.equal(empty.status, 422);
      assert.match(empty.html, /Write a reply first\./);

      // Another tenant's record under a genuinely signed token: Globex's service cannot see Acme's ticket.
      const store = await openMailStore(lab.target);
      const crossed = issueMailLink(LINK_SECRET, {
        tenant: 'globex',
        resource: 'ticket',
        key: { id: 't-acme-1' },
        expires: desk.clock.now + HOUR,
      });
      await store.issueLink({
        nonce: crossed.claim.nonce,
        tenantId: 'globex',
        resource: 'ticket',
        keyJson: mailLinkKey(crossed.claim.key),
        createdAt: desk.clock.now,
        expiresAt: crossed.claim.expires,
      });
      await store.close();
      assert.equal((await desk.link(crossed.token)).status, 404);
      // A changed first character of the signature always changes its bytes; the last ones may not.
      const dot = acme.indexOf('.') + 1;
      const forged = `${acme.slice(0, dot)}${acme[dot] === 'A' ? 'B' : 'A'}${acme.slice(dot + 1)}`;
      assert.equal((await desk.link(forged)).status, 404, 'a forged signature');
      // A second spelling of the same bytes is no signature either.
      const last = acme.at(-1)!;
      const respelled = `${acme.slice(0, -1)}${String.fromCharCode(last.charCodeAt(0) ^ 1)}`;
      assert.equal((await desk.link(respelled)).status, 404, 'a respelled signature');

      // Revoked: by its record, and only that record's links.
      assert.equal(await revokeTenantMailLinks(lab.target, { tenant: 'acme', resource: 'ticket', key: { id: 't-acme-1' } }), 1);
      assert.equal((await desk.link(acme)).status, 410);
      assert.equal((await desk.link(globex)).status, 200);
      // Expired: a day on (the service's ttl), the clock says so.
      desk.clock.now += 25 * HOUR;
      assert.equal((await desk.link(globex)).status, 410);
    });
  });

test('mail is declared in one shape and refused for anything else', () => {
  const declare = (mail: unknown) => () => defineJobs({}, { principals, mail } as never);
  assert.throws(declare({}), JobDeclarationError);
  assert.throws(declare({ receive: { runAs: 'mail-intake' } }), /command/);
  assert.throws(declare({ send: { runAs: 'mail-sender', claim: 'claimMail', record: 'recordMail', every: '1 second' } }), /5 seconds/);
  assert.throws(declare({ send: { runAs: 'mail-sender', claim: 'claimMail', record: 'recordMail', every: '0 9 * * *' } }), /duration/);
  assert.throws(declare({ links: { runAs: 'requester-links', command: 'viewTicket', extra: 1 } }), JobDeclarationError);
  assert.throws(declare({ receive: { runAs: 'mail-intake', command: 'receiveEmail', attachments: 'No Such' } }), /file resource/);
  const captured = capturedJobModule(mailModule)!;
  assert.equal(captured.mail?.send?.everyMs, 60_000);
});

test('a tenant App refuses mail whose links command names no record, a receive that names one, or attachments into no file resource', (t) => {
  const owner = { appId: binding.appId, storeId: binding.storeId, source: binding.source };
  const deploy = (mail: unknown) => () =>
    tenantJobDeployment(capturedJobModule(defineJobs({}, { principals, mail } as never)), { binding: owner, commands });
  assert.throws(
    deploy({ links: { runAs: 'requester-links', command: 'claimMail' } }),
    /mail links runs command "claimMail", which names no record/,
  );
  assert.throws(
    deploy({ receive: { runAs: 'mail-intake', command: 'viewTicket' } }),
    /mail receive runs command "viewTicket", which names a record/,
  );
  assert.throws(deploy({ receive: { runAs: 'mail-intake', command: 'nothing' } }), /does not register/);
  assert.ok(tenantJobDeployment(capturedJobModule(mailModule), { binding: owner, commands }));
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(SCHEMA.sqlite.replace('PRAGMA journal_mode=WAL;', ''));
  db.exec('BEGIN IMMEDIATE');
  const schema = readSqliteScopeCatalog(db).schema;
  db.exec('COMMIT');
  const owned = captureTenantOwnership({
    appId: binding.appId,
    source: binding.source,
    schema,
    physicalSchema: structuredClone(schema),
    resources: Object.fromEntries(schema.tables.map((table) => [table.id, table.id])),
    profile: 'desk',
    ownership: policy.ownership,
  });
  const check = (mail: unknown) => () =>
    assertTenantJobs(capturedJobModule(defineJobs({}, { principals, mail } as never)), app, commands, owned, binding.source.connection);
  assert.throws(check({ receive: { runAs: 'mail-intake', command: 'receiveEmail', attachments: 'ticket' } }), /not a file resource/);
  assert.throws(
    check({ receive: { runAs: 'mail-sender', command: 'receiveEmail' } }),
    JobDeclarationError,
    'a principal whose roles do not grant the command is refused at load',
  );
  assertTenantJobs(capturedJobModule(mailModule), app, commands, owned, binding.source.connection);
});

test("without receive.input, a command gets the receive-an-email shape: the tenant's own address as to, the quoted history gone", () => {
  const mail = {
    tenant: 'acme',
    mailbox: 'help',
    recipient: 'help+acme@in.tw.example',
    from: { address: 'ann@example.org', name: 'Ann Lee' },
    to: [{ address: 'help+acme@in.tw.example' }, { address: 'help@acme.example', name: 'Acme Help' }],
    cc: [],
    subject: '',
    messageId: '<a@b>',
    inReplyTo: '<r@acme.example>',
    references: ['<x@y>', '<r@acme.example>'],
    text: 'Thanks.',
    html: '',
    attachments: [],
  };
  assert.deepEqual(defaultMailInput(mail, { domain: 'in.tw.example' }), {
    to: 'help@acme.example',
    from: 'ann@example.org',
    from_name: 'Ann Lee',
    subject: '(no subject)',
    body: 'Thanks.',
    message_id: '<a@b>',
    in_reply_to: '<r@acme.example>',
    references: '<x@y> <r@acme.example>',
  });
  assert.equal(defaultMailInput({ ...mail, recipient: 'help@acme.example', to: [] }, { domain: 'in.tw.example' }).to, 'help@acme.example');
});
