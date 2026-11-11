/**
 * The steps of `mistri check` that need nothing of runSteps' own state: the step's shape and the finding it makes,
 * the indexes and queries steps (which ask the database), the route table `--routes` prints, and the facts a served
 * App builds its hosts from. They live apart because runSteps is one long sequence and these are each a function of
 * the App and its registry; check.ts imports them back.
 */
import { relative, resolve } from 'node:path';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { appRoutes, type LoadedApp } from '../app/apps.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { appForRoles, pagesForRoles } from '../../shared/appViewRoles.js';
import { routeTable } from '../../shared/appAddress.js';
import { appHome, type AddressMount } from '@mistriwork/engine/shared/mount.js';
import { isTenantApp } from '../../shared/appModel.js';
import { appRealms } from '../../shared/appTenancy.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import { homeSourceOf, withRollups, type AppDef } from '../../shared/app.js';
import { promiseOf } from './themeContract.js';
import { appConnection, pageQueryFailures } from './checkQueries.js';
import { SMALL_TABLE_ROWS, holdBack, indexFindings, readPgIndexes } from './checkIndexes.js';
import type { ServedFacts } from './servedHosts.js';
import { docsFor, type CheckProblem, type CheckSeverity, type CheckStep } from './checkProblems.js';

/* `pending` is the stores step's alone: what `mistri migrate up --app` makes, which no change to the App fixes. */
export type Status = 'passed' | 'failed' | 'skipped' | 'pending';
/** A step's verdict, its lines as the text output says them, and its findings as `--json` gives them (checkProblems.ts). */
export interface Step {
  name: CheckStep;
  status: Status;
  detail: string;
  lines: string[];
  problems?: CheckProblem[];
}
export const problem = (
  step: CheckStep,
  code: string,
  message: string,
  more: Partial<CheckProblem> = {},
  severity: CheckSeverity = 'error',
): CheckProblem => {
  /* Every finding of a contract code says its promise, so an agent reads which promise broke beside the measurement. */
  const promise = promiseOf(code);
  return { code, severity, step, ...more, message, ...(promise ? { promise } : {}), docs: docsFor(code, step) };
};

export const shown = (path: string) => {
  const near = relative(process.cwd(), path);
  return !near ? '.' : near.startsWith('..') ? path : near;
};

/**
 * The indexes step: the App's declared access paths against the database's index list, on PostgreSQL. It never
 * fails the check. Where it cannot run (SQLite, a role that may not read the catalog) it says one note instead.
 */
export async function indexStep(
  registry: Registry,
  loaded: LoadedApp,
  policyFile: string | undefined,
  all = false,
): Promise<{ step?: Step; note?: string }> {
  const app = loaded.app;
  const bound = app.connection ?? (app.sources ? app.sources[homeSourceOf(app)!]?.connection : undefined);
  const connection = bound
    ? registry.list().find((c) => c.id === bound || c.name === bound)
    : registry.list().find((c) => c.id === registry.active);
  if (!connection) return {};
  try {
    const { adapter } = await registry.open(connection.id);
    if (adapter.dialect !== 'postgres')
      return { note: 'skipped, PostgreSQL only: SQLite reads a table from a file, with no round trip to save.' };
    const indexes = await readPgIndexes(adapter);
    if (!indexes) return { note: 'skipped, the database would not list its indexes to this role.' };
    const { schema } = await loadAppRuntimeResources(registry, app, connection.id);
    /* A tenant App's ownership columns live in its policy module, which a request reads: with --policy, they are judged too. */
    let owners: Record<string, string> | undefined;
    if (app.auth?.rows === 'tenant' && policyFile) {
      const { loadAppTenantPolicy } = await import('../policy/appTenantPolicy.js');
      const policy = await loadAppTenantPolicy(resolve(policyFile)).catch(() => undefined);
      owners = Object.fromEntries(
        Object.entries(policy?.ownership ?? {}).flatMap(([id, owner]) => (owner.kind === 'tenant' ? [[id, owner.column]] : [])),
      );
    }
    const every = indexFindings({ app, pages: loaded.pages, schema: withRollups(app, schema), indexes, ...(owners ? { owners } : {}) });
    /* A table too small for an index to matter is not worth a line each: a small local database gave seventy. They are
       counted in one line, and listed with --warnings. */
    const { shown: found, held } = holdBack(every, all);
    const warnings = found.filter((finding) => finding.severity === 'warning').length;
    return {
      step: {
        name: 'indexes',
        status: 'passed',
        detail:
          (found.length
            ? `${found.length} read${found.length === 1 ? '' : 's'} no index leads (${warnings} on tables of ${SMALL_TABLE_ROWS.toLocaleString('en-US')} rows or more)`
            : 'every foreign key, sort, filter and search the App reads by is led by an index') +
          (held.length ? `; ${held.length} held back on smaller tables` : ''),
        lines: [
          ...found.map(
            (finding) => `${finding.severity === 'warning' ? 'warning: ' : 'note: '}${finding.message} Add: ${finding.fix} [index-missing]`,
          ),
          ...(held.length
            ? [
                `note: ${held.length} index suggestion${held.length === 1 ? '' : 's'} held back on tables under ${SMALL_TABLE_ROWS.toLocaleString('en-US')} rows, where an index rarely matters; mistri check --warnings lists ${held.length === 1 ? 'it' : 'them all'}.`,
              ]
            : []),
        ],
        problems: found.map((finding) =>
          problem(
            'indexes',
            'index-missing',
            finding.message,
            { path: finding.declaration, fix: finding.fix, file: shown(loaded.path) },
            finding.severity,
          ),
        ),
      },
    };
  } catch (error) {
    return { note: `skipped, could not read the indexes: ${(error as Error).message}` };
  }
}

/**
 * The queries step: every read the App's pages would make, planned by its database (checkQueries.ts). A refusal is a
 * `query-invalid` error with the page and section; where the database cannot be asked it says one note instead.
 */
export async function queryStep(registry: Registry, loaded: LoadedApp): Promise<{ step?: Step; note?: string }> {
  const app = loaded.app;
  const connection = appConnection(registry, app);
  if (!connection) return {};
  if (isTenantApp(app)) return { note: 'skipped, a tenant App reads through its tenants, which this run does not open.' };
  try {
    const { failures, statements, skipped, sections } = await pageQueryFailures(registry, app, loaded.pages, connection.id);
    return {
      step: {
        name: 'queries',
        status: failures.length ? 'failed' : 'passed',
        detail:
          (failures.length
            ? `${failures.length} read${failures.length === 1 ? '' : 's'} the database refused`
            : `the database planned the ${statements} statement${statements === 1 ? '' : 's'} of the App's lists, dashboards, segments and ${sections} page section${sections === 1 ? '' : 's'}`) +
          `; ${statements} checked, ${skipped} skipped (a parameter this run cannot supply)`,
        lines: failures.map((failure) => `${failure.at}: ${failure.message} [query-invalid]`),
        problems: failures.map((failure) =>
          problem('queries', 'query-invalid', `${failure.at}: the database refused this read: ${failure.message}`, {
            path: failure.path,
            file: shown(loaded.path),
            fix: "The message is the database's own: a column that two joined tables share, a type that cannot be compared, a function it lacks. Change the section's columns, query, sort or group, or the column it reads.",
          }),
        ),
      },
    };
  } catch (error) {
    return { note: `skipped, could not plan the pages' reads: ${(error as Error).message}` };
  }
}

/**
 * The route table `--routes` prints. A tenant App's addresses carry their
 * context after the App's own parameters (client tenantLink.ts): a tenant's
 * `tenant=`, the platform realm's `realm=platform`, each realm with the rooms
 * its own context is served.
 */
export function checkedRoutes(loaded: LoadedApp, schema: DatabaseSchema, mount: AddressMount): Array<{ path: string; what: string }> {
  const app = appHome(mount, loaded.app.id);
  if (!isTenantApp(loaded.app)) {
    const whole = routeTable(appRoutes(loaded, schema), app);
    /* A record's address is the first view showing its table among the views
       the person is served: a role served other views may say a record
       elsewhere (a resident's repair at /my-requests/12, the office's at
       /repairs/12). One line per role whose address differs. */
    const known = new Set(whole.map((row) => row.path));
    const rows = [
      ...whole,
      ...Object.keys(loaded.app.auth?.roles ?? {}).flatMap((role) =>
        routeTable(appRoutes(loaded, schema, undefined, [role]), app)
          .filter((row) => row.what.startsWith('one record of') && !known.has(row.path))
          .map((row) => ({ path: row.path, what: `${row.what}, as the role "${role}" opens it` })),
      ),
    ];
    const open = loaded.app.auth?.public?.read;
    if (!open) return rows;
    /* A signed-out visitor is served fewer views, so a record may be
       addressed under a different list for them (the first they can open):
       those addresses too, as the sitemap and a public page's canonical
       link say them (http/sitemap.ts, http/publicHead.ts). */
    const said = new Set(rows.map((row) => row.path));
    const visitor = routeTable(
      appRoutes(
        { ...loaded, app: appForRoles(loaded.app, []), pages: pagesForRoles(loaded.pages, [], loaded.app.auth) },
        { ...schema, tables: schema.tables.filter((table) => open.includes(table.id)) },
      ),
      app,
    );
    return [
      ...rows,
      ...visitor
        .filter((row) => !said.has(row.path))
        .map((row) => ({ path: row.path, what: `${row.what}, as a signed-out visitor opens it` })),
    ];
  }
  const qualified = (rows: Array<{ path: string; what: string }>, selector: string) =>
    rows.map((row) => ({ path: `${row.path}${row.path.includes('?') ? '&' : '?'}${selector}`, what: row.what }));
  const tenant = qualified(routeTable(appRoutes(loaded, schema, 'tenant'), app), 'tenant={tenant}');
  if (!appRealms(loaded.app).platform) return tenant;
  return [...tenant, ...qualified(routeTable(appRoutes(loaded, schema, 'platform'), app), 'realm=platform')];
}

/** What the App and its jobs module declare that makes a served App build more hosts (servedHosts.ts). */
export async function servedFactsOf(
  app: AppDef,
  commands: BusinessCommandRegistry | undefined,
  jobsFile: string | undefined,
): Promise<ServedFacts> {
  const { getCommandEffects } = await import('../commands/businessCommands.js');
  const facts: ServedFacts = {
    tenant: app.auth?.rows === 'tenant',
    assistant: app.assistant !== undefined,
    apiEvents: Boolean(app.api?.events?.length),
    effects: Object.values(commands ?? {}).some((command) => getCommandEffects(command)),
  };
  if (jobsFile === undefined) return facts;
  try {
    const { loadJobModule } = await import('../jobs/jobLoader.js');
    const module = await loadJobModule(jobsFile);
    return {
      ...facts,
      jobs: module.jobs.size + module.workflows.size > 0,
      decisions: (module.decisions?.size ?? 0) > 0,
      mail: module.mail !== undefined,
      integrations: module.integrations !== undefined,
      inbound: module.inbound.size > 0,
    };
  } catch {
    // A jobs module that does not load is the validation step's to say; the sum then counts without it.
    return facts;
  }
}
