/**
 * `tablewalk migrate`: change a database's schema with versioned SQL files in
 * Flyway's format, and keep the App that reads it honest.
 *
 * tablewalk rides on the database; it does not become a database tool. So
 * this is a small runner of the format a team may already use, with no Java
 * to install (`npx tablewalk` has no build step), and `--tool flyway` hands
 * the same files and history to a real Flyway. What no generic tool can do
 * is the part tied to the App: after `up` its schema types are regenerated
 * and `mistri check` names the view, page or command a dropped or renamed
 * column breaks; `status` says when the types are older than the database;
 * and a database changed by hand is said as drift.
 *
 * That App part is the App framework's, handed in as a `MigrateHost` by the
 * main that has one (cli/appTargets.ts): what an App binds, its types and its
 * check, and the commands only an App has (`stores`, `files`). This file reads
 * the flags and the database; with no host, `--app` is refused and those
 * commands are not offered.
 */
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { Registry, redact } from '../connections.js';
import { parseArgs, type Options } from '../cli/args.js';
import { readStartupConfig, type StartupConfig } from '../cli/config.js';
import { CACHE_SECTIONS } from '../cacheService.js';
import type { ConfigSections } from '../configSections.js';
import { dialectOf } from './database.js';
import { atlasBinary, defaultSchemaFile, diffHeader, firstHeader, firstMigration, pendingSql, squashInto } from './desired.js';
import { compareVersions, newMigration, readMigrations } from './files.js';
import { FLYWAY_COMMANDS, runFlyway } from './flyway.js';
import { migrateBaseline, migrateRepair, migrateUp, migrateValidate, migrationStatus, recordAround, type Status } from './runner.js';
import { sayChange } from './snapshot.js';
import { resolveTarget, targetDir, type TargetBinding } from './target.js';
import { product } from '../product.js';

/** What a run keeps of the App `--app` names: what it binds, and its two questions after a run. */
export interface MigrateApp {
  readonly binding: TargetBinding;
  /** `status`: say when the App's generated types are older than the database. */
  types(registry: Registry, write: (line: string) => void): Promise<void>;
  /** After `up`: the App judged against the schema the run left, its problems written; false when it no longer fits. */
  check(rest: string[], write: (line: string) => void): Promise<boolean>;
}

/** What a host's command is handed: the database read the way a start reads it, and the App when one was named. */
interface MigrateCommandInput<A extends MigrateApp> {
  readonly sub: string;
  /** Its own flags (`takes`), as given. */
  readonly flags: Readonly<Record<string, string | true>>;
  readonly registry: Registry;
  readonly config: StartupConfig;
  readonly opts: Options;
  readonly sections: ConfigSections;
  readonly appDir?: string;
  readonly app?: A;
  readonly connection?: string;
  readonly argument?: string;
  readonly schemas: readonly string[];
  readonly dryRun: boolean;
}

/** A command a host adds under `migrate`, which takes a word of its own (`stores up`). */
interface MigrateCommand<A extends MigrateApp> {
  /** One line of the help: what it is for. */
  readonly says: string;
  readonly usage: string;
  /** Said when its word is missing. */
  readonly needs: string;
  /** Its own flags, and whether each takes a value. */
  readonly takes: Readonly<Record<string, boolean>>;
  /** Whether it takes --dry-run. It takes no other migration-file option. */
  readonly dryRun?: boolean;
  run(input: MigrateCommandInput<A>, write: (line: string) => void): Promise<number>;
}

/** The App framework's part of `tablewalk migrate` (cli/appTargets.ts). */
export interface MigrateHost<A extends MigrateApp = MigrateApp> {
  /** The App in `dir`; throws with the sentence to print when it cannot be read. */
  app(
    dir: string,
    given: { opts: Options; config: StartupConfig; command: string; flags: Readonly<Record<string, string | true>> },
  ): Promise<A>;
  readonly commands: Readonly<Record<string, MigrateCommand<A>>>;
}

const migrateUsage = () =>
  product() +
  ' migrate <new <name> | diff <name> | check | squash | status | up | validate | baseline | repair> [--app <dir>] ' +
  '[<db> | --db <target> | --config <path>] [--connection <name>] [--schema <name>] [--migrations <dir>] [--history-table <name>] ' +
  '[--schema-file <path>] [--dev-url <url>] [--dry-run] [--tool flyway] [--repeatable]';

/** The exit codes: what went wrong, for CI. */
const EXIT = { ok: 0, couldNot: 1, invalid: 2, failed: 3, app: 4 } as const;

const COMMANDS = ['new', 'diff', 'check', 'squash', 'status', 'up', 'validate', 'baseline', 'repair'] as const;
type Command = (typeof COMMANDS)[number];
/** The commands that compare the migrations with the desired schema.sql (desired.ts). */
const DESIRED: readonly Command[] = ['diff', 'check', 'squash'];

/* The start's own flags this command takes, and whether each has a value;
   anything else is a mode of the server and no business of a migration. */
const PASSED: Record<string, boolean> = {
  '--db': true,
  '-d': true,
  '--config': true,
  '--no-config': false,
  '--schema': true,
  '--app-entry': true,
  '--policy': true,
};

const shown = (path: string) => {
  const near = relative(process.cwd(), path);
  return !near ? '.' : near.startsWith('..') ? path : near;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export async function runMigrate<A extends MigrateApp>(
  argv: string[],
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  sections: ConfigSections = CACHE_SECTIONS,
  host?: MigrateHost<A>,
): Promise<number> {
  const hosted: Readonly<Record<string, MigrateCommand<A>>> = host?.commands ?? {};
  const fail = (why: string, code: number = EXIT.couldNot) => {
    console.error(`${product()} migrate: ${why}`);
    return code;
  };
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    write(
      `${migrateUsage()}\n\n` +
        "Versioned SQL files in Flyway's format (V3__add_payoff_quote.sql, R__views.sql), in migrations/ inside the App\n" +
        'by default, run forward only, each in its own transaction (MySQL: none, and a failure stops the run).\n' +
        '  new <name>  write the next V file (--repeatable: an R__ file)\n' +
        '  diff <name> write the next V file from schema.sql: what the migrations still lack to build it (Atlas;\n' +
        '              the first is schema.sql itself, with no download)\n' +
        '  check       the migrations, applied to a scratch database, build schema.sql (exit 2 if not)\n' +
        '  squash      fold the V files into one V1__baseline.sql holding schema.sql, before a database worth keeping exists\n' +
        "  status      what is applied and pending, drift made outside migrations, and whether the App's types are older than the database\n" +
        '              (exit 2 while nothing was ever applied)\n' +
        "  up          apply what is pending; with --app, regenerate the App's types and check it\n" +
        '  validate    applied files unchanged, nothing pending, nothing failed, no drift (exit 2 if not)\n' +
        '  baseline    record an existing database as version 0, and its schema beside the migrations\n' +
        '  repair      remove failed entries, accept changed files, mark missing ones deleted\n' +
        Object.entries(hosted)
          .map(([word, each]) => `  ${word.padEnd(11)} ${each.says}: ${each.usage.replace(`${product()} migrate `, '')}\n`)
          .join('') +
        'Exit codes: 1 could not run, 2 files and history disagree, 3 a migration failed, 4 applied but the App no longer checks.\n' +
        'mistri docs migrate is the guide.',
    );
    return EXIT.ok;
  }
  const command = argv[0] as Command;
  const own = Object.hasOwn(hosted, argv[0]) ? hosted[argv[0]] : undefined;
  if (!COMMANDS.includes(command) && !own) return fail(`"${argv[0]}" is not a migrate command. ${migrateUsage()}`);
  let name: string | undefined;
  let app: string | undefined;
  let migrations: string | undefined;
  let table: string | undefined;
  let connection: string | undefined;
  let tool: string | undefined;
  let dryRun = false;
  let repeatable = false;
  let schemaFile: string | undefined;
  let devUrl: string | undefined;
  let sub: string | undefined;
  const ownFlags: Record<string, string | true> = {};
  const rest: string[] = [];
  const value = (i: number, flag: string) => {
    const given = argv[i + 1];
    if (given === undefined || given.startsWith('-')) throw new Error(`${flag} needs a value. ${migrateUsage()}`);
    return given;
  };
  try {
    if (own) {
      sub = argv[1];
      if (sub === undefined) throw new Error(`${own.needs} ${own.usage}`);
    }
    for (let i = own ? 2 : 1; i < argv.length; i++) {
      const arg = argv[i];
      const theirs = Object.entries(hosted).find(([, each]) => Object.hasOwn(each.takes, arg));
      if (theirs) {
        if (!own || !Object.hasOwn(own.takes, arg)) throw new Error(`${arg} is for ${theirs[0]}.`);
        ownFlags[arg] = own.takes[arg] ? value(i++, arg) : true;
        continue;
      }
      if (arg === '--app') {
        if (app !== undefined) throw new Error('--app may be supplied only once.');
        app = value(i++, arg);
        continue;
      }
      if (arg === '--migrations') {
        migrations = value(i++, arg);
        continue;
      }
      if (arg === '--history-table') {
        table = value(i++, arg);
        continue;
      }
      if (arg === '--connection') {
        connection = value(i++, arg);
        continue;
      }
      if (arg === '--tool') {
        tool = value(i++, arg);
        continue;
      }
      if (arg === '--schema-file') {
        schemaFile = value(i++, arg);
        continue;
      }
      if (arg === '--dev-url') {
        devUrl = value(i++, arg);
        continue;
      }
      if (arg === '--dry-run') {
        dryRun = true;
        continue;
      }
      if (arg === '--repeatable') {
        repeatable = true;
        continue;
      }
      if ((command === 'new' || command === 'diff') && name === undefined && !arg.startsWith('-')) {
        name = arg;
        continue;
      }
      const flag = arg.split('=')[0];
      if (flag in PASSED) {
        rest.push(arg);
        if (PASSED[flag] && !arg.includes('=')) rest.push(value(i++, arg));
        continue;
      }
      if (arg.startsWith('-')) throw new Error(`"${arg}" is not an option of migrate. ${migrateUsage()}`);
      rest.push(arg);
    }
  } catch (error) {
    return fail((error as Error).message);
  }
  if (tool !== undefined && tool !== 'flyway')
    return fail(`--tool takes flyway, the one other runner it can hand the files to; "${tool}" is not it.`);
  if ((command === 'new' || command === 'diff') && !name)
    return fail(`${command} needs a name: ${product()} migrate ${command} add_payoff_quote`);
  if ((schemaFile !== undefined || devUrl !== undefined) && !DESIRED.includes(command))
    return fail(`--schema-file and --dev-url are for diff, check and squash; ${command} does not read schema.sql.`);
  if (DESIRED.includes(command) && (tool !== undefined || dryRun || repeatable))
    return fail(`${command} takes no --tool, --dry-run or --repeatable: it compares schema.sql with the migrations on scratch databases.`);
  if (own && (migrations !== undefined || table !== undefined || tool !== undefined || repeatable || (dryRun && !own.dryRun))) {
    return fail(`${command} takes no migration-file options. ${own.usage}`);
  }
  if (repeatable && command !== 'new') return fail('--repeatable is for new: it names the file R__<name>.sql.');
  if (dryRun && !own && !['up', 'baseline', 'repair'].includes(command))
    return fail(`--dry-run is for up, baseline and repair; ${command} changes nothing.`);
  if (tool && (command === 'new' || dryRun))
    return fail(
      command === 'new'
        ? 'new writes a file; no tool is needed for it.'
        : "Flyway's dry run is not in its free edition: drop --tool flyway to see the SQL.",
    );

  const opts = parseArgs(rest);
  if (opts.unknown) return fail(`unknown option "${opts.unknown}". ${migrateUsage()}`);
  const appDir = app !== undefined ? resolve(app) : undefined;
  if (appDir !== undefined && !host)
    return fail(
      "--app reads an App, which is the App framework's part: " +
        product() +
        ' migrates a database alone. Run npx @mistriwork/mistri migrate --app, or drop --app.',
    );
  if (appDir !== undefined && !existsSync(appDir)) return fail(`${app} is not a directory.`);

  /* The database, read the way a start reads it. Its narration is not this
     command's to print: stdout is what the migrations did. */
  const registry = new Registry();
  const log = console.log;
  console.log = () => {};
  try {
    const config = await readStartupConfig(opts, registry, sections);
    const argument = opts.target
      ? registry.add({ name: redact(opts.target), url: opts.target, schemas: opts.schemas, source: 'argument' }).id
      : undefined;
    let loaded: A | undefined;
    if (appDir !== undefined) {
      try {
        loaded = await host!.app(appDir, { opts, config, command, flags: ownFlags });
      } catch (error) {
        return fail((error as Error).message);
      }
    }
    const flags = { connection, argument, migrations, table, schemas: opts.schemas };

    if (own) {
      return await own.run(
        {
          sub: sub!,
          flags: ownFlags,
          registry,
          config,
          opts,
          sections,
          ...(appDir !== undefined ? { appDir } : {}),
          ...(loaded ? { app: loaded } : {}),
          ...(connection !== undefined ? { connection } : {}),
          ...(argument !== undefined ? { argument } : {}),
          schemas: opts.schemas,
          dryRun,
        },
        write,
      );
    }

    if (command === 'new') {
      const path = newMigration(targetDir(registry, config, flags, appDir, loaded?.binding), name!, repeatable);
      write(`wrote ${shown(path)}`);
      return EXIT.ok;
    }

    const target = await resolveTarget(registry, config, flags, appDir, loaded?.binding);
    if (DESIRED.includes(command)) {
      const file = schemaFile !== undefined ? resolve(schemaFile) : defaultSchemaFile(target.dir);
      /* The first migration is schema.sql itself: written before any diff tool
         is fetched, since the quickstart's first diff was a 40 MB download to
         copy one file into another. */
      if (command === 'diff' && !readMigrations(target.dir).files.some((each) => each.kind === 'versioned')) {
        const sql = firstMigration(file, dialectOf(target.url), target.schemas);
        const path = newMigration(target.dir, name!, false, new Date(), `${firstHeader()}${sql}`);
        write(`wrote ${shown(path)}:`);
        write(sql.trimEnd());
        return EXIT.ok;
      }
      /* The pinned binary is the project's: beside tablewalk.json, else the App, else here. */
      const project = config.configPath ? dirname(config.configPath) : (appDir ?? process.cwd());
      const atlas = await atlasBinary(project, (line) => console.error(`${product()} migrate: ${line}`));
      const options = { schemaFile: file, atlas, ...(devUrl !== undefined ? { devUrl } : {}) };
      return await runDesired(command, target, options, name, write);
    }
    const dialect = dialectOf(target.url);
    const appFlag = appDir !== undefined ? ` --app ${shown(appDir)}` : '';
    const where = `${target.connection.name} (${dialect}), history in ${target.table}, migrations in ${shown(target.dir)}`;

    if (tool) {
      write(`Running flyway ${FLYWAY_COMMANDS[command]} on ${where}`);
      const run = () => runFlyway(command, target, dialect, write);
      const code = command === 'up' || command === 'baseline' || command === 'repair' ? await recordAround(target, run) : await run();
      if (code !== 0) return command === 'up' ? EXIT.failed : command === 'validate' ? EXIT.invalid : EXIT.couldNot;
      if (command === 'up' && loaded) return (await loaded.check(rest, write)) ? EXIT.ok : EXIT.app;
      return EXIT.ok;
    }

    if (command === 'status') {
      const status = await migrationStatus(target);
      write(`Migrations of ${where}`);
      sayStatus(status, write);
      if (loaded) await loaded.types(registry, write);
      /* Never applied is not a state to report and pass: a deploy script that
         reads status before serving would serve an App with no tables. */
      if (!status.started) {
        if (!status.holds && !status.plan.pending.length)
          write(`No migrations to apply: ${product()} migrate diff init${appFlag} writes the first from schema.sql.`);
        return EXIT.invalid;
      }
      return EXIT.ok;
    }

    if (command === 'validate') {
      const { status, valid } = await migrateValidate(target);
      write(`Validating ${where}`);
      sayProblems(status, write);
      if (!status.started) write('  no migration history yet: ' + product() + ' migrate up, or baseline for a database that has tables');
      for (const file of status.plan.pending) write(`  pending: ${file.script} is not applied`);
      sayDrift(status, write);
      write(valid ? `Valid: ${plural(status.plan.history.versioned.size, 'migration')} applied, nothing pending, no drift.` : 'Not valid.');
      return valid ? EXIT.ok : EXIT.invalid;
    }

    if (command === 'baseline') {
      const result = await migrateBaseline(target, { dryRun });
      if (result.refused) return fail(result.refused, EXIT.invalid);
      if (result.already) {
        write(`${target.connection.name} is already ${result.already}; nothing to do.`);
        return EXIT.ok;
      }
      const tables = Object.keys(result.objects).filter((key) => key.startsWith('table ')).length;
      const objects = Object.keys(result.objects).length;
      if (dryRun) {
        write(
          `Would record ${where} as version 0: ${plural(tables, 'table')}, ${plural(objects, 'object')} in all, and write ${shown(result.file)}.`,
        );
        return EXIT.ok;
      }
      write(
        `Recorded ${target.connection.name} as version 0: ${plural(tables, 'table')}, ${plural(objects, 'object')} in all. Nothing in it was changed; migrations from V1 on change it.`,
      );
      write(
        result.wrote
          ? `wrote ${shown(result.file)} (read-only, never run): the schema as it was`
          : `kept ${shown(result.file)}, the snapshot an earlier baseline wrote`,
      );
      return EXIT.ok;
    }

    if (command === 'repair') {
      const { actions } = await migrateRepair(target, { dryRun });
      write(`${dryRun ? 'Would repair' : 'Repairing'} ${where}`);
      for (const action of actions) write(`  ${action}`);
      write(
        actions.length
          ? dryRun
            ? `${plural(actions.length, 'change')} to make.`
            : `Repaired: ${plural(actions.length, 'change')}.`
          : 'Nothing to repair.',
      );
      return EXIT.ok;
    }

    // up
    /* Nothing to apply and nothing ever applied is no schema at all, not "up to date". */
    if (!readMigrations(target.dir).files.length) {
      const status = await migrationStatus(target);
      if (!status.started && !status.holds)
        return fail(
          `there are no migrations in ${shown(target.dir)} and none was ever applied, so the schema never was. Write the first from schema.sql with ${product()} migrate diff init${appFlag}, then run ${product()} migrate up${appFlag} again.`,
          EXIT.invalid,
        );
    }
    const result = await migrateUp(target, { dryRun, waiting: () => write('waiting for another migration run to finish…') });
    write(`${dryRun ? 'Dry run of' : 'Migrating'} ${where}`);
    if (result.refused) return fail(result.refused, EXIT.invalid);
    if (result.status.plan.problems.length) {
      sayProblems(result.status, write);
      write('Nothing was applied.');
      return EXIT.invalid;
    }
    if (result.wouldRun) {
      if (!result.wouldRun.length) {
        write('Nothing to apply.');
        return EXIT.ok;
      }
      for (const file of result.wouldRun) {
        const how =
          dialect === 'mysql'
            ? 'as it is: MySQL commits DDL as it runs'
            : file.transactional
              ? 'in one transaction'
              : 'statement by statement, outside a transaction';
        write(`-- ${file.script}, ${how}`);
        write(file.sql.trimEnd());
        write(
          `-- then its row in ${target.table}: ${file.version !== undefined ? `version ${file.version}` : 'repeatable'}, "${file.description}", checksum ${file.checksum}`,
        );
        write('');
      }
      write(`${plural(result.wouldRun.length, 'migration')} would be applied.`);
      return EXIT.ok;
    }
    for (const { file, ms } of result.applied) write(`  applied ${file.script} (${ms} ms)`);
    if (result.failure) {
      write(`  failed  ${result.failure.file.script}: ${result.failure.message}`);
      write(`${plural(result.applied.length, 'migration')} applied before it; the run stopped there.`);
      return EXIT.failed;
    }
    if (!result.applied.length) {
      write(`Nothing to apply: up to date${sayVersion(result.status)}.`);
      return EXIT.ok;
    }
    write(`Applied ${plural(result.applied.length, 'migration')}: now${sayVersion(result.status)}.`);
    sayDrift(result.status, write);
    if (loaded) return (await loaded.check(rest, write)) ? EXIT.ok : EXIT.app;
    return EXIT.ok;
  } catch (error) {
    return fail((error as Error).message);
  } finally {
    console.log = log;
    await registry.closeAll();
  }
}

/** diff, check and squash: the migrations against schema.sql, on scratch databases. */
async function runDesired(
  command: Command,
  target: Awaited<ReturnType<typeof resolveTarget>>,
  options: Parameters<typeof pendingSql>[1],
  name: string | undefined,
  write: (line: string) => void,
): Promise<number> {
  const file = shown(options.schemaFile);
  const sql = await pendingSql(target, options);
  if (command === 'check') {
    if (!sql) {
      write(`${file} matches the migrations in ${shown(target.dir)}.`);
      return EXIT.ok;
    }
    write(`${file} and the migrations in ${shown(target.dir)} disagree. What the migrations still lack:`);
    write(sql.replace(/^/gm, '  '));
    write('Write it with: ' + product() + ' migrate diff <name>, or change schema.sql back.');
    return EXIT.invalid;
  }
  if (command === 'diff') {
    if (!sql) {
      write(`Nothing to write: the migrations already build ${file}.`);
      return EXIT.ok;
    }
    const path = newMigration(target.dir, name!, false, new Date(), `${diffHeader()}${sql}\n`);
    write(`wrote ${shown(path)}:`);
    write(sql);
    if (/\bDROP\b/i.test(sql))
      write('note: it drops something. If that is a rename, rewrite it as RENAME: a diff cannot tell a rename from a drop and an add.');
    return EXIT.ok;
  }
  // squash
  if (sql) {
    write(`${file} and the migrations disagree, so there is nothing settled to squash. What they still lack:`);
    write(sql.replace(/^/gm, '  '));
    write('Write it with ' + product() + ' migrate diff <name> first, or change schema.sql back.');
    return EXIT.invalid;
  }
  const versioned = readMigrations(target.dir).files.filter((each) => each.kind === 'versioned');
  if (versioned.length < 2) {
    write(`Nothing to squash: ${shown(target.dir)} holds ${plural(versioned.length, 'versioned migration')}.`);
    return EXIT.ok;
  }
  const { removed, wrote } = squashInto(target.dir, options.schemaFile, dialectOf(target.url));
  write(`Squashed ${plural(removed.length, 'migration')} into ${shown(wrote)}: ${removed.join(', ')} (git holds them).`);
  const again = await pendingSql(target, options);
  if (again) {
    write('The baseline does not build schema.sql on its own; what it lacks:');
    write(again.replace(/^/gm, '  '));
    return EXIT.invalid;
  }
  write(
    `It builds ${file}. A database migrated with the old files no longer matches its history: rebuild it, or ${product()} migrate repair.`,
  );
  return EXIT.ok;
}

function sayVersion(status: Status): string {
  const versions = [...status.plan.history.versioned.keys()];
  const at = versions.length ? versions[versions.length - 1] : (status.plan.history.baseline?.version ?? undefined);
  return at !== undefined && at !== null ? ` at version ${at}` : '';
}

function sayProblems(status: Status, write: (line: string) => void): void {
  for (const file of status.directory.ignored)
    write(`  warning: ${file} is not named as a migration (V<version>__<name>.sql or R__<name>.sql), so it is not run`);
  for (const note of status.plan.notes) write(`  note: ${note}`);
  for (const problem of status.plan.problems) write(`  error: ${problem}`);
}

function sayDrift(status: Status, write: (line: string) => void): void {
  if (status.behind) {
    write(
      `  note: ${plural(status.behind, 'migration')} ${status.behind === 1 ? 'was' : 'were'} applied by another runner after the schema was last recorded, so ${status.behind === 1 ? 'its' : 'their'} changes read as drift: ${product()} migrate repair records it again.`,
    );
  }
  if (!status.drift) return;
  if (!status.drift.length) return;
  write(
    `  Drift: ${plural(status.drift.length, 'change')} made outside migrations since they last ran. Adopt each in a migration, or undo it:`,
  );
  for (const change of status.drift) write(`    ${sayChange(change)}`);
}

function sayStatus(status: Status, write: (line: string) => void): void {
  const { history, pending } = status.plan;
  /* Versions in version order, then the repeatables by description, as they
     run; not the order they happened to be installed in. */
  const versioned: string[][] = [];
  const repeatable: string[][] = [];
  if (history.baseline)
    versioned.push([history.baseline.version ?? '', history.baseline.description, history.baseline.installed_on, 'baseline']);
  for (const row of [...history.versioned.values()].sort((a, b) => compareVersions(a.version!, b.version!)))
    versioned.push([row.version!, row.description, row.installed_on, 'applied']);
  for (const row of history.failed) versioned.push([row.version ?? 'R', row.description, row.installed_on, 'failed']);
  for (const file of pending.filter((each) => each.version !== undefined)) versioned.push([file.version!, file.description, '', 'pending']);
  for (const row of [...history.repeatable.values()].sort((a, b) => (a.description < b.description ? -1 : 1))) {
    const changed = pending.some((file) => file.version === undefined && file.description === row.description);
    repeatable.push(['R', row.description, row.installed_on, changed ? 'pending (changed)' : 'applied']);
  }
  for (const file of pending.filter((each) => each.version === undefined && !history.repeatable.has(each.description)))
    repeatable.push(['R', file.description, '', 'pending']);
  const rows = [...versioned, ...repeatable];
  if (!status.started)
    write(
      status.holds
        ? `  no migration history yet, and the database already holds ${status.holds} table${status.holds === 1 ? '' : 's'} or view${status.holds === 1 ? '' : 's'}: ${product()} migrate baseline records it as it is`
        : '  no migration history yet',
    );
  if (rows.length) {
    const widths = [7, 11, 19].map((min, i) => Math.max(min, ...rows.map((row) => row[i].length)));
    write(`  ${'version'.padEnd(widths[0])}  ${'description'.padEnd(widths[1])}  ${'installed'.padEnd(widths[2])}  state`);
    for (const row of rows) write(`  ${row[0].padEnd(widths[0])}  ${row[1].padEnd(widths[1])}  ${row[2].padEnd(widths[2])}  ${row[3]}`);
  }
  sayProblems(status, write);
  sayDrift(status, write);
  if (status.drift && !status.drift.length) write('  No drift: the schema is what the migrations made it.');
  if (status.started && !status.snapshot)
    write(
      '  note: no schema recorded by ' + product() + ' yet, so drift cannot be told: ' + product() + ' migrate repair records it as it is.',
    );
  write(
    pending.length
      ? `${plural(pending.length, 'migration')} pending: ${product()} migrate up`
      : status.started
        ? `Up to date${sayVersion(status)}.`
        : 'Nothing applied yet.',
  );
}
