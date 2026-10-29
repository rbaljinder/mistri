/**
 * `mistri check --pending`: the App judged against the schema as it will
 * be once the pending migrations run, before they run anywhere that matters.
 * They are applied to a scratch copy of the App's database, and the check
 * then reads the copy in the database's place:
 *
 * - SQLite: the file copied with `VACUUM INTO`, a consistent copy even of a
 *   database another process is writing.
 * - PostgreSQL: `CREATE DATABASE … TEMPLATE`, the server's own copy, which
 *   needs a role that may create databases and nobody else connected to the
 *   App's database while it copies. While something is connected (the dev
 *   server, usually), an empty database and `pg_dump --schema-only` of the
 *   App's schemas into it, when pg_dump is installed: the same names, no
 *   rows. Without CREATEDB it says so, and how to give it, rather than
 *   approximating in the real database: a copy of a schema beside the real
 *   one cannot keep the names the App binds, and a migration that names its
 *   schema would reach past the copy into the real one.
 * - `--pending-on <url>`: no copy is made. The migrations run on the database
 *   that URL names — a branch or restore of the real one, or an empty database
 *   the whole history can build — on either engine. It is the way
 *   where the role has no CREATEDB (a hosted database) and the better one
 *   where the host branches databases. It is never dropped or emptied, and a
 *   URL that names the App's own database is refused.
 *
 * A copy mistri made is dropped when the check ends, whatever it found.
 */
import { execFile } from 'node:child_process';
import { pgConnectionOptions } from '@mistriwork/engine/adapters/postgresValues.js';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Registry, redact } from '@mistriwork/engine/server/connections.js';
import { loadApp, type LoadedApp } from '../app/apps.js';
import { AppProblems, type AppDef } from '../../shared/app.js';
import { parseArgs } from '@mistriwork/engine/server/cli/args.js';
import { readStartupConfig } from '@mistriwork/engine/server/cli/config.js';
import { CACHE_SECTIONS } from '@mistriwork/engine/server/cacheService.js';
import type { ConfigSections } from '@mistriwork/engine/server/configSections.js';
import { resolveConnection } from '@mistriwork/engine/server/auth/credentials.js';
import { dialectOf, sqlitePath } from '@mistriwork/engine/server/migrate/database.js';
import { migrateUp, migrationStatus } from '@mistriwork/engine/server/migrate/runner.js';
import { resolveTarget } from '@mistriwork/engine/server/migrate/target.js';
import { appBinding } from '../cli/appBinding.js';

/** The variable the check's own processes read the scratch copy's URL from, so a password never reaches a command line or a file. */
const PENDING_URL = 'MISTRI_PENDING_URL';

interface PendingCopy {
  /** The check's arguments, pointed at the copy. */
  readonly args: string[];
  readonly status: 'passed' | 'failed';
  readonly detail: string;
  readonly lines: string[];
  cleanup(): Promise<void>;
}

const nothing = async () => {};

export async function pendingCopy(
  appDir: string,
  rest: string[],
  flags: { migrations?: string; table?: string; on?: string },
  sections: ConfigSections = CACHE_SECTIONS,
): Promise<PendingCopy> {
  const refuse = (detail: string, lines: string[] = []): PendingCopy => ({ args: rest, status: 'failed', detail, lines, cleanup: nothing });
  const opts = parseArgs(rest);
  const registry = new Registry();
  const log = console.log;
  console.log = () => {};
  try {
    const config = await readStartupConfig(opts, registry, sections);
    const argument = opts.target
      ? registry.add({ name: redact(opts.target), url: opts.target, schemas: opts.schemas, source: 'argument' }).id
      : undefined;
    let loaded: LoadedApp | undefined;
    try {
      loaded = await loadApp(appDir, {
        lock: 'report',
        ...(opts.appEntry !== undefined ? { entry: opts.appEntry } : {}),
        ...(config.appEnv[appDir] ? { env: config.appEnv[appDir] } : {}),
      });
    } catch (error) {
      if (!(error instanceof AppProblems && error.partial)) return refuse('the App did not load; the validation step says why');
      loaded = { path: appDir, dir: appDir, app: error.partial as AppDef, pages: [], sources: {} };
    }
    const target = await resolveTarget(registry, config, { ...flags, argument, schemas: opts.schemas }, appDir, appBinding(loaded.app));
    const dialect = dialectOf(target.url);
    const status = await migrationStatus(target);
    if (status.plan.problems.length)
      return refuse('the migrations and the history disagree: mistri migrate status says how', [...status.plan.problems]);
    const pending = status.plan.pending;
    if (!pending.length)
      return {
        args: rest,
        status: 'passed',
        detail: 'nothing pending: the App is judged against the database as it is',
        lines: [],
        cleanup: nothing,
      };

    let scratchUrl: string;
    let how: string;
    let drop: () => Promise<void>;
    if (flags.on !== undefined) {
      // A `${NAME}` reference is expanded here, so a password stays in the environment rather than on a command line.
      const given = (await resolveConnection('pending-on', flags.on, { secrets: true })).url;
      if (dialectOf(given) !== dialect)
        return refuse(
          `--pending-on names a ${dialectOf(given)} database, and the App's is ${dialect}: the migrations are written for one engine.`,
        );
      if (sameDatabase(given, target.url))
        return refuse(
          "--pending-on names the App's own database. It is where the migrations are tried, so it must be another: a branch or a restore of it, or an empty one.",
        );
      scratchUrl = given;
      how = 'the scratch database --pending-on names';
      drop = nothing;
    } else if (dialect === 'sqlite') {
      const dir = mkdtempSync(join(tmpdir(), 'tablewalk-pending-'));
      const copy = join(dir, basename(sqlitePath(target.url)));
      const source = new DatabaseSync(sqlitePath(target.url), { readOnly: true });
      try {
        source.prepare('VACUUM INTO ?').run(copy);
      } finally {
        source.close();
      }
      scratchUrl = copy;
      how = 'a copy of the SQLite file';
      drop = async () => rmSync(dir, { recursive: true, force: true });
    } else {
      const made = await postgresCopy(target.url, target.schemas);
      if ('refused' in made) return refuse(made.refused);
      ({ url: scratchUrl, drop, how } = made);
    }
    try {
      const applied = await migrateUp({ ...target, url: scratchUrl });
      if (applied.failure || applied.refused || applied.status.plan.problems.length) {
        await drop();
        return refuse(
          applied.failure
            ? `${applied.failure.file.script} failed on the scratch copy: ${applied.failure.message}`
            : (applied.refused ?? 'the migrations and the history disagree'),
          applied.status.plan.problems.slice(),
        );
      }
    } catch (error) {
      await drop();
      throw error;
    }

    /* The check reads the copy where it would read the database: the
       command line's target replaced, or the config's connection pointed at
       the copy in a config written beside the original, so every path in it
       still means what it did. */
    let args: string[];
    let written: string | undefined;
    if (argument) {
      args = rest.filter(
        (arg, i) => arg !== opts.target && !(['--db', '-d'].includes(arg) && rest[i + 1] === opts.target) && arg !== `--db=${opts.target}`,
      );
      args.push('--db', `\${${PENDING_URL}}`);
    } else {
      const path = config.configPath!;
      const raw = JSON.parse(await readFile(path, 'utf8')) as { connections: Array<Record<string, unknown>> };
      raw.connections = raw.connections.map((entry) =>
        entry.name === target.connection.name ? { ...entry, url: `\${${PENDING_URL}}` } : entry,
      );
      written = join(dirname(path), `.mistri-pending-${randomBytes(4).toString('hex')}.json`);
      await writeFile(written, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      args = rest.filter(
        (arg, i) => arg !== '--config' && rest[i - 1] !== '--config' && !arg.startsWith('--config=') && arg !== '--no-config',
      );
      args.push('--config', written);
    }
    process.env[PENDING_URL] = scratchUrl;
    return {
      args,
      status: 'passed',
      detail: `${pending.length} pending migration${pending.length === 1 ? '' : 's'} applied to ${how}; the steps below read it`,
      lines: pending.map((file) => file.script),
      async cleanup() {
        delete process.env[PENDING_URL];
        if (written) await rm(written, { force: true });
        await drop();
      },
    };
  } finally {
    console.log = log;
    await registry.closeAll();
  }
}

/** Whether two database URLs reach the same database: the same file, or the same host, port and name. */
function sameDatabase(a: string, b: string): boolean {
  if (dialectOf(a) === 'sqlite' || dialectOf(b) === 'sqlite')
    return dialectOf(a) === dialectOf(b) && resolve(sqlitePath(a)) === resolve(sqlitePath(b));
  const where = (url: string) => {
    const address = new URL(url);
    const port = address.port || '5432';
    return `${dialectOf(url)}://${address.hostname.toLowerCase()}:${port}${address.pathname}`;
  };
  return where(a) === where(b);
}

type PgAdmin = { connect(): Promise<void>; query(sql: string): Promise<unknown>; end(): Promise<void> };

/** The App's PostgreSQL database copied, or why it could not be. */
async function postgresCopy(
  url: string,
  schemas: readonly string[],
): Promise<{ url: string; drop: () => Promise<void>; how: string } | { refused: string }> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as {
    Client?: new (options: unknown) => PgAdmin;
    default?: { Client?: new (options: unknown) => PgAdmin };
  };
  const Client = (pg.Client ?? pg.default?.Client)!;
  const database = decodeURIComponent(new URL(url).pathname.slice(1));
  const copy = `${database.slice(0, 40)}_pending_${randomBytes(4).toString('hex')}`;
  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const at = (name: string) => {
    const address = new URL(url);
    address.pathname = `/${encodeURIComponent(name)}`;
    return address.href;
  };
  // Connected to the maintenance database: the template must have no session, this one included.
  const admin = async () => {
    for (const other of ['postgres', 'template1']) {
      const client = new Client({ ...pgConnectionOptions(at(other)), connectionTimeoutMillis: 15_000 });
      try {
        await client.connect();
        return client;
      } catch {
        await client.end().catch(() => {});
      }
    }
    return undefined;
  };
  const drop = async () => {
    const dropper = await admin();
    if (!dropper) return;
    try {
      await dropper.query(`DROP DATABASE IF EXISTS ${quote(copy)} WITH (FORCE)`);
    } finally {
      await dropper.end().catch(() => {});
    }
  };
  const client = await admin();
  if (!client) return { refused: "the server's postgres database could not be opened to make a copy from" };
  let busy = false;
  try {
    await client.query(`CREATE DATABASE ${quote(copy)} TEMPLATE ${quote(database)}`);
    return { url: at(copy), drop, how: 'a copy of the database (CREATE DATABASE … TEMPLATE)' };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501')
      return {
        refused:
          'the role may not create databases, so no copy can be made: grant it CREATEDB (ALTER ROLE … CREATEDB), or check as a role that has it',
      };
    if (code !== '55006') return { refused: `PostgreSQL would not copy ${database}: ${(error as Error).message.split('\n')[0]}` };
    busy = true;
    await client.query(`CREATE DATABASE ${quote(copy)}`).catch(() => {
      busy = false;
    });
  } finally {
    await client.end().catch(() => {});
  }
  const cannot = 'PostgreSQL copies a database only while nobody else is connected to it, and something is (a running mistri server?)';
  if (!busy) return { refused: `${cannot}: stop it and check again` };
  const dump = await schemaDump(url, schemas);
  if ('refused' in dump) {
    await drop();
    return { refused: `${cannot}, and ${dump.refused}: stop it, or install pg_dump, and check again` };
  }
  const target = new Client({ ...pgConnectionOptions(at(copy)), connectionTimeoutMillis: 15_000 });
  try {
    await target.connect();
    await target.query(dump.sql);
  } catch (error) {
    await target.end().catch(() => {});
    await drop();
    return { refused: `${cannot}, and its schema would not load into a new database: ${(error as Error).message.split('\n')[0]}` };
  }
  await target.end().catch(() => {});
  return { url: at(copy), drop, how: 'a schema-only copy of the database (pg_dump), since another session holds it' };
}

/**
 * `pg_dump --schema-only` of the App's schemas, as SQL a client can run: its
 * psql meta-commands (`\restrict` and the like) left out. Credentials reach
 * pg_dump through its environment, never its command line.
 */
function schemaDump(url: string, schemas: readonly string[]): Promise<{ sql: string } | { refused: string }> {
  const address = new URL(url);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: address.hostname,
    PGPORT: address.port || '5432',
    PGDATABASE: decodeURIComponent(address.pathname.slice(1)),
    ...(address.username ? { PGUSER: decodeURIComponent(address.username) } : {}),
    ...(address.password ? { PGPASSWORD: decodeURIComponent(address.password) } : {}),
    ...(address.searchParams.get('sslmode') ? { PGSSLMODE: address.searchParams.get('sslmode')! } : {}),
  };
  const args = ['--schema-only', '--no-owner', '--no-privileges', ...schemas.flatMap((schema) => ['--schema', schema])];
  return new Promise((done) => {
    execFile('pg_dump', args, { env, maxBuffer: 256 * 1024 * 1024 }, (error, out) => {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        done({ refused: 'pg_dump is not installed to copy its schema instead' });
        return;
      }
      if (error) {
        done({ refused: `pg_dump could not read its schema (${error.message.split('\n')[0]})` });
        return;
      }
      done({
        sql: out
          .split('\n')
          .filter((line) => !line.startsWith('\\'))
          .join('\n'),
      });
    });
  });
}
