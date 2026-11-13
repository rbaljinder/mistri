/**
 * Capability links in a row-policy App (policy/appPolicyContext.ts withLink): a person the policy lets write a row
 * mints a link on it, and the link is the grant for that one row — its page shows the declared columns, its
 * commands run on that row and no other, and the App's policy, written for people, is never asked about the link.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournalSchema.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { configureFormKey } from '../packages/mistri/src/server/forms/formKey.js';
import { LINK_MISS } from '../packages/mistri/src/server/links/linkPage.js';
import { configureLinkBase, linkTokenId } from '../packages/mistri/src/server/links/linkToken.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { createApp } from './support/createApp.js';
import { parseTestApp } from './support/commandCatalog.js';

const appId = 'claims';
const clerk: Identity = { id: 'account-clerk', who: 'clerk@example.test', role: 'clerk' };
const KEY = 'k'.repeat(40);
const asked = (): string[] => ((globalThis as { __linkPolicyAsked?: string[] }).__linkPolicyAsked ??= []);

async function serve(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-policy-links-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  const registry = new Registry();
  let server: Server | undefined, policy: HttpAppPolicy | undefined;
  const disposers: Array<() => void> = [];
  t.after(async () => {
    try {
      for (const dispose of disposers) dispose();
      if (server) {
        const closed = new Promise<void>((resolve) => server!.close(() => resolve()));
        server.closeAllConnections();
        await closed;
      }
      await policy?.retire();
      await registry.closeAll();
      clearJournal('data');
      resetPublicFormLimits();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`CREATE TABLE claim (id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, claimant TEXT NOT NULL, status TEXT NOT NULL, note TEXT);
    INSERT INTO claim VALUES (1, 'account-clerk', 'Ada', 'open', 'private'), (2, 'account-clerk', 'Bea', 'open', 'private'),
                             (3, 'someone-else', 'Cy', 'open', 'private');
    CREATE TABLE slot (account_id TEXT NOT NULL, number INTEGER NOT NULL, detail TEXT NOT NULL, PRIMARY KEY (account_id, number));
    INSERT INTO slot VALUES ('account-clerk', 1, 'Alpha slot'), ('account-clerk', 2, 'Bravo slot'), ('someone-else', 1, 'Charlie slot');`);
  migrateSqliteCommandJournal(file);
  registry.add({ id: 'data', name: 'Data', url: file, writable: true, source: 'config' });
  const app = parseTestApp(
    {
      id: appId,
      name: 'Claims',
      sources: { main: { connection: 'data', default: true } },
      resources: {
        claim: {
          access: 'write',
          actions: {
            invite: { label: 'Invite', command: { id: 'invite', version: 1, target: 'claim', input: { link: { type: 'text' } } } },
          },
          links: { status: { show: ['claimant', 'status'], commands: ['withdraw'] } },
        },
        /* A row named by two columns: a link on it is the grant for that pair and no other row sharing a part. */
        slot: {
          access: 'write',
          actions: {
            invite: { label: 'Invite', command: { id: 'inviteSlot', version: 1, target: 'slot', input: { link: { type: 'text' } } } },
          },
          links: { status: { show: ['detail'] } },
        },
      },
      auth: {
        rows: 'policy',
        roles: { clerk: { read: ['claim', 'slot'], commands: ['invite', 'inviteSlot'] } },
      },
      views: { claims: { kind: 'list', from: 'claim' } },
      home: 'claims',
      nav: ['claims'],
    },
    'row-policy links fixture',
    { withdraw: { target: 'claim', input: { reason: { type: 'text', optional: true } } } },
  );
  const commands = defineCommands({
    invite: defineCommand({
      source: 'main',
      target: 'claim',
      track: 'receipts',
      input: { link: { type: 'text' } } as never,
      output: shape({ link: text() }),
      async handle({ link }, input) {
        return { link: await link((input as { link: string }).link) };
      },
    }),
    inviteSlot: defineCommand({
      source: 'main',
      target: 'slot',
      track: 'receipts',
      input: { link: { type: 'text' } } as never,
      output: shape({ link: text() }),
      async handle({ link }, input) {
        return { link: await link((input as { link: string }).link) };
      },
    }),
    withdraw: defineCommand({
      source: 'main',
      target: 'claim',
      track: 'receipts',
      input: { reason: { type: 'text', optional: true } } as never,
      async handle({ tx, record }, input) {
        await tx.update({
          table: 'claim',
          key: { id: Number(record.id) },
          values: { status: 'withdrawn', note: (input as { reason?: string }).reason ?? null },
        });
      },
    }),
  });
  const module = join(directory, 'policy.mjs');
  /* The clerk's own claims. Every principal the policy is asked about is noted, so a link that reached it shows. */
  writeFileSync(
    module,
    `export default { appId: ${JSON.stringify(appId)},
    resultReferences: { invite: () => [], inviteSlot: () => [], withdraw: () => [] },
    resolveRows(principal) {
      (globalThis.__linkPolicyAsked ??= []).push(principal.id);
      const own = { groups: [[{ column: 'account_id', op: '=', value: principal.id }]] };
      return { claim: own, slot: own };
    } };`,
  );
  disposers.push(configureFormKey(appId, { MISTRI_FORM_KEY: KEY }));
  policy = await loadHttpAppPolicy({ app, registry, commands, file: module, verifySession: async () => clerk });
  const host: AppHost = {
    app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
    pages: [],
    auth: { spec: app.auth!, store: join(directory, 'auth.db'), close() {}, handler: async () => {}, session: async () => clerk },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  server = createApp({ registry, bound, apps: [host], policy });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  const origin = `http://${bound.host}:${bound.port}`;
  disposers.push(configureLinkBase(appId, origin));
  resetPublicFormLimits();
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${origin}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(10_000), ...init });
    const body = await response.text();
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    return { status: response.status, headers: response.headers, text: body, body: parsed };
  };
  let keys = 0;
  const signedIn = { 'content-type': 'application/json', 'x-mistri-account': clerk.id, origin };
  const mint = async (id: number, command = 'invite', key: object = { id }) => {
    const prepared = await call('/api/commands/prepare', {
      method: 'POST',
      headers: signedIn,
      body: JSON.stringify({ command, commandVersion: 1, key }),
    });
    assert.equal(prepared.status, 200, prepared.text);
    const minted = await call('/api/commands/execute', {
      method: 'POST',
      headers: signedIn,
      body: JSON.stringify({
        command,
        commandVersion: 1,
        key,
        expectedVersion: prepared.body.expectedVersion,
        idempotencyKey: `policy-links-invite-${id}-${++keys}`,
        input: { link: 'status' },
      }),
    });
    assert.equal(minted.status, 200, minted.text);
    const url = /http:\/\/[^"]+\/l\/mstl1\.[A-Za-z0-9_.-]+/.exec(minted.text)?.[0];
    assert.ok(url, `the minting answer says the URL: ${minted.text}`);
    return url;
  };
  const land = async (url: string) => {
    const opened = await call(url.slice(origin.length));
    assert.equal(opened.status, 303, opened.text);
    const id = linkTokenId(url.slice(url.lastIndexOf('/') + 1))!;
    const cookie = opened.headers.get('set-cookie')!.split(';')[0];
    const page = await call(`/l/${id}`, { headers: { cookie } });
    const session = /data-session="([^"]+)"/.exec(page.text)?.[1] ?? '';
    return { id, cookie, session, page };
  };
  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    call(path, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(body) });
  return { db, mint, land, post, call };
}

test('a row-policy App mints a link, and the link opens its one row with the policy never asked', { timeout: 20_000 }, async (t) => {
  const { db, mint, land, post } = await serve(t);
  const url = await mint(1);
  asked().length = 0;
  const { id, page, session } = await land(url);
  assert.equal(page.status, 200, page.text);
  assert.match(page.text, /Ada/);
  assert.doesNotMatch(page.text, /private/);
  const prepared = await post(`/l/${id}/prepare`, {}, { 'x-mistri-link': session });
  assert.equal(prepared.status, 200, prepared.text);
  assert.deepEqual(prepared.body.refused, {});
  const ran = await post(
    `/l/${id}/run`,
    {
      command: 'withdraw',
      expectedVersion: prepared.body.commands.withdraw.expectedVersion,
      idempotencyKey: 'policy-link-withdraw-1',
      input: { reason: 'changed my mind' },
    },
    { 'x-mistri-link': session },
  );
  assert.equal(ran.status, 200, ran.text);
  assert.deepEqual(
    db
      .prepare('SELECT id, status, note FROM claim ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
    [
      { id: 1, status: 'withdrawn', note: 'changed my mind' },
      { id: 2, status: 'open', note: 'private' },
      { id: 3, status: 'open', note: 'private' },
    ],
  );
  assert.deepEqual(asked(), [], 'the policy is never asked about a link');
  const actor = db.prepare(`SELECT actor_id FROM ${COMMAND_JOURNAL_TABLES.receipt} WHERE command_id = 'withdraw'`).get() as {
    actor_id: string;
  };
  assert.equal(actor.actor_id, `link:${id}`, 'the receipt names the link');
});

test(
  'a link in a row-policy App runs only on its own row: a body naming another key changes nothing else',
  { timeout: 20_000 },
  async (t) => {
    const { db, mint, land, post } = await serve(t);
    const { id, session } = await land(await mint(1));
    const prepared = await post(`/l/${id}/prepare`, {}, { 'x-mistri-link': session });
    /* The page posts the link's own key; a body naming another one is not this door's, and the row stays. */
    const ran = await post(
      `/l/${id}/run`,
      {
        command: 'withdraw',
        key: { id: 2 },
        expectedVersion: prepared.body.commands.withdraw.expectedVersion,
        idempotencyKey: 'policy-link-other-row-2',
      },
      { 'x-mistri-link': session },
    );
    assert.equal(ran.status, 200, ran.text);
    assert.equal((db.prepare('SELECT status FROM claim WHERE id = 2').get() as { status: string }).status, 'open');
    assert.equal((db.prepare('SELECT status FROM claim WHERE id = 1').get() as { status: string }).status, 'withdrawn');
    /* A command the link does not declare is refused before anything runs. */
    const invite = await post(
      `/l/${id}/run`,
      { command: 'invite', idempotencyKey: 'policy-link-undeclared-3' },
      { 'x-mistri-link': session },
    );
    assert.equal(invite.status, 403, invite.text);
  },
);

/* A link that no longer opens answers as one that never did: the same status and words, whether the holder is at the
   token's address or on the page a session had already reached, so nothing says the link once existed. */
for (const [how, end] of [
  [
    'a revoked',
    (db: DatabaseSync, id: string) =>
      db.prepare(`UPDATE "${COMMAND_JOURNAL_TABLES.link}" SET revoked_at = ? WHERE id = ?`).run(Date.now(), id),
  ],
  [
    'an expired',
    (db: DatabaseSync, id: string) => db.prepare(`UPDATE "${COMMAND_JOURNAL_TABLES.link}" SET expires_at = 1 WHERE id = ?`).run(id),
  ],
] as const) {
  test(`${how} link is refused with the not-found answer, at its address and on its page`, { timeout: 20_000 }, async (t) => {
    const { db, mint, land, post, call } = await serve(t);
    const url = await mint(1);
    const { id, cookie, session } = await land(url);
    const before = await post(`/l/${id}/prepare`, {}, { 'x-mistri-link': session });
    assert.equal(before.status, 200, before.text);
    end(db, id);
    const unknown = 'u'.repeat(22);
    const [token, page, prepared, ran, never, neverPrepared] = await Promise.all([
      call(url.slice(url.indexOf('/l/'))),
      call(`/l/${id}`, { headers: { cookie } }),
      post(`/l/${id}/prepare`, {}, { 'x-mistri-link': session }),
      post(`/l/${id}/run`, { command: 'withdraw', idempotencyKey: 'policy-link-gone-1' }, { 'x-mistri-link': session }),
      call(`/l/${unknown}`, { headers: { cookie } }),
      post(`/l/${unknown}/prepare`, {}, { 'x-mistri-link': session }),
    ]);
    for (const answer of [token, page]) {
      assert.equal(answer.status, 404, answer.text);
      assert.doesNotMatch(answer.text, /Ada/);
    }
    for (const answer of [prepared, ran]) {
      assert.equal(answer.status, 404, answer.text);
      assert.deepEqual(answer.body, { code: 'not_found', error: LINK_MISS });
    }
    assert.equal(never.status, page.status);
    assert.deepEqual(neverPrepared.body, prepared.body);
    assert.equal((db.prepare('SELECT status FROM claim WHERE id = 1').get() as { status: string }).status, 'open', 'nothing ran');
  });
}

test(
  'a link on a row named by two columns opens that row alone, not another that shares a part of its key',
  { timeout: 20_000 },
  async (t) => {
    const { db, mint, land, post } = await serve(t);
    const { id, page, session } = await land(await mint(0, 'inviteSlot', { account_id: 'account-clerk', number: 1 }));
    assert.equal(page.status, 200, page.text);
    assert.match(page.text, /Alpha slot/);
    assert.doesNotMatch(page.text, /Bravo slot|Charlie slot/);
    /* Its door takes no key of the caller's: a body naming another row neither reads nor runs it. */
    const named = await post(
      `/l/${id}/run`,
      { command: 'inviteSlot', key: { account_id: 'account-clerk', number: 2 }, idempotencyKey: 'policy-link-composite-1' },
      { 'x-mistri-link': session },
    );
    assert.equal(named.status, 403, named.text);
    assert.doesNotMatch(named.text, /Bravo slot|Charlie slot/);
    assert.equal((db.prepare('SELECT count(*) AS n FROM slot').get() as { n: number }).n, 3);
  },
);
