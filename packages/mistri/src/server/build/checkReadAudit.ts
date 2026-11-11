/**
 * `read-audit-query`: a query the App writes over a resource whose reads are audited, which the audit could not keep.
 *
 * A list read's row keeps what it asked as canonical JSON (readAudit.ts auditQuery), and a read whose row cannot be
 * written is refused, with nothing it read leaving the server. So a view or a tab whose conditions the audit cannot
 * keep is a view that never shows a row, and the first anyone heard of it was a page that said its read could not be
 * recorded (a field report). Judged here the way a read is: the App's own query, parsed against the catalog, handed to
 * the same function the row is written with.
 */
import { tableNamed, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { expandSegments } from '@mistriwork/engine/shared/query.js';
import { parseViewQuery } from '@mistriwork/engine/shared/view.js';
import { checkedPerson } from '../../shared/appMe.js';
import { isFormView, type AppDef } from '../../shared/appModel.js';
import { READ_AUDIT_LIMITS } from '../../adapters/readAudit/readAudit.js';
import { auditQuery } from '../readAudit.js';

/** Each App-written query over an audited resource that the read audit could not record, in plain words. */
export function readAuditUnrecordable(app: AppDef, schema: DatabaseSchema): string[] {
  const audited = new Map<string, string>();
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const table = schema.tables.find((candidate) => candidate.id === name) ?? tableNamed(schema, name);
    if (resource.audit?.reads === true && table) audited.set(table.id, name);
  }
  if (!audited.size) return [];
  const person = checkedPerson(app, schema);
  const found: string[] = [];
  const judge = (where: string, table: TableMeta | undefined, text: string | undefined) => {
    const resource = table && audited.get(table.id);
    if (!resource || !text?.trim()) return;
    /* A segment is written out where it is named, as a read writes it (query.ts expandSegments). */
    const segments = app.resources?.[resource]?.segments;
    const named = segments && Object.fromEntries(Object.entries(segments).map(([key, segment]) => [key, segment.query]));
    const parsed = parseViewQuery(schema, table.id, expandSegments(text, named).text, undefined, person ? { me: person } : {});
    /* A query that does not parse is said by validation; this judges only what would be read. */
    if (parsed.errors.length) return;
    try {
      auditQuery(parsed.filter.groups, parsed.orderBy, 0);
    } catch {
      found.push(
        `${where}: reads of ${resource} are audited, and the read audit cannot record this query (it keeps at most ${READ_AUDIT_LIMITS.query / 1024} KiB of conditions), so every read through it would be refused. Shorten the query, or split it across tabs.`,
      );
    }
  };
  const tableOf = (name: string | undefined) =>
    name ? (schema.tables.find((table) => table.id === name) ?? tableNamed(schema, name)) : undefined;
  for (const [key, view] of Object.entries(app.views)) {
    if (isFormView(view) || 'landing' in view) continue;
    if ('sections' in view) {
      for (const section of [...view.sections, ...(view.aside ?? [])]) {
        const { table, query, title, kind } = section as { table?: string; query?: string; title?: string; kind: string };
        judge(`view "${key}", section "${title ?? kind}"`, tableOf(table), query);
      }
      continue;
    }
    const list = view as { table: string; query?: string; tabs?: ReadonlyArray<{ label: string; query?: string }> };
    const table = tableOf(list.table);
    judge(`view "${key}"`, table, list.query);
    for (const tab of list.tabs ?? []) judge(`view "${key}", tab "${tab.label}"`, table, tab.query);
  }
  return found;
}
