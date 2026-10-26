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
  },
): string | undefined {
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

/** Add `Accept-Language` to a response's `Vary`, once. */
export function varyOnLanguage(res: Pick<ServerResponse, 'getHeader' | 'setHeader'>): void {
  const current = res.getHeader('vary');
  const list = (Array.isArray(current) ? current.join(',') : current === undefined ? '' : String(current))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (list.some((item) => item === '*' || item.toLowerCase() === 'accept-language')) return;
  res.setHeader('vary', [...list, 'Accept-Language'].join(', '));
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
