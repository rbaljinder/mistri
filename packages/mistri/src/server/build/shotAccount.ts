/**
 * `shot --as <email>` and `grade --as <email>`: the pages as an account that already exists sees them — its own
 * rows under a row policy, its own name in the menu — rather than a fresh account of a role.
 *
 * The run still serves over its own temporary config directory: the account's store is copied into it as a
 * snapshot (`VACUUM INTO`, read-only on the original), so nothing the run does — a session, a sign-in counted — is
 * written where the account lives. The store is the one `mistri dev` keeps in `<app>/.mistri/`, else the one a
 * plain start of the App keeps; a store the App names (`auth.store`) is a deployment's, and is refused.
 *
 * The password is read from MISTRI_AS_PASSWORD and from nowhere else: never a flag, so it is not in a shell's
 * history or a process listing, and never printed.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LoadedApp } from '../app/apps.js';
import { hashPassword } from 'better-auth/crypto';
import { appAuthStore } from '../auth/auth.js';
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';

/** The variable `--as <email>` reads the account's password from. */
const AS_PASSWORD = 'MISTRI_AS_PASSWORD';

/** Whether `--as` names an account (an email) rather than a role. */
export const namesAccount = (as: string) => as.includes('@');

/**
 * The account's store, copied into the run's config directory where a start of the App over `xdg` reads it, and
 * the email and password to sign in with. Throws (the caller's refusal) with what to do instead.
 */
export function shotAccount(
  loaded: LoadedApp,
  email: string,
  xdg: string,
  env: NodeJS.ProcessEnv,
  refuse: (why: string) => never,
): { email: string; password: string } {
  const app = loaded.app;
  if (!app.auth) refuse(`--as: "${app.name}" has no sign-in, so every page is already what a reader sees.`);
  if (!(app.auth.providers ?? ['email']).includes('email')) refuse('--as signs in by email and password, which this App does not offer.');
  if (app.auth.store)
    refuse(
      `--as ${email}: "${app.name}" keeps its accounts in the store it names (auth.store), a deployment's; shot signs in only to the store mistri dev or a local start keeps.`,
    );
  const password = env[AS_PASSWORD];
  if (!password) refuse(`--as ${email} signs in with the password in ${AS_PASSWORD}: set it in the environment, not on the command line.`);
  const stores = localStores(loaded, env);
  const found = stores.find((file) => existsSync(file) && holds(file, email));
  if (!found)
    refuse(
      `--as ${email}: no account with that email in ${app.name}'s accounts (${stores.join(', ')}). Sign it up there first, or name a role.`,
    );
  snapshot(loaded, found, xdg, env);
  return { email, password };
}

/**
 * `shot --as <role>` and `grade --as <role>` (AG5): an account of that role the App's own accounts already hold,
 * signed in inside a snapshot of its store, so the pictures show a person with rows of their own rather than a
 * fresh account that owns nothing. The earliest made of that role (not banned) is the one; its password is set to
 * a random one in the copy alone, never in the store it came from, and never printed. Nothing, where no local store
 * holds such an account (the caller then makes a fresh one, and says so).
 *
 * Where several accounts hold the role, the one the App's people table names comes first (`linked`: the emails
 * `auth.me` finds a row for, lowercase): an account with no person row is a name in the menu and no rows of its own,
 * the very picture this is meant to avoid. The earliest made is the tiebreak among the linked and among the unlinked.
 */
export async function shotRoleAccount(
  loaded: LoadedApp,
  role: string,
  xdg: string,
  env: NodeJS.ProcessEnv,
  linked: ReadonlySet<string> = new Set(),
): Promise<{ email: string; password: string } | undefined> {
  for (const file of localStores(loaded, env)) {
    if (!existsSync(file)) continue;
    const accounts = accountsOfRole(file, role);
    const found = accounts.find((account) => linked.has(account.email.toLowerCase())) ?? accounts[0];
    if (!found) continue;
    const copy = snapshot(loaded, file, xdg, env);
    const password = randomBytes(18).toString('base64url');
    const hash = await hashPassword(password);
    const db = new DatabaseSync(copy);
    try {
      const now = new Date().toISOString();
      const columns = (table: string) => (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name);
      const credential = db.prepare(`SELECT id FROM "account" WHERE "userId" = ? AND "providerId" = 'credential' LIMIT 1`).get(found.id) as
        | { id: string }
        | undefined;
      if (credential) db.prepare('UPDATE "account" SET password = ?, "updatedAt" = ? WHERE id = ?').run(hash, now, credential.id);
      else {
        /* An account that signs in only through a provider gets a password in the copy, so the run can sign in;
           Better Auth names a local credential's issuer `local:credential`. */
        const issuer = columns('account').includes('issuer');
        db.prepare(
          `INSERT INTO "account" (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt"${issuer ? ', issuer' : ''}) VALUES (?, ?, 'credential', ?, ?, ?, ?${issuer ? ", 'local:credential'" : ''})`,
        ).run(randomUUID(), found.id, found.id, hash, now, now);
      }
      /* A second factor would stop the run at its prompt: the copy's account signs in with the password alone. */
      if (columns('user').includes('twoFactorEnabled')) db.prepare('UPDATE "user" SET "twoFactorEnabled" = 0 WHERE id = ?').run(found.id);
    } finally {
      db.close();
    }
    return { email: found.email, password };
  }
  return undefined;
}

/** The most person rows read to find who an account is: a people table, not a data set. */
const PEOPLE_MOST = 10_000;

/**
 * The sign-in emails (lowercase) the App's people table holds (`auth.me`: the table people are rows of and its email
 * column), read from the business database the run serves over. Empty where the App names no such table, keeps
 * accounts per tenant (the column holds an account id there), or the table cannot be read: the earliest account
 * then stands, as it did before this preference.
 */
export async function personEmails(app: LoadedApp['app'], adapter: Pick<Adapter, 'query'>): Promise<Set<string>> {
  const me = app.auth?.me;
  if (!me || app.auth?.rows === 'tenant') return new Set();
  try {
    const found = await adapter.query({ table: me.from, columns: [me.column], limit: PEOPLE_MOST, offset: 0 });
    const emails = new Set<string>();
    for (const row of found.rows) {
      const value = (row as Record<string, unknown>)[me.column];
      if (typeof value === 'string' && value) emails.add(value.toLowerCase());
    }
    return emails;
  } catch {
    return new Set();
  }
}

/** The stores a local run of the App keeps its accounts in: mistri dev's, then a plain start's. */
function localStores(loaded: LoadedApp, env: NodeJS.ProcessEnv): string[] {
  const dir = loaded.dir ?? dirname(loaded.path);
  return [appAuthStore(loaded, { ...env, XDG_CONFIG_HOME: join(dir, '.mistri', 'config') }), appAuthStore(loaded, env)];
}

/** The store copied into the run's config directory (`VACUUM INTO`, read-only on the original); its path. */
function snapshot(loaded: LoadedApp, found: string, xdg: string, env: NodeJS.ProcessEnv): string {
  const copy = appAuthStore(loaded, { ...env, XDG_CONFIG_HOME: xdg });
  mkdirSync(dirname(copy), { recursive: true });
  const source = new DatabaseSync(found, { readOnly: true });
  try {
    source.prepare('VACUUM INTO ?').run(copy);
  } finally {
    source.close();
  }
  return copy;
}

/** The accounts holding `role` (Better Auth keeps several as `a,b`), not banned, earliest made first. */
function accountsOfRole(file: string, role: string): Array<{ id: string; email: string }> {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return db
      .prepare(
        `SELECT id, email FROM "user" WHERE instr(',' || replace(coalesce(role, ''), ' ', '') || ',', ?) > 0 AND coalesce(banned, 0) = 0 ORDER BY "createdAt", rowid`,
      )
      .all(`,${role},`) as Array<{ id: string; email: string }>;
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function holds(file: string, email: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return db.prepare('SELECT 1 FROM "user" WHERE lower(email) = ? LIMIT 1').get(email.toLowerCase()) !== undefined;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
