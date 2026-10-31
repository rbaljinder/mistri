/**
 * Public intake over the dedicated tenant host, with genuine native auth: a
 * signed-out visitor reads a tenant App's public form and submits it, and the
 * server places the submission by the `?via=` address alone. Every placement
 * answers with the same status, header names and body shape; a request that
 * names a tenant header, an unknown parameter, a second address or another
 * origin is refused before anything is counted or read; the submission key
 * replays; and the ordinary public form limits apply.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { literal, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  type TenantStoreAdministration,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import { parseTestApp } from './support/commandCatalog.js';

const appId = 'lending';
const binding = { appId, source: { id: 'business', connection: 'business-db' }, storeId: 'intake-http-store' };
const NORTH = 'north-intake-AAAAAAAAAAAAAAAA',
  WEST = 'west-intake-CCCCCCCCCCCCCCCCC',
  UNKNOWN = 'unknown-intake-FFFFFFFFFFFFFF';
const input = { name: { label: 'Name', type: 'text', max: 80 } } as const;

async function portFor() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function maintain(file: string, run: (admin: TenantStoreAdministration) => Promise<void>) {
  const db = new DatabaseSync(file);
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

async function fixture(t: TestContext, mount = '') {
  resetPublicFormLimits();
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-intake-http-'));
  const business = join(directory, 'business.db');
  const db = new DatabaseSync(business);
  try {
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, intake_address TEXT);
      CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), reference TEXT NOT NULL, name TEXT NOT NULL,
        more TEXT, status TEXT, resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT);
      CREATE TABLE intake_submission (id TEXT PRIMARY KEY NOT NULL, reference TEXT NOT NULL, name TEXT NOT NULL,
        more TEXT, status TEXT, resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT);
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
  await maintain(business, (admin) => admin.putTenant({ tenantId: 'west', status: 'suspended', expectedVersion: '1' }));
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
    app: parseTestApp(
      {
        id: appId,
        name: 'Lending',
        sources: { business: { connection: binding.source.connection } },
        resources: {
          dealer: { owner: 'platform' },
          lead: { access: 'write', owner: 'tenant' },
          intake_submission: { access: 'write', owner: 'platform' },
        },
        auth: {
          store: join(directory, 'auth.db'),
          signUp: 'open',
          rows: 'tenant',
          tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
          roles: { staff: { realm: 'tenant', read: true }, manager: { realm: 'platform', read: true } },
        },
        views: {
          leads: { kind: 'list', from: 'lead' },
          welcome: { kind: 'landing', hero: { heading: 'Finance your next car', actions: [{ label: 'Apply', to: 'apply' }] } },
          triage: { kind: 'list', from: 'intake_submission' },
          apply: { kind: 'form', label: 'Apply for financing', public: true, command: { id: 'apply', version: 1, input } },
          // Saved on every step: each step resolved from its address, its draft kept where the first step landed.
          draft: {
            kind: 'form',
            label: 'Apply in steps',
            public: true,
            resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress', after: '14 days' },
            draft: { status: 'draft' },
            steps: [
              { id: 'name', label: 'Name', command: { id: 'draftName', version: 1, input } },
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
        home: [{ view: 'apply', signedOut: true }, { view: 'leads' }],
      },
      'intake fixture',
    ),
    // A compiled component's files, as appComponents.ts leaves them: code, served to a signed-in reader only.
    components: {
      entries: { card: { kind: 'section', js: 'card-0123abcd.js', sources: [] } },
      files: { 'card-0123abcd.js': 'export default function Card() { return null; }', 'card-0123abcd.js.map': '{"version":3}' },
    },
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
      input,
      output: savedStep,
      async handle({ tx, draft, intake }, value) {
        if (draft!.root) await tx.update({ table: root(intake), key: { ...draft!.root }, values: { name: value.name } });
        else
          await tx.insert({
            table: root(intake),
            values: { id: randomUUID(), reference: `IGN-D-${randomUUID().slice(0, 8)}`, name: value.name, ...draft!.start },
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
    apply: defineCommand({
      targets: 'none',
      source: 'business',
      target: 'lead',
      write: ['intake_submission'],
      public: true,
      input,
      output: shape({ reference: text(), message: literal('Application received.') }),
      async handle({ db, intake }, value) {
        const reference = `IGN-${value.name}`;
        if (intake === 'tenant') await db.lead.insert({ id: randomUUID(), reference, name: value.name });
        else await db.intake_submission.insert({ id: randomUUID(), reference, name: value.name });
        return { reference, message: 'Application received.' };
      },
    }),
  });
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const saved = names.map((name) => process.env[name]);
  process.env.BETTER_AUTH_SECRET = 'synthetic-intake-host-secret-at-least-thirty-two-characters';
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  try {
    auth = await createAppAuth(loaded, { baseURL: `${origin}${mount}`, trustedOrigins: [origin] });
  } finally {
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
  }
  const everything = { dealer: true, lead: true, intake_submission: true };
  owner = await createTenantAuthenticatedHttpServer({
    loaded,
    auth,
    browser: true,
    bound: { host: '127.0.0.1', port },
    ...(mount ? { mount: { base: mount, apps: { [appId]: '' } } } : {}),
    enrollment: {
      policy: defineAppTenantPolicy({
        kind: 'tenant',
        appId,
        storeId: binding.storeId,
        ownership: { dealer: { kind: 'platform' }, lead: { kind: 'tenant', column: 'tenant_id' }, intake_submission: { kind: 'platform' } },
        resolveMembershipRows: () => everything,
        resolveRows: () => everything,
        resolvePlatformRows: () => everything,
        resultReferences: { apply: () => [], draftName: () => [], draftMore: () => [], draftSubmit: () => [] },
        intake: { address: 'intake_address' },
      }),
      source: { ...binding.source, existingPath: business },
      deployment: 'intake-generation',
      roles: ['staff', 'manager'],
      maxLifetimeMs: 60000,
      commands: { registry },
    },
  });
  owner.server.listen(port, '127.0.0.1');
  await once(owner.server, 'listening');
  const request = (path: string, init: RequestInit = {}) => fetch(origin + mount + path, { ...init, signal: AbortSignal.timeout(10000) });
  const submit = (query: string, body: unknown, headers: Record<string, string> = {}) =>
    request(`/api/forms/apply${query}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const count = (sql: string) => {
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
  return { request, submit, count, origin };
}
const via = (address: string) => `?via=${encodeURIComponent(address)}`;
const tenantHeaders = (response: Response) => [...response.headers.keys()].filter((name) => name.startsWith('x-tablewalk'));

test('signed out, a tenant App serves its public form, says so in who-am-I, and its URL says nothing', async (t) => {
  const f = await fixture(t);
  const me = await (await f.request(`/api/whoami?app=${appId}`)).json();
  assert.equal(me.signedIn, false);
  assert.equal(me.tenant, true);
  assert.equal(me.home, 'apply');
  // The landing's view key rides the signed-out answer as the single-App one sends it: the client matches
  // its home against it instead of dropping a landing for the sign-in screen.
  assert.equal(me.landingView, 'welcome');
  const form = await f.request('/api/forms/apply');
  assert.equal(form.status, 200);
  assert.deepEqual(tenantHeaders(form), []);
  const body = await form.json();
  assert.equal(body.form.id, 'apply');
  assert.equal(body.app.id, appId);
  assert.equal(JSON.stringify(body).includes('"command"'), false, 'the command id and version are never presented');
  assert.equal((await f.request('/api/forms')).status, 200);
  // The list names no address; a form's read may name one (it places a choice from a table), and answers the same
  // for every address.
  assert.equal((await f.request(`/api/forms${via(NORTH)}`)).status, 400);
  const placed = await f.request(`/api/forms/apply${via(NORTH)}`),
    unplaced = await f.request(`/api/forms/apply${via(UNKNOWN)}`);
  assert.equal(placed.status, 200);
  assert.deepEqual(await placed.json(), await unplaced.json());
  assert.equal((await f.request('/api/landing')).status, 200);
  assert.equal((await f.request('/api/forms/leads')).status, 404);
});

test('a submission lands in the dealer its address names; every other address answers with the same status, headers and shape', async (t) => {
  const f = await fixture(t);
  const answers: Array<{ status: number; headers: string[]; keys: string[]; reference: unknown }> = [];
  for (const query of [via(NORTH), via(UNKNOWN), '', via(WEST), via('north')]) {
    const response = await f.submit(query, { input: { name: 'Ada' }, submission: randomUUID() });
    const body = await response.json();
    answers.push({
      status: response.status,
      headers: [...response.headers.keys()].filter((name) => name !== 'date').sort(),
      keys: Object.keys(body).sort(),
      reference: body.reference,
    });
  }
  for (const answer of answers) assert.deepEqual(answer, answers[0]);
  assert.equal(answers[0].status, 200);
  assert.equal(answers[0].reference, 'IGN-Ada');
  assert.deepEqual(answers[0].keys, ['receipt', 'reference']);
  assert.equal(
    answers[0].headers.some((name) => name.startsWith('x-tablewalk')),
    false,
  );
  assert.deepEqual(f.count('SELECT tenant_id, reference FROM lead'), [{ tenant_id: 'north', reference: 'IGN-Ada' }]);
  assert.deepEqual(f.count('SELECT count(*) AS n FROM intake_submission'), [{ n: 4 }]);
});

test('the submission key replays; refusals come before anything is counted or read, and name only the field', async (t) => {
  const f = await fixture(t);
  const key = randomUUID();
  const first = await (await f.submit(via(NORTH), { input: { name: 'Grace' }, submission: key })).json();
  const again = await (await f.submit(via(NORTH), { input: { name: 'Grace' }, submission: key })).json();
  assert.deepEqual(again, first);
  assert.deepEqual(f.count("SELECT count(*) AS n FROM lead WHERE reference = 'IGN-Grace'"), [{ n: 1 }]);
  // Refused before the rate limit and the resolver: a tenant header, an unknown parameter, two addresses, another origin, a PUT.
  const body = { input: { name: 'Mallory' }, submission: randomUUID() };
  assert.equal((await f.submit(via(NORTH), body, { 'x-mistri-tenant': 'north' })).status, 400);
  assert.equal((await f.submit(`${via(NORTH)}&tenant=north`, body)).status, 400);
  assert.equal((await f.submit(`${via(NORTH)}&via=${UNKNOWN}`, body)).status, 400);
  assert.equal((await f.submit(via(NORTH), body, { origin: 'http://attacker.example' })).status, 403);
  assert.equal((await f.request('/api/forms/apply', { method: 'PUT' })).status, 405);
  // The shape of what was typed is refused alike, wherever the address points.
  for (const query of [via(NORTH), via(UNKNOWN)]) {
    const refused = await f.submit(query, { input: {}, submission: randomUUID() });
    assert.equal(refused.status, 400);
    const detail = await refused.json();
    assert.equal(detail.code, 'invalid_input');
    assert.equal(detail.field, 'name');
    assert.equal(Object.hasOwn(detail, 'outcome'), false);
  }
  assert.deepEqual(f.count("SELECT count(*) AS n FROM lead WHERE name = 'Mallory'"), [{ n: 0 }]);
});

test('the ordinary public form limits apply to tenant intake, per client', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 5; index++) {
    assert.equal(
      (await f.submit(via(index % 2 ? NORTH : UNKNOWN), { input: { name: `Applicant ${index}` }, submission: randomUUID() })).status,
      200,
    );
  }
  const limited = await f.submit(via(NORTH), { input: { name: 'One too many' }, submission: randomUUID() });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.deepEqual(f.count("SELECT count(*) AS n FROM lead WHERE name = 'One too many'"), [{ n: 0 }]);
});

test("a tenant App serves its components' code to a signed-in reader only, and the host modules to anyone", async (t) => {
  const f = await fixture(t);
  const file = '/lending/_components/card-0123abcd.js';
  // Signed out: there is no such file, map or code, and a shared cache is never offered one.
  for (const path of [file, `${file}.map`]) assert.equal((await f.request(path)).status, 404, path);
  const sdk = await f.request('/_mistri/sdk/react.js');
  assert.equal(sdk.status, 200);
  assert.match(sdk.headers.get('content-type') ?? '', /javascript/);
  // Another App's name, or a file this one never compiled, is no file either.
  assert.equal((await f.request('/other/_components/card-0123abcd.js')).status, 404);
  const signedUp = await f.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { origin: f.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'reader@example.invalid', password: 'a-long-synthetic-password-1', name: 'Reader' }),
  });
  assert.equal(signedUp.status, 200, await signedUp.clone().text());
  const cookie = signedUp.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const code = await f.request(file, { headers: { cookie } });
  assert.equal(code.status, 200);
  assert.equal(await code.text(), 'export default function Card() { return null; }');
  assert.match(code.headers.get('cache-control') ?? '', /^private,/);
  assert.equal((await f.request('/lending/_components/missing-0123abcd.js', { headers: { cookie } })).status, 404);
});

/* G18: an App served at the root (here under a base path) is asked for `/_components/…`; the shell's own HTML
   in its place is no module, and a root-mounted App's components never drew. */
test('a tenant App at the root serves its components at the address the page asks for', async (t) => {
  const f = await fixture(t, '/leads');
  const file = '/_components/card-0123abcd.js';
  assert.equal((await f.request(file)).status, 404, "still a signed-in reader's only");
  const signedUp = await f.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { origin: f.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'root-reader@example.invalid', password: 'a-long-synthetic-password-1', name: 'Reader' }),
  });
  assert.equal(signedUp.status, 200, await signedUp.clone().text());
  const cookie = signedUp.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const code = await f.request(file, { headers: { cookie } });
  assert.equal(code.status, 200);
  assert.match(code.headers.get('content-type') ?? '', /javascript/);
  assert.equal(await code.text(), 'export default function Card() { return null; }');
  // The App's own id is no segment of an App at the root: that address names a route of it, not its files.
  assert.doesNotMatch(
    (await f.request('/lending/_components/card-0123abcd.js', { headers: { cookie } })).headers.get('content-type') ?? '',
    /javascript/,
  );
});

test('a saved form over the tenant host: every step carries its address, and a cookie from one dealer continues nothing under another', async (t) => {
  const f = await fixture(t);
  const post = (path: string, query: string, body: unknown, cookie?: string) =>
    f.request(`/api/forms/draft${path}${query}`, {
      method: 'POST',
      headers: { origin: f.origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const cookieOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .find((value) => value.startsWith('tw_form_draft='));
  // A first step, placed and unplaced: the same status, header names and body.
  const placed = await post('/steps/name', via(NORTH), { input: { name: 'Ada' }, submission: randomUUID() });
  const unplaced = await post('/steps/name', via(UNKNOWN), { input: { name: 'Ada' }, submission: randomUUID() });
  for (const response of [placed, unplaced]) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.clone().json(), { saved: 'name' });
    assert.equal(tenantHeaders(response).length, 0);
  }
  assert.deepEqual(
    [...placed.headers.keys()].filter((name) => name !== 'date').sort(),
    [...unplaced.headers.keys()].filter((name) => name !== 'date').sort(),
  );
  const north = cookieOf(placed)!;
  assert.ok(north);
  assert.equal((await post('/steps/more', via(NORTH), { input: { more: 'Details' }, submission: randomUUID() }, north)).status, 200);
  assert.deepEqual(await (await post('/resume', via(NORTH), {}, north)).json(), { saved: ['name', 'more'] });
  // North's cookie under another dealer's address, a suspended one's, or none: no draft, and nothing written there.
  for (const query of [via(WEST), via(UNKNOWN), '']) {
    assert.deepEqual(await (await post('/resume', query, {}, north)).json(), { saved: [] }, query);
    const refused = await post('/steps/more', query, { input: { more: 'Hijacked' }, submission: randomUUID() }, north);
    assert.equal(refused.status, 404, query);
    assert.equal((await refused.json()).code, 'not_found');
    // The browser's place is forgotten with the answer: the cookie is cleared.
    assert.match(refused.headers.getSetCookie().join('\n'), /tw_form_draft=;/);
  }
  assert.deepEqual(f.count("SELECT tenant_id, name, more, status FROM lead WHERE status = 'draft'"), [
    { tenant_id: 'north', name: 'Ada', more: 'Details', status: 'draft' },
  ]);
  assert.deepEqual(f.count("SELECT count(*) AS n FROM intake_submission WHERE more = 'Hijacked'"), [{ n: 0 }]);
  const submitted = await post('', via(NORTH), { input: {}, submission: randomUUID() }, north);
  assert.equal(submitted.status, 200);
  const body = await submitted.json();
  assert.match(body.reference, /^IGN-D-/);
  assert.deepEqual(f.count("SELECT tenant_id, status, resume_token_hash FROM lead WHERE status = 'submitted'"), [
    { tenant_id: 'north', status: 'submitted', resume_token_hash: null },
  ]);
  // A saved form's paths are the ordinary host's: no status check or link on a tenant App.
  assert.equal((await post('/status', via(NORTH), {})).status, 404);
});

test('a mounted tenant saved form scopes its draft cookie to the mounted form path', async (t) => {
  const f = await fixture(t, '/leads');
  const post = (path: string, body: unknown, cookie?: string) =>
    f.request(`/api/forms/draft${path}${via(NORTH)}`, {
      method: 'POST',
      headers: { origin: f.origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const first = await post('/steps/name', { input: { name: 'Maya' }, submission: randomUUID() });
  assert.equal(first.status, 200, await first.clone().text());
  const savedCookie = first.headers.getSetCookie().find((value) => value.startsWith('tw_form_draft='));
  assert.ok(savedCookie);
  assert.match(savedCookie, /(?:^|;)\s*Path=\/leads\/api\/forms\/draft(?:;|$)/i);
  const cookie = savedCookie.split(';')[0];
  const resumed = await post('/resume', {}, cookie);
  assert.equal(resumed.status, 200);
  assert.deepEqual(await resumed.json(), { saved: ['name'] });
  assert.deepEqual(f.count("SELECT tenant_id, name FROM lead WHERE status = 'draft'"), [{ tenant_id: 'north', name: 'Maya' }]);
  assert.equal((await f.request('/api/forms/draft', { headers: { origin: f.origin } })).status, 200);
});

test('a public form page on a tenant host is titled by its form, not the tenant', async (t) => {
  const f = await fixture(t);
  for (const path of ['/form/apply', `/${appId}/form/apply`, `/${appId}/form/apply${via(NORTH)}`]) {
    const response = await f.request(path, { headers: { accept: 'text/html' } });
    assert.equal(response.status, 200, path);
    const title = (await response.text()).match(/<title>([^<]*)<\/title>/)?.[1];
    assert.match(title ?? '', /^Apply for financing · /, path);
  }
});
