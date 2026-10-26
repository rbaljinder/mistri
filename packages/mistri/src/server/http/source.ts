/**
 * Which database answers: one browser connection or one App entry point,
 * resolved for the request in hand. App resources select their
 * server-configured source without changing the registry's active DB.
 * Every reply that comes from it is stamped with where it came from.
 */
import { learnValueLabels } from '../app/valueLabels.js';
import type { Adapter, QueryRequest, QueryResult, InsertRequest, UpdateRequest } from '@mistriwork/engine/adapters/adapter.js';
import { validatePage, type PageDef } from '@mistriwork/engine/shared/page.js';
import {
  appActionGrants,
  appDeletable,
  grantsByRole,
  resolveAppAccess,
  withLabelTemplates,
  withRollups,
  type AppDef,
} from '../../shared/app.js';
import { localizedApp, type AppHost } from '../app/apps.js';
import { loadAppRuntimeResources, type RuntimeResources } from '../app/appRuntimeResources.js';
import { readZone } from '../app/readerZone.js';
import { readLocale, requestLocale } from '../app/readerLocale.js';
import { readTenantMessages } from '../app/recordMessages.js';
import { brandingTenant } from './brandingTenant.js';
import { AppAccessDenied, authorizeResources, markStableGrant, type ResourceAccess } from '../app/appAccess.js';
import { compileAppDefinitionValidation } from '../app/appValidation.js';
import { compileAppTransitions } from '../app/appTransitions.js';
import { compileAppStamps, signedInAs, stampInsert, stampUpdate, type StampMoment } from '../app/appStamps.js';
import { lookupPerson, personKey, unprovenPerson } from '../app/appMe.js';
import { ensurePersonRow, personRowSeen } from '../app/appPersonRows.js';
import { clockNow } from '@mistriwork/engine/server/http/clock.js';
import { httpPolicyReads } from '../policy/appPolicyHttp.js';
import { readablePage } from '../app/appFieldProjection.js';
import { appEntrypoint } from '../app/appEntrypoint.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { HttpError } from '@mistriwork/engine/server/http/reply.js';
import type { RequestContext, ResolvedSource } from '@mistriwork/engine/server/http/context.js';
import { consoleSourceOwners } from './appContext.js';
import { resolveConnectionSource } from '@mistriwork/engine/server/http/connectionSource.js';
import { pagesForRoles, sessionRoles } from '../../shared/appViewRoles.js';
import { appZone } from '../../shared/appZone.js';

/* A page judged against what a role is served, kept per page, per App catalog
   (stable while the App is loaded: appRuntimeResources.ts keeps it) and per
   role set. What a reader's catalog is made of besides those — `now`, `me` —
   moves values, never which tables, columns and rollups exist, which is all
   validation reads. Checking every page on every request was a fifth of the
   CPU of a busy App. A page that fails stays out, as before. */
const servedPages = new WeakMap<DatabaseSchema, WeakMap<PageDef, Map<string, PageDef | null>>>();
function servedPage(page: PageDef, catalog: DatabaseSchema, roles: string, judge: () => PageDef | undefined): PageDef[] {
  let byPage = servedPages.get(catalog);
  if (!byPage) servedPages.set(catalog, (byPage = new WeakMap()));
  let byRoles = byPage.get(page);
  if (!byRoles) byPage.set(page, (byRoles = new Map()));
  let kept = byRoles.get(roles);
  if (kept === undefined) {
    const checked = judge();
    byRoles.set(roles, (kept = checked && !checked.error ? checked : null));
  }
  return kept ? [kept] : [];
}

/* What a role is served, before the request's person and moment touch it: the
   grant, the rules compiled over the catalog, the whole-row writes, and the
   catalog cut to the App's resources and its record labels. All of it is a
   function of the App, its catalog (stable while loaded) and the role set,
   and was rebuilt, a fresh catalog object included, on every request: which
   is also why nothing keyed on that catalog (a parse, a pruned view of it)
   could ever be found again. Keyed on the catalog and the App by identity, so
   a reloaded App or a refreshed catalog starts empty; bounded per App. */
/* An App is replaced when it is reloaded, but one changed in place (a test's,
   an embedder's) must be read again, as appRuntimeResources.ts reads it: the
   App's own declarations, and one level into what the grants are made of, are
   compared by identity. */
function declarations(app: AppDef): unknown[] {
  const out: unknown[] = Object.values(app);
  for (const group of [app.resources, app.auth, app.auth?.roles, app.auth?.public] as Array<Record<string, unknown> | undefined>) {
    if (!group || typeof group !== 'object') continue;
    for (const value of Object.values(group)) {
      out.push(value);
      if (value && typeof value === 'object' && !Array.isArray(value)) out.push(...Object.values(value));
    }
  }
  return out;
}

interface Served {
  inputs: readonly unknown[];
  grant: ReturnType<typeof resolveAppAccess>;
  validation: ReturnType<typeof compileAppDefinitionValidation>;
  transitions: ReturnType<typeof compileAppTransitions>;
  stamps: ReturnType<typeof compileAppStamps>;
  granted: ReturnType<typeof appActionGrants> | undefined;
  wholeRowWrites: ReadonlySet<string> | undefined;
}
/* The catalog cut to the App's resources (what the grant prunes it to, so
   per grant: accessibleSchema keeps that object for a stable grant), with
   what the server will accept said on it: no Delete is drawn for a resource
   the App does not delete from (appDeletable), a machine's column, and its
   `since`, are its verbs' to move (no editor offers them), and the App's
   record labels. Kept on the pruned catalog by identity; where the grant is
   not kept (a row scope) the catalog is new each time and this is as before. */
const cutByCatalog = new WeakMap<DatabaseSchema, WeakMap<AppDef, { inputs: readonly unknown[]; schema: DatabaseSchema }>>();
function cutSchema(app: AppDef, pruned: DatabaseSchema, transitions: Served['transitions']): DatabaseSchema {
  let byApp = cutByCatalog.get(pruned);
  if (!byApp) cutByCatalog.set(pruned, (byApp = new WeakMap()));
  const inputs = [...declarations(app), transitions];
  const kept = byApp.get(app);
  if (kept && kept.inputs.length === inputs.length && kept.inputs.every((input, at) => input === inputs[at])) return kept.schema;
  const deletes = appDeletable(app, pruned);
  const cut: DatabaseSchema = {
    ...pruned,
    label: app.name,
    tables: pruned.tables.map((table) => ({
      ...table,
      deletable: table.deletable !== false && deletes.has(table.id),
      columns: table.columns.map((column) =>
        transitions?.get(table.id)?.fields.has(column.name) || transitions?.get(table.id)?.since === column.name
          ? { ...column, changesBy: 'actions' as const }
          : column,
      ),
    })),
  };
  const schema = withLabelTemplates(app, cut);
  byApp.set(app, { inputs, schema });
  return schema;
}

const SERVED_ROLE_SETS = 64;
const servedByCatalog = new WeakMap<DatabaseSchema, WeakMap<AppDef, Map<string, Served>>>();
function servedFor(app: AppDef, catalog: DatabaseSchema, visitor: boolean, verifiedRoles: string[]): Served {
  let byApp = servedByCatalog.get(catalog);
  if (!byApp) servedByCatalog.set(catalog, (byApp = new WeakMap()));
  let byRoles = byApp.get(app);
  if (!byRoles) byApp.set(app, (byRoles = new Map()));
  const key = visitor ? '\0public' : verifiedRoles.join(',');
  const inputs = declarations(app);
  const kept = byRoles.get(key);
  if (kept && kept.inputs.length === inputs.length && kept.inputs.every((input, at) => input === inputs[at])) return kept;
  const validation = compileAppDefinitionValidation(catalog, app);
  const transitions = compileAppTransitions(catalog, app);
  const stamps = compileAppStamps(catalog, app);
  /* The fixed actions a role runs without write (`roles.<role>.actions`),
     from the verified session's roles; a visitor runs none. */
  const actions = visitor || !grantsByRole(app) ? undefined : appActionGrants(app, catalog, verifiedRoles);
  const granted = actions?.size ? actions : undefined;
  const grant = visitor && grantsByRole(app) ? resolveAppAccess(app, catalog, [], 'public') : resolveAppAccess(app, catalog, verifiedRoles);
  markStableGrant(grant);
  const wholeRowWrites = grant.fields
    ? new Set(
        catalog.tables
          .filter((table) => {
            const fields = grant.fields!.get(table.id);
            return (
              grant.writable.has(table.id) &&
              fields &&
              table.columns.every((column) => fields.read.has(column.name) && fields.write.has(column.name))
            );
          })
          .map((table) => table.id),
      )
    : undefined;
  const served: Served = { inputs, grant, validation, transitions, stamps, granted, wholeRowWrites };
  if (byRoles.size >= SERVED_ROLE_SETS) byRoles.clear();
  byRoles.set(key, served);
  return served;
}

export async function resolveSource(ctx: RequestContext, id: string | null | undefined): Promise<ResolvedSource> {
  const { res, url, registry, appHosts, policy, identity, appConfigured, policyContext } = ctx;
  let adapter: Adapter;
  let schema: DatabaseSchema;
  let resources: RuntimeResources | undefined;
  /** The App's own catalog and reads, for who `me` is (below). */
  let whole:
    | { app: AppDef; who: string | undefined; unproven: boolean; catalog: NonNullable<Parameters<typeof lookupPerson>[4]> }
    | undefined;
  let access: ResourceAccess | undefined;
  let wholeRowWrites: ReadonlySet<string> | undefined;
  let selectedHost: AppHost | undefined;
  let connectionId: string;
  /** The reader's zone, where `ui.timezone` reads one (readerZone.ts). */
  let zone: string | undefined;
  /** The words and figures this reader is served in (readerLocale.ts), and their tenant's own words (recordMessages.ts). */
  let locale: string | undefined;
  let words: Awaited<ReturnType<typeof readTenantMessages>>;
  /* Read under this reader's own grants, before their pages are cut to what they may read: a page is
     said in their words first, so what is cut is the page they are served. */
  const sayFor = async (app: AppHost, schema: DatabaseSchema, query: (request: QueryRequest) => Promise<QueryResult>) => {
    const visitor = typeof identity.id !== 'string' || !identity.id.trim();
    locale = requestLocale(app.app.app, { person: await readLocale(app.app.app.ui, schema, query), visitor, req: ctx.req, res });
    words = await readTenantMessages({
      app: app.app.app,
      schema,
      query,
      tenant: brandingTenant(ctx.req, app.app.app, url, undefined, !visitor),
    });
    const said = localizedApp(app.app, locale, words);
    if (said === app.app) return;
    const own = new Set(app.app.pages);
    const byId = new Map(said.pages.map((page) => [page.id, page]));
    ctx.configPages = ctx.configPages.map((page) => (own.has(page) ? (byId.get(page.id) ?? page) : page));
  };
  /* A request no App curates reads the connection it names (connectionSource.ts). */
  if (!appConfigured) return resolveConnectionSource(ctx, id);
  if (url.searchParams.has('conn')) throw new HttpError(400, 'Application requests identify an app, not a connection.');
  /* Named but unknown is a 404, not a fallback, as a connection is. */
  selectedHost = id ? appHosts!.find((host) => host.app.app.id === id) : appHosts!.length === 1 ? appHosts![0] : undefined;
  if (!selectedHost) throw new HttpError(id ? 404 : 400, id ? 'Application not found.' : 'Choose an application.');
  const consoleSource = consoleSourceOwners.get(selectedHost.app.app);
  if (consoleSource) return consoleSource(ctx, selectedHost);
  const target = appEntrypoint(selectedHost, registry);
  if (!target) throw new HttpError(503, 'Application data is unavailable.');
  const host = selectedHost;
  const lease = (owner: string) => {
    const release = registry.lease(owner);
    if (res.destroyed) release();
    else res.once('close', release);
  };
  {
    /* Signed out: nobody, unless the App opens resources to the public (`auth.public`), and then only its public grant. */
    const visitor = typeof identity.id !== 'string' || !identity.id.trim();
    if (grantsByRole(host.app.app) && visitor && !host.app.app.auth?.public) throw new AppAccessDenied();
    /* A page that names its roles is not this principal's unless it holds one (appViewRoles.ts). */
    ctx.configPages = pagesForRoles(ctx.configPages, visitor ? [] : sessionRoles(identity.role), host.app.app.auth);
    /* A new account's person row (`auth.me.create`), made on its first signed-in
       request through the App's own catalog and writer, before anything reads `me`. */
    const account = signedInAs(identity);
    if (account && host.app.app.auth?.me?.create && !personRowSeen(host.app.app, account)) {
      const own = await loadAppRuntimeResources(registry, host.app.app, target, lease);
      if (own.adapter.insert)
        await ensurePersonRow(
          host.app.app,
          own.schema,
          { query: own.adapter.query.bind(own.adapter), insert: own.adapter.insert.bind(own.adapter) },
          { email: account, ...(identity.name ? { name: identity.name } : {}) },
        );
    }
    if (policyContext) {
      ({ adapter, access } = httpPolicyReads(policyContext));
      zone = await readZone(host.app.app.ui, policyContext.schema, (request) => adapter.query(request));
      await learnValueLabels(host.app, policyContext.schema);
      await sayFor(host, policyContext.schema, (request) => adapter.query(request));
      const writable = policy!.writableTables(policyContext);
      const policyTransitions = compileAppTransitions(policyContext.schema, host.app.app);
      schema = {
        ...policyContext.schema,
        label: host.app.app.name,
        /* New is offered where the policy lets this reader insert and its
           writable columns can make a row (accessibleSchema judged those). */
        tables: policyContext.schema.tables.map((table) => ({
          ...table,
          insertable: table.insertable !== false && policy!.updates.canInsert(policyContext, table.id),
          deletable: policy!.updates.canDelete(policyContext, table.id),
          columns: table.columns.map((column) => ({
            ...column,
            writable: writable.includes(table.id) && policyContext.writeFields[table.id].includes(column.name),
            ...(policyTransitions?.get(table.id)?.fields.has(column.name) ? { changesBy: 'actions' as const } : {}),
          })),
        })),
      };
      // Each record's name, as this reader's catalog can say it (recordLabel.ts),
      // and the rollups whose child rows it can read (appRollups.ts), and the
      // computed columns whose inputs it can (appComputed.ts), `me` its own.
      schema = withRollups(host.app.app, withLabelTemplates(host.app.app, schema), clockNow(), signedInAs(identity) ?? null, zone);
      // A section this reader cannot read is left out, never the page (readablePage).
      ctx.configPages = ctx.configPages
        .flatMap((page) => readablePage(schema, page) ?? [])
        .map((page) => validatePage(schema, page))
        .filter((page) => !page.error);
    } else {
      resources = await loadAppRuntimeResources(registry, host.app.app, target, lease);
      const app = host.app.app;
      const personSchema = resources.schema;
      const verifiedRoles = typeof identity.role === 'string' ? identity.role.split(',').map((role) => role.trim()) : [];
      const {
        grant,
        validation,
        transitions,
        stamps,
        granted,
        wholeRowWrites: wholeWrites,
      } = servedFor(app, resources.schema, visitor, verifiedRoles);
      /* The person is the verified session's and the moment the server's own,
         read when the write runs: nothing the request says becomes a stamp. */
      const who = signedInAs(identity);
      const moment = (reader: Parameters<typeof lookupPerson>[3]): StampMoment => ({
        now: clockNow(),
        ...(who ? { who } : {}),
        person: () => (identity.emailUnproven ? Promise.resolve(null) : personKey(app, personSchema, who, reader)),
      });
      const stamp = stamps?.rules.size
        ? (request: UpdateRequest, reader: Parameters<typeof lookupPerson>[3]) => stampUpdate(stamps, request, moment(reader))
        : undefined;
      const fill = stamps?.defaults
        ? (request: InsertRequest, reader: Parameters<typeof lookupPerson>[3]) => stampInsert(stamps, request, moment(reader))
        : undefined;
      /* The App's own catalog and reads, before any grant narrows them: where
         the reader may not read people's emails, the server finds the
         reader's own row by the verified one (appMe.ts). */
      whole = { app, who, unproven: identity.emailUnproven === true, catalog: { schema: resources.schema, reader: resources.adapter } };
      /* `me` in an action's `when` is judged for the same person, only where a transition or a granted action needs judging. */
      const me =
        transitions || granted
          ? (reader: Parameters<typeof lookupPerson>[3]) =>
              identity.emailUnproven ? Promise.resolve(unprovenPerson(app, personSchema)) : lookupPerson(app, personSchema, who, reader)
          : undefined;
      /* Every App serves its resources and nothing else, signed in or not:
         the catalog is cut to them, every read and write is checked against
         the grant, and raw SQL is not part of the authorized adapter. A
         table the App does not declare answers as one that does not exist. */
      access =
        validation || transitions || stamp || fill || granted
          ? {
              ...grant,
              ...(validation ? { validation } : {}),
              ...(transitions ? { transitions } : {}),
              ...(stamp ? { stamp } : {}),
              ...(fill ? { fill } : {}),
              ...(me ? { me } : {}),
              ...(granted ? { actions: granted, ...(appZone(app.ui) ? { zone: appZone(app.ui) } : {}) } : {}),
            }
          : grant;
      wholeRowWrites = wholeWrites;
      resources = authorizeResources(resources, access);
      const reads = resources.adapter;
      zone = await readZone(app.ui, resources.schema, (request) => reads.query(request));
      await learnValueLabels(host.app, resources.schema);
      await sayFor(host, resources.schema, (request) => reads.query(request));
      // A page's fields may name a rollup this reader's catalog serves.
      const served = withRollups(host.app.app, resources.schema, clockNow(), signedInAs(identity) ?? null, zone);
      ctx.configPages = ctx.configPages.flatMap((page) =>
        servedPage(page, personSchema, visitor ? 'public' : verifiedRoles.join(','), () => {
          // A section this reader cannot read is left out, never the page (readablePage).
          const kept = readablePage(served, page);
          return kept ? validatePage(served, kept) : undefined;
        }),
      );
      adapter = resources.adapter;
      schema = withRollups(host.app.app, cutSchema(app, resources.schema, transitions), clockNow(), signedInAs(identity) ?? null, zone);
    }
  }
  connectionId = target;

  /* Every answer says which database gave it.

     Set here rather than added to a dozen `send` calls: this is the one
     place that knows, and a header covers the replies that are arrays and
     the ones that are errors as well as the ones that are objects.

     It exists to make the guarantee checkable. "The reply came from the
     connection the request named" is the whole of the multi-tab fix, and
     without this it is a claim rather than something a test or a reader can
     verify. */
  res.setHeader('x-mistri-app', host.app.app.id);

  const publicScope = { appId: selectedHost.app.app.id };
  const publicDefinition = <T extends { connection?: string }>(definition: T): T => {
    const { connection: _connection, ...visible } = definition;
    return visible as T;
  };
  /* Who `me` is, judged by the reader's own catalog first, and by the App's
     where that catalog keeps people's emails from this reader. */
  const readerSchema = schema;
  const person = whole
    ? (reader: Parameters<typeof lookupPerson>[3]) =>
        whole!.unproven
          ? Promise.resolve(unprovenPerson(whole!.app, readerSchema!))
          : lookupPerson(whole!.app, readerSchema!, whole!.who, reader, whole!.catalog)
    : undefined;
  return {
    adapter,
    schema,
    resources,
    access,
    wholeRowWrites,
    selectedHost,
    connectionId,
    publicScope,
    publicDefinition,
    ...(person ? { person } : {}),
    ...(zone === undefined ? {} : { zone }),
    ...(locale === undefined ? {} : { locale }),
    ...(words?.words.size ? { messages: { stamp: words.stamp, words: words.words } } : {}),
  };
}
