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
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournalSchema.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import type { EmailMessage, EmailTransport } from '../packages/mistri/src/server/email/email.js';
import { configureFormKey } from '../packages/mistri/src/server/forms/formKey.js';
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
import { LINK_MISS } from '../packages/mistri/src/server/links/linkPage.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { appLinkProblems } from '../packages/mistri/src/shared/appLinks.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { redactLinkTokens } from '../packages/engine/src/server/http/refusalReport.js';
import { Masker } from '../packages/mistri/src/server/observe/mask.js';
import { createApp } from './support/createApp.js';
import { catalogOf } from './support/commandCatalog.js';

const SCHEMA = `CREATE TABLE application (id INTEGER PRIMARY KEY, applicant TEXT NOT NULL, status TEXT NOT NULL, zip TEXT, email TEXT, note TEXT);
  INSERT INTO application VALUES (1, 'Ada', 'submitted', '94110', 'ada@example.test', 'private note'),
                                 (2, 'Bea', 'submitted', '10001', 'bea@example.test', 'another note');`;

const KEY = 'k'.repeat(40);

const CONTRACTS = {
  invite: { target: 'application', input: { link: { type: 'text' } } },
  withdraw: { target: 'application', input: { reason: { type: 'text', optional: true } } },
  approve: { target: 'application' },
  revoke: { target: 'application' },
  discard: { target: 'application' },
  apply: { public: true, input: { applicant: { type: 'text', max: 80 } } },
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
        brief: { show: ['applicant'], expires: '1 hour' },
      },
    },
  },
  auth: { providers: ['email'], roles: { clerk: { read: true, commands: ['invite', 'revoke', 'approve', 'discard'] } } },
  views: {
    applications: { kind: 'list', from: 'application' },
    apply: { kind: 'form', label: 'Apply', public: true, done: { title: 'Thanks' }, command: 'apply' },
  },
  home: 'applications',
  nav: ['applications'],
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
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-links-'));
  const file = join(directory, 'intake.db');
  const setup = new DatabaseSync(file);
  setup.exec(SCHEMA);
  setup.close();
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'intake-db', name: 'Intake', url: file, writable: true, source: 'config' });
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
        return { link: (await link((input as { link: string }).link)) as unknown as string };
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
        return { reference: `A-${made.key.id}`, link: (await link(applicant === 'undeclared' ? 'nope' : 'status')) as unknown as string };
      },
    }),
  });
  const app = parse();
  const clerk: Identity = { id: 'account-clerk', who: 'clerk@example.test', role: 'clerk' };
  const host: AppHost = {
    app: { app, path: '/private/intake/app.ts', pages: [], sources: {} },
    pages: [],
    auth: { spec: app.auth!, store: '/private/intake/auth.db', close() {}, handler: async () => {}, session: async () => clerk },
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
    });
  } finally {
    sql.close();
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
  const ref = new LinkRef('C'.repeat(22));
  assert.equal(JSON.stringify({ link: ref }), `{"link":"mistri-link:${'C'.repeat(22)}"}`);
  assert.equal(String(ref), `mistri-link:${'C'.repeat(22)}`);
  assert.equal(
    await renderLinkRefs(`Open ${ref} or ${ref}`, async (id) => `https://x.test/l/${id}`),
    `Open https://x.test/l/${'C'.repeat(22)} or https://x.test/l/${'C'.repeat(22)}`,
  );
  assert.equal(await renderLinkRefs(`Open ${ref}`, async () => undefined), undefined);
  assert.equal(await renderLinkRefs('nothing here', async () => undefined), 'nothing here');
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
  const schema = {
    dialect: 'sqlite',
    tables: [
      {
        id: 'application',
        name: 'application',
        columns: ['id', 'applicant', 'status', 'zip', 'email', 'note'].map((name) => ({
          name,
          type: 'TEXT',
          nullable: true,
          primaryKey: name === 'id',
        })),
      },
    ],
  } as unknown as DatabaseSchema;
  assert.deepEqual(appLinkProblems(parse(), schema), []);
  assert.match(appLinkProblems(parse(withLink({ show: ['missing'] })), schema)[0], /"missing", which is not a column/);
  const hidden = parse({
    ...RAW,
    resources: { application: { ...RAW.resources.application, hidden: ['note'], links: { x: { show: ['note'] } } } },
  });
  assert.match(appLinkProblems(hidden, schema)[0], /the resource hides; a link adds no read/);
  const keyedL = parse({ ...RAW, views: { ...RAW.views, l: { kind: 'list', from: 'application' } } });
  assert.match(appLinkProblems(keyedL, schema)[0], /no view can be keyed "l"/);
});

test('a link is minted by its command, said once as a URL, and opens its one record behind a Lax cookie', () =>
  fixture(async ({ mint, land, get, post, sql, origin }) => {
    const { url } = await mint('status');
    // The receipt keeps the reference; the secret is nowhere in the journal.
    const receipts = JSON.stringify(sql.prepare(`SELECT * FROM ${COMMAND_JOURNAL_TABLES.receipt}`).all());
    assert.match(receipts, /mistri-link:[A-Za-z0-9_-]{22}/);
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
    assert.doesNotMatch(page.text, /Ada|Bea|ada@example\.test/);

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
    assert.doesNotMatch(page.text, /Ada/);
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

test('a step-up mails a code to the record’s address, and the code opens the record once', () =>
  fixture(async ({ mint, land, get, post, mail }) => {
    const { url } = await mint('stepped');
    const { id, page, session } = await land(url);
    assert.match(page.text, /data-gate="send"/);
    assert.doesNotMatch(page.text, /Ada|ada@example/);
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
