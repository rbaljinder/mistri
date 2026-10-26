/**
 * An App's part of the data routes (dataRoutes.ts `DataHooks`): its source —
 * its resources under the reader's grants or the row policy (source.ts) — a
 * signed-out visitor asked to sign in where they ask past `auth.public`, its
 * write gate, search documents and record rules (appRecordWrites.ts), its
 * reads through the search engine, "now" in its zone and `me` from its
 * session, a free-form page's loaders, the routes only an App serves, and
 * its export grants, page anatomy and composed record pages.
 */
import { zonedNow } from '../../shared/app.js';
import { appZone } from '../../shared/appUi.js';
import { sessionRoles } from '../../shared/appViewRoles.js';
import { localeWeekStart } from '@mistriwork/engine/shared/weekStart.js';
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { lookupPerson, unprovenPerson } from '../app/appMe.js';
import { searchAwareAdapter } from '../app/appSearchRuntime.js';
import { liveSyncOn } from '../live/liveBinding.js';
import { trackingReads } from '../live/liveReads.js';
import { signedInAs } from '../app/appStamps.js';
import { appForConnection, type AppHost } from '../app/apps.js';
import { businessCommandHttpError } from '../commands/businessCommandHttp.js';
import { BusinessCommandExecutionError } from '../commands/businessCommandExecution.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { httpRowPolicyAllows } from '../policy/appPolicyHttp.js';
import { APP_PAGES, appAuthoringRoutes } from './appAuthoring.js';
import { APP_EXPORT } from './appExport.js';
import { appFileRoute } from './appFileRead.js';
import { appProjectionRoutes, browserApp, defaultPage } from './appProjection.js';
import { APP_WRITES, appWriteRoutes } from './appRecordWrites.js';
import { CapturedReply } from '@mistriwork/engine/server/http/captured.js';
import { clockNow } from '@mistriwork/engine/server/http/clock.js';
import { commandRoutes } from './commandRoutes.js';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import { APP_READS } from '../app/appReads.js';
import type { DataHooks } from '@mistriwork/engine/server/http/dataRoutes.js';
import { publicReadRoute, signInCard } from './gate.js';
import { httpOperationRoutes } from '@mistriwork/engine/server/http/httpOperationRoutes.js';
import { inboxRoutes } from './inboxRoutes.js';
import { integrationRoutes } from './integrationRoutes.js';
import { PAGE_HEADER, PAGE_LOAD_PATH, pageLoad, pageManifestRefusal } from './pageLoad.js';
import type { ComposeResources } from '@mistriwork/engine/server/http/recordCompose.js';
import { recordHistoryRoutes } from './recordHistoryRoutes.js';
import { decisionRoutes } from './decisionRoutes.js';
import { send } from '@mistriwork/engine/server/http/reply.js';
import { resolveSource } from './source.js';
import { asksOutside } from './visitorTables.js';

/**
 * "Now" for date phrases, in the app's zone when an app curates the
 * connection: a server in a UTC container serving a team in Sydney said
 * "today" about a day that had ended there hours ago. The parsers take a
 * `now`; this is the one place it is chosen.
 */
function appNowFor(registry: Registry, appHosts: AppHost[] | undefined, connection: string | undefined, zone?: string): Date {
  const now = clockNow();
  if (!connection || !appHosts?.length) return now;
  const host = appForConnection(appHosts, connection, registry.configOf(connection)?.name);
  return zonedNow(appZone(host?.app.app.ui, zone), now);
}

/** Whether this request's reader may ask `path` on its own: the gate's and the row policy's rule for that route. */
function mayAsk(ctx: RequestContext, path: string): boolean {
  const { signedIn, identity, policy, policyContext, policyUnavailable } = ctx;
  if (signedIn?.auth && identity.id === undefined && !publicReadRoute(signedIn, 'POST', path)) return false;
  if ((policyContext || policy || policyUnavailable) && !httpRowPolicyAllows('POST', path, policy?.commands !== undefined)) return false;
  return true;
}

export const APP_DATA: DataHooks = {
  source: resolveSource,
  appReads: APP_READS,
  gates: {
    /* A signed-out visitor asking past `auth.public` is asked to sign in, alike for a private table and for none
       (visitorTables.ts): the visitor's catalog holds only what is public, so the read was a typo's answer. A GET
       is asked here only for a table past it (a member's record's suggested page): the one answer for both. */
    read: (ctx, source, asked) => {
      const visiting = source.selectedHost;
      if (ctx.identity.id !== undefined || !visiting?.auth || !visiting.app.app.auth?.public) return false;
      if (asked.body !== undefined && !asksOutside(source.schema, asked.path, asked.body)) return false;
      ctx.res.setHeader('cache-control', 'no-store');
      send(ctx.res, 401, { error: 'Sign in to continue.', code: 'members_only', signIn: signInCard(visiting) });
      return true;
    },
    write: APP_WRITES.gates.write,
  },
  ...(APP_WRITES.after ? { after: APP_WRITES.after } : {}),
  ...(APP_WRITES.rules ? { rules: APP_WRITES.rules } : {}),
  /* In an App, a text filter on a field a resource declares searchable is
     asked of its search engine, and the rows are still read here, through
     this request's own adapter (appSearchRuntime.ts). When the engine does
     not answer, the filter runs on the database and the reply says so. */
  reads: (ctx, source, adapter, reply) => {
    if (!ctx.appHosts?.length) return adapter;
    const searched = searchAwareAdapter(adapter, {
      registry: ctx.registry,
      appHosts: ctx.appHosts,
      connection: source.connectionId,
      schema: source.schema,
      onFallback: () => {
        if (!reply.headersSent) reply.setHeader('x-mistri-search', 'database');
      },
    });
    /* And each read says which tables it answered from, so a page refetches it only when one of them changes (liveReads.ts). */
    return liveSyncOn() ? trackingReads(searched, source.schema, reply) : searched;
  },
  extras: (ctx, source, reads) => {
    const { identity, registry, appHosts } = ctx;
    /* `me` is this session's account; the App says which of its rows is a person (appMe). */
    const app = source.selectedHost?.app.app;
    const who = signedInAs(identity);
    const me = app
      ? (reader: Adapter) =>
          source.person?.(reader) ??
          (identity.emailUnproven ? Promise.resolve(unprovenPerson(app, source.schema)) : lookupPerson(app, source.schema, who, reader))
      : undefined;
    return {
      appNow: () => appNowFor(registry, appHosts, source.connectionId, source.zone),
      appHost: source.selectedHost,
      recipient: who,
      ...(source.zone === undefined ? {} : { zone: source.zone }),
      ...(me ? { me: () => me(reads) } : {}),
    };
  },
  page: async (ctx, source, body) => {
    const app = source.selectedHost?.app.app;
    if (!app) return false;
    const { identity, res, req, path } = ctx;
    const roles = sessionRoles(identity.role);
    if (path === PAGE_LOAD_PATH) {
      const reply = await pageLoad({
        app,
        roles,
        signedIn: identity.id !== undefined || !app.auth,
        ...(identity.id === undefined ? {} : { account: identity.id }),
        loaders: source.selectedHost?.app.loaders,
        body,
        reader: source.adapter,
        schema: source.schema,
        ...(source.zone === undefined ? {} : { zone: source.zone }),
      });
      send(res, reply.status, reply.body);
      return true;
    }
    const refused = pageManifestRefusal({ app, roles, header: req.headers[PAGE_HEADER], path, body, schema: source.schema });
    if (!refused) return false;
    send(res, refused.status, refused.body);
    return true;
  },
  routes: async (post) =>
    (await httpOperationRoutes(post)) ||
    appAuthoringRoutes(post) ||
    (await recordHistoryRoutes(post)) ||
    (await decisionRoutes(post)) ||
    (await inboxRoutes(post)) ||
    (await integrationRoutes(post)),
  later: async (post) => appWriteRoutes(post),
  /** The ISO weekday the App's weeks start on, from its `ui.locale` (Monday where it names none). */
  weekStart: (post) => {
    const { registry, appHosts, connection } = post;
    const host = connection && appHosts?.length ? appForConnection(appHosts, connection, registry.configOf(connection)?.name) : undefined;
    return localeWeekStart(host?.app.app.ui.locale);
  },
  exports: APP_EXPORT,
  pages: APP_PAGES,
  compose: {
    mayAsk,
    resources: (ctx, source) => (browserApp(ctx, source).app?.resources ?? {}) as ComposeResources,
    suggested: (source, table) => defaultPage(source.selectedHost, source.schema, table),
    availability: async (ctx, checks) => {
      const reply = new CapturedReply();
      const refuse = (code: ConstructorParameters<typeof BusinessCommandExecutionError>[0]) => {
        const failure = businessCommandHttpError(new BusinessCommandExecutionError(code, 'not_applied'), false);
        send(reply.asResponse(), failure.status, failure.body);
      };
      try {
        await commandRoutes(
          { ...ctx, res: reply.asResponse(), path: '/api/commands/availability', commandRequest: true, commandRefusal: refuse },
          { checks },
        );
      } catch {
        return undefined;
      }
      return reply.answer();
    },
  },
  read: { projection: appProjectionRoutes, file: appFileRoute },
};
