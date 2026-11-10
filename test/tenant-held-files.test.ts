/**
 * Files held for a command on a tenant App (server/commands/stagedFiles.ts): a public form's, held over the tenant
 * host for the visitor's cookie in the place its address names, and a signed-in member's, held in the tenant's own
 * journal store. Each is taken in the command's own transaction, so a file held under one tenant is no use under
 * another, one visitor's or account's is no use to the next, and a form saved on every step takes none.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import {
  COMMAND_STAGED_TABLE,
  StagedFilesFull,
  stageSqliteFile,
  type StagedNamespace,
} from '../packages/mistri/src/adapters/commands/commandStaging.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth, type AppAuthRuntime, type VerifiedSessionInstance } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineChallenges } from '../packages/mistri/src/server/commands/challenges.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { literal, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  type TenantStoreAdministration,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import { parseTestApp } from './support/commandCatalog.js';

const MIB = 1024 * 1024;
const NORTH = 'north-intake-AAAAAAAAAAAAAAAA',
  WEST = 'west-intake-CCCCCCCCCCCCCCCCC';
const via = (address: string) => `?via=${encodeURIComponent(address)}`;
const b64 = (bytes: number | Uint8Array, fill = 7) =>
  Buffer.from(typeof bytes === 'number' ? new Uint8Array(bytes).fill(fill) : bytes).toString('base64');
const file = (name = 'a.txt', size: number | Uint8Array = 64) => ({ name, type: 'text/plain', data: b64(size) });
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};

/* ---------- a public form, over the tenant host ---------- */

const appId = 'lending';
const binding = { appId, source: { id: 'business', connection: 'business-db' }, storeId: 'held-http-store' };
const draftColumns = 'more TEXT, status TEXT, resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT';
const claimInput = { name: field.text({ max: 80 }), docs: field.files('lead_file', { max: 10 }) };
const savedInput = { name: { label: 'Name', type: 'text', max: 80 } } as const;

async function portFor() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function maintain(path: string, run: (admin: TenantStoreAdministration) => Promise<void>) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    const operations = new TransactionOperations();
    await run(createSqliteTenantAdministration(db, operations, binding));
    await operations.finish();
    db.exec('COMMIT');
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}

async function publicFixture(t: TestContext, options: { challenge?: boolean } = {}) {
  resetPublicFormLimits();
  const directory = mkdtempSync(join(tmpdir(), 'mistri-held-http-'));
  const business = join(directory, 'business.db');
  const db = new DatabaseSync(business);
  try {
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, intake_address TEXT);
      CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), reference TEXT NOT NULL, name TEXT NOT NULL, ${draftColumns});
      CREATE TABLE lead_file (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), lead_id TEXT,
        file_name TEXT NOT NULL, content_type TEXT, byte_size INTEGER, data BLOB);
      CREATE TABLE intake_submission (id TEXT PRIMARY KEY NOT NULL, reference TEXT NOT NULL, name TEXT NOT NULL, ${draftColumns});
      INSERT INTO dealer VALUES ('north', 'North Motors', '${NORTH}'), ('west', 'West Wheels', '${WEST}');`);
  } finally {
    db.close();
  }
  provisionSqliteTenantStore(business, binding);
  migrateSqliteCommandJournal(business);
  await maintain(business, async (admin) => {
    for (const tenantId of ['north', 'west']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
  });
  const port = await portFor(),
    origin = `http://127.0.0.1:${port}`;
  let auth: AppAuthRuntime | undefined;
  let owner: Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>> | undefined;
  t.after(async () => {
    try {
      owner?.server.closeAllConnections();
      await owner?.retire();
    } finally {
      auth?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const loaded: LoadedApp = {
    path: join(directory, 'app.ts'),
    pages: [],
    sources: {},
    ...(options.challenge
      ? { challenges: defineChallenges({ verifyHuman: { verify: async (token: string) => token === 'person' } }) }
      : {}),
    app: parseTestApp(
      {
        id: appId,
        name: 'Lending',
        sources: { business: { connection: binding.source.connection } },
        resources: {
          dealer: { owner: 'platform' },
          lead: { access: 'write', owner: 'tenant' },
          lead_file: {
            access: 'write',
            owner: 'tenant',
            file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', maxBytes: 20 * MIB },
          },
          intake_submission: { access: 'write', owner: 'platform' },
        },
        auth: {
          store: join(directory, 'auth.db'),
          signUp: 'open',
          rows: 'tenant',
          tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
          roles: { staff: { realm: 'tenant', read: true }, manager: { realm: 'platform', read: true } },
          ...(options.challenge ? { challenge: 'verifyHuman' } : {}),
        },
        views: {
          leads: { kind: 'list', from: 'lead' },
          triage: { kind: 'list', from: 'intake_submission' },
          claim: { kind: 'form', label: 'Send documents', public: true, command: { id: 'claim', version: 1, input: claimInput } },
          draft: {
            kind: 'form',
            label: 'Apply in steps',
            public: true,
            resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress', after: '14 days' },
            draft: { status: 'draft' },
            steps: [
              { id: 'name', label: 'Name', command: { id: 'draftName', version: 1, input: savedInput } },
              {
                id: 'more',
                label: 'More',
                command: { id: 'draftMore', version: 1, input: { more: { label: 'More', type: 'text', max: 80 } } },
              },
            ],
            command: { id: 'draftSubmit', version: 1, input: { note: { label: 'Note', type: 'text', max: 80, optional: true } } },
          },
        },
        nav: [
          { id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['leads'] },
          { id: 'lender', label: 'Lender', realm: 'platform', children: ['triage'] },
        ],
        home: [{ view: 'claim', signedOut: true }, { view: 'leads' }],
      },
      'held files fixture',
    ),
  };
  const places = ['lead', 'intake_submission'];
  const root = (intake: unknown) => (intake === 'tenant' ? 'lead' : 'intake_submission');
  const savedStep = shape({ message: literal('Saved.') });
  const registry = defineCommands({
    draftName: defineCommand({
      targets: 'none',
      source: 'business',
      target: 'lead',
      write: places,
      read: places,
      public: true,
      input: savedInput,
      output: savedStep,
      async handle({ tx, draft, intake }, value) {
        if (draft!.root) await tx.update({ table: root(intake), key: { ...draft!.root }, values: { name: value.name } });
        else
          await tx.insert({
            table: root(intake),
            values: { id: randomUUID(), reference: `D-${randomUUID().slice(0, 8)}`, name: value.name, ...draft!.start },
          });
        return { message: 'Saved.' as const };
      },
    }),
    draftMore: defineCommand({
      targets: 'none',
      source: 'business',
      target: 'lead',
      write: places,
      read: places,
      public: true,
      input: { more: { label: 'More', type: 'text', max: 80 } },
      output: savedStep,
      async handle({ tx, draft, intake }, value) {
        await tx.update({ table: root(intake), key: { ...draft!.root! }, values: { more: value.more } });
        return { message: 'Saved.' as const };
      },
    }),
    draftSubmit: defineCommand({
      targets: 'none',
      source: 'business',
      target: 'lead',
      write: places,
      read: places,
      public: true,
      input: { note: { label: 'Note', type: 'text', max: 80, optional: true } },
      output: shape({ reference: text(), message: literal('Application received.') }),
      async handle({ tx, draft, intake }) {
        const [row] = (await tx.query({ table: root(intake), columns: ['reference'], limit: 1, offset: 0 })).rows;
        await tx.update({ table: root(intake), key: { ...draft!.root! }, values: { status: 'submitted' } });
        return { reference: String(row.reference), message: 'Application received.' as const };
      },
    }),
    claim: defineCommand({
      targets: 'none',
      source: 'business',
      target: 'lead',
      write: ['lead', 'lead_file', 'intake_submission'],
      public: true,
      input: claimInput,
      output: shape({ reference: text() }),
      async handle({ db: records, intake }, value) {
        const reference = `CLM-${value.name}`;
        // Where it lands: a dealer's rows keep the files; the platform's triage keeps the words.
        if (intake === 'tenant') {
          const lead = await records.lead.insert({ id: randomUUID(), reference, name: value.name });
          for (const each of value.docs) await records.lead_file.insertFile(each, { id: randomUUID(), lead_id: String(lead.id) });
        } else await records.intake_submission.insert({ id: randomUUID(), reference, name: value.name });
        return { reference };
      },
    }),
  });
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const saved = names.map((name) => process.env[name]);
  process.env.BETTER_AUTH_SECRET = 'synthetic-held-files-secret-at-least-thirty-two-characters';
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  try {
    auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
  } finally {
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
  }
  const everything = { dealer: true, lead: true, lead_file: true, intake_submission: true };
  owner = await createTenantAuthenticatedHttpServer({
    loaded,
    auth,
    browser: true,
    bound: { host: '127.0.0.1', port },
    enrollment: {
      policy: defineAppTenantPolicy({
        kind: 'tenant',
        appId,
        storeId: binding.storeId,
        ownership: {
          dealer: { kind: 'platform' },
          lead: { kind: 'tenant', column: 'tenant_id' },
          lead_file: { kind: 'tenant', column: 'tenant_id' },
          intake_submission: { kind: 'platform' },
        },
        resolveMembershipRows: () => everything,
        resolveRows: () => everything,
        resolvePlatformRows: () => everything,
        resultReferences: { claim: () => [], draftName: () => [], draftMore: () => [], draftSubmit: () => [] },
        intake: { address: 'intake_address' },
      }),
      source: { ...binding.source, existingPath: business },
      deployment: 'held-generation',
      roles: ['staff', 'manager'],
      maxLifetimeMs: 60000,
      commands: { registry },
    },
  });
  owner.server.listen(port, '127.0.0.1');
  await once(owner.server, 'listening');
  const request = (path: string, init: RequestInit = {}) => fetch(origin + path, { ...init, signal: AbortSignal.timeout(20000) });
  const post = (path: string, body: unknown, cookie?: string, headers: Record<string, string> = {}) =>
    request(path, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      body: JSON.stringify(body),
    });
  /** Holds a file for the form's field; the visitor's cookie is the one given, or the one this answer sets. */
  const hold = async (address: string, upload: unknown, cookie?: string) => {
    const response = await post(`/api/forms/claim/files${via(address)}`, { field: 'docs', file: upload }, cookie);
    const set = response.headers.getSetCookie()[0]?.split(';')[0];
    return { response, cookie: cookie ?? set, body: object(await response.json()) };
  };
  const send = async (address: string, ids: string[], cookie?: string, name = 'Ada') => {
    const response = await post(`/api/forms/claim${via(address)}`, { input: { name, docs: ids }, submission: randomUUID() }, cookie);
    return { response, body: object(await response.json()) };
  };
  const rows = (sql: string) => {
    const reader = new DatabaseSync(business, { readOnly: true });
    try {
      return reader
        .prepare(sql)
        .all()
        .map((row) => ({ ...row }));
    } finally {
      reader.close();
    }
  };
  const held = () => Number(rows(`SELECT count(*) AS n FROM ${COMMAND_STAGED_TABLE}`)[0].n);
  return { request, post, hold, send, rows, held };
}

test("a public tenant form holds a file for its visitor, and on submit it lands in the placed tenant's rows", async (t) => {
  const f = await publicFixture(t);
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const first = await f.hold(NORTH, file('doc.txt', bytes));
  assert.equal(first.response.status, 200, JSON.stringify(first.body));
  assert.deepEqual(Object.keys(first.body).sort(), ['id', 'name', 'size', 'type']);
  assert.equal(first.body.name, 'doc.txt');
  assert.equal(first.body.size, 5);
  assert.ok(first.cookie?.startsWith('mistri_files_claim='), 'the visitor is given a cookie where they have none');
  assert.equal(f.held(), 1);
  const sent = await f.send(NORTH, [first.body.id as string], first.cookie);
  assert.equal(sent.response.status, 200, JSON.stringify(sent.body) + JSON.stringify(first.body));
  assert.equal(sent.body.reference, 'CLM-Ada');
  assert.equal(JSON.stringify(sent.body).includes(first.body.id as string), false, 'a held id never comes back in a receipt');
  assert.deepEqual(f.rows('SELECT tenant_id, file_name, byte_size FROM lead_file'), [
    { tenant_id: 'north', file_name: 'doc.txt', byte_size: 5 },
  ]);
  assert.deepEqual(f.rows('SELECT hex(data) AS data FROM lead_file'), [{ data: '0102030405' }]);
  assert.equal(f.held(), 0, 'taking a file uses it up');
  // An id used once is used up.
  const again = await f.send(NORTH, [first.body.id as string], first.cookie, 'Bea');
  assert.equal(again.response.status, 400);
  assert.equal(f.rows('SELECT 1 FROM lead_file').length, 1);
});

test('a file held under one tenant is refused by a form placed in another, and nothing is written there', async (t) => {
  const f = await publicFixture(t);
  const held = await f.hold(NORTH, file());
  assert.equal(held.response.status, 200);
  const wrong = await f.send(WEST, [held.body.id as string], held.cookie);
  assert.equal(wrong.response.status, 400, JSON.stringify(wrong.body));
  assert.equal(JSON.stringify(wrong.body).includes(held.body.id as string), false);
  assert.deepEqual(f.rows('SELECT 1 FROM lead_file'), []);
  assert.deepEqual(f.rows("SELECT 1 FROM lead WHERE tenant_id = 'west'"), []);
  assert.equal(f.held(), 1, 'refused, it is still held where it was');
  // Placed where it was held, it is taken.
  assert.equal((await f.send(NORTH, [held.body.id as string], held.cookie)).response.status, 200);
  assert.deepEqual(f.rows('SELECT tenant_id FROM lead_file'), [{ tenant_id: 'north' }]);
});

test("one visitor's cookie takes only that visitor's held file", async (t) => {
  const f = await publicFixture(t);
  const a = await f.hold(NORTH, file('a.txt'));
  const b = await f.hold(NORTH, file('b.txt'));
  assert.notEqual(a.cookie, b.cookie);
  const stolen = await f.send(NORTH, [a.body.id as string], b.cookie);
  assert.equal(stolen.response.status, 400);
  const bare = await f.send(NORTH, [a.body.id as string], undefined);
  assert.equal(bare.response.status, 400);
  assert.deepEqual(f.rows('SELECT 1 FROM lead_file'), []);
  assert.equal(f.held(), 2);
  assert.equal((await f.send(NORTH, [a.body.id as string], a.cookie)).response.status, 200);
  assert.deepEqual(f.rows('SELECT file_name FROM lead_file'), [{ file_name: 'a.txt' }]);
});

test('a visitor holds at most ten files, 25 MB and 10 MB a file', async (t) => {
  const f = await publicFixture(t);
  let cookie: string | undefined;
  for (let n = 1; n <= 10; n++) {
    const held = await f.hold(NORTH, file(`f${n}.txt`, 16), cookie);
    assert.equal(held.response.status, 200, `file ${n}: ${JSON.stringify(held.body)}`);
    cookie = held.cookie;
  }
  const eleventh = await f.hold(NORTH, file('f11.txt', 16), cookie);
  assert.equal(eleventh.response.status, 429, JSON.stringify(eleventh.body));
  assert.equal(eleventh.body.code, 'too_many_files');
  assert.equal(f.held(), 10);
  // Another visitor has their own count; bytes are counted for them.
  let other: string | undefined;
  for (const size of [9 * MIB, 9 * MIB]) {
    const held = await f.hold(NORTH, file('big.bin', size), other);
    assert.equal(held.response.status, 200, JSON.stringify(held.body));
    other = held.cookie;
  }
  const over = await f.hold(NORTH, file('big.bin', 9 * MIB), other);
  assert.equal(over.response.status, 429, JSON.stringify(over.body));
  // A file past a public file's most is too large, whatever its resource takes (20 MB here).
  const huge = await f.hold(NORTH, file('huge.bin', 10 * MIB + 1));
  assert.equal(huge.response.status, 413, JSON.stringify(huge.body));
  assert.equal(huge.body.code, 'too_large');
});

test("a tenant App's human check is asked of a file hold as of the submission: no answer, no file held", async (t) => {
  const f = await publicFixture(t, { challenge: true });
  const hold = (headers: Record<string, string>) =>
    f.post(`/api/forms/claim/files${via(NORTH)}`, { field: 'docs', file: file() }, undefined, headers);
  for (const headers of [{}, { 'x-mistri-challenge': 'robot' }] as Record<string, string>[]) {
    const refused = await hold(headers);
    assert.equal(refused.status, 403);
    assert.equal(object(await refused.json()).code, 'challenge_failed');
  }
  assert.equal(f.held(), 0);
  const passed = await hold({ 'x-mistri-challenge': 'person' });
  assert.equal(passed.status, 200, await passed.text());
  assert.equal(f.held(), 1);
});

test('a tenant form saved on every step takes no public files, and a key that names no form holds none', async (t) => {
  const f = await publicFixture(t);
  const saved = await f.post(`/api/forms/draft/files${via(NORTH)}`, { field: 'docs', file: file() });
  assert.equal(saved.status, 403);
  assert.equal(f.held(), 0);
  const none = await f.post(`/api/forms/nowhere/files${via(NORTH)}`, { field: 'docs', file: file() });
  assert.equal(none.status, 404);
  const method = await f.request(`/api/forms/claim/files${via(NORTH)}`);
  assert.equal(method.status, 405);
  // A body that is not a file is refused, not run.
  const bad = await f.post(`/api/forms/claim/files${via(NORTH)}`, { field: 'docs', file: { name: 'x', data: '***' } });
  assert.equal(bad.status, 400);
  // A field the command does not take.
  const wrong = await f.post(`/api/forms/claim/files${via(NORTH)}`, { field: 'name', file: file() });
  assert.equal(wrong.status, 404);
});

/* ---------- a signed-in member, over the tenant host ---------- */

type Answer = { status: number; body: Record<string, unknown>; text: string };
type Context = { tabId: string; context: string; appId: string; accountId: string; tenantId: string; revision: number };
const deskId = 'desk';

async function memberFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-held-member-')),
    path = join(directory, 'business.db');
  const db = new DatabaseSync(path);
  let owner: ReturnType<typeof createTenantHttpServer> | undefined;
  let enrollment: Awaited<ReturnType<typeof createTenantEnrollment<IncomingMessage>>> | undefined;
  t.after(async () => {
    try {
      if (owner) {
        const stopped = new Promise<void>((resolve) => owner!.server.close(() => resolve()));
        owner.server.closeAllConnections();
        await stopped;
        await owner.retire();
      }
      await enrollment?.retire();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE ticket(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL);
    CREATE TABLE ticket_file(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, ticket_id TEXT, file_name TEXT NOT NULL,
      content_type TEXT, byte_size INTEGER, data BLOB);`);
  const bind = { appId: deskId, source: { id: 'business', connection: 'business-db' }, storeId: 'desk-store' };
  provisionSqliteTenantStore(path, bind);
  migrateSqliteCommandJournal(path);
  const operations = new TransactionOperations();
  db.exec('BEGIN IMMEDIATE');
  const admin = createSqliteTenantAdministration(db, operations, bind);
  for (const tenantId of ['north', 'south']) {
    await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    for (const accountId of ['eve', 'fay'])
      await admin.putMembership({
        tenantId,
        accountId,
        membershipId: `${tenantId}-${accountId}`,
        status: 'active',
        roles: ['employee'],
        validUntil: 10000,
        expectedVersion: null,
      });
  }
  await operations.finish();
  db.exec('COMMIT');
  const attachInput = { title: field.text(), docs: field.files('ticket_file', { max: 3 }) };
  const app = parseTestApp(
    {
      id: deskId,
      name: 'Desk',
      auth: { rows: 'tenant', roles: { employee: { read: true, commands: ['attach'] } } },
      sources: { business: { connection: bind.source.connection } },
      resources: {
        ticket: { owner: 'tenant', access: 'write' },
        ticket_file: {
          owner: 'tenant',
          access: 'write',
          file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', maxBytes: 4096 },
        },
      },
      views: {
        tickets: { kind: 'list', from: 'ticket' },
        attach: { kind: 'form', label: 'Attach', command: { id: 'attach', version: 1, input: attachInput } },
      },
      nav: ['tickets', 'attach'],
      home: 'tickets',
    },
    'held member fixture',
  );
  const registry = defineCommands({
    attach: defineCommand({
      source: 'business',
      target: 'ticket',
      targets: 'none',
      read: ['ticket'],
      write: ['ticket', 'ticket_file'],
      input: attachInput,
      output: { parse: (value: unknown) => value as { id: string } },
      async handle({ db: records }, value) {
        const id = randomUUID();
        await records.ticket.insert({ id, title: value.title });
        for (const each of value.docs) await records.ticket_file.insertFile(each, { id: randomUUID(), ticket_id: id });
        return { id };
      },
    }),
  });
  const rowsOf = { ticket: true, ticket_file: true };
  const policy = defineAppTenantPolicy({
    kind: 'tenant',
    appId: deskId,
    storeId: bind.storeId,
    ownership: { ticket: { kind: 'tenant', column: 'tenant_id' }, ticket_file: { kind: 'tenant', column: 'tenant_id' } },
    resolveMembershipRows: () => rowsOf,
    resolveRows: () => rowsOf,
    resultReferences: { attach: () => [] },
  });
  let who = 'eve';
  enrollment = await createTenantEnrollment<IncomingMessage>({
    app,
    pages: [],
    policy,
    source: { ...bind.source, existingPath: path },
    deployment: 'desk-deployment',
    roles: ['employee'],
    maxLifetimeMs: 300000,
    now: () => 1000,
    commands: { registry },
    verifySession: async () => ({ id: who, who }),
  });
  const bound = { host: '127.0.0.1', port: 0 };
  owner = createTenantHttpServer({
    app,
    enrollment,
    bound,
    verifySessionInstance: (): VerifiedSessionInstance => ({ identity: { id: who, who }, sessionId: `session-${who}`, expiresAt: 20000 }),
  });
  owner.server.listen(0, bound.host);
  await once(owner.server, 'listening');
  const address = owner.server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const call = async (target: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
    const response = await fetch(`http://${bound.host}:${bound.port}${target}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const body_ = await response.text();
    return { status: response.status, text: body_, body: object(JSON.parse(body_)) };
  };
  const select = (target: string, tenant: string) => `${target}?app=${deskId}&tenant=${tenant}`;
  const open = async (account: string, tenant = 'north'): Promise<Context> => {
    who = account;
    const reply = await call(select('/api/tenant/context/open', tenant), {});
    assert.equal(reply.status, 200, reply.text);
    return reply.body as Context;
  };
  const data = (target: string, value: Context, body: unknown) => {
    who = value.accountId;
    return call(select(target, value.tenantId), body, {
      'x-mistri-tab': value.tabId,
      'x-mistri-context': value.context,
      'x-mistri-lease-revision': String(value.revision),
      'x-mistri-account': value.accountId,
    });
  };
  const hold = (value: Context, upload: unknown, field_ = 'docs') =>
    data('/api/commands/files', value, { command: 'attach', field: field_, file: upload });
  const attach = (value: Context, ids: string[]) =>
    data('/api/commands/execute', value, {
      command: 'attach',
      commandVersion: 1,
      key: {},
      expectedVersion: 0,
      idempotencyKey: `attach-${randomUUID()}`,
      input: { title: 'Broken printer', docs: ids },
    });
  const rows = (sql: string) =>
    db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  return { open, hold, attach, rows };
}

test('a signed-in tenant command takes its held file in its transaction, and another account cannot take it', async (t) => {
  const f = await memberFixture(t);
  const eve = await f.open('eve'),
    fay = await f.open('fay');
  const held = await f.hold(eve, file('scan.txt', new Uint8Array([9, 8, 7])));
  assert.equal(held.status, 200, held.text);
  assert.deepEqual(Object.keys(held.body).sort(), ['id', 'name', 'size', 'type']);
  const id = held.body.id as string;
  // Held for eve alone: fay's command finds nothing under her name, and writes nothing.
  const stolen = await f.attach(fay, [id]);
  assert.equal(stolen.status, 400, stolen.text);
  assert.deepEqual(f.rows('SELECT 1 FROM ticket'), []);
  assert.deepEqual(f.rows('SELECT 1 FROM ticket_file'), []);
  // A file past what its resource takes is refused when it is held (4096 bytes here).
  const big = await f.hold(eve, file('big.bin', 5000));
  assert.equal(big.status, 413, big.text);
  // A field the command does not take.
  assert.equal((await f.hold(eve, file(), 'title')).status, 404);
  const done = await f.attach(eve, [id]);
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.status, 'applied', done.text);
  assert.equal(done.text.includes(id), false, 'a held id never comes back in a receipt');
  assert.deepEqual(f.rows('SELECT tenant_id, file_name, hex(data) AS data FROM ticket_file'), [
    { tenant_id: 'north', file_name: 'scan.txt', data: '090807' },
  ]);
  // Used up.
  assert.equal((await f.attach(eve, [id])).status, 400);
});

test("a file held in one tenant is no use to a command run in another, and the other account's lease does not hold it", async (t) => {
  const f = await memberFixture(t);
  const north = await f.open('eve', 'north'),
    south = await f.open('eve', 'south');
  const held = await f.hold(north, file('n.txt'));
  assert.equal(held.status, 200, held.text);
  const crossed = await f.attach(south, [held.body.id as string]);
  assert.equal(crossed.status, 400, crossed.text);
  assert.deepEqual(f.rows('SELECT 1 FROM ticket_file'), []);
  assert.equal((await f.attach(north, [held.body.id as string])).status, 200);
  assert.deepEqual(f.rows('SELECT tenant_id FROM ticket_file'), [{ tenant_id: 'north' }]);
});

test("a signed-in member holds at most forty files in the tenant's own store, and another tenant's count is its own", async (t) => {
  const f = await memberFixture(t);
  const north = await f.open('eve', 'north'),
    south = await f.open('eve', 'south');
  for (let n = 1; n <= 40; n++) assert.equal((await f.hold(north, file(`f${n}.txt`, 8))).status, 200, `file ${n}`);
  const over = await f.hold(north, file('f41.txt', 8));
  assert.equal(over.status, 429, over.text);
  assert.equal(over.body.code, 'too_many_files');
  assert.equal((await f.hold(south, file('s1.txt', 8))).status, 200, "the count is the place store's");
});

test("every visitor's share and a sender's count are a place's own: a full tenant leaves another's room alone", (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-held-count-')),
    path = join(directory, 'count.db');
  new DatabaseSync(path).close();
  migrateSqliteCommandJournal(path);
  const db = new DatabaseSync(path);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  try {
    const place = (tenant: string) => ['store', 'business', 'tenant', tenant] as StagedNamespace;
    const row = (owner: string) => ({
      idHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
      owner,
      command: 'claim',
      field: 'docs',
      name: 'a.txt',
      type: 'text/plain',
      size: 100,
      data: new Uint8Array(100),
      expiresAt: Date.now() + 60_000,
    });
    const most = { files: 2, bytes: 1000, shared: { prefix: 'visitor:', bytes: 350 } };
    db.exec('BEGIN IMMEDIATE');
    const stage = (tenant: string, owner: string) => stageSqliteFile(db, 'lending', place(tenant), row(owner), most, Date.now());
    stage('north', 'visitor:one');
    stage('north', 'visitor:one');
    // The same sender is at their count in north, and has all of it in west.
    assert.throws(() => stage('north', 'visitor:one'), StagedFilesFull);
    stage('west', 'visitor:one');
    // North's share is spent by its visitors alone: 350 bytes holds three files of 100, not four.
    stage('north', 'visitor:two');
    assert.throws(
      () => stage('north', 'visitor:three'),
      (error) => error instanceof StagedFilesFull && error.shared,
    );
    stage('west', 'visitor:three');
  } finally {
    db.close();
  }
});
