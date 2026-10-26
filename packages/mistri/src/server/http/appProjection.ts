/**
 * The App projection: what the client draws around the data — the App
 * itself, the pages and their building blocks, the stored layouts, saved
 * pages and filters, and the agent's tool list. Every answer is shaped for
 * the connection or App in hand.
 */
import { suggestPage, validatePage } from '@mistriwork/engine/shared/page.js';
import { assistantModel } from '../assistant/assistantModel.js';
import { servedDecisions } from '../decide/decisionServing.js';
import { anatomyPage, type AnatomyHints } from '@mistriwork/engine/shared/pageAnatomy.js';
import { headingOf, pluralOf, recordNoun } from '@mistriwork/engine/shared/appNoun.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { historyRules } from '../recordHistory.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import { appAllowsWrite, grantsByRole, type AppDef } from '../../shared/app.js';
import { appCommandGrants, appExportable } from '../../shared/appAccess.js';
import { servedCommandIds } from '../../shared/appCommandIds.js';
import { appForConnection, appPayload, localizedApp, schemaStamp, type AppHost } from '../app/apps.js';
import {
  servedLanguages,
  servedLocale,
  servedZone,
  withAvailableEmptyActions,
  withAvailablePageEmptyActions,
  withHome,
  withoutBrokenViews,
  withoutSignedInParts,
  type AppPayload,
  type AppPayloadApp,
} from '../../shared/appPayload.js';
import { homeViews } from '../../shared/appHome.js';
import { appForRoles, pagesForRoles, sessionRoles } from '../../shared/appViewRoles.js';
import { greetReader } from '../../shared/appGreeting.js';
import { fieldAccessibleApp } from '../app/appFieldProjection.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { grantedFormCommands, visibleBusinessCommandActions } from '../commands/businessCommandLoader.js';
import { publicPageCommands } from '../commands/commandContracts.js';
import { withPublicCommandChoices } from '../forms/formChoices.js';
import { appEntrypoint } from '../app/appEntrypoint.js';
import { withDraftsHidden } from '../forms/savedFormLists.js';
import { send, sendRevalidated } from '@mistriwork/engine/server/http/reply.js';
import { catalogLocales, localeRow } from '../app/readerLocale.js';
import { componentMessages } from '../app/appMessages.js';
import { principalOf, type RequestContext, type ResolvedSource } from '@mistriwork/engine/server/http/context.js';
import { requestRecordBranding, withRecordBranding } from './recordBranding.js';
import { pageReadRoutes, type PageReadHooks } from '@mistriwork/engine/server/http/pageReads.js';

/**
 * The App as the browser in hand is served it: this principal's actions and
 * fields, without API-only or broken rooms, with its home. `/api/app` answers
 * it, and a public page's canonical address is read from it (publicHead.ts),
 * so the server and the address bar route by one book.
 */
/* Whether the App's own problems — its load error, a broken view — are kept
   from this reader. Roles and hidden columns make readers who are not the
   author; an App without them is read by the one who wrote it, whose loop is
   the browser. Every App is access-checked (source.ts); this is only which
   of them tells. */
const guardedProblems = (app: AppDef | undefined, access: ResolvedSource['access']) =>
  Boolean(access && app && (grantsByRole(app) || access.fields));

export function browserApp(ctx: RequestContext, source: ResolvedSource) {
  const { registry, appHosts, commands, identity } = ctx;
  const { schema, access, connectionId } = source;
  const name = registry.list().find((c) => c.id === connectionId!)?.name;
  const host = appForConnection(appHosts ?? [], connectionId!, name);
  const roles = (identity.role ?? '')
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
  const commandRegistry = commands?.appId === host?.app.app.id ? commands?.registry : undefined;
  /* The App in this reader's words (appMessages.ts): a definition per locale and tenant words, so every
     per-definition cache below is one per locale too. */
  const inWords = host && localizedApp(host.app, source.locale, source.messages);
  /* The views and pages this principal may open come first, so nothing
     below — the payload, its address book, an import naming a list — can
     reach one that names other roles. A signed-out visitor holds none. */
  const opening = host?.app.app.auth && !identity.id ? [] : roles;
  const openable = inWords && appForRoles(inWords.app, opening);
  /* One projection per principal shape, not per request (projected, below). */
  const visibleApp = host
    ? {
        ...inWords!,
        pages: pagesForRoles(inWords!.pages, opening, inWords!.app.auth),
        app: projected(
          openable!,
          schema!,
          ['visible', Boolean(access?.fields), commandRegistry ? registryId(commandRegistry) : 0, [...roles].sort()],
          () =>
            withDraftsHidden(
              visibleBusinessCommandActions(
                access?.fields ? fieldAccessibleApp(openable!, schema!, access.actions) : openable!,
                commandRegistry,
                schema!,
                roles,
              ),
              commandRegistry,
              schema!,
            ),
        ),
      }
    : undefined;
  const guarded = guardedProblems(host?.app.app, access);
  const payload = appPayload(visibleApp, connectionId!, name, schema!, guarded ? undefined : host?.loadError);
  const { connection: _connection, ...said } = payload;
  /* Told to whoever is told the load error, and only while it is the error it was placed for.
     The stream of saves is the author's too: a reader the App's problems are
     kept from picks up a new App on their next fetch, and holds no stream. */
  const placed = !guarded && host?.loadError && host.loadProblem?.of === host.loadError ? host.loadProblem.problem : undefined;
  const publicPayload = { ...said, ...(placed ? { loadProblem: placed } : {}), ...(!guarded && host?.live ? { live: true as const } : {}) };
  let app = payload.app;
  if (app && guarded) {
    const { problems: _problems, ...visible } = app;
    app = withoutBrokenViews(visible, homeViews(host!.app.app));
  }
  // API-only and broken rooms are absent from the browser payload. An empty
  // state may only offer a destination the final payload can actually open.
  if (app) app = withAvailableEmptyActions(app);
  /* This reader's days, after the per-definition cache (readerZone.ts). */
  if (app && source.zone !== undefined) app = { ...app, ui: servedZone(app.ui, source.zone) };
  /* This reader's locale, after the same cache: their figures agree with the words they were said (readerLocale.ts). */
  if (app && source.locale !== undefined) app = { ...app, ui: servedLocale(app.ui, source.locale) };
  /* And the languages the picker offers them, where the App has words in several. */
  if (app && host) app = { ...app, ui: servedLanguages(app.ui, catalogLocales(host.app.app)) };
  /* And the catalog itself, for the components that say it (`useMessage`): only to a reader who is drawn one. */
  if (app?.components && Object.keys(app.components).length && host) {
    const messages = componentMessages(host.app.app, source.locale, source.messages);
    if (messages) app = { ...app, messages };
  }
  /* Where this principal starts, from its verified session's roles alone:
     the gate admits a signed-out visitor to an App that signs people in
     only where it opens resources to the public (`auth.public`), and an
     App without sign-in has no rule that asks for a role. */
  if (app && host)
    app = withHome(
      app,
      host.app.app,
      host.app.app.auth && !identity.id ? { signedIn: false } : { signedIn: true, roles: host.app.app.auth ? roles : [] },
    );
  if (app && host?.app.app.auth && !identity.id) app = withoutSignedInParts(app, schema);
  /* Export is a grant of its own in an App that grants by role (appExportable): the tables this reader may export,
     and no Export menu at all when there are none. The export route refuses the same. */
  const exportable = app && host ? appExportable(host.app.app, schema!, roles, Boolean(identity.id)) : undefined;
  if (app && exportable) app = { ...app, exportableTables: [...exportable], ui: exportable.size ? app.ui : { ...app.ui, export: false } };
  /* An assistant offered to some roles is not drawn for the others, and none
     is drawn while the server has no model to talk to; its routes refuse the
     same (assistantRoutes.ts). */
  const offeredTo = host?.app.app.assistant?.roles;
  if (app?.assistant && ((offeredTo && !roles.some((role) => offeredTo.includes(role))) || !assistantModel())) {
    const { assistant: _assistant, ...rest } = app;
    app = rest;
  }
  /* The fields a decision answers, of the tables this reader is served, where they could accept it (granted its answer
     command): a record reserves the suggestion's place. The routes answer no one else (decisionRoutes.ts). */
  const decided =
    app && host
      ? servedDecisions(
          registry,
          host.app.app.id,
          new Set(schema!.tables.map((table) => table.id)),
          appCommandGrants(host.app.app, opening),
        )
      : undefined;
  if (app && decided) app = { ...app, decisions: decided };
  /* A granted command that names no record and that no signed-in form runs: a component's `useCommand`
     reaches it by name, under the same grant and reads a form's would need. */
  const formCommands = host ? grantedFormCommands(host.app.app, commandRegistry, schema!, opening) : {};
  return { host, visibleApp, publicPayload, app, formCommands };
}

export async function appProjectionRoutes(ctx: RequestContext, source: ResolvedSource): Promise<boolean> {
  const { res, path, registry, appHosts, commands, policy, identity, policyContext } = ctx;
  const { schema, resources, access, connectionId, publicScope, publicDefinition } = source;
  const { configPages } = ctx;

  /**
   * Pages the config file names, for the connection in hand.
   *
   * Checked against this connection's schema here rather than in the browser,
   * because the check needs the schema and the browser would have to be told
   * the same rules a second time — which is how the two ended up disagreeing
   * about what a valid path was in every other feature that tried it.
   *
   * A page that does not fit this connection comes back *with its reason*
   * rather than missing. A config file shared by a team always describes some
   * connection someone is not on, and "the page I wrote is not in the list"
   * is a bug report nobody can act on.
   */
  /**
   * The app this server was started with, resolved for the connection in
   * hand. Everything app-shaped lives in apps.ts; this route only says which
   * connection is asking. `app: null` is an answer, not an error — most
   * servers have no app, and the client draws the ordinary sidebar.
   */
  /* A watched App's saves, as they land (app/appLive.ts): the stream says only
     that the App moved on, and the page asks /api/app as itself. Only to a
     reader told the App's problems (browserApp's `live`): the author. */
  if (path === '/api/app/live') {
    const host = appForConnection(appHosts ?? [], connectionId!, registry.list().find((c) => c.id === connectionId!)?.name);
    if (host?.live && !guardedProblems(host.app.app, access)) host.live.stream(ctx.req, res);
    else send(res, 404, { error: 'Saves to this App are not followed here.' });
    return true;
  }
  if (path === '/api/app') {
    const principal = principalOf(identity);
    const { host, visibleApp, publicPayload, app: projectedApp, formCommands } = browserApp(ctx, source);
    const branding = projectedApp ? await requestRecordBranding(ctx, source) : undefined;
    const app = projectedApp && withRecordBranding(projectedApp, branding);
    // Private record presentation (including fallback) has the same storage
    // boundary as its shell. sendRevalidated preserves no-store and skips 304.
    if (branding?.private) {
      res.setHeader('cache-control', 'private, no-store');
      res.removeHeader('etag');
    }
    /* The row a signed-in reader's language pick is written to, where `ui.locale` names a column of it (readerLocale.ts). */
    const ownRow =
      app?.ui.languages && host && identity.id && source.person
        ? localeRow(host.app.app, schema!, await source.person(source.adapter).catch(() => undefined))
        : undefined;
    /* A dashboard that greets its reader is said to this one, from the
       verified session, after every per-principal cache (appGreeting.ts). */
    /* The public commands the public pages this reader is served run through their own door (pageCommandRoutes.ts). */
    /* Each with its choices from a table, read as the public reads them, so a page draws them with no read of its own
       (forms/formChoices.ts); they ride in this revalidated answer, so a change to the rows is a new tag. */
    const publicCommands =
      app && host && commands?.appId === host.app.app.id
        ? await withPublicCommandChoices(publicPageCommands(app.views, commands.registry), {
            registry,
            app: host.app.app,
            connection: policy ? undefined : appEntrypoint(host, registry),
            commands: commands.registry,
          })
        : {};
    const withPublic = (served: AppPayloadApp): AppPayloadApp =>
      Object.keys(publicCommands).length ? { ...served, publicCommands } : served;
    const answer = (served: AppPayloadApp | null): AppPayload => ({
      ...publicPayload,
      ...publicScope,
      app:
        served &&
        greetReader(
          withPublic(ownRow ? { ...served, ui: { ...served.ui, localeRow: ownRow } } : served),
          identity.id ? identity.name : undefined,
        ),
    });
    /* Every command an action this principal may run references, whichever list shows it, each its signed-in
       forms run, and each it runs that names no record and no form runs. */
    const grantedCommands = visibleApp ? [...servedCommandIds(visibleApp.app), ...Object.keys(formCommands)] : [];
    const unformed = Object.keys(formCommands).length ? { formCommands } : {};
    if (app && policyContext) {
      const grantedActions = policy!.grantedActions(policyContext);
      sendRevalidated(
        res,
        answer({
          ...app,
          writableTables: policy!.writableTables(policyContext),
          ...(Object.keys(grantedActions).length ? { grantedActions } : {}),
          grantedCommands,
          ...unformed,
        }),
        principal,
      );
      return true;
    }
    if (app && host && resources) {
      const writableTables = schema!.tables
        .filter(
          (table) =>
            /* A union is read-only, and has no connection of its own (appUnions.ts). */
            !table.union &&
            registry.configOf(resources!.connectionFor(table.id))?.writable === true &&
            (access
              ? access.writable.has(table.id) && (!access.fields || Boolean(access.fields.get(table.id)?.write.size))
              : appAllowsWrite(host.app.app, schema!, table.id, identity.role)),
        )
        .map((table) => table.id);
      /* The fixed actions a role runs without write, by table and id: the
         bar offers these beside a table it cannot otherwise edit. */
      const grantedActions =
        access?.actions &&
        Object.fromEntries(
          [...access.actions]
            .filter(([table]) => registry.configOf(resources!.connectionFor(table))?.writable === true)
            .map(([table, actions]) => [table, actions.map((action) => action.id)]),
        );
      sendRevalidated(
        res,
        answer({
          ...app,
          writableTables,
          ...(grantedActions && Object.keys(grantedActions).length ? { grantedActions } : {}),
          ...(commands?.appId === host.app.app.id ? { grantedCommands, ...unformed } : {}),
        }),
        principal,
      );
      return true;
    }
    sendRevalidated(res, answer(app), principal);
    return true;
  }

  if (path === '/api/pages') {
    const name = registry.list().find((c) => c.id === connectionId!)?.name;
    const mine = configPages.filter((p) => !p.connection || p.connection === connectionId! || p.connection === name);
    let pages = mine.map((p) => publicDefinition(validatePage(schema!, p)));
    if (pages.some((page) => page.sections.some((section) => section.kind === 'list' && section.empty?.action))) {
      const host = appForConnection(appHosts ?? [], connectionId!, name);
      const said = host && localizedApp(host.app, source.locale, source.messages);
      const openable = said && appForRoles(said.app, host.app.app.auth && !identity.id ? [] : sessionRoles(identity.role));
      const visible = said
        ? {
            ...said,
            app: access?.fields ? projected(openable!, schema!, ['fields'], () => fieldAccessibleApp(openable!, schema!)) : openable!,
          }
        : undefined;
      const guarded = guardedProblems(host?.app.app, access);
      let rooms = visible ? appPayload(visible, connectionId!, name, schema!, guarded ? undefined : host?.loadError).app : null;
      if (rooms && guarded) rooms = withoutBrokenViews(rooms, homeViews(host!.app.app));
      pages = withAvailablePageEmptyActions(pages, rooms ?? { views: {} });
    }
    sendRevalidated(
      res,
      {
        ...publicScope,
        pages,
      },
      principalOf(identity),
    );
    return true;
  }

  return pageReadRoutes(ctx, source, APP_PAGE_READS);
}

/** The page-shaping reads in an App: its record anatomy, and its sign-in. */
const APP_PAGE_READS: PageReadHooks = {
  suggested: (source, schema, table) => defaultPage(source.selectedHost, schema, table),
  signsIn: (ctx, source) =>
    Boolean(
      appForConnection(ctx.appHosts ?? [], source.connectionId, ctx.registry.list().find((c) => c.id === source.connectionId)?.name)?.app
        .app.auth,
    ),
};

/* The definition as one principal may see it, one object per (definition,
   catalog, shape): the App payload is cached on the definition it is given
   (apps.ts), and a projection rebuilt per request is a new definition, so
   the payload was rebuilt per request too. The shape is everything the
   projection reads besides the catalog — roles, whether fields are cut, the
   command registry — and the catalog is in the key by content. */
const projections = new WeakMap<AppDef, Map<string, AppDef>>();
const registries = new WeakMap<object, number>();
let registryCount = 0;
const PROJECTIONS_PER_DEFINITION = 32;

function registryId(registry: object): number {
  let id = registries.get(registry);
  if (id === undefined) registries.set(registry, (id = ++registryCount));
  return id;
}

function projected(base: AppDef, schema: DatabaseSchema, shape: unknown[], build: () => AppDef): AppDef {
  const key = JSON.stringify([schemaStamp(schema), ...shape]);
  let held = projections.get(base);
  const hit = held?.get(key);
  if (hit) return hit;
  if (!held) projections.set(base, (held = new Map()));
  if (held.size >= PROJECTIONS_PER_DEFINITION) held.delete(held.keys().next().value!);
  const app = build();
  held.set(key, app);
  return app;
}

/** A table's page when nobody wrote one: in an App, the record anatomy; in the Workbench, its counts and lists. */
export function defaultPage(host: AppHost | undefined, schema: DatabaseSchema, table: string): PageDef | null {
  return host ? anatomyPage(schema, table, anatomyHints(host.app.app, host.pages, table)) : suggestPage(schema, table);
}

/** What an App says that the anatomy reads: which columns are money, and whether this resource keeps a history. */
function anatomyHints(app: AppDef, pages: readonly PageDef[], table: string): AnatomyHints {
  const display = (id: string) => app.resources?.[id]?.display as Record<string, { format?: string } | undefined> | undefined;
  const history = historyRules(app, pages);
  const resource = (id: string) => app.resources?.[id];
  return {
    /* A status is a column the App dresses in tones, or one named like a state. */
    status: (of, column) =>
      (resource(of.id)?.display as Record<string, { tone?: unknown } | undefined> | undefined)?.[column.name]?.tone !== undefined ||
      undefined,
    /* A list is called what its records are, as a list view would be. */
    title: (fk, child, ambiguous) => {
      const noun = resource(child.id)?.noun;
      const many = noun?.many ?? pluralOf(recordNoun(noun, child.name));
      return `${headingOf(many)}${ambiguous ? ` (${humanName(fk.from.columns[0].replace(/_id$/i, '')).toLowerCase()})` : ''}`;
    },
    noun: (of) => recordNoun(resource(of.id)?.noun, of.name),
    money: (of, column) => {
      const rule = display(of.id)?.[column.name] ?? display(of.name)?.[column.name];
      return rule?.format === undefined ? undefined : rule.format === 'money';
    },
    history: history.has(table),
  };
}
