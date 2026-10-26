/**
 * Apps: a named curation of the UI, read from a directory.
 *
 * An app is data, deliberately — a manifest that can be parsed, validated,
 * diffed, emitted by tooling and served to agents without executing
 * anything (docs/apps.md holds the design and its boundaries). The
 * manifest has one root, grouped as identity (`id`, `name`), data
 * (`connection`, `sources`, `resources`), auth (`auth`), content (`views`,
 * `pages`, `features`, `home`, `nav`) and chrome (`ui`); its pages are the
 * same page bodies a mistri.json carries, keyed by id. `features` merge
 * into one flat root before anything else is read (appFeatures.ts).
 *
 * The parse front here validates that shape location by location — a
 * key the types declare ahead of its feature is refused as not supported
 * yet, anything else unknown is refused with the keys the location takes —
 * resolves
 * every reference, and normalises the result into the internal AppDef
 * (appModel.ts) every server and client reader works from.
 *
 * The conventions are page.ts's: a malformed manifest throws with the file
 * and the fix named, booleans and shapes are refused rather than coerced,
 * and nothing is silently skipped.
 */
import { checkShellNew } from './appNewMenu.js';
import { parseBrandingDeclaration } from './tenantBranding.js';
import { TAGS_COLUMN } from '@mistriwork/engine/shared/tagLists.js';
import { stitchedFarProblem, stitchedHop, stitchedListProblem } from '@mistriwork/engine/shared/stitchedPaths.js';
import { hasFilterOf } from '@mistriwork/engine/shared/listFilters.js';
import {
  columnKind,
  findTable,
  columnOrRollup,
  isBinaryType,
  isFlagColumn,
  labelColumn,
  labelPath,
  primaryKey,
  tableNamed,
  type DatabaseSchema,
  type MachineStates,
  type TableMeta,
} from '@mistriwork/engine/shared/schema.js';
import { isLabelTemplate, LABEL_SEGMENT, parseLabelTemplate } from '@mistriwork/engine/shared/recordLabel.js';
import {
  computedColumnMeta,
  computedReads,
  readsMe,
  withComputedColumns,
  type ComputedColumn,
} from '@mistriwork/engine/shared/computed.js';
import { parseComputed } from '@mistriwork/engine/shared/computedParse.js';
import { labelTemplateProblem, stitchedLabelProblem } from './appRecordLabels.js';
export { appLabelTemplates, labelTemplateProblem, withLabelTemplates } from './appRecordLabels.js';
export { appCatalog, appRollupRules, withRollups } from './appRollups.js';
export { zonedNow } from './appZone.js';
export { segmentProblems, servedSegments } from './appSegments.js';
export { appConsumesRules } from './appConsumes.js';
import { ANYONE, andQuery, expandSegments, parseQuery, saidAt, topLevelConditions } from '@mistriwork/engine/shared/query.js';
import { funnelChains, funnelText } from '@mistriwork/engine/shared/funnel.js';
import { parseViewQuery, resolvePath, tryResolvePath } from '@mistriwork/engine/shared/view.js';
import { textToBreakdown } from '@mistriwork/engine/shared/breakdowntext.js';
import {
  parseAppForm,
  parseAppValidation,
  referencedRuleFields,
  referenceTarget,
  validateAppForm,
  validateFormRules,
  type FormRule,
} from './formRules.js';
import {
  checkCommandCatalogFlagGates,
  commandInputProblem,
  commandReferenceProblem,
  withCommandCatalog,
  type CommandCatalog,
} from './command.js';
import { machinePath, machineStates } from './appMachine.js';
import { atWhenFilter } from './appAtWhen.js';
import type { AppUpdateAction } from './command.js';
import {
  DEFAULT_WINDOWS,
  grantsByRole,
  isFormView,
  isPublicForm,
  noteRestated,
  resourceCeiling,
  resourceValidation,
  viewOrder,
  type AppDashSection,
  type DashTarget,
  type AppDashboardView,
  type AppDef,
  type AppDisplayRule,
  type AppFileDef,
  type AppForm,
  type AppListView,
  type ResolvedFormView,
  type ResolvedListView,
} from './appModel.js';
import { allowKeys, humanName, plainRecord, setKeyHomes, type AppNoun } from '@mistriwork/engine/shared/model.js';
import type { AppCalendarBackdrop, AppChecklist, AppListPresentation } from '@mistriwork/engine/shared/listPresentations.js';
import { fixedActionProblem, parseAuthGrants } from './appAuthGrants.js';
import { declaredNamesOf, parseDataBlocks } from './appResourceBlocks.js';
import { appFileRules, appTagRules } from './appResourceRules.js';
import { appSearchProblem } from './appSearch.js';
import { checkImports, importProblem } from './appImport.js';
import { metricCohortQuery, parseContent } from './appViews.js';
import { cardsProblem, cardsTitled } from '@mistriwork/engine/shared/appCards.js';
import { parseAppPages } from './appPages.js';
import { appRealms, checkTenancy } from './appTenancy.js';
import { headingOf } from '@mistriwork/engine/shared/appNoun.js';
import { appZone, parseUi } from './appUi.js';
import { parseOpenRoles } from './appViewRoles.js';
import { composeFeatures } from './appFeatures.js';
import { withProvenance } from './appProvenance.js';
import { AppProblems, attempt } from './appProblems.js';
import { slug } from '@mistriwork/engine/shared/slug.js';
import { normalizeFlagCatalog } from './appFlags.js';
import { captureFlagDeclaration, normalizeExperimentDeclarations } from './appExperiments.js';
import { analyticsCatalog, analyticsProblems, normalizeAnalytics } from './appAnalytics.js';
import { checkFlagCapabilityReferences } from './appFlagCapabilities.js';
import type { ServedFlowDiagram, ServedMachine, ServedResource } from '@mistriwork/engine/shared/servedApp.js';
export type { ServedFlowDiagram, ServedMachine, ServedResource } from '@mistriwork/engine/shared/servedApp.js';

/** Addresses the server answers itself, before any App; `_mistri` and the rest of shared/mount.ts SERVER_SEGMENTS are refused as mounts there. */
const RESERVED_IDS = new Set(['api', 'healthz', 'readyz']);
import { keyHomesFor } from './appKeyHomes.js';
import { apiCrossConnectionProblems, parseAppApi, type AppApiDef } from './appApi.js';
import { parseAppAssistant } from './appAssistant.js';
import { actionStamps, checkStamps } from './appStamps.js';
import { checkMe, checkedPerson, personTable } from './appMe.js';
import { textRulesProblem } from '@mistriwork/engine/shared/textRules.js';
import { servedDefined } from '@mistriwork/engine/shared/definedFields.js';
import { flowsProblem } from './appFlows.js';
import type { QueryPerson } from '@mistriwork/engine/shared/query.js';
import { autoKeyOf, withUnit } from '@mistriwork/engine/shared/autoBucket.js';
import { PREVIOUS_PERIOD, hasWindowPhrase, previousPeriodQuery, withoutWindowPhrase } from './dashWindow.js';
import { noteDeprecated } from './deprecations.js';
import { parseUnions } from './appUnions.js';
export { previousPeriodQuery, withoutWindowPhrase } from './dashWindow.js';
export { AppProblems, problemsOf } from './appProblems.js';
export { appStampRules, type AppStampRules } from './appStamps.js';
export * from './appModel.js';
export {
  resolveAppAccess,
  appActionGrants,
  appCommandGrants,
  appOperationsGrants,
  appCeilingWarnings,
  appMissingTables,
  appAllowsWrite,
  appDeletable,
  appExportable,
  writeScopeRefusal,
  rowPolicyAppShape,
  tenantAppShape,
  tenantBusinessApp,
} from './appAccess.js';
export * from '@mistriwork/engine/shared/appNoun.js';
export { landingHrefProblem } from './appLanding.js';
export type { AppCardsImageFrom, AppCardsList } from '@mistriwork/engine/shared/appCards.js';
export { orderAppPages, parseAppPage, parseAppPages } from './appPages.js';
export { listPresentationColumns } from '@mistriwork/engine/shared/appListColumns.js';
export { checkResourceSlot, sourceScopeOf } from './appResourceBlocks.js';
export { appFileRules, appTagRules, type AppFileRule, type AppTagRule } from './appResourceRules.js';
import { resolveDisplay } from './appDisplayResolve.js';
import { parseAppRetention } from './appRetention.js';
export { resolveDisplay } from './appDisplayResolve.js';

/** The root, by group: identity, data, auth, content, ui. */
export const ROOT_KEYS = [
  'id',
  'name',
  'connection',
  'sources',
  'resources',
  'unions',
  'auth',
  'views',
  'pages',
  'features',
  'home',
  'nav',
  'ui',
  'branding',
  'api',
  'track',
  'live',
  'flags',
  'audiences',
  'experiments',
  'analytics',
  'assistant',
  'retention',
] as const;
/* The homes a refused key is told it belongs in: a function to call, built on the first refusal (appKeyHomes.ts). */
setKeyHomes(keyHomesFor(ROOT_KEYS));

/** The table a list view shows; undefined for a dashboard, a form or a room. */
const listTable = (view: object): string | undefined =>
  !isFormView(view) && 'table' in view && typeof view.table === 'string' && !('sections' in view) ? view.table : undefined;

/**
 * Read an App manifest. `pages` is validated here and read again by the
 * loader, which joins the pages/ files onto the manifest's (loadApp).
 */
export function parseAppConfig(raw: unknown, where: string, options: { commands?: CommandCatalog } = {}): AppDef {
  /* The App names its commands; the loader hands the server's registrations
     in, and every name is resolved from them (shared/command.ts). */
  if (options.commands) return withCommandCatalog(options.commands, () => parseAppConfig(raw, where));
  /* Composition (appFeatures.ts): the root's `features` merge into one flat
     root first, everything below reads that, and a refusal about what a
     feature wrote names the feature (appProvenance.ts). It parses the api
     block itself — merging exposures needs the parsed shapes — and hands it
     back beside the root rather than on it, so it is parsed exactly once.
     Without features there is nothing to merge: the root still carries it
     raw, and parseRoot parses it. */
  const { root, origins, api } = composeFeatures(raw, where);
  const app = withProvenance(origins, where, () => parseRoot(root, where, api));
  /* A deprecated key still parses; `check` says what replaces it (deprecations.ts). Read off the raw App, where a
     feature slice still says which keys it wrote. */
  noteDeprecated(app, raw);
  return app;
}

/**
 * What the schema types can still be written from when the data half itself
 * is refused (a key in the wrong place inside one resource): the connection
 * and the tables the resources name, with the rollups, computed columns and segments each declares where they
 * read, without judging them. Nothing here
 * is validated, so it is only ever the stale-types guard's input (`partial`),
 * never an App that is served; an App naming several sources has no one
 * connection to type against and gets none.
 */
function dataHalfOf(a: Record<string, unknown>, id: string, name: string, ui: () => AppDef['ui']): AppDef | undefined {
  if (typeof a.connection !== 'string' || a.sources !== undefined) return undefined;
  const raw = a.resources;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const resources: Record<string, object> = {};
  for (const [table, declared] of Object.entries(raw)) {
    const hidden = (declared as { hidden?: unknown } | null)?.hidden;
    resources[table] = {
      ...(Array.isArray(hidden) && hidden.every((column) => typeof column === 'string') ? { hidden: hidden as string[] } : {}),
      // Its rollups, computed columns and segments, where each reads: pages name them like columns.
      ...declaredNamesOf(declared),
    };
  }
  return { id, name, connection: a.connection, resources, views: {}, nav: [], home: [], ui: ui() } as unknown as AppDef;
}

function parseRoot(raw: unknown, where: string, composed?: AppApiDef): AppDef {
  const a = plainRecord(raw, where, 'an object');
  allowKeys(a, ROOT_KEYS, where);
  if (typeof a.name !== 'string' || !a.name.trim()) throw new Error(`${where} has no "name". An app is named after what it is for.`);
  const name = a.name.trim();
  if (a.id !== undefined && (typeof a.id !== 'string' || !a.id.trim()))
    throw new Error(`${where} has an "id" that is not a non-empty string.`);
  /* The id is the App's address (`/helpdesk`) and its account store's name,
     so an unstated one is the slug the docs promise: a name of "Helpdesk" is
     served at /helpdesk. It once defaulted to `app-helpdesk`, and the address
     the docs gave opened a screen blaming the database. */
  const id = a.id === undefined ? slug(name, 'app') : (a.id as string).trim();
  /* `/api` and the orchestrator's probes are the server's own; an App there
     would never be reached. */
  if (RESERVED_IDS.has(id)) {
    throw new Error(
      `${where}: the App ${a.id === undefined ? `"${name}" would be served at /${id} (its id defaults to a slug of its name)` : `has the id "${id}"`}, ` +
        'which is the server\'s own address. Give it another "id".',
    );
  }
  /* The independent parts are judged side by side, so one run names every
     refusal (appProblems.ts): the resources, the look, then — when those
     parse — the grants, the API and the content; the pages always, since
     they read nothing else. */
  const problems: string[] = [];
  /* A union is read like a resource (appUnions.ts): a view names it as it names a table. */
  const parsedData = attempt(problems, () => {
    const data = parseDataBlocks(a, where);
    return a.unions === undefined ? data : { ...data, unions: parseUnions(a.unions, where) };
  });
  const parsedUi = attempt(problems, () => parseUi(a.ui, where));
  // A platform-only source is not one of the App's own: grants and tenancy count those only.
  const parsedAuth =
    parsedData &&
    attempt(problems, () =>
      parseAuthGrants(
        a.auth,
        where,
        resourceCeiling(parsedData.value),
        parsedData.value.sources ? Object.values(parsedData.value.sources).filter((source) => source.realm !== 'platform').length : 0,
      ),
    );
  const parsedContent =
    parsedData &&
    parsedAuth &&
    attempt(problems, () => {
      const data = parsedData.value;
      const auth = parsedAuth.value;
      const api = composed ?? parseAppApi(a.api, Object.keys(auth?.roles ?? {}), `${where}: api`);
      // Several sources may be exposed; one request reads one connection. What
      // parsing can see of a path across two is refused here, and the checked
      // catalog judges every path again (apiReadCatalog.ts).
      if (api) {
        const crossing = apiCrossConnectionProblems({ sources: data.sources, resources: data.resources, views: {}, api }, `${where}: api`);
        if (crossing.length) throw new Error(crossing[0]);
      }
      const content = parseContent(a, where, {
        data,
        name,
        ...(auth ? { auth } : {}),
        ...(api ? { api } : {}),
      });
      const placement = parsedUi?.value.shell?.placement;
      if (typeof placement === 'object') placement.top = parseOpenRoles(placement.top, `${where}: ui.shell.placement`, auth, 'top')!;
      /* A theme per role names roles the App declares, as a view's roles do. */
      const audiences = parsedUi?.value.theme?.for?.roles;
      if (audiences) parseOpenRoles(Object.keys(audiences), `${where}: ui.theme.for`, auth, 'roles');
      const shellNew = parsedUi?.value.shell?.new;
      if (shellNew) checkShellNew(shellNew, content.views, `${where}: ui.shell.new`);
      // An API serves the App's own data. Only the platform realm's own reads see a
      // platform-only source, so nothing exposed may belong to one: not a resource,
      // not a view's table, and not anything they reach — the checked catalog walks
      // the resolved dependencies too (apiTenantReadCatalog).
      if (api) {
        /* Where the menu puts each view, by the one walk `appForRealm` uses. Only
         the views and the menu are needed, and this is lenient: a menu that does
         not say its realms is checkTenancy's refusal, below, not this one's. */
        const apiViewRealm = appRealms({
          name,
          views: content.views,
          nav: content.nav,
          ...(auth ? { auth } : {}),
        } as AppDef).view;
        const outside = (resource: string | undefined) => {
          const source = resource === undefined ? undefined : data.resources?.[resource]?.source;
          return source !== undefined && data.sources?.[source]?.realm === 'platform' ? source : undefined;
        };
        const refuseExposure = (at: string, resource: string, source: string): never => {
          throw new Error(
            `${where}: api.${at} names "${resource}", which belongs to the platform-only source "${source}". ` +
              "Only the platform realm's own reads see that source; an API token and an MCP client never do.",
          );
        };
        for (const resource of Object.keys(api.resources)) {
          const source = outside(resource);
          if (source) refuseExposure(`resources.${resource}`, resource, source);
        }
        for (const { view } of api.views) {
          const exposed = content.views[view] as { table?: string; realm?: string } | undefined;
          const source = outside(exposed?.table);
          if (source) refuseExposure(`views.${view}`, exposed!.table!, source);
          // A token acts through one tenant membership. A platform-realm view is
          // the business above the tenants looking across them: its shape and its
          // question are theirs, so it is not a tenant token's to be served.
          //
          // Asked of the realm projection, never of the view's own word alone: a
          // view in a "platform" group serves the platform without saying so. The
          // ownership check downstream (apiTenantReadCatalog) is not the backstop
          // it looks like, because a platform view over a *tenant-owned* table —
          // the lender's list of a dealership's documents — passes it.
          if (apiViewRealm(view) === 'platform') {
            throw new Error(
              `${where}: api.views.${view} exposes a platform-realm view, which an API token cannot be served: ` +
                "a token acts through one tenant membership, and a platform-realm view is the platform's own. Expose a tenant-realm view.",
            );
          }
        }
        // The same for a command: each realm runs its own, and a tenant-bound token
        // never runs the platform's (apiTenantCommandCatalog refuses it again).
        for (const { command } of api.commands) {
          if ((command as { realm?: string }).realm === 'platform') {
            throw new Error(
              `${where}: api.commands names "${command.id}", a "realm": "platform" command, which an API token cannot run: ` +
                "a token acts through one tenant membership, and a platform-realm command is the platform's own.",
            );
          }
        }
      }
      return { data, auth, api, content };
    });
  const parsedPages = attempt(problems, () => parseAppPages(a, where));
  if (problems.length) {
    /* What the schema-types step needs is the App's data half — its
       connections, resources and grants — which can stand when a view does
       not: carried beside the refusal so a stale types file is not what the
       next typecheck judges by. */
    const partial: AppDef | undefined = parsedData
      ? {
          id,
          name,
          ...(parsedData.value.connection === undefined ? {} : { connection: parsedData.value.connection }),
          ...(parsedData.value.sources ? { sources: parsedData.value.sources } : {}),
          ...(parsedData.value.resources ? { resources: parsedData.value.resources } : {}),
          // Grants that did not parse are left out: the types then read as a reader with no grant, never a wrong one.
          ...(parsedAuth?.value ? { auth: parsedAuth.value } : {}),
          views: {},
          nav: [],
          home: [],
          ui: parsedUi?.value ?? parseUi(undefined, where),
        }
      : dataHalfOf(a, id, name, () => parsedUi?.value ?? parseUi(undefined, where));
    throw new AppProblems(problems, partial);
  }
  const ui = parsedUi!.value;
  const { data, auth, api, content } = parsedContent!.value;
  const declared = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(a, key);
    if (!descriptor) return {};
    if (!('value' in descriptor) || !descriptor.enumerable) throw new Error(`${where}: ${key} requires plain data.`);
    return captureFlagDeclaration(descriptor.value);
  };
  const catalog = normalizeFlagCatalog({
    flags: declared('flags'),
    audiences: declared('audiences'),
    roles: Object.keys(auth?.roles ?? {}),
  });
  checkCommandCatalogFlagGates(catalog);
  const experiments = normalizeExperimentDeclarations(declared('experiments'), catalog);
  checkFlagCapabilityReferences(auth?.roles ?? {}, catalog, experiments);
  const analytics = Object.hasOwn(a, 'analytics') ? normalizeAnalytics(declared('analytics'), where) : undefined;
  // What every command keeps by default; a command's own `track` overrides it (docs: commands, "What a command keeps").
  if (a.track !== undefined && !(['none', 'receipts', 'audit'] as unknown[]).includes(a.track)) {
    throw new Error(`${where}: track is "none", "receipts" or "audit".`);
  }
  // Live sync is the App's choice, off unless it asks (server/live/liveBinding.ts); `--no-live` still wins.
  if (a.live !== undefined && typeof a.live !== 'boolean') {
    throw new Error(`${where}: live is true (its open pages follow other people's changes) or false, the default.`);
  }
  const retention = Object.hasOwn(a, 'retention') ? parseAppRetention(a.retention, `${where}: retention`) : undefined;
  const pages = parsedPages!.value;
  const app: AppDef = {
    id,
    name,
    ...(Object.hasOwn(a, 'flags') ? { flags: catalog.flags } : {}),
    ...(Object.hasOwn(a, 'audiences') ? { audiences: catalog.audiences } : {}),
    ...(Object.hasOwn(a, 'experiments') ? { experiments } : {}),
    ...(analytics ? { analytics } : {}),
    ...(retention ? { retention } : {}),
    ...(data.connection === undefined ? {} : { connection: data.connection }),
    ...(data.sources ? { sources: data.sources } : {}),
    ...(data.resources ? { resources: data.resources } : {}),
    ...(data.unions ? { unions: data.unions } : {}),
    views: withMachineLanes(content.views, data.resources),
    nav: content.nav,
    home: content.home,
    ui,
    ...(auth ? { auth } : {}),
    ...(api ? { api } : {}),
    ...(content.landing ? { landing: content.landing } : {}),
    ...(a.track === undefined ? {} : { track: a.track as NonNullable<AppDef['track']> }),
    ...(a.live === true ? { live: true as const } : {}),
    ...(a.branding === undefined
      ? {}
      : {
          branding: parseBrandingDeclaration(a.branding, { ui, ...(auth ? { auth } : {}) }, where),
        }),
  };
  for (const page of pages) {
    for (const [i, section] of page.sections.entries()) {
      if (section.kind === 'flows' && !data.resources?.[page.base]?.flows) {
        throw new Error(
          `${where}: page "${page.id}", section ${i + 1}: a flows section shows the runs of the base resource's flows; resources.${page.base} declares none.`,
        );
      }
      if (
        section.kind === 'diagram' &&
        !data.resources?.[page.base]?.flows &&
        !Object.values(data.resources ?? {}).some((resource) => resource.flows?.from === page.base)
      ) {
        throw new Error(
          `${where}: page "${page.id}", section ${i + 1}: a diagram draws a flow's steps, on the page of a flow or of a record that runs them; ${page.base} is no resource's flows "from" and declares no flows.`,
        );
      }
      if (section.kind !== 'list' || !section.empty?.action) continue;
      const target = app.views[section.empty.action.view];
      if (
        !Object.hasOwn(app.views, section.empty.action.view) ||
        !target ||
        // A signed-in form is a room an empty list may open; a public one is served outside the App.
        isPublicForm(target) ||
        'form' in target ||
        'landing' in target
      ) {
        throw new Error(
          `${where}: page "${page.id}" related empty action names "${section.empty.action.view}", which is not a list, a dashboard or a signed-in form view.`,
        );
      }
    }
  }
  if (analytics) {
    const problems = analyticsProblems(analytics, analyticsCatalog(app, pages), where);
    if (problems.length) throw new Error(problems.join('\n'));
  }
  /* A Branding form saves what the App's `branding` lets a tenant change; without one there is nothing to save. */
  for (const [key, view] of Object.entries(app.views))
    if ('sections' in view && [...view.sections, ...(view.aside ?? [])].some((section) => section.kind === 'branding') && !app.branding)
      throw new Error(
        `${where}: views "${key}" has a branding form, and the App declares no "branding": say what a tenant may change, branding: { allow, editors }.`,
      );
  checkTenancy(app, pages);
  checkImports(app, where);
  checkStamps(app, where);
  checkMe(app, pages, where);
  const assistant = parseAppAssistant(
    a.assistant,
    {
      roles: auth?.roles ? Object.keys(auth.roles) : undefined,
      actions: Object.fromEntries(
        Object.entries(app.resources ?? {}).map(([key, resource]) => [key, (resource.actions ?? []).map(({ id }) => id)]),
      ),
      views: Object.fromEntries(Object.entries(app.views).map(([key, view]) => [key, listTable(view)])),
      recordTables: [...Object.values(app.views).flatMap((view) => listTable(view) ?? []), ...pages.map((page) => page.base)],
    },
    `${where}: assistant`,
  );
  /* A tenant App's assistant answers on the tab's context lease, and only for the tenants the platform owner turned
     it on for (tenant/tenantAssistant.ts). */
  if (assistant) app.assistant = assistant;
  /* A role's fixed actions, by label, once every resource's actions are known. */
  for (const [role, grant] of Object.entries(app.auth?.roles ?? {})) {
    for (const [resource, labels] of Object.entries(grant.actions ?? {})) {
      for (const label of labels) {
        const problem = fixedActionProblem(app, resource, label, `${where}: "auth", role "${role}", "actions", "${resource}"`);
        if (problem) throw new Error(problem);
      }
    }
  }
  noteRestated(app, restatedInRoot(a));
  return app;
}

/** The two things a root can say that are what it would be without: `signUp: 'invite'` and `default: true` on its only source. */
function restatedInRoot(root: Record<string, unknown>): string[] {
  const notes: string[] = [];
  const auth = root.auth;
  if (auth && typeof auth === 'object' && (auth as Record<string, unknown>).signUp === 'invite') {
    notes.push('"auth" [restated]: signUp: \'invite\' is the default. Delete it.');
  }
  const sources = root.sources;
  if (sources && typeof sources === 'object' && !Array.isArray(sources)) {
    const named = Object.entries(sources as Record<string, unknown>);
    if (named.length === 1 && (named[0][1] as { default?: unknown } | null)?.default === true) {
      notes.push(`sources "${named[0][0]}" [restated]: default: true on the only source is implied. Delete it.`);
    }
  }
  return notes;
}

/** Catalog check for the resources' invariants, including resources absent from navigation.
 * Call with the logical App catalog; writer enrollment must reject all warnings.
 * A resource the catalog does not have is refused outright, like every
 * other name the parsers cannot find: a rule that can never run is a typo,
 * and a typo carried as a warning is a rule quietly not enforced. */
export function resolveValidation(app: AppDef, schema: DatabaseSchema): { validation: Record<string, FormRule[]>; warnings: string[] } {
  const validation: Record<string, FormRule[]> = {};
  const warnings: string[] = [];
  for (const [resource, rules] of Object.entries(parseAppValidation(resourceValidation(app) ?? {}))) {
    const table = tableNamed(schema, resource);
    if (!table) throw new Error(`validation: unknown or ambiguous resource "${resource}".`);
    if (Object.hasOwn(validation, table.id)) warnings.push(`validation: duplicate resource identity "${resource}".`);
    else {
      Object.defineProperty(validation, table.id, {
        value: rules,
        enumerable: true,
      });
      const virtual = virtualReads(app, resource, rules, table, schema);
      const worked = storedComputed(app, schema);
      warnings.push(
        ...(virtual.length
          ? virtual
          : validateFormRules(
              rules,
              worked.tables.find((each) => each.id === table.id)!,
              worked,
            )
        ).map((problem) => `validation "${resource}": ${problem}`),
      );
    }
  }
  return { validation: Object.freeze(validation), warnings };
}

/**
 * The catalog with each resource's computed columns among its table's columns (computed.ts withComputedColumns): what
 * a validation and a form's value from a referenced record read one through, worked out of the stored row (DM5).
 */
export function storedComputed(app: AppDef, schema: DatabaseSchema): DatabaseSchema {
  const byTable = new Map<string, Record<string, Pick<ComputedColumn, 'type'>>>();
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const table = resource.computed && tableNamed(schema, name);
    if (table && !byTable.has(table.id)) byTable.set(table.id, resource.computed!);
  }
  return withComputedColumns(schema, byTable);
}

/**
 * Why a computed column cannot be worked out of the record as stored, or undefined where it can (DM5): it reads a
 * rollup, counted from other tables' rows; a path through a reference, another record; or `me`, who a record's rule
 * does not know. A computed column it reads is held to the same. One that does not parse is its own problem.
 */
function storedUnreadable(app: AppDef, resource: string, name: string, table: TableMeta, seen = new Set<string>()): string | undefined {
  const declared = app.resources?.[resource];
  const computed = declared?.computed && Object.hasOwn(declared.computed, name) ? declared.computed[name] : undefined;
  if (!computed || seen.has(name)) return undefined;
  seen.add(name);
  const own = (path: string) =>
    table.columns.some((column) => column.name === path) ||
    Object.hasOwn(declared!.rollups ?? {}, path) ||
    Object.hasOwn(declared!.computed ?? {}, path);
  let node;
  try {
    node = parseComputed(computed.value, (path) => path.includes('.') || own(path));
  } catch {
    return undefined;
  }
  if (readsMe(node)) return '`me`, the person reading';
  for (const path of computedReads(node)) {
    if (path.includes('.')) return `"${path}", another record's`;
    if (Object.hasOwn(declared!.rollups ?? {}, path)) return `the rollup "${path}", counted from other tables' rows`;
    const deeper = storedUnreadable(app, resource, path, table, seen);
    if (deeper) return deeper;
  }
  return undefined;
}

/* A form's value from a referenced record's computed column is worked out of that record as stored: one it cannot be
   worked out of is refused with why (storedUnreadable). */
function derivedComputedProblem(app: AppDef, form: AppForm, table: TableMeta, schema: DatabaseSchema): string | undefined {
  for (const [field, path] of Object.entries(parseAppForm(form, 'Form', true).derived ?? {})) {
    const [via, name] = path!.split('.');
    const target = referenceTarget(via, table, schema);
    const resource = target && Object.keys(app.resources ?? {}).find((key) => tableNamed(schema, key)?.id === target.id);
    const why = resource && storedUnreadable(app, resource, name, target);
    if (why)
      return `Form: defaults "${field}" is from "${path}", computed from ${why}, which a new record cannot take from the record as stored.`;
  }
  return undefined;
}

/* A validation is judged against the record as stored, the post-image a write
   leaves (server appValidation.ts). A computed column is worked out of that
   row as a list works it out (DM5), where it reads the row's own columns; a
   rollup is counted from other tables' rows, and is not there to judge: named,
   it is refused here, as is a computed column that reads one, rather than as
   an unknown column the App only meets when it is served. */
function virtualReads(app: AppDef, resource: string, rules: readonly FormRule[], table: TableMeta, schema: DatabaseSchema): string[] {
  let fields: string[];
  try {
    fields = referencedRuleFields(rules);
  } catch {
    return [];
  }
  return fields.flatMap((path) => {
    // Through a reference, the record it names is read as stored too: its computed columns and rollups are no more there.
    const [via, name] = path.split('.');
    const through = name === undefined ? undefined : referenceTarget(via, table, schema);
    if (name !== undefined && !through) return [];
    const [field, at, of] = through ? [name, through, through.name] : [path, table, resource];
    const declared = app.resources?.[of];
    const computed = declared?.computed && Object.hasOwn(declared.computed, field) ? declared.computed[field] : undefined;
    if (computed) {
      const why = storedUnreadable(app, of, field, at);
      if (!why) return [];
      const reads = computedInputs(computed.value, at);
      return [
        `"${path}" is computed ("${computed.value}") from ${why}, which a validation cannot work out of the stored record. ` +
          `Write the condition on the columns it reads${reads.length ? ` (${reads.join(', ')})` : ''}, or refuse the write in a command.`,
      ];
    }
    if (declared?.rollups && Object.hasOwn(declared.rollups, field))
      return [
        `"${path}" is a rollup, counted from other tables' rows when the record is read, and a validation judges the record's ` +
          `own stored columns. Refuse the write in a command that reads it.`,
      ];
    return [];
  });
}

/* A fixed action's `when` is judged inside its write, against the stored row read through one table
   (appTransitions.ts), where a computed column and a rollup are not there: one it named held for nothing, so the
   button was offered and every press refused. A command's `when` reads them (commandWhen.ts), so that is the fix. */
function derivedWhenProblem(
  action: { id: string; when?: string },
  table: TableMeta,
  segments: Readonly<Record<string, { query: string }>> | undefined,
): string | undefined {
  const named = segments && Object.fromEntries(Object.entries(segments).map(([key, segment]) => [key, segment.query]));
  const parsed = parseQuery(`${table.id} ${expandSegments(action.when ?? '', named).text}`, { me: ANYONE });
  const paths = (parsed.query?.filter.groups ?? []).flat().map((condition) => condition.column);
  const derived = paths.find((path) => Object.hasOwn(table.computed ?? {}, path) || Object.hasOwn(table.rollups ?? {}, path));
  if (!derived) return undefined;
  const what = Object.hasOwn(table.computed ?? {}, derived)
    ? `"${derived}" is computed, worked out when the record is read`
    : `"${derived}" is a rollup, counted from other tables' rows when the record is read`;
  return (
    `action "${action.id}", when: ${what}, and a fixed action's when is judged against the stored row inside its write, ` +
    `where it is not. Write the condition on stored columns, or run the action as a command, whose when reads it.`
  );
}

/* The names a computed expression reads, for the fix; none when it does not parse (its own problem says why). */
function computedInputs(value: string, table: TableMeta): string[] {
  try {
    return computedReads(parseComputed(value, (path) => table.columns.some((column) => column.name === path)));
  } catch {
    return [];
  }
}

/** One resource's machine, as a generic write meets it (appTransitions.ts), resolved against the catalog. */
interface AppTransitionRule {
  /** The machine's column → the fixed verbs that may move it (none: only its commands do). */
  fields: ReadonlyMap<string, readonly AppUpdateAction[]>;
  /** The machine's column → the state a new record starts in: the first. */
  starts: ReadonlyMap<string, string>;
  /** Every (from → to) the graph allows, by any verb: what a command's write is held to. */
  moves: ReadonlyMap<string, ReadonlySet<string>>;
  /** The machine's column and its `since`, stamped when the state changes. */
  column: string;
  since?: string;
  /** The App's `ui.timezone`, the wall clock a zone-less `since` is written in (UTC when absent). */
  timezone?: string;
}
export type AppTransitionRules = ReadonlyMap<string, AppTransitionRule>;

/**
 * Each resource's machine (appMachine.ts), keyed by table id: its column
 * moves only as a fixed verb from the stored state, or by a command along an
 * edge. Problems are the App's to fix before it starts: a graph the server
 * could not enforce must never become an unchecked write (appTransitions).
 */
export function appTransitionRules(app: AppDef, schema: DatabaseSchema): { rules: Map<string, AppTransitionRule>; problems: string[] } {
  const exact = grantsByRole(app);
  const rules = new Map<string, AppTransitionRule>();
  const problems: string[] = [];
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const machine = resource.machine;
    const table = exact ? schema.tables.find((candidate) => candidate.id === name) : tableNamed(schema, name);
    if (!table) continue;
    /* The resource's timers at an instant (appAt.ts): a date or timestamp column, and a when the sweep can run. */
    for (const timer of resource.at ?? []) {
      const at = table.columns.find((candidate) => candidate.name === timer.column);
      if (!at || at.primaryKey || (columnKind(at.type) !== 'date' && !Object.hasOwn(resource.types ?? {}, timer.column)))
        problems.push(
          `resources "${name}": at "${timer.column}" runs "${timer.command}", and "${timer.column}" is not a date or timestamp column of ${table.name}.`,
        );
      const when = timer.when === undefined ? undefined : atWhenFilter(schema, table, timer.when);
      if (when?.problem) problems.push(`resources "${name}": at "${timer.column}", when: ${when.problem}`);
    }
    if (!machine) continue;
    const column = machine.column;
    const meta = table.columns.find((candidate) => candidate.name === column);
    if (!meta) {
      problems.push(`resources "${name}": the machine's column "${column}" is not a column of ${table.name}.`);
      continue;
    }
    if (meta.primaryKey) {
      problems.push(`resources "${name}": the machine's column "${column}" is part of the key, and a key does not move.`);
      continue;
    }
    if (machine.since !== undefined && !table.columns.some((candidate) => candidate.name === machine.since && !candidate.primaryKey)) {
      problems.push(`resources "${name}": the machine's "since" names "${machine.since}", which is not a column of ${table.name}.`);
    }
    for (const state of machine.states) {
      /* A move `by` a role is a service's alone: a role a person may hold would be a verb without a button. */
      for (const by of state.by ?? []) {
        const role = app.auth?.roles && Object.hasOwn(app.auth.roles, by.role) ? app.auth.roles[by.role] : undefined;
        if (role?.service !== true)
          problems.push(
            `resources "${name}": the machine's state "${state.name}" is moved by "${by.role}", which is not a role with service: true; only a service principal takes a move no verb makes.`,
          );
      }
    }
    const updates = (resource.actions ?? []).filter(
      (action): action is AppUpdateAction => !action.command && Object.hasOwn(action.set, column),
    );
    for (const action of updates) {
      if (action.reason !== undefined && !table.columns.some((candidate) => candidate.name === action.reason)) {
        problems.push(
          `resources "${name}": verb "${action.label}" asks its reason into "${action.reason}", which is not a column of ${table.name}.`,
        );
      }
    }
    const moves = new Map<string, Set<string>>();
    for (const edge of machine.edges) {
      const next = moves.get(edge.from) ?? new Set<string>();
      for (const to of edge.to) next.add(to);
      moves.set(edge.from, next);
    }
    rules.set(table.id, {
      fields: new Map([[column, updates]]),
      starts: new Map([[column, machine.states[0].name]]),
      moves,
      column,
      ...(machine.since === undefined ? {} : { since: machine.since }),
      ...(appZone(app.ui) ? { timezone: appZone(app.ui) } : {}),
    });
  }
  return { rules, problems };
}

/**
 * Whether a standing query can hold a record whose `column` is `value`: some branch of it (its conditions are read
 * as ORs of ANDs, `not in` as its inequalities) puts no condition on the column that the value fails. Only
 * equality, inequality and `in` are judged; anything else, or a query that does not parse, admits it.
 */
function admits(
  table: string,
  query: string | undefined,
  column: string,
  value: string,
  states?: MachineStates,
  segments?: Readonly<Record<string, string>>,
): boolean {
  if (!query?.trim()) return true;
  /* A segment's name is its conditions (query.ts expandSegments): `query: 'open'` trims the lanes `status is open`
     would. Nobody is signed in at load, so `me` reads as anyone's and judges no lane. */
  const parsed = parseQuery(`${table} ${expandSegments(query, segments).text}`, {
    ...(states ? { states: { [column]: states } } : {}),
    me: ANYONE,
  });
  if (parsed.errors.length || !parsed.query) return true;
  const groups = parsed.query.filter.groups;
  if (!groups.length) return true;
  return groups.some((group) =>
    group.every((condition) => {
      if (condition.column !== column) return true;
      const listed = Array.isArray(condition.value) ? condition.value.map(String) : [String(condition.value)];
      if (condition.op === '=') return listed.includes(value);
      if (condition.op === '!=') return !listed.includes(value);
      if (condition.op === 'in') return listed.includes(value);
      return true;
    }),
  );
}

/**
 * A board over a machine's column reads its lanes in the machine's order —
 * the record's forward path, then any state off it that is not an exit, the
 * first eight. Every other board
 * finds its lanes from the column's vocabulary or the values it holds.
 */
function withMachineLanes(views: AppDef['views'], resources: AppDef['resources']): AppDef['views'] {
  const lanesOf = (table: string | undefined, by: string | undefined, query: string | undefined): string[] | undefined => {
    const machine = table === undefined ? undefined : resources?.[table]?.machine;
    if (!machine || machine.column !== by) return undefined;
    /* The forward path, then the states off it that are not an exit: a lane each, the first eight. A state the
       view's standing query never admits (`status != collected`) is no lane: it could only ever stand empty. */
    const path = machinePath(machine);
    const segments = resources?.[table!]?.segments;
    const named = segments && Object.fromEntries(Object.entries(segments).map(([name, segment]) => [name, segment.query]));
    return [...path, ...machine.states.filter((state) => !state.final && !path.includes(state.name)).map((state) => state.name)]
      .filter((state) => admits(table!, query, by, state, machineStates(machine), named))
      .slice(0, 8);
  };
  let changed = false;
  const out: AppDef['views'] = {};
  for (const [key, view] of Object.entries(views)) {
    out[key] = view;
    if ('sections' in view) {
      const sections = view.sections.map((section) => {
        const lanes = section.kind === 'board' ? lanesOf(section.table, section.by, (section as { query?: string }).query) : undefined;
        return lanes ? { ...section, lanes } : section;
      });
      if (sections.some((section, index) => section !== view.sections[index])) {
        out[key] = { ...view, sections };
        changed = true;
      }
    } else if ('table' in view && view.presentation?.kind === 'board') {
      const lanes = lanesOf(view.table, view.presentation.by, view.query);
      if (lanes) {
        out[key] = { ...view, presentation: { ...view.presentation, lanes } };
        changed = true;
      }
    }
  }
  return changed ? out : views;
}

/** Validate against the readable catalog; callers must not publish these errors after field pruning. */
function checklistProblem(list: AppChecklist, table: TableMeta): string | undefined {
  if (!table.columns.some((column) => column.primaryKey)) return 'Checklist requires a complete readable primary key.';
  const names: Array<[string, string]> = [
    ['primary', list.primary],
    ['checked', list.checked],
    ...(list.lines ?? []).map((line, i): [string, string] => [`lines[${i}]`, line]),
  ];
  for (const [key, name] of names) {
    const column = table.columns.find((column) => column.name === name);
    if (!column || name.includes('.')) return `Checklist ${key}: "${name}" must be a local readable column.`;
    if (key === 'primary' && columnKind(column.type) !== 'text') return 'Checklist primary must be a text column.';
    if (key === 'checked' && columnKind(column.type) !== 'boolean')
      return 'Checklist checked must be a boolean column (declare BOOLEAN in SQLite).';
  }
  return undefined;
}

/**
 * A calendar's shaded span against the readable catalog: its resource is a table here, its ends are its date
 * columns, and its label is one of its columns. A reader's catalog that lacks any of them is not offered the span
 * (appFieldProjection.ts), and the calendar stands without it.
 */
export function backdropProblem(span: AppCalendarBackdrop, schema: DatabaseSchema): string | undefined {
  const table = tableNamed(schema, span.from);
  if (!table) return `Calendar backdrop: no table "${span.from}" is readable here.`;
  for (const [key, name] of [
    ['start', span.start],
    ['end', span.end],
  ] as const) {
    const column = table.columns.find((candidate) => candidate.name === name);
    if (!column) return `Calendar backdrop ${key}: "${name}" is not a column of "${table.name}" that is readable here.`;
    if (!/date|time/i.test(column.type ?? ''))
      return `Calendar backdrop ${key}: "${name}" is ${column.type || 'untyped'}; a span runs between date columns.`;
  }
  if (!table.columns.some((candidate) => candidate.name === span.labelColumn))
    return `Calendar backdrop labelColumn: "${span.labelColumn}" is not a column of "${table.name}" that is readable here.`;
  if (!primaryKey(table).length) return `Calendar backdrop: "${table.name}" needs a complete readable primary key.`;
  return undefined;
}

/** Every list presentation, judged against the readable catalog the same way. */
export function listProblem(
  list: AppListPresentation,
  table: TableMeta,
  schema?: DatabaseSchema,
  files?: ReadonlySet<string>,
  icons?: (column: string) => boolean,
): string | undefined {
  if (list.kind === 'checklist') return checklistProblem(list, table);
  if (list.kind === 'cards') return cardsProblem(list, table, schema, files, icons);
  /* A split's columns are label paths, judged by the path resolver where the
     entry's own show is; there is no local column of its own to check here. */
  if (list.kind === 'split') {
    if (!list.row) return undefined;
    /* Its rows are a queue's, judged as a queue's, the avatar being one more name. */
    const { avatar, ...queue } = list.row;
    const bad = listProblem({ kind: 'queue', ...queue }, table, schema, files);
    if (bad) return bad.replace(/^Queue/, 'Split row');
    if (avatar !== undefined && !avatar.includes('.') && !table.columns.some((column) => column.name === avatar))
      return `Split row avatar: "${avatar}" must be a readable column.`;
    return undefined;
  }
  /* A custom list reads its label paths as a split's are read: through the path resolver, against this catalog. */
  if (list.kind === 'custom') {
    if (!schema) return undefined;
    for (const path of list.show) {
      try {
        resolvePath(schema, table.id, path);
      } catch (err) {
        return `Custom list show: "${path}" (${(err as Error).message}).`;
      }
    }
    return undefined;
  }
  if (list.kind === 'tree' || list.kind === 'gantt') {
    const word = list.kind === 'tree' ? 'Tree' : 'Gantt';
    if (!table.columns.some((column) => column.primaryKey)) return `${word} requires a complete readable primary key.`;
    if (list.kind === 'tree') {
      const parent = table.columns.find((column) => column.name === list.parent);
      if (!parent) return `Tree parent: "${list.parent}" must be a local readable column.`;
      const self = schema?.foreignKeys.some(
        (fk) =>
          fk.from.table === table.id && fk.to.table === table.id && fk.from.columns.length === 1 && fk.from.columns[0] === list.parent,
      );
      if (schema && !self) return `Tree parent: "${list.parent}" must reference "${table.name}" itself, the record above each one.`;
    } else {
      for (const [key, name] of [
        ['start', list.start],
        ['end', list.end],
      ] as const) {
        const column = table.columns.find((candidate) => candidate.name === name);
        if (!column) return `Gantt ${key}: "${name}" must be a local readable column.`;
        if (!/date|time/i.test(column.type ?? ''))
          return `Gantt ${key}: "${name}" is ${column.type || 'untyped'}; a bar runs between date columns.`;
      }
      if (list.progress !== undefined) {
        const progress = table.columns.find((candidate) => candidate.name === list.progress);
        if (!progress || columnKind(progress.type) !== 'number')
          return `Gantt progress: "${list.progress}" must be a local numeric column (0–100).`;
      }
    }
    const named = [
      ['primary', list.primary],
      ...(list.kind === 'tree' ? (list.lines ?? []).map((line, i) => [`lines[${i}]`, line]) : []),
      ...(list.kind === 'gantt' && list.by !== undefined ? [['by', list.by]] : []),
    ] as Array<[string, string]>;
    for (const [key, name] of named) {
      let column = table.columns.find((candidate) => candidate.name === name);
      if (name.includes('.')) {
        if (!schema) continue;
        try {
          column = resolvePath(schema, table.id, name).column;
        } catch (error) {
          return `${word} ${key}: "${name}" is not a readable one-hop reference label path (${(error as Error).message}).`;
        }
      }
      if (!column) return `${word} ${key}: "${name}" must be a readable column.`;
    }
    return undefined;
  }
  if (list.kind === 'calendar') {
    if (!table.columns.some((column) => column.primaryKey)) return 'Calendar requires a complete readable primary key.';
    const date = table.columns.find((column) => column.name === list.date);
    if (!date || list.date.includes('.')) return `Calendar date: "${list.date}" must be a local readable column.`;
    if (!/date|time/i.test(date.type ?? ''))
      return `Calendar date: "${list.date}" is ${date.type || 'untyped'}; a calendar places records by a date column.`;
    if (list.end !== undefined) {
      const end = table.columns.find((column) => column.name === list.end);
      if (!end || list.end.includes('.')) return `Calendar end: "${list.end}" must be a local readable column.`;
      if (!/date|time/i.test(end.type ?? ''))
        return `Calendar end: "${list.end}" is ${end.type || 'untyped'}; a record's last day is a date column.`;
    }
    const named = [
      ['primary', list.primary],
      ...(list.badge === undefined ? [] : [['badge', list.badge]]),
      ...(list.lines ?? []).map((line, i) => [`lines[${i}]`, line]),
    ] as Array<[string, string]>;
    for (const [key, name] of named) {
      let column = table.columns.find((candidate) => candidate.name === name);
      if (name.includes('.')) {
        // As a queue's: a caller with the catalog proves the one-hop path.
        if (!schema) continue;
        try {
          column = resolvePath(schema, table.id, name).column;
        } catch (error) {
          return `Calendar ${key}: "${name}" is not a readable one-hop reference label path (${(error as Error).message}).`;
        }
      }
      if (!column) return `Calendar ${key}: "${name}" must be a readable column.`;
      if (key === 'primary' && columnKind(column.type) !== 'text') return 'Calendar primary must be a text column.';
    }
    for (const span of schema ? (list.backdrop ?? []) : []) {
      const problem = backdropProblem(span, schema!);
      if (problem) return problem;
    }
    return undefined;
  }
  const word = list.kind === 'queue' ? 'Queue' : 'Board';
  if (!table.columns.some((column) => column.primaryKey)) return `${word} requires a complete readable primary key.`;
  const lines = (list.lines ?? []).map((line, i): [string, string] => [`lines[${i}]`, line]);
  if (list.kind === 'queue') {
    const named: Array<[string, string]> = [
      ['primary', list.primary],
      ...(list.badge === undefined ? [] : [['badge', list.badge] as [string, string]]),
      ...lines,
      ...(list.facts ?? []).map((fact, i): [string, string] => [`properties[${i}]`, fact]),
    ];
    for (const [key, name] of named) {
      let column = table.columns.find((candidate) => candidate.name === name);
      // A fact, a line or the badge may be a rollup of the row: a pick list's lines, a board's open threads.
      if (!column && key !== 'primary' && columnOrRollup(table, name)) continue;
      if (name.includes('.')) {
        /* Callers with a catalog prove the reference path; a local-only caller
           retains the old local validation without crashing on a path. */
        if (!schema) continue;
        try {
          column = resolvePath(schema, table.id, name).column;
        } catch (error) {
          return `Queue ${key}: "${name}" is not a readable one-hop reference label path (${(error as Error).message}).`;
        }
      }
      if (!column) return `Queue ${key}: "${name}" must be a readable column.`;
      /* A reference column titles the card by the record it names, as a board's does; a path reads one column of it. */
      if (key === 'primary' && columnKind(column.type) !== 'text' && !(column.references && !name.includes('.')))
        return `Queue primary must be a text column, a reference (which titles each card by the record it names), or a label path to a text column.`;
    }
    return undefined;
  }
  const names: Array<[string, string]> = [['by', list.by], ['primary', list.primary], ...lines];
  for (const [key, name] of names) {
    let column = table.columns.find((column) => column.name === name);
    /* A board's title may be read through one reference, as a queue's is: `patient_id.name`. A caller without the
       catalog cannot prove the path and keeps the local checks. */
    if (key === 'primary' && name.includes('.')) {
      if (!schema) continue;
      try {
        column = resolvePath(schema, table.id, name).column;
      } catch (error) {
        return `Board primary: "${name}" is not a readable one-hop reference label path (${(error as Error).message}).`;
      }
      if (columnKind(column.type) !== 'text')
        return 'Board primary must be a text column, or a reference, which titles each card by the record it names.';
      continue;
    }
    // A board's line may be a rollup or a computed number of the row, as a queue's may: a problem's open tickets.
    if (!column && key.startsWith('lines[') && columnOrRollup(table, name)) continue;
    if (!column || name.includes('.')) return `${word} ${key}: "${name}" must be a local readable column.`;
    /* A reference titles a card by the record it names, as a cell does (listReferenceNames): a fulfillment is
       its order, `#1042 · Ana Ruiz`, with no copy of the order's name kept on the parcel. */
    if (key === 'primary' && columnKind(column.type) !== 'text' && !column.references)
      return `${word} primary must be a text column, or a reference, which titles each card by the record it names.`;
    if (key === 'by' && column.primaryKey) return 'Board by must not be a primary key column.';
  }
  if (list.kind === 'board' && list.lanes) {
    const allowed = table.columns.find((column) => column.name === list.by)?.allowed;
    const unknown = allowed && list.lanes.filter((lane) => !allowed.includes(lane));
    if (unknown?.length)
      return `Board lanes ${unknown.map((lane) => JSON.stringify(lane)).join(', ')} are not in the declared vocabulary of "${list.by}".`;
  }
  if (list.kind === 'board' && list.order !== undefined) {
    const order = table.columns.find((column) => column.name === list.order);
    if (!order || list.order.includes('.')) return `Board order: "${list.order}" must be a local readable column.`;
    if (columnKind(order.type) !== 'number')
      return `Board order: "${list.order}" is ${order.type || 'untyped'}; a card's place in its lane is a number.`;
    if (order.primaryKey) return 'Board order must not be a primary key column.';
    if (list.order === list.by) return 'Board order must be another column than by: one says the lane, the other the place in it.';
  }
  if (list.kind === 'board' && list.swimlanes !== undefined) {
    const rows = table.columns.find((column) => column.name === list.swimlanes);
    if (!rows || list.swimlanes.includes('.')) return `Board swimlanes: "${list.swimlanes}" must be a local readable column.`;
    if (rows.primaryKey) return 'Board swimlanes must not be a primary key column: a row per record is a list, not a board.';
  }
  if (list.kind === 'board' && list.sum !== undefined) {
    const sum = table.columns.find((column) => column.name === list.sum);
    if (!sum || list.sum.includes('.')) return `Board sum: "${list.sum}" must be a local readable column.`;
    if (columnKind(sum.type) !== 'number') return `Board sum: "${list.sum}" is ${sum.type || 'untyped'}; a lane's sum adds numbers.`;
  }
  if (list.kind === 'board' && list.folded && !list.lanes) {
    const allowed = table.columns.find((column) => column.name === list.by)?.allowed;
    const unknown = allowed && list.folded.filter((lane) => !allowed.includes(lane));
    if (unknown?.length)
      return `Board folded ${unknown.map((lane) => JSON.stringify(lane)).join(', ')} are not in the declared vocabulary of "${list.by}".`;
  }
  /* Authored lanes already bound the limits' keys (the parser checks them); otherwise a vocabulary does. */
  if (list.kind === 'board' && list.limits && !list.lanes) {
    const allowed = table.columns.find((column) => column.name === list.by)?.allowed;
    const unknown = allowed && Object.keys(list.limits).filter((lane) => !allowed.includes(lane));
    if (unknown?.length)
      return `Board limits ${unknown.map((lane) => JSON.stringify(lane)).join(', ')} are not in the declared vocabulary of "${list.by}".`;
  }
  return undefined;
}

/**
 * The views against one connection's schema, keyed as authored and listed in
 * the menu's order. A view whose table this connection does not have is
 * returned *with its reason* rather than dropped — a shorter menu with no
 * explanation is the failure this whole tool argues against.
 *
 * Tables resolve by id or by unambiguous bare name, the same convention as
 * the query language and MCP: a manifest is written `"work_order"`, and on
 * Postgres the table's identity is `"public.work_order"`. Matching ids
 * alone made every view "missing" on the product's primary target. What
 * is served back is the *resolved* id, because that is what every client
 * lookup — `appListFor`, the show clause, the grid — keys on.
 */
export function resolveViews(app: AppDef, schema: DatabaseSchema): Record<string, ResolvedListView | AppDashboardView | ResolvedFormView> {
  const resolved: Record<string, ResolvedListView | AppDashboardView | ResolvedFormView> = {};
  /* The tables whose rows are files, for a card's picture drawn from one. */
  const files = new Set(appFileRules(app, schema).rules.keys());
  /* `me` is judged as a request's parse will read it (appMe.ts), on a person no row is. */
  const person = checkedPerson(app, schema);
  for (const key of viewOrder(app)) {
    const view = app.views[key];
    resolved[key] = isFormView(view)
      ? resolveFormView(view, schema)
      : 'sections' in view
        ? resolveDashboard(view, schema, person, app.views)
        : withImport(
            resolveListView(
              view,
              schema,
              files,
              app.resources?.[view.table]?.noun,
              person,
              app.resources?.[view.table]?.recordLabel,
              (column) => Object.keys(app.resources?.[view.table]?.display?.[column]?.icons ?? {}).length > 0,
            ),
            schema,
          );
  }
  return resolved;
}

/* A list's own import that this catalog cannot run is not offered (resolveResources says why). */
function withImport(view: ResolvedListView, schema: DatabaseSchema): ResolvedListView {
  if (!view.import) return view;
  const table = tableNamed(schema, view.table);
  return table && !importProblem(view.import, table, schema) ? view : { ...view, import: false };
}

/* A form reads nothing itself; a reference input's picker reads its resource, which must be in this catalog. */
function resolveFormView(view: ResolvedFormView, schema: DatabaseSchema): ResolvedFormView {
  const problem = commandInputProblem(view.command.input, schema);
  return problem ? { ...view, error: problem } : view;
}

/**
 * A metric's data target that is the whole the figure is a share of: the same table and measure, and no condition
 * the metric does not also hold (structural, over top-level `and`s with segments written out). Then "118 of 159
 * (74%)" is true, where "74% of 159 target" is not. The whole is the same cohort as the figure, so it follows the
 * reader's window by the metric's clock, and the metric's own authored window is carried into it. Where the subset
 * cannot be shown, nothing is returned and the target stays a goal.
 */
function wholeTarget(
  s: { query?: string; measure?: string; over?: string },
  table: { id: string; segments?: Readonly<Record<string, string>> },
  target: DashTarget,
): DashTarget | undefined {
  if (target.by || target.table !== table.id) return undefined;
  const squash = (text: string | undefined) => (text ?? 'count').replace(/\s+/g, ' ').trim();
  if (squash(target.measure) !== squash(s.measure)) return undefined;
  /* The author's own window on the metric's clock is not a condition the whole lacks: it is carried over, below. */
  const base = s.over ? withoutWindowPhrase(s.query, s.over) : undefined;
  const held = topLevelConditions(s.query ?? '', table.segments);
  const asked = new Set(topLevelConditions(base ?? s.query ?? '', table.segments));
  if (!topLevelConditions(target.query ?? '', table.segments).every((condition) => asked.has(condition))) return undefined;
  const window = base === undefined ? [] : held.filter((condition) => !asked.has(condition));
  return {
    ...target,
    ...(s.over && !target.over ? { over: s.over } : {}),
    ...(window.length ? { query: andQuery(target.query, ...window), windowBase: target.query ?? '' } : {}),
  };
}

/**
 * A dashboard resolves its own way: every section's table by the id-or-name
 * convention, every metric and compare through the breakdown grammar its
 * number will run in, every list query through the real parser. Same
 * contract as a list view — carried with its reason, never dropped.
 */
function resolveDashboard(
  entry: AppDashboardView,
  schema: DatabaseSchema,
  person: QueryPerson | undefined,
  views: AppDef['views'],
): AppDashboardView {
  const me = person ? { me: person } : {};
  /* Every section is judged, and every problem kept: a dashboard with
     five typos used to be five reload cycles, one refusal at a time.
     Each section still stops at its own first problem — the checks
     below build on one another — but the next section gets its turn. */
  const problems: string[] = [];
  let dashError: string | undefined;
  const windows = entry.windows ?? DEFAULT_WINDOWS;
  const resolveSections = (authored: readonly AppDashSection[]): AppDashSection[] =>
    authored.map((s): AppDashSection => {
      if (dashError) {
        problems.push(dashError);
        dashError = undefined;
      }
      /* A note has no table to resolve and no grammar to judge. */
      if (s.kind === 'note') return s;
      /* An activity's resources, by the id-or-name convention: one this
       catalog does not hold (a reader whose grant leaves it out) is left out
       of the feed, as its rows are left out of every other read. */
      if (s.kind === 'activity') {
        return {
          ...s,
          resources: Object.fromEntries(
            Object.entries(s.resources ?? {}).flatMap(([name, mark]) => {
              const table = tableNamed(schema, name);
              return table ? [[table.id, mark]] : [];
            }),
          ),
        };
      }
      /* A find's resources likewise: one this reader's catalog lacks is not searched. */
      if (s.kind === 'find')
        return {
          ...s,
          searched: (s.searched ?? []).flatMap((name) => tableNamed(schema, name)?.id ?? []),
        };
      /* A first run's step is served its table, whose first row marks it done; a step
       whose table this catalog lacks is left out: the reader could not take it. */
      if (s.kind === 'firstRun') {
        const steps = (s.steps ?? []).flatMap((step) => {
          const view = views[step.view];
          const table = view && 'table' in view && typeof view.table === 'string' ? tableNamed(schema, view.table) : undefined;
          return table ? [{ ...step, table: table.id }] : [];
        });
        return { ...s, steps };
      }
      /* A custom section's reads are rows sections in all but drawing: each is judged as one, and
       keeps what resolving one served (its table id, the query without its own window). */
      if (s.kind === 'custom') {
        const reads = s.reads ?? {},
          names = Object.keys(reads);
        const resolved = resolveSections(
          names.map((name): AppDashSection => {
            const { table, query, show, sort, limit, over } = reads[name];
            return {
              kind: 'rows',
              title: `${s.title ?? s.component?.id ?? 'custom'}, rows "${name}"`,
              table,
              query,
              show,
              sort,
              limit,
              over,
            };
          }),
        );
        /* Its aggregate reads are a metric (one figure) or a breakdown (a `by`) in all but drawing, judged through the
           grammar their number will run in, and keep what resolving one served. */
        const totals = s.aggregates ?? {},
          totalNames = Object.keys(totals);
        const resolvedTotals = resolveSections(
          totalNames.map((name): AppDashSection => {
            const { table, query, measure, by, limit, over } = totals[name];
            return {
              kind: by === undefined ? 'metric' : 'breakdown',
              title: `${s.title ?? s.component?.id ?? 'custom'}, figures "${name}"`,
              table,
              query,
              measure,
              by,
              limit,
              over,
            };
          }),
        );
        return names.length || totalNames.length
          ? {
              ...s,
              ...(names.length
                ? {
                    reads: Object.fromEntries(
                      names.map((name, i) => [
                        name,
                        {
                          ...reads[name],
                          table: resolved[i].table ?? reads[name].table,
                          ...(resolved[i].windowBase === undefined ? {} : { windowBase: resolved[i].windowBase }),
                        },
                      ]),
                    ),
                  }
                : {}),
              ...(totalNames.length
                ? {
                    aggregates: Object.fromEntries(
                      totalNames.map((name, i) => [
                        name,
                        {
                          ...totals[name],
                          table: resolvedTotals[i].table ?? totals[name].table,
                          ...(resolvedTotals[i].windowBase === undefined ? {} : { windowBase: resolvedTotals[i].windowBase }),
                        },
                      ]),
                    ),
                  }
                : {}),
            }
          : s;
      }
      /* The Branding and integrations blocks read the tenant's own settings, never a table. */
      if (s.kind === 'branding' || s.kind === 'integrations') return s;
      const sTable = tableNamed(schema, s.table ?? '');
      if (!sTable) {
        dashError ??= `Section "${s.title ?? s.kind}": no table "${s.table}" on this connection.`;
        return s;
      }
      /* A metric over a clock compares with the period before by default: the change is most of what a figure on a
         dashboard is read for, and an author had to know to write `compare: 'previous period'` to get it. A
         compare written by hand is still the author's. */
      const followsClock = s.kind === 'metric' && Boolean(s.over) && s.compare === undefined;
      if (!dashError && s.spark && !s.over) {
        dashError = `Section "${s.title ?? s.kind}": "spark" needs "over" — the date column the trend is bucketed by.`;
      }
      /* A metric's target may itself stand on a date filter. That condition
       belongs to the room, not the replaceable window: derive periods from
       the refinement alone, then put the standing filter back. */
      /* A window inside a segment (`recent: 'closed_on = last 90 days'`) is the author's window as surely as one
         written inline: the section is served the conditions the segment names, so the reader's window replaces
         it here and the client reads it in the title (dashboardModel.ts authoredWindow), as it would inline. */
      if (s.over && s.query && sTable.segments && withoutWindowPhrase(s.query, s.over) === undefined) {
        const written = expandSegments(s.query, sTable.segments).text;
        if (written !== s.query && withoutWindowPhrase(written, s.over) !== undefined) s = { ...s, query: written };
      }
      const target = s.kind === 'metric' && s.view ? views[s.view] : undefined;
      const standing = target && 'query' in target ? metricCohortQuery(undefined, target.query) : undefined;
      const scoped = (query: string | undefined) => (standing ? metricCohortQuery(standing, query) : query);
      const windowQuery =
        standing && s.query === standing
          ? undefined
          : standing && s.query?.startsWith(`${standing} and `)
            ? s.query.slice(standing.length + 5)
            : s.query;
      /* A query that already windows the `over` column — `close_date =
       last 90 days` — hands the client that query *without* the phrase,
       so the reader's window replaces the author's rather than
       intersecting it: "last 12 months" picked used to mean the ninety
       days both windows share, and the pill did nothing. A compare
       derived from "previous period" is marked so the client can
       re-derive it against the reader's window; a compare written by
       hand is the author's and hides while a window is picked, because
       comparing the reader's window to the author's is not a delta. */
      if (!dashError && s.over) {
        const base = withoutWindowPhrase(windowQuery, s.over);
        if (base !== undefined) s = { ...s, windowBase: scoped(base) ?? '' };
        if (s.kind === 'metric' && (s.compare === PREVIOUS_PERIOD || followsClock)) s = { ...s, comparePeriod: true };
      }
      /* The window is a condition the reader will ask for later: judge
       it now, so a bad column or a phrase the grammar does not speak
       is a startup error and not a dead control. Date-ness is checked
       by declared type — against a text column, `status = last 30
       days` parses happily as an equality with that literal, which is
       exactly the quiet wrong answer this refusal exists to prevent. */
      if (!dashError && s.over) {
        /* A computed date (`renews_on: computed.date('ends_on + term months')`) windows like a stored one: every read
         of the section writes its expression where a condition names it. */
        const computedOver =
          sTable.computed && Object.hasOwn(sTable.computed, s.over) ? computedColumnMeta(s.over, sTable.computed[s.over]) : undefined;
        const overCol = sTable.columns.find((c) => c.name === s.over) ?? computedOver;
        /* The window phrase is the grammar's to judge, against the column as a list reads it. */
        const phrased = computedOver
          ? {
              ...schema,
              tables: schema.tables.map((t) => (t.id === sTable.id ? { ...t, columns: [...t.columns, computedOver] } : t)),
            }
          : schema;
        if (!overCol) {
          dashError = `Section "${s.title ?? s.kind}": "${sTable.name}" has no column "${s.over}" — named in its "over".`;
        } else if (!/date|time/i.test(overCol.type ?? '')) {
          dashError = `Section "${s.title ?? s.kind}": "${s.over}" is ${overCol.type || 'untyped'}, so the time window cannot narrow by it. Pick a date column. See \`mistri docs dates-and-types\`.`;
        } else {
          /* The section's own windows are judged like the dashboard's; the dashboard's still are,
           though they pass it over, so a phrase is refused the same wherever it is written. */
          for (const w of [...windows, ...(s.windows ?? [])]) {
            const parsed = parseQuery(`${sTable.id} ${s.over} = ${w}`, {
              schema: phrased,
            });
            if (parsed.errors.length) {
              dashError = `Section "${s.title ?? s.kind}" over "${s.over}": ${parsed.errors[0].message}`;
              break;
            }
          }
        }
      }
      if (!dashError && s.kind === 'board' && !sTable.columns.some((c) => c.name === s.by)) {
        dashError = `Section "${s.title ?? s.kind}": "${sTable.name}" has no column "${s.by}" — a board's lanes come from one of its own columns.`;
      }
      if (!dashError && s.kind === 'board' && s.lanes) {
        const allowed = sTable.columns.find((column) => column.name === s.by)?.allowed;
        const unknown = allowed && s.lanes.filter((lane) => !allowed.includes(lane));
        if (unknown?.length) {
          dashError = `Section "${s.title ?? s.kind}": "${sTable.name}.${s.by}" has unknown lane values ${unknown.map((lane) => JSON.stringify(lane)).join(', ')}. Use values from its declared vocabulary.`;
        }
      }
      if (!dashError) {
        if (s.kind !== 'rows' && s.kind !== 'board') {
          /* A chart is a breakdown drawn differently; both are judged in
           the grammar the numbers will run in, a metric in its
           one-group form. */
          /* A scatter's `x` is a second measure, judged in the same line as the one it is asked in (dashboardAsks.ts). */
          const measured = `${s.x ? `${s.x}, ` : ''}${s.measure ?? 'count'}`;
          /* `auto` is decided in the browser, before the read (autoBucket.ts): judged here as the finest unit it can
             become, so its column is held to the same rule `day x` is — and a text column is refused in the words
             a window on one is. */
          const autoKey = s.kind === 'chart' ? autoKeyOf(s.by) : null;
          if (autoKey && !autoKey.column.includes('.')) {
            const column =
              sTable.columns.find((c) => c.name === autoKey.column) ??
              (sTable.computed && Object.hasOwn(sTable.computed, autoKey.column)
                ? computedColumnMeta(autoKey.column, sTable.computed[autoKey.column])
                : undefined);
            if (column && !/date|time/i.test(column.type ?? '')) {
              dashError = `Section "${s.title ?? s.kind}": "auto ${autoKey.column}" cuts a date into periods and "${autoKey.column}" is ${column.type || 'untyped'}, so it cannot be cut by time [not-a-date]. Pick a date column. See \`mistri docs dates-and-types\`.`;
            }
          }
          const text = [
            sTable.id,
            s.query,
            s.kind === 'metric' ? (s.measure ?? 'count') : `${measured} by ${s.by && autoKey ? withUnit(s.by, 'day') : s.by}`,
          ]
            .filter(Boolean)
            .join(' ');
          /* A funnel is judged a stage at a time, in the line it will ask (funnel.ts), so a refusal names the stage. */
          const chains = s.kind === 'funnel' ? funnelChains(s.stages ?? []) : [];
          for (const [index, chain] of chains.entries()) {
            const stage = textToBreakdown(
              schema,
              funnelText({ table: sTable.id, query: s.query, stages: [{ label: '', query: chain }] }) ?? '',
              me,
            );
            if (stage.errors?.length && !dashError)
              dashError = `Section "${s.title ?? s.kind}", stage "${s.stages?.[index]?.label}": ${stage.errors[0].message}`;
          }
          const parsed = s.kind === 'funnel' ? { errors: [], breakdown: undefined } : textToBreakdown(schema, text, me);
          if (!dashError && parsed.errors?.length) dashError = `Section "${s.title ?? s.kind}": ${parsed.errors[0].message}`;
          if (!dashError && s.kind === 'matrix' && (parsed.breakdown?.by?.length ?? 0) !== 2) {
            dashError = `Section "${s.title ?? s.kind}": a matrix crosses exactly two keys; "${s.by}" has ${parsed.breakdown?.by?.length ?? 0}.`;
          }
          if (!dashError && (s.compare === PREVIOUS_PERIOD || followsClock)) {
            const prev = previousPeriodQuery(windowQuery);
            /* A metric with no window of its own, over a date column, follows
             the reader's: the compare is derived against whatever window is
             picked (dashboardModel.ts, windowed), and there is no change to
             show until one is. */
            if ('error' in prev && s.over && !hasWindowPhrase(windowQuery)) {
              s = { ...s, compare: undefined, comparePeriod: true };
            } else if ('error' in prev) {
              /* A compare the author did not ask for never refuses: two windows of its own mean the change is
                 theirs to write, and the figure stands without one. */
              if (!followsClock) dashError = `Section "${s.title ?? s.kind}": ${prev.error}`;
            } else s = { ...s, compare: scoped(prev.query) };
          }
          if (!dashError && s.compare) {
            const cmp = textToBreakdown(schema, [sTable.id, s.compare, s.measure ?? 'count'].filter(Boolean).join(' '), me);
            if (cmp.errors?.length) dashError = `Section "${s.title ?? s.kind}" compare: ${cmp.errors[0].message}`;
          }
          /* A goal read from data is a second metric: judged in the same grammar, its table resolved to an id. */
          if (!dashError && s.target !== undefined && typeof s.target === 'object') {
            const goalTable = tableNamed(schema, s.target.table);
            if (!goalTable) dashError = `Section "${s.title ?? s.kind}" target: no table "${s.target.table}" on this connection.`;
            else {
              /* A breakdown's goal is grouped by its own `by`, a row per group, and windowed by its own `over` (G76). */
              const { by, over: overName } = s.target;
              const goal = textToBreakdown(
                schema,
                [goalTable.id, s.target.query, by ? `${s.target.measure} by ${by}` : s.target.measure].filter(Boolean).join(' '),
                me,
              );
              const over = overName ? goalTable.columns.find((column) => column.name === overName) : undefined;
              if (goal.errors?.length) dashError = `Section "${s.title ?? s.kind}" target: ${goal.errors[0].message}`;
              else if (!by && goal.breakdown?.by.length)
                dashError = `Section "${s.title ?? s.kind}" target: a goal is one number, so its measure takes no "by".`;
              else if (by && (goal.breakdown?.by.length ?? 0) !== 1)
                dashError = `Section "${s.title ?? s.kind}" target: a goal per group is grouped by one column, "${by}".`;
              else if (overName && !over)
                dashError = `Section "${s.title ?? s.kind}" target: "${goalTable.name}" has no column "${overName}" — named in its "over".`;
              else if (over && !/date|time/i.test(over.type ?? ''))
                dashError = `Section "${s.title ?? s.kind}" target: "${overName}" is ${over.type || 'untyped'}, so the time window cannot narrow by it.`;
              else {
                const resolved = { ...s.target, table: goalTable.id };
                const whole = s.kind === 'metric' ? wholeTarget(s, sTable, resolved) : undefined;
                s = whole ? { ...s, target: whole, targetWhole: true } : { ...s, target: resolved };
              }
            }
          }
        } else {
          /* The query and sort through the view parser the rows run in —
           paths and column comparisons are the runtime's to walk; the
           shows through the path resolver. */
          const q = [s.query, s.sort ? `sort ${s.sort}` : ''].filter(Boolean).join(' ');
          const parsed = parseViewQuery(schema, sTable.id, q, undefined, me);
          if (parsed.errors.length) dashError = `Section "${s.title ?? s.kind}": ${saidAt(parsed.errors[0], q.trim())}`;
          for (const col of s.show ?? []) {
            if (dashError) break;
            try {
              resolvePath(schema, sTable.id, col);
            } catch (err) {
              dashError = `Section "${s.title ?? s.kind}": "${col}" (${(err as Error).message})`;
            }
          }
        }
      }
      return { ...s, table: sTable.id };
    });
  const sections = resolveSections(entry.sections);
  const aside = entry.aside === undefined ? undefined : resolveSections(entry.aside);
  if (dashError) {
    problems.push(dashError);
    dashError = undefined;
  }
  /* A pick-filter that reaches no section is a typo wearing a control:
     each named column must exist (or be a whole single-column
     reference) on at least one section's table. */
  if (!dashError) {
    for (const f of entry.filters ?? []) {
      const reaches = [...entry.sections, ...(entry.aside ?? [])].some((s) => {
        const tables =
          s.kind === 'custom'
            ? [...Object.values(s.reads ?? {}), ...Object.values(s.aggregates ?? {})].map((read) => read.table)
            : s.kind === 'note' || s.kind === 'firstRun' || !s.table
              ? []
              : [s.table];
        return tables.some((name) => Boolean(tableNamed(schema, name)?.columns.some((c) => c.name === f)));
      });
      if (!reaches) {
        dashError = `Filter "${f}": no section's table has that column.`;
        break;
      }
    }
  }
  return {
    label: entry.label,
    // Plain heading copy is authored with the dashboard and needs the same
    // resolved payload as its label; this object deliberately rebuilds fields.
    ...(entry.heading ? { heading: entry.heading } : {}),
    ...(entry.headingHidden ? { headingHidden: true as const } : {}),
    ...(entry.description ? { description: entry.description } : {}),
    // The menu's mark, served like the label: the menus draw both.
    ...(entry.icon ? { icon: entry.icon } : {}),
    /* Parsed on a dashboard like on a list (appViews.ts), and dropped here
       until now: this object is rebuilt key by key, so a star is served only
       if it is named. */
    ...(entry.favorite ? { favorite: true as const } : {}),
    sections,
    ...(aside === undefined ? {} : { aside }),
    // Served as authored: the template is in the payload so the grid's tracks are fixed at the first paint.
    ...(entry.areas ? { areas: entry.areas } : {}),
    /* The dashboard's window is offered where a section follows it: one with its own windows picks
       its period in its own heading and passes the dashboard's over. */
    ...([...entry.sections, ...(entry.aside ?? [])].some(
      (s) =>
        (s.over && !s.windows) ||
        Object.values(s.reads ?? {}).some((read) => read.over) ||
        Object.values(s.aggregates ?? {}).some((total) => total.over),
    )
      ? {
          windows,
          ...(entry.window ? { window: entry.window } : {}),
          ...(entry.windowControl === 'button' ? { windowControl: 'button' as const } : {}),
        }
      : {}),
    ...(entry.filters?.length ? { filters: entry.filters } : {}),
    /* A page's reads gate it as a section's table gates a dashboard: this
       catalog is the reader's, so a resource they cannot read is missing
       from it, and the page is theirs to open only when every one is here. */
    ...(entry.page
      ? {
          page: {
            ...entry.page,
            reads: entry.page.reads.map((name) => {
              const table = tableNamed(schema, name);
              if (!table) problems.push(`The page reads "${name}", which this connection does not have or this reader cannot read.`);
              return table?.id ?? name;
            }),
          },
        }
      : {}),
    ...(() => {
      if (dashError) problems.push(dashError);
      if (!problems.length) return {};
      /* One sentence for the screen, every one for the problems list. */
      const error = problems.length === 1 ? problems[0] : `${problems[0]} (and ${problems.length - 1} more)`;
      return { error, errors: problems };
    })(),
  };
}

/**
 * Depth, not just existence: a view naming a real table but a wrong column
 * or an unparseable tab query used to load clean and fail one refused
 * request at a time — the opposite of the "errors name the fix at startup"
 * story an agent-authored app depends on. Judged here, by the real parser,
 * with the view carrying its reason like a missing table always has.
 */
/**
 * A board, a queue or a calendar with no `primary` of its own, titled by its
 * record's name as this catalog names it: the resource's recordLabel column or
 * path, a template's first column, else the column the catalog names rows by.
 * A board's card reads its own row, so a path there falls back to a column.
 */
function titledPresentation(
  presentation: AppListPresentation,
  table: TableMeta,
  schema: DatabaseSchema,
  recordLabel?: string | false,
): AppListPresentation {
  if (presentation.kind !== 'board' && presentation.kind !== 'queue' && presentation.kind !== 'calendar') return presentation;
  if (presentation.primary !== LABEL_SEGMENT) return presentation;
  let named: string | undefined = labelPath(schema, table, recordLabel);
  if (named === LABEL_SEGMENT || named === undefined) {
    const template = typeof recordLabel === 'string' && isLabelTemplate(recordLabel) ? parseLabelTemplate(recordLabel) : undefined;
    named = template && 'paths' in template ? template.paths[0] : undefined;
  }
  if (named === undefined || (presentation.kind === 'board' && named.includes('.'))) named = labelColumn(table) ?? primaryKey(table)[0];
  return named === undefined ? presentation : { ...presentation, primary: named };
}

/**
 * Why a list's filter across its related tables does not read here, or
 * undefined: a path up a reference must end on a stored column of the record
 * it reaches, in this source; a `has` filter must find its rows by the one
 * reference they point at the record through (or the `via` it names), and ask
 * a value of theirs a checklist can list — a vocabulary, a reference, text
 * or a number — or be one of their segments.
 */
function crossFilterProblem(schema: DatabaseSchema, table: TableMeta, name: string, person?: QueryPerson): string | undefined {
  const me = person ? { me: person } : {};
  const has = hasFilterOf(name);
  if (!has) {
    const { resolved, error } = tryResolvePath(schema, table.id, name);
    if (error || !resolved) return error?.message ?? `"${name}" is not a path from ${table.name}.`;
    if (resolved.rollup || resolved.computed || resolved.tags || resolved.jsonKey)
      return `"${name}" is not a stored column of ${resolved.table.name}; a filter across a reference reads one.`;
    const hop = stitchedHop(schema, table.id, name);
    return hop ? stitchedFarProblem(hop, name, 'filter') : undefined;
  }
  const asColumn = parseViewQuery(schema, table.id, `${name} is not empty`, undefined, me);
  if (!asColumn.errors.length) {
    const rows = asColumn.filter.groups[0]?.[0]?.any;
    const child = rows && findTable(schema, rows.via.slice(0, rows.via.lastIndexOf('.')));
    const column = child && tryResolvePath(schema, child.id, has.asks).resolved?.column;
    if (
      column &&
      !(column.allowed?.length || column.references) &&
      (isFlagColumn(column) || !['text', 'number'].includes(columnKind(column.type)))
    )
      return (
        `"${has.asks}" of ${child.name} is ${isFlagColumn(column) ? 'a yes-or-no' : columnKind(column.type)}, which a checklist of values does not list: ` +
        `name it in a segment of ${child.name} and filter by { has: '${has.child}', segment: … }.`
      );
    return undefined;
  }
  if (!has.asks.includes('.') && !parseViewQuery(schema, table.id, name, undefined, me).errors.length) return undefined;
  const first = asColumn.errors[0];
  const child = findTable(schema, has.child) ?? schema.tables.find((t) => t.name === has.child);
  if (child && !has.asks.includes('.') && !child.columns.some((c) => c.name === has.asks) && first.message.includes(`"${has.asks}"`))
    return `${child.name} has no column or segment "${has.asks}".`;
  return first.message;
}

/**
 * Every list filter across a related table that does not read, against the
 * whole catalog (segments served): one problem each, naming the view and the
 * filter. A reader's own catalog leaves such a filter off (resolveListView).
 */
export function listFilterProblems(app: AppDef, schema: DatabaseSchema): string[] {
  const person = checkedPerson(app, schema);
  const problems: string[] = [];
  for (const [key, view] of Object.entries(app.views ?? {})) {
    if (isFormView(view) || 'sections' in view || !view.filters?.length) continue;
    const table = tableNamed(schema, view.table);
    if (!table) continue;
    for (const name of view.filters) {
      if (!name.includes('.') && !hasFilterOf(name)) continue;
      const problem = crossFilterProblem(schema, table, name, person);
      if (problem) problems.push(`view "${key}": This view's filter "${name}": ${problem}`);
    }
  }
  return problems;
}

function resolveListView(
  view: AppListView,
  schema: DatabaseSchema,
  files?: ReadonlySet<string>,
  noun?: AppNoun,
  person?: QueryPerson,
  recordLabel?: string | false,
  icons?: (column: string) => boolean,
): ResolvedListView {
  const me = person ? { me: person } : {};
  const table = tableNamed(schema, view.table);
  let error: string | undefined;
  if (!table) {
    error = `This connection has no table "${view.table}" — or more than one, and the name needs qualifying.`;
  } else {
    if (view.presentation) view = { ...view, presentation: titledPresentation(view.presentation, table, schema, recordLabel) };
    /* A show entry may be a dotted label path — "account_id.name" puts
       the record's name where its id would sit — judged by the same path
       resolver every dotted column goes through. */
    const badPaths: string[] = [];
    for (const path of view.show ?? []) {
      try {
        resolvePath(schema, table.id, path);
      } catch (err) {
        badPaths.push(`"${path}" (${(err as Error).message})`);
      }
    }
    // A record's tags filter too (tagLists.ts): a checklist of its tags. And a rollup or a computed column, as it
    // reads in a condition: a customer's lifetime spend is a Min/Max like any number (`spent >= 500`).
    /* A filter across a reference, or over the rows that point at the record (listFilters.ts), is the reader's
       where this catalog reads every table and column it walks, and is left off where it does not: a facet
       is no way into a table a reader is not granted. Its author's mistakes are named at load
       (listFilterProblems), against the whole catalog. */
    const crossing = (name: string) => name.includes('.') || hasFilterOf(name) !== undefined;
    const missing = (view.filters ?? []).filter(
      (name) => !crossing(name) && !columnOrRollup(table, name) && !(name === TAGS_COLUMN && table.tags),
    );
    if (view.filters?.some(crossing))
      view = { ...view, filters: view.filters.filter((name) => !crossing(name) || !crossFilterProblem(schema, table, name, person)) };
    /* A total is a sum, so it names a numeric column of the resource itself — stored, or computed: the footer asks
       `sum <name>` as a dashboard measure does, and a measure writes a computed number's expression where it is named. */
    /* A suggestion reads `<column> contains "<typed>"` and fills a box that searches with `contains`: text, both. */
    const textColumn = (name: string) => {
      const column = table.columns.find((c) => c.name === name);
      return column !== undefined && columnKind(column.type) === 'text';
    };
    const suggestError = Object.entries(view.suggest ?? {})
      .flatMap(([filter, columns]) =>
        [filter, ...columns]
          .filter((name) => !textColumn(name))
          .map(
            (name) =>
              `This view's suggest: "${name}"${name === filter ? '' : ` (suggested for "${filter}")`} must be a text column of "${table.name}"; a suggestion is a value typed into a search.`,
          ),
      )
      .at(0);
    const badTotals = (view.totals ?? []).filter((name) => {
      const column = table.columns.find((c) => c.name === name);
      if (column) return columnKind(column.type) !== 'number';
      // A numeric rollup sums as a column does: the footer asks `sum <name>`, and a measure reads a rollup by name.
      if (table.rollups && Object.hasOwn(table.rollups, name)) return columnKind(table.rollups[name].type) !== 'number';
      return !(table.computed && Object.hasOwn(table.computed, name) && table.computed[name].type === 'number');
    });
    const listError = view.presentation && listProblem(view.presentation, table, schema, files, icons);
    /* A hand order is kept in a number of the resource's own — never its key, which names the row while its place changes. */
    const orderColumn = view.order === undefined ? undefined : table.columns.find((c) => c.name === view.order);
    const orderError =
      view.order === undefined
        ? undefined
        : !orderColumn
          ? `This view's order: "${view.order}" must be a local readable column of "${table.name}".`
          : columnKind(orderColumn.type) !== 'number'
            ? `This view's order: "${view.order}" is ${orderColumn.type || 'untyped'}; a row's place in the list is a number.`
            : orderColumn.primaryKey
              ? "This view's order must not be a primary key column: the key names a row, and its place changes."
              : undefined;
    /* A cell edited in place is one of the table's own values: a label path
       is another record's, the key names the row, and a document or bytes
       have no one-line editor. */
    const editableError = Array.isArray(view.editable)
      ? view.editable
          .map((name) => {
            const column = table.columns.find((c) => c.name === name);
            if (!column) return `This view's editable: "${name}" is not a column of "${table.name}".`;
            if (column.primaryKey)
              return `This view's editable names "${name}", the primary key: the key names the row, so it is never edited in place.`;
            if (/json/i.test(column.type) || isBinaryType(column.type))
              return `This view's editable names "${name}", a ${column.type} column, which has no editor in a cell. Leave it out of "editable".`;
            return undefined;
          })
          .find(Boolean)
      : undefined;
    const opensColumn = view.opens === undefined ? undefined : table.columns.find((c) => c.name === view.opens);
    const opensError =
      view.opens === undefined || opensColumn?.references
        ? undefined
        : `This view's opens: "${view.opens}" must be a reference column of "${table.name}"; a row opens the record it names.`;
    if (badPaths.length) {
      error = `This view's show cannot be resolved on "${table.name}": ${badPaths.join(', ')}.`;
    } else if (missing.length) {
      error = `"${table.name}" has no column ${missing.map((m) => `"${m}"`).join(', ')} — named in this view's filters.`;
    } else if (badTotals.length) {
      error = `This view's totals name ${badTotals.map((m) => `"${m}"`).join(', ')}, which "${table.name}" has no numeric column called.`;
    } else if (suggestError) {
      error = suggestError;
    } else if (listError) {
      error = listError;
    } else if (orderError) {
      error = orderError;
    } else if (editableError) {
      error = editableError;
    } else if (opensError) {
      error = opensError;
    } else {
      /* A module's standing conditions, judged composed with each tab —
         the exact texts the client will run — so "query and tab" is
         refused at startup, never one dead tab at a time. */
      /* Read by the view parser, as the list will be: a list reads through
         the query bar's route, which walks a reference path on either side
         of a comparison, and a tab like `on_hand < product_id.reorder_level`
         is refused here by name or runs as written — never compares with the
         text of the path. */
      if (view.query) {
        const parsed = parseViewQuery(schema, table.id, view.query, undefined, me);
        const far = parsed.errors.length ? undefined : stitchedListProblem(schema, table.id, parsed);
        if (parsed.errors.length) error = `This view's query: ${saidAt(parsed.errors[0], view.query.trim())}`;
        else if (far) error = `This view's query: ${far}`;
      }
      /* Each named order, or the view's one, by the real parser against the
         real table: a sort naming a column the table lacks is refused at
         startup, not when a reader picks it. The first named order is the
         view's own, so it is judged once, by its name. */
      for (const choice of view.sorts ?? (view.sort ? [{ label: view.sort, sort: view.sort }] : [])) {
        if (error) continue;
        // The view parser, as the list reads it: a sort may name a rollup.
        const parsed = parseViewQuery(schema, table.id, `sort ${choice.sort}`);
        const far = parsed.errors.length ? undefined : stitchedListProblem(schema, table.id, parsed);
        if (parsed.errors.length || far) error = `This view's sort "${choice.label}": ${far ?? parsed.errors[0].message}`;
      }
      for (const tab of view.tabs ?? []) {
        if (error || !tab.query) continue;
        /* Composed by the same helper the client runs, so what is judged
           here is the text that will run — `a or b` narrowed by a tab is
           `(a or b) and c`, not `a or (b and c)`. */
        const text = andQuery(view.query, tab.query);
        const parsed = parseViewQuery(schema, table.id, text, undefined, me);
        const far = parsed.errors.length ? undefined : stitchedListProblem(schema, table.id, parsed);
        if (parsed.errors.length || far) {
          error = `Tab "${tab.label}": ${far ?? saidAt(parsed.errors[0], text.trim())}`;
          break;
        }
      }
    }
  }
  const { label, ...rest } = view;
  return {
    ...rest,
    // A card with no title of its own says its record's name, read where this catalog reads it.
    ...(table && rest.presentation?.kind === 'cards'
      ? {
          presentation: cardsTitled(rest.presentation, table, schema, recordLabel),
        }
      : {}),
    /* A calendar's spans are read by their tables' ids, as the list's own rows are. */
    ...(rest.presentation?.kind === 'calendar' && rest.presentation.backdrop
      ? {
          presentation: {
            ...rest.presentation,
            backdrop: rest.presentation.backdrop.map((span) => ({
              ...span,
              from: tableNamed(schema, span.from)?.id ?? span.from,
            })),
          },
        }
      : {}),
    table: table?.id ?? view.table,
    label: label ?? (noun ? headingOf(noun.many) : table ? humanName(table.name) : view.table),
    ...(error ? { error } : {}),
  };
}

/** What a resource says about its rows, as one connection serves it: what the shared client draws
    (servedApp.ts ServedResource), and its CSV import. */
export interface ResolvedResource extends ServedResource {
  /** Its rows may be imported from a CSV file (appImport.ts). */
  import?: import('./appImportDeclaration.js').AppImportDef;
}

/** The served machine: a state says the words the column's display gives it, else its own. */
function servedMachine(machine: import('./appMachine.js').AppMachineDef, rule: AppDisplayRule | undefined): ServedMachine {
  const words =
    rule && typeof rule === 'object' && 'values' in rule && rule.values && typeof rule.values === 'object'
      ? (rule.values as Record<string, string>)
      : {};
  return {
    column: machine.column,
    states: machine.states.map((state) => ({
      value: state.name,
      label: typeof words[state.name] === 'string' ? words[state.name] : state.label,
      ...(state.final ? { final: true as const } : {}),
    })),
    path: machinePath(machine),
    ...(machine.groups ? { groups: machine.groups } : {}),
  };
}

/* Where the bytes are kept is the server's business: a page reads a file
   through the file route whatever its storage, and a bucket's address is
   not sent to every browser that draws an attachment. */
function browserFile(file: AppFileDef): AppFileDef {
  // Where the bytes are is the server's business: the browser asks /api/file, never the bucket.
  const { storage: _storage, bucket: _bucket, object: _object, hash: _hash, ...shown } = file;
  return shown;
}

/**
 * The resources against one connection's schema, keyed by resolved table
 * id — the key every client lookup runs on. A resource this connection does
 * not have is left out: an App without role grants may serve several
 * connections. Its actions and New form are judged here, once, whichever
 * view shows the resource: a resource whose actions or form cannot run on
 * this catalog serves neither, and says why in `problems`, rather than
 * offering a button that fails when pressed. A resource serves only what it
 * says: no actions when this principal may run none — read-only metadata
 * carries no write presentation at all — and nothing for a resource with
 * nothing to say.
 */
export function resolveResources(app: AppDef, schema: DatabaseSchema): { resources: Record<string, ResolvedResource>; problems: string[] } {
  const files = appFileRules(app, schema).rules;
  const tagRules = appTagRules(app, schema).rules;
  const resources: Record<string, ResolvedResource> = {};
  const problems: string[] = [];
  const display = resolveDisplay(app, schema).display;
  const seen = new Set<string>();
  const person = checkedPerson(app, schema);
  const people = personTable(app, schema);
  const personProblem = people.problem;
  if (personProblem) problems.push(personProblem);
  /* Who a form's `me` default can be: nobody without sign-in, else a row of auth.me's table or an email. */
  const formPerson = app.auth ? { ...(people.table ? { table: people.table.id } : {}) } : null;
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const table = tableNamed(schema, name);
    if (!table || seen.has(table.id)) continue;
    seen.add(table.id);
    const has = (column: string) => table.columns.some((c) => c.name === column);
    let problem: string | undefined;
    for (const action of resource.actions ?? []) {
      if (action.command) {
        const reference = commandReferenceProblem(action.command, table.id, schema);
        if (reference) {
          problem = `action "${action.id}": ${reference}`;
          break;
        }
      }
      const unknown = Object.keys(action.set ?? {}).filter((c) => !has(c));
      if (unknown.length) {
        problem = `action "${action.id}": "${table.name}" has no column ${unknown.map((c) => `"${c}"`).join(', ')}.`;
        break;
      }
      if (!action.command) {
        problem = actionStamps(action, table, schema, people.table?.id).problem;
        if (problem) break;
      }
      if (action.reason && !has(action.reason)) {
        problem = `action "${action.id}": "${table.name}" has no column "${action.reason}" for its reason.`;
        break;
      }
      /* Read as a tab's query is, where a rollup and a computed column are names like a column's: the browser asks
         an action's `when` as a list asks its tab, and a command judges its own (commandWhen.ts). */
      if (action.when) {
        const parsed = parseViewQuery(schema, table.id, action.when, undefined, person ? { me: person } : {});
        if (parsed.errors.length) {
          problem = `action "${action.id}", when: ${saidAt(parsed.errors[0], action.when)}`;
          break;
        }
        if (!action.command) problem = derivedWhenProblem(action, table, resource.segments);
        if (problem) break;
      }
    }
    problem ??=
      resource.form &&
      (validateAppForm(resource.form, table, resource.fields?.read, {
        schema,
        derivedFrom: storedComputed(app, schema),
        person: formPerson,
      })[0] ??
        derivedComputedProblem(app, resource.form, table, schema));
    if (problem) problems.push(`resources "${name}"${problem.startsWith('action "') ? ', ' : ': '}${problem}`);
    /* Judged apart from actions and forms: a search this catalog cannot run
       is left out and said, and the rest of the resource still serves. */
    const searchProblem = resource.search && appSearchProblem(resource.search, table, schema.tables);
    if (searchProblem) problems.push(`resources "${name}": ${searchProblem}`);
    const importIssue = resource.import && importProblem(resource.import, table, schema);
    if (importIssue) problems.push(`resources "${name}": ${importIssue}`);
    const textIssue = resource.text && textRulesProblem(resource.text, table.columns, table.name);
    if (textIssue) problems.push(`resources "${name}": ${textIssue}`);
    /* Fields defined by rows (definedFields.ts): a binding this catalog cannot run is said and left out; the rest serve. */
    const defined = servedDefined(resource.defined, table, (from) =>
      Object.hasOwn(app.resources ?? {}, from) ? tableNamed(schema, from) : undefined,
    );
    for (const issue of defined.problems) problems.push(`resources "${name}": ${issue}`);
    /* Flows whose steps are rows (appFlows.ts): a binding this catalog cannot run is said; the resource still serves. */
    const declared = (id: string) => (Object.hasOwn(app.resources ?? {}, id) ? tableNamed(schema, id) : undefined);
    const flowsIssue =
      resource.flows &&
      flowsProblem(resource.flows, table, declared(resource.flows.from), declared(resource.flows.steps), resource.machine?.column);
    if (flowsIssue) problems.push(`resources "${name}": ${flowsIssue}`);
    /* A declared date is the App's catalog speaking for SQLite (declaredDates.ts);
       this catalog has already read it, so a column it left alone says why. */
    for (const [column, kind] of Object.entries(resource.types ?? {})) {
      const meta = table.columns.find((c) => c.name === column);
      if (!meta) problems.push(`resources "${name}": types "${column}": "${table.name}" has no column "${column}".`);
      else if (schema.dialect !== 'sqlite') {
        problems.push(
          `resources "${name}": types "${column}": a TEXT column is declared a ${kind} on SQLite only; on ${schema.dialect} its type says it, so give the column a date type or read it through a view that casts it. See \`mistri docs dates-and-types\`.`,
        );
      } else if (!meta.type.endsWith(` as ${kind}`)) {
        problems.push(
          `resources "${name}": types "${column}" is ${meta.type || 'untyped'}; only a TEXT column is declared a ${kind}. See \`mistri docs dates-and-types\`.`,
        );
      }
    }
    const labels = Object.entries(resource.labels ?? {}).filter(([path]) => {
      try {
        resolvePath(schema, table.id, path);
        return true;
      } catch {
        return false;
      }
    });
    let recordLabel: string | false | undefined;
    if (resource.recordLabel === false) {
      // Field and realm projection deliberately retain only the sentinel: a
      // restricted payload must never repeat the unavailable authored path.
      recordLabel = false;
    } else if (isLabelTemplate(resource.recordLabel)) {
      const problem = labelTemplateProblem(schema, table, resource.recordLabel);
      if (problem) problems.push(`resources "${name}": recordLabel "${resource.recordLabel}": ${problem}`);
      else recordLabel = resource.recordLabel;
    } else if (resource.recordLabel !== undefined) {
      try {
        resolvePath(schema, table.id, resource.recordLabel);
        if (stitchedHop(schema, table.id, resource.recordLabel)) throw new Error(stitchedLabelProblem(resource.recordLabel));
        recordLabel = resource.recordLabel;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        problems.push(`resources "${name}": recordLabel "${resource.recordLabel}": ${message}`);
      }
    }
    const rules = Object.entries(display)
      .filter(([key]) => key.startsWith(`${table.id}.`))
      .map(([key, rule]) => [key.slice(table.id.length + 1), rule] as const);
    const served: ResolvedResource = {
      ...(labels.length ? { labels: Object.fromEntries(labels) } : {}),
      ...(recordLabel === undefined ? {} : { recordLabel }),
      ...(rules.length ? { display: Object.fromEntries(rules) } : {}),
      /* A column's own input component, for the columns this catalog has (appComponents.ts). */
      ...(() => {
        const inputs = Object.entries(resource.inputs ?? {}).filter(([column]) => has(column));
        return inputs.length ? { inputs: Object.fromEntries(inputs) } : {};
      })(),
      ...(!problem && resource.actions?.length ? { actions: resource.actions } : {}),
      ...(!problem && resource.form ? { form: resource.form } : {}),
      /* Its text rules, for the columns this catalog has: the form says them as someone types (textRules.ts). */
      ...(() => {
        const text = Object.entries(resource.text ?? {}).filter(([column]) => has(column));
        return text.length && !textIssue ? { text: Object.fromEntries(text) } : {};
      })(),
      ...(Object.keys(defined.served).length ? { defined: defined.served } : {}),
      ...(resource.machine && has(resource.machine.column)
        ? {
            machine: servedMachine(resource.machine, resource.display?.[resource.machine.column]),
          }
        : {}),
      ...(resource.page === undefined ? {} : { page: resource.page }),
      ...(resource.view === undefined ? {} : { view: resource.view }),
      ...(resource.address === undefined ? {} : { address: resource.address }),
      ...(resource.slug ? { slug: true as const } : {}),
      ...(resource.file && files.has(table.id) ? { file: browserFile(resource.file) } : {}),
      ...(tagRules.has(table.id) ? { tags: tagRules.get(table.id) } : {}),
      ...(resource.favorite ? { favorite: true as const } : {}),
      ...(resource.noun ? { noun: resource.noun } : {}),
      ...(resource.settings ? { settings: resource.settings } : {}),
      ...(resource.import && !importIssue ? { import: resource.import } : {}),
    };
    if (Object.keys(served).length) resources[table.id] = served;
  }
  /* A flow's page may draw its steps, and a record's page its run: both tables are told the steps table the binding
     names, where the binding runs, and whether each of its App kinds waits for a word (an approval) or only runs. */
  const declared = (id: string) => (Object.hasOwn(app.resources ?? {}, id) ? tableNamed(schema, id) : undefined);
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const table = tableNamed(schema, name);
    const from = resource.flows && declared(resource.flows.from),
      steps = resource.flows && declared(resource.flows.steps);
    if (!table || !from || !steps || flowsProblem(resource.flows!, table, from, steps, resource.machine?.column)) continue;
    const kinds = Object.entries(resource.flows!.kinds ?? {});
    const diagram: ServedFlowDiagram = {
      steps: steps.id,
      ...(kinds.length
        ? {
            kinds: Object.fromEntries(kinds.map(([kind, def]) => [kind, def.waitFor ? 'asks' : 'runs'])),
          }
        : {}),
    };
    resources[from.id] = { ...resources[from.id], flowDiagram: diagram };
    resources[table.id] = {
      ...resources[table.id],
      flowDiagram: { ...diagram, run: true },
    };
  }
  /* A list's own import is judged over the same catalog, and said as the view's. */
  for (const [key, view] of Object.entries(app.views)) {
    if (!('table' in view) || isFormView(view) || !view.import) continue;
    const table = tableNamed(schema, view.table);
    const issue = table && importProblem(view.import, table, schema);
    if (issue) problems.push(`view "${key}": ${issue}`);
  }
  return { resources, problems };
}
