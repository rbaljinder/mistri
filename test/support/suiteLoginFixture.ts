/** A Keystone-shaped suite over SQLite, for suite login: Lender at the root,
 * Dealer, Leads and Customer mounted beside it, one shared identity, and the
 * landing rules Keystone would write. Keystone itself needs PostgreSQL; this
 * keeps its shape (who may open which App) and nothing else. Every call owns a
 * mkdtemp directory and a port of its own, so suites never share state. */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startConfiguredSuite } from '../../packages/mistri/src/server/cli/suiteCommand.js';
import { changeSuiteGrant } from '../../packages/mistri/src/server/cli/suiteGrant.js';

export const SUITE_LOGIN_PASSWORD = 'suite-login-password-long-enough';
export const SUITE_LOGIN_APPS = {
  lender: { name: 'Lender', mount: '/', roles: ['officer', 'auditor'] },
  dealer: { name: 'Dealer', mount: '/dealer', roles: ['manager', 'agent'], logo: 'car' },
  leads: { name: 'Leads', mount: '/leads', roles: ['agent'] },
  customer: { name: 'Customer', mount: '/customer', roles: ['borrower'] },
} as const;
export type SuiteLoginApp = keyof typeof SUITE_LOGIN_APPS;
/** Each account's grants: an officer, a dealer manager, a dealer agent who also
 * works leads, a borrower, and an account no App has granted anything. */
export const SUITE_LOGIN_ACCOUNTS = {
  officer: { lender: ['officer'] },
  manager: { dealer: ['manager'], leads: ['agent'] },
  agent: { dealer: ['agent'], leads: ['agent'] },
  borrower: { customer: ['borrower'] },
  nobody: {},
} as const satisfies Record<string, Partial<Record<SuiteLoginApp, readonly string[]>>>;
export type SuiteLoginAccount = keyof typeof SUITE_LOGIN_ACCOUNTS;
export const noteOf = (app: SuiteLoginApp) => `${SUITE_LOGIN_APPS[app].name} fixture note`;
export const homeOf = (app: SuiteLoginApp) => (SUITE_LOGIN_APPS[app].mount === '/' ? '' : SUITE_LOGIN_APPS[app].mount);

export async function startSuiteLogin() {
  const dir = mkdtempSync(join(tmpdir(), 'tw-suite-login-'));
  let running: Awaited<ReturnType<typeof startConfiguredSuite>> | undefined;
  try {
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
    const apps = [];
    for (const [id, spec] of Object.entries(SUITE_LOGIN_APPS) as [SuiteLoginApp, (typeof SUITE_LOGIN_APPS)[SuiteLoginApp]][]) {
      const home = join(dir, id);
      mkdirSync(home);
      const db = new DatabaseSync(join(home, 'business.db'));
      try {
        db.exec('CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
        db.prepare('INSERT INTO note VALUES (1, ?)').run(noteOf(id));
      } finally {
        db.close();
      }
      writeFileSync(
        join(home, 'app.json'),
        JSON.stringify({
          id,
          name: spec.name,
          resources: { note: {} },
          ...('logo' in spec ? { ui: { logo: spec.logo } } : {}),
          auth: { providers: ['email'], roles: Object.fromEntries(spec.roles.map((role) => [role, { read: ['note'] }])) },
          views: { notes: { kind: 'list', from: 'note', show: ['body'] } },
          home: 'notes',
        }),
      );
      writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: join(home, 'business.db') }] }));
      apps.push({ id, directory: `./${id}`, config: `./${id}/connections.json`, mount: spec.mount });
    }
    const file = join(dir, 'suite.json');
    const environment = { SECRET: 'suite-login-fixture-secret-longer-than-thirty-two-characters' };
    writeFileSync(
      file,
      JSON.stringify({
        port,
        apps,
        identity: {
          id: 'keystone-login',
          name: 'Keystone',
          store: './identity.db',
          grants: './grants.db',
          environment: { BETTER_AUTH_SECRET: 'SECRET' },
          landing: [{ app: 'lender', roles: ['officer'] }, { app: 'dealer', roles: ['manager'] }, { app: 'customer' }],
        },
      }),
    );
    running = await startConfiguredSuite(file, environment);
    const origin = running.publicURL;
    const accounts = {} as Record<SuiteLoginAccount, { id: string; email: string; cookie: string }>;
    for (const [name, grants] of Object.entries(SUITE_LOGIN_ACCOUNTS) as [
      SuiteLoginAccount,
      Partial<Record<SuiteLoginApp, readonly string[]>>,
    ][]) {
      const email = `${name}@example.test`;
      const response = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ name, email, password: SUITE_LOGIN_PASSWORD }),
      });
      if (response.status !== 200) throw new Error(`Fixture sign-up failed: ${response.status} ${await response.text()}`);
      const id = ((await response.json()) as { user: { id: string } }).user.id;
      const cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      for (const [appId, roles] of Object.entries(grants))
        await changeSuiteGrant(file, { appId, subjectId: id, roles: roles!, expectedRevision: 0 }, environment);
      accounts[name] = { id, email, cookie };
    }
    return {
      origin,
      file,
      environment,
      accounts,
      chooser: `${origin}/_mistri/apps`,
      async close() {
        try {
          await running?.close();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await running?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    throw error;
  }
}
export type SuiteLogin = Awaited<ReturnType<typeof startSuiteLogin>>;
