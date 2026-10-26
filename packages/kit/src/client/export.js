/**
 * Export the result you are looking at, as CSV or JSON.
 *
 * The serialisers at the top are pure — columns and rows in, a string out —
 * because CSV is the part of this feature that is easy to get subtly wrong
 * and the only way to know it is right is to test it without a browser. Their
 * field and record rules are `shared/csv.ts`, which the server's streamed
 * export writes with too. The DOM half below is a thin wrapper over them.
 *
 * The rule the format has to hold up to: a spreadsheet reading the file back
 * must see exactly the values the grid showed, including the distinction
 * between a null and an empty string, which every naive `join(',')` loses.
 *
 * The control itself — the menu, the column chooser — is `components/Export.tsx`.
 */
import { el, findTable, loadJson, saveJson, state, toast } from './core.js';
import { maskQuoted } from './clauses.js';
import { MAX_LIMIT } from '@mistriwork/engine/shared/reads.js';
import { plural } from './locale.js';
import { CRLF, csvField, csvRecord, jsonRecord } from '@mistriwork/engine/shared/csv.js';
import { scopeApiRequest } from './requestIdentity.js';
import { captureSessionIdentity } from './sessionIdentity.js';
import { say } from './copy/workbench/export.js';
import { portalRoot } from './shellHost.js';
import { fetchServer } from './transport.js';

export { csvField };

/* Mirrors MAX_LIMIT in packages/engine/src/shared/reads.ts. The server clamps to it
   regardless, so this is only here to keep the button honest about how many
   rows "all matching" can actually mean. */
export const EXPORT_MAX_ROWS = MAX_LIMIT;

/** A CSV document: a header row of column names, then one row per record. */
export function toCsv(columns, rows) {
  const lines = [columns.map(csvField).join(',')];
  for (const row of rows ?? []) lines.push(csvRecord(columns, row));
  // CRLF, per RFC 4180, and a trailing one so the file ends on a record
  // boundary rather than mid-line.
  return lines.join(CRLF) + CRLF;
}

/** A JSON document: an array of objects, in the column order on screen (jsonRecord). */
export function toJson(columns, rows) {
  return `${JSON.stringify(
    (rows ?? []).map((row) => jsonRecord(columns, row)),
    null,
    2,
  )}\n`;
}

/**
 * Put the selected columns into a query, replacing any `show` clause it has.
 *
 * The language is parsed on the server and nowhere else, so the only way for
 * the client to ask for different columns is to edit the text — the same
 * trick the sortable headers use. Replacing rather than appending is the part
 * that matters: the parser concatenates repeated clauses with `and`, so a
 * second `show` would arrive as one column named "b and c" and the export
 * would fail with a column error instead of exporting anything.
 *
 * An empty list means "every column", which is what no `show` clause means.
 */
export function withColumns(query, names) {
  const marks = clauseMarks(query);
  let out = '';
  let cut = 0;
  marks.forEach((mark, i) => {
    if (mark.word !== 'show' && mark.word !== 'select') return;
    out += query.slice(cut, mark.start);
    cut = i + 1 < marks.length ? marks[i + 1].start : query.length;
  });
  const base = `${out}${query.slice(cut)}`.trim();
  return names.length ? `${base} show ${names.join(', ')}` : base;
}

/* Mirrors CLAUSE_RE in packages/engine/src/shared/query.ts. Two copies of a rule is a cost,
   but the alternative is a build step to share one — and the client is a
   static file on purpose. */
const CLAUSE_RE = /\b(filter|where|show|select|sort|order\s+by|limit)\b/gi;

/* ...including the rule that makes a clause word a column name instead. A
   table with a column called `show` is unusual but `show = 3` is a filter,
   and cutting from there would silently drop the rest of the query. */
const FOLLOWED_BY_OPERATOR = /^\s*(?:=|!=|>=|<=|>|<|\bis\b|\bcontains\b|\bstartswith\b|\bendswith\b|\bin\b|\bnot\s+in\b)/i;

function clauseMarks(text) {
  /* Scanned with quoted values blanked out, and the offsets used against the
     real text — the same masking the parser does, for the same reason. Without
     it `name contains "show me"` was cut at the value's own word, and the
     rewritten query came back with a filter holding `"sort name show id, name`:
     a string assembled out of the query's punctuation, exported as though it
     were what the user asked for. */
  const scannable = maskQuoted(text);
  const marks = [];
  CLAUSE_RE.lastIndex = 0;
  let m;
  while ((m = CLAUSE_RE.exec(scannable))) {
    if (FOLLOWED_BY_OPERATOR.test(scannable.slice(CLAUSE_RE.lastIndex))) continue;
    marks.push({ word: m[1].toLowerCase().replace(/\s+/g, ' '), start: m.index });
  }
  return marks;
}

/**
 * The chosen columns, in the order the table declares them.
 *
 * Not the order they were ticked in: two exports of the same table a week
 * apart should differ only where the data differs, and a column list that
 * depends on which checkbox someone clicked first makes every diff noise.
 * A name the table does not declare keeps its relative position at the end,
 * which is where a computed column from a view lands.
 */
export function orderColumns(selected, declared) {
  const rank = new Map(declared.map((name, i) => [name, i]));
  return [...new Set(selected)].sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER));
}

export const sameList = (a, b) => a.length === b.length && a.every((name, i) => name === b[i]);

/* ---------- which columns ---------- */

const COLUMN_KEY = 'mistri.export-columns.v1';

/* Per connection as well as per table: `orders` on staging and `orders` on
   production are not the same table, and neither are their useful columns. */
const scope = () => state.activeConnection ?? 'default';

/* Survives a re-render within the session even when nothing can be persisted,
   which is the case in private mode and with site data blocked. */
const chosen = new Map();

export function rememberColumns(tableId, names) {
  chosen.set(`${scope()}::${tableId}`, names);
  // loadJson/saveJson swallow a throwing or full localStorage: a column
  // preference that cannot be saved is not a reason to fail the export.
  const all = loadJson(COLUMN_KEY, {}) ?? {};
  all[scope()] = { ...(all[scope()] ?? {}), [tableId]: names };
  saveJson(COLUMN_KEY, all);
}

/** Column names of the table as the catalog declares them, or [] if unknown. */
export function declaredColumns(tableId) {
  if (!state.schema) return [];
  return (findTable(tableId)?.columns ?? []).map((c) => c.name);
}

/**
 * What to export, before anyone opens the chooser: last time's selection if
 * there is one, otherwise exactly what is on screen — which already respects
 * a `show` clause in the query.
 */
export function selectionFor(tableId, displayed, declared) {
  const key = `${scope()}::${tableId}`;
  const remembered = chosen.get(key) ?? loadJson(COLUMN_KEY, {})?.[scope()]?.[tableId];
  const known = new Set([...declared, ...displayed]);
  // A remembered column that no longer exists is dropped rather than sent:
  // the query would fail on it, and the export would fail with it.
  const valid = Array.isArray(remembered) ? remembered.filter((n) => known.has(n)) : [];
  return orderColumns(valid.length ? valid : displayed, declared);
}

/** `customer-2026-08-22.csv` — the table and the day, which is what you look for later. */
export function exportFilename(table, extension, now = new Date()) {
  const stem = String(table ?? 'export').replace(/[^\w.-]+/g, '_');
  return `${stem}-${now.toISOString().slice(0, 10)}.${extension}`;
}

export function download(filename, text, mime) {
  /* A UTF-8 CSV with no BOM opens in Excel as the local codepage, which turns
     every accented name into mojibake. The BOM is the one thing that makes it
     read the file as UTF-8, and other tools skip it. */
  const body = mime === 'text/csv' ? `\ufeff${text}` : text;
  const url = URL.createObjectURL(new Blob([body], { type: `${mime};charset=utf-8` }));
  const link = el('a', { href: url, download: filename });
  portalRoot().append(link);
  link.click();
  link.remove();
  /* Revoked, or the blob is held for the life of the page — but not until the
     next tick: revoking in the same task can cancel the download that click
     just started. */
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function saveExport(kind, table, columns, rows) {
  if (kind === 'csv') download(exportFilename(table, 'csv'), toCsv(columns, rows), 'text/csv');
  else download(exportFilename(table, 'json'), toJson(columns, rows), 'application/json');
  toast(say('exportedRows', { count: rows.length }));
}

/**
 * All matching rows, as a file the server streams (`POST /api/export`):
 * read in batches and written as each arrives, so neither side holds the
 * whole result as objects and nothing is counted. False where the server
 * does not offer it — a tenant host, a row-policy App (its replies wait for
 * the policy to settle, which a stream cannot) — and the caller exports
 * through `/api/run` as before.
 *
 * @param {'csv' | 'json'} kind
 * @param {string} table
 * @param {string} q
 * @param {string[]} columns the file's columns, in order
 * @returns {Promise<boolean>}
 */
export async function streamExport(kind, table, q, columns) {
  const identity = captureSessionIdentity();
  if (identity.tenantRequired) return false;
  const { url, payload } = scopeApiRequest('/api/export', { q, format: kind, columns }, state.activeConnection);
  const res = await fetchServer(url, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...(identity.mode === 'authenticated' ? { 'x-mistri-account': identity.accountId } : {}),
    },
    body: JSON.stringify(payload),
  });
  /* The file is the one answer with a disposition; anything else is JSON
     saying why not — a refusal to fall back from, or the query's error. */
  if (res.ok && res.headers.get('content-disposition')) {
    const blob = await res.blob();
    const link = el('a', { href: URL.createObjectURL(blob), download: exportFilename(table, kind) });
    portalRoot().append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
    toast(say('exportedAllMatchingRows'));
    return true;
  }
  if ([401, 403, 404, 405].includes(res.status)) return false;
  const said = await res.json().catch(() => null);
  throw new Error(said?.errors?.[0]?.message ?? said?.error ?? say('theExportCouldNotBeRead'));
}
