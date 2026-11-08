/**
 * `mistri check --schema-file [schema.sql]`: the App judged against the schema it declares, with no database of its
 * own to reach. The file is run on a scratch database by the executor a migration runs on (migrate/desired.ts
 * schemaDatabase; nothing here reads SQL), and every step then reads that scratch where it would read the App's
 * database. It is dropped when the check ends, whatever it found.
 *
 * SQLite always; PostgreSQL when `--dev-url` names a server where two scratch databases may be made (CREATEDB).
 * Tables are empty, so an EXPLAIN is still a plan but a row count is not a fact.
 *
 * A committed catalog snapshot, to check with no server at all, was designed and set aside: the validation child
 * hosts the App's commands, policies and triggers against the adapter itself (cli/oneShot.ts checkApps,
 * commands/commandTriggerChecks.ts, policy/policyServiceChecks.ts), so a `DatabaseSchema` alone cannot stand in
 * for the connection.
 */
import { join, relative, resolve } from 'node:path';
import { Registry, redact } from '@mistriwork/engine/server/connections.js';
import { loadApp } from '../app/apps.js';
import { AppProblems, type AppDef } from '../../shared/app.js';
import { parseArgs } from '@mistriwork/engine/server/cli/args.js';
import { readStartupConfig } from '@mistriwork/engine/server/cli/config.js';
import type { ConfigSections } from '@mistriwork/engine/server/configSections.js';
import { resolveConnection } from '@mistriwork/engine/server/auth/credentials.js';
import { defaultSchemaFile, schemaDatabase } from '@mistriwork/engine/server/migrate/desired.js';
import { dialectOf } from '@mistriwork/engine/server/migrate/database.js';
import { targetConnection } from '@mistriwork/engine/server/migrate/target.js';
import { appBinding } from '../cli/appBinding.js';
import { pointAt } from './pending.js';

interface SchemaFileCopy {
  /** The check's arguments, pointed at the scratch database. */
  readonly args: string[];
  readonly detail: string;
  readonly lines: string[];
  cleanup(): Promise<void>;
}

/** A path as the person gave it where it is under where they ran the command; the whole path where it is elsewhere. */
const shownPath = (file: string) => {
  const short = relative(process.cwd(), file);
  return short && !short.startsWith('..') ? short : file;
};

/** The scratch database made from the App's schema file, or the reason it could not be (thrown, in the person's words). */
export async function schemaFileCopy(
  appDir: string,
  rest: string[],
  flags: { file?: string; devUrl?: string },
  sections: ConfigSections,
): Promise<SchemaFileCopy> {
  const opts = parseArgs(rest);
  const registry = new Registry();
  const log = console.log;
  console.log = () => {};
  try {
    const config = await readStartupConfig(opts, registry, sections);
    const argument = opts.target
      ? registry.add({ name: redact(opts.target), url: opts.target, schemas: opts.schemas, source: 'argument' }).id
      : undefined;
    let app: AppDef | undefined;
    try {
      app = (await loadApp(appDir, { lock: 'report', ...(opts.appEntry !== undefined ? { entry: opts.appEntry } : {}) })).app;
    } catch (error) {
      // The validation step says why it did not load; a partial App still names the database it binds.
      if (error instanceof AppProblems && error.partial) app = error.partial as AppDef;
    }
    const binding = app ? appBinding(app) : undefined;
    if (new Set((binding?.schemas ?? []).map((source) => source.connection)).size > 1 || Object.keys(app?.sources ?? {}).length > 1)
      throw new Error('the App reads several sources, and one schema file describes one database: check it against its databases.');

    /* A database the person already names is only read for its kind: the scratch must be the same engine, since
       the file is written for one. Unreachable or unset is not this step's to say. */
    let connection: { name: string; dialect?: 'sqlite' | 'postgres' } | undefined;
    if (registry.configs().length) {
      const named = targetConnection(registry, { ...(argument ? { argument } : {}) }, binding, 'check');
      connection = { name: named.name };
      if (!named.http) {
        try {
          connection.dialect = dialectOf((await resolveConnection(named.name, named.url, { secrets: true })).url);
        } catch {
          /* Left unknown. */
        }
      }
    }
    const wants = flags.devUrl !== undefined ? dialectOf(flags.devUrl) : 'sqlite';
    if (connection?.dialect && connection.dialect !== wants)
      throw new Error(
        connection.dialect === 'postgres'
          ? `the App's database is PostgreSQL, and a schema file is loaded into a scratch SQLite database unless --dev-url names a PostgreSQL server where two scratch databases may be made (the role needs CREATEDB).`
          : `--dev-url names a ${wants} server, and the App's database is ${connection.dialect}.`,
      );

    const file = flags.file !== undefined ? resolve(flags.file) : defaultSchemaFile(join(appDir, 'migrations'));
    const scratch = await schemaDatabase({
      schemaFile: file,
      ...(flags.devUrl !== undefined ? { devUrl: flags.devUrl } : {}),
      ...(opts.schemas[0] !== undefined ? { schema: opts.schemas[0] } : {}),
    });
    try {
      const pointed = await pointAt(rest, opts, config, argument, connection?.name, scratch.url);
      return {
        args: pointed.args,
        detail: `${shownPath(file)} loaded into a scratch ${scratch.dialect} database; the steps below read it`,
        lines: ['its tables are empty: a plan is real, a row count is not'],
        async cleanup() {
          await pointed.restore();
          await scratch.drop();
        },
      };
    } catch (error) {
      await scratch.drop();
      throw error;
    }
  } finally {
    console.log = log;
    await registry.closeAll();
  }
}
