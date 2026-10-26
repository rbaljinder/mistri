import type { ReactNode } from 'react';
import { useMessageLanguage } from './useMessageLanguage.js';
import { columnLabel, keyOf, labelPath, openRecord, recordLabel, rowLabel, state } from '../core.js';
import { opensRecord } from '../recordIntent.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { TrailList } from '../recordTrail.js';
import { Value } from './Value.js';
import { rowOpensTarget, useRowOpens } from './rowOpens.js';
import type { GridData } from './Grid.js';
import { presentationColumns } from './columnPresentation.js';
import { splitConditions, splitQuery } from '../clauses.js';
import { say } from '../copy/record/components/RecordSummaries.js';

/**
 * The columns a question holds to one value (`status = new`, a tab's own
 * condition): every record the list shows says the same there, so a summary
 * that repeats it on each is a line spent saying nothing. Only a whole
 * condition of one literal counts; `a or b`, a range or a window phrase does not.
 */
export function fixedColumns(query: string | undefined): string[] {
  if (!query) return [];
  return splitConditions(splitQuery(query).filter).flatMap((condition: string) => {
    const match = /^([\w.]+)\s*=\s*("[^"]*"|'[^']*'|[\w.-]+)$/.exec(condition.trim());
    return match ? [match[1]] : [];
  });
}

/** The authored column order is the mobile priority; state remains visible. */
export function summaryColumns(table: TableMeta, columns: string[]): string[] {
  const naming = labelPath(table);
  const keys = primaryKey(table);
  const facts = columns.filter((name) => name !== naming && !keys.includes(name));
  const state = facts.filter((name) => /^(status|stage|priority)$/.test(name));
  return [...new Set([...state, ...facts])].slice(0, 4);
}

/**
 * The column a link row is titled by, where it has no title of its own: the
 * name of the row it links to that is not the record it is listed under. A
 * campaign's member row (`campaign_id`, `lead_id`, a date, a flag) on a
 * lead's page was a card titled "6" — its key — over a "Campaign" line that
 * named it; it is the campaign's card there. `parent` names the reference
 * to the record the list is under (and every column the list holds to one
 * value is one too), so it is never the title. Null where the row names
 * itself, or nothing shown names a row it links to.
 */
export function linkTitleColumn(
  table: TableMeta,
  columns: string[],
  parent: string[],
  referenceLabels?: Record<string, string>,
): string | null {
  if (recordLabel(table) !== undefined) return null;
  const naming = labelPath(table);
  if (naming && !primaryKey(table).includes(naming)) return null;
  const links = table.columns.filter((column) => column.references && !parent.includes(column.name)).map((column) => column.name);
  for (const link of links) {
    if (referenceLabels?.[link] && columns.includes(link)) return link;
    const path = columns.find((name) => name.startsWith(`${link}.`) && !name.slice(link.length + 1).includes('.'));
    if (path) return path;
  }
  return null;
}

/**
 * The columns a summary says under its title: the page's columns less what the question fixes, the link that titles
 * the row, and any column whose value *is* the title on every row. A record named by a template of one column
 * (`recordLabel: '{title}'`) reaches `labelPath` as the template, not the column, so the column was listed again under
 * its own name, as "Title Outlet not working" below "Outlet not working". A reference is compared by the name it is
 * drawn as (`referenceLabels`), not by its key: a lease titled "Alder Court #406" listed "Home" with the same words.
 */
function shownValue(row: Record<string, unknown>, name: string, referenceLabels?: Record<string, string>): string {
  const label = referenceLabels?.[name];
  return String((label ? row[label] : row[name]) ?? '');
}

function summaryFacts(
  table: TableMeta,
  columns: string[],
  rows: Array<Record<string, unknown>>,
  titles: string[],
  skip: string[],
  referenceLabels?: Record<string, string>,
): string[] {
  const echoes = (name: string) => rows.length > 0 && rows.every((row, i) => shownValue(row, name, referenceLabels) === titles[i]);
  return summaryColumns(
    table,
    columns.filter((name) => !skip.includes(name) && !echoes(name)),
  );
}

/**
 * Whether the table has anything the summaries leave out, which is the only reason to offer the Table beside them
 * (TableView): the summaries say four facts under a title, so a list of more has a wider reading, and a list of
 * fewer has the same one in two dresses.
 */
export function tableSaysMore(
  table: TableMeta,
  columns: string[],
  rows: Array<Record<string, unknown>>,
  query?: string,
  referenceLabels?: Record<string, string>,
): boolean {
  const titles = rows.map((row) => String(rowLabel(table, row) ?? ''));
  const fixed = fixedColumns(query);
  const said = summaryFacts(table, columns, rows, titles, fixed, referenceLabels);
  const keys = primaryKey(table);
  const naming = labelPath(table);
  return columns.some(
    (name) =>
      !said.includes(name) &&
      !fixed.includes(name) &&
      !keys.includes(name) &&
      name !== naming &&
      !rows.every((row, i) => shownValue(row, name, referenceLabels) === titles[i]),
  );
}

export function RecordSummaries({
  table,
  data,
  columns,
  labels,
  referenceLabels,
  list,
  recordForRow,
  query,
  parent,
  adornFact,
}: {
  table: TableMeta;
  data: GridData;
  columns: string[];
  labels?: Record<string, string>;
  /** The list's question: a column it holds to one value is left out of every summary (fixedColumns). */
  query?: string;
  /** Joined names already carried by the list query; raw values remain keys. */
  referenceLabels?: Record<string, string>;
  /** The list these rows are a page of, so a record opened here steps past the page (recordTrail.ts). */
  list?: TrailList;
  /** Related projections can alias primary keys and the record's naming path. */
  recordForRow?: (row: Record<string, unknown>) => {
    key: Record<string, unknown> | null;
    label: string;
  };
  /** The reference to the record this list is under, on a record's page (linkTitleColumn). */
  parent?: string;
  /**
   * What the host draws for an empty fact in place of its empty mark (a suggestion waiting on it, the shell's
   * `useCellMarks` in its summary form); undefined leaves the mark. It stands in the mark's own box: a fact's line
   * wraps, so anything wider arriving later would move the facts after it.
   */
  adornFact?: (row: Record<string, unknown>, column: string) => ReactNode | undefined;
}) {
  useMessageLanguage();
  const fixed = fixedColumns(query);
  const linkTitle = linkTitleColumn(table, columns, [...fixed, ...(parent ? [parent] : [])], referenceLabels);
  const linked = (row: Record<string, unknown>) => {
    const value = linkTitle ? (referenceLabels?.[linkTitle] ? row[referenceLabels[linkTitle]] : row[linkTitle]) : undefined;
    return value == null || String(value) === '' ? undefined : String(value);
  };
  /* A list whose rows open what they are about (a view's `opens`) opens that from a summary too, alone. */
  const opens = useRowOpens();
  const items = (data.rows ?? []).map((row) => {
    const target = opens && !recordForRow ? rowOpensTarget(table, row, opens) : undefined;
    if (target !== undefined)
      return {
        row,
        opensTable: target?.table,
        key: target?.key ?? null,
        label: linked(row) ?? target?.label ?? '',
      };
    const record = recordForRow?.(row) ?? {
      key: keyOf(table, row) as Record<string, unknown> | null,
      label: rowLabel(table, row) as string,
    };
    return {
      row,
      opensTable: undefined as string | undefined,
      ...record,
      label: linked(row) ?? record.label,
    };
  });
  const facts = summaryFacts(
    table,
    columns,
    items.map(({ row }) => row),
    items.map(({ label }) => label),
    [...fixed, ...(linkTitle ? [linkTitle] : [])],
    referenceLabels,
  );
  const metadata = presentationColumns(state.schema, table, facts);
  const records = items.flatMap(({ key, label }) => (key ? [{ key, label }] : []));
  const trail = opens ? {} : { records, list };
  return (
    <ul className="record-summaries" aria-label={say('common.records')}>
      {items.map(({ row, key, label: title, opensTable }, index) => {
        return (
          <li
            key={key ? JSON.stringify(key) : index}
            className={`record-summary${key ? ' is-navigable' : ''}`}
            data-opens={key ? opensRecord(opensTable ?? table.id, key) : undefined}
            onClick={(event) => {
              // The title remains the keyboard target; nested controls own their clicks.
              if (
                !key ||
                (event.target as Element).closest('button, a, input, select, textarea, summary, [role="button"], [contenteditable="true"]')
              )
                return;
              if (window.getSelection()?.isCollapsed === false) return;
              void openRecord(opensTable ?? table.id, key, title, 'push', trail);
            }}
          >
            <button
              type="button"
              className="record-summary-title"
              disabled={!key}
              onClick={() => {
                if (key) void openRecord(opensTable ?? table.id, key, title, 'push', trail);
              }}
            >
              {title}
            </button>
            <dl>
              {facts.map((name) => {
                const label = referenceLabels?.[name] ? row[referenceLabels[name]] : undefined;
                const col = metadata.get(name) ?? {
                  name,
                  type: 'TEXT',
                  nullable: true,
                  primaryKey: false,
                };
                const value = label ?? row[name];
                const adorned = adornFact && (value === null || value === undefined || value === '') ? adornFact(row, name) : undefined;
                return (
                  <div key={name}>
                    <dt>{labels?.[name] ?? columnLabel(table.id, name) ?? humanName(name)}</dt>
                    <dd>
                      {adorned ?? <Value tableId={table.id} col={label == null ? col : { ...col, type: 'TEXT' }} value={value} compact />}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </li>
        );
      })}
    </ul>
  );
}
