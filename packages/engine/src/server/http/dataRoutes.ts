/**
 * The data routes both products serve on a resolved source: a POST reads its
 * body once, resolves the source it names and goes to `handlePost` — the
 * page routes, an export, the resource reads (resourceReadHttp.ts), a
 * composed record page, the record writes (recordWrites.ts) — and a GET
 * goes to the reads (readRoutes.ts).
 *
 * What a product decides of them is `DataHooks`, given by its dispatcher:
 * the database browser's (browserHandler.ts) and the App framework's
 * (handler.ts). The hooks are where a product's rules enter, and the only
 * place:
 *
 *   - `gates.read`: a reader asking past what they may read (an App's
 *     signed-out visitor is asked to sign in); `gates.write`, the write gate
 *     every record write passes (the connection's `writable` flag and the
 *     reader's grant, in the product's words); `after.write`, what follows a
 *     committed write (an App's search document);
 *   - `source`: how the source is resolved (an App's resources and its
 *     reader's grants, or the connection);
 *   - the rest — the routes before and after, an export's grants, a page's
 *     anatomy, a composed page's App — each named on the hook.
 */
import type { ServerResponse } from 'node:http';
import type { Adapter } from '../../adapters/adapter.js';
import { lagTolerantReads, primaryReads } from '../../adapters/replicas.js';
import { AppAccessDenied } from '../columnGrants.js';
import { dispatchResourceReadHttp, type AppReads } from '../resourceReadHttp.js';
import { UNEXPORTED_MOST } from '../../shared/reads.js';
import { clockNow } from './clock.js';
import { sourceSelector } from './connectionSource.js';
import type { PostContext, RequestContext, ResolvedSource } from './context.js';
import { exportRoute, type ExportHooks } from './exportRoute.js';
import { pageRoutes, type PageHooks } from './pageRoutes.js';
import { readRoutes, type ReadHooks } from './readRoutes.js';
import { toleratesLag } from './readRouting.js';
import { COMPOSE_PATH, composeRecordPage, type ComposeHooks } from './recordCompose.js';
import { recordWriteRoutes, type RecordHooks } from './recordWrites.js';
import { FILE_UPLOAD_BODY, FILE_UPLOAD_PATH, httpRead, readJson, send } from './reply.js';

/** What a POST is given beside its body and source, by the product. */
type PostExtras = Partial<Pick<PostContext, 'appNow' | 'zone' | 'appHost' | 'recipient' | 'me'>>;

export interface DataHooks {
  /** The source a request names (`null`: none), resolved and leased for the request's life. */
  source(ctx: RequestContext, id: string | null | undefined): Promise<ResolvedSource>;
  readonly gates: {
    /**
     * A reader asking past what they may read — a table their catalog does
     * not hold, or (with `body`) a POST read naming one. True when it was
     * answered; otherwise a GET is refused as a table that does not exist,
     * and a POST goes on to be refused by the route that reads it.
     */
    read?(ctx: RequestContext, source: ResolvedSource, asked: { path: string; body?: Record<string, unknown> }): boolean;
    readonly write: RecordHooks['gates']['write'];
  };
  readonly after?: RecordHooks['after'];
  readonly rules?: RecordHooks['rules'];
  /** The adapter a POST's reads go through (an App's search-aware reader), into `reply`. */
  reads?(ctx: RequestContext, source: ResolvedSource, adapter: Adapter, reply: ServerResponse): Adapter;
  /** What a POST is told beside its body: "now" in the App's zone, who `me` is, whose notices it reads. */
  extras?(ctx: RequestContext, source: ResolvedSource, reads: Adapter): PostExtras;
  /** A POST the App's pages answer before any route (a free-form page's loaders, its manifest). True when answered. */
  page?(ctx: RequestContext, source: ResolvedSource, body: Record<string, unknown>): Promise<boolean>;
  /** The POST routes before the data routes. True when answered. */
  routes(post: PostContext): Promise<boolean>;
  /** The POST routes after them. True when answered. */
  later(post: PostContext): Promise<boolean>;
  /**
   * What an App's reads are (app/appReads.ts): its unions, its replies
   * without the compiler's output, its failures in its own words, its `me`.
   * Given by the App framework's dispatcher; a request on an App is refused
   * rather than read as the database browser's without it.
   */
  readonly appReads?: AppReads;
  /** The ISO weekday the reads' weeks start on, where the product says. */
  weekStart?(post: PostContext): number;
  readonly exports: ExportHooks;
  readonly pages: PageHooks;
  readonly compose: ComposeHooks;
  readonly read: ReadHooks;
}

/**
 * A POST to the API: the body is read once, the connection or App it names
 * is resolved from it, and the routes that take a body (`handlePost`) are
 * given both, as a PostContext built here.
 *
 * Split out because the connection is resolved from the body, which means the
 * body has to be read before dispatch — and a stream can only be read once.
 * Handlers get it already parsed rather than each reaching for the request.
 */
export async function postData(ctx: RequestContext, hooks: DataHooks): Promise<void> {
  const { res, url, path, identity, appHosts, registry } = ctx;
  const selector = sourceSelector(ctx);
  // POST bodies can name a connection too, and the body is read once and
  // reused by the handler below.
  const body = await readJson(ctx.req, path === FILE_UPLOAD_PATH ? FILE_UPLOAD_BODY : undefined);
  if (ctx.appConfigured && Object.hasOwn(body, 'conn'))
    return send(res, 400, { error: 'Application requests identify an app, not a connection.' });
  if (body[selector] !== undefined && typeof body[selector] !== 'string') return send(res, 400, { error: 'Invalid request identity.' });
  const inBody = typeof body[selector] === 'string' ? (body[selector] as string) : undefined;
  const inQuery = url.searchParams.get(selector);
  /* Both, and disagreeing, is refused rather than resolved by precedence.
   Either answer runs somebody's statement against a database they did not
   mean, and the request has already told us it is confused about which. */
  if (inBody && inQuery && inBody !== inQuery) {
    return send(res, 400, {
      error: ctx.appConfigured
        ? 'This request names two different applications.'
        : `This request names two connections: "${inQuery}" in the URL and "${inBody}" in the body.`,
    });
  }
  const source = await hooks.source(ctx, inBody ?? inQuery);
  if (res.destroyed) return;
  const { adapter, schema, resources, access, wholeRowWrites, connectionId } = source;
  if (hooks.gates.read?.(ctx, source, { path, body })) return;
  const appConfigured = Boolean(appHosts?.length);
  /* One POST on this source, into the reply it is given: this request's
   own, or a composed read's part (recordCompose.ts), which is the same
   route with the same grants, row scope and hidden columns. */
  const post = async (reply: ServerResponse, asked: string, given: Record<string, unknown>): Promise<void> => {
    if (access && typeof given.table === 'string' && !access.readable.has(given.table)) throw new AppAccessDenied();
    const reads = hooks.reads?.(ctx, source, adapter, reply) ?? adapter;
    return handlePost(
      {
        res: reply,
        path: asked,
        body: given,
        adapter: reads,
        schema,
        registry,
        connection: connectionId,
        configPages: ctx.configPages,
        appHosts,
        who: identity.who,
        role: identity.role,
        resources,
        access,
        principal: identity.id,
        wholeRowWrites,
        rowPolicy: Boolean(ctx.policyContext),
        appConfigured,
        appNow: clockNow,
        ...hooks.extras?.(ctx, source, reads),
      },
      hooks,
    );
  };
  /* A record page, pinned to the primary whole: its related lists are
     asked through the list routes, and a record is where a person looks
     for what they just saved (readRouting.ts). */
  if (path === COMPOSE_PATH) return primaryReads(() => composeRecordPage({ ctx, source, body, post, hooks: hooks.compose }));
  if (await hooks.page?.(ctx, source, body)) return;
  return post(res, path, body);
}

/** Everything that takes a body, on its source. */
async function handlePost(post: PostContext, hooks: DataHooks): Promise<void> {
  const { res, path, body, adapter: reads, schema, appConfigured, appNow, me } = post;

  if (await hooks.routes(post)) return;
  if (await pageRoutes(post, hooks.pages)) return;
  /* A list, a count, a breakdown or an export may be answered by a replica
     (readRouting.ts); every other route reads the primary. */
  const reading = <T>(work: () => Promise<T>): Promise<T> => (toleratesLag(path, body) ? lagTolerantReads(work) : work());
  if (await reading(() => exportRoute(post, hooks.exports))) return;
  const exportable = hooks.exports.may(post);
  const weekStart = hooks.weekStart?.(post);
  /* Read as the browser's, an App's reply would carry its SQL and its compiled columns. */
  if (appConfigured && !hooks.appReads) throw new Error('An App is read through its own reads (DataHooks.appReads).');

  const readReply = await httpRead(() =>
    reading(() =>
      dispatchResourceReadHttp(path, body, reads, schema, {
        app: appConfigured ? hooks.appReads : undefined,
        now: appNow,
        ...(me ? { me } : {}),
        ...(weekStart === undefined ? {} : { weekStart }),
        // A table this person may not export is read a screen's worth at a time, never a file's.
        rowsMost: (table: string) => (exportable(table) ? undefined : UNEXPORTED_MOST),
      }),
    ),
  );
  if (readReply) return send(res, readReply.status, readReply.body);

  if (await recordWriteRoutes(post, hooks)) return;
  if (await hooks.later(post)) return;

  return send(res, 404, { error: `No such endpoint: ${path}` });
}

/** A read of the API, on the source its query names. */
export async function getData(ctx: RequestContext, hooks: DataHooks): Promise<void> {
  const source = await hooks.source(ctx, ctx.url.searchParams.get(sourceSelector(ctx)));
  if (ctx.res.destroyed) return;
  const table = ctx.url.searchParams.get('table');
  if (source.access && table !== null && !source.access.readable.has(table)) {
    if (hooks.gates.read?.(ctx, source, { path: ctx.path })) return;
    throw new AppAccessDenied();
  }
  if (await readRoutes(ctx, source, hooks.read)) return;
  send(ctx.res, 404, { error: `No such endpoint: ${ctx.path}` });
}
