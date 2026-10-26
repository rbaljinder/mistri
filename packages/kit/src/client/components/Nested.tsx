/**
 * A row's children, opened in place.
 *
 * The view composer answers "how many" with an aggregate and deliberately
 * refuses to LEFT JOIN a has-many, because that multiplies the base row.
 * Expanding a row is the answer that does not multiply it: the children
 * live in their own row underneath, one query per relationship keyed on
 * that row, so the base row remains one row and its numbers its own.
 *
 * Fetched when opened rather than with the page, and kept by Query so that
 * closing and reopening is free; a new result clears the cache (see
 * `resetNested` in nested.js).
 */
import { useQuery } from '@tanstack/react-query';
import { api, findTable, go, keyOf, openRecord, quote, refsTo, tableView } from '../core.js';
import { equalityFilter } from '../resourceRequests.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { Grid as GridComponent, GridData, Row } from './Grid.js';
import { formatApprox, formatNumber } from '../locale.js';
import { say } from '../copy/lists/components/Nested.js';

/** Rows of a child table shown inline before it needs its own page. */
const INLINE = 5;

interface Fk {
  name: string;
  from: { table: string; columns: string[] };
  to: { table: string; columns: string[] };
}

interface Section {
  fk: Fk;
  child: TableMeta;
  data?: GridData;
  total?: number;
  exact?: boolean;
  error?: string;
}

async function fetchChildren(table: TableMeta, key: Record<string, unknown>): Promise<Section[]> {
  const sections = await Promise.all(
    (refsTo(table.id) as Fk[]).map(async (fk): Promise<Section | null> => {
      const child = findTable(fk.from.table) as TableMeta | undefined;
      if (!child) return null;
      /* Every column of the key has to match, which is what makes this correct
       for a composite key and not only for a single-column one. */
      const conditions = fk.to.columns.map((parentColumn, i) => ({
        column: fk.from.columns[i] ?? fk.from.columns[0],
        op: '=',
        value: key[parentColumn],
      }));
      if (conditions.some((c) => c.value === undefined || c.value === null)) return null;
      try {
        const filter = equalityFilter(Object.fromEntries(conditions.map((condition) => [condition.column, condition.value])));
        // A source that reports no totals (an API) is not asked for one it would refuse.
        const counted = child.countable !== false;
        const [data, total] = await Promise.all([
          api('/api/query', { table: child.id, filter, limit: INLINE, offset: 0 }),
          counted ? api('/api/count', { table: child.id, filter }) : Promise.resolve(undefined),
        ]);
        return { fk, child, data, total: total?.count, exact: total?.exact };
      } catch (err) {
        return { fk, child, error: (err as Error).message };
      }
    }),
  );
  return sections.filter((s): s is Section => Boolean(s)).filter((s) => s.error || (s.data?.rows.length ?? 0) > 0);
}

/** The little triangle, drawn into its row's host (components/RowHost.tsx).
    The row itself navigates; opening the detail is a different intent and
    must not also walk away from the table — or out of whatever holds it. */
export function Expander({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="expander"
      aria-expanded={open}
      aria-label={say('showWhatPointsAtThisRow')}
      title={say('showWhatPointsAtThisRow')}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {open ? '▾' : '▸'}
    </button>
  );
}

/**
 * The detail, in a sibling `<tr>` rather than inside the row's own cell,
 * because a table row cannot contain another table without the inner one
 * inheriting the outer one's column widths.
 */
export function DetailRow({
  table,
  row,
  colSpan,
  grid: Grid,
}: {
  table: TableMeta;
  row: Row;
  colSpan: number;
  /** The grid that draws a child's rows: handed in, since a nested grid is a Grid and an import would loop. */
  grid: typeof GridComponent;
}) {
  const key = keyOf(table, row) as Record<string, unknown>;
  const children = useQuery({
    queryKey: ['nested', table.id, key],
    queryFn: () => fetchChildren(table, key),
    staleTime: Infinity,
  });
  return (
    <tr className="detail-row">
      <td className="detail-cell" colSpan={colSpan}>
        {children.isPending && <p className="loading">{say('looking')}</p>}
        {children.data && !children.data.length && <p className="note">{say('nothingPointsAtThisRow')}</p>}
        {children.data?.map((section) => (
          <div key={section.fk.name} className="detail-section">
            {section.error ? (
              <>
                <h4>{section.child.name}</h4>
                <p className="sql-error" role="alert">
                  {section.error}
                </p>
              </>
            ) : (
              <>
                <div className="detail-head">
                  <h4>{section.child.name}</h4>
                  <span className="detail-via">{say('viaColumns', { columns: section.fk.from.columns.join(', ') })}</span>
                  {section.total !== undefined && (
                    <span className="detail-count">
                      {section.exact === false ? `~${formatApprox(section.total)}` : formatNumber(section.total)}
                    </span>
                  )}
                  {/* Without a total (an API), a full inline page is the sign that more follow. */}
                  {(section.total === undefined
                    ? (section.data?.rows.length ?? 0) >= INLINE
                    : section.total > (section.data?.rows.length ?? 0)) && (
                    <button
                      type="button"
                      className="ghost detail-all"
                      onClick={() => {
                        const conditions = section.fk.from.columns
                          .map((col, i) => `${col} = ${quote(key[section.fk.to.columns[i]])}`)
                          .join(' and ');
                        go(tableView(section.child.id, `${section.child.id} ${conditions}`), 'push');
                      }}
                    >
                      {say('seeAll')}
                    </button>
                  )}
                </div>
                <Grid
                  table={section.child}
                  data={section.data!}
                  interactive={false}
                  virtual={false}
                  onRowClick={(childRow) => {
                    const childKey = keyOf(section.child, childRow) as Record<string, unknown> | null;
                    // Through openRecord: in app mode a nested row opens as a page too.
                    if (childKey) void openRecord(section.child.id, childKey, String(Object.values(childKey).join('/')));
                  }}
                />
              </>
            )}
          </div>
        ))}
      </td>
    </tr>
  );
}
