/**
 * A related list read as groups: a header for each record its rows share (an estimate, over its financing options),
 * that group's rows under it, and a page of groups at a time. The groups are one breakdown of the same rows; each
 * group's rows are one list read narrowed to its key, asked once the groups are in. The header's facts are columns of
 * the grouped record read through the rows (`estimate_id.total`), so a header costs no read of its own, and the
 * parent's name comes with the groups (the breakdown names a reference's keys).
 *
 * Where the list says how (`moves`, groupMoves.tsx), a row is dragged into another group, or to its place in a
 * ranked one, and Alt and ↑/↓ do the same from the keyboard; the move is drawn at once and read back once.
 *
 * Nothing here moves a page that is already drawn: a page of groups turned, or a group opened, keeps what stood until
 * the answer is in (`keepPreviousData`), and a group's rows hold their height as one place.
 */
import { Fragment, useId, useState, type ReactNode } from 'react';
import { keepPreviousData, useQueries } from '@tanstack/react-query';
import type { ResourceClientReply } from '@mistriwork/engine/shared/resourceHttp.js';
import type { HttpViewDefinition } from '@mistriwork/engine/shared/resourceHttp.js';
import { columnDisplay, columnLabel, findTable, openRecord, state } from '../core.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { formatNumber } from '../locale.js';
import { GROUP_ROWS_MOST } from '@mistriwork/engine/shared/pageModel.js';
import { primaryKey, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { groupFactPaths, groupTable } from '@mistriwork/engine/shared/pagePaths.js';
import type { GridData } from './Grid.js';
import { Icon } from './Icon.js';
import { Empty } from './Notes.js';
import { Value } from './Value.js';
import { usePageApi, type SlotProps } from './pageContext.js';
import { namedGroups } from './dashboardModel.js';
import { presentationColumns } from './columnPresentation.js';
import { groupLabel, type DisplayRule } from './valueModel.js';
import { say } from '../copy/record/components/PageGroups.js';
import { RANK, useGroupMoves, type GroupMoves } from './groupMoves.js';

/** The groups as the breakdown route answers them, without the failure it may answer instead. */
export type Groups = Exclude<ResourceClientReply<'/api/breakdown'>, { errors: unknown }>;

/** The list's own conditions with one more on every alternative: the rows of this group. */
function groupView(view: HttpViewDefinition, by: string, key: unknown, limit: number): HttpViewDefinition {
  const held = (view.filter?.groups?.length ? view.filter.groups : [[]]) as Array<Array<Record<string, unknown>>>;
  const condition = key === null || key === undefined ? { path: by, op: 'isNull' } : { path: by, op: '=', value: key };
  return { ...view, filter: { groups: held.map((group) => [...group, condition]) } as HttpViewDefinition['filter'], limit };
}

export function GroupedBody({
  section,
  groups,
  offset,
  perPage,
  onOffset,
  view,
  labelColumns,
  rowsPerGroup,
  grid,
  overall,
  moves,
}: {
  section: SlotProps['section'];
  groups: Groups;
  offset: number;
  perPage: number;
  onOffset: (offset: number) => void;
  /** The list's own planned view, labels and keys added (PageRelated's `presentation`). */
  view: HttpViewDefinition;
  labelColumns: Record<string, string>;
  rowsPerGroup: number;
  /** One group's rows as the list draws its table: with the subtotal row and the words under it, when there are some. */
  grid: (data: GridData, totals?: Record<string, unknown>, totalsLabel?: string) => ReactNode;
  /** Every row's sums, for the foot of the whole list: the words, and each column's figure. */
  overall?: { label: string; sums: Record<string, unknown> };
  /** How a row moves to another group or its place in one; absent, the rows stay where they are. */
  moves?: GroupMoves;
}) {
  const api = usePageApi();
  const group = section.group!;
  const heading = useId();
  const [open, setOpen] = useState<Record<string, true>>({});
  const from = findTable(section.from ?? '') as TableMeta | undefined;
  const parent = state.schema
    ? (groupTable(state.schema as DatabaseSchema, { from: section.from ?? '', group: section.group }) as TableMeta | undefined)
    : undefined;
  const [keyName] = groups.columns;
  const keyOf = (row: Record<string, unknown>) => row[keyName];
  const keyText = (row: Record<string, unknown>) => String(keyOf(row) ?? '');
  const rows = groups.rows as Array<Record<string, unknown>>;
  const facts = groupFactPaths(section);
  const allowed = parent ? undefined : presentationColumns(state.schema, from, [group.by]).get(group.by)?.allowed;
  /* "No sprint": the column's caption in its sentence, an acronym kept as it is (the board's rule, BoardList's `none`). */
  const caption = (columnLabel(section.from ?? '', group.by) as string | null) ?? humanName(group.by.split('.').pop()!.replace(/_id$/, ''));
  const noValue =
    group.empty ?? say('noGroupValue', { caption: /^[A-Z][a-z]/.test(caption) ? caption[0].toLowerCase() + caption.slice(1) : caption });
  const named = namedGroups(groups, keyName, (key) =>
    key === null || key === undefined
      ? noValue
      : groupLabel(columnDisplay(section.from ?? '', group.by) as DisplayRule | null, key, allowed),
  );
  const asked = useQueries({
    queries: rows.map((row) => {
      const limit = open[keyText(row)] ? GROUP_ROWS_MOST : rowsPerGroup;
      /* A ranked list reads each row's place, shown or not, for the number a moved row takes. */
      const ranked =
        moves?.rank && !view.columns?.some((column) => column.path === moves.rank!.column)
          ? { ...view, columns: [...(view.columns ?? []), { path: moves.rank.column, alias: RANK }] }
          : view;
      const narrowed = groupView(ranked, group.by, keyOf(row), limit);
      return {
        queryKey: ['page-list', narrowed, 0],
        queryFn: () => api('/api/view/run', { view: narrowed, offset: 0, count: 'none' }),
        staleTime: 0,
        placeholderData: keepPreviousData,
      };
    }),
  });
  const answers = asked.map((each) =>
    each.data && 'view' in each.data ? (each.data as { rows?: unknown[]; columns?: string[] }) : undefined,
  );
  const shownColumns = answers.find((answer) => answer?.columns)?.columns ?? [];
  const moving = useGroupMoves({ moves, groups: rows.map(keyOf), answers, columns: shownColumns, label: named });
  const things = (section.title ?? from?.name ?? '').toLocaleLowerCase();
  const first = offset + 1;
  const last = offset + rows.length;
  const more = typeof groups.total === 'number' ? offset + rows.length < groups.total : rows.length >= perPage;

  return (
    <div className="page-groups">
      {rows.length === 0 ? (
        <Empty className="page-group-empty" text={say('nothingToGroup')} />
      ) : (
        rows.map((row, i) => {
          const key = keyOf(row);
          const id = `${heading}-${i}`;
          const count = (Number(row.group_rows) || 0) + moving.drift(i);
          const answer = asked[i].data;
          const drawn = answer && 'view' in answer ? answer : undefined;
          const body = (moving.movable ? moving.bodies[i] : (drawn?.rows ?? [])) as Array<Record<string, unknown>>;
          const columns = drawn?.columns ?? [];
          const expanded = Boolean(open[keyText(row)]);
          const label = named(key);
          const capped = Math.min(count, expanded ? GROUP_ROWS_MOST : rowsPerGroup);
          /* A subtotal sums every row of the group, not only the ones drawn, and says so when they are fewer. */
          const subtotals = section.totals?.length
            ? Object.fromEntries(section.totals.map((column, n) => [column, row[`total_${n}`] ?? 0]))
            : undefined;
          const partial = count > body.length;
          const recordKey =
            parent && key !== null && key !== undefined && primaryKey(parent).length === 1
              ? { [primaryKey(parent)[0]]: key as string | number }
              : null;
          const lead = body[0];
          return (
            <div key={keyText(row) || `none-${i}`} className="page-group" role="group" aria-labelledby={id}>
              <header className="page-group-head">
                <h3 id={id} className="page-group-name">
                  {recordKey && parent ? (
                    <button type="button" className="page-group-link" onClick={() => void openRecord(parent.id, recordKey, label)}>
                      {label}
                    </button>
                  ) : (
                    label
                  )}
                </h3>
                {lead && facts.length > 0 && parent && (
                  <span className="page-group-facts">
                    {group.show!.map((column, n) => {
                      const path = facts[n];
                      const said = labelColumns[path] ? lead[labelColumns[path]] : undefined;
                      const meta = parent.columns.find((c) => c.name === column);
                      const value = lead[path];
                      if (value === null || value === undefined || value === '') return null;
                      return (
                        <Fragment key={column}>
                          <span className="page-group-fact">
                            {typeof said === 'string' && said !== '' ? (
                              said
                            ) : (
                              <Value col={meta} value={value} tableId={parent.id} links={false} compact />
                            )}
                          </span>
                        </Fragment>
                      );
                    })}
                  </span>
                )}
                <span className="page-group-count">{say('groupCount', { shown: formatNumber(capped), count: formatNumber(count) })}</span>
                {(group.sum ?? []).map((column, n) => {
                  const figure = row[`group_sum_${n}`];
                  if (figure === null || figure === undefined) return null;
                  return (
                    <span key={column} className="page-group-sum">
                      <Value
                        col={from?.columns.find((c) => c.name === column)}
                        value={figure}
                        tableId={section.from}
                        links={false}
                        compact
                      />
                    </span>
                  );
                })}
              </header>
              <div className="result-table" id={`${id}-rows`} {...moving.zone(i)}>
                {drawn
                  ? grid(
                      { ...drawn, rows: body, columns } as GridData,
                      subtotals && body.length ? subtotals : undefined,
                      partial ? say('totalOfCount', { count: formatNumber(count) }) : undefined,
                    )
                  : null}
              </div>
              {count > rowsPerGroup && (
                <button
                  type="button"
                  className="ghost page-group-more"
                  aria-expanded={expanded}
                  aria-controls={`${id}-rows`}
                  aria-label={
                    expanded
                      ? say('showFewerOf', { count: formatNumber(rowsPerGroup), things, group: label })
                      : say('showAllOf', { count: formatNumber(count), things, group: label })
                  }
                  onClick={() =>
                    setOpen((held) =>
                      expanded
                        ? Object.fromEntries(Object.entries(held).filter(([k]) => k !== keyText(row)))
                        : { ...held, [keyText(row)]: true },
                    )
                  }
                >
                  {expanded ? say('showFewer', { count: formatNumber(rowsPerGroup) }) : say('showAll', { count: formatNumber(count) })}
                </button>
              )}
            </div>
          );
        })
      )}
      {moving.live}
      {overall && from && (
        <p className="page-group-total">
          <span className="page-group-total-label">{overall.label}</span>
          {Object.entries(overall.sums).map(([column, figure]) => (
            <span key={column} className="page-group-total-figure">
              <span className="page-group-total-caption">{(columnLabel(from.id, column) as string | null) ?? humanName(column)}</span>
              <Value col={from.columns.find((c) => c.name === column)} value={figure} tableId={from.id} links={false} compact />
            </span>
          ))}
        </p>
      )}
      {(offset > 0 || more) && (
        <div className="page-pager">
          <span className="step-control">
            <button
              type="button"
              className="step-button"
              aria-label={say('previousGroups')}
              disabled={offset === 0}
              onClick={() => onOffset(Math.max(0, offset - perPage))}
            >
              <Icon name="caret-left" size={16} />
            </button>
            <span className="page-range step-position">
              {`${formatNumber(first)}–${formatNumber(last)}${typeof groups.total === 'number' ? say('common.ofTotal', { total: formatNumber(groups.total) }) : ''}`}
            </span>
            <button
              type="button"
              className="step-button"
              aria-label={say('moreGroups')}
              disabled={!more}
              onClick={() => onOffset(offset + perPage)}
            >
              <Icon name="caret-right" size={16} />
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
