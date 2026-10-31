/**
 * An App's part of the door (http/door.ts holds its order: the Host, the
 * proxy identity, this, then a write's Origin): a host's preflight and
 * bearer, a public storefront's anonymity, the hosting precondition, and the
 * session gate of an App that signs people in, with the public forms, landing
 * and reads a signed-out person may reach. Returns what it established, or
 * `undefined` when it already answered — in which case the caller is done.
 */
import { validateHeaderValue } from 'node:http';
import { authHoldsOwnProof, signInInfo } from '../auth/auth.js';
import { publicHome } from '../../shared/appHome.js';
import { isPublicForm, type AppFormView } from '../../shared/app.js';
import { AppAccessDenied } from '@mistriwork/engine/server/columnGrants.js';
import { PoolBusy } from '@mistriwork/engine/adapters/poolMetrics.js';
import { databaseUnanswered } from '@mistriwork/engine/server/evidence.js';
import { appHostingError } from '../app/appEntrypoint.js';
import { snapshotScopedData } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import { doorRefusal, writes } from '@mistriwork/engine/server/http/trust.js';
import { door } from '@mistriwork/engine/server/http/door.js';
import { answerPreflight, embedDoor, embedDoorFor } from '../embed/crossOrigin.js';
import { EMBED_BOOT_PATH } from '../../shared/embedProtocol.js';
import { send } from '@mistriwork/engine/server/http/reply.js';
import { publicFormPath, publicForms } from './formRoutes.js';
import { publicPageCommandRoute } from './pageCommandRoutes.js';
import { savedFormAction } from '../forms/savedFormHttp.js';
import { burnClaimsOnSignOut } from '../forms/formLink.js';
import { secureRequest } from '../forms/savedForms.js';
import { LANDING_PATH } from './landingRoutes.js';
import { SHARE_CARD_PATH } from './shareCard.js';
import type { GateInput, GateResult, Identity } from '@mistriwork/engine/server/http/context.js';
import type { AppHost } from '../app/apps.js';
import { appLook } from '../../shared/appUi.js';
import { withIconGlyphs } from '../app/iconPayload.js';
import { arrivedUrls } from '@mistriwork/engine/server/http/context.js';
import { getTenantHostIntent } from './tenantHosts.js';

/**
 * The one API a signed-out person may reach on an App that signs people in,
 * besides who-am-I and the landing: its public forms, and only the ones it
 * declares. `/api/forms` when it declares any, and `/api/forms/<key>` for a
 * form that says `public: true` — nothing under them, nothing beside them,
 * never a signed-in form's key; an App without one opens none of it.
 */
export function publicFormRoute(host: AppHost | undefined, path: string): boolean {
  const match = publicFormPath(path);
  if (!match || !host) return false;
  const { views } = host.app.app;
  if (match.id === undefined) return publicForms(host.app.app).length > 0;
  if (!Object.hasOwn(views, match.id) || !isPublicForm(views[match.id])) return false;
  // A multistep form's step check (formRoutes.ts), for a step it has.
  if (match.action === 'check')
    return ((views[match.id] as AppFormView).steps ?? []).some((step) => (step as { id: string }).id === match.step);
  // Under a form's key only the paths a saved form serves: its steps, its resume and its status check.
  return match.action === undefined || savedFormAction(views[match.id] as AppFormView, match) !== undefined;
}

/**
 * The public landing, the other signed-out API: `/api/landing` exactly, and
 * only when the App declares a landing view. It answers content the author
 * wrote and reads no data, so it is open on a row-policy App too. The page
 * that draws it is a static file like the sign-in screen, served at every
 * path already; this is the one read it makes.
 */
export function publicLandingRoute(host: AppHost | undefined, path: string): boolean {
  return Boolean(host?.app.app.landing) && path === LANDING_PATH;
}

/**
 * A public page's share card (shareCard.ts), where the App has public pages:
 * `/api/og` exactly. It draws only what its route reads as the public
 * principal, whoever asks, so a signed-out ask reaches no more than a
 * signed-in one.
 */
function publicCardRoute(host: AppHost | undefined, path: string): boolean {
  return path === SHARE_CARD_PATH && Boolean(host?.app.app.auth?.public || host?.app.app.landing);
}

/* The reads a signed-out visitor makes, where the App opens resources to the
   public: the App, its schema and pages, the data reads, a file's bytes. A
   public table's record opens on its suggested page, built from the visitor's
   catalog (appProjection.ts), so a visitor at `/jobs/1` reads the record
   rather than being drawn the sign-in screen. */
/* `/api/live`: a visitor is told of changes to the rows the public grant reads (live/liveRoute.ts). */
const PUBLIC_GETS = new Set(['/api/app', '/api/schema', '/api/pages', '/api/pages/suggested', '/api/runtime', '/api/file', '/api/live']);
const PUBLIC_POSTS = new Set([
  '/api/run',
  '/api/query',
  '/api/count',
  '/api/counts',
  '/api/view/run',
  '/api/breakdown',
  '/api/breakdowns',
  '/api/references',
  '/api/pages/plan',
  '/api/pages/compose',
  /* A public free-form page's loader: the route serves only a page that says `public: true` to a visitor (pageLoad.ts). */
  '/api/pages/load',
]);

/**
 * A signed-out visitor's read, in an App that says `auth.public`. It reaches
 * the source with the public grant alone (source.ts), so a table or column
 * the grant does not name is refused there as for any principal. Every
 * write, command and account route still needs a session.
 */
export function publicReadRoute(host: AppHost | undefined, method: string | undefined, path: string): boolean {
  if (!host?.app.app.auth?.public) return false;
  if (method === 'GET' || method === 'HEAD') return PUBLIC_GETS.has(path);
  return method === 'POST' && PUBLIC_POSTS.has(path);
}

/** The sign-in card a signed-out answer carries: the App's providers, drawn in its own look. */
export function signInCard(host: AppHost) {
  return { ...signInInfo(host.auth!, host.app.app.name), look: withIconGlyphs(appLook(host.app.app)) };
}

export async function gate(ctx: GateInput): Promise<GateResult | undefined> {
  const { req, res, path, bound, appHosts, commandRequest, commandRefusal } = ctx;
  /* A host on another origin that signs people in here (embed/). */
  const embed = embedDoorFor(appHosts?.find((h) => h.auth)?.auth?.embed, bound.embedOrigins);
  // A mapped storefront is a public surface, even when the browser forwards
  // staff cookies or a trusted proxy adds identity headers. Keep form draft
  // cookies intact: only native/private identity resolution is suppressed.
  const publicHost = Boolean(getTenantHostIntent(req));
  const hostingError = appHostingError(appHosts ?? []);
  const signedIn = appHosts?.find((h) => h.auth);
  const opened = await door(
    {
      req,
      res,
      bound,
      /* A command is answered in its own refusal shape; the API in JSON; a
         page in a line of text, since no script is there to read JSON. A
         write's Origin is only ever asked of the API, so its answer is JSON. */
      refuse: (check, status, error) => {
        if (commandRequest) commandRefusal(check === 'identity' ? 'unauthenticated' : 'forbidden');
        else if (check === 'origin' || path.startsWith('/api/')) send(res, status, { error });
        else {
          res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`${error}\n`);
        }
      },
    },
    {
      arrive: () => {
        /* Its preflight is answered before anything else, and only for its origins. */
        if (embed && req.method === 'OPTIONS' && answerPreflight(req, res, path, embed.origins)) return { answered: true };
        if (publicHost && req.headers.cookie) {
          // Row-policy owners independently recheck native sessions from the same
          // request. Remove only native auth cookies before those checks; saved
          // form draft/resume cookies and other public state remain available.
          req.headers.cookie = req.headers.cookie
            .split(';')
            .filter((part) => !/^(?:__Secure-|__Host-)?mistri-[^=;]+\./.test(part.trim()))
            .join(';');
        }
        return { anonymous: publicHost };
      },
      admit: (identity) => appSession(ctx, identity, { embed, publicHost, hostingError, signedIn }),
    },
  );
  return opened && { identity: opened.identity, signedIn, hostingError };
}

/**
 * The session part of an App's door (http/door.ts): the hosting precondition,
 * a host's bearer, and the sign-in of an App that signs people in — which
 * completes `identity` in place. True when the request goes on to the routes;
 * undefined when it was answered here.
 */
async function appSession(
  ctx: GateInput,
  identity: Identity,
  {
    embed,
    publicHost,
    hostingError,
    signedIn,
  }: {
    embed: ReturnType<typeof embedDoorFor>;
    publicHost: boolean;
    hostingError: string | undefined;
    signedIn: AppHost | undefined;
  },
): Promise<true | undefined> {
  const { req, res, path, bound, commandRequest, commandRefusal } = ctx;
  if (hostingError && path.startsWith('/api/')) {
    if (commandRequest) {
      commandRefusal('temporarily_unavailable');
      return undefined;
    }
    send(res, 503, { error: hostingError });
    return undefined;
  }
  /* A request from a host's origin (crossOrigin.ts) is read as the bearer it
     carries and nothing else: the cookies it brought are dropped whether or
     not it has one, so cross-origin a cookie never stands for anyone. */
  if (embed && !publicHost) await embedDoor(req, res, path, embed);
  /* An app that signs people in. Its routes are Better Auth's, mounted
     whole under /api/auth; everything else under /api needs a session,
     except the one question a signed-out client may ask — who am I — which
     answers with what the sign-in screen needs. Static files are always
     served: the sign-in screen is one of them. */
  if (signedIn?.auth) {
    const verifySession = async () => {
      if (publicHost) return null;
      try {
        return snapshotScopedData(await signedIn.auth!.session(req));
      } catch (error) {
        /* A session store that did not answer — a pool that would not lend a connection, a lookup cancelled
           (auth/authStore.ts storeFailureBeneath) — decided nothing about who is asking. Refused, it was a 403 a
           client does not retry; it is the server being busy, answered as a pool's busy is (serverCore.ts): 503 with
           Retry-After. Anything else is still refused. */
        if (databaseUnanswered(error)) throw new PoolBusy('read', 'queue_timeout', error);
        throw new AppAccessDenied();
      }
    };
    if (path === '/api/auth' || path.startsWith('/api/auth/')) {
      /* Better Auth's writes are held to the door a tenant's native host
         holds them to (tenantAuthenticatedHttp.ts), not left to its own
         `trustedOrigins` alone: the fetch site and the Origin on a write,
         but no JSON body (sign-out is bodyless, a callback a form POST), and
         not the Origin where a route holds its own proof (auth.ts). A route
         that is never posted from a page — a SCIM directory's bearer — sends
         no Origin and passes as it did. */
      const ownProof = authHoldsOwnProof(path, signedIn.auth.embed !== undefined);
      const refusal = doorRefusal(req, bound, { writing: writes(req), origin: ownProof ? 'none' : 'writes', sameSite: true, json: false });
      if (refusal) {
        send(res, 403, { error: refusal.error });
        return undefined;
      }
      if (path === '/api/auth/sign-out' && req.headers['x-mistri-account'] !== undefined) {
        const session = await verifySession();
        if (session && req.headers['x-mistri-account'] !== session.id) {
          res.setHeader('cache-control', 'no-store');
          send(res, 409, { error: 'The signed-in account changed. Reload before continuing.' });
          return undefined;
        }
      }
      // Signing out burns the claims a submit left in this browser (forms/formLink.ts).
      if (path === '/api/auth/sign-out')
        burnClaimsOnSignOut(res, signedIn.app.app, secureRequest(req, bound.trustedProxies), ctx.mount.base);
      /* Better Auth routes by the whole address, the base path with it
         (auth.ts): given back what the browser sent (server.ts). It is
         answered here, so the door's write check after the session is not
         asked of it: that one wants a JSON body. */
      req.url = arrivedUrls.get(req) ?? req.url;
      await signedIn.auth.handler(req, res);
      return undefined;
    }
    const session = await verifySession();
    /* `home` is where the App's home rules start a signed-out visitor, and
       only when that is a public view — the landing or a public form — so the
       client draws it without asking again, and an App whose signed-out
       visitors start on the sign-in screen boots on this one request. It is
       all this answer says about the App's views. */
    const signedOut = () => {
      const home = publicHome(signedIn.app.app);
      return {
        signedIn: false,
        accountId: null,
        appId: signedIn.app.app.id,
        who: null,
        header: null,
        // The App's look travels with the sign-in answer, so the door is
        // drawn in the App's own colours; a landing and a public form are
        // already told the same thing (appLook).
        signIn: signInCard(signedIn),
        ...(home === undefined ? {} : { home }),
        /* The landing's view key, where the App has one: the signed-out
           home's drawer (publicSurface.ts) matches its home against it
           instead of probing `/api/landing` for a home that is a public
           form — an App without a landing answered that probe 401. */
        ...(signedIn.app.app.landing ? { landingView: signedIn.app.app.landing.view } : {}),
        // Browsable signed out, within `auth.public`: the client boots the App, not the sign-in screen.
        ...(signedIn.app.app.auth?.public ? { public: true } : {}),
      };
    };
    if (session) {
      let validId = typeof session.id === 'string' && Boolean(session.id.trim());
      if (validId) {
        try {
          validateHeaderValue('x-mistri-account', session.id);
        } catch {
          validId = false;
        }
      }
      if (!validId && path.startsWith('/api/')) {
        if (commandRequest) {
          commandRefusal('unauthenticated');
          return undefined;
        }
        res.setHeader('cache-control', 'no-store');
        send(res, 401, { error: 'Sign in to continue.', ...signedOut() });
        return undefined;
      }
      identity.id = session.id;
      identity.who = session.who;
      identity.role = session.role;
      identity.name = session.name;
      if (session.emailVerified === true) identity.emailVerified = true;
      if (session.emailUnproven === true) identity.emailUnproven = true;
      if (validId && path.startsWith('/api/')) res.setHeader('x-mistri-account', session.id);
      // This is a stale-tab precondition, never a source of identity or grants.
      const expectedAccount = req.headers['x-mistri-account'];
      if (path.startsWith('/api/') && expectedAccount !== undefined && expectedAccount !== session.id) {
        if (commandRequest) {
          commandRefusal('stale_account');
          return undefined;
        }
        res.setHeader('cache-control', 'no-store');
        send(res, 409, { error: 'The signed-in account changed. Reload before continuing.' });
        return undefined;
      }
    } else if (
      path.startsWith('/api/') &&
      /* The embed's one boot read reads nothing itself: each answer it carries
         is asked again through the dispatcher as this request (embed/boot.ts),
         and a signed-out reader's who-am-I is one of them. */
      path !== EMBED_BOOT_PATH &&
      !publicFormRoute(signedIn, path) &&
      /* A public page's door and its ticket (pageCommandRoutes.ts), for a page that runs public commands. */
      !publicPageCommandRoute(signedIn.app.app, path) &&
      !publicLandingRoute(signedIn, path) &&
      !publicCardRoute(signedIn, path) &&
      !publicReadRoute(signedIn, req.method, path)
    ) {
      if (commandRequest) {
        commandRefusal('unauthenticated');
        return undefined;
      }
      res.setHeader('cache-control', 'no-store');
      if (path === '/api/whoami') {
        send(res, 200, signedOut());
        return undefined;
      }
      send(res, 401, { error: 'Sign in to continue.', signIn: signedOut().signIn });
      return undefined;
    }
  }

  return true;
}
