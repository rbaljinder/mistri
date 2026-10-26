/**
 * `tablewalk seed`: fill an App's database with rows to look at (seed.ts says
 * what makes them believable). The database is found the way `migrate` finds
 * it — the App's connection, a named one, or the only one — and written only
 * when its config says `"writable": true`: the flag is the reviewable
 * statement that this database may be changed, and seed is a change.
 *
 * `--app` is the App framework's: a main that has one hands a `SeedHost`
 * (cli/appTargets.ts) that names the App's connection, how its statuses move
 * and who signs in. With no host, `--app` is refused.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Registry, redact } from '../connections.js';
import { parseArgs, type Options } from '../cli/args.js';
import { readStartupConfig, type StartupConfig } from '../cli/config.js';
import { CACHE_SECTIONS } from '../cacheService.js';
import type { ConfigSections } from '../configSections.js';
import { targetConnection, type TargetBinding } from '../migrate/target.js';
import { seedDatabase, SeedRefusal, type SeedResource } from './seed.js';
import { configFileName } from '../product.js';
import { product } from '../product.js';

/** The App framework's part of `tablewalk seed`: the App in `dir`, as seed reads it. Throws with the sentence to print. */
export interface SeedHost {
  app(
    dir: string,
    given: { opts: Options; config: StartupConfig },
  ): Promise<{
    binding: TargetBinding;
    resources?: Record<string, SeedResource>;
    people?: { table: string; column: string };
  }>;
}

const seedUsage = () =>
  product() + ' seed [--app <dir>] [<db> | --db <target> | --config <path>] [--connection <name>] [--rows <n>] [--seed <n>] [--append]';

/** The exit codes: 1 could not run, 2 refused (read-only, or rows already there). */
const EXIT = { ok: 0, couldNot: 1, refused: 2 } as const;

/* The start's own flags this command takes, and whether each has a value. */
const PASSED: Record<string, boolean> = {
  '--db': true,
  '-d': true,
  '--config': true,
  '--no-config': false,
  '--schema': true,
  '--app-entry': true,
};

export async function runSeed(
  argv: string[],
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  sections: ConfigSections = CACHE_SECTIONS,
  host?: SeedHost,
): Promise<number> {
  const fail = (why: string, code: number = EXIT.couldNot) => {
    console.error(`${product()} seed: ${why}`);
    return code;
  };
  if (argv[0] === '--help' || argv[0] === '-h') {
    write(
      `${seedUsage()}\n\n` +
        'Rows to look at, in a writable database: about --rows per main table (default 40), fewer for staff\n' +
        "and lookups, more for lines. Each status the way the App's machine moves it, with its stamps; dates\n" +
        'across the last 90 days, some work due today or overdue. --seed <n> makes the same rows again on the\n' +
        'same day. A table that already holds rows is refused unless --append.',
    );
    return EXIT.ok;
  }
  let app: string | undefined;
  let connection: string | undefined;
  let rows = 40;
  let seed: number | undefined;
  let append = false;
  const rest: string[] = [];
  const value = (i: number, flag: string) => {
    const given = argv[i + 1];
    if (given === undefined || given.startsWith('-')) throw new Error(`${flag} needs a value. ${seedUsage()}`);
    return given;
  };
  const whole = (text: string, flag: string, lo: number, hi: number) => {
    const n = Number(text);
    if (!Number.isInteger(n) || n < lo || n > hi)
      throw new Error(`${flag} takes a whole number from ${lo} to ${hi}; "${text}" is not one.`);
    return n;
  };
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--app') {
        app = value(i++, arg);
        continue;
      }
      if (arg === '--connection') {
        connection = value(i++, arg);
        continue;
      }
      if (arg === '--rows') {
        rows = whole(value(i++, arg), arg, 1, 10_000);
        continue;
      }
      if (arg === '--seed') {
        seed = whole(value(i++, arg), arg, 0, 2 ** 32 - 1);
        continue;
      }
      if (arg === '--append') {
        append = true;
        continue;
      }
      const flag = arg.split('=')[0];
      if (flag in PASSED) {
        rest.push(arg);
        if (PASSED[flag] && !arg.includes('=')) rest.push(value(i++, arg));
        continue;
      }
      if (arg.startsWith('-')) throw new Error(`"${arg}" is not an option of seed. ${seedUsage()}`);
      rest.push(arg);
    }
  } catch (error) {
    return fail((error as Error).message);
  }
  const opts = parseArgs(rest);
  if (opts.unknown) return fail(`unknown option "${opts.unknown}". ${seedUsage()}`);
  const appDir = app !== undefined ? resolve(app) : undefined;
  if (appDir !== undefined && !host)
    return fail(
      "--app reads an App, which is the App framework's part: " +
        product() +
        ' seeds a database alone. Run npx @mistriwork/mistri seed --app, or drop --app.',
    );
  if (appDir !== undefined && !existsSync(appDir)) return fail(`${app} is not a directory.`);
  /* A seed nobody chose is still said, so the same rows can be made again. */
  const chosen = seed ?? Math.floor(Math.random() * 1_000_000);

  const registry = new Registry();
  const log = console.log;
  console.log = () => {};
  try {
    const config = await readStartupConfig(opts, registry, sections);
    const argument = opts.target
      ? registry.add({ name: redact(opts.target), url: opts.target, schemas: opts.schemas, source: 'argument' }).id
      : undefined;
    let loaded: Awaited<ReturnType<SeedHost['app']>> | undefined;
    if (appDir !== undefined) {
      try {
        loaded = await host!.app(appDir, { opts, config });
      } catch (error) {
        return fail((error as Error).message);
      }
    }
    const target = targetConnection(registry, { connection, argument }, loaded?.binding, 'seed');
    if (target.http) return fail(`"${target.name}" is an HTTP API; seed writes rows to a database.`, EXIT.refused);
    if (target.writable !== true)
      return fail(
        `"${target.name}" is read-only, and seed writes rows. Give the connection "writable": true in ${configFileName()} — ` +
          'a database named on the command line is always read-only.',
        EXIT.refused,
      );
    const { adapter, schema } = await registry.open(target.id);
    const me = loaded?.people;
    const report = await seedDatabase(adapter, schema, {
      rows,
      seed: chosen,
      append,
      ...(loaded?.resources ? { resources: loaded.resources } : {}),
      ...(me ? { people: me } : {}),
    });
    const total = report.tables.reduce((sum, table) => sum + table.rows, 0);
    write(`Seeded ${target.name} with ${total} rows (--seed ${chosen}):`);
    for (const table of report.tables) write(`  ${table.table.padEnd(24)} ${table.rows}`);
    if (report.signIn.length) write(`Sign in as ${report.signIn.join(', ')} — or any other of ${me!.table}.`);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof SeedRefusal) return fail(error.message, EXIT.refused);
    return fail((error as Error).message);
  } finally {
    console.log = log;
    await registry.closeAll();
  }
}
