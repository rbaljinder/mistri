/**
 * A visitor's reads over HTTP on a tenant App's host (`auth.public`): the
 * signed-out reads an ordinary App's visitor makes (http/gate.ts PUBLIC_GETS
 * and PUBLIC_POSTS), each placed with one tenant by its public address
 * (`?via=`) or by the operator's mapped host, and answered through the
 * visitor's own owner (tenantPublicReadRuntime.ts). The routes are the
 * member lane's building blocks (dispatchResourceReadHttp, tenantPagePlan,
 * composeTenantRecordPage, pageLoad, tenantFileRead) over the visitor's
 * reader and catalog; nothing here reads a session, a lease or a membership.
 *
 * Every answer is the visitor's alone: never stored (`no-store`), never sent
 * as a referrer, never indexed, and carrying no `x-mistri-*` header, so
 * nothing in it names a tenant the address did not. An address that places
 * nobody, a tenant that is not active, a record of another tenant and a
 * resource the grant does not name all answer as the same missing page.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ScopedReads } from '@mistriwork/engine/adapters/adapter.js';
import { zonedNow, type AppDef } from '../../shared/app.js';
import { appSurfaceForRealm } from '../../shared/appTenancy.js';
import { appZone } from '../../shared/appUi.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import { PAGE_LOAD_PATH } from '@mistriwork/engine/shared/pageRoutes.js';
import type { ResourceHttpPath } from '@mistriwork/engine/shared/resourceHttp.js';
import { isPublicReadRequest, PUBLIC_READ_GETS } from '../../shared/tenantPublicReads.js';
import { localeWeekStart } from '@mistriwork/engine/shared/weekStart.js';
import { localizedApp } from '../app/apps.js';
import { componentMessages } from '../app/appMessages.js';
import { requestLocale } from '../app/readerLocale.js';
import type { PageLoader } from '../commands/pageLoaders.js';
import {
  captureTenantData,
  databaseFault,
  TenantRequestFault,
  tenantIdentifier,
  tenantRecord,
} from '@mistriwork/engine/server/evidence.js';
import { pageLoad } from '../http/pageLoad.js';
import { withRecordBranding, type BrandingPresentation } from '../http/recordBranding.js';
import { reportRefusal } from '@mistriwork/engine/server/http/refusalReport.js';
import { FILE_READ_PATH } from '@mistriwork/engine/server/http/reply.js';
import { doorRefusal, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { dispatchResourceReadHttp } from '@mistriwork/engine/server/resourceReadHttp.js';
import { APP_READS } from '../app/appReads.js';
import { composeInputValid, composeTenantRecordPage } from './tenantCompose.js';
import { readAdapter, tenantFileRead } from './tenantHttp.js';
import { projectTenantMetadata } from './tenantMetadata.js';
import { tenantPagePlan, tenantReferences } from './tenantPageOperations.js';
import { TenantPublicNotFound, type PublicPlacement, type PublicReadContext } from './tenantPublicReadRuntime.js';
import { tenantServedSchema, withRequestInstant } from './tenantServedSchema.js';
import type { TenantSearch } from './tenantSearch.js';

/* The fields each body may say, as the member lane's (tenantHttp.ts), and the App it is for. */
const fields: Record<string, readonly string[]> = {
  [PAGE_LOAD_PATH]: ['page', 'params'],
  '/api/pages/plan': ['page', 'key'],
  '/api/pages/compose': ['page', 'key', 'rows', 'tab'],
  '/api/references': ['table', 'key'],
  '/api/query': ['table', 'filter', 'columns', 'orderBy', 'limit', 'offset'],
  '/api/count': ['table', 'filter', 'exactCount', 'countLimit'],
  '/api/counts': ['items', 'countLimit'],
  '/api/run': ['q', 'columns', 'exactCount', 'countLimit', 'count', 'limit', 'offset'],
  '/api/view/run': ['view', 'text', 'query', 'count', 'limit', 'offset'],
  '/api/breakdown': ['def', 'text', 'limit', 'offset'],
  '/api/breakdowns': ['items'],
  [FILE_READ_PATH]: ['table', 'key', 'variant', 'inline'],
};
const BODY_MOST = 262144;

interface TenantPublicReadHttpOptions {
  readonly app: AppDef;
  readonly pages: readonly PageDef[];
  readonly withPublicContext: <T>(placement: PublicPlacement, run: (context: PublicReadContext) => T | Promise<T>) => Promise<T>;
  readonly bound: Bound;
  readonly now: () => number;
  readonly assertActive: () => void;
  /** The placed tenant's published look (`private: false`), never a member's. */
  readonly branding?: (tenantId: string) => Promise<BrandingPresentation | undefined>;
  /** The App's search, a visitor's reader made searchable within the placed tenant. */
  readonly search?: Pick<TenantSearch, 'reader'>;
  /** The free-form pages' loaders: only a page that says `public: true` runs for a visitor (pageLoad.ts). */
  readonly loaders?: Readonly<Record<string, PageLoader>>;
  /** Where the components a visitor's public pages draw are served (appComponents.ts publicComponentIds): code, never a row. */
  readonly components?: Readonly<Record<string, { kind: string; href: string; css?: string }>>;
}

class Refused extends Error {
  constructor(readonly status: number) {
    super('This request is not valid.');
  }
}

function send(req: IncomingMessage, res: ServerResponse, status: number, value: unknown): void {
  const json = JSON.stringify(value);
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    // The address is the visitor's key to the page: never handed on as a referrer, never indexed.
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex',
    'content-length': Buffer.byteLength(json),
  });
  res.end(req.method === 'HEAD' ? undefined : json);
}
const NOT_FOUND = { error: 'Not found.', code: 'not_found' };

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    if ((size += chunk.length) > BODY_MOST) throw new Refused(413);
    chunks.push(chunk);
  }
  try {
    const value: unknown = captureTenantData(
      JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))),
    );
    tenantRecord(value);
    return value;
  } catch {
    throw new Refused(400);
  }
}

/**
 * The visitor lane's handler. `placement` is what placed the request — the
 * one `?via=` address, or the mapped host's tenant — and was judged by the
 * host's router (tenantAuthenticatedHttp.ts), which sends nothing here that
 * names a lease, a tenant, a realm or a bearer.
 */
export function createTenantPublicReadHttp(options: TenantPublicReadHttpOptions) {
  const { app, pages, withPublicContext, bound, now, assertActive } = options;
  return async (req: IncomingMessage, res: ServerResponse, url: URL, placement: PublicPlacement): Promise<void> => {
    const path = url.pathname;
    try {
      assertActive();
      const get = req.method === 'GET' || req.method === 'HEAD';
      if (!isPublicReadRequest(req.method, path)) throw new Refused(405);
      // The App the request is for, at most once, and the address: nothing else rides in the URL.
      if (
        [...url.searchParams.keys()].some((key) => key !== 'app' && key !== 'via') ||
        url.searchParams.getAll('app').length > 1 ||
        (url.searchParams.has('app') && url.searchParams.get('app') !== app.id)
      )
        throw new Refused(400);
      if (doorRefusal(req, bound, { writing: !get })) throw new Refused(403);
      if (
        get &&
        (req.headers['transfer-encoding'] !== undefined ||
          (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0'))
      )
        throw new Refused(400);
      let input: Record<string, unknown> = {};
      if (!get) {
        input = await body(req);
        // The client's ordinary envelope names its App in the body (requestIdentity.ts); only this one.
        if (Object.hasOwn(input, 'app')) {
          if (input.app !== app.id) throw new Refused(400);
          const { app: _app, ...rest } = input;
          input = rest;
        }
        try {
          tenantRecord(input, fields[path]);
        } catch {
          throw new Refused(400);
        }
        if (path === '/api/pages/compose' && !composeInputValid(input)) throw new Refused(400);
      }
      assertActive();
      if (req.aborted || res.destroyed) return;
      /* Nobody is known, so the browser's language among the App's catalogs (or a pick kept in this browser) says
         the visitor's words and figures, as a single App's public page does (readerLocale.ts). */
      const locale = requestLocale(app, { visitor: true, req, res });
      /* One instant for the read, as for a member's request (tenantHttp.ts): the catalog and every statement it writes. */
      const answer = await withPublicContext(placement, (context) =>
        withRequestInstant(new Date(now()), () => {
          const instant = () => zonedNow(appZone(app.ui), new Date(now()));
          const schema = tenantServedSchema(context, app, new Date(now()));
          return route(context, schema, path, input, instant, locale);
        }),
      );
      assertActive();
      if (req.aborted || res.destroyed) return;
      // A missing record and a refused one read the same as a missing page from outside.
      if (answer.status === 404) return send(req, res, 404, NOT_FOUND);
      return send(req, res, answer.status, answer.body);
    } catch (error) {
      if (error instanceof Refused) {
        if (error.status === 405) res.setHeader('allow', PUBLIC_READ_GETS.has(path) ? 'GET, HEAD' : 'POST');
        return send(req, res, error.status, { error: error.message, code: 'invalid_request' });
      }
      if (error instanceof TenantRequestFault && error.status !== 404) {
        reportRefusal(req, error.status, error.code, error.message, error);
        return send(req, res, error.status, { error: error.message, code: error.code });
      }
      /* Whatever placed nobody or refused the read — an unknown address, a tenant
         that is not active, another tenant's record, a resource the grant does not
         name — is one missing page. Only a database that did not answer says so. */
      const unavailable = !(error instanceof TenantPublicNotFound) && !(error instanceof TenantRequestFault) && databaseFault(error);
      reportRefusal(req, unavailable ? 503 : 404, unavailable ? 'temporarily_unavailable' : 'not_found', 'Not found.', error, unavailable);
      return unavailable
        ? send(req, res, 503, { error: 'This page is temporarily unavailable.', code: 'temporarily_unavailable' })
        : send(req, res, 404, NOT_FOUND);
    }
  };

  async function route(
    context: PublicReadContext,
    schema: ReturnType<typeof tenantServedSchema>,
    path: string,
    input: Record<string, unknown>,
    instant: () => Date,
    locale: string | undefined,
  ): Promise<{ status: number; body: unknown }> {
    const reply = (value: unknown) => ({ status: 200, body: value });
    const tenantId = context.principal.tenantId;
    if (path === '/api/schema') return reply(schema);
    if (path === '/api/runtime')
      return reply({ appConfigured: true, active: app.id, apps: [{ id: app.id, name: app.name, writable: false }] });
    if (path === PAGE_LOAD_PATH) {
      /* A free-form page's loader, for a page that says `public: true` alone, over the visitor's reader (pageLoad.ts). */
      const loaded = await pageLoad({
        app: appSurfaceForRealm(app, pages, 'tenant').app,
        roles: [],
        signedIn: false,
        loaders: options.loaders,
        body: input,
        reader: readAdapter(context),
        schema,
      });
      return { status: loaded.status, body: loaded.body };
    }
    const said = localizedApp({ app, pages: [...pages] }, locale);
    const metadata = projectTenantMetadata(said.app, said.pages, schema, undefined, [], 'tenant', undefined, locale, true);
    if (path === '/api/app') {
      const branding = options.branding ? await options.branding(tenantId).catch(() => undefined) : undefined;
      // The placed tenant's published look, and only one that says it is that tenant's.
      const published =
        branding && !branding.private && branding.value.identity.app === app.id && branding.value.identity.tenant === tenantId
          ? branding
          : undefined;
      const branded = metadata.app && withRecordBranding(metadata.app, published);
      /* Only the components this visitor's payload places: a page or view a visitor is not offered names none here. */
      const placed = options.components && branded ? placedComponents(branded, metadata.pages, options.components) : undefined;
      /* The catalog beside them, in the visitor's language as the rest of their payload is (`useMessage`). */
      const catalog = placed && Object.keys(placed).length ? componentMessages(app, locale ?? app.ui.locale) : undefined;
      return reply({
        appId: app.id,
        app: placed ? { ...branded, components: placed, ...(catalog ? { messages: catalog } : {}) } : branded,
      });
    }
    if (path === '/api/pages') return reply({ appId: app.id, pages: metadata.pages });
    if (path === '/api/references') {
      tenantIdentifier(input.table);
      tenantRecord(input.key);
      return reply(await tenantReferences(readAdapter(context), schema, input.table, input.key as Record<string, string | number>));
    }
    if (path === '/api/pages/plan' || path === '/api/pages/compose') {
      tenantIdentifier(input.page, 1024);
      tenantRecord(input.key);
      // Only a page the App declares: a suggested page is a member's.
      const page = metadata.pages.find((candidate) => candidate.id === input.page);
      if (!page) throw new TenantRequestFault(404, 'not_found');
      const planned = await tenantPagePlan(readAdapter(context), schema, page, input.key as Record<string, string | number>, instant());
      if (path === '/api/pages/plan') return reply(planned);
      const composed = await composeTenantRecordPage({
        schema,
        planned,
        key: input.key as Record<string, unknown>,
        rows: input.rows,
        tab: input.tab,
        app: metadata.app,
        ask: (asked, given) => route(context, schema, asked, given, instant, locale),
      });
      // A visitor runs no command: the record offers it none.
      const { checks: _checks, ...shown } = composed;
      return reply(shown);
    }
    if (path === FILE_READ_PATH) return tenantFileRead(app, readAdapter(context), schema, input, { app: app.id, tenant: tenantId });
    /* A list's text filter on a searched field is asked of the engine within the placed tenant, then read here as any row is. */
    const reader = options.search ? options.search.reader(readAdapter(context), schema, tenantId) : readAdapter(context);
    const result = await dispatchResourceReadHttp(path as ResourceHttpPath, input, reader as typeof reader & ScopedReads, schema, {
      app: APP_READS,
      now: instant,
      weekStart: localeWeekStart(locale ?? app.ui.locale),
    });
    if (!result) throw new TenantRequestFault(404, 'not_found');
    return result;
  }
}

/* The served components a visitor's payload names: a placement keeps its
   declaration's id and kind (appComponents.ts), wherever it stands. */
function placedComponents(
  app: unknown,
  pages: unknown,
  served: Readonly<Record<string, { kind: string; href: string; css?: string }>>,
): Record<string, { kind: string; href: string; css?: string }> | undefined {
  const named = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      const { id, kind } = value as { id?: unknown; kind?: unknown };
      if (typeof id === 'string' && typeof kind === 'string' && Object.hasOwn(served, id) && served[id].kind === kind) named.add(id);
      Object.values(value).forEach(walk);
    }
  };
  walk(app);
  walk(pages);
  return named.size ? Object.fromEntries([...named].map((id) => [id, served[id]])) : undefined;
}
