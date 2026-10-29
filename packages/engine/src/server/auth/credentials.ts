/**
 * Where connection secrets live, and — more importantly — where they do not.
 *
 * The rule this file exists to enforce: **tablewalk does not invent its own
 * secret storage.** Rolling encryption for a local dev tool means inventing a
 * key-management scheme, and a key sitting next to the ciphertext it protects
 * is obfuscation with extra steps. Every option below either delegates to
 * something that already solves the problem (the OS keychain, the
 * environment) or is explicit about being plaintext-on-disk with the same
 * permission discipline ssh and psql use.
 *
 * Four ways to supply a password, in the order they are tried:
 *
 *   1. `${VAR}` in the URL, expanded from the environment. Nothing is stored.
 *   2. The OS keychain, addressed by connection name. The secret never
 *      touches a tablewalk file.
 *   3. A credentials file at 0600, refused if the mode is wider.
 *   4. Inline in the URL — supported because it is what people paste, and
 *      warned about because it ends up in shell history and config files.
 *
 * Whatever the source, the resolved URL stays in the server process. The
 * browser is only ever sent a redacted form; `redact` in connections.ts is
 * the single point that produces it and there are tests asserting no password
 * survives the trip.
 */
import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { product } from '../product.js';

const run = promisify(execFile);

/** Where the credentials file lives when one is used at all. */
export function credentialsPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, product(), 'credentials.json');
}

/** The keychain service name: the product's, one namespace per product, addressed by connection name. */
const keychainService = (): string => product();

/* ---------- 1. environment expansion ---------- */

/**
 * Expand `${VAR}` and `$VAR` in a connection string.
 *
 * This is the recommended option, and the only one where the secret is never
 * written anywhere tablewalk controls:
 *
 *   { "name": "prod", "url": "postgres://app:${PROD_DB_PASSWORD}@db/app" }
 *
 * An unset variable is an error rather than an empty expansion. Silently
 * producing `postgres://app:@db/app` would send an empty password and fail
 * with an authentication error that says nothing about the real cause.
 */
export function expandEnv(url: string, env: NodeJS.ProcessEnv = process.env): string {
  return url.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, bare) =>
    environmentValue(braced ?? bare, env),
  );
}

/**
 * Expand only the `${NAME}` form. An authentication store URL is read this
 * way, and it is the only form its documentation names: there a bare `$` is
 * literal, so a password containing `$abc` is not mistaken for a reference
 * to an unset variable (and refused) or, worse, to a set one.
 */
export function expandEnvReferences(url: string, env: NodeJS.ProcessEnv = process.env): string {
  return url.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => environmentValue(name, env));
}

function environmentValue(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (value === undefined) {
    throw new Error(`Connection references $${name}, which is not set. Export it, or remove it from the connection.`);
  }
  return value;
}

/** True when a URL carries a literal password rather than a reference. */
export function hasInlinePassword(url: string): boolean {
  try {
    return Boolean(new URL(url).password);
  } catch {
    return false;
  }
}

/* ---------- 2. the OS keychain ---------- */

/**
 * Read a password from the platform keychain.
 *
 * macOS only for now, through the `security` binary that ships with the OS —
 * no dependency, no native module, and the secret is protected by the same
 * thing protecting everything else on the machine. Linux and Windows return
 * undefined and fall through to the file, which is honest: claiming keychain
 * support and quietly storing plaintext would be worse than not offering it.
 */
/* `MISTRI_NO_KEYCHAIN=1` pretends there is none: the test suite sets it
   so `npm test` never writes to the developer's real keychain (and never
   hangs on a locked one), and it is a way out for a macOS box whose
   keychain is not the place a team keeps its passwords. */
const keychainOff = () => process.env.MISTRI_NO_KEYCHAIN === '1';

async function keychainGet(account: string): Promise<string | undefined> {
  if (platform() !== 'darwin' || keychainOff()) return undefined;
  try {
    const { stdout } = await run('security', ['find-generic-password', '-s', keychainService(), '-a', account, '-w']);
    return stdout.trim() || undefined;
  } catch {
    // Not found, or the user declined the prompt: fall through to the file.
    return undefined;
  }
}

export async function keychainSet(account: string, secret: string): Promise<boolean> {
  if (platform() !== 'darwin' || keychainOff()) return false;
  try {
    // -U updates in place rather than erroring when the item already exists.
    await run('security', ['add-generic-password', '-U', '-s', keychainService(), '-a', account, '-w', secret]);
    return true;
  } catch {
    return false;
  }
}

export async function keychainDelete(account: string): Promise<void> {
  if (platform() !== 'darwin') return;
  try {
    await run('security', ['delete-generic-password', '-s', keychainService(), '-a', account]);
  } catch {
    /* Already gone. */
  }
}

export const keychainAvailable = (): boolean => platform() === 'darwin';

/* ---------- 3. the credentials file ---------- */

interface CredentialsFile {
  [connectionName: string]: string;
}

/**
 * Read the credentials file, refusing it if anyone but the owner can read it.
 *
 * The permission check is the whole point. It is what `ssh` does to private
 * keys and what `psql` does to `.pgpass`, and it catches the realistic
 * mistake: a file created correctly, then committed, copied or synced with
 * permissions that no longer match the intent. Refusing loudly is better than
 * reading it and leaving the user believing it was safe.
 */
export async function readCredentials(path = credentialsPath()): Promise<CredentialsFile> {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    return {}; // No file is the normal case, not an error.
  }
  if (mode & 0o077) {
    throw new Error(`${path} is readable by others (mode ${mode.toString(8)}). ` + `Run: chmod 600 ${path}`);
  }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    throw new Error('expected an object of name → password');
  } catch (err) {
    throw new Error(`${path} could not be read: ${(err as Error).message}`);
  }
}

export async function writeCredential(name: string, secret: string, path = credentialsPath()): Promise<void> {
  const existing = await readCredentials(path).catch(() => ({}));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  /* Written with the restrictive mode from the start rather than chmod-ed
     afterwards — between a default-mode write and the chmod there is a window
     where the secret is world-readable. */
  await writeFile(path, `${JSON.stringify({ ...existing, [name]: secret }, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/* ---------- resolution ---------- */

interface ResolvedConnection {
  url: string;
  /** Where the password came from, for the UI to report honestly. */
  source: 'none' | 'inline' | 'environment' | 'keychain' | 'file';
  warning?: string;
}

/**
 * Turn a stored connection into a usable URL.
 *
 * Order matters and is deliberate: the environment wins because it is the
 * most explicit, then the keychain because it is the best-protected, then the
 * file. An inline password is used as-is but reported, so the UI can say what
 * it is doing rather than leaving the user to guess.
 */
export async function resolveConnection(
  name: string,
  storedUrl: string,
  options: { credentialsFile?: string; secrets?: boolean; environment?: NodeJS.ProcessEnv } = {},
): Promise<ResolvedConnection> {
  /* `secrets: false` resolves nothing: no environment expansion, no keychain,
     no credentials file — the URL is used exactly as written, inline password
     or none. It is the form for a URL that arrived over the network rather
     than from this machine's config or command line. Every lookup here binds
     a secret to a *name* or a *reference* the caller chose, so a caller who
     is not the operator could name a connection "prod" and have the prod
     password attached to a host of their choosing, or write `${AWS_SECRET}`
     into a URL pointing at themselves. The server decides who the operator
     is; this function only has to offer the switch. */
  if (options.secrets === false) {
    return { url: storedUrl, source: hasInlinePassword(storedUrl) ? 'inline' : 'none' };
  }
  // 1. Environment references, which may supply the whole URL or just part.
  const expanded = expandEnv(storedUrl, options.environment);
  const usedEnv = expanded !== storedUrl;

  /* Anything with a host has a credential to resolve; a bare file path does
     not. This tested for Postgres specifically, so any other networked
     connection skipped the keychain and the credentials file entirely and
     never warned about a password written into its URL. Asking whether the target *has a host* is the question that
     was always meant, and it does not need editing again for the next
     adapter. */
  if (!/^[a-z][\w+.-]*:\/\//i.test(expanded)) {
    // SQLite is a file path; there is no credential to resolve.
    return { url: expanded, source: usedEnv ? 'environment' : 'none' };
  }

  if (hasInlinePassword(expanded)) {
    return {
      url: expanded,
      source: usedEnv ? 'environment' : 'inline',
      warning: usedEnv
        ? undefined
        : 'This connection has its password written into the URL. Prefer ${ENV_VAR}, or store it in the keychain.',
    };
  }

  // 2 and 3: a URL with a user but no password can have one supplied.
  let parsed: URL;
  try {
    parsed = new URL(expanded);
  } catch {
    return { url: expanded, source: 'none' };
  }

  const fromKeychain = await keychainGet(name);
  if (fromKeychain) {
    parsed.password = encodeURIComponent(fromKeychain);
    return { url: parsed.toString(), source: 'keychain' };
  }

  const file = await readCredentials(options.credentialsFile);
  if (file[name]) {
    parsed.password = encodeURIComponent(file[name]);
    return { url: parsed.toString(), source: 'file' };
  }

  // No password anywhere. Postgres may still accept it — peer auth, trust,
  // or a ~/.pgpass the driver reads itself — so this is not an error.
  return { url: expanded, source: 'none' };
}
