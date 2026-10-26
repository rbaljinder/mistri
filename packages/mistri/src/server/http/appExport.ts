/**
 * An App's part of an export (http/exportRoute.ts `ExportHooks`): who
 * exports which table, by the App's role grants and its `ui.export` switch;
 * who `me` is in the question; and what an amount kept in minor units, or a
 * value its component draws as a word, says in a CSV.
 */
import { appExportable } from '../../shared/appAccess.js';
import { sessionRoles } from '../../shared/appViewRoles.js';
import { minorToMajor, rowCurrency } from '@mistriwork/engine/shared/money.js';
import { findTable } from '@mistriwork/engine/shared/schema.js';
import { readMeSets, textsMentionMe } from '../app/appMe.js';
import { appForConnection } from '../app/apps.js';
import type { PostContext } from '@mistriwork/engine/server/http/context.js';
import type { ExportHooks } from '@mistriwork/engine/server/http/exportRoute.js';

/** Whether this request's person may export a table (`''`: any table). Everyone may where the App does not grant by role. */
function exportsTable(post: PostContext): (tableId: string) => boolean {
  const host = post.appHosts?.length
    ? appForConnection(post.appHosts, post.connection, post.registry.configOf(post.connection)?.name)
    : undefined;
  const allowed = host && appExportable(host.app.app, post.schema, sessionRoles(post.role), post.principal !== undefined);
  /* `ui.export: false` is the App's one switch and it holds here, not only on the menu: with role grants it is a ceiling over them. */
  const off = host?.app.app.ui?.export === false;
  return (tableId) => !off && (!allowed || (tableId ? allowed.has(tableId) : allowed.size > 0));
}

/**
 * A CSV says an amount kept in minor units as the figure it is — 1999 cents
 * as 19.99, in the row's currency — so the file reads as a sheet and imports
 * back as it was (appImport.ts reads it the same way). JSON keeps the data
 * as stored: it is read by programs, which know the unit from the API.
 */
function csvAmounts(post: PostContext, tableId: string): ((row: Record<string, unknown>) => Record<string, unknown>) | undefined {
  const host = post.appHosts?.length
    ? appForConnection(post.appHosts, post.connection, post.registry.configOf(post.connection)?.name)
    : undefined;
  const table = findTable(post.schema, tableId);
  if (!host || !table) return undefined;
  const app = host.app.app;
  const resources = (app.resources ?? {}) as Record<string, { display?: Record<string, unknown> }>;
  const display = (resources[table.id] ?? resources[table.name])?.display ?? {};
  const minor = Object.entries(display).filter(
    (
      entry,
    ): entry is [
      string,
      {
        format: 'money';
        minor: true;
        currency?: string;
        currencyColumn?: string;
      },
    ] => (entry[1] as { format?: string; minor?: true }).format === 'money' && (entry[1] as { minor?: true }).minor === true,
  );
  /* A column whose component draws the word says it in the file too, over the words its `label` gave (valueLabels.ts)
     and under the author's own `values`: a spreadsheet reader has no component to draw it. */
  const resource = resources[table.id] ? table.id : table.name;
  const spoken = Object.entries(display).flatMap(([column, rule]) => {
    const learned = (rule as { component?: unknown }).component ? app.valueLabels?.[`${resource}.${column}`] : undefined;
    return learned ? [[column, { ...learned, ...(rule as { values?: Record<string, string> }).values }] as const] : [];
  });
  if (!minor.length && !spoken.length) return undefined;
  const fallback = app.ui?.currency ?? 'USD';
  return (row) => {
    const said = { ...row };
    for (const [column, rule] of minor)
      if (Object.hasOwn(row, column)) said[column] = minorToMajor(row[column], rowCurrency(rule, row, fallback)) ?? row[column];
    for (const [column, words] of spoken) {
      const stored = row[column];
      if (typeof stored === 'string' && Object.hasOwn(words, stored)) said[column] = words[stored];
    }
    return said;
  };
}

export const APP_EXPORT: ExportHooks = {
  may: exportsTable,
  person: async (post, text) =>
    post.me && textsMentionMe([text], post.schema) ? readMeSets(await post.me(), [text], post.schema, post.adapter) : undefined,
  amounts: csvAmounts,
};
