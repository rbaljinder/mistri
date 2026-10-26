/**
 * A public page's head: its canonical address, and a title that names it.
 *
 * A signed-out visitor to an App that opens resources to the public
 * (`auth.public`) is who a search engine or a link preview is. The shell is
 * one static page, so without this every public record was "tablewalk" at
 * whatever spelling it was reached by. Here the server reads the address the
 * way the browser will (shared/appAddress.ts, over the same App payload
 * `/api/app` serves this principal), finds the record under the public grant
 * alone — the same resolveSource and read path a public `/api/view/run`
 * takes — and either answers 301 to the canonical spelling (a slug that
 * changed, or none) or serves the shell with `<title>` and
 * `<link rel="canonical">` written in.
 *
 * Anything it cannot place — not a public visitor, no such route, no such
 * record, a read that fails — is the plain shell, which the client resolves
 * as ever. It never refuses a page: a head is a courtesy, not a gate.
 */
import { addressSlug, readAppSegments, recordSegments } from '../../shared/appAddress.js';
import { isPublicForm, isRowPolicyApp, type AppDef, type AppFormView } from '../../shared/app.js';
import { publicHome } from '../../shared/appHome.js';
import { findTable, labelPath, primaryKey } from '@mistriwork/engine/shared/schema.js';
import { dispatchResourceReadHttp } from '@mistriwork/engine/server/resourceReadHttp.js';
import { APP_READS } from '../app/appReads.js';
import { browserApp } from './appProjection.js';
import { resolveSource } from './source.js';
import { clockNow } from '@mistriwork/engine/server/http/clock.js';
import type { AppPolicyContext } from '../policy/appPolicyContext.js';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import { requestRecordBranding } from './recordBranding.js';
import { pictureDetails } from './publicPictures.js';
import { appFileRules } from '../../shared/app.js';
import { outward, serverPath } from '@mistriwork/engine/shared/mount.js';
import { tabKey } from '@mistriwork/engine/shared/addressParams.js';
import { listPage, publicAddressBook, recordPage, type PublicPage, type PublicReading } from './publicPage.js';

/** What the shell carries for one public address, or where it lives instead. */
export interface ShellHead {
  title?: string;
  canonical?: string;
  redirect?: string;
  /** The page in words (publicPage.ts): its room as a document, its description and preview picture. */
  page?: PublicPage;
  /** The App's or the white-label brand's name, for a preview's site name. */
  site?: string;
  /** What a preview calls the page where its title is the site's own: the landing's heading. */
  headline?: string;
}

/** Whether this request is a signed-out visitor to an App's public side. */
function publicVisitor(ctx: Omit<RequestContext, 'policyContext'>): boolean {
  const host = ctx.signedIn;
  return Boolean(host?.auth && host.app.app.auth?.public && (typeof ctx.identity.id !== 'string' || !ctx.identity.id.trim()));
}

/**
 * The landing's head where `path` is its address — `/{app}/welcome`, or
 * `/{app}` where it is the signed-out home — titled as the client titles it.
 * Content the author wrote, so it reads nothing, and the tenant host's
 * landing says it the same way (tenantAuthenticatedHttp.ts).
 */
export function landingHead(app: AppDef, path: string, site: string): ShellHead | undefined {
  const landing = app.landing;
  if (!app.auth || !landing) return undefined;
  const segments = path.split('/').filter(Boolean);
  let first: string;
  try {
    first = decodeURIComponent(segments[0] ?? '');
  } catch {
    return undefined;
  }
  if (first !== app.id) return undefined;
  const placed = segments.length === 2 ? segments[1] === 'welcome' : segments.length === 1 && publicHome(app) === landing.view;
  if (!placed) return undefined;
  const label = landing.content.label?.trim();
  return {
    title: label || site,
    site,
    canonical: path,
    headline: landing.content.hero.heading,
    ...(landing.content.hero.description ? { page: { description: landing.content.hero.description } } : {}),
  };
}

/**
 * A public form's page, `/{app}/form/{key}`, titled as the client titles it (publicForm.js): an intake form by its
 * label alone — its page has no heading and a brand row of the mark only — any other as "label · site". Content the
 * author wrote, so it reads nothing; a tab's title before the script runs, and a link preview's.
 */
export function formHead(app: AppDef, path: string, site: string): ShellHead | undefined {
  const segments = path.split('/').filter(Boolean);
  if (segments.length !== 3 || segments[1] !== 'form') return undefined;
  let first: string;
  let key: string;
  try {
    [first, key] = [decodeURIComponent(segments[0]), decodeURIComponent(segments[2])];
  } catch {
    return undefined;
  }
  if (first !== app.id || !Object.hasOwn(app.views, key)) return undefined;
  const view = app.views[key];
  if (!isPublicForm(view)) return undefined;
  const form = view as AppFormView & { style?: string };
  const label = form.label?.trim();
  if (!label) return undefined;
  return { title: form.style === 'intake' ? label : `${label} · ${site}`, site, canonical: path };
}

/**
 * The head for this request's page, for a signed-out visitor. `whoever`
 * reads it as the public principal whoever asks — the share card's route
 * (shareCard.ts), which must draw what anyone may see and never what the
 * asker may — as the sitemap reads (sitemap.ts asPublic).
 */
export async function publicHead(ctx: Omit<RequestContext, 'policyContext'>, whoever = false): Promise<ShellHead | undefined> {
  if (whoever) ctx = { ...ctx, identity: {} };
  const { req, path } = ctx;
  if ((req.method !== 'GET' && req.method !== 'HEAD') || path.startsWith('/api/')) return undefined;
  const signedOut = Boolean(ctx.signedIn?.auth) && (typeof ctx.identity.id !== 'string' || !ctx.identity.id.trim());
  if (ctx.signedIn && /^\/[^/]+\/form\/[^/]+$/.test(path)) {
    const app = ctx.signedIn.app.app;
    try {
      const branding = await requestRecordBranding(ctx, undefined, true);
      return formHead(app, path, branding?.value.content.name ?? app.name);
    } catch {
      return formHead(app, path, app.name);
    }
  }
  /* A public form's view key is also an address in the App (`/{app}/request-viewing`, what a link or a hand-typed path
     says), but a form is drawn only on its own page: left alone, the client took the key for a list the visitor may not
     read and said the form was for signed-in members. */
  if (signedOut) {
    const app = ctx.signedIn!.app.app;
    const segments = path.split('/').filter(Boolean);
    /* With the App at the root its own id is no part of an address, so `/lintel/form/request-viewing` (the spelling a
       link written for a mounted App keeps) reads inside as the id twice. It is the form all the same: sent to the one
       address, not to the shell, which took the id for a list and ended on "for signed-in members". */
    if (segments.length >= 3 && segments.length <= 4) {
      try {
        const [first, second, ...rest] = segments.map(decodeURIComponent);
        const key = rest.length === 2 ? (rest[0] === 'form' ? rest[1] : undefined) : rest[0];
        if (
          first === app.id &&
          second === app.id &&
          key !== undefined &&
          key !== 'form' &&
          Object.hasOwn(app.views, key) &&
          isPublicForm(app.views[key])
        )
          return { redirect: `/${encodeURIComponent(app.id)}/form/${encodeURIComponent(key)}${ctx.url.search}` };
      } catch {
        return undefined;
      }
    }
    if (segments.length === 2) {
      let first: string;
      let key: string;
      try {
        [first, key] = [decodeURIComponent(segments[0]), decodeURIComponent(segments[1])];
      } catch {
        return undefined;
      }
      if (first === app.id && key !== 'form' && Object.hasOwn(app.views, key) && isPublicForm(app.views[key]))
        return { redirect: `/${encodeURIComponent(app.id)}/form/${encodeURIComponent(key)}${ctx.url.search}` };
    }
  }
  if (signedOut && ctx.signedIn!.app.app.landing) {
    try {
      const branding = await requestRecordBranding(ctx, undefined, true);
      const landing = landingHead(ctx.signedIn!.app.app, path, branding?.value.content.name ?? ctx.signedIn!.app.app.name);
      if (landing) return landing;
    } catch {
      return undefined;
    }
  }
  if (!publicVisitor(ctx)) return undefined;
  const host = ctx.signedIn!;
  const appId = host.app.app.id;
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) return undefined;
  let head: string;
  try {
    head = decodeURIComponent(segments[0]);
  } catch {
    return undefined;
  }
  if (head !== appId) return undefined;
  const rowPolicy = ctx.policy || ctx.policyUnavailable || isRowPolicyApp(host.app.app);
  try {
    if (!rowPolicy) return await placed(ctx, segments.slice(1));
    const policy = ctx.policy;
    if (ctx.policyUnavailable || !policy || !policy.matches(host.app.app)) return undefined;
    const within = whoever ? policy.withPublicContext : policy.withContext;
    return await within(req, async (context: AppPolicyContext) => {
      // As the API's own cross-check: the policy must agree nobody is signed in.
      if (context.principal.kind !== 'public' || context.principal.appId !== appId) return undefined;
      return placed({ ...ctx, policyContext: context }, segments.slice(1));
    });
  } catch {
    return undefined;
  }
}

async function placed(ctx: RequestContext, rest: string[]): Promise<ShellHead | undefined> {
  const source = await resolveSource(ctx, ctx.signedIn!.app.app.id);
  const { app } = browserApp(ctx, source);
  if (!app || !source.schema) return undefined;
  const schema = source.schema;
  const book = publicAddressBook(app, schema);
  const parsed = readAppSegments(book, rest);
  if (!parsed) return undefined;
  const branding = await requestRecordBranding(ctx, source);
  const site = branding?.value.content.name ?? app.name;
  const titled = (name: string) => ({ title: `${name} · ${site}`, site });
  const reading: PublicReading = {
    source,
    app,
    schema,
    book,
    outward: (inside) => outward(ctx.mount, inside),
    served: (path) => serverPath(ctx.mount, path),
    pictures: (table, rows) =>
      pictureDetails(source.adapter, table, appFileRules(ctx.signedIn!.app.app, schema).rules.get(table.id), rows, source.access),
  };
  /* The words are a courtesy like the title: a read that fails leaves the page without them. */
  const worded = async (read: () => Promise<PublicPage | undefined>) => {
    try {
      const page = await read();
      return page ? { page } : {};
    } catch {
      return {};
    }
  };
  if (parsed.kind !== 'record') {
    const target = parsed.target;
    if (parsed.kind === 'route' && target.kind === 'inbox') return { ...titled('Notifications'), canonical: ctx.path };
    if (target.kind === 'assistant') return { ...titled('Assistant'), canonical: ctx.path };
    if (parsed.kind === 'route' && (target.kind === 'list' || target.kind === 'dashboard')) {
      const view = app.views[target.view] as { label?: string; tabs?: Array<{ label: string; slug?: string }> } | undefined;
      if (!view?.label) return undefined;
      /* A list as it opens, or on a tab: a search or a refinement is the client's question to ask (publicAddress.ts). */
      const params = [...ctx.url.searchParams.keys()];
      const tab = ctx.url.searchParams.get('tab');
      const index = tab === null ? 0 : (view.tabs ?? []).findIndex((item) => tabKey(item) === tab);
      const plain = target.kind === 'list' && params.every((name) => name === 'tab') && index >= 0;
      return {
        ...titled(view.label),
        canonical: ctx.path + ctx.url.search,
        ...(plain ? await worded(() => listPage(reading, target.view, index)) : {}),
      };
    }
    return undefined;
  }
  const table = findTable(schema, parsed.table);
  if (!table) return undefined;
  const key = primaryKey(table);
  const resource = Object.hasOwn(app.resources, table.id) ? app.resources[table.id] : undefined;
  const label = labelPath(schema, table, resource?.recordLabel);
  const route = book.records.get(table.id);
  const columns = [...new Set([...key, ...(label ? [label] : []), ...(route?.column ? [route.column] : [])])];
  const reply = await dispatchResourceReadHttp(
    '/api/view/run',
    {
      view: {
        id: `head:${table.id}`,
        name: table.name,
        base: table.id,
        columns: columns.map((path) => ({ path })),
        filter: { groups: [Object.entries(parsed.key).map(([path, value]) => ({ path, op: '=', value }))] },
        limit: 2,
      },
      count: 'none',
    },
    source.adapter,
    schema,
    { app: APP_READS, now: clockNow },
  );
  const rows = (reply?.status === 200 ? (reply.body as { rows?: Record<string, unknown>[] }).rows : undefined) ?? [];
  // None is "not found", which the client says; two would be no key at all.
  if (rows.length !== 1) return undefined;
  const row = rows[0];
  const name = label && row[label] !== null && row[label] !== undefined && String(row[label]) !== '' ? String(row[label]) : undefined;
  /* Said under the segment it was reached by where the client keeps it —
     a split's, whose pick is beside its list, and a second page's — and
     under the table's own route otherwise (client publicAddress.ts). */
  const target = parsed.target;
  const split =
    target.kind === 'list' && (app.views[target.view] as { presentation?: { kind?: string } } | undefined)?.presentation?.kind === 'split';
  const reached =
    target.kind === 'list'
      ? split
        ? book.views.get(target.view)
        : undefined
      : target.kind === 'page' && book.defaultPage.get(table.id) !== target.page
        ? book.pages.get(target.page)
        : undefined;
  const said = recordSegments(book, table.id, {
    key: Object.fromEntries(key.map((column) => [column, row[column]])),
    natural: route?.column ? row[route.column] : undefined,
    slug: addressSlug(name),
    tab: parsed.tab,
    via: reached && reached !== route?.segment ? reached : undefined,
  });
  if (!said) return undefined;
  const canonical = `/${encodeURIComponent(ctx.signedIn!.app.app.id)}/${said.join('/')}`;
  if (canonical !== ctx.path) return { redirect: canonical + ctx.url.search };
  const title = name ?? Object.values(parsed.key).join(' · ');
  /* The way back up, to the list the record is addressed under, where the visitor may open it. */
  const home = route ? book.routes.get(route.segment) : undefined;
  const list = home?.kind === 'list' ? (app.views[home.view] as { label?: string } | undefined) : undefined;
  const up =
    route && list?.label ? { href: outward(ctx.mount, `/${encodeURIComponent(app.id)}/${route.segment}`), label: list.label } : undefined;
  return {
    ...titled(title),
    canonical,
    ...(parsed.tab
      ? {}
      : await worded(() => recordPage(reading, table, Object.fromEntries(key.map((column) => [column, row[column]])), title, up))),
  };
}
