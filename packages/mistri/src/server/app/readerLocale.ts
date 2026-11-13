/**
 * The reader's locale (shared/appLocale.ts `resolveLocale`), read once per
 * request by whatever builds the request's reader (http/source.ts,
 * tenant/tenantReadRuntime.ts), as readerZone.ts reads their zone: the
 * person's own tag from `ui.locale: { column }`, the first row of that column
 * they may read under their own grants; and, for a reader nobody knows, the
 * browser's `Accept-Language` among the locales the App has words for.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { QueryRequest, QueryResult } from '@mistriwork/engine/adapters/adapter.js';
import type { AppDef, AppUi } from '../../shared/appModel.js';
import type { QueryPerson } from '@mistriwork/engine/shared/query.js';
import { canonicalLocale, localeColumn, localeCookieName, negotiateLocale, resolveLocale } from '@mistriwork/engine/shared/appLocale.js';
import { columnKind, tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { appCatalogs } from './appMessages.js';
import { peopleByAccount, personTable } from '../../shared/appMe.js';

export async function readLocale(
  ui: AppUi | undefined,
  /** The reader's own catalog: a column it does not serve is not asked for, since a refused read would fail the request. */
  schema: DatabaseSchema,
  query: (request: QueryRequest) => Promise<QueryResult>,
): Promise<string | undefined> {
  const named = localeColumn(ui);
  if (!named) return undefined;
  const table = tableNamed(schema, named.resource);
  if (!table?.columns.some((column) => column.name === named.column)) return undefined;
  const { rows } = await query({ table: table.id, columns: [named.column], limit: 1, offset: 0 });
  return canonicalLocale(rows[0]?.[named.column]);
}

/**
 * A tenant member's own tag for their command (`ctx.locale`), as `readLocale`
 * reads it for their pages and `commandZone` reads the zone, under the tenant's
 * scope: where `ui.locale` names a column of the people table `auth.me` names,
 * the member's own row of it, found by their account's id as `me` finds it (the
 * scope holds every member's row, and the first is someone else's); a column of
 * any other table is the tenant's own setting, its first row. A column the scope
 * cannot read, or a member with no row (or two), is no tag, never a failed
 * command: the cookie, then the App's, answer.
 */
export async function scopedLocale(
  app: Pick<AppDef, 'ui' | 'auth'>,
  /** The member's account id: what a tenant App's people are found by (appMe.ts `peopleByAccount`). */
  account: string | undefined,
  reads: () => Promise<{ query(request: QueryRequest): Promise<QueryResult> }>,
): Promise<string | undefined> {
  const named = localeColumn(app.ui);
  if (!named || named.resource === 'tenant') return undefined;
  const me = app.auth?.me;
  const own = me && me.from === named.resource;
  if (own && (typeof account !== 'string' || !account)) return undefined;
  try {
    const { rows } = await (
      await reads()
    ).query({
      table: named.resource,
      columns: [named.column],
      offset: 0,
      ...(own ? { limit: 2, filter: { groups: [[{ column: me.column, op: '=', value: account }]] } } : { limit: 1 }),
    });
    return own && rows.length !== 1 ? undefined : canonicalLocale(rows[0]?.[named.column]);
  } catch {
    return undefined;
  }
}

/**
 * The reader's own row the language picker writes their pick to: where
 * `ui.locale` names a column of the people table `auth.me` names, and `me`
 * found their row there. The key is their own, which they read anyway; the
 * write goes through /api/update under their grants like any other.
 */
export function localeRow(
  app: AppDef,
  schema: DatabaseSchema,
  person: QueryPerson | undefined,
): { table: string; key: Record<string, string | number>; column: string } | undefined {
  const named = localeColumn(app.ui);
  const key = person?.person?.key;
  const table = named && tableNamed(schema, named.resource);
  if (!table || key === null || key === undefined || person!.person!.table !== table.id) return undefined;
  const pk = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
  if (pk.length !== 1 || !table.columns.some((column) => column.name === named!.column)) return undefined;
  return { table: table.id, key: { [pk[0]!]: key }, column: named!.column };
}

/**
 * A signed-in person's own tag, for what runs on their behalf rather than
 * what they read (a command's `ctx.locale`): the `ui.locale` column of their
 * row of the people table `auth.me` names, found as `me` finds it — by the
 * account where people are bound by account, else by the verified email.
 * Read by the server, since the person's own row is all it names and the tag
 * goes nowhere but their own command; undefined where there is no such row.
 */
export async function personLocale(
  app: AppDef,
  schema: DatabaseSchema,
  reader: { query: (request: QueryRequest) => Promise<QueryResult> },
  who: { email?: string | undefined; account?: string | undefined },
): Promise<string | undefined> {
  const named = localeColumn(app.ui);
  if (!named) return undefined;
  const { table, column } = personTable(app, schema);
  if (!table || !column || tableNamed(schema, named.resource)?.id !== table.id) return undefined;
  if (!table.columns.some((each) => each.name === named.column)) return undefined;
  const match = peopleByAccount(app) ? who.account : who.email;
  if (typeof match !== 'string' || !match) return undefined;
  const { rows } = await reader.query({
    table: table.id,
    columns: [named.column],
    limit: 2,
    offset: 0,
    filter: { groups: [[{ column, op: '=', value: match }]] },
  });
  /* Two rows carrying one email name nobody in particular, as `me` reads them. */
  return rows.length === 1 ? canonicalLocale(rows[0]?.[named.column]) : undefined;
}

/** Startup's check of the column against the whole catalog: a declared resource's text column. */
export function localeColumnProblem(app: AppDef, schema: DatabaseSchema): string | undefined {
  const named = localeColumn(app.ui);
  if (!named) return undefined;
  const where = `"ui.locale" reads "${named.resource}.${named.column}"`;
  if (!Object.hasOwn(app.resources ?? {}, named.resource)) return `${where}, and "${named.resource}" is not one of the App's resources.`;
  const column = tableNamed(schema, named.resource)?.columns.find((column) => column.name === named.column);
  if (!column) return `${where}, and "${named.resource}" has no column "${named.column}".`;
  if (columnKind(column.type) !== 'text') return `${where}, which is ${column.type}; a locale is text like "es-MX".`;
  return undefined;
}

/** The locales an App has words for: its catalogs' (none without a messages/ folder). */
export function catalogLocales(app: AppDef): string[] {
  const catalogs = appCatalogs(app);
  return catalogs ? Object.keys(catalogs.locales) : [];
}

/**
 * The language a reader picked in this browser (the picker's cookie,
 * shared/appLocale.ts `localeCookieName`), among the App's catalogs: read as
 * their own where the App names no column of their row, and only for an App
 * with words to choose between. Negotiated as a header is, so a tag outside
 * the catalogs is no choice and a region keeps its figures.
 */
export function pickedLocale(app: AppDef, req: Pick<IncomingMessage, 'headers'> | undefined): string | undefined {
  const header = req?.headers.cookie;
  if (typeof header !== 'string' || header.length > 8192) return undefined;
  const offered = catalogLocales(app);
  if (offered.length < 2) return undefined;
  const name = localeCookieName(app.id);
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== name) continue;
    let value: string;
    try {
      value = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      return undefined;
    }
    return negotiateLocale(value, offered);
  }
  return undefined;
}

/**
 * One reader's locale, nearest first: their own row's (else their pick in
 * this browser), their tenant's, the browser's where nobody is known, then
 * the App's. The browser is asked only
 * for an App with words to choose between, and the answer then varies on it:
 * `Vary: Accept-Language` goes on the response.
 */
export function requestLocale(
  app: AppDef,
  options: {
    person?: string | undefined;
    tenant?: string | undefined;
    /** Nobody known: a public page, the sign-in screen. */
    visitor: boolean;
    req?: Pick<IncomingMessage, 'headers'>;
    res?: Pick<ServerResponse, 'getHeader' | 'setHeader'>;
    /** The language the request names itself (`askedLocale`): where it names one, it is the answer among the App's
        catalogs, else the App's own; the pick and the browser are not asked. */
    asked?: string | null | undefined;
  },
): string | undefined {
  if (typeof options.asked === 'string') {
    const catalogs = catalogLocales(app);
    return resolveLocale({
      person: catalogs.length > 1 ? negotiateLocale(canonicalLocale(options.asked), catalogs) : undefined,
      app: app.ui.locale,
    });
  }
  const offered = options.visitor ? catalogLocales(app) : [];
  if (offered.length > 1 && options.res) varyOnLanguage(options.res);
  const header = options.req?.headers['accept-language'];
  return resolveLocale({
    person: canonicalLocale(options.person) ?? pickedLocale(app, options.req),
    tenant: options.tenant,
    browser: offered.length > 1 ? negotiateLocale(Array.isArray(header) ? header.join(',') : header, offered) : undefined,
    app: app.ui.locale,
  });
}

/**
 * The language a public form's request names in its own address (`?locale=`), or null where it names none. A form is
 * fetched without the visitor's cookies (client/publicForm.js), so the client says the pick it holds; the URL then
 * keys the answer, as `Vary` keys one said from the headers.
 */
export function askedLocale(req: Pick<IncomingMessage, 'url'>): string | null {
  const at = req.url?.indexOf('?') ?? -1;
  return at < 0 ? null : new URLSearchParams(req.url!.slice(at + 1)).get('locale');
}

/** Add `Accept-Language` to a response's `Vary`, once. */
export function varyOnLanguage(res: Pick<ServerResponse, 'getHeader' | 'setHeader'>): void {
  addVary(res, 'Accept-Language');
}

/** Add `Cookie` to a response's `Vary`, once: a visitor's answer said in the language they picked (`pickedLocale`). */
export function varyOnPick(res: Pick<ServerResponse, 'getHeader' | 'setHeader'>): void {
  addVary(res, 'Cookie');
}

function addVary(res: Pick<ServerResponse, 'getHeader' | 'setHeader'>, name: string): void {
  const current = res.getHeader('vary');
  const list = (Array.isArray(current) ? current.join(',') : current === undefined ? '' : String(current))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (list.some((item) => item === '*' || item.toLowerCase() === name.toLowerCase())) return;
  res.setHeader('vary', [...list, name].join(', '));
}

/** Take `Accept-Language` back out of a response's `Vary`: an answer said in a locale its address names (`/api/og`). */
export function unvaryOnLanguage(res: Pick<ServerResponse, 'getHeader' | 'setHeader' | 'removeHeader'>): void {
  const current = res.getHeader('vary');
  if (current === undefined) return;
  const list = (Array.isArray(current) ? current.join(',') : String(current))
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && item.toLowerCase() !== 'accept-language');
  if (list.length) res.setHeader('vary', list.join(', '));
  else res.removeHeader('vary');
}
