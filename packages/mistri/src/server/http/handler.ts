/**
 * Every request the public HTTP server answers, as one ordered dispatcher.
 * `createApp` (server.ts) wires it. `handle` is the door (`door`: the closed
 * App, the gate in gate.ts, the context every route reads), then two tables
 * of routes tried in order: OPEN_ROUTES, which read no App rows as the
 * person asking (the crawler's reads, the public landing, accounts, the
 * assistant, the embed boot, public forms), and ROUTES, inside the row
 * policy's context where the deployment has one — scopedWrites,
 * operationsRoutes, commandRoutes, connectionRoutes, importRoutes, then a
 * POST resolves its source from its body (`postRoute`) and goes to
 * `handlePost` (authoringRoutes, the resource reads, dataWriteRoutes) as a
 * PostContext, while a page is the shell and a GET goes to readRoutes. The
 * row-policy wrapper (`underPolicy`) stays here whole: it is the one piece
 * that sees the reply before the client does.
 */
import { serveClient, shellEgress, type SocialHead } from '@mistriwork/engine/server/clientHttp.js';
import { CLIENT_FILES } from '../clientFiles.js';
import { AppValidationDenied, ConsumesRefused } from '../app/appValidationDenied.js';
import { appError } from '../app/appErrors.js';
import {
  appFaceHead,
  groundsOf,
  lookDensityFor,
  lookFacesFor,
  lookGroundsFor,
  lookSchemeFor,
  lookSheetsFor,
} from '@mistriwork/engine/server/clientSurface.js';
import { fontRoute } from './fontRoutes.js';
import { brandRoute } from './brandRoutes.js';
import { publicHead, type ShellHead } from './publicHead.js';
import { personAddress } from './personAddress.js';
import { cardRequest, SHARE_CARD_PATH, sendShareCard, shareCard, shareCardImage } from './shareCard.js';
import { publicPane } from '../publicRender.js';
import { requestOrigin } from '@mistriwork/engine/server/http/requestOrigin.js';
import { firstPaint, firstPaintBlock, loopbackRequest, type Loop } from '@mistriwork/engine/server/http/firstPaint.js';
import { APP_PAINT_ROOMS, placedPublicFormPage } from './firstPaintRooms.js';
import { inheritTenantHostIntent } from './tenantHosts.js';
import { CapturedReply } from '@mistriwork/engine/server/http/captured.js';
import { FIRST_PAINT_ELEMENT } from '@mistriwork/engine/shared/firstPaint.js';
import { EMBED_BOOT_PATH } from '../../shared/embedProtocol.js';
import { embedBootRoute } from '../embed/boot.js';
import { embedDoorFor } from '../embed/crossOrigin.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Registry } from '@mistriwork/engine/server/connections.js';
import { Refusal, TransactionOutcomeUnknown, WriteConflict } from '@mistriwork/engine/adapters/adapter.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import { isRowPolicyApp, isTenantApp } from '../../shared/app.js';
import type { AppHost } from '../app/apps.js';
import { catalogLocales, requestLocale, unvaryOnLanguage } from '../app/readerLocale.js';
import type { ConfigLayout } from '@mistriwork/engine/shared/recordview.js';
import { accountOf } from '../app/appStamps.js';
import { attributeWrites } from '@mistriwork/engine/adapters/writeAttribution.js';
import { AppAccessDenied } from '@mistriwork/engine/server/columnGrants.js';
import { httpRowPolicyAllows, type HttpAppPolicy } from '../policy/appPolicyHttp.js';
import type { AppPolicyContext } from '../policy/appPolicyContext.js';
import { writeFailureOutcome } from '@mistriwork/engine/server/constraints.js';
import { PathError, type ViewDef } from '@mistriwork/engine/shared/view.js';
import type { SavedQuery } from '@mistriwork/engine/shared/sqlsaved.js';
import type { RequestDiagnostics } from '@mistriwork/engine/server/operations/diagnostics.js';
import { businessCommandHttpError, commandBody, isBusinessCommandPath } from '../commands/businessCommandHttp.js';
import { BusinessCommandExecutionError } from '../commands/businessCommandExecution.js';
import { clientTrusted, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { HttpError, policyResponses, send, sendBusy, sendRowLocked, FILE_UPLOAD_PATH } from '@mistriwork/engine/server/http/reply.js';
import { lockTimedOut } from '@mistriwork/engine/adapters/writeLanes.js';
import { isPoolBusy } from '@mistriwork/engine/adapters/poolMetrics.js';
import { gate } from './gate.js';
import { scopedWriteRoutes } from './scopedWrites.js';
import { operationsRoutes } from './operationsRoutes.js';
import { commandRoutes } from './commandRoutes.js';
import { challengeOf, publicFormRoutes } from './formRoutes.js';
import { pageCommandRoutes } from './pageCommandRoutes.js';
import { landingRoute, LANDING_PATH } from './landingRoutes.js';
import { seoRoutes } from './sitemap.js';
import { recordBrandingSpec, requestRecordBranding, publicBrandingSurface, type BrandingPresentation } from './recordBranding.js';
import { appConnectionRoutes } from './appConnections.js';
import { accountRoutes } from './accountRoutes.js';
import { importRoutes } from './importRoutes.js';
import { componentRoutes } from './componentRoutes.js';
import { PAGE_HEADER, pageManifestRefusal } from './pageLoad.js';
import { APP_DATA } from './appData.js';
import { getData, postData } from '@mistriwork/engine/server/http/dataRoutes.js';
import { sessionRoles } from '../../shared/appViewRoles.js';
import { assistantRoutes } from './assistantRoutes.js';
import { ensureAppRecordHistory } from '../recordHistory.js';
import { ensureAppInbox } from '../inbox.js';
import { ensureAppLive } from '../live/liveBinding.js';
import { liveRoute } from '../live/liveRoute.js';
import { readFreshness } from '@mistriwork/engine/server/http/readRouting.js';
import { readsAs } from '@mistriwork/engine/adapters/replicas.js';
import { noteAuthorRequest, reportRefusal } from '@mistriwork/engine/server/http/refusalReport.js';
import { administersAccounts } from '../../shared/accountAdministration.js';
import { recordRefusalCause, refusalSaid } from '@mistriwork/engine/shared/refusal.js';
import { currentSpan } from '@mistriwork/engine/adapters/telemetry/trace.js';
import { observerHome, observerMounted } from '../observe/mount.js';
import type { GatedContext, RequestContext } from '@mistriwork/engine/server/http/context.js';
import type { CommandHosting, CommandRefusalCode, JobsReadiness } from './appContext.js';
import { route, type Route } from '@mistriwork/engine/server/http/router.js';
import { mountJson, NO_MOUNT, outward, type AddressMount } from '@mistriwork/engine/shared/mount.js';

export type { CommandHosting } from './appContext.js';

/**
 * What one server serves, as `createApp` (server.ts) was given it: read on
 * every request and changed by none. A loopback request (firstPaint.ts) is
 * the same server asked again, with the pages its page was drawn from.
 */
export interface Serving {
  readonly registry: Registry;
  readonly views?: ViewDef[];
  /** The file this session read its connections from, and writes them back to. */
  readonly configPath?: string;
  readonly bound?: Bound;
  readonly queries?: SavedQuery[];
  readonly pages?: PageDef[];
  readonly layouts?: ConfigLayout[];
  readonly apps?: AppHost[];
  readonly commands?: CommandHosting;
  readonly policy?: HttpAppPolicy;
  readonly policyUnavailable?: boolean | string;
  readonly diagnostics?: RequestDiagnostics;
  readonly jobs?: JobsReadiness;
  /** Where the Apps are served (shared/mount.ts); the request's `url` is already its inside form. */
  readonly mount?: AddressMount;
}

/** A request past the door: who is asking is settled, the row policy is not yet entered. */
interface Admitted extends GatedContext {
  /** Whether this browser (or token) wrote a moment ago, so its reads go to the primary (replicas.ts). */
  readonly freshness: ReturnType<typeof readFreshness>;
  /** Who this request's writes are, for the record history (writeAttribution.ts). */
  readonly attribution: Parameters<typeof attributeWrites>[0];
}

/**
 * Every request: the door, then the routes that read no App rows, then the
 * row policy's context (when the deployment has one) around the routes that
 * do. Each table is tried in order and the first route that answers ends it.
 */
export async function handle(req: IncomingMessage, res: ServerResponse, url: URL, serving: Serving): Promise<void> {
  const admitted = await door(req, res, url, serving);
  if (!admitted) return;
  if (await route(admitted, OPEN_ROUTES)) return;
  return underPolicy(admitted, async (policyContext) => {
    await route<RequestContext>({ ...admitted, policyContext }, ROUTES);
  });
}

/**
 * The door: what refuses a request before any route reads it — an App that
 * is closed until a restart, the gate (gate.ts) — and the context every
 * route reads, built once. `undefined` when it already answered.
 */
async function door(req: IncomingMessage, res: ServerResponse, url: URL, serving: Serving): Promise<Admitted | undefined> {
  const { registry, policy, diagnostics, jobs, commands } = serving;
  const bound = serving.bound ?? { host: '127.0.0.1', port: 4111 };
  const mount = serving.mount ?? NO_MOUNT;
  const policyUnavailable = serving.policyUnavailable ?? false;
  if (serving.apps?.some((host) => isTenantApp(host.app.app))) {
    res.setHeader('cache-control', 'no-store');
    send(res, 503, { error: 'Tenant applications are not enabled in public transports.' });
    return undefined;
  }
  const path = url.pathname;
  /* Whether this browser (or token) wrote a moment ago: if so its reads go
     to the primary, so a save shows in the list it returns to (replicas.ts). */
  const freshness = readFreshness(req, res, mount.base);
  const commandRequest = isBusinessCommandPath(path);
  const commandRefusal = (code: CommandRefusalCode) => {
    const failure = businessCommandHttpError(
      new BusinessCommandExecutionError(
        code,
        policy || policyUnavailable || serving.apps?.some((host) => isRowPolicyApp(host.app.app)) ? 'unknown' : 'not_applied',
      ),
      path === '/api/commands/status',
    );
    return send(res, failure.status, failure.body);
  };
  /* A reload changed what an App grants (authorityLock.ts): neither its old
     authority nor the new one is served until the server restarts. */
  const closed = serving.apps?.find((host) => host.unavailable)?.unavailable;
  if (closed && (commandRequest || path.startsWith('/api/'))) {
    res.setHeader('cache-control', 'no-store');
    if (commandRequest) commandRefusal('temporarily_unavailable');
    else send(res, 503, { error: closed });
    return undefined;
  }
  if (
    commandRequest ||
    (path.startsWith('/api/') && (policy || policyUnavailable || serving.apps?.some((host) => isRowPolicyApp(host.app.app))))
  )
    res.setHeader('cache-control', 'no-store');
  // A policy reload applies to the next request, never half of this one.
  const appHosts = serving.apps?.map((host) => ({ ...host, app: { ...host.app } }));
  const configPages = (serving.pages ?? []).slice();

  const gated = await gate({ req, res, path, bound, appHosts, commandRequest, commandRefusal, mount });
  /* The gate's decision, on the request's span: allowed or refused, and
     whether anyone was signed in. Never who: that stays local, for the dev
     observer's access view. */
  currentSpan()?.event('mistri.auth.decision', {
    'mistri.auth.outcome': gated ? 'allowed' : 'refused',
    ...(gated ? { 'mistri.auth.signed_in': gated.identity.id !== undefined } : { 'http.response.status_code': res.statusCode }),
  });
  if (!gated) return undefined;
  const { identity } = gated;
  currentSpan()?.detail(() => ({ identity: { account: identity.id, who: identity.who, role: identity.role } }));
  // Whether a refusal may tell this reader its cause (refusalReport.ts).
  noteAuthorRequest(
    req,
    bound,
    identity.id !== undefined && administersAccounts(identity.role),
    (appHosts ?? []).map((host) => host.app),
  );
  const appConfigured = Boolean(appHosts?.length);
  return {
    req,
    res,
    url,
    path,
    registry,
    configViews: serving.views ?? [],
    configPath: serving.configPath,
    bound,
    configQueries: serving.queries ?? [],
    configPages,
    configLayouts: serving.layouts ?? [],
    appHosts,
    commands,
    policy,
    policyUnavailable,
    diagnostics,
    jobs,
    commandRequest,
    commandRefusal,
    mount,
    ...gated,
    /* Whether the browser on this listener is the operator — see `clientTrusted`.
       Decided once per request and consulted by every route that takes a
       database address, a file path, or a place to write from the client. */
    trusted: clientTrusted(bound),
    appConfigured,
    freshness,
    /* Who this request's writes are, for the record history: the verified
       session's account (or the operator's proxy header in the Workbench),
       set here for everything below and never read from a body. A public form
       is nobody's, even for a signed-in caller, as its principal is. */
    attribution: {
      actor: appConfigured ? accountOf(identity) : identity.who?.trim() || undefined,
      ...(appConfigured && identity.name?.trim() ? { name: identity.name.trim() } : {}),
      via: appConfigured ? ('app' as const) : ('workbench' as const),
    },
  };
}

/** The routes before the row policy: none of them reads an App's rows as the person asking. */
const OPEN_ROUTES: readonly Route<Admitted>[] = [
  /* What a crawler asks first: read as the public principal, whoever asks (sitemap.ts). */
  (ctx) => seoRoutes(ctx),
  /* A link preview's picture, the same way (shareCard.ts). */
  async (ctx) => {
    if (ctx.path !== SHARE_CARD_PATH) return false;
    await shareCardRoute(ctx);
    return true;
  },
  // Static landings still need no source. A record-backed landing obtains its
  // public presentation through an explicit authorized owner first.
  async (ctx) => {
    if (ctx.path !== LANDING_PATH) return false;
    const branding = ctx.req.method === 'GET' || ctx.req.method === 'HEAD' ? await requestRecordBranding(ctx, undefined, true) : undefined;
    return landingRoute({ ...ctx, branding });
  },
  /* An administrator's accounts screen reads and writes the auth store alone,
     never the App's rows, so it answers before any source or row policy. */
  (ctx) => accountRoutes(ctx),
  /* Before any route can write: the tables this App's history pages keep
     are bound to their adapters (recordHistory.ts). Once per load. */
  /* And the tables whose writes tell people (inbox.ts), for the same reason. */
  async (ctx) => {
    for (const host of ctx.appHosts ?? []) {
      await ensureAppRecordHistory(ctx.registry, host);
      await ensureAppInbox(ctx.registry, host);
      /* And the databases live sync announces their writes from (live/liveBinding.ts): marked only, nothing opened. */
      ensureAppLive(ctx.registry, host);
    }
    return false;
  },
  /* The assistant's own routes read no rows: what it reads goes back through
     this dispatcher as this request (the loop), row policy and all. */
  (ctx) => assistantRoutes(ctx, () => loopback(ctx, ctx.configPages)),
  /* The embed's boot, with its first answers (embed/boot.ts): asked through
     the same loop, as this request, so it carries nothing a fetch would not
     be given. What a served page would not carry, it does not either. */
  async (ctx) =>
    ctx.path === EMBED_BOOT_PATH &&
    (await embedBootRoute(
      {
        req: ctx.req,
        res: ctx.res,
        url: ctx.url,
        path: ctx.path,
        signedIn: ctx.identity.id !== undefined,
        carries: (asked) =>
          !placedPublicFormPage(asked, ctx.policy?.publicPlacement?.isPlacedForm) &&
          !ctx.appHosts?.some((host) => recordBrandingSpec(host.app.app)),
      },
      () => loopback(ctx, ctx.configPages),
    )),
  // Public forms have their own deployment capability and always a public
  // principal, even for signed-in callers. They must not borrow account rows.
  (ctx) => readsAs(ctx.freshness, () => attributeWrites({ via: 'form' }, () => publicFormRoutes(ctx))),
  /* A public page's door (pageCommandRoutes.ts): the public principal again, whoever asks. */
  (ctx) => readsAs(ctx.freshness, () => attributeWrites({ via: 'form' }, () => pageCommandRoutes(ctx))),
];

/** The routes under the row policy, when the deployment has one. The last answers whatever is left. */
const ROUTES: readonly Route<RequestContext>[] = [
  (ctx) => scopedWriteRoutes(ctx),
  (ctx) => operationsRoutes(ctx),
  /* Live sync's stream: the reader's authority, resolved here under the row policy where there is one. */
  (ctx) => liveRoute(ctx),
  /* A command a free-form page runs says so (x-mistri-page): one its page does not declare is refused (pageLoad.ts). */
  async (ctx) => {
    let pageCommand: unknown;
    const pageHeader = ctx.req.headers[PAGE_HEADER];
    if (ctx.commandRequest && pageHeader !== undefined && ctx.signedIn?.app) {
      pageCommand = await commandBody(ctx.req);
      const refused = pageManifestRefusal({
        app: ctx.signedIn.app.app,
        roles: sessionRoles(ctx.identity.role),
        header: pageHeader,
        path: ctx.path,
        body: pageCommand && typeof pageCommand === 'object' ? (pageCommand as Record<string, unknown>) : {},
      });
      if (refused) {
        send(ctx.res, refused.status, refused.body);
        return true;
      }
    }
    return commandRoutes(ctx, pageCommand);
  },
  (ctx) => appConnectionRoutes(ctx),
  (ctx) => importRoutes(ctx),
  /* Everything else that takes a body, on the source the body names (dataRoutes.ts), with the App's hooks. */
  async (ctx) => {
    if (ctx.req.method !== 'POST' || !ctx.path.startsWith('/api/')) return false;
    await postData(ctx, APP_DATA);
    return true;
  },
  /* Only the API needs a database. Resolving before the static handler at the
     bottom meant `GET /` — the page itself — answered 409 "No connection is
     open" when there was nothing to open, so the one screen that could have
     asked for a connection was the one screen behind the requirement. */
  // A custom component's code and the host modules it imports (componentRoutes.ts).
  async (ctx) => !ctx.path.startsWith('/api/') && (await componentRoutes(ctx)),
  // A theme's font files (fontRoutes.ts): the App's own, from its own origin.
  (ctx) =>
    !ctx.path.startsWith('/api/') && fontRoute(ctx, ctx.path, (id) => ctx.appHosts?.find((host) => host.app.app.id === id)?.app.fonts),
  // Its logo's pictures (brandRoutes.ts), the same way.
  (ctx) =>
    !ctx.path.startsWith('/api/') && brandRoute(ctx, ctx.path, (id) => ctx.appHosts?.find((host) => host.app.app.id === id)?.app.brand),
  async (ctx) => {
    if (ctx.path.startsWith('/api/')) return false;
    await serveShell(ctx);
    return true;
  },
  /* A read of the API, on the source its query names. */
  async (ctx) => {
    await getData(ctx, APP_DATA);
    return true;
  },
];

/**
 * The routes in the row policy's context, where the deployment has one: the
 * context the policy owner issues for this request (and checks against the
 * gate's own reading of who is asking), and the mapping of what a write or
 * an import failed with inside it. Without one, the routes simply run.
 */
async function underPolicy(ctx: Admitted, routes: (policyContext?: AppPolicyContext) => Promise<void>): Promise<void> {
  const { req, res, url, path, identity, signedIn, policy, policyUnavailable, appHosts, commandRequest, commandRefusal, freshness } = ctx;
  const run = (policyContext?: AppPolicyContext) => readsAs(freshness, () => attributeWrites(ctx.attribution, () => routes(policyContext)));
  if (!(path.startsWith('/api/') && (policyUnavailable || policy || appHosts?.some((host) => isRowPolicyApp(host.app.app))))) return run();
  res.setHeader('cache-control', 'no-store');
  if (policyUnavailable || !policy || appHosts?.length !== 1 || !signedIn?.auth || !policy.matches(signedIn.app.app)) {
    if (commandRequest) return commandRefusal('temporarily_unavailable');
    return send(res, 503, {
      error:
        typeof policyUnavailable === 'string'
          ? policyUnavailable
          : 'Application policy is unavailable. Restart with a valid policy configuration.',
    });
  }
  if (!httpRowPolicyAllows(req.method, path, policy.commands !== undefined)) {
    if (commandRequest) return commandRefusal('forbidden');
    return send(res, 403, { error: 'This operation is unavailable in a row-policy application.' });
  }
  if (url.searchParams.has('conn') || (url.searchParams.has('app') && url.searchParams.get('app') !== policy.appId)) {
    if (commandRequest) return commandRefusal('forbidden');
    return send(res, 400, { error: 'This request must identify the policy application.' });
  }
  const deferred: { reply?: () => void } = {};
  policyResponses.set(res, deferred);
  try {
    await policy.withContext(req, async (context) => {
      // Session verification belongs to the deployment. If it changed during
      // the outer auth check, do not mix its rows with the earlier account/UI.
      const roles = [
        ...new Set(
          (identity.role ?? '')
            .split(',')
            .map((role) => role.trim())
            .filter(Boolean),
        ),
      ].sort();
      if (context.principal.kind === 'public') {
        /* The deployment answered this as a signed-out visitor at an App
           with `auth.public`. The same cross-check applies, in the only
           form it can take here: the gate must agree that nobody is
           signed in. A session that appeared between the two is a
           disagreement, and a disagreement is a denial. */
        if (identity.id !== undefined || roles.length || context.principal.appId !== signedIn.app.app.id) throw new AppAccessDenied();
      } else if (
        context.principal.id !== identity.id ||
        context.principal.appId !== signedIn.app.app.id ||
        JSON.stringify([...context.principal.roles].sort()) !== JSON.stringify(roles)
      )
        throw new AppAccessDenied();
      return run(context);
    });
  } catch (error) {
    // Preserve executor-confirmed outcomes. Before the executor can establish
    // receipt absence, even a refusal cannot claim that an earlier attempt did
    // not commit. The outer command formatter supplies that conservative error.
    if (commandRequest) throw error;
    /* A write that waited out another transaction's lock rolled back:
       nothing landed, and the same request can simply be sent again. */
    if (['/api/update', '/api/insert', FILE_UPLOAD_PATH, '/api/delete', '/api/import'].includes(path) && lockTimedOut(error)) {
      policyResponses.delete(res);
      return sendRowLocked(
        res,
        path === '/api/delete' ? { deleted: false } : path === '/api/import' ? { rows: 0, ready: 0, refused: [] } : {},
      );
    }
    /* The pool had no connection for it: it never began, and says so. */
    if (['/api/update', '/api/insert', FILE_UPLOAD_PATH, '/api/delete', '/api/import', '/api/revert'].includes(path) && isPoolBusy(error)) {
      policyResponses.delete(res);
      return sendBusy(
        res,
        path === '/api/delete'
          ? { deleted: false }
          : path === '/api/import'
            ? { rows: 0, ready: 0, refused: [] }
            : path === '/api/revert'
              ? { reverted: false }
              : {},
        true,
        error,
      );
    }
    /* An import's commit is one scoped transaction: refused, it wrote
       nothing; uncertain, it says so. Never the provider's own words. */
    if (path === '/api/import' && !(error instanceof AppAccessDenied) && !(error instanceof HttpError)) {
      policyResponses.delete(res);
      const rejected =
        error instanceof WriteConflict ||
        error instanceof Refusal ||
        (!(error instanceof TransactionOutcomeUnknown) && writeFailureOutcome(error) === 'rejected');
      const said = rejected
        ? 'Nothing was imported: a row is not allowed under the current permissions or record state. Check the file again.'
        : 'The import could not be confirmed. Refresh the list before trying again.';
      const cause = reportRefusal(req, rejected ? 400 : 503, rejected ? 'not_applied' : 'unknown', said, error);
      return send(res, 200, {
        outcome: rejected ? 'not_applied' : 'unknown',
        rows: 0,
        ready: 0,
        refused: [],
        error: said,
        ...(cause ? { cause } : {}),
      });
    }
    if (['/api/update', '/api/insert', FILE_UPLOAD_PATH, '/api/delete', '/api/revert'].includes(path)) {
      // Keep write uncertainty intact across the context's drain. Refusal
      // messages from providers/adapters can contain private schema details.
      policyResponses.delete(res);
      /* The App's own rules refusing the record, or one of its lines: the person's to fix, said by field
         with the rule's own sentence, as the single-App host and a tenant lease say it (appErrors.ts). */
      if (error instanceof AppValidationDenied && (path === '/api/insert' || path === '/api/update')) {
        const failure = appError(error, 'write');
        return send(res, error instanceof ConsumesRefused ? 422 : 200, {
          code: failure.code,
          message: failure.message,
          error: failure.message,
          errors: [failure],
          outcome: 'rejected',
        });
      }
      const conflict = error instanceof WriteConflict;
      const denied = error instanceof AppAccessDenied;
      const rejected =
        conflict ||
        denied ||
        error instanceof Refusal ||
        error instanceof HttpError ||
        (!(error instanceof TransactionOutcomeUnknown) && writeFailureOutcome(error) === 'rejected');
      const outcome = rejected ? (path === '/api/revert' ? 'not_applied' : 'rejected') : 'unknown';
      const failure = rejected
        ? {
            code: conflict ? 'record_conflict' : denied ? 'forbidden' : 'validation_failed',
            /* The rule that refused, where the code that refused said it (sayRefusal): the role, a column, the row
               policy. Otherwise the fixed sentence, and the server's log names the cause. */
            message: conflict
              ? new WriteConflict().message
              : (refusalSaid(error) ?? 'The change is unavailable under the current permissions or record state.'),
          }
        : {
            code: 'write_unconfirmed',
            message: 'The change could not be confirmed. Refresh and reconcile the record before trying again.',
          };
      const status = denied ? 403 : conflict ? 409 : rejected ? 400 : 200;
      const cause = reportRefusal(req, rejected ? status : 503, failure.code, failure.message, error);
      /* One refusal body for every route: the code and message at the top, as a command's say them, and errors[]
         for the readers of a write's per-field list. */
      return send(res, status, {
        ...(path === '/api/revert' ? { reverted: false } : path === '/api/delete' ? { deleted: rejected ? false : null } : {}),
        code: failure.code,
        message: failure.message,
        error: failure.message,
        errors: [failure],
        outcome,
        ...(cause ? { cause } : {}),
      });
    }
    // A provider can throw Refusal too; its private message is not a public
    // validation diagnostic. Buffered handler replies are discarded on error.
    if (error instanceof AppAccessDenied || error instanceof HttpError || isPoolBusy(error)) throw error;
    // The replacement keeps what it replaces for the operator (refusalReport.ts).
    if (error instanceof Refusal || error instanceof PathError)
      throw recordRefusalCause(new HttpError(400, 'The scoped request could not be completed.'), error);
    throw recordRefusalCause(new Error('Application data is unavailable.'), error);
  } finally {
    policyResponses.delete(res);
  }
  if (!res.destroyed) deferred.reply?.();
}

/**
 * A page: the shell, with a public page's head written in, or a 301 to the
 * spelling of its address that is canonical (publicHead.ts). Every other
 * visitor, and every file, is the static shell as ever.
 */
const decodeSegment = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

async function serveShell(ctx: RequestContext): Promise<void> {
  const { req, res } = ctx;
  /* The pages as this request arrived with them: the head's source narrows them for its own reader. */
  const pages = ctx.configPages.slice();
  const branding = await requestRecordBranding(ctx, undefined, publicBrandingSurface(ctx.signedIn?.app.app, ctx.path));
  /* A record at an address this person is not served is sent on to theirs (personAddress.ts). */
  const theirs = await personAddress(ctx);
  if (res.destroyed || res.writableEnded) return;
  if (theirs) {
    res.writeHead(302, { location: outward(ctx.mount, theirs), 'cache-control': 'no-store' }).end();
    return;
  }
  const head = await publicHead(ctx);
  if (res.destroyed || res.writableEnded) return;
  if (head?.redirect) {
    res.writeHead(301, { location: outward(ctx.mount, head.redirect), 'cache-control': 'no-cache' }).end();
    return;
  }
  /* The served Apps' declared egress, in the page's policy (clientHttp.ts shellEgress). */
  const egress = shellEgress(
    (ctx.appHosts ?? []).map((host) => {
      const widget = challengeOf(host)?.widget?.script;
      return { ui: host.app.app.ui, components: Boolean(host.app.components), ...(widget ? { widget } : {}) };
    }),
  );
  /* Every page says where it is mounted, so the client reads and writes its
     addresses by the server's rule (client addressMount.js), and names the surface
     its inside address will draw (clientSurface.ts). */
  /* An App's page is titled with the App's name from its first byte, not
     "tablewalk" until the client boots; a public page's own title stands. */
  const segment = ctx.path.split('/')[1] ?? '';
  const served = (ctx.appHosts ?? []).find((host) => host.app.app.id === decodeSegment(segment))?.app.app;
  const named = served?.name;
  /* Who the page is drawn for, so its first paint is guessed in their theme (ui.theme.for, themeResolve.ts). */
  const audience = { public: ctx.identity.id === undefined, roles: sessionRoles(ctx.identity.role) };
  const placedFormPage = placedPublicFormPage(ctx.path, ctx.policy?.publicPlacement?.isPlacedForm);
  const mount = { base: ctx.mount.base, json: mountJson(ctx.mount) };
  /* A public page's content pane drawn on the server (publicRender.ts); a placed form owns a fresh token and never is. */
  const pane = placedFormPage ? undefined : publicPane(ctx.path, head?.page?.room, mount);
  const { page: _page, site: _site, headline: _headline, ...shellHead } = head ?? {};
  /* `?embed=frame`: an App's page in a host's iframe (clientHttp.ts withFrameAncestors), framed only by the origins listed for it. */
  const framed =
    served && ctx.url.searchParams.get('embed') === 'frame'
      ? embedDoorFor(ctx.appHosts?.find((host) => host.auth)?.auth?.embed, ctx.bound.embedOrigins)?.origins
      : undefined;
  /* `?authorize=`: an OAuth consent page (auth/oauthServer.ts). Its one button gives a token away, so nothing
     frames it, the App's own pages included: a click cannot be borrowed through an overlay. */
  const consenting = ctx.url.searchParams.has('authorize');
  if (consenting) res.setHeader('x-frame-options', 'DENY');
  return serveClient(CLIENT_FILES, req, res, {
    ...(consenting ? { unframed: true } : framed?.size ? { frameAncestors: [...framed].sort() } : {}),
    ...(named ? { title: branding?.value.content.name ?? named } : {}),
    ...shellHead,
    ...(branding ? { branding } : {}),
    ...(await socialHead(ctx, head, branding)),
    ...(pane ? { pane } : {}),
    ...(head?.canonical ? { canonical: outward(ctx.mount, head.canonical) } : {}),
    ...(egress ? { egress } : {}),
    mount,
    path: ctx.path,
    looks: lookSheetsFor(served?.ui, audience),
    faces: lookFacesFor(served?.ui, audience),
    appFaces: appFaceHead(served?.ui, (href) => outward(ctx.mount, href), audience),
    density: branding?.value.theme.density ?? lookDensityFor(served?.ui, audience),
    scheme: branding ? branding.value.theme.scheme : lookSchemeFor(served?.ui, audience),
    grounds: branding ? groundsOf(branding.value.theme) : lookGroundsFor(served?.ui, audience),
    /* Read as the client's first words will be (messages.ts setMessageScope): a guess wrong only by a fetch. */
    ...(served ? { locale: requestLocale(served, { visitor: ctx.identity.id === undefined, req }) } : {}),
    ...(observerMounted() ? { observe: observerHome(ctx.mount) } : {}),
    // A branding head is already the request's authorized snapshot. Its API
    // reads arrive normally, rather than loopback requests losing host intent.
    ...(!placedFormPage && !branding && !ctx.appHosts?.some((host) => recordBrandingSpec(host.app.app))
      ? {
          data: async () => {
            const page = await firstPaint({ path: ctx.path, search: ctx.url.search, loop: loopback(ctx, pages), rooms: APP_PAINT_ROOMS });
            /* The answers by request, for a pane the server draws from them: exactly what the client will read. */
            return page.json
              ? {
                  block: firstPaintBlock(FIRST_PAINT_ELEMENT, page.json),
                  ...(pane ? { answers: (JSON.parse(page.json) as { reads: Record<string, { body: unknown }> }).reads } : {}),
                }
              : undefined;
          },
        }
      : {}),
  });
}

/**
 * What a link preview reads of a public page (clientHttp.ts socialMeta):
 * absolute addresses, from the origin this request was made to — a
 * white-label host's page names its own host. The picture is the page's
 * share card (shareCard.ts), drawn from these same words in the App's look,
 * except on a record with a photo of its own, which is the better picture of
 * it; where this server draws no card, the page's first photo, at the width
 * previews draw, or none.
 */
async function socialHead(
  ctx: RequestContext,
  head: ShellHead | undefined,
  branding: BrandingPresentation | undefined,
): Promise<{ social?: SocialHead }> {
  const origin = head?.canonical && head.title && head.site ? requestOrigin(ctx.req, ctx.bound) : undefined;
  if (!origin || !head?.canonical || !head.title || !head.site) return {};
  const image = head.page?.image;
  const title = socialTitle(head);
  const description = head.page?.description?.slice(0, 300);
  const photo = image ? { image: `${origin}${image.src.replace(/&variant=[^&]*/, '')}&w=1280`, imageAlt: image.alt } : undefined;
  const app = ctx.signedIn?.app.app;
  const card =
    app && !(photo && head.page?.room?.kind === 'record')
      ? await shareCardImage(
          origin,
          ctx.mount,
          head.canonical,
          shareCard({
            site: head.site,
            title,
            ...(description ? { summary: description } : {}),
            ui: app.ui,
            ...(branding ? { branding } : {}),
          }),
          catalogLocales(app).length > 1 ? requestLocale(app, { visitor: true, req: ctx.req }) : undefined,
        ).catch(() => undefined)
      : undefined;
  return {
    social: {
      url: origin + outward(ctx.mount, head.canonical),
      title,
      site: head.site,
      type: head.page?.room?.kind === 'record' ? 'article' : 'website',
      ...(description ? { description } : {}),
      ...(card ? { image: card, imageAlt: title } : (photo ?? {})),
    },
  };
}

/** A page's name as a preview says it: the landing's heading, else the title without the site after it, which the preview says on its own line. */
const socialTitle = (head: ShellHead) =>
  head.headline ?? (head.title!.endsWith(` · ${head.site}`) ? head.title!.slice(0, -(head.site!.length + 3)) : head.title!);

/**
 * `/api/og?path=…&v=…`: the card of the public page at `path`, read as the
 * public principal whoever asks — the head the page's signed-out visitor is
 * given, and the branding they are shown — so a signed-in member's grants
 * never reach a picture anyone may fetch.
 */
async function shareCardRoute(ctx: GatedContext): Promise<void> {
  const asked = ctx.req.method === 'GET' || ctx.req.method === 'HEAD' ? cardRequest(ctx.url) : undefined;
  const app = ctx.signedIn?.app.app;
  let card;
  if (asked && app) {
    /* Said in the locale the card's address names, or the App's own: never the fetcher's Accept-Language, so one
       address is one picture to every cache (shareCard.ts shareCardImage). The request itself is asked, as its host
       mapping is kept by it; its headers are its own again once the card's words are read. */
    const sent = ctx.req.headers;
    const { 'accept-language': _asked, ...headers } = sent;
    ctx.req.headers = asked.locale ? { ...headers, 'accept-language': asked.locale } : headers;
    try {
      const visitor = { ...ctx, identity: {}, path: asked.inside.pathname, url: asked.inside };
      const head = await publicHead(visitor, true).catch(() => undefined);
      if (head?.title && head.site && head.canonical && !head.redirect) {
        const branding = await requestRecordBranding(visitor, undefined, true).catch(() => undefined);
        const description = head.page?.description?.slice(0, 300);
        card = shareCard({
          site: head.site,
          title: socialTitle(head),
          ...(description ? { summary: description } : {}),
          ui: app.ui,
          ...(branding ? { branding } : {}),
        });
      }
    } finally {
      ctx.req.headers = sent;
      unvaryOnLanguage(ctx.res);
    }
  }
  if (ctx.res.destroyed || ctx.res.writableEnded) return;
  return sendShareCard(ctx.req, ctx.res, card, asked?.version);
}

/**
 * The dispatcher, asked by the server on a page's behalf (firstPaint.ts):
 * the whole of `handle` — the gate, the row policy, the routes — for the
 * request a fetch from that page would make, answered into memory.
 */
function loopback(ctx: GatedContext, pages: PageDef[]): Loop {
  return async (method, target, body, signal) => {
    if (signal?.aborted || ctx.res.destroyed) return undefined;
    const form = /^\/api\/forms\/([a-z0-9][a-z0-9-]{0,63})(?:\?|$)/.exec(target);
    if (method === 'GET' && form && ctx.policy?.publicPlacement?.isPlacedForm(form[1])) return undefined;
    const request = loopbackRequest(ctx.req, method, target, body);
    inheritTenantHostIntent(ctx.req, request);
    const reply = new CapturedReply();
    // Routes cancel their reads on response close, just as for a disconnected fetch.
    const cancel = () => {
      request.destroy();
      reply.destroy();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    ctx.res.once('close', cancel);
    try {
      await handle(request, reply.asResponse(), new URL(target, 'http://localhost'), {
        registry: ctx.registry,
        views: ctx.configViews,
        configPath: ctx.configPath,
        bound: ctx.bound,
        queries: ctx.configQueries,
        pages,
        layouts: ctx.configLayouts,
        apps: ctx.appHosts,
        commands: ctx.commands,
        policy: ctx.policy,
        policyUnavailable: ctx.policyUnavailable,
        diagnostics: ctx.diagnostics,
        jobs: ctx.jobs,
        mount: ctx.mount,
      });
    } catch {
      return undefined;
    } finally {
      signal?.removeEventListener('abort', cancel);
      ctx.res.off('close', cancel);
    }
    if (reply.destroyed || signal?.aborted) return undefined;
    const answer = reply.answer();
    if (!answer) return undefined;
    const account = reply.getHeader('x-mistri-account');
    return {
      ...answer,
      ...(typeof account === 'string' ? { account } : {}),
      carriable: !reply.hasHeader('set-cookie') && !reply.hasHeader('x-mistri-search'),
    };
  };
}
