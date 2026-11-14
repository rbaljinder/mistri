/**
 * An App as `mistri migrate` and `mistri seed` read it: the App
 * framework's half of two engine commands.
 *
 * The engine's migrate (migrate/cli.ts) and seed (seed/cli.ts) read a
 * database the way a start reads one and know nothing of Apps. With `--app`,
 * this says which connection the App binds and which schemas its sources
 * keep (the target), regenerates its types and checks it after `up`, adds the
 * commands only an App has — `migrate stores`, `migrate files` and `migrate backstop` — and gives
 * seed the App's machines and its people. The mistri main hands these to the
 * engine commands (mistriCommands.ts); the database browser's main hands
 * none, and its migrate and seed take no `--app`.
 */
import { relative } from 'node:path';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { loadApp, type LoadedApp } from '../app/apps.js';
import { AppProblems, type AppDef } from '../../shared/app.js';
import { machinePath, type AppMachineDef } from '../../shared/appMachine.js';
import { stateStampColumn, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { Options } from '@mistriwork/engine/server/cli/args.js';
import { appEntries } from '@mistriwork/engine/server/config/profile.js';
import { appBinding } from './appBinding.js';
import { isTenantApp } from '../../shared/appModel.js';
import type { StartupConfig } from '@mistriwork/engine/server/cli/config.js';
import type { MigrateApp, MigrateHost } from '@mistriwork/engine/server/migrate/cli.js';
import type { SeedLife, SeedResource } from '@mistriwork/engine/server/seed/seed.js';
import type { SeedHost } from '@mistriwork/engine/server/seed/cli.js';
import { STORES_USAGE } from '../stores/storesCli.js';
import { FILES_USAGE } from '../files/filesCli.js';

/* Kept here, not in backstopCli.ts, which reads tenancy: loading this module for its usage lines must not. */
const BACKSTOP_USAGE =
  'mistri migrate backstop <status | new> --app <dir> --policy <file> [--runtime <role>] [--connection <name>] [--config <path>]';

const shown = (path: string) => {
  const near = relative(process.cwd(), path);
  return !near ? '.' : near.startsWith('..') ? path : near;
};

/**
 * The App in `appDir`, loaded for a run that reads its database rather than serves it. An App whose views are
 * refused still names its connection, sources and machines, which is all these commands need of it; `check` says
 * the rest. Throws with the sentence to print when it does not load at all.
 */
async function loadTargetApp(appDir: string, opts: Options, config: StartupConfig, commands?: string): Promise<LoadedApp> {
  try {
    return await loadApp(appDir, {
      lock: 'report',
      ...(opts.appEntry !== undefined ? { entry: opts.appEntry } : {}),
      ...(config.appEnv[appDir] ? { env: config.appEnv[appDir] } : {}),
      ...(commands !== undefined ? { commands } : {}),
    });
  } catch (error) {
    if (!(error instanceof AppProblems && error.partial))
      throw new Error(`the App in ${shown(appDir)} did not load: ${(error as Error).message.split('\n')[0]}`, { cause: error });
    return { path: appDir, dir: appDir, app: error.partial as AppDef, pages: [], sources: {} };
  }
}

/** A build's bundled commands module, at the versions its authority.lock holds, as a start reads it (commandHost.ts). */
async function builtCommands(file: string, loaded: LoadedApp): Promise<NonNullable<LoadedApp['commands']>> {
  const [{ loadBusinessCommands }, { withCommandVersions }, { lockedVersion }] = await Promise.all([
    import('../commands/businessCommandLoader.js'),
    import('../commands/businessCommands.js'),
    import('../commands/commandContracts.js'),
  ]);
  return { file, registry: withCommandVersions(await loadBusinessCommands(file), lockedVersion(loaded.authority?.lock)) };
}

/** What a migrate run keeps of its App: the loaded App the stores and files commands read, and its jobs module. */
interface MigrateAppRun extends MigrateApp {
  readonly loaded: LoadedApp;
  readonly jobs?: string;
}

/** `mistri migrate`, as the App framework extends it. */
export const MIGRATE_APPS: MigrateHost<MigrateAppRun> = {
  async app(appDir, { opts, config, command }) {
    let loaded = await loadTargetApp(appDir, opts, config, opts.commands);
    let jobs = opts.jobs;
    /* A build holds its commands and jobs as the bundles it was built with, not as a commands.ts beside its
       manifest, so the definition alone named no command, and `stores up` provisioned nothing a command, an
       event or a job needs. Its own entries are read, as a source's commands.ts is; a flag that names another
       module is refused, as a start refuses it (cli/apps.ts assertBuildEntries). */
    if (loaded.build) {
      const own = loaded.build.entries;
      const { assertBuildEntries } = await import('./apps.js');
      assertBuildEntries({ commands: opts.commands, jobs, policy: opts.policy }, [loaded]);
      if (own.commands) loaded = { ...loaded, commands: await builtCommands(own.commands, loaded) };
      if (command !== 'files') jobs ??= own.jobs;
    }
    return {
      loaded,
      binding: appBinding(loaded.app),
      ...(jobs !== undefined ? { jobs } : {}),
      /* Whether the App's generated types still say what the database does. */
      async types(registry: Registry, write: (line: string) => void) {
        const { schemaTypes } = await import('../build/check.js');
        const step = await schemaTypes(registry, loaded, appDir, false);
        if (step.status === 'failed')
          write(`  warning: ${step.detail}. mistri check --app ${shown(appDir)} regenerates them and says what no longer fits.`);
      },
      /* The bootstrap plan's App phases (stores/bootstrap.ts): the stores, the sign-in store, seed data, and the
         check. The migrations are in the database whatever the check says, forward only, so a failure there names
         what to fix, in the App or in a migration that puts back what it needs; a store still absent is said as one,
         never as a schema the App no longer fits (a field report). */
      entries: appEntries(loaded, opts),
      async bootstrap(input) {
        const { bootstrapPhases } = await import('../stores/bootstrap.js');
        return bootstrapPhases(
          {
            loaded,
            appDir,
            config,
            ...(jobs !== undefined ? { jobs } : {}),
            async check(given, write) {
              let rest = given;
              const { runCheck } = await import('../build/check.js');
              /* The check is a start of its own, and a tenant App's start refuses without its policy: the one this run
                 resolved (a flag, or the `app` block of mistri.json) goes with it, so a check never judges the App
                 beside a different answer than the migrations were run beside. */
              const named = (flag: string) => rest.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
              /* A tenant App's start refuses a database named on the command line (its connections are the config's), so
                 the file `migrate up <db>` ran against is not passed on: the check reads the connection the App binds,
                 which is the one the migrations were run on (a field report: the migration applied, then exit 4). */
              if (isTenantApp(loaded.app) && opts.target !== undefined) {
                const at = rest.indexOf(opts.target);
                if (at >= 0) rest = rest.filter((_, index) => index !== at && !(index === at - 1 && rest[index] === '--db'));
              }
              return runCheck(
                ['--app', appDir, ...rest, ...(opts.policy !== undefined && !named('--policy') ? ['--policy', opts.policy] : [])],
                write,
              );
            },
          },
          input,
        );
      },
    };
  },
  commands: {
    stores: {
      says: 'the layouts mistri keeps in a database of its own',
      usage: STORES_USAGE,
      needs: 'stores needs status or up.',
      takes: { '--suite': true },
      async run(input, write) {
        const { runStores } = await import('../stores/storesCli.js');
        return runStores(
          input.sub,
          {
            registry: input.registry,
            config: input.config,
            appDir: input.appDir,
            loaded: input.app?.loaded,
            connection: input.connection,
            argument: input.argument,
            schemas: input.schemas,
            ...(typeof input.flags['--suite'] === 'string' ? { suite: input.flags['--suite'] } : {}),
            sections: input.sections,
            ...(input.opts.policy !== undefined ? { policy: input.opts.policy } : {}),
            ...((input.app?.jobs ?? input.opts.jobs) !== undefined ? { jobs: (input.app?.jobs ?? input.opts.jobs)! } : {}),
          },
          write,
        );
      },
    },
    files: {
      says: "move an App's files to where each resource's storage says, or sweep its bucket",
      usage: FILES_USAGE,
      needs: 'files needs status, up or sweep.',
      takes: {},
      dryRun: true,
      async run(input, write) {
        const { runFiles } = await import('../files/filesCli.js');
        return runFiles(
          input.sub,
          {
            registry: input.registry,
            config: input.config,
            appDir: input.appDir,
            loaded: input.app?.loaded,
            connection: input.connection,
            argument: input.argument,
            schemas: input.schemas,
            ...(input.opts.policy !== undefined ? { policy: input.opts.policy } : {}),
            dryRun: input.dryRun,
          },
          write,
        );
      },
    },
    backstop: {
      says: "a tenant App's row-security backstop: what its database lacks of it, or the migration that makes it",
      usage: BACKSTOP_USAGE,
      needs: 'backstop needs status or new.',
      takes: { '--runtime': true },
      async run(input, write) {
        const { runBackstop } = await import('./backstopCli.js');
        return runBackstop(
          input.sub,
          {
            registry: input.registry,
            config: input.config,
            appDir: input.appDir,
            loaded: input.app?.loaded,
            connection: input.connection,
            argument: input.argument,
            schemas: input.schemas,
            ...(input.opts.policy !== undefined ? { policy: input.opts.policy } : {}),
            ...(typeof input.flags['--runtime'] === 'string' ? { runtime: input.flags['--runtime'] } : {}),
          },
          write,
        );
      },
    },
  },
};

/** A machine as seed walks it: the forward path, the side states, the exits, and what entering each state stamps. */
const isNow = (value: unknown) => Boolean(value) && typeof value === 'object' && (value as { auto?: unknown }).auto === 'now';

export function lifeOfMachine(table: TableMeta, machine: AppMachineDef): SeedLife {
  const path = machinePath(machine);
  const finals = new Set(machine.states.filter((state) => state.final).map((state) => state.name));
  const stamps = new Map<string, string[]>();
  const reasons = new Map<string, string>();
  const holds = new Map<string, string>();
  for (const state of machine.states) {
    const own = stateStampColumn(state.name, table.columns, machine);
    stamps.set(state.name, own ? [own.name] : []);
  }
  for (const edge of machine.edges) {
    for (const to of edge.to) {
      const set = Object.entries(edge.fixed?.set ?? {})
        .filter(([, value]) => isNow(value))
        .map(([column]) => column);
      stamps.set(to, [...new Set([...(stamps.get(to) ?? []), ...set])]);
      if (edge.fixed?.reason) reasons.set(to, edge.fixed.reason);
      if (!path.includes(to) && !finals.has(to) && path.includes(edge.from) && !holds.has(to)) holds.set(to, edge.from);
    }
  }
  return {
    column: machine.column,
    ...(machine.since ? { since: machine.since } : {}),
    path,
    holds,
    exits: [...finals].filter((state) => !path.includes(state)),
    stamps,
    reasons,
  };
}

/** The columns an App declares as money in minor units. */
function minorColumns(display: Record<string, { format?: string; minor?: boolean }> | undefined): string[] | undefined {
  const names = Object.entries(display ?? {})
    .filter(([, rule]) => rule.format === 'money' && rule.minor === true)
    .map(([name]) => name);
  return names.length ? names : undefined;
}

/** `mistri seed`, as the App framework extends it: the App's tables, each status the way its machine moves it. */
export const SEED_APPS: SeedHost = {
  async app(appDir, { opts, config }) {
    const { app } = await loadTargetApp(appDir, opts, config);
    const resources: Record<string, SeedResource> | undefined = app.resources
      ? Object.fromEntries(
          Object.entries(app.resources).map(([name, resource]) => {
            const machine = resource.machine;
            return [
              name,
              {
                ...(machine ? { life: (table: TableMeta) => lifeOfMachine(table, machine) } : {}),
                ...(resource.types ? { types: resource.types } : {}),
                ...(minorColumns(resource.display) ? { minor: minorColumns(resource.display) } : {}),
              },
            ];
          }),
        )
      : undefined;
    const me = app.auth?.me;
    return {
      binding: appBinding(app),
      ...(resources ? { resources } : {}),
      ...(me ? { people: { table: me.from, column: me.column } } : {}),
    };
  },
};
