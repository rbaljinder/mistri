/** A row-scoped App API token (`api.scopes`, `--scope`, `POST …/$scope`) on a
 * row-policy App over SQLite, through the real CLI: an unscoped token asks for
 * a child narrowed to one clinic; the child lists, reads and writes that
 * clinic's rows alone — a path mapping (`visit` through its patient) included —
 * cannot be scoped again, lives no longer than it asked or its parent does,
 * and ends with its parent. A key the parent cannot read answers exactly as a
 * missing one. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { loadBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { issueSqliteApiCommandToken, revokeSqliteApiToken } from '../packages/mistri/src/server/auth/sqliteApiTokenMaintenance.js';
import { captureAuthStoreExclusion } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { readSqliteReadAudit } from '../packages/mistri/src/adapters/readAudit/sqliteReadAudit.js';
import { ROOT, SESSION_SECRET, serveApi } from './appApiCli.js';

const storeId = '6c1d9f1e-3b5e-4d66-8f2b-4a7e1e7d3c22';
const COMMANDS = ['rename', 'admit', 'enroll', 'move', 'reassign', 'cancel'];

async function clinics(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-api-scope-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const business = join(directory, 'business.db'),
    authPath = join(directory, 'auth.db');
  const db = new DatabaseSync(business);
  try {
    db.exec(
      'CREATE TABLE clinic(id INTEGER PRIMARY KEY, name TEXT NOT NULL); ' +
        'CREATE TABLE patient(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, clinic_id INTEGER NOT NULL REFERENCES clinic(id), name TEXT NOT NULL); ' +
        'CREATE TABLE visit(id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patient(id), note TEXT NOT NULL); ' +
        'CREATE TABLE scan(id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patient(id), filename TEXT NOT NULL, bytes BLOB NOT NULL); ' +
        'CREATE INDEX patient_clinic ON patient(clinic_id); CREATE INDEX visit_patient ON visit(patient_id); CREATE INDEX scan_patient ON scan(patient_id); ' +
        "INSERT INTO clinic VALUES (1, 'North'), (2, 'South'); " +
        "INSERT INTO patient(id, clinic_id, name) VALUES (1, 1, 'Ada'), (2, 2, 'Bo'), (3, 1, 'Cy'); " +
        "INSERT INTO visit VALUES (1, 1, 'checkup'), (2, 2, 'x-ray'), (3, 3, 'cleaning'); " +
        "INSERT INTO scan VALUES (1, 1, 'ada.png', x'89504e47'), (2, 2, 'bo.png', x'89504e47')",
    );
  } finally {
    db.close();
  }
  migrateSqliteCommandJournal(business);
  await provisionStores({ sqlite: business }, { only: ['read-audit'] });
  const appDir = join(directory, 'app');
  mkdirSync(appDir);
  const config = join(directory, 'mistri.json'),
    commands = join(appDir, 'commands.mjs'),
    policy = join(directory, 'policy.mjs');
  writeFileSync(
    join(appDir, 'app.json'),
    JSON.stringify({
      id: 'clinics',
      name: 'Clinics',
      sources: { business: { connection: 'data', default: true } },
      resources: {
        clinic: {},
        patient: { access: 'write' },
        visit: { access: 'write', delete: true, audit: { reads: true } },
        scan: { file: { content: 'bytes', name: 'filename' } },
      },
      auth: {
        store: authPath,
        rows: 'policy',
        roles: { staff: { read: ['clinic', 'patient', 'visit', 'scan'], write: false, commands: COMMANDS } },
      },
      views: {
        patients: { kind: 'list', from: 'patient' },
        'admit-patient': { kind: 'form', label: 'Admit a patient', command: 'admit' },
        'enroll-patient': { kind: 'form', label: 'Enroll a patient', command: 'enroll' },
      },
      home: 'patients',
      nav: ['patients', 'admit-patient', 'enroll-patient'],
      api: {
        version: 1,
        roles: ['staff'],
        resources: {
          clinic: { fields: ['id', 'name'], sorts: ['id'] },
          patient: { fields: ['id', 'revision', 'clinic_id', 'name'], filters: ['name', 'clinic_id'], sorts: ['id'] },
          visit: { fields: ['id', 'patient_id', 'patient_id.name', 'note'], sorts: ['id'] },
          scan: { fields: ['id', 'patient_id', 'filename'], filters: ['filename'], sorts: ['id'] },
        },
        views: ['patients'],
        commands: COMMANDS,
        scopes: {
          clinic: {
            key: 'clinic',
            rows: { clinic: 'id', patient: 'clinic_id', visit: 'patient_id.clinic_id', scan: 'patient_id.clinic_id' },
          },
        },
      },
    }),
  );
  writeFileSync(config, JSON.stringify({ connections: [{ id: 'data', name: 'data', url: business, writable: true }] }));
  const source = (path: string) => pathToFileURL(join(ROOT, path)).href;
  // `admit` names its clinic; `enroll` leaves it to the token's scope.
  writeFileSync(
    commands,
    `import { defineCommand, defineCommands } from '${source('packages/mistri/src/server/commands/businessCommands.ts')}';
import { shape, bool, text } from '${source('packages/mistri/src/server/commands/commandShapes.ts')}';
export default defineCommands({
  rename: defineCommand({ source: 'business', target: 'patient', input: { name: { type: 'text' } }, output: shape({ ok: bool(), scope: text() }),
    async handle(context, input) {
      await context.db.patient.update(context.record, { name: input.name });
      // What the command is told of the token's scope, as it is told it.
      const scope = context.actor.scope;
      return { ok: true, scope: scope ? scope.name + ':' + scope.key : 'none' };
    } }),
  admit: defineCommand({ source: 'business', target: 'patient', targets: 'none', read: ['clinic'], input: { id: { type: 'text' }, clinic: { type: 'text' }, name: { type: 'text' } }, output: shape({ ok: bool() }),
    async handle(context, input) {
      await context.db.patient.insert({ id: Number(input.id), clinic_id: Number(input.clinic), name: input.name });
      return { ok: true };
    } }),
  enroll: defineCommand({ source: 'business', target: 'patient', targets: 'none', read: ['clinic'], input: { id: { type: 'text' }, name: { type: 'text' } }, output: shape({ ok: bool() }),
    async handle(context, input) {
      await context.db.patient.insert({ id: Number(input.id), name: input.name });
      return { ok: true };
    } }),
  // Re-points the patient's own scope column, and a visit's hop to its patient.
  move: defineCommand({ source: 'business', target: 'patient', read: ['clinic'], input: { clinic: { type: 'text' } }, output: shape({ ok: bool() }),
    async handle(context, input) {
      await context.db.patient.update(context.record, { clinic_id: Number(input.clinic) });
      return { ok: true };
    } }),
  reassign: defineCommand({ source: 'business', target: 'visit', read: ['patient'], input: { patient: { type: 'text' } }, output: shape({ ok: bool() }),
    async handle(context, input) {
      await context.db.visit.update(context.record, { patient_id: Number(input.patient) });
      return { ok: true };
    } }),
  cancel: defineCommand({ source: 'business', target: 'visit', output: shape({ ok: bool() }),
    async handle(context) {
      await context.db.visit.remove(context.record);
      return { ok: true };
    } }),
});
`,
  );
  writeFileSync(
    policy,
    `export default { appId: 'clinics',
  resolveRows() { return { clinic: true, patient: true, visit: true, scan: true }; },
  // Deletes under a row policy are the policy's to allow; this one allows any its rows reach.
  authorizeDeletedRecord() { return true; },
  resultReferences: { rename: () => [], admit: () => [], enroll: () => [], move: () => [], reassign: () => [], cancel: () => [] },
};
`,
  );
  const loaded = await loadApp(appDir);
  writeFileSync(join(appDir, 'authority.lock'), loaded.authority!.report);
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  process.env.BETTER_AUTH_SECRET = SESSION_SECRET;
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  try {
    (await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] })).close();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const accounts = new DatabaseSync(authPath);
  try {
    accounts
      .prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)')
      .run('ann', 'ann', 'ann@example.test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'staff');
  } finally {
    accounts.close();
  }
  const exclusions = [captureAuthStoreExclusion(business)];
  provisionSqliteApiTokenStore(authPath, { appId: 'clinics', storeId, exclusions });
  const registry = new Registry();
  registry.add({ id: 'data', name: 'data', url: business, writable: true, source: 'config' });
  const issue = async (label: string, expiresAt: number, rowScope?: { name: string; key: string }) => {
    try {
      const resources = await loadAppRuntimeResources(registry, loaded.app, 'data');
      const evidence = { connectionFor: resources.connectionFor, writableConnection: () => true, transactionalConnection: () => true };
      const declared = await loadBusinessCommands(commands);
      return issueSqliteApiCommandToken(
        authPath,
        loaded.app,
        resources.schema,
        declared,
        evidence,
        { storeId, exclusions, subjectId: 'ann', actorId: 'ann', roles: ['staff'], label, expiresAt, ...(rowScope ? { rowScope } : {}) },
        Date.now(),
      );
    } finally {
      await registry.closeAll();
    }
  };
  const revoke = (tokenId: string) =>
    revokeSqliteApiToken(authPath, { appId: 'clinics', storeId, exclusions, tokenId, expectedVersion: '1', actorId: 'ann' }, Date.now());
  const patients = () => {
    const check = new DatabaseSync(business, { readOnly: true });
    try {
      return check.prepare('SELECT id, clinic_id, name FROM patient ORDER BY id').all() as {
        id: number;
        clinic_id: number;
        name: string;
      }[];
    } finally {
      check.close();
    }
  };
  const audited = () => {
    const check = new DatabaseSync(business, { readOnly: true });
    try {
      return readSqliteReadAudit(check, { app: 'clinics', limit: 100 }).filter((row) => row.resource === 'visit');
    } finally {
      check.close();
    }
  };
  // Each rename's receipt, by idempotency key: the scope its first target's audit names, or null.
  const receiptScopes = () => {
    const check = new DatabaseSync(business, { readOnly: true });
    try {
      const rows = check
        .prepare(`SELECT idempotency_key, changes_json FROM __mistri_command_receipt WHERE command_id = 'rename' ORDER BY idempotency_key`)
        .all() as { idempotency_key: string; changes_json: string }[];
      return rows.map((row) => {
        const first = JSON.parse((JSON.parse(row.changes_json) as string[])[0]!) as unknown;
        return [row.idempotency_key, Array.isArray(first) ? null : (first as { scope: string }).scope];
      });
    } finally {
      check.close();
    }
  };
  const visits = () => {
    const check = new DatabaseSync(business, { readOnly: true });
    try {
      return check
        .prepare('SELECT id, patient_id FROM visit ORDER BY id')
        .all()
        .map((row) => ({ ...row })) as { id: number; patient_id: number }[];
    } finally {
      check.close();
    }
  };
  return { appDir, config, commands, policy, issue, revoke, patients, visits, audited, receiptScopes };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test('a $scope child reads, writes and lives inside one clinic, and ends with its parent', { timeout: 180000 }, async (t) => {
  const f = await clinics(t);
  const parent = await f.issue('parent', Date.now() + 30 * 60 * 1000);
  const served = await serveApi(t, f, 'clinics', ['--policy', f.policy]);
  await served.started;
  const get = async (token: string, path: string) => {
    const res = await fetch(`${served.base}${path}`, { headers: bearer(token) });
    return { status: res.status, body: await res.json() };
  };
  const ids = (body: { items: { id: string }[] }) => body.items.map((row) => row.id);
  const scope = async (token: string, body: unknown, init: RequestInit = {}) => {
    const res = await fetch(`${served.base}/$scope`, {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...init,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  // The parent reads every clinic.
  assert.deepEqual(ids((await get(parent.token, '/patient?sort=id')).body), ['1', '2', '3']);
  assert.deepEqual(ids((await get(parent.token, '/visit?sort=id')).body), ['1', '2', '3']);

  // The transport's word on the request itself.
  const wrongMethod = await fetch(`${served.base}/$scope`, { headers: bearer(parent.token) });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  await wrongMethod.body?.cancel();
  for (const bad of [
    '{',
    { scope: 'clinic' },
    { scope: 'ward', key: '1' },
    { scope: 'clinic', key: '1', ttl: 3601 },
    { scope: 'clinic', key: '1', extra: 1 },
    { scope: 'clinic', key: '9'.repeat(257) },
  ]) {
    const refused = await scope(parent.token, bad);
    assert.equal(refused.status, 400, JSON.stringify(bad));
    assert.equal(refused.body.error.code, 'invalid_request');
  }
  // A key that is not a row answers not-found, and mints nothing.
  const missing = await scope(parent.token, { scope: 'clinic', key: '999' });
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
  assert.equal(missing.body.error.code, 'not_found');

  // The child: clinic 1 alone, through its own column and through the patient a visit belongs to.
  const before = Date.now();
  const minted = await scope(parent.token, { scope: 'clinic', key: 1, ttl: 120 });
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  assert.deepEqual(minted.body.scope, { name: 'clinic', key: '1' });
  const expiresAt = Date.parse(minted.body.expiresAt);
  assert.ok(expiresAt > before && expiresAt <= Date.now() + 120 * 1000, minted.body.expiresAt);
  const child = minted.body.token as string;
  assert.deepEqual(ids((await get(child, '/clinic?sort=id')).body), ['1']);
  assert.deepEqual(ids((await get(child, '/patient?sort=id')).body), ['1', '3']);
  assert.deepEqual(ids((await get(child, '/visit?sort=id')).body), ['1', '3']);
  // The read audit names the scope the child read under, and no scope for its parent.
  assert.deepEqual(
    f.audited().map((row) => [row.scope ?? null, row.count]),
    [
      ['clinic:1', 2],
      [null, 3],
    ],
  );
  assert.equal((await get(child, '/patient/1')).status, 200);
  assert.equal((await get(child, '/patient/2')).status, 404);
  assert.equal((await get(child, '/visit/2')).status, 404);
  assert.equal((await get(child, '/clinic/2')).status, 404);

  // No life past the parent's, whatever it asks.
  const short = await f.issue('short', Date.now() + 60 * 1000);
  const capped = await scope(short.token, { scope: 'clinic', key: '1', ttl: 3600 });
  assert.equal(capped.status, 201, JSON.stringify(capped.body));
  assert.ok(Date.parse(capped.body.expiresAt) <= Date.now() + 60 * 1000, capped.body.expiresAt);
  // Fifteen minutes when it asks for nothing.
  const plain = await scope(parent.token, { scope: 'clinic', key: '2' });
  assert.equal(plain.status, 201);
  assert.ok(
    Date.parse(plain.body.expiresAt) <= Date.now() + 15 * 60 * 1000 && Date.parse(plain.body.expiresAt) > Date.now() + 14 * 60 * 1000,
  );

  // A scoped token is not scoped again — neither a child nor an operator's.
  assert.equal((await scope(child, { scope: 'clinic', key: '1' })).status, 409);
  const operator = await f.issue('operator', Date.now() + 30 * 60 * 1000, { name: 'clinic', key: '2' });
  const fixed = await scope(operator.token, { scope: 'clinic', key: '2' });
  assert.equal(fixed.status, 409);
  assert.equal(fixed.body.error.code, 'scope_fixed');
  assert.deepEqual(ids((await get(operator.token, '/patient?sort=id')).body), ['2']);

  // Writes. An update of a row outside the scope is not found; inside it, it applies.
  const run = async (token: string, path: string, key: string, body: object, ifMatch?: string) => {
    const res = await fetch(`${served.base}${path}`, {
      method: 'POST',
      headers: {
        ...bearer(token),
        'content-type': 'application/json',
        'idempotency-key': key,
        ...(ifMatch ? { 'if-match': ifMatch } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.text() };
  };
  const foreignPrepare = await fetch(`${served.base}/patient/2/commands/rename/v1/prepare`, { headers: bearer(child) });
  assert.equal(foreignPrepare.status, 404);
  await foreignPrepare.body?.cancel();
  const foreign = await run(child, '/patient/2/commands/rename/v1', 'scope-rename-0001', { name: 'Moved' }, '"0"');
  assert.notEqual(foreign.status, 200, foreign.body);
  assert.equal(f.patients().find((row) => row.id === 2)?.name, 'Bo');
  // The operator's clinic:2 token writes its own clinic's row.
  const theirs = await fetch(`${served.base}/patient/2/commands/rename/v1/prepare`, { headers: bearer(operator.token) });
  assert.equal(theirs.status, 200);
  await theirs.body?.cancel();
  const renamed = await run(
    operator.token,
    '/patient/2/commands/rename/v1',
    'scope-rename-0003',
    { name: 'Bo B.' },
    theirs.headers.get('etag')!,
  );
  assert.equal(renamed.status, 200, renamed.body);
  assert.match(renamed.body, /"scope":"clinic:2"/, 'the command is told the operator token scope');
  assert.equal(f.patients().find((row) => row.id === 2)?.name, 'Bo B.');
  const prepared = await fetch(`${served.base}/patient/1/commands/rename/v1/prepare`, { headers: bearer(child) });
  assert.equal(prepared.status, 200);
  await prepared.body?.cancel();
  const own = await run(child, '/patient/1/commands/rename/v1', 'scope-rename-0002', { name: 'Ada L.' }, prepared.headers.get('etag')!);
  assert.equal(own.status, 200, own.body);
  assert.match(own.body, /"scope":"clinic:1"/, 'the command is told the child scope');
  assert.equal(f.patients().find((row) => row.id === 1)?.name, 'Ada L.');

  // An insert must land in the scope: another clinic's is refused; the key fills a column left out.
  const elsewhere = await run(child, '/patient/commands/admit/v1', 'scope-admit-0001', { id: '10', clinic: '2', name: 'Di' });
  assert.equal(elsewhere.status, 422, elsewhere.body);
  assert.match(elsewhere.body, /out_of_scope/);
  const inside = await run(child, '/patient/commands/admit/v1', 'scope-admit-0002', { id: '11', clinic: '1', name: 'Ed' });
  assert.equal(inside.status, 200, inside.body);
  const filled = await run(child, '/patient/commands/enroll/v1', 'scope-enroll-0001', { id: '12', name: 'Flo' });
  assert.equal(filled.status, 200, filled.body);
  assert.deepEqual(
    f
      .patients()
      .filter((row) => row.id >= 10)
      .map((row) => ({ ...row })),
    [
      { id: 11, clinic_id: 1, name: 'Ed' },
      { id: 12, clinic_id: 1, name: 'Flo' },
    ],
  );

  // An unscoped token's command is told no scope.
  const open = await fetch(`${served.base}/patient/3/commands/rename/v1/prepare`, { headers: bearer(parent.token) });
  assert.equal(open.status, 200);
  await open.body?.cancel();
  const plainRename = await run(
    parent.token,
    '/patient/3/commands/rename/v1',
    'scope-rename-0004',
    { name: 'Cy C.' },
    open.headers.get('etag')!,
  );
  assert.equal(plainRename.status, 200, plainRename.body);
  assert.match(plainRename.body, /"scope":"none"/);
  // Each receipt names the scope its token wrote under, and an unscoped token's names none.
  assert.deepEqual(f.receiptScopes(), [
    ['scope-rename-0002', 'clinic:1'],
    ['scope-rename-0003', 'clinic:2'],
    ['scope-rename-0004', null],
  ]);

  // Revoking the parent ends the child, with no write of the child's own.
  f.revoke(parent.tokenId);
  assert.equal((await get(child, '/patient/1')).status, 401);
  assert.equal((await get(parent.token, '/patient/1')).status, 401);
  assert.equal((await get(operator.token, '/patient/2')).status, 200);
});

test('a $scope child stores the key the proving read found, and only a key that read finds', { timeout: 180000 }, async (t) => {
  const f = await clinics(t);
  const parent = await f.issue('parent', Date.now() + 30 * 60 * 1000);
  const served = await serveApi(t, f, 'clinics', ['--policy', f.policy]);
  await served.started;
  const mint = async (key: unknown) => {
    const res = await fetch(`${served.base}/$scope`, {
      method: 'POST',
      headers: { ...bearer(parent.token), 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'clinic', key }),
    });
    return { status: res.status, body: await res.json() };
  };
  // The item read takes a key as its row spells it, so another spelling of a clinic is not a clinic here.
  for (const key of ['01', '+1', ' 1', '1.0', '0x1']) assert.equal((await mint(key)).status, 404, JSON.stringify(key));
  // The scope carries the key as the proving read returned it.
  const minted = await mint(1);
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  assert.deepEqual(minted.body.scope, { name: 'clinic', key: '1' });
});

test('mint answers not-found when the proving read returns no key column, without touching the store', async () => {
  const { createApiScopeMint } = await import('../packages/mistri/src/server/api/apiScopeMint.js');
  const app = {
    id: 'clinics',
    api: { scopes: { clinic: { key: 'clinic', rows: { clinic: 'id' } } } },
  } as unknown as Parameters<typeof createApiScopeMint>[0]['app'];
  const answers: Record<string, string> = { whole: '{"id":7,"name":"North"}', bare: '{"name":"North"}', empty: '{"id":""}' };
  for (const [name, body] of Object.entries(answers)) {
    const mint = createApiScopeMint({
      app,
      // A store reached would throw: the answer would then be a thrown temporarily_unavailable, not a sent 404.
      auth: {} as never,
      observe: async () => ({ observed: {} }),
      readItem: async (_credential, _operation, _key, send) => {
        send({ status: 200, body });
        return undefined;
      },
    });
    let sent: { status: number } | undefined;
    const run = mint('twa1.x.y', { scope: 'clinic', key: '7' }, (answer) => {
      sent = answer;
    });
    if (name === 'whole') await assert.rejects(run, /temporarily_unavailable|unavailable/i);
    else {
      await run;
      assert.equal(sent?.status, 404, name);
    }
  }
});
test(
  'a scoped token reads includes, counts, filters, a view and files of its clinic alone, moves nothing out of it, and deletes inside it',
  { timeout: 180000 },
  async (t) => {
    const f = await clinics(t);
    const parent = await f.issue('parent', Date.now() + 30 * 60 * 1000);
    const child = (await f.issue('clinic-1', Date.now() + 30 * 60 * 1000, { name: 'clinic', key: '1' })).token;
    const served = await serveApi(t, f, 'clinics', ['--policy', f.policy]);
    await served.started;
    const get = async (token: string, path: string) => {
      const res = await fetch(`${served.base}${path}`, { headers: bearer(token) });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const ids = (body: { items: { id: string }[] }) => body.items.map((row) => row.id);
    const prepare = async (token: string, path: string) => {
      const res = await fetch(`${served.base}${path}/prepare`, { headers: bearer(token) });
      await res.body?.cancel();
      return { status: res.status, etag: res.headers.get('etag') };
    };
    const run = async (token: string, path: string, key: string, body: object, ifMatch?: string) => {
      const res = await fetch(`${served.base}${path}`, {
        method: 'POST',
        headers: {
          ...bearer(token),
          'content-type': 'application/json',
          'idempotency-key': key,
          ...(ifMatch ? { 'if-match': ifMatch } : {}),
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.text() };
    };

    // An include walks to the parent of a row in scope, and only such a row.
    const included = await get(child, '/visit?sort=id&fields=id,patient_id.name');
    assert.equal(included.status, 200, JSON.stringify(included.body));
    assert.deepEqual(ids(included.body), ['1', '3']);
    assert.deepEqual(
      included.body.items.map((row: Record<string, unknown>) => row['patient_id.name']),
      ['Ada', 'Cy'],
    );
    // A count is the scope's, and so is what a filter finds: another clinic's name, or its key, finds nothing.
    assert.deepEqual((await get(child, '/patient?count=true')).body.count, { value: 2, exact: true, capped: false });
    assert.equal((await get(parent.token, '/patient?count=true')).body.count.value, 3);
    assert.deepEqual(ids((await get(parent.token, '/patient?name=Bo')).body), ['2']);
    assert.deepEqual(ids((await get(child, '/patient?name=Bo')).body), []);
    const foreignKey = await get(child, '/patient?clinic_id=2&count=true');
    assert.deepEqual(ids(foreignKey.body), []);
    assert.equal(foreignKey.body.count.value, 0);
    assert.deepEqual(ids((await get(child, '/patient?name=Ada')).body), ['1']);
    // A view is the list it names, narrowed the same way.
    const view = await get(child, '/views/patients?sort=id');
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.deepEqual(ids(view.body), ['1', '3']);
    // A file resource's rows, through the path to their patient's clinic.
    assert.deepEqual(ids((await get(parent.token, '/scan?sort=id')).body), ['1', '2']);
    assert.deepEqual(ids((await get(child, '/scan?sort=id')).body), ['1']);
    assert.deepEqual(ids((await get(child, '/scan?filename=bo.png')).body), []);
    assert.equal((await get(child, '/scan/1')).status, 200);
    assert.equal((await get(child, '/scan/2')).status, 404);
    // A row-policy App serves no event feed (check refuses `api.events` there), to a scoped token or any other.
    assert.equal((await get(child, '/$events')).status, 404);
    assert.equal((await get(parent.token, '/$events')).status, 404);

    // An update may not carry a row out of the scope: not by its own column, nor by the hop its path walks.
    const moving = await prepare(child, '/patient/1/commands/move/v1');
    assert.equal(moving.status, 200);
    const moved = await run(child, '/patient/1/commands/move/v1', 'scope-move-00000001', { clinic: '2' }, moving.etag!);
    assert.notEqual(moved.status, 200, moved.body);
    assert.match(moved.body, /not_applied/);
    assert.equal(f.patients().find((row) => row.id === 1)?.clinic_id, 1);
    const reassigning = await prepare(child, '/visit/1/commands/reassign/v1');
    assert.equal(reassigning.status, 200);
    const away = await run(child, '/visit/1/commands/reassign/v1', 'scope-reassign-001', { patient: '2' }, reassigning.etag!);
    assert.notEqual(away.status, 200, away.body);
    assert.match(away.body, /not_applied/);
    assert.equal(f.visits().find((row) => row.id === 1)?.patient_id, 1);
    // Inside the scope, the same hop moves.
    const within = await run(child, '/visit/1/commands/reassign/v1', 'scope-reassign-002', { patient: '3' }, reassigning.etag!);
    assert.equal(within.status, 200, within.body);
    assert.equal(f.visits().find((row) => row.id === 1)?.patient_id, 3);
    // A delete: another clinic's visit is not found; one of its own goes.
    assert.equal((await prepare(child, '/visit/2/commands/cancel/v1')).status, 404);
    const foreign = await run(child, '/visit/2/commands/cancel/v1', 'scope-cancel-000001', {}, '"0"');
    assert.notEqual(foreign.status, 200, foreign.body);
    assert.ok(f.visits().some((row) => row.id === 2));
    const leaving = await prepare(child, '/visit/1/commands/cancel/v1');
    assert.equal(leaving.status, 200);
    const cancelled = await run(child, '/visit/1/commands/cancel/v1', 'scope-cancel-000002', {}, leaving.etag!);
    assert.equal(cancelled.status, 200, cancelled.body);
    assert.equal(
      f.visits().some((row) => row.id === 1),
      false,
    );
    // The unscoped token's move is the grants' to judge, and they allow it.
    const open = await prepare(parent.token, '/patient/3/commands/move/v1');
    const opened = await run(parent.token, '/patient/3/commands/move/v1', 'scope-move-00000002', { clinic: '2' }, open.etag!);
    assert.equal(opened.status, 200, opened.body);
    assert.equal(f.patients().find((row) => row.id === 3)?.clinic_id, 2);
  },
);
