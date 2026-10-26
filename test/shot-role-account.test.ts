/** `shot --as <role>` and `grade --as <role>` (AG5): the run signs in as the earliest account of that role the
 * App's own local store holds, inside a copy of it, so the pages show a person with rows of their own. The copy's
 * session reads exactly that account's rows under the App's row policy; the store it came from is byte-for-byte
 * what it was; a role no account holds is the caller's fallback to a fresh account. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { hashPassword } from 'better-auth/crypto';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { appAuthStore, createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { personEmails, shotRoleAccount } from '../packages/mistri/src/server/build/shotAccount.js';
import { SESSION_SECRET, serveCli } from './appApiCli.js';

async function desk(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-shot-role-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const business = join(directory, 'business.db');
  const db = new DatabaseSync(business);
  try {
    db.exec(
      'CREATE TABLE ticket(id INTEGER PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL); ' +
        "INSERT INTO ticket VALUES (1, 'ann', 'Printer'), (2, 'bob', 'Laptop'), (3, 'cy', 'Badge')",
    );
  } finally {
    db.close();
  }
  const appDir = join(directory, 'app');
  mkdirSync(appDir);
  const config = join(directory, 'mistri.json');
  const policy = join(directory, 'policy.mjs');
  writeFileSync(
    join(appDir, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      connection: 'data',
      resources: { ticket: {} },
      auth: { rows: 'policy', roles: { agent: { read: ['ticket'] }, lead: { read: ['ticket'] } } },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    }),
  );
  writeFileSync(config, JSON.stringify({ connections: [{ id: 'data', name: 'data', url: business }] }));
  writeFileSync(
    policy,
    `export default { appId: 'desk', resolveRows(principal) { return { ticket: { groups: [[{ column: 'owner', op: '=', value: principal.id }]] } }; } };\n`,
  );
  const loaded = await loadApp(appDir);
  writeFileSync(join(appDir, 'authority.lock'), loaded.authority!.report);
  // The App's own accounts, where a plain start of it keeps them.
  const xdg = join(directory, 'xdg');
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: xdg, BETTER_AUTH_SECRET: SESSION_SECRET };
  delete env.MISTRI_AUTH_ADMIN_EMAIL;
  delete env.MISTRI_AUTH_ADMIN_PASSWORD;
  const names = ['XDG_CONFIG_HOME', 'BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) {
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
  try {
    (await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'], environment: env })).close();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const store = appAuthStore(loaded, env);
  const accounts = new DatabaseSync(store);
  try {
    // bob is the earliest agent but banned; ann the earliest one signed in as; cy a later agent.
    const people: Array<[string, string, string, number]> = [
      ['bob', '2025-12-01T00:00:00.000Z', 'agent', 1],
      ['cy', '2026-03-01T00:00:00.000Z', 'agent', 0],
      ['ann', '2026-01-01T00:00:00.000Z', 'lead,agent', 0],
    ];
    for (const [id, made, role, banned] of people)
      accounts
        .prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,?)')
        .run(id, id, `${id}@example.test`, made, made, role, banned);
    accounts
      .prepare(
        `INSERT INTO "account" (id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES (?,?,'credential',?,?,?,?)`,
      )
      .run('ann-credential', 'ann', 'ann', await hashPassword('the real password'), '2026-01-01', '2026-01-01');
  } finally {
    accounts.close();
  }
  return { directory, appDir, config, policy, loaded, env, store };
}

test('--as <role> signs in as the earliest account of that role, in a copy, and reads its own rows', { timeout: 120_000 }, async (t) => {
  const f = await desk(t);
  const before = readFileSync(f.store);
  const run = join(f.directory, 'run');
  const account = await shotRoleAccount(f.loaded, 'agent', run, f.env);
  assert.ok(account, 'an agent account is there to sign in as');
  assert.equal(account.email, 'ann@example.test');
  assert.notEqual(account.password, 'the real password');
  assert.deepEqual(readFileSync(f.store), before, "the App's own store is untouched");

  // The run's server over the copy, as shot serves it: the account signs in and reads ann's rows only.
  const base = await serveCli(t, ['--config', f.config, '--app', f.appDir, '--policy', f.policy], { XDG_CONFIG_HOME: run });
  const origin = base;
  const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(account),
  });
  assert.equal(signIn.status, 200, await signIn.clone().text());
  const cookie = signIn.headers
    .getSetCookie()
    .map((each) => each.split(';')[0])
    .join('; ');
  const rows = await fetch(`${base}/api/query`, {
    method: 'POST',
    headers: { origin, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ table: 'ticket', limit: 10, offset: 0 }),
  });
  const body = (await rows.json()) as { rows: Array<{ id: number; owner: string }> };
  assert.equal(rows.status, 200, JSON.stringify(body));
  assert.deepEqual(
    body.rows.map((row) => row.owner),
    ['ann'],
  );
  // The real password still signs in nowhere but the original; the original is byte-for-byte what it was.
  assert.deepEqual(readFileSync(f.store), before, "the App's own store is untouched after the run");
});

test('--as <role> that no account holds leaves the fresh account to the caller, and copies nothing', async (t) => {
  const f = await desk(t);
  const before = readFileSync(f.store);
  const run = join(f.directory, 'run');
  assert.equal(await shotRoleAccount(f.loaded, 'admin', run, f.env), undefined);
  // A name inside a role's ("lea" in "lead") is not that role.
  assert.equal(await shotRoleAccount(f.loaded, 'lea', run, f.env), undefined);
  assert.deepEqual(readFileSync(f.store), before);
  assert.throws(() => readFileSync(appAuthStore(f.loaded, { ...f.env, XDG_CONFIG_HOME: run })), /ENOENT/);
});

test('--as <role> prefers the account the people table names, then the earliest, and reads nobody from a table it cannot', async (t) => {
  const f = await desk(t);
  const run = (name: string) => join(f.directory, name);
  // cy is a later agent than ann, but the only one with a person row: the one to be, with the email matched in any case.
  assert.equal((await shotRoleAccount(f.loaded, 'agent', run('a'), f.env, new Set(['cy@example.test'])))?.email, 'cy@example.test');
  // Both linked, or neither: the earliest made is the tiebreak, as it was.
  assert.equal(
    (await shotRoleAccount(f.loaded, 'agent', run('b'), f.env, new Set(['cy@example.test', 'ann@example.test'])))?.email,
    'ann@example.test',
  );
  assert.equal((await shotRoleAccount(f.loaded, 'agent', run('c'), f.env, new Set(['nobody@example.test'])))?.email, 'ann@example.test');
  // A banned account is no choice, linked or not.
  assert.equal((await shotRoleAccount(f.loaded, 'agent', run('d'), f.env, new Set(['bob@example.test'])))?.email, 'ann@example.test');

  // The emails come from the table auth.me names, lowercase; an App with none, or a table that cannot be read, names nobody.
  const asked: unknown[] = [];
  const adapter = {
    async query(request: unknown) {
      asked.push(request);
      return { rows: [{ email: 'Cy@Example.test' }, { email: null }, { email: '' }] };
    },
  };
  const app = { auth: { me: { from: 'person', column: 'email' } } } as never;
  assert.deepEqual([...(await personEmails(app, adapter as never))], ['cy@example.test']);
  assert.deepEqual((asked[0] as { table: string; columns: string[] }).columns, ['email']);
  assert.equal((await personEmails({ auth: {} } as never, adapter as never)).size, 0);
  assert.equal(
    (await personEmails({ auth: { rows: 'tenant', me: { from: 'person', column: 'account' } } } as never, adapter as never)).size,
    0,
  );
  const broken = { query: () => Promise.reject(new Error('no such table')) };
  assert.equal((await personEmails(app, broken as never)).size, 0);
});
