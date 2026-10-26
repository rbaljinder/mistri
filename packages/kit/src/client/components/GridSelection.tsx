/**
 * The queue's selection on a grid: a checkbox in each row's leading cell —
 * the row host, so the grid is not told about it — one in the header row's
 * for every row at once, and the same bulk bar, the same keys and the same
 * per-record writes as a queue over the resource.
 */
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { AppAction } from '@mistriwork/engine/schema/model.js';
import { keyOf, rowLabel } from '../core.js';
import { shell } from '../shellMode.js';
import { bulkKey } from '../bulkActions.js';
import { resourceOf } from './appRooms.js';
import { RowDecoration, RowHeadDecoration } from './RowHost.js';
import { useBulkSelection, type BulkRecord } from './useBulkSelection.js';
import { say } from '../copy/lists/components/GridSelection.js';

export function GridSelection({
  table,
  rows,
  actions,
  interactive,
  editable = [],
}: {
  table: TableMeta;
  rows: Array<Record<string, unknown>>;
  actions: AppAction[];
  interactive: boolean;
  /** The list's editable columns: the selection offers "Set field…" over them. */
  editable?: readonly string[];
}) {
  const keyed: BulkRecord[] = rows.flatMap((row) => {
    const key = keyOf(table, row) as Record<string, unknown> | null;
    return key ? [{ id: bulkKey(table, key), key, label: String(rowLabel(table, row) ?? say('common.untitled')), row }] : [];
  });
  const { offered, selection, change, bar, dialogs } = useBulkSelection({ table, keyed, actions, interactive, editable });
  if (!offered) return null;
  const chosen = new Set(selection);
  const every = keyed.length > 0 && selection.length === keyed.length;
  const partly = selection.length > 0 && !every;
  /* The box every table has in its header row: no label and no count, since
     the column says what it is. Its name says what "all" takes — the rows
     loaded here, as before — in the resource's own word where it has one. */
  const noun = resourceOf(shell().app(), table.id)?.noun?.many ?? 'rows';
  return (
    <>
      <div className="grid-select-bar">{bar}</div>
      {keyed.length > 0 && (
        <RowHeadDecoration>
          {/* Mixed is a property, not an attribute: set on every paint, because
          the box may reach the header after the selection changed. */}
          <input
            type="checkbox"
            className="row-select"
            aria-label={say('selectAll', { noun })}
            checked={every}
            ref={(box) => {
              if (box) box.indeterminate = partly;
            }}
            onChange={() => change(every ? [] : keyed.map((record) => record.id))}
          />
        </RowHeadDecoration>
      )}
      {keyed.map((record) => (
        <RowDecoration key={record.id} rowKey={record.id}>
          {/* Choosing is not opening: the click stays on the box. */}
          <input
            type="checkbox"
            className="row-select"
            aria-label={say('select', { label: record.label })}
            checked={chosen.has(record.id)}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => change(event.target.checked ? [...selection, record.id] : selection.filter((id) => id !== record.id))}
          />
        </RowDecoration>
      ))}
      {dialogs}
    </>
  );
}
