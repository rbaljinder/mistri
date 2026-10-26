/**
 * A tenant's own words over the App's (`ui.messages: fromRecord(...)`,
 * design §5): one row per message and locale in a tenant-owned table. Read
 * through the reader the request already holds — the tenant's own grants and
 * row scope, never a reader of the App's — and checked row by row against the
 * source catalog the loader set on the binding: a key the source has, ICU that
 * parses, the source's arguments or fewer. A row that fails is skipped with a
 * warning, never served; the same check refuses it on write (appValidation.ts
 * `messageRow`). A row whose tenant column is not the reader's tenant is never
 * read as theirs.
 */
import { createHash } from 'node:crypto';
import type { QueryRequest, QueryResult } from '@mistriwork/engine/adapters/adapter.js';
import type { AppDef } from '../../shared/appModel.js';
import type { RecordMessagesSpec } from '../../shared/branding.js';
import { canonicalLocale } from '@mistriwork/engine/shared/appLocale.js';
import { MESSAGE_KEY } from '@mistriwork/engine/shared/appMessages.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { messageArgs, type MessageOverrides } from './appMessages.js';

/** A tenant's words are a few hundred rows; past this many, the rest are not read. */
const MOST_ROWS = 5000;
const MOST_TEXT = 4000;

/** Which of the three columns a refusal names. */
interface MessageRowProblem {
  readonly field: 'key' | 'locale' | 'text';
  readonly reason: string;
}

/**
 * What is wrong with one row, or undefined: the key must be one of the source
 * catalog's, the locale a language tag, the text ICU that reads only arguments
 * the source's text reads. Imports the formatter on first use.
 */
export async function messageRowProblem(
  spec: RecordMessagesSpec,
  key: unknown,
  locale: unknown,
  text: unknown,
): Promise<MessageRowProblem | undefined> {
  const source = spec.source;
  if (!source) return { field: 'key', reason: 'The App has no messages to override.' };
  if (typeof key !== 'string' || !MESSAGE_KEY.test(key) || !Object.hasOwn(source.entries, key))
    return { field: 'key', reason: "This is not one of the App's messages." };
  if (!canonicalLocale(locale)) return { field: 'locale', reason: 'This is not a language tag like "es" or "es-MX".' };
  if (typeof text !== 'string' || !text.trim() || text.length > MOST_TEXT)
    return { field: 'text', reason: `The words must be text of at most ${MOST_TEXT} characters.` };
  const { default: Format } = await import('intl-messageformat');
  let names: Set<string>;
  try {
    names = messageArgs(new Format(text, canonicalLocale(locale)).getAst());
  } catch {
    return { field: 'text', reason: 'These words are not ICU MessageFormat: check every { has its }.' };
  }
  const allowed = messageArgs(new Format(source.entries[key]!, source.locale).getAst());
  const extra = [...names].filter((name) => !allowed.has(name));
  if (extra.length)
    return { field: 'text', reason: `The App's words say no {${extra.join('}, {')}}; use only {${[...allowed].join('}, {') || '…'}}.` };
  return undefined;
}

interface Checked {
  readonly fingerprint: string;
  readonly words: MessageOverrides;
  readonly skipped: readonly string[];
}
/* One tenant's checked words per binding, kept while the rows read the same: the read is every request's, only the check is cached. */
const checked = new WeakMap<RecordMessagesSpec, Map<string, Checked>>();
const warned = new Set<string>();

/**
 * One tenant's words, read under the reader's own grants, checked, and
 * stamped by the tenant and the rows' content: what `localizedApp` keys a
 * reader's definition by, so it is never another tenant's. Undefined where the
 * App binds none, nobody's tenant is known, or the reader may not read the table.
 */
export async function readTenantMessages(options: {
  app: Pick<AppDef, 'id' | 'ui'>;
  schema: DatabaseSchema;
  query: (request: QueryRequest) => Promise<QueryResult>;
  tenant: string | null | undefined;
}): Promise<TenantWords | undefined> {
  const spec = options.app.ui.messages;
  const { tenant } = options;
  if (!spec?.source || typeof tenant !== 'string' || !tenant) return undefined;
  const table = tableNamed(options.schema, spec.from);
  const columns = messageColumns(spec);
  if (!table || columns.some((name) => !table.columns.some((column) => column.name === name))) return undefined;
  let rows: Record<string, unknown>[];
  try {
    ({ rows } = await options.query({
      table: table.id,
      columns,
      filter: { groups: [[{ column: spec.tenantField, op: '=', value: tenant }]] },
      limit: MOST_ROWS,
      offset: 0,
    }));
  } catch {
    return undefined;
  }
  return checkTenantMessages(options.app.id, spec, tenant, rows);
}

/** One tenant's words, as `localizedApp` takes them: stamped by the tenant and what its rows said. */
interface TenantWords {
  readonly stamp: string;
  readonly words: MessageOverrides;
  readonly skipped: readonly string[];
}

/** The columns a row of words is read by: whose, which message, which locale, and the words. */
export const messageColumns = (spec: RecordMessagesSpec) => [spec.tenantField, spec.fields.key, spec.fields.locale, spec.fields.text];
export { MOST_ROWS as MOST_MESSAGE_ROWS };

/**
 * One tenant's rows, checked: a row of another tenant or one the check
 * refuses is skipped with a warning, once. The check is kept while the rows
 * read the same; the read is every caller's own.
 */
export async function checkTenantMessages(
  app: string,
  spec: RecordMessagesSpec,
  tenant: string,
  rows: readonly Record<string, unknown>[],
): Promise<TenantWords | undefined> {
  if (!spec.source) return undefined;
  const columns = messageColumns(spec);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(rows.map((row) => columns.map((name) => row[name]))))
    .digest('hex')
    .slice(0, 24);
  let byTenant = checked.get(spec);
  if (!byTenant) checked.set(spec, (byTenant = new Map()));
  let hit = byTenant.get(tenant);
  if (hit?.fingerprint !== fingerprint) {
    const words = new Map<string, Map<string, string>>();
    const skipped: string[] = [];
    for (const row of rows) {
      const key = row[spec.fields.key];
      const said = `${spec.from} row for "${String(key)}" (${String(row[spec.fields.locale])})`;
      /* Read under the tenant's own scope, so only its rows come back; one that names another tenant is not this one's. */
      if (row[spec.tenantField] !== tenant) {
        skipped.push(`${said}: it belongs to another tenant.`);
        continue;
      }
      const problem = await messageRowProblem(spec, key, row[spec.fields.locale], row[spec.fields.text]);
      if (problem) {
        skipped.push(`${said}: ${problem.reason}`);
        continue;
      }
      const locale = canonicalLocale(row[spec.fields.locale])!;
      let held = words.get(key as string);
      if (!held) words.set(key as string, (held = new Map()));
      held.set(locale, (row[spec.fields.text] as string).trim());
    }
    hit = { fingerprint, words, skipped };
    byTenant.delete(tenant);
    byTenant.set(tenant, hit);
    if (byTenant.size > 1024) byTenant.delete(byTenant.keys().next().value!);
    for (const line of skipped) {
      const once = `${app}|${tenant}|${line}`;
      if (warned.has(once)) continue;
      if (warned.size > 1024) warned.clear();
      warned.add(once);
      console.warn(`[mistri] ${app}: ui.messages skipped a ${line}`);
    }
  }
  return { stamp: `${tenant}:${hit.fingerprint}`, words: hit.words, skipped: hit.skipped };
}
