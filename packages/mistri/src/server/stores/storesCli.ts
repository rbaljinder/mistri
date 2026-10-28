/**
 * `mistri migrate stores status | up`: the layouts mistri keeps in a
 * database of its own (storeLayouts.ts), read and brought forward in one
 * place. The databases are the ones the same inputs name everywhere else: an
 * App's connection, a config's connections, a database on the command line,
 * and with `--suite` the suite's identity, grant, preference, flag and
 * experiment stores and each App's connections.
 */
import type { ConfigSections } from '@mistriwork/engine/server/configSections.js';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { redact, type Registry } from '@mistriwork/engine/server/connections.js';
import { resolveConnection } from '@mistriwork/engine/server/auth/credentials.js';
import type { LoadedApp } from '../app/apps.js';
import type { StartupConfig } from '@mistriwork/engine/server/cli/config.js';
import { STORES, storeStatuses, upgradeStores, type StoreStatus } from '../storeLayouts.js';
import { dialectOf, openMigrationDb } from '@mistriwork/engine/server/migrate/database.js';
import { homeSourceOf, isTenantApp } from '../../shared/appModel.js';
import { getCommandEffects, getCommandEvents } from '../commands/businessCommands.js';
import { resolveTarget } from '@mistriwork/engine/server/migrate/target.js';
import { appBinding } from '../cli/appBinding.js';
import type { JobModule } from '../jobs/jobModule.js';
import type { ProvisionStoresOptions } from '../maintenance.js';
import type { AppTenantPolicy } from '../policy/appTenantPolicy.js';

export const STORES_USAGE =
  'mistri migrate stores <status | up> [--suite <suite.json>] [--app <dir> [--jobs <file>] [--policy <file>]] [<db> | --db <target> | --config <path>] [--connection <name>]';

/** A database to read: what to call it, and its address. */
interface StoreLocation {
  readonly label: string;
  readonly url: string;
}

const EXIT = { ok: 0, couldNot: 1, refused: 2, failed: 3 } as const;

const shown = (path: string) => {
  const near = relative(process.cwd(), path);
  return !near ? '.' : near.startsWith('..') ? path : near;
};

/** Every database the inputs name, each once, in the order they were named. */
async function storeLocations(input: {
  registry: Registry;
  config: StartupConfig;
  /** The config sections the bin reads (else the registry's): the analytics key and an App's services are read under them. */
  sections?: ConfigSections;
  appDir?: string;
  loaded?: LoadedApp;
  connection?: string;
  argument?: string;
  schemas: readonly string[];
  suite?: string;
  /** With `--app`: the jobs module whose stores `up` provisions too. */
  jobs?: string;
  /** With a tenant `--app`: its policy, the binding its stores are made under. */
  policy?: string;
}): Promise<{ locations: StoreLocation[]; problems: string[] }> {
  const locations: StoreLocation[] = [],
    problems: string[] = [];
  const add = (label: string, url: string) => {
    if (!locations.some((each) => each.url === url)) locations.push({ label, url });
  };
  const flags = { connection: input.connection, argument: input.argument, schemas: input.schemas };
  if (input.suite === undefined || input.connection !== undefined || input.argument !== undefined || input.appDir !== undefined) {
    if (input.connection !== undefined || input.argument !== undefined || input.appDir !== undefined) {
      const target = await resolveTarget(input.registry, input.config, flags, input.appDir, input.loaded && appBinding(input.loaded.app));
      add(target.connection.name, target.url);
    } else {
      for (const connection of input.registry.configs()) {
        if (connection.http) continue;
        try {
          add(connection.name, (await resolveConnection(connection.name, connection.url, { secrets: true })).url);
        } catch (error) {
          problems.push(`${connection.name}: ${(error as Error).message}`);
        }
      }
      if (input.config.configPath) {
        try {
          const { loadConfig } = await import('@mistriwork/engine/server/connections.js');
          const analytics = (await loadConfig(input.config.configPath, input.sections ?? input.registry.sections))?.analytics;
          if (analytics) add('analytics', analytics.store);
        } catch (error) {
          problems.push(`analytics: ${(error as Error).message}`);
        }
      }
      if (!locations.length && !problems.length && input.suite === undefined) {
        throw new Error(
          'no database to read. Name it — a SQLite file, --db <url>, --config <file> or --suite <file> — or keep a mistri.json beside where you run it.',
        );
      }
    }
  }
  if (input.suite !== undefined) {
    const { readSuiteConfiguration } = await import('../cli/suiteConfig.js');
    const suite = await readSuiteConfiguration(input.suite);
    if (suite.identity) {
      add('suite identity', suite.identity.store);
      add('suite grants', suite.identity.grants);
      if (existsSync(`${suite.identity.store}.preferences`)) add('suite preferences', `${suite.identity.store}.preferences`);
    }
    if (suite.flags) add('suite flags', suite.flags.store);
    if (suite.experiments) add('suite experiments', suite.experiments.store);
    if (suite.analytics) add('suite analytics', suite.analytics.store);
    const { loadConfig } = await import('@mistriwork/engine/server/connections.js');
    for (const app of suite.apps) {
      try {
        const loaded = await loadConfig(app.config, input.sections ?? input.registry.sections);
        if (loaded?.analytics && suite.analytics === undefined) add(`${app.id}: analytics`, loaded.analytics.store);
        for (const connection of loaded?.connections ?? []) {
          if (connection.http) continue;
          add(
            `${app.id}: ${connection.name}`,
            (await resolveConnection(connection.name, connection.url, { secrets: true, environment: app.environment })).url,
          );
        }
      } catch (error) {
        problems.push(`${app.id}: ${(error as Error).message}`);
      }
    }
  }
  return { locations, problems };
}

/**
 * The databases the same inputs name that hold a store behind its layout, as
 * `label: store, store` lines; empty when none is, or when they cannot be
 * read. A start that refused a store asks this to say how to bring it
 * forward, so it never throws: the refusal it is explaining comes first.
 */
export async function storesBehind(input: Parameters<typeof storeLocations>[0]): Promise<string[]> {
  try {
    const { locations } = await storeLocations(input);
    const lines: string[] = [];
    for (const location of locations) {
      let db: Awaited<ReturnType<typeof openMigrationDb>>;
      try {
        db = await openMigrationDb(location.url, [], false);
      } catch {
        continue;
      }
      try {
        const behind = (await storeStatuses(db)).filter((status) => status.found !== null && status.pending.length && !status.refused);
        if (behind.length) lines.push(`${location.label}: ${behind.map((status) => status.id).join(', ')}`);
      } finally {
        await db.close().catch(() => {});
      }
    }
    return lines;
  } catch {
    return [];
  }
}

/** A URL as it was given, minus its password (the user's own keychain or PGPASSWORD supplies it again); a path as it is. */
function withoutPassword(target: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return target;
  try {
    const url = new URL(target);
    url.password = '';
    return url.href;
  } catch {
    return '<database url>';
  }
}

/** `mistri migrate stores up` with the arguments a start was given, so it reaches the same databases. A URL's password is never written. */
export function storesUpCommand(
  given: Readonly<{ suite?: string; apps?: readonly string[]; config?: string; target?: string; policy?: string }>,
): string {
  const word = (text: string) => (/^[\w@%+=:,./~-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`);
  const parts = ['mistri migrate stores up'];
  if (given.suite !== undefined) parts.push('--suite', word(given.suite));
  else {
    if (given.apps?.length === 1) parts.push('--app', word(given.apps[0]));
    // A tenant App's stores are made under its policy's binding: without it, `up` makes none of them.
    if (given.apps?.length === 1 && given.policy) parts.push('--policy', word(given.policy));
    if (given.config) parts.push('--config', word(given.config));
    if (given.target) parts.push(word(withoutPassword(given.target)));
  }
  return parts.join(' ');
}

/** A tenant App's own stores (TENANT_ORDER's), as its policy declares them: what its start attests beside the
 * command journal, the sandboxes and the record history. */
function tenantPolicyStores(policy: Pick<AppTenantPolicy, 'administration' | 'invitations' | 'support'>): string[] {
  return [
    'tenant-store',
    ...(policy.administration || policy.invitations || policy.support ? ['tenant-administration'] : []),
    ...(policy.invitations ? ['tenant-invitations'] : []),
    ...(policy.support ? ['tenant-support-audit'] : []),
  ];
}

/** The stores a tenant App's start attests in its own database, by their id in the store list. */
export function tenantStoresNeeded(
  loaded: Pick<LoadedApp, 'app' | 'pages'>,
  policy: Pick<AppTenantPolicy, 'administration' | 'invitations' | 'support'>,
  registry: Readonly<Record<string, Parameters<typeof getCommandEvents>[0]>> | undefined,
  history: (app: LoadedApp['app'], pages: LoadedApp['pages']) => ReadonlyMap<string, unknown>,
): string[] {
  const commands = Object.values(registry ?? {});
  return [
    ...tenantPolicyStores(policy),
    ...(commands.length ? ['command-journal'] : []),
    ...(commands.some((command) => getCommandEvents(command) || getCommandEffects(command)) ? ['command-events'] : []),
    ...(Object.values(loaded.app.resources ?? {}).some((resource) => resource.clone !== undefined) ? ['tenant-sandboxes'] : []),
    ...(history(loaded.app, loaded.pages).size ? ['record-history'] : []),
  ];
}

/**
 * Which of these stores the database at `url` holds none of. A start that
 * refused asks it, once the database has been opened, to name what to make;
 * like `storesBehind`, it never throws.
 */
export async function storesAbsentAt(url: string, ids: readonly string[]): Promise<string[]> {
  try {
    const db = await openMigrationDb(url, [], false);
    try {
      const found = new Map((await storeStatuses(db)).map((status) => [status.id, status.found]));
      return ids.filter((id) => found.has(id) && found.get(id) === null);
    } finally {
      await db.close().catch(() => {});
    }
  } catch {
    return [];
  }
}

const placed = (location: StoreLocation) =>
  dialectOf(location.url) === 'sqlite' ? shown(location.url.replace(/^sqlite:(\/\/)?/i, '')) : redact(location.url);

function line(status: StoreStatus): string {
  const found = status.found === null ? (status.refused ? 'unreadable' : 'absent') : `v${status.found}`;
  const pending = status.refused
    ? `refused: ${status.refused}`
    : status.found === null
      ? ''
      : status.pending.length
        ? `pending ${status.pending.map((from) => `${from}→${from + 1}`).join(', ')}`
        : 'up to date';
  return `  ${status.id.padEnd(22)} ${found.padEnd(10)} current v${String(status.current).padEnd(3)} ${pending}`.trimEnd();
}

export async function runStores(sub: string, input: Parameters<typeof storeLocations>[0], write: (line: string) => void): Promise<number> {
  const fail = (why: string) => {
    console.error(`mistri migrate stores: ${why}`);
    return EXIT.couldNot;
  };
  if (sub !== 'status' && sub !== 'up') return fail(`"${sub}" is not a stores command. ${STORES_USAGE}`);
  let found: Awaited<ReturnType<typeof storeLocations>>;
  try {
    found = await storeLocations(input);
  } catch (error) {
    return fail((error as Error).message);
  }
  let code: number = EXIT.ok;
  for (const problem of found.problems) {
    console.error(`mistri migrate stores: ${problem}`);
    code = EXIT.couldNot;
  }
  for (const location of found.locations) {
    let db: Awaited<ReturnType<typeof openMigrationDb>>;
    try {
      db = await openMigrationDb(location.url, [], false);
    } catch (error) {
      console.error(`mistri migrate stores: ${location.label}: ${(error as Error).message}`);
      code = EXIT.couldNot;
      continue;
    }
    try {
      const where = placed(location);
      write(`${sub === 'up' ? 'Upgrading' : 'Stores in'} ${location.label} (${db.dialect}${where === location.label ? '' : `, ${where}`})`);
      if (sub === 'status') {
        for (const status of await storeStatuses(db)) write(line(status));
        continue;
      }
      const result = await upgradeStores(db, location.url);
      for (const step of result.applied) write(`  ${step.id} v${step.from} → v${step.to}: ${step.says}`);
      for (const step of result.failed) {
        write(`  ${step.id} v${step.from} → v${step.from + 1} failed, rolled back: ${step.message}`);
        code = EXIT.failed;
      }
      for (const store of result.refused) {
        write(`  ${store.id} refused: ${store.message}`);
        if (code === EXIT.ok) code = EXIT.refused;
      }
      if (!result.applied.length && !result.failed.length && !result.refused.length) write('  nothing to upgrade.');
    } catch (error) {
      console.error(`mistri migrate stores: ${location.label}: ${(error as Error).message}`);
      code = EXIT.couldNot;
    } finally {
      await db.close();
    }
  }
  if (sub === 'up' && input.loaded && code !== EXIT.couldNot)
    code = Math.max(code, await provisionAppStores(input.registry, input.loaded, input.jobs, input.policy, write));
  if (sub === 'status')
    write(
      `${STORES.filter((store) => Object.keys(store.current).length > 0).length} stores known; \`mistri migrate stores up\` applies what is pending.`,
    );
  return code;
}

/**
 * With `--app`, `up` also creates every store the App uses and the database
 * lacks, on the connection each belongs on: the notification store beside
 * the resources that notify, the record history beside the resources a page
 * shows the history of, the command journal on each connection its commands
 * run on, and, when a command records events, posts effects or `--jobs`
 * names a module, the App's event store, their delivery destinations, the
 * job, workflow and integrations stores beside them. The App is the binding
 * a bare database does not carry, so this is the one place all of them can
 * be made by one command. Each is idempotent: present, it is left as it is.
 * A tenant App's stores are bound to its policy: with `--policy`, `up` makes
 * what its start attests (the tenant store and the journals its policy
 * declares, the command journal, sandboxes, record history, and the event,
 * effect and job stores bound to every tenant); without it, it says so and
 * only upgrades what the database holds (above).
 */
async function provisionAppStores(
  registry: Registry,
  loaded: LoadedApp,
  jobsFile: string | undefined,
  policyFile: string | undefined,
  write: (line: string) => void,
): Promise<number> {
  const { app } = loaded;
  /* Without its policy a tenant App's stores have no binding to be made under: said, and the upgrade above stands. */
  if (isTenantApp(app) && policyFile === undefined) {
    write("  a tenant App's stores are bound to its policy: add --policy <file> to provision them.");
    return EXIT.ok;
  }
  const registryOf = loaded.commands?.registry;
  const commands = registryOf ? Object.values(registryOf) : [];
  const connectionOf = (source: string | undefined) =>
    (source === undefined ? undefined : app.sources?.[source]?.connection) ?? app.connection;
  /* A logical resource is `source.table` outside the default source, bare inside it (appModel.ts logicalResource). */
  const sourceOfResource = (resource: string) => {
    const dot = resource.indexOf('.');
    const named = dot > 0 ? resource.slice(0, dot) : undefined;
    return named !== undefined && app.sources?.[named] ? named : homeSourceOf(app);
  };
  const [{ storeTargetOf }, maintenance, { historyRules }, { migrateSqliteCommandJournal }, { migratePostgresCommandJournal }] =
    await Promise.all([
      import('../commands/appCommandEvents.js'),
      import('../maintenance.js'),
      import('../recordHistory.js'),
      import('../../adapters/commands/commandJournal.js'),
      import('../../adapters/commands/postgresCommandJournal.js'),
    ]);
  const jobLoader = jobsFile !== undefined && registryOf ? await import('../jobs/jobLoader.js') : undefined;
  /* A tenant App's module is wrapped with its machine timers by the provisioning itself, as its start wraps it. */
  const jobs =
    jobLoader &&
    (isTenantApp(app) ? await jobLoader.loadJobModule(jobsFile!) : await jobLoader.servedJobModule(jobsFile!, app, registryOf!));
  if (jobsFile !== undefined && !registryOf) {
    write("  jobs: a jobs module runs the App's commands, and this App has none");
    return EXIT.couldNot;
  }
  type Target = NonNullable<ReturnType<typeof storeTargetOf>>;
  /* Where a step provisions: the connection's address, its engine, and the store target a SQLite or PostgreSQL one has. */
  type Step = (where: { url: string; dialect: string; target?: Target }) => Promise<string | undefined>;
  /** A store kept only in SQLite or PostgreSQL. */
  class Unkept extends Error {}
  const kept = (where: { target?: Target }, what: string): Target => {
    if (!where.target) throw new Unkept(`${what} is kept in SQLite or PostgreSQL`);
    return where.target;
  };
  /* What each connection holds, in the order a start attests them. */
  const steps = new Map<string, Step[]>();
  const add = (connection: string | undefined, step: Step) => {
    if (connection === undefined) return;
    steps.set(connection, [...(steps.get(connection) ?? []), step]);
  };
  const said = (what: string, outcome: { provisioned: boolean }) => `${what} ${outcome.provisioned ? 'provisioned' : 'present'}`;
  /* The store list's own provisioning (maintenance.ts provisionStores), on the database each store belongs in. */
  const provision = (where: { url: string; dialect: string; target?: Target }, options: ProvisionStoresOptions) =>
    maintenance.provisionStores(where.dialect === 'mysql' ? { mysql: where.url } : where.target!, options);
  /* A store the list keeps on every engine, or only where a store target is (SQLite, PostgreSQL). */
  const unbound = (id: string, what: string, everywhere: boolean) => async (where: { url: string; dialect: string; target?: Target }) => {
    if (!(everywhere && where.dialect === 'mysql')) kept(where, what);
    const made = (await provision(where, { only: [id] })).stores[id];
    return said(`${what} v${made.version}`, made);
  };
  /* Each connection's steps, in order: a step that cannot be kept on its engine is said and the rest go on. */
  const run = async (): Promise<number> => {
    let code: number = EXIT.ok;
    for (const [name, todo] of steps) {
      const config = registry.configs().find((each) => each.id === name || each.name === name);
      if (!config) {
        write(`  stores: connection "${name}" is not in the config`);
        code = EXIT.couldNot;
        continue;
      }
      try {
        const { url } = await resolveConnection(config.name, config.url, { secrets: true });
        const where = { url, dialect: dialectOf(url), target: storeTargetOf(url) };
        for (const step of todo) {
          try {
            const done = await step(where);
            if (done !== undefined) write(`  ${config.name}: ${done}`);
          } catch (error) {
            if (!(error instanceof Unkept)) throw error;
            write(`  ${config.name}: ${error.message}, and this connection is ${where.dialect}`);
            if (code === EXIT.ok) code = EXIT.refused;
          }
        }
      } catch (error) {
        write(`  ${config.name}: the App's stores could not be provisioned: ${(error as Error).message}`);
        code = EXIT.failed;
      }
    }
    return code;
  };
  if (isTenantApp(app)) {
    const { loadAppTenantPolicy } = await import('../policy/appTenantPolicy.js');
    let policy: Awaited<ReturnType<typeof loadAppTenantPolicy>>;
    try {
      policy = await loadAppTenantPolicy(policyFile!);
    } catch (error) {
      write(`  the tenant policy did not load: ${(error as Error).message}`);
      return EXIT.couldNot;
    }
    const source = homeSourceOf(app)!,
      home = app.sources![source].connection;
    /* What the start attests (tenantFeature*.ts), bound as enrollment binds it (tenantEnrollment.ts). */
    const binding = { appId: app.id, source: { id: source, connection: home }, storeId: policy.storeId };
    const tenantStores = tenantPolicyStores(policy);
    add(home, async (where) => {
      kept(where, "a tenant App's stores");
      const made = await provision(where, { app: { id: app.id, tenant: binding }, only: tenantStores });
      return tenantStores.map((id) => said(`${id} v${made.stores[id].version}`, made.stores[id])).join(', ');
    });
    if (registryOf)
      add(home, async (where) => {
        const target = kept(where, 'the command journal');
        const journal =
          'sqlite' in target ? migrateSqliteCommandJournal(target.sqlite) : await migratePostgresCommandJournal(target.postgres);
        return `command journal v${journal.version} ${journal.migrated ? 'provisioned' : 'present'}`;
      });
    if (Object.values(app.resources ?? {}).some((resource) => resource.clone !== undefined))
      add(home, unbound('tenant-sandboxes', 'sandbox store', false));
    if (historyRules(app, loaded.pages).size) add(home, unbound('record-history', 'record history', true));
    /* Live sync's change store, where every tenant's writes are told to the pages that show them. */
    add(home, unbound('live-change', 'live sync store', true));
    /* What a production build's start last validated (tenantValidationRecord.ts): PostgreSQL's only, and never
       required — a database without it is checked in full at every start, so a SQLite one is passed over unsaid. */
    add(home, async (where) =>
      where.dialect === 'postgres' ? await unbound('validation-record', 'validation record', false)(where) : undefined,
    );
    /* The event store, the effects' destinations and the jobs' stores, each bound to every tenant of the App. */
    if (registryOf && (jobs || commands.some((command) => getCommandEvents(command) || getCommandEffects(command))))
      add(home, async (where) => {
        kept(where, "the commands' event store");
        const made = await provision(where, {
          app: { id: app.id, tenant: binding, commands: registryOf, definition: app, pages: loaded.pages },
          ...(jobs ? { jobs: jobs as unknown as JobModule } : {}),
        });
        const stores = Object.entries(made.stores).map(([id, store]) => said(id, store));
        return [...stores, `${made.destinations.length} delivery destination(s)`].join(', ');
      });
    return run();
  }
  const notifying = Object.entries(app.resources ?? {}).filter(([, resource]) => resource.notify?.length);
  for (const connection of new Set(notifying.map(([id]) => connectionOf(sourceOfResource(id)))))
    add(connection, unbound('inbox', 'notification store', true));
  /* A rule that emails an address the record holds queues its mail in the integrations store, in the write's transaction. */
  const emailing = notifying.filter(([, resource]) => resource.notify!.some((rule) => rule.send?.channel === 'email'));
  for (const connection of new Set(emailing.map(([id]) => connectionOf(sourceOfResource(id)))))
    add(connection, unbound('integrations', 'integrations store', false));
  for (const connection of new Set([...historyRules(app, loaded.pages).keys()].map((id) => connectionOf(sourceOfResource(id)))))
    add(connection, unbound('record-history', 'record history', true));
  /* Live sync's change store, on every database a resource is read from: a page showing any of them is told of its writes. */
  for (const connection of new Set(Object.keys(app.resources ?? {}).map((id) => connectionOf(sourceOfResource(id)))))
    add(connection, unbound('live-change', 'live sync store', true));
  for (const connection of new Set(commands.map((command) => connectionOf(command.source))))
    add(connection, async (where) => {
      const target = kept(where, 'the command journal');
      const journal =
        'sqlite' in target ? migrateSqliteCommandJournal(target.sqlite) : await migratePostgresCommandJournal(target.postgres);
      return `command journal v${journal.version} ${journal.migrated ? 'provisioned' : 'present'}`;
    });
  const emitting = commands.find((command) => getCommandEvents(command));
  if (emitting)
    add(connectionOf(emitting.source), async (where) => {
      kept(where, 'the event store');
      const events = (await provision(where, { app: { id: app.id, source: emitting.source } })).stores['command-events'];
      return said(`event store for App "${app.id}" v${events.version}`, events);
    });
  const posting = commands.find((command) => getCommandEffects(command));
  if (posting && registryOf)
    add(connectionOf(posting.source), async (where) => {
      kept(where, "effects' deliveries");
      const effects = await provision(where, { app: { id: app.id, commands: registryOf } });
      const added = effects.destinations.filter((each) => each.added).length;
      return `effects: ${effects.destinations.length} destination(s), ${added} added`;
    });
  if (jobs && registryOf) {
    /* The jobs' stores sit beside the commands they run, as a start derives them (jobLoader.ts). */
    const inbound = new Set([...jobs.inbound.values()].map((endpoint) => endpoint.command.id));
    const anchor =
      Object.entries(registryOf).find(([id, command]) => command.integrations || getCommandEffects(command) || inbound.has(id))?.[1] ??
      commands[0];
    const sourceId =
      jobs.jobs.size || jobs.workflows.size
        ? jobLoader!.jobDeployment(jobs, { appId: app.id, commands: registryOf }).sourceId
        : anchor?.source;
    add(connectionOf(sourceId), async (where) => {
      kept(where, "the jobs' stores");
      /* The module as the server runs it, its machine timers among its jobs: maintenance captures it again as it is. */
      const made = await provision(where, { app: { id: app.id, commands: registryOf }, jobs: jobs as unknown as JobModule });
      const store = (id: string) => made.stores[id];
      const parts = [
        /* Only a job store made is said: a module that needs none and one already there both leave it unsaid. */
        store('jobs')?.provisioned ? 'job store provisioned' : undefined,
        `${made.destinations.length} delivery destination(s), ${made.destinations.filter((each) => each.added).length} added`,
        store('workflows') === undefined ? undefined : `workflow store ${store('workflows').provisioned ? 'provisioned' : 'present'}`,
        store('integrations') === undefined
          ? undefined
          : `integrations store ${store('integrations').provisioned ? 'provisioned' : 'present'}`,
      ];
      return `jobs: ${parts.filter(Boolean).join(', ')}`;
    });
  }
  return run();
}
