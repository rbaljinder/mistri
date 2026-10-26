/**
 * The question an App's list asks, as its first page sends it: the table,
 * the view's standing condition and a tab's, the order the view keeps, and
 * the plumbing — the show clause that fetches its columns, the names its
 * references are read by, the keys a row needs to open, its page size.
 *
 * The client's list builds its question by these rules
 * (client/components/appListModel.ts), and the server builds a first page's
 * the same way (server/http/firstPaintRooms.ts) so the answer it carries in
 * the page is the answer to the request the list then makes. One rule on
 * both sides: a copy would drift, and a drifted copy is a request the page
 * did not carry.
 */
import { andQuery } from './query.js';
import { splitQuery } from './clauses.js';
import { listPresentationColumns } from './appListColumns.js';
import { findTable, labelPath, primaryKey, type DatabaseSchema, type TableMeta } from './schema.js';
import { referenceProjection } from './referenceModel.js';
import { tableAtPrefix } from './viewPaths.js';
import type { ServedResource } from './servedApp.js';
import type { AppListPresentation } from './listPresentations.js';
import { leadTonePath, subtitlePath } from './subtitlePath.js';
import { currencyPath } from './money.js';

/** What a list's question is read over: the schema, and the App's resources — their record labels and display rules. */
export interface ListRules {
  readonly schema: DatabaseSchema;
  readonly resources: Readonly<Record<string, Pick<ServedResource, 'recordLabel' | 'display'>>>;
}

/** One of a list's tabs: its label and the condition it adds. */
export interface ListTab {
  label: string;
  query?: string;
  /** Its word in an address where the label is said in another language (addressParams.ts `tabKey`). */
  slug?: string;
}

/** What of a list view its question is made from. */
export interface ListQuestionSpec {
  table: string;
  query?: string;
  tabs?: ListTab[];
  show?: string[];
  presentation?: AppListPresentation;
  sort?: string;
  order?: string;
  limit?: number;
  editable?: true | string[];
  /** The reference column whose record a row opens (a view's `opens`): fetched, as the row's key is, to open it. */
  opens?: string;
}

const squeeze = (text: unknown): string =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();

const resource = (rules: ListRules, tableId: string) => (Object.hasOwn(rules.resources, tableId) ? rules.resources[tableId] : undefined);

/** A table's record label, where its resource names one (false: a projection that withholds it). */
const recordLabelOf = (rules: ListRules, table: TableMeta): string | false | undefined => resource(rules, table.id)?.recordLabel;

/** Where a row's name lives, as a view path (schema.ts labelPath), by the App's record label. */
const labelPathOf = (rules: ListRules, table: TableMeta): string | undefined => labelPath(rules.schema, table, recordLabelOf(rules, table));

/**
 * The references among a list's columns, each with the path its record's
 * name is read from: `partner_id` → `partner_id.code` where the partner's
 * resource says `recordLabel: 'code'`, else the name the record page would
 * give it. A target with nothing better than its key keeps the key.
 */
export function referenceNames(rules: ListRules, tableId: string, names: readonly string[]): Record<string, string> {
  const base = findTable(rules.schema, tableId);
  if (!base) return {};
  const naming = (target: TableMeta) => {
    const path = labelPathOf(rules, target);
    return path && !primaryKey(target).includes(path) ? path : undefined;
  };
  return Object.fromEntries(referenceProjection(rules.schema, base, names, true, naming).labels);
}

/** The columns a shown column's second line reads: fetched with the row, drawn under it. */
export function subtitleColumns(rules: ListRules, tableId: string, shown: readonly string[]): string[] {
  return [
    ...new Set(
      shown.flatMap((name) => {
        /* A dotted column wears the rule of the table it was read from, and its
       second line is read from that table too. */
        const hop = name.lastIndexOf('.');
        const owner = hop < 0 ? tableId : tableAtPrefix(rules.schema, tableId, name.slice(0, hop))?.id;
        const rule = owner ? resource(rules, owner)?.display?.[name.slice(hop + 1)] : undefined;
        /* A lead icon's tone is read with the row too: a failed run's square says so without a second column. */
        return [
          subtitlePath(rule as { subtitle?: string } | undefined, name),
          leadTonePath(rule as { icon?: { toneOf?: string } }, name),
          /* A money column whose currency is each row's own reads that code with it. */
          currencyPath(rule as { currencyColumn?: string } | undefined, name),
        ].filter((path): path is string => path !== undefined);
      }),
    ),
  ];
}

/** The references an editable list shows by name (`owner_id.name`): their keys ride along
    with the row, so a cell edits the reference and says what it replaces. */
export function editedReferences(rules: ListRules, spec: Pick<ListQuestionSpec, 'table' | 'show' | 'editable' | 'presentation'>): string[] {
  const t = findTable(rules.schema, spec.table);
  if (!t || !spec.editable || spec.presentation) return [];
  return [
    ...new Set(
      (spec.show ?? []).flatMap((name) => {
        const hop = name.indexOf('.');
        const head = name.slice(0, hop);
        return hop > 0 &&
          name.indexOf('.', hop + 1) < 0 &&
          (spec.editable === true || spec.editable!.includes(head)) &&
          t.columns.some((column) => column.name === head && column.references)
          ? [head]
          : [];
      }),
    ),
  ];
}

/** The references a list draws — its `show`, its presentation's columns, or every column — by the path each is named from (referenceNames). */
export function listReferenceNames(
  rules: ListRules,
  spec: Pick<ListQuestionSpec, 'table' | 'show' | 'presentation'>,
): Record<string, string> {
  const t = findTable(rules.schema, spec.table);
  if (!t) return {};
  const drawn = [...(spec.show ?? []), ...(spec.presentation ? listPresentationColumns(spec.presentation) : [])];
  return referenceNames(rules, spec.table, drawn.length ? drawn : t.columns.map((column) => column.name));
}

/** The show clause that fetches the app's columns plus the keys a row needs to open.
    A presentation names the columns it draws, so a view of cards needs no `show`. */
export function showClause(rules: ListRules, spec: ListQuestionSpec): string {
  const t = findTable(rules.schema, spec.table);
  const names = spec.show ?? [];
  const listNames = spec.presentation ? listPresentationColumns(spec.presentation) : [];
  if (!t) return '';
  const naming = recordLabelOf(rules, t) === undefined ? undefined : labelPathOf(rules, t);
  const named = Object.values(listReferenceNames(rules, spec));
  if (!names.length && !listNames.length && !naming && !named.length) return '';
  const shown = names.length || listNames.length ? names : t.columns.map((column) => column.name);
  return `show ${[
    ...new Set([
      ...shown,
      ...listNames,
      ...(naming ? [naming] : []),
      ...named,
      ...(spec.order ? [spec.order] : []),
      ...subtitleColumns(rules, spec.table, names),
      ...editedReferences(rules, spec),
      ...(spec.opens ? [spec.opens] : []),
      ...primaryKey(t),
    ]),
  ].join(', ')}`;
}

/* The authored page size, as the question writes it after the show clause. */
export const limitClause = (spec: Pick<ListQuestionSpec, 'limit'>): string => (spec.limit ? `limit ${spec.limit}` : '');

/* A view's hand order is plumbing too: "sort position" is how the list is
   kept, not a sort anyone chose, so it is asked wherever nothing else sorts
   the question — a tab's own sort, a header's, the reader's own win — and
   folded out of what the bar shows. A view's default `sort` is the same
   reading, said in the query bar's words. */
export const orderClause = (spec: Pick<ListQuestionSpec, 'order' | 'sort'>): string =>
  spec.order ? `sort ${spec.order}` : spec.sort ? `sort ${spec.sort}` : '';

export function withOrder(spec: Pick<ListQuestionSpec, 'table' | 'order' | 'sort'>, question: string): string {
  const order = orderClause(spec);
  return order && !splitQuery(`${spec.table} ${question}`).sort ? squeeze(`${question} ${order}`) : question;
}

/** The full query text one of the app's tabs stands for. A module's
    standing conditions come first; a tab refines on top of them. */
export function appListQuery(rules: ListRules, spec: ListQuestionSpec, index = 0): string {
  const tab: Partial<ListTab> = (spec.tabs?.length ? spec.tabs : [{}])[index] ?? {};
  const where = withOrder(spec, andQuery(spec.query, tab.query) ?? '');
  return [spec.table, where, showClause(rules, spec), limitClause(spec)].filter(Boolean).join(' ');
}
