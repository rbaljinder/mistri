/**
 * `/sitemap.xml` and `/robots.txt`: where a search engine learns which of an
 * App's addresses are public, and which of the server's are not pages.
 *
 * The addresses are the App's canonical ones (shared/appAddress.ts), from
 * the route table `mistri check --routes` prints (routeTable) — the
 * fixed ones as they are, a record's as publicHead.ts would answer it with
 * no redirect — so the sitemap can name no address the App does not answer.
 * Which rows are named is decided as for any signed-out visitor: the public
 * principal, whoever asks (a signed-in editor fetching the sitemap still
 * gets the public one), the App's grants and row policy, and a list's own
 * standing condition, so a car the public list hides is not in it either.
 *
 * Every `<loc>` is absolute, from the origin the request was made to
 * (requestOrigin.ts): a white-label host's sitemap names its own host. Past
 * PER_FILE addresses the answer is an index of parts, each a keyset range
 * of one route's records (`?part=vehicles&after=812`), so no part is ever
 * read by skipping rows.
 *
 * Nothing public — the database browser, an App that signs everyone in —
 * has no sitemap, and its robots.txt asks crawlers to stay out.
 */
import { isRowPolicyApp, zonedNow } from '../../shared/app.js';
import { appZone } from '../../shared/appZone.js';
import { andQuery, quoteValue } from '@mistriwork/engine/shared/query.js';
import { routeTable } from '../../shared/appAddress.js';
import { appHome, outward, serverPath } from '@mistriwork/engine/shared/mount.js';
import { findTable, labelPath, primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { dispatchResourceReadHttp } from '@mistriwork/engine/server/resourceReadHttp.js';
import { APP_READS } from '../app/appReads.js';
import type { AppPolicyContext } from '../policy/appPolicyContext.js';
import { browserApp } from './appProjection.js';
import { clockNow } from '@mistriwork/engine/server/http/clock.js';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import { publicAddressBook, recordHref, type PublicReading } from './publicPage.js';
import { requestOrigin } from '@mistriwork/engine/server/http/requestOrigin.js';
import { ROBOTS_PATH, SITEMAP_PATH, crawlerAsks, sendText as crawlerText } from '@mistriwork/engine/server/http/crawlerText.js';
import { resolveSource } from './source.js';
import { SHARE_CARD_PATH } from './shareCard.js';

/* The protocol allows 50,000 a file; a smaller part is one quick read. MISTRI_SITEMAP_URLS sets it (a test sets it low). */
const perFile = () => Math.min(50_000, Math.max(1, Math.trunc(Number(process.env.MISTRI_SITEMAP_URLS)) || 10_000));
/* An index names at most this many parts per route: a million records is past what a page-by-page App publishes. */
const MOST_PARTS = 100;

type Row = Record<string, unknown>;
type Ctx = Omit<RequestContext, 'policyContext'>;

const escapeXml = (text: string) =>
  text.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

const sendText = (ctx: Ctx, status: number, type: string, body: string) => crawlerText(ctx.req, ctx.res, status, type, body);

/** The App a signed-out visitor may browse (`auth.public`), if this server serves one. */
const publicApp = (ctx: Ctx) => (ctx.signedIn?.auth && ctx.signedIn.app.app.auth?.public ? ctx.signedIn.app.app : undefined);

/** Answer `/robots.txt` or `/sitemap.xml`, or return false for any other address. */
export async function seoRoutes(ctx: Ctx): Promise<boolean> {
  const { req, path } = ctx;
  if (path !== ROBOTS_PATH && path !== SITEMAP_PATH) return false;
  if (crawlerAsks(req, ctx.res, path)) return true;
  const app = publicApp(ctx);
  const origin = requestOrigin(req, ctx.bound);
  if (path === ROBOTS_PATH) {
    if (!app || !origin) return sendText(ctx, 200, 'text/plain', 'User-agent: *\nDisallow: /\n');
    const under = (server: string) => serverPath(ctx.mount, server);
    return sendText(
      ctx,
      200,
      'text/plain',
      [
        'User-agent: *',
        // The API is data, not pages; its pictures are what an image search shows, and its share cards what a preview does.
        `Disallow: ${under('/api/')}`,
        `Allow: ${under('/api/file')}`,
        `Allow: ${under(SHARE_CARD_PATH)}`,
        `Disallow: ${under('/_mistri/')}`,
        '',
        `Sitemap: ${origin}${under(SITEMAP_PATH)}`,
        '',
      ].join('\n'),
    );
  }
  if (!app || !origin) return sendText(ctx, 404, 'text/plain', 'Nothing here is public.\n');
  const xml = await asPublic(ctx, (visitor) => sitemap(visitor, origin)).catch(() => undefined);
  if (xml === undefined) return sendText(ctx, 503, 'text/plain', 'The sitemap could not be read just now.\n');
  if (xml === null) return sendText(ctx, 404, 'text/plain', 'No such part of the sitemap.\n');
  return sendText(ctx, 200, 'application/xml', xml);
}

/* The public principal, whoever is signed in: as a public form reads (recordBranding.ts does the same). */
async function asPublic<T>(ctx: Ctx, read: (visitor: RequestContext) => Promise<T>): Promise<T | undefined> {
  const host = ctx.signedIn!;
  const visitor = { ...ctx, identity: {} } as Ctx;
  if (!(ctx.policy || ctx.policyUnavailable || isRowPolicyApp(host.app.app))) return read(visitor);
  const policy = ctx.policy;
  if (ctx.policyUnavailable || !policy || !policy.matches(host.app.app)) return undefined;
  return policy.withPublicContext(ctx.req, async (context: AppPolicyContext) => {
    if (context.principal.kind !== 'public' || context.principal.appId !== host.app.app.id) return undefined;
    return read({ ...visitor, policyContext: context });
  });
}

/** One route's records, as a part of the sitemap reads them. */
interface Records {
  segment: string;
  table: TableMeta;
  /** The list's standing condition, when the records are addressed under a list. */
  where: string;
  key: string[];
  label?: string;
  natural?: string;
}

async function sitemap(ctx: RequestContext, origin: string): Promise<string | null | undefined> {
  const appId = ctx.signedIn!.app.app.id;
  const source = await resolveSource(ctx, appId);
  const { app } = browserApp(ctx, source);
  if (!app || !source.schema) return undefined;
  const schema = source.schema;
  const book = publicAddressBook(app, schema);
  const reading: PublicReading = {
    source,
    app,
    schema,
    book,
    outward: (inside) => outward(ctx.mount, inside),
    served: (path) => serverPath(ctx.mount, path),
  };
  const home = appHome(ctx.mount, appId);
  const under = home.replace(/\/$/, '');
  /* The fixed addresses: the route table's rows with nothing left to fill in, that a visitor reads (not a New form, an inbox or the assistant). */
  const fixed = routeTable(book, home)
    .filter((row) => !/[{?…]/.test(row.path) && !row.path.endsWith('/new'))
    .filter((row) => {
      if (row.path === home) return true;
      const target = book.routes.get(decodeURIComponent(row.path.slice(under.length + 1)));
      return target?.kind === 'list' || target?.kind === 'dashboard';
    })
    .map((row) => row.path);
  if (ctx.signedIn!.app.app.landing) fixed.push(outward(ctx.mount, `/${encodeURIComponent(appId)}/welcome`));
  /* Each record route with a plain id (`{id}`, `{id}[-slug]`, a natural `{sku}`); one under a parent's address is that parent's page's to link. */
  const said = new Set(routeTable(book, home).map((row) => row.path));
  const records: Records[] = [];
  for (const [tableId, route] of book.records) {
    const table = findTable(schema, tableId);
    const target = book.routes.get(route.segment);
    /* A record a list or a page shows; a bare table's rows (a photo's, a log's) are not a page anyone reads. */
    if (!table || route.parent || !said.has(`${under}/${route.segment}`) || (target?.kind !== 'list' && target?.kind !== 'page')) continue;
    const view =
      target?.kind === 'list' ? (app.views[target.view] as { query?: string; tabs?: Array<{ query?: string }> } | undefined) : undefined;
    records.push({
      segment: route.segment,
      table,
      where: andQuery(view?.query, view?.tabs?.[0]?.query),
      key: primaryKey(table),
      label: labelPath(schema, table, app.resources[table.id]?.recordLabel),
      natural: route.column,
    });
  }
  const loc = (path: string) => origin + path;
  const part = ctx.url.searchParams.get('part');
  const most = perFile();
  if (part === 'pages') return urlset(fixed.map(loc));
  if (part !== null) {
    const of = records.find((each) => each.segment === part);
    if (!of) return null;
    const after = ctx.url.searchParams.get('after');
    const rows = await chunk(reading, of, after === null ? undefined : parsedKey(after), most);
    if (!rows) return undefined;
    return urlset(hrefs(reading, of, rows).map(loc));
  }
  /* Small enough for one file: everything in it. */
  const firsts: Row[][] = [];
  for (const each of records) {
    const rows = await chunk(reading, each, undefined, most + 1);
    if (!rows) return undefined;
    firsts.push(rows);
  }
  const total = fixed.length + firsts.reduce((sum, rows) => sum + rows.length, 0);
  if (total <= most) return urlset([...fixed, ...records.flatMap((each, i) => hrefs(reading, each, firsts[i]))].map(loc));
  /* An index: the fixed addresses, then each route's records in key ranges. */
  const self = serverPath(ctx.mount, SITEMAP_PATH);
  const parts: string[] = fixed.length ? [`${self}?part=pages`] : [];
  for (const each of records) {
    let after: unknown;
    for (let n = 0; n < MOST_PARTS; n++) {
      const keys = await chunk(reading, each, after, most, true);
      if (!keys?.length) break;
      parts.push(`${self}?${new URLSearchParams({ part: each.segment, ...(n ? { after: JSON.stringify(after) } : {}) })}`);
      // A key of more than one column has no range to continue from: its first part is all it names.
      if (keys.length < most || each.key.length !== 1) break;
      after = keys[keys.length - 1][each.key[0]];
    }
  }
  return sitemapIndex(parts.map(loc));
}

const parsedKey = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** Up to `most` of a route's records, in key order, after `after` (a one-column key's value). */
async function chunk(reading: PublicReading, of: Records, after: unknown, most: number, keysOnly = false): Promise<Row[] | undefined> {
  if (!of.key.length) return [];
  const range = after !== undefined && of.key.length === 1 ? `${of.key[0]} > ${quoteValue(after)}` : undefined;
  if (after !== undefined && !range) return [];
  const show = [...new Set([...of.key, ...(keysOnly ? [] : [of.label, of.natural].filter((path): path is string => Boolean(path)))])];
  const q = [of.table.id, andQuery(of.where, range), `sort ${of.key.join(', ')}`, `show ${show.join(', ')}`].filter(Boolean).join(' ');
  const reply = await dispatchResourceReadHttp(
    '/api/run',
    { q, limit: most, offset: 0, count: 'none' },
    reading.source.adapter,
    reading.schema,
    {
      app: APP_READS,
      // The App's wall clock, so a route's `where` that says `today` lists what its public page lists.
      now: () => zonedNow(appZone(reading.app.ui, reading.source.zone), clockNow()),
    },
  );
  const body = reply?.status === 200 ? (reply.body as { rows?: Row[]; errors?: unknown[] }) : undefined;
  return body && !body.errors?.length ? (body.rows ?? []) : undefined;
}

function hrefs(reading: PublicReading, of: Records, rows: Row[]): string[] {
  return rows.flatMap((row) => {
    const name =
      of.label && row[of.label] !== null && row[of.label] !== undefined && String(row[of.label]) !== '' ? String(row[of.label]) : undefined;
    const href = recordHref(reading, of.table, row, name);
    return href ? [href] : [];
  });
}

const XML = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';

function urlset(locs: string[]): string {
  return `${XML}<urlset xmlns="${NS}">\n${locs.map((at) => `<url><loc>${escapeXml(at)}</loc></url>\n`).join('')}</urlset>\n`;
}

function sitemapIndex(locs: string[]): string {
  return `${XML}<sitemapindex xmlns="${NS}">\n${locs.map((at) => `<sitemap><loc>${escapeXml(at)}</loc></sitemap>\n`).join('')}</sitemapindex>\n`;
}
