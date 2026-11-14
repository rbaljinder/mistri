/**
 * `mistri migrate backstop <status | new>`: the tenant App's row-security backstop (docs/postgresql.md) read from
 * the App instead of written by hand. `status` says what the database lacks of it or holds beside it; `new` writes the
 * next V file that makes it (tenant/tenantBackstop.ts has the plan, the SQL and the drift). `mistri check` asks the
 * same question of a connection that declares the backstop.
 *
 * It is an operator's entry point, as the tenant commands are: the one place outside tenancy that reads a tenant
 * App's policy to say what its database must hold.
 */
import { relative } from 'node:path';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { resolveConnection } from '@mistriwork/engine/server/auth/credentials.js';
import type { StartupConfig } from '@mistriwork/engine/server/cli/config.js';
import { refusalReasons } from '@mistriwork/engine/shared/refusal.js';
import { newMigration } from '@mistriwork/engine/server/migrate/files.js';
import { dialectOf } from '@mistriwork/engine/server/migrate/database.js';
import { targetConnection, targetDir } from '@mistriwork/engine/server/migrate/target.js';
import { PostgresAdapter } from '@mistriwork/engine/adapters/postgres.js';
import type { LoadedApp } from '../app/apps.js';
import { isTenantApp } from '../../shared/appModel.js';
import { backstopDrift, backstopSql, BackstopRefusal, readBackstopPlan, type BackstopPlan } from '../tenant/tenantBackstop.js';
import { appBinding } from './appBinding.js';

/** 2: the database and the plan disagree, as `migrate validate` says of files and history. */
const EXIT = { ok: 0, couldNot: 1, drift: 2 } as const;

const shown = (path: string) => {
  const near = relative(process.cwd(), path);
  return !near ? '.' : near.startsWith('..') ? path : near;
};

/** The role a URL signs in as, for a connection that declares the backstop and names no `--runtime`. */
function roleOfUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.username) || parsed.searchParams.get('user') || undefined;
  } catch {
    return undefined;
  }
}

interface BackstopInput {
  readonly registry: Registry;
  readonly appDir?: string;
  readonly loaded?: LoadedApp;
  readonly connection?: string;
  readonly argument?: string;
  readonly schemas: readonly string[];
  readonly policy?: string;
  readonly runtime?: string;
}

/** The plan for this App on its database, and where to read the database as it is; throws BackstopRefusal with the sentence to print. */
async function planned(input: BackstopInput) {
  const { loaded, appDir } = input;
  if (!loaded || appDir === undefined) throw new BackstopRefusal("the backstop is an App's: name it with --app <dir>.");
  if (!isTenantApp(loaded.app)) throw new BackstopRefusal('this App is not a tenant App, and only a tenant App has a tenant to fence.');
  const connection = targetConnection(input.registry, { connection: input.connection, argument: input.argument }, appBinding(loaded.app));
  if (connection.http) throw new BackstopRefusal(`"${connection.name}" is an HTTP API, which has no roles or row-level security.`);
  const url = (await resolveConnection(connection.name, connection.url, { secrets: true })).url;
  if (dialectOf(url) !== 'postgres')
    throw new BackstopRefusal(`"${connection.name}" is SQLite, which has no roles or row-level security: the backstop is PostgreSQL's.`);
  const runtime = input.runtime ?? (connection.backstop ? roleOfUrl(url) : undefined);
  if (runtime === undefined)
    throw new BackstopRefusal(
      `name the role the App runs as with --runtime <role>${connection.backstop ? ' ("url" names no user to read it from)' : ` ("${connection.name}" declares no backstop)`}.`,
    );
  /* The catalog is read as the owner, which every table belongs to, as a start reads it. */
  const read = connection.backstop ? (await resolveConnection(connection.name, connection.owner!, { secrets: true })).url : url;
  if (input.policy === undefined) throw new BackstopRefusal("a tenant App's ownership is its policy's: add --policy <file>.");
  const { loadAppTenantPolicy } = await import('../policy/appTenantPolicy.js');
  let policy: Awaited<ReturnType<typeof loadAppTenantPolicy>>;
  try {
    policy = await loadAppTenantPolicy(input.policy);
  } catch (error) {
    throw new BackstopRefusal(`the tenant policy did not load: ${(error as Error).message}`);
  }
  const plan = await readBackstopPlan({ app: loaded.app, policy, url: read, runtime });
  return { plan, read, connection };
}

/** An error as one line, with the reasons a refusal recorded: a tenant refusal's own message says nothing. */
const said = (error: unknown) => {
  const first = (error as Error).message.split('\n')[0];
  const reasons = refusalReasons(error);
  return reasons.length ? `${first} (${reasons.join('; ')})` : first;
};

/** What the database lacks of the plan, or holds beside it. */
async function driftOf(plan: BackstopPlan, url: string): Promise<string[]> {
  const adapter = new PostgresAdapter(url, 'Backstop status');
  try {
    return await adapter.readSnapshot((snapshot) => backstopDrift(plan, snapshot.client));
  } finally {
    await adapter.close();
  }
}

/* `new` writes grants, never revokes: what the database holds beyond the plan, or a role it cannot fix, is undone by hand. */
const BY_HAND = /which the plan does not|is a member of|owns the tenant tables|a superuser|BYPASSRLS/;

const fixLine = (input: BackstopInput, drift: readonly string[]) =>
  `mistri migrate backstop new --app ${shown(input.appDir!)} --policy ${input.policy ?? '<file>'} --runtime ${input.runtime ?? '<role>'}, then migrate up` +
  (drift.some((line) => BY_HAND.test(line))
    ? '; revoke by hand what the plan does not make, and alter the role it cannot (new writes grants, never revokes)'
    : '');

export async function runBackstop(
  sub: string,
  /* `new` writes where the config's migrations directory says. */
  input: BackstopInput & { readonly config: StartupConfig },
  write: (line: string) => void,
): Promise<number> {
  if (sub !== 'status' && sub !== 'new') {
    console.error(`mistri migrate backstop: "${sub}" is not a backstop command: status or new.`);
    return EXIT.couldNot;
  }
  try {
    const { plan, read, connection } = await planned(input);
    if (sub === 'new') {
      const dir = targetDir(
        input.registry,
        input.config,
        { connection: input.connection, argument: input.argument, schemas: input.schemas },
        input.appDir,
        appBinding(input.loaded!.app),
      );
      const path = newMigration(dir, 'tenant_backstop', false, new Date(), backstopSql(plan));
      write(`wrote ${shown(path)}`);
      write(
        `  ${plan.tenant.length} tenant table${plan.tenant.length === 1 ? '' : 's'} fenced for "${plan.runtime}". Apply it with migrate up, as the owner role.`,
      );
      write(`  The role is made NOLOGIN. Letting it sign in is yours, once: ALTER ROLE "${plan.runtime}" LOGIN PASSWORD '<secret>';`);
      return EXIT.ok;
    }
    const drift = await driftOf(plan, read);
    if (!drift.length) {
      write(`backstop on ${connection.name}: the database matches the plan for "${plan.runtime}" (${plan.tenant.length} fenced tables).`);
      return EXIT.ok;
    }
    write(
      `backstop on ${connection.name}: ${drift.length} difference${drift.length === 1 ? '' : 's'} from the plan for "${plan.runtime}":`,
    );
    for (const line of drift) write(`  ${line}`);
    write(`  made by: ${fixLine({ ...input, runtime: plan.runtime }, drift)}`);
    return EXIT.drift;
  } catch (error) {
    console.error(
      `mistri migrate backstop: ${error instanceof BackstopRefusal ? error.message : `could not read the database: ${said(error)}`}`,
    );
    return EXIT.couldNot;
  }
}

/** The check's reading of the backstop: undefined where the connection declares none; else the drift, or why it could not be judged. */
export async function backstopFinding(
  registry: Registry,
  loaded: LoadedApp,
  opts: { policy?: string },
  appDir: string,
): Promise<{ runtime: string; drift: string[]; fix: string } | { skipped: string } | { unread: string } | undefined> {
  if (!isTenantApp(loaded.app)) return undefined;
  const bound = appBinding(loaded.app).connection;
  const declared = registry.configs().find((each) => (each.id === bound || each.name === bound) && each.backstop);
  if (!declared) return undefined;
  if (opts.policy === undefined) return { skipped: `the backstop is judged from the tenant policy: add --policy <file>` };
  const input: BackstopInput = { registry, appDir, loaded, schemas: [], policy: opts.policy };
  try {
    const { plan, read } = await planned(input);
    const drift = await driftOf(plan, read);
    return { runtime: plan.runtime, drift, fix: fixLine({ ...input, runtime: plan.runtime }, drift) };
  } catch (error) {
    return { unread: error instanceof BackstopRefusal ? error.message : said(error) };
  }
}
