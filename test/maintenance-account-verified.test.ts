/**
 * `createAppAccounts` and an address nobody proved (F19). Under open sign-up an unverified account is signed in as
 * nobody in particular: a row policy that finds rows by the account's email finds none. The operator who makes an
 * account for an address that is theirs to vouch for (a development store's throwaway one, a person they know)
 * asserts it: `{ verified: true }` makes the account verified and the account trail's row says so. The default stays
 * unverified, because nothing proved the address.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { appAuthStore } from '../packages/mistri/src/server/auth/auth.js';
import { createAppAccounts, TenantMaintenanceRefusal } from '../packages/mistri/src/server/tenant/tenantMaintenance.js';
import { SESSION_SECRET, serveCli } from './appApiCli.js';

async function household(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-verified-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const business = join(directory, 'business.db');
  const db = new DatabaseSync(business);
  try {
    db.exec(
      'CREATE TABLE ticket(id INTEGER PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL); ' +
        "INSERT INTO ticket VALUES (1, 'ann@example.test', 'Printer'), (2, 'bob@example.test', 'Laptop')",
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
      // Open sign-up: an address nobody proved is signed in as nobody (auth.ts `emailUnproven`).
      auth: { signUp: 'open', rows: 'policy', roles: { agent: { read: ['ticket'] } } },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    }),
  );
  writeFileSync(config, JSON.stringify({ connections: [{ id: 'data', name: 'data', url: business }] }));
  // The household is found by the account's email, as an email-scoped policy finds it.
  writeFileSync(
    policy,
    `export default { appId: 'desk', resolveRows(principal) { return { ticket: { groups: [[{ column: 'owner', op: '=', value: principal.email ?? '' }]] } }; } };\n`,
  );
  const loaded = await loadApp(appDir);
  writeFileSync(join(appDir, 'authority.lock'), loaded.authority!.report);
  const xdg = join(directory, 'xdg');
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: xdg, BETTER_AUTH_SECRET: SESSION_SECRET };
  return { directory, appDir, config, policy, loaded, env, xdg };
}

/** The maintenance step as an operator runs it on this machine: the App's accounts, where a start of it keeps them. */
async function asOperator<T>(env: NodeJS.ProcessEnv, work: () => Promise<T>): Promise<T> {
  const saved = [process.env.XDG_CONFIG_HOME, process.env.BETTER_AUTH_SECRET];
  Object.assign(process.env, env);
  try {
    return await work();
  } finally {
    for (const [name, value] of [
      ['XDG_CONFIG_HOME', saved[0]],
      ['BETTER_AUTH_SECRET', saved[1]],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('createAppAccounts is unverified unless the operator asserts { verified: true }, and the trail says which', async (t) => {
  const f = await household(t);
  const password = 'a-long-password-1';
  await asOperator(f.env, async () => {
    await createAppAccounts(f.appDir, [{ email: 'ann@example.test', name: 'Ann', password }]);
    await createAppAccounts(f.appDir, [{ email: 'bob@example.test', name: 'Bob', password }], { verified: true });
    // Only ever an assertion: `false` and anything else are refused before an account is made.
    for (const options of [{ verified: false }, { verified: 'yes' }, null])
      await assert.rejects(
        createAppAccounts(f.appDir, [{ email: 'cy@example.test', name: 'Cy', password }], options as never),
        TenantMaintenanceRefusal,
      );
  });
  const store = new DatabaseSync(appAuthStore(f.loaded, f.env), { readOnly: true });
  t.after(() => store.close());
  const verified = Object.fromEntries(
    (store.prepare('SELECT email, emailVerified FROM "user" ORDER BY email').all() as Array<{ email: string; emailVerified: number }>).map(
      (row) => [row.email, row.emailVerified],
    ),
  );
  assert.deepEqual(verified, { 'ann@example.test': 0, 'bob@example.test': 1 });
  const trail = Object.fromEntries(
    (
      store.prepare('SELECT targetEmail, principal, after FROM "accountAudit"').all() as Array<{
        targetEmail: string;
        principal: string;
        after: string;
      }>
    ).map((row) => [row.targetEmail, { principal: row.principal, verified: JSON.parse(row.after).verified }]),
  );
  assert.deepEqual(trail, {
    'ann@example.test': { principal: 'maintenance', verified: undefined },
    'bob@example.test': { principal: 'maintenance', verified: true },
  });
});

test(
  'an email-scoped row policy finds the verified account its household, and the unverified one nobody',
  { timeout: 120_000 },
  async (t) => {
    const f = await household(t);
    const password = 'a-long-password-1';
    await asOperator(f.env, async () => {
      await createAppAccounts(f.appDir, [{ email: 'ann@example.test', name: 'Ann', password }]);
      await createAppAccounts(f.appDir, [{ email: 'bob@example.test', name: 'Bob', password }], { verified: true });
    });
    // The store gave them its default native role, which reads nothing; the household is about rows, so grant the role.
    const store = new DatabaseSync(appAuthStore(f.loaded, f.env));
    try {
      store.exec(`UPDATE "user" SET role = 'agent'`);
    } finally {
      store.close();
    }
    const base = await serveCli(t, ['--config', f.config, '--app', f.appDir, '--policy', f.policy], f.env as Record<string, string>);
    const owners = async (email: string) => {
      const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      assert.equal(signIn.status, 200, await signIn.clone().text());
      const cookie = signIn.headers
        .getSetCookie()
        .map((each) => each.split(';')[0])
        .join('; ');
      const rows = await fetch(`${base}/api/query`, {
        method: 'POST',
        headers: { origin: base, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ table: 'ticket', limit: 10, offset: 0 }),
      });
      const body = (await rows.json()) as { rows?: Array<{ owner: string }> };
      assert.equal(rows.status, 200, JSON.stringify(body));
      return body.rows!.map((row) => row.owner);
    };
    assert.deepEqual(await owners('bob@example.test'), ['bob@example.test'], 'the asserted address is the household it names');
    // Before the assertion existed every maintenance account was like this one: signed in, and nobody's.
    assert.deepEqual(await owners('ann@example.test'), [], 'an address nobody proved finds no rows under open sign-up');
  },
);
