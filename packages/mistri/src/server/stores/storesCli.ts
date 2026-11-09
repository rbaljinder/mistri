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
import { projectContext } from '@mistriwork/engine/server/config/profile.js';
import { appBinding } from '../cli/appBinding.js';
import { runsJobs, type JobModule } from '../jobs/jobModule.js';
import type { ProvisionStoresOptions } from '../maintenance.js';
import type { AppTenantPolicy } from '../policy/appTenantPolicy.js';
import type { EventDeliveryPolicy } from '../../adapters/events/eventDeliveryTypes.js';

export const STORES_USAGE =
  'mistri migrate stores <status | up> [--suite <suite.json>] [--app <dir> [--commands <file>] [--jobs <file>] [--policy <file>]] [<db> | --db <target> | --config <path>] [--connection <name>]';

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

/**
 * `mistri migrate up --app …` with the entries a run was given, so the one command that applies the App's migrations
 * and makes its stores (docs/bootstrap-plan.md) reaches the same databases and the same jobs. What `check` names as the
 * fix for `store-pending`. A URL's password is never written.
 */
export function migrateUpCommand(
  given: Readonly<{ app: string; config?: string; target?: string; commands?: string; jobs?: string; policy?: string }>,
): string {
  const word = (text: string) => (/^[\w@%+=:,./~-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`);
  /* What the project profile gave, the same command finds again in mistri.json: it is not repeated. */
  const context = projectContext();
  const parts = ['mistri migrate up', ...(context?.app?.from === 'profile' ? [] : ['--app', word(given.app)])];
  for (const [flag, value, profiled] of [
    ['--commands', given.commands, context?.entries.commands?.from === 'profile'],
    ['--jobs', given.jobs, context?.entries.jobs?.from === 'profile'],
    ['--policy', given.policy, context?.entries.policy?.from === 'profile'],
    ['--config', given.config, context?.config?.from === 'app'],
  ] as const)
    if (value && !profiled) parts.push(flag, word(value));
  if (given.target) parts.push(word(withoutPassword(given.target)));
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
    ...(Object.values(loaded.app.resources ?? {}).some((resource) => resource.audit?.reads) ? ['read-audit'] : []),
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
  if (sub === 'up' && input.loaded && code !== EXIT.couldNot) {
    code = Math.max(code, await provisionAppStores(input.registry, input.loaded, input.jobs, input.policy, write));
    code = Math.max(code, await provisionSignInStore(input.loaded, write));
  }
  if (sub === 'status')
    write(
      `${STORES.filter((store) => Object.keys(store.current).length > 0).length} stores known; \`mistri migrate stores up\` applies what is pending.`,
    );
  return code;
}

/** What each store this App uses is called in a plan: the words a person reads, not the store list's id. */
const STORE_WORDS: Readonly<Record<string, string>> = {
  'command-journal': 'command journal',
  'command-events': 'event store',
  'event-delivery': 'event delivery',
  jobs: 'job store',
  workflows: 'workflow store',
  integrations: 'integrations store',
  inbox: 'notification store',
  'record-history': 'record history',
  'read-audit': 'read audit',
  assistant: 'assistant store',
  'live-change': 'live sync',
  'tenant-sandboxes': 'sandbox store',
  'validation-record': 'validation record',
};
export const storeWords = (id: string): string => STORE_WORDS[id] ?? id;
/** A store a plan names, with what is wrong with it: behind its layout, refused, or holding a destination that changed. */
export const plannedStoreWords = (store: Pick<PlannedStore, 'id' | 'state' | 'refused' | 'changed'>): string =>
  `${storeWords(store.id)}${
    store.state === 'behind'
      ? ' (behind its layout)'
      : store.state === 'refused'
        ? ` (refused: ${store.refused})`
        : store.state === 'changed'
          ? ` (delivery destination changed: ${store.changed!.join('; ')})`
          : ''
  }`;

type StoreTargetOf = Readonly<{ sqlite: string }> | Readonly<{ postgres: string }>;
/* Where a step provisions: the connection's address, its engine, and the store target a SQLite or PostgreSQL one has. */
type StoreWhere = { url: string; dialect: string; target?: StoreTargetOf };
/** One thing `up` makes for the App on one connection: the stores it leaves there (by id), and how. */
interface AppStoreStep {
  readonly connection: string;
  /** The stores this step makes, by their id in the store list: what a plan reads to say whether it is pending. */
  readonly ids: readonly string[];
  /** The delivery destinations this step derives, which a plan reads against the ones the store holds. */
  readonly deliveries?: readonly EventDeliveryPolicy[];
  run(where: StoreWhere): Promise<string | undefined>;
}

/** A store kept only in SQLite or PostgreSQL. */
class Unkept extends Error {}

/**
 * The stores the App uses, each on the connection it belongs on: the notification store beside the resources that
 * notify, the record history beside the resources a page shows the history of, the assistant's conversations where
 * the App declares an assistant, the command journal on each connection its commands run on, and, when a command
 * records events, posts effects or `--jobs` names a module, the App's event store, their delivery destinations, the
 * job, workflow and integrations stores beside them. A tenant App's stores are bound to its policy: without one,
 * there are none to name (`skipped` says so). `up` runs the steps (provisionAppStores); a plan reads which of their
 * stores the database lacks (appStoresPlan), so both follow the one list.
 */
async function appStoreSteps(
  loaded: LoadedApp,
  jobsFile: string | undefined,
  policyFile: string | undefined,
): Promise<{ steps: AppStoreStep[]; skipped?: string; refused?: string }> {
  const { app } = loaded;
  /* Without its policy a tenant App's stores have no binding to be made under: said, and the upgrade above stands. */
  if (isTenantApp(app) && policyFile === undefined)
    return { steps: [], skipped: "a tenant App's stores are bound to its policy: add --policy <file> to provision them." };
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
  const [maintenance, { historyRules }, { migrateSqliteCommandJournal }, { migratePostgresCommandJournal }] = await Promise.all([
    import('../maintenance.js'),
    import('../recordHistory.js'),
    import('../../adapters/commands/commandJournal.js'),
    import('../../adapters/commands/postgresCommandJournal.js'),
  ]);
  if (jobsFile !== undefined && !registryOf)
    return { steps: [], refused: "jobs: a jobs module runs the App's commands, and this App has none" };
  const jobLoader = jobsFile !== undefined ? await import('../jobs/jobLoader.js') : undefined;
  /* A tenant App's module is wrapped with its machine timers by the provisioning itself, as its start wraps it. */
  const jobs =
    jobLoader &&
    (isTenantApp(app) ? await jobLoader.loadJobModule(jobsFile!) : await jobLoader.servedJobModule(jobsFile!, app, registryOf!));
  const kept = (where: StoreWhere, what: string): StoreTargetOf => {
    if (!where.target) throw new Unkept(`${what} is kept in SQLite or PostgreSQL`);
    return where.target;
  };
  const steps: AppStoreStep[] = [];
  const add = (
    connection: string | undefined,
    ids: readonly string[],
    run: AppStoreStep['run'],
    deliveries?: readonly EventDeliveryPolicy[],
  ) => {
    if (connection !== undefined) steps.push({ connection, ids, run, ...(deliveries ? { deliveries } : {}) });
  };
  const said = (what: string, outcome: { provisioned: boolean }) => `${what} ${outcome.provisioned ? 'provisioned' : 'present'}`;
  /* The store list's own provisioning (maintenance.ts provisionStores), on the database each store belongs in. */
  const provision = (where: StoreWhere, options: ProvisionStoresOptions) => maintenance.provisionStores(where.target!, options);
  /* A store the list keeps where a store target is (SQLite, PostgreSQL). */
  const unbound = (id: string, what: string) => async (where: StoreWhere) => {
    kept(where, what);
    const made = (await provision(where, { only: [id] })).stores[id];
    return said(`${what} v${made.version}`, made);
  };
  const journal = async (where: StoreWhere) => {
    const target = kept(where, 'the command journal');
    const made = 'sqlite' in target ? migrateSqliteCommandJournal(target.sqlite) : await migratePostgresCommandJournal(target.postgres);
    return `command journal v${made.version} ${made.migrated ? 'provisioned' : 'present'}`;
  };
  /* The module's own stores: a job store where it runs jobs, the deliveries its jobs listen on, a workflow store and
     an integrations store where it declares them (maintenance.ts boundStores). */
  const jobStores = jobs
    ? [
        ...(runsJobs(jobs) ? ['jobs'] : []),
        ...([...jobs.jobs.values()].some((job) => job.from) ? ['event-delivery'] : []),
        ...(jobs.workflows.size ? ['workflows'] : []),
        ...(jobs.integrations || (!runsJobs(jobs) && jobs.inbound.size) ? ['integrations'] : []),
      ]
    : [];
  if (isTenantApp(app)) {
    const { loadAppTenantPolicy } = await import('../policy/appTenantPolicy.js');
    let policy: Awaited<ReturnType<typeof loadAppTenantPolicy>>;
    try {
      policy = await loadAppTenantPolicy(policyFile!);
    } catch (error) {
      return { steps: [], refused: `the tenant policy did not load: ${(error as Error).message}` };
    }
    const source = homeSourceOf(app)!,
      home = app.sources![source].connection;
    /* What the start attests (tenantFeature*.ts), bound as enrollment binds it (tenantEnrollment.ts). */
    const binding = { appId: app.id, source: { id: source, connection: home }, storeId: policy.storeId };
    const tenantStores = tenantPolicyStores(policy);
    add(home, tenantStores, async (where) => {
      kept(where, "a tenant App's stores");
      const made = await provision(where, { app: { id: app.id, tenant: binding }, only: tenantStores });
      return tenantStores.map((id) => said(`${id} v${made.stores[id].version}`, made.stores[id])).join(', ');
    });
    if (registryOf) add(home, ['command-journal'], journal);
    if (Object.values(app.resources ?? {}).some((resource) => resource.clone !== undefined))
      add(home, ['tenant-sandboxes'], unbound('tenant-sandboxes', 'sandbox store'));
    if (historyRules(app, loaded.pages).size) add(home, ['record-history'], unbound('record-history', 'record history'));
    /* Every tenant's read audit, beside the tenant source, each row carrying its tenant (readAudit.ts). */
    if (Object.values(app.resources ?? {}).some((resource) => resource.audit?.reads))
      add(home, ['read-audit'], unbound('read-audit', 'read audit'));
    /* The tenants' saved branding, beside the tenant source: its start attests the store and refuses without it (tenantBrandingStore.ts). */
    if (app.branding) add(home, ['branding'], unbound('branding', 'branding store'));
    /* The assistant's conversations, beside the tenant source (tenantAssistant.ts), where its start looks for them. */
    if (app.assistant) add(home, ['assistant'], unbound('assistant', 'assistant store'));
    /* Live sync's change store, where every tenant's writes are told to the pages that show them. */
    add(home, ['live-change'], unbound('live-change', 'live sync store'));
    /* What a production build's start last validated (tenantValidationRecord.ts): PostgreSQL's only, and never
       required — a database without it is checked in full at every start, so a SQLite one is passed over unsaid,
       and a plan never waits on it. */
    add(home, [], async (where) =>
      where.dialect === 'postgres' ? await unbound('validation-record', 'validation record')(where) : undefined,
    );
    /* The event store, the effects' destinations and the jobs' stores, each bound to every tenant of the App. */
    if (registryOf && (jobs || commands.some((command) => getCommandEvents(command) || getCommandEffects(command))))
      add(home, ['command-events', ...jobStores], async (where) => {
        kept(where, "the commands' event store");
        const made = await provision(where, {
          app: { id: app.id, tenant: binding, commands: registryOf, definition: app, pages: loaded.pages },
          ...(jobs ? { jobs: jobs as unknown as JobModule } : {}),
        });
        const stores = Object.entries(made.stores).map(([id, store]) => said(id, store));
        return [...stores, `${made.destinations.length} delivery destination(s)`].join(', ');
      });
    return { steps };
  }
  const notifying = Object.entries(app.resources ?? {}).filter(([, resource]) => resource.notify?.length);
  for (const connection of new Set(notifying.map(([id]) => connectionOf(sourceOfResource(id)))))
    add(connection, ['inbox'], unbound('inbox', 'notification store'));
  /* A rule that emails an address the record holds queues its mail in the integrations store, in the write's transaction. */
  const emailing = notifying.filter(([, resource]) => resource.notify!.some((rule) => rule.send?.channel === 'email'));
  for (const connection of new Set(emailing.map(([id]) => connectionOf(sourceOfResource(id)))))
    add(connection, ['integrations'], unbound('integrations', 'integrations store'));
  for (const connection of new Set([...historyRules(app, loaded.pages).keys()].map((id) => connectionOf(sourceOfResource(id)))))
    add(connection, ['record-history'], unbound('record-history', 'record history'));
  /* The read audit, beside each audited resource's rows: a read is logged on the database it read. */
  const audited = Object.entries(app.resources ?? {}).filter(([, resource]) => resource.audit?.reads);
  for (const connection of new Set(audited.map(([id]) => connectionOf(sourceOfResource(id)))))
    add(connection, ['read-audit'], unbound('read-audit', 'read audit'));
  /* Branding's store, on the connection the App's entry point names, as the assistant's is. */
  if (app.branding) add(connectionOf(undefined), ['branding'], unbound('branding', 'branding store'));
  /* The assistant's conversations, on the connection the App's entry point names (assistantStores.ts), where serving looks. */
  if (app.assistant) add(connectionOf(undefined), ['assistant'], unbound('assistant', 'assistant store'));
  /* Live sync's change store, on every database a resource is read from: a page showing any of them is told of its writes. */
  for (const connection of new Set(Object.keys(app.resources ?? {}).map((id) => connectionOf(sourceOfResource(id)))))
    add(connection, ['live-change'], unbound('live-change', 'live sync store'));
  for (const connection of new Set(commands.map((command) => connectionOf(command.source)))) add(connection, ['command-journal'], journal);
  const emitting = commands.find((command) => getCommandEvents(command));
  if (emitting)
    add(connectionOf(emitting.source), ['command-events'], async (where) => {
      kept(where, 'the event store');
      const events = (await provision(where, { app: { id: app.id, source: emitting.source } })).stores['command-events'];
      return said(`event store for App "${app.id}" v${events.version}`, events);
    });
  const posting = commands.find((command) => getCommandEffects(command));
  if (posting && registryOf)
    add(connectionOf(posting.source), ['command-events', 'event-delivery'], async (where) => {
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
    const deployment =
      jobs.jobs.size || jobs.workflows.size ? jobLoader!.jobDeployment(jobs, { appId: app.id, commands: registryOf }) : undefined;
    const sourceId = deployment ? deployment.sourceId : anchor?.source;
    const deliveries = deployment ? [...deployment.destinations, ...deployment.workflowDestinations].map(({ policy }) => policy) : [];
    add(
      connectionOf(sourceId),
      jobStores,
      async (where) => {
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
      },
      deliveries,
    );
  }
  return { steps };
}

/**
 * With `--app`, `up` also creates every store the App uses and the database lacks (appStoreSteps), on the connection
 * each belongs on. The App is the binding a bare database does not carry, so this is the one place all of them can be
 * made by one command. Each is idempotent: present, it is left as it is. Without a tenant App's policy, it says so and
 * only upgrades what the database holds (runStores, above).
 */
async function provisionAppStores(
  registry: Registry,
  loaded: LoadedApp,
  jobsFile: string | undefined,
  policyFile: string | undefined,
  write: (line: string) => void,
): Promise<number> {
  const { steps, skipped, refused } = await appStoreSteps(loaded, jobsFile, policyFile);
  if (skipped) {
    write(`  ${skipped}`);
    return EXIT.ok;
  }
  if (refused) {
    write(`  ${refused}`);
    return EXIT.couldNot;
  }
  const { storeTargetOf } = await import('../commands/appCommandEvents.js');
  let code: number = EXIT.ok;
  /* Each connection's steps, in the order a start attests them: a step that cannot be kept on its engine is said and the rest go on. */
  for (const name of new Set(steps.map((step) => step.connection))) {
    const config = registry.configs().find((each) => each.id === name || each.name === name);
    if (!config) {
      write(`  stores: connection "${name}" is not in the config`);
      code = EXIT.couldNot;
      continue;
    }
    /* An HTTP source keeps no change store: live sync watches only the databases it writes (liveStore.ts liveStoreOf). */
    const owed = steps.filter((each) => each.connection === name && !(config.http && each.ids.every((id) => id === 'live-change')));
    if (!owed.length) continue;
    try {
      const { url } = await resolveConnection(config.name, config.url, { secrets: true });
      const where = { url, dialect: dialectOf(url), target: storeTargetOf(url) };
      for (const step of owed) {
        try {
          const done = await step.run(where);
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
}

/** One store this App uses, on one connection, as a plan reads it. */
interface PlannedStore {
  readonly connection: string;
  readonly id: string;
  /**
   * `absent`: `up` makes it. `behind`: it is there at an older layout, and `up` brings it forward. `refused`: it is
   * there in a layout `up` will not touch (newer than this mistri, or with no upgrade from it), said in `refused`.
   */
  readonly state: 'present' | 'absent' | 'behind' | 'refused' | 'changed';
  readonly refused?: string;
  /**
   * `changed`: the store is there, and holds a delivery destination made under a different policy than this App now
   * derives (a producing command's version was bumped): each said with its producer versions, and what stands in the
   * way of `up` replacing it. `up` replaces the ones with nothing undelivered.
   */
  readonly changed?: readonly string[];
}

/** What the bootstrap plan's stores phase reads: each store the App uses and whether the database has it. */
export interface StoresPlan {
  readonly stores: readonly PlannedStore[];
  /** Why the App's own stores cannot be named (a tenant App without its policy). */
  readonly skipped?: string;
  /** What could not be read: a connection that did not open, a jobs module that did not load. */
  readonly problems: readonly string[];
}

/**
 * The stores phase of the bootstrap plan (docs/bootstrap-plan.md): which of the stores `up` would make for this App
 * each database lacks, read without making any. It follows the steps `up` runs (appStoreSteps), so the plan and the
 * run never disagree about what this App needs. The event store is attested for this App's own binding, as a start
 * attests it: another App's event store in the same database is not this one's.
 */
export async function appStoresPlan(input: { registry: Registry; loaded: LoadedApp; jobs?: string; policy?: string }): Promise<StoresPlan> {
  let found: Awaited<ReturnType<typeof appStoreSteps>>;
  try {
    found = await appStoreSteps(input.loaded, input.jobs, input.policy);
  } catch (error) {
    return { stores: [], problems: [(error as Error).message] };
  }
  if (found.skipped) return { stores: [], skipped: found.skipped, problems: [] };
  if (found.refused) return { stores: [], problems: [found.refused] };
  const stores: PlannedStore[] = [];
  const problems: string[] = [];
  const { storeTargetOf, appCommandEventStore } = await import('../commands/appCommandEvents.js');
  for (const name of new Set(found.steps.map((step) => step.connection))) {
    const config = input.registry.configs().find((each) => each.id === name || each.name === name);
    if (!config) {
      problems.push(`connection "${name}" is not in the config`);
      continue;
    }
    let db: Awaited<ReturnType<typeof openMigrationDb>>;
    let url: string;
    const ids = [...new Set(found.steps.filter((step) => step.connection === name).flatMap((step) => step.ids))];
    try {
      url = (await resolveConnection(config.name, config.url, { secrets: true })).url;
      /* A SQLite file not made yet holds none of them; `up` makes the file with its migrations. */
      if (dialectOf(url) === 'sqlite' && !existsSync(url.replace(/^sqlite:(\/\/)?/i, ''))) {
        stores.push(...ids.map((id) => ({ connection: config.name, id, state: 'absent' as const })));
        continue;
      }
      db = await openMigrationDb(url, [], false);
    } catch (error) {
      problems.push(`${config.name}: ${(error as Error).message}`);
      continue;
    }
    try {
      const statuses = new Map((await storeStatuses(db)).map((status) => [status.id, status]));
      for (const id of ids) {
        const status = statuses.get(id);
        if (status?.refused !== undefined) {
          stores.push({ connection: config.name, id, state: 'refused', refused: status.refused });
          continue;
        }
        let state: PlannedStore['state'] =
          status === undefined || status.found === null ? 'absent' : status.pending.length ? 'behind' : 'present';
        /* The event store is one per App: present for another App is absent for this one. */
        if (id === 'command-events' && state === 'present' && !isTenantApp(input.loaded.app)) {
          const emitting = Object.values(input.loaded.commands?.registry ?? {}).find((command) => getCommandEvents(command));
          const target = storeTargetOf(url);
          if (emitting && target && !(await eventStoreAttests(target, appCommandEventStore(input.loaded.app.id, emitting.source))))
            state = 'absent';
        }
        stores.push({ connection: config.name, id, state });
      }
      /* A destination made for another producer version: a start refuses it, and `up` replaces it. */
      const deliveries = found.steps.filter((step) => step.connection === name).flatMap((step) => step.deliveries ?? []);
      const target = storeTargetOf(url);
      if (deliveries.length && target && statuses.get('event-delivery')?.found != null) {
        const changed = (await changedDestinations(target, deliveries)).map((each) => each.summary);
        if (changed.length) {
          const held = stores.findIndex((store) => store.connection === config.name && store.id === 'event-delivery');
          const entry: PlannedStore = { connection: config.name, id: 'event-delivery', state: 'changed', changed };
          if (held >= 0) stores[held] = entry;
          else stores.push(entry);
        }
      }
    } catch (error) {
      problems.push(`${config.name}: ${(error as Error).message}`);
    } finally {
      await db.close().catch(() => {});
    }
  }
  return { stores, problems };
}

/** The delivery destinations among `policies` the store holds under a different policy, read and changed by nothing. */
async function changedDestinations(target: StoreTargetOf, policies: readonly EventDeliveryPolicy[]) {
  if ('sqlite' in target) {
    const { changedSqliteDestinations } = await import('../../adapters/events/eventDeliverySchema.js');
    return changedSqliteDestinations(target.sqlite, policies);
  }
  const [{ PgConnectionManager }, { changedPostgresDestinations }] = await Promise.all([
    import('@mistriwork/engine/adapters/postgresPool.js'),
    import('../../adapters/events/postgresEventDeliveryStore.js'),
  ]);
  const connection = new PgConnectionManager(target.postgres);
  try {
    return await connection.withReadClient((client) => changedPostgresDestinations(client, policies));
  } finally {
    await connection.close().catch(() => {});
  }
}

/** Whether the database holds this App's own event store, read as a start attests it; never throws. */
async function eventStoreAttests(target: StoreTargetOf, binding: { appId: string; storeId: string; sourceId: string }): Promise<boolean> {
  try {
    if ('sqlite' in target) {
      const [{ DatabaseSync }, { assertSqliteCommandEventStore }] = await Promise.all([
        import('node:sqlite'),
        import('../../adapters/events/commandEventSchema.js'),
      ]);
      const db = new DatabaseSync(target.sqlite, { readOnly: true });
      try {
        assertSqliteCommandEventStore(db, binding);
      } finally {
        db.close();
      }
      return true;
    }
    const [{ PgConnectionManager }, { assertPostgresCommandEventStore }] = await Promise.all([
      import('@mistriwork/engine/adapters/postgresPool.js'),
      import('../../adapters/events/postgresCommandEventStore.js'),
    ]);
    const connection = new PgConnectionManager(target.postgres);
    try {
      await connection.withReadClient((client) => assertPostgresCommandEventStore(client, binding));
    } finally {
      await connection.close().catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

/** The App's PostgreSQL `auth.store` URL, when it signs people in and names one; a SQLite store is made by a start. */
async function postgresSignInStore(loaded: LoadedApp): Promise<string | undefined> {
  if (!loaded.app.auth) return undefined;
  const [{ localAuthStore }, { isPostgresAuthStore }] = await Promise.all([import('../auth/auth.js'), import('../auth/authStore.js')]);
  const { store } = localAuthStore(loaded);
  return isPostgresAuthStore(store) ? store : undefined;
}

/** Whether the App's PostgreSQL `auth.store` holds the sign-in tables; undefined when it keeps none there. Throws when it cannot be read. */
export async function signInStorePresent(loaded: LoadedApp): Promise<boolean | undefined> {
  const store = await postgresSignInStore(loaded);
  if (store === undefined) return undefined;
  const db = await openMigrationDb(store, [], false);
  try {
    return (await storeStatuses(db)).some((status) => status.id === 'auth' && status.found !== null);
  } finally {
    await db.close().catch(() => {});
  }
}

/**
 * The App's PostgreSQL `auth.store`, made where it is absent (decision D4 of docs/bootstrap-plan.md): the one
 * bootstrap step that was a `node -e` call to migratePostgresAuthStore. In its own transaction; its URL is never said.
 */
export async function provisionSignInStore(loaded: LoadedApp, write: (line: string) => void): Promise<number> {
  try {
    if ((await signInStorePresent(loaded)) !== false) return EXIT.ok;
    const { migratePostgresAuthStore } = await import('../../adapters/auth/postgresAuthStore.js');
    await migratePostgresAuthStore((await postgresSignInStore(loaded))!);
    write('  auth.store: sign-in store provisioned');
    return EXIT.ok;
  } catch (error) {
    write(`  auth.store: the sign-in store could not be provisioned, and its transaction rolled back: ${(error as Error).message}`);
    return EXIT.failed;
  }
}
