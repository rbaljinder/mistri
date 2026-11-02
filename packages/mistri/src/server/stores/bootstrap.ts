/**
 * The bootstrap plan's App phases (docs/bootstrap-plan.md): what `mistri migrate status --app` reports after the
 * migrations, and `mistri migrate up --app` carries out. In order: the stores this App uses, its sign-in store, a
 * word on seed data, and the check. A field report took ten steps and three dead ends to bring up one App with
 * events and jobs, because `up` stopped at the migrations and a missing store was said as a schema the App no
 * longer fits. One sequence now, read and run by the same code `migrate stores up` runs (storesCli.ts).
 */
import { projectContext } from '@mistriwork/engine/server/config/profile.js';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import type { Options } from '@mistriwork/engine/server/cli/args.js';
import type { StartupConfig } from '@mistriwork/engine/server/cli/config.js';
import type { BootstrapInput, PlanPhase } from '@mistriwork/engine/server/migrate/cli.js';
import { openMigrationDb } from '@mistriwork/engine/server/migrate/database.js';
import type { LoadedApp } from '../app/apps.js';
import { homeSourceOf, isTenantApp } from '../../shared/appModel.js';
import { appStoresPlan, migrateUpCommand, runStores, storeWords, type StoresPlan } from './storesCli.js';

const shown = (path: string) => {
  const near = relative(process.cwd(), path);
  return !near ? '.' : near.startsWith('..') ? path : near;
};

/** What the plan reads of a migrate run, beyond the engine's input. */
export interface BootstrapApp {
  readonly loaded: LoadedApp;
  readonly appDir: string;
  readonly config: StartupConfig;
  /** The jobs module the run was given (`--jobs`), or a build's own. */
  readonly jobs?: string;
  /** The App judged against the schema, as `mistri check` judges it: its exit code. */
  check(rest: readonly string[], write: (line: string) => void): Promise<number>;
}

/** Whether checking the App needs its policy module (`--policy`): row policies, or tenant rows. */
const needsPolicy = (loaded: LoadedApp) => loaded.app.auth?.rows === 'policy' || loaded.app.auth?.rows === 'tenant';

/** The stores still to make, in words, with the connection where the App uses more than one. */
function missingWords(plan: StoresPlan): string[] {
  const missing = plan.stores.filter((store) => store.state !== 'present');
  const many = new Set(plan.stores.map((store) => store.connection)).size > 1;
  return missing.map(
    (store) =>
      `${storeWords(store.id)}${store.state === 'behind' ? ' (behind its layout)' : store.state === 'refused' ? ` (refused: ${store.refused})` : ''}${many ? ` on ${store.connection}` : ''}`,
  );
}

export async function bootstrapPhases(
  app: BootstrapApp,
  input: BootstrapInput,
): Promise<{ title: string; next: string; phases: PlanPhase[] }> {
  const { loaded, appDir } = app;
  const { opts, registry, write } = input;
  const next = migrateUpCommand({
    app: shown(appDir),
    ...upFlags(opts, app.jobs),
  });
  const migrationsWait = input.migrations.status === 'pending' || input.migrations.status === 'failed';
  const plan = () =>
    appStoresPlan({
      registry,
      loaded,
      ...(app.jobs !== undefined ? { jobs: app.jobs } : {}),
      ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
    });

  /* Whether a PostgreSQL auth.store was there before the stores step, which makes it: `applied` or `done` after. */
  const authBefore = await (await import('./storesCli.js')).signInStorePresent(loaded).catch(() => undefined);

  /* 2: the stores this App uses. */
  let stores: PlanPhase;
  const before = await plan();
  const missing = missingWords(before);
  if (before.skipped) stores = { phase: 'stores', status: 'skipped', detail: before.skipped, items: [] };
  else if (before.problems.length && !before.stores.length)
    stores = { phase: 'stores', status: 'failed', detail: 'could not be read', items: [], error: before.problems.join(' ') };
  else if (!before.stores.length) stores = { phase: 'stores', status: '—', detail: 'this App uses none', items: [] };
  else if (!missing.length)
    stores = {
      phase: 'stores',
      status: 'done',
      detail: [...new Set(before.stores.map((store) => storeWords(store.id)))].join(', '),
      items: [],
    };
  else if (input.mode === 'plan' || input.migrations.status === 'failed')
    stores =
      input.migrations.status === 'failed'
        ? { phase: 'stores', status: 'waiting', detail: `runs after 1: ${missing.join(', ')}`, items: missing }
        : { phase: 'stores', status: 'pending', detail: missing.join(', '), items: missing };
  else {
    const lines: string[] = [];
    const code = await runStores(
      'up',
      {
        registry,
        config: app.config,
        appDir,
        loaded,
        schemas: input.target.schemas,
        ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
        ...(app.jobs !== undefined ? { jobs: app.jobs } : {}),
      },
      (line) => {
        lines.push(line);
        write(line);
      },
    );
    const after = await plan();
    const still = missingWords(after);
    const made = missing.filter((word) => !still.includes(word));
    stores =
      code === 0 && !still.length
        ? { phase: 'stores', status: 'applied', detail: made.join(', '), items: made }
        : {
            phase: 'stores',
            status: 'failed',
            detail: `${still.length ? `not made: ${still.join(', ')}` : 'a step was refused'}${made.length ? `; made: ${made.join(', ')}` : ''}`,
            items: made,
            /* The step's own last word on it: the store, the database's message, and that it was rolled back. */
            error:
              lines
                .filter((line) => /failed|refused|could not|cannot/.test(line))
                .map((line) => line.trim())
                .at(-1) ?? 'see the stores step above',
          };
  }

  /* 3: the sign-in store. SQLite's is made by the first start, in the place a command run on this machine reads
     (auth.ts localAuthStore); a PostgreSQL auth.store is made here, which was a `node -e` call (decision D4). */
  const signIn = await signInPhase(loaded, input.mode, migrationsWait || stores.status === 'failed', authBefore);

  /* 4: seed data, reported and never run (decision D3). */
  const seed = await seedPhase(loaded, appDir, input.target);

  /* 5: the check, with the run's own flags. */
  const earlier = [input.migrations, stores, signIn]
    .map((phase, i) => ({ phase, n: i === 0 ? 1 : i === 1 ? 2 : 3 }))
    .filter(({ phase }) => phase.status === 'pending' || phase.status === 'failed' || phase.status === 'waiting');
  let check: PlanPhase;
  if (earlier.length)
    check = {
      phase: 'check',
      status: 'waiting',
      detail: `runs after ${earlier.map(({ n }) => n).join(' and ')}`,
      items: [],
    };
  else if (input.mode === 'plan')
    check = { phase: 'check', status: '—', detail: `up runs it; mistri check --app ${shown(appDir)} on its own`, items: [] };
  else if (needsPolicy(loaded) && opts.policy === undefined)
    /* An App whose rows a policy decides is checked only beside that policy (a field report): named, not failed. */
    check = {
      phase: 'check',
      status: 'skipped',
      detail: `${isTenantApp(loaded.app) ? 'a tenant App' : 'an App with row policies'} is checked beside its policy, and none was given: give up the same --policy, or mistri check --app ${shown(appDir)} --policy <file>`,
      items: [],
    };
  else {
    write('');
    const code = await app.check(input.rest, write);
    if (code === 0) check = { phase: 'check', status: 'passed', detail: 'the App fits the schema and the stores this run left', items: [] };
    else if (code === 8) {
      /* The check found a store still absent: a store this run could not make, never a schema the App misfits. */
      const left = missingWords(await plan());
      check = {
        phase: 'check',
        status: 'failed',
        detail: `the App waits on stores this run did not make: ${left.join(', ') || 'see the check above'}`,
        items: left,
      };
      write(
        `The migrations are applied, and the App waits on stores this database does not have: ${left.join(', ') || 'see the check above'}. ${next} makes them.`,
      );
    } else {
      check = {
        phase: 'check',
        status: 'failed',
        detail: 'the App no longer fits: see the check above',
        items: [],
      };
      write(
        `The migrations are applied, and the App no longer fits the schema they made: fix what the check names above, or write a migration that puts back what the App needs. Next time, mistri check --app ${shown(appDir)} --pending judges them first.`,
      );
    }
  }
  /* A check that waited on a store this run could not make is a store step that failed: exit 5, not 4. */
  if (check.status === 'failed' && check.items.length && stores.status !== 'failed')
    stores = { ...stores, status: 'failed', error: `not made: ${check.items.join(', ')}` };
  return { title: loaded.app.id, next, phases: [stores, signIn, seed, check] };
}

/** The flags `migrate up --app` would be given to reach the same databases with the same modules. */
function upFlags(opts: Options, jobs: string | undefined) {
  return {
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(opts.target && !opts.targetFromEnvironment ? { target: opts.target } : {}),
    ...(opts.commands !== undefined ? { commands: opts.commands } : {}),
    ...(jobs !== undefined ? { jobs } : {}),
    ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
  };
}

async function signInPhase(loaded: LoadedApp, mode: 'plan' | 'up', wait: boolean, before: boolean | undefined): Promise<PlanPhase> {
  if (!loaded.app.auth) return { phase: 'sign-in store', status: '—', detail: 'the App has no sign-in', items: [] };
  const [{ localAuthStore }, { isPostgresAuthStore }] = await Promise.all([import('../auth/auth.js'), import('../auth/authStore.js')]);
  const { store, kept } = localAuthStore(loaded);
  if (!isPostgresAuthStore(store)) {
    const where = `${shown(store)}${kept === 'dev' ? ', under mistri dev' : kept === 'named' ? ', auth.store' : ''}`;
    return existsSync(store)
      ? { phase: 'sign-in store', status: 'done', detail: `SQLite, ${where}`, items: [] }
      : { phase: 'sign-in store', status: 'at start', detail: `a SQLite file the first start makes (${where})`, items: [] };
  }
  /* A PostgreSQL auth.store: its URL is a secret and never said. The stores step makes it (provisionSignInStore),
     so `migrate stores up` and a deploy's migrate step make it too; read again here, after that step. */
  const { signInStorePresent, provisionSignInStore } = await import('./storesCli.js');
  let present: boolean | undefined;
  try {
    present = await signInStorePresent(loaded);
  } catch (error) {
    return {
      phase: 'sign-in store',
      status: 'failed',
      detail: 'auth.store on PostgreSQL could not be read',
      items: [],
      error: (error as Error).message,
    };
  }
  if (present)
    return before === false && mode === 'up'
      ? { phase: 'sign-in store', status: 'applied', detail: 'auth.store on PostgreSQL: its tables are made', items: ['auth'] }
      : { phase: 'sign-in store', status: 'done', detail: 'auth.store on PostgreSQL', items: [] };
  if (mode === 'plan')
    return { phase: 'sign-in store', status: 'pending', detail: 'auth.store on PostgreSQL: up makes its tables', items: ['auth'] };
  if (wait) return { phase: 'sign-in store', status: 'waiting', detail: 'runs after 1 and 2', items: [] };
  const lines: string[] = [];
  const code = await provisionSignInStore(loaded, (line) => lines.push(line.trim()));
  return code === 0
    ? { phase: 'sign-in store', status: 'applied', detail: 'auth.store on PostgreSQL: its tables are made', items: ['auth'] }
    : {
        phase: 'sign-in store',
        status: 'failed',
        detail: 'auth.store on PostgreSQL was not made, and its transaction rolled back',
        items: [],
        error: lines.join(' '),
      };
}

/** The App's own tables on the database the migrations ran on, and which are empty: `mistri seed` fills them. */
async function seedPhase(loaded: LoadedApp, appDir: string, target: BootstrapInput['target']): Promise<PlanPhase> {
  const home = homeSourceOf(loaded.app);
  const tables = Object.entries(loaded.app.resources ?? {})
    .filter(([, resource]) => resource.source === undefined || resource.source === home)
    .map(([name, resource]) => ({
      name: name.slice(name.indexOf('.') + 1),
      table: resource.physical ?? name.slice(name.indexOf('.') + 1),
    }));
  if (!tables.length) return { phase: 'seed', status: '—', detail: 'the App declares no tables of its own', items: [] };
  const empty: string[] = [];
  try {
    const db = await openMigrationDb(target.url, target.schemas, false);
    try {
      for (const { name, table } of tables) {
        const quoted = table
          .split('.')
          .map((part) => `"${part.replaceAll('"', '""')}"`)
          .join('.');
        try {
          if (!(await db.all(`SELECT 1 FROM ${quoted} LIMIT 1`)).length) empty.push(name);
        } catch {
          /* Not made yet: the migrations make it, and it is empty then. */
          empty.push(name);
        }
      }
    } finally {
      await db.close().catch(() => {});
    }
  } catch {
    empty.push(...tables.map(({ name }) => name));
  }
  /* Where the profile named the App, seed finds it there too. */
  const seed = projectContext()?.app?.from === 'profile' ? 'mistri seed' : `mistri seed --app ${shown(appDir)}`;
  if (!empty.length) return { phase: 'seed', status: '—', detail: "the App's tables hold rows", items: [] };
  const said = empty.length > 4 ? `${empty.slice(0, 4).join(', ')} and ${empty.length - 4} more` : empty.join(', ');
  return {
    phase: 'seed',
    status: '—',
    detail: `${said} ${empty.length === 1 ? 'is' : 'are'} empty: ${seed}`,
    items: empty,
  };
}
