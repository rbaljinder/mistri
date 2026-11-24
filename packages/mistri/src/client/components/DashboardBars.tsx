/**
 * A breakdown drawn as bars (`shape: 'bars'`): the kit's `Bars` part over the dashboard's own breakdown read, so a page's
 * `<Breakdown shape="bars">` and a dashboard section are one drawing. A second measure (`also`, "4 deals") is asked in
 * the same line as the first (`sum amount, count by stage`), so the bars cost no request of their own. Also home to the
 * column order every breakdown keeps (orderOf), out of Dashboard.tsx so both read it without importing each other.
 */
import type { ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { findTable, columnDisplay } from '@mistriwork/kit/client/core.js';
import { batchedBreakdown } from '@mistriwork/kit/client/breakdownBatch.js';
import { breakdownText, namedGroups, orderGroups, sayer, type Section } from '@mistriwork/kit/client/components/dashboardModel.js';
import { groupsAskedFor } from '@mistriwork/engine/shared/dashboardAsks.js';
import { declaredOrder, orderDeclared } from '@mistriwork/kit/client/components/groupOrder.js';
import type { DisplayRule } from '@mistriwork/kit/client/components/valueModel.js';
import { Problem } from '@mistriwork/kit/client/components/Notes.js';
import { resourceOf } from '@mistriwork/kit/client/components/appRooms.js';
import { pluralOf, recordNoun } from '@mistriwork/engine/shared/appNoun.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { activeApp } from '../appState.js';
import { BreakdownList } from '@mistriwork/ui/charts.js';
import { sayGroup } from './dashboardSay.js';
import { TILE_FRESH, minuteTick } from './dashboardClock.js';

interface Breakdown {
  columns?: string[];
  rows?: Record<string, unknown>[];
  names?: Record<string, Record<string, string>>;
}

/** The order of the column a section groups by, where it declares one (groupOrder.ts, declaredOrder). */
export function orderOf(table: string | undefined, by: string | undefined): { vocabulary?: string[]; scale: boolean } {
  /* A computed column (an age in days) is not among the table's own columns: its declared type says whether it is a
     scale (shared/computed.ts). */
  const meta = findTable(table ?? '') as TableMeta | undefined;
  const computed = by && meta?.computed && Object.hasOwn(meta.computed, by) ? meta.computed[by] : undefined;
  const column = meta?.columns.find((c) => c.name === by) ?? (computed ? { type: computed.type } : undefined);
  return declaredOrder(column, by ? (columnDisplay(table ?? '', by) as DisplayRule | null) : null, by);
}

/** How a second measure is said beside its bar: a count in the records' own word ("4 deals"), else as its column says. */
function alsoSayer(section: Section): (value: unknown) => string {
  const also = section.also ?? '';
  if (/^count$/i.test(also.trim())) {
    const noun = resourceOf(activeApp(), section.table ?? '')?.noun;
    const one = recordNoun(noun, section.table ?? '');
    const many = noun?.many ?? pluralOf(one);
    return (value) => `${String(value ?? 0)} ${Number(value) === 1 ? one : many}`;
  }
  return sayer({ ...section, measure: also, format: undefined, unit: undefined });
}

/** `nothing`: what the section says when it counts no group, the dashboard's own empty state or its leaving out. */
export function DashboardBars({ section, nothing }: { section: Section; nothing: ReactNode }) {
  const measure = section.also ? `${section.measure ?? 'count'}, ${section.also}` : section.measure;
  const text = section.by ? breakdownText({ ...section, measure }, groupsAskedFor(section)) : null;
  const data = useQuery<Breakdown>({
    queryKey: ['breakdown', text, null],
    // Asked with the other sections of this paint, in one request (breakdownBatch.ts).
    queryFn: () => batchedBreakdown<Breakdown>({ text: text! }),
    enabled: Boolean(text),
    refetchInterval: minuteTick(text, section.table),
    staleTime: TILE_FRESH,
    placeholderData: keepPreviousData,
  });
  if (data.isError) return <Problem text={(data.error as Error).message} />;
  const { vocabulary, scale } = orderOf(section.table, section.by);
  /* While read, as many rows as will come, so the sections under it do not move when they arrive. */
  if (!data.data) {
    const expected = Math.min(Math.max(section.limit ?? vocabulary?.length ?? 3, 1), 8);
    return (
      <ul className="kit-bars" role="status" aria-busy="true">
        {Array.from({ length: expected }, (_, i) => (
          <li key={i} className="kit-bars-row" aria-hidden="true">
            <span className="kit-bars-label">
              <span className="sk-bar" style={{ width: `${[58, 44, 66, 38][i % 4]}%`, height: '10px' }} />
            </span>
          </li>
        ))}
      </ul>
    );
  }
  const [keyName, valueName, alsoName] = data.data.columns ?? [];
  const measured = data.data.rows ?? [];
  /* A scale with a limit keeps its largest groups, then reads them in its order, as the rows drawing does. */
  const kept = scale && !vocabulary && section.limit ? orderGroups(measured, keyName, valueName).slice(0, section.limit) : measured;
  const rows = orderDeclared(kept, keyName, valueName, vocabulary, scale).slice(0, section.limit);
  if (!rows.length) return <>{nothing}</>;
  const sayRow = sayer(section).among(rows.map((row) => row[valueName]));
  const sayKey = namedGroups(data.data, keyName, sayGroup(section.table, section.by));
  const sayAlso = section.also && alsoName ? alsoSayer(section) : undefined;
  return (
    <BreakdownList
      ariaLabel={section.title}
      formatValue={sayRow}
      items={rows.map((row) => ({
        key: String(row[keyName]),
        label: sayKey(row[keyName]),
        value: Number(row[valueName]) || 0,
        ...(sayAlso ? { note: sayAlso(row[alsoName]) } : {}),
      }))}
    />
  );
}
