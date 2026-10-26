/**
 * Every request the database browser's HTTP server answers, as one ordered
 * dispatcher: the door (door.ts — the Host, the proxy's identity, then a
 * write's Origin and body; the database browser has no session of its own),
 * then its routes in order — what a crawler asks, connection management, a
 * POST on the source its body names and a GET on the one its query names
 * (dataRoutes.ts, with this product's hooks), and the shell for a page.
 *
 * Nothing here loads the App framework: an App's sign-in, row policy,
 * commands, public pages and forms are the App framework's dispatcher's
 * (handler.ts). This product's rules are its hooks below — the connection's
 * `writable` flag and the reader's grant on a write, every write journaled
 * for Undo, the schema's suggested page — and nothing else.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { attributeWrites } from '@mistriwork/engine/adapters/writeAttribution.js';
import { readsAs } from '@mistriwork/engine/adapters/replicas.js';
import { currentSpan } from '@mistriwork/engine/adapters/telemetry/trace.js';
import { serveClient } from '@mistriwork/engine/server/clientHttp.js';
import { CLIENT_FILES } from '../clientFiles.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { RequestDiagnostics } from '@mistriwork/engine/server/operations/diagnostics.js';
import { FIRST_PAINT_ELEMENT } from '@mistriwork/engine/shared/firstPaint.js';
import { mountJson, NO_MOUNT, type AddressMount } from '@mistriwork/engine/shared/mount.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import { suggestPage } from '@mistriwork/engine/shared/page.js';
import type { ConfigLayout } from '@mistriwork/engine/shared/recordview.js';
import type { SavedQuery } from '@mistriwork/engine/shared/sqlsaved.js';
import type { ViewDef } from '@mistriwork/engine/shared/view.js';
import { BROWSER_PAGES, authoringRoutes } from './authoringRoutes.js';
import { CapturedReply } from '@mistriwork/engine/server/http/captured.js';
import { resolveConnectionSource } from '@mistriwork/engine/server/http/connectionSource.js';
import { connectionRoutes } from './connectionRoutes.js';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import { closedToCrawlers } from '@mistriwork/engine/server/http/crawlerText.js';
import { getData, postData, type DataHooks } from '@mistriwork/engine/server/http/dataRoutes.js';
import { BROWSER_WRITES, dataWriteRoutes } from './dataWriteRoutes.js';
import { door } from '@mistriwork/engine/server/http/door.js';
import { firstPaint, firstPaintBlock, loopbackRequest, type Loop } from '@mistriwork/engine/server/http/firstPaint.js';
import { httpOperationRoutes } from '@mistriwork/engine/server/http/httpOperationRoutes.js';
import { readFreshness } from '@mistriwork/engine/server/http/readRouting.js';
import { noteAuthorRequest } from '@mistriwork/engine/server/http/refusalReport.js';
import { send } from '@mistriwork/engine/server/http/reply.js';
import { route, type Route } from '@mistriwork/engine/server/http/router.js';
import { clientTrusted, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { workbenchReads } from './workbenchReads.js';

/**
 * What the database browser serves, as `createBrowserApp` (browserServer.ts)
 * was given it: read on every request and changed by none. A loopback
 * request (firstPaint.ts) is the same server asked again.
 */
interface BrowserServing {
  readonly registry: Registry;
  readonly views?: ViewDef[];
  /** The file this session read its connections from, and writes them back to. */
  readonly configPath?: string;
  readonly bound?: Bound;
  readonly queries?: SavedQuery[];
  readonly pages?: PageDef[];
  readonly layouts?: ConfigLayout[];
  readonly diagnostics?: RequestDiagnostics;
  /** Where it is served (shared/mount.ts): a reverse proxy's base path, and no App beneath it. */
  readonly mount?: AddressMount;
}

/** The data routes in the database browser. */
const BROWSER_DATA: DataHooks = {
  source: resolveConnectionSource,
  gates: BROWSER_WRITES.gates,
  /* An HTTP connection's operations (the API tab), the layout and page builders, the agent console's call and a view compiled without running. */
  routes: async (post) => (await httpOperationRoutes(post)) || (await authoringRoutes(post)),
  /* Raw SQL and Undo. */
  later: dataWriteRoutes,
  /* It exports every table it reads, as stored. */
  exports: { may: () => () => true },
  pages: BROWSER_PAGES,
  /* Every part of a record page is asked: there is no sign-in, no row policy and no App. */
  compose: { mayAsk: () => true, resources: () => ({}), suggested: (source, table) => suggestPage(source.schema, table) },
  read: { projection: workbenchReads },
};

/** Its routes, tried in order; the last answers whatever is left. */
const ROUTES: readonly Route<RequestContext>[] = [
  /* An operator's reads (readiness, the support bundle, workflows) are an authenticated App host's: an
     unauthenticated host says nothing about itself, and says so uncached, as an App server without sign-in does. */
  (ctx) => {
    if (ctx.path !== '/api/operations' && !ctx.path.startsWith('/api/operations/')) return false;
    ctx.res.setHeader('cache-control', 'no-store');
    send(ctx.res, 404, { error: 'Operator reads are available only on an authenticated App host.' });
    return true;
  },
  (ctx) => connectionRoutes(ctx),
  /* Everything else that takes a body, on the source the body names (dataRoutes.ts). */
  async (ctx) => {
    if (ctx.req.method !== 'POST' || !ctx.path.startsWith('/api/')) return false;
    await postData(ctx, BROWSER_DATA);
    return true;
  },
  /* Only the API needs a database: the page itself is served with nothing open, so the one screen that can ask for a connection is not behind the requirement. */
  async (ctx) => {
    if (ctx.path.startsWith('/api/')) return false;
    await serveShell(ctx);
    return true;
  },
  /* A read of the API, on the source its query names. */
  async (ctx) => {
    await getData(ctx, BROWSER_DATA);
    return true;
  },
];

/**
 * Every request: the door, then the routes. Who asked is the operator's proxy
 * header where one is configured, and a write is theirs in the record's
 * history and the Undo journal.
 */
export async function handleBrowser(req: IncomingMessage, res: ServerResponse, url: URL, serving: BrowserServing): Promise<void> {
  const { registry, diagnostics } = serving;
  const bound = serving.bound ?? { host: '127.0.0.1', port: 4111 };
  const mount = serving.mount ?? NO_MOUNT;
  const path = url.pathname;
  /* Whether this browser wrote a moment ago: if so its reads go to the primary, so a save shows in the list it returns to (replicas.ts). */
  const freshness = readFreshness(req, res, mount.base);
  const opened = await door(
    {
      req,
      res,
      bound,
      /* The API in JSON; a page in a line of text, since no script is there to read JSON. A write's Origin is only ever asked of the API. */
      refuse: (check, status, error) => {
        if (check === 'origin' || path.startsWith('/api/')) send(res, status, { error });
        else {
          res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`${error}\n`);
        }
      },
    },
    { admit: async () => true },
  );
  /* The door's decision, on the request's span: allowed or refused. Never who. */
  currentSpan()?.event('tablewalk.auth.decision', {
    'tablewalk.auth.outcome': opened ? 'allowed' : 'refused',
    ...(opened ? { 'tablewalk.auth.signed_in': false } : { 'http.response.status_code': res.statusCode }),
  });
  if (!opened) return;
  const { identity } = opened;
  currentSpan()?.detail(() => ({ identity: { who: identity.who } }));
  // Whether a refusal may tell this reader its cause (refusalReport.ts): nobody here administers accounts.
  noteAuthorRequest(req, bound, false, []);
  const ctx: RequestContext = {
    req,
    res,
    url,
    path,
    registry,
    configViews: serving.views ?? [],
    configPath: serving.configPath,
    bound,
    configQueries: serving.queries ?? [],
    configPages: (serving.pages ?? []).slice(),
    configLayouts: serving.layouts ?? [],
    policyUnavailable: false,
    diagnostics,
    /* No route here is a command's. */
    commandRequest: false,
    commandRefusal: () => send(res, 404, { error: `No such endpoint: ${path}` }),
    mount,
    identity,
    /* Whether the browser on this listener is the operator — see `clientTrusted`.
       Decided once per request and consulted by every route that takes a
       database address, a file path, or a place to write from the client. */
    trusted: clientTrusted(bound),
    appConfigured: false,
  };
  if (closedToCrawlers(req, res, path)) return;
  /* Who this request's writes are, for the record history: the operator's proxy header, never a body. */
  const attribution = { actor: identity.who?.trim() || undefined, via: 'workbench' as const };
  await readsAs(freshness, () => attributeWrites(attribution, () => route(ctx, ROUTES)));
}

/**
 * A page: the shell, with what the page will first ask already answered
 * (firstPaint.ts), asked of this dispatcher through its own loop.
 */
async function serveShell(ctx: RequestContext): Promise<void> {
  const { req, res } = ctx;
  const pages = ctx.configPages.slice();
  /* `?authorize=`: an OAuth consent page's address. Its one button gives a token away, so nothing frames it. */
  const consenting = ctx.url.searchParams.has('authorize');
  if (consenting) res.setHeader('x-frame-options', 'DENY');
  return serveClient(CLIENT_FILES, req, res, {
    ...(consenting ? { unframed: true } : {}),
    /* Every page says where it is mounted, so the client reads and writes its addresses by the server's rule (client addressMount.js). */
    mount: { base: ctx.mount.base, json: mountJson(ctx.mount) },
    path: ctx.path,
    /* The Workbench's page: its chunks, and the meta that starts its main rather than an App's (clientSurface.ts). */
    workbench: true,
    looks: [],
    faces: [],
    appFaces: '',
    data: async () => {
      const page = await firstPaint({ path: ctx.path, search: ctx.url.search, loop: loopback(ctx, pages) });
      return page.json ? { block: firstPaintBlock(FIRST_PAINT_ELEMENT, page.json) } : undefined;
    },
  });
}

/**
 * The dispatcher, asked by the server on a page's behalf (firstPaint.ts):
 * the whole of `handleBrowser` for the request a fetch from that page would
 * make, answered into memory.
 */
function loopback(ctx: RequestContext, pages: PageDef[]): Loop {
  return async (method, target, body, signal) => {
    if (signal?.aborted || ctx.res.destroyed) return undefined;
    const request = loopbackRequest(ctx.req, method, target, body);
    const reply = new CapturedReply();
    // Routes cancel their reads on response close, just as for a disconnected fetch.
    const cancel = () => {
      request.destroy();
      reply.destroy();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    ctx.res.once('close', cancel);
    try {
      await handleBrowser(request, reply.asResponse(), new URL(target, 'http://localhost'), {
        registry: ctx.registry,
        views: ctx.configViews,
        ...(ctx.configPath === undefined ? {} : { configPath: ctx.configPath }),
        bound: ctx.bound,
        queries: ctx.configQueries,
        pages,
        layouts: ctx.configLayouts,
        ...(ctx.diagnostics ? { diagnostics: ctx.diagnostics } : {}),
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
    return { ...answer, carriable: !reply.hasHeader('set-cookie') && !reply.hasHeader('x-mistri-search') };
  };
}
