/**
 * Which database a migration run is about, and which of its schemas, which
 * directory and which history table: read the way a start reads a
 * connection, so `tablewalk migrate` and `mistri check --pending` agree
 * with the server about what "the App's database" is.
 *
 * The directory defaults to `migrations/` inside the App's directory. It is
 * the one place the App's other derived facts already live (its generated
 * `mistri-schema.d.ts`, its `authority.lock`), it travels with the App in
 * version control, and a change to it is reviewed beside the App code that
 * needs it. A connection that says otherwise (`"migrations": { "dir": … }`
 * in tablewalk.json, relative to that file) wins, which is how several Apps
 * over one database share its migrations, and `--migrations` wins over both.
 */
import { dirname, resolve } from 'node:path';
import { resolveConnection } from '../auth/credentials.js';
import type { ConnectionConfig, Registry } from '../connections.js';
import type { StartupConfig } from '../cli/config.js';
import { DEFAULT_HISTORY_TABLE } from './history.js';
import type { MigrateTarget } from './runner.js';
import { configFileName } from '../product.js';

interface TargetFlags {
  readonly connection?: string;
  /** The id of the connection the command line named (`<db>`, --db, DATABASE_URL): it wins over a config's. */
  readonly argument?: string;
  readonly migrations?: string;
  readonly table?: string;
  /** --schema, as parsed: wins over what the App and the connection say. */
  readonly schemas: readonly string[];
}

/**
 * What an App says about the database a run is about, without the engine reading the App: the connection it binds
 * (its own, or its home source's) and the schemas its sources keep, home source first. The App framework derives it
 * from a loaded App (cli/appTargets.ts); a run with no App has none.
 */
export interface TargetBinding {
  readonly connection?: string;
  readonly schemas?: ReadonlyArray<Readonly<{ connection: string; schema: string }>>;
}

interface ResolvedTarget extends MigrateTarget {
  readonly connection: ConnectionConfig;
}

/** The connection the run is about: named, the App's home source's, or the only one. `tablewalk seed` reads it the same way. */
export function targetConnection(
  registry: Registry,
  flags: Pick<TargetFlags, 'connection' | 'argument'>,
  binding?: TargetBinding,
  purpose = 'migrate',
): ConnectionConfig {
  const find = (name: string) => registry.configs().find((config) => config.id === name || config.name === name);
  const bound = flags.connection ?? binding?.connection;
  if (bound !== undefined) {
    const found = find(bound);
    if (!found)
      throw new Error(
        `there is no connection "${bound}". Known: ${
          registry
            .configs()
            .map((config) => config.name)
            .join(', ') || 'none'
        }.`,
      );
    return found;
  }
  if (flags.argument) return registry.configOf(flags.argument)!;
  const configs = registry.configs();
  if (configs.length === 1) return configs[0];
  if (configs.length > 1)
    throw new Error(`several connections are configured (${configs.map((config) => config.name).join(', ')}): name one with --connection.`);
  throw new Error(
    `no database to ${purpose}. Name it — a SQLite file, --db <url>, or --config <file> — or keep a ${configFileName()} beside where you run it.`,
  );
}

function directoryOf(
  connection: ConnectionConfig | undefined,
  config: StartupConfig,
  flags: Pick<TargetFlags, 'migrations'>,
  appDir?: string,
): string {
  const base = config.configPath ? dirname(config.configPath) : process.cwd();
  return flags.migrations !== undefined
    ? resolve(flags.migrations)
    : connection?.migrations
      ? resolve(base, connection.migrations.dir)
      : appDir !== undefined
        ? resolve(appDir, 'migrations')
        : resolve('migrations');
}

/** The directory alone, for `migrate new`, which writes a file and opens no database. */
export function targetDir(registry: Registry, config: StartupConfig, flags: TargetFlags, appDir?: string, binding?: TargetBinding): string {
  let connection: ConnectionConfig | undefined;
  try {
    connection = targetConnection(registry, flags, binding);
  } catch {
    connection = undefined;
  }
  return directoryOf(connection, config, flags, appDir);
}

export async function resolveTarget(
  registry: Registry,
  config: StartupConfig,
  flags: TargetFlags,
  appDir?: string,
  binding?: TargetBinding,
): Promise<ResolvedTarget> {
  const connection = targetConnection(registry, flags, binding);
  if (connection.http) throw new Error(`"${connection.name}" is an HTTP API, which has no schema of its own to migrate.`);
  const { url } = await resolveConnection(connection.name, connection.url, { secrets: true });
  /* The App's schemas on this connection, home source first: an App that
     keeps a source per schema owns those and nothing else of a shared
     database. */
  const appSchemas = (binding?.schemas ?? [])
    .filter((source) => {
      const bound = registry.configs().find((config) => config.id === source.connection || config.name === source.connection);
      return bound?.id === connection.id;
    })
    .map((source) => source.schema);
  const schemas = [...new Set(flags.schemas.length ? flags.schemas : appSchemas.length ? appSchemas : (connection.schemas ?? []))];
  const dir = directoryOf(connection, config, flags, appDir);
  const table = flags.table ?? connection.migrations?.table ?? DEFAULT_HISTORY_TABLE;
  if (!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(table))
    throw new Error(`"${table}" is not a table name the history can have: letters, digits and _, at most 63.`);
  return { url, schemas, dir, table, connection };
}
