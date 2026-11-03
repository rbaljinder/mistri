/**
 * A grouped grid's heads (a list view's `group`): one breakdown of the group's column over everything the list's
 * conditions match — each value's rows counted and each `totals` column summed — never a read per group. Asked in the
 * list's own query family, as the footer's sums are, so a write that redraws the rows redraws the heads with them.
 * The rows themselves are read in the group's order (listQuestion.ts groupedQuestion, in TableRoom.tsx), so the grid
 * draws a head wherever a run of one value begins (Grid.tsx `group`).
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { humanName } from '@mistriwork/engine/shared/model.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { api, columnDisplay, columnLabel, state } from '../core.js';
import { splitQuery } from '../clauses.js';
import { presentationColumns } from './columnPresentation.js';
import { groupLabel, type DisplayRule } from './valueModel.js';
import type { GridGroup, GroupHead } from './Grid.js';
import { say } from '../copy/lists/components/useGridGroups.js';

/** The most groups one list's heads are read for: past it a run of rows still stands under its value, uncounted. */
const GROUP_HEADS = 500;

interface Heads {
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  /** A reference's records by key, named (the breakdown names a reference's keys). */
  names?: Record<string, Record<string, string>>;
}

const keyText = (value: unknown): string => (value === null || value === undefined ? '\u0000' : String(value));

export function useGridGroups({
  column,
  table,
  query,
  totals,
  connection,
}: {
  /** The view's `group`; absent, the grid is not grouped and nothing is asked. */
  column: string | undefined;
  table: TableMeta | undefined;
  /** The list's question as the reader has it: its conditions are the heads' too, its sort and page are not. */
  query: string;
  totals: readonly string[] | undefined;
  connection: string | null | undefined;
}): GridGroup | undefined {
  const tableId = table?.id ?? '';
  const text = column
    ? [
        tableId,
        splitQuery(query).filter,
        ['count as group_rows', ...(totals ?? []).map((name, i) => `sum ${name} as total_${i}`)].join(', '),
        `by ${column}`,
      ]
        .filter(Boolean)
        .join(' ')
    : '';
  const answer = useQuery({
    queryKey: ['run', connection ?? '', 'groups', text],
    queryFn: async () => {
      const data = (await api('/api/breakdown', { text, limit: GROUP_HEADS })) as Heads & { errors?: unknown[] };
      return data.errors?.length ? null : data;
    },
    enabled: Boolean(column && table),
  });
  const heads = answer.data;
  return useMemo(() => {
    if (!column || !table) return undefined;
    const keyName = heads?.columns?.[0];
    const counted = new Map((heads?.rows ?? []).map((row) => [keyText(keyName ? row[keyName] : undefined), row]));
    const names = keyName ? heads?.names?.[keyName] : undefined;
    const display = columnDisplay(tableId, column) as DisplayRule | null;
    const allowed = presentationColumns(state.schema, table, [column]).get(column)?.allowed;
    /* "No stage": the column's caption in its sentence, an acronym kept as it is (PageGroups.tsx's rule). */
    const caption = (columnLabel(tableId, column) as string | null) ?? humanName(column.replace(/_id$/, ''));
    const noValue = say('noGroupValue', { caption: /^[A-Z][a-z]/.test(caption) ? caption[0].toLowerCase() + caption.slice(1) : caption });
    return {
      column,
      head: (value: unknown): GroupHead => {
        const label =
          value === null || value === undefined
            ? noValue
            : names && Object.hasOwn(names, String(value))
              ? names[String(value)]
              : groupLabel(display, value, allowed);
        const row = counted.get(keyText(value));
        if (!row) return { label };
        return {
          label,
          count: Number(row.group_rows) || 0,
          ...(totals?.length ? { sums: Object.fromEntries(totals.map((name, i) => [name, row[`total_${i}`] ?? 0])) } : {}),
        };
      },
    };
  }, [column, table, tableId, heads, totals]);
}
