import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, findTable, keyOf, openRecord, state, writeAllowed } from '@mistriwork/kit/client/core.js';
import type { TrailList } from '@mistriwork/kit/client/recordTrail.js';
import { recordKey } from '@mistriwork/kit/client/resourceRequests.js';
import { sessionIdentity, subscribeSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { updateAttempts, type UpdateOwner } from '@mistriwork/kit/client/updateAttempts.js';
import { columnKind, expectedValues, primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { AppChecklist } from '@mistriwork/engine/shared/listPresentations.js';
import { Value } from '@mistriwork/kit/client/components/Value.js';
import { namedCell } from '@mistriwork/kit/client/components/listColumn.js';
import type { ModalRecord } from './RecordModal.js';
import { useListOrder, type ListOrder } from '@mistriwork/kit/client/components/useListOrder.js';
import { useListRef, useRowWindow, type RowWindow } from '@mistriwork/kit/client/components/useRowWindow.js';
import { say } from '../copy/lists/components/Checklist.js';

type ChecklistSpec = AppChecklist;
type Ordering = ReturnType<typeof useListOrder>;

/** A presentation of ordinary records, not a separate task/write engine. */
export function Checklist({
  table,
  rows,
  spec,
  interactive = true,
  list,
  order,
  referenceLabels,
}: {
  table: TableMeta;
  rows: Array<Record<string, unknown>>;
  spec: ChecklistSpec;
  interactive?: boolean;
  /** A reference column → the fetched path its record's name is read from, so a reference primary is said by name. */
  referenceLabels?: Record<string, string>;
  /** The list these rows are a page of, so a record opened here steps past the page (recordTrail.ts). */
  list?: TrailList;
  /** The view's hand order, where it keeps one: its rows are put in place by drag, Alt+↑/↓ or their grip (useListOrder.tsx). */
  order?: ListOrder;
}) {
  const titleOf = (row: Record<string, unknown>) =>
    String(namedCell(table, spec.primary, row, referenceLabels).value ?? say('common.untitled'));
  const records = rows.flatMap((row) => {
    const key = keyOf(table, row) as Record<string, unknown> | null;
    return key ? [{ key, label: titleOf(row) }] : [];
  });
  const ordering = useListOrder({ table, rows, order, interactive, title: titleOf });
  // A long page is drawn around the viewport; the page itself is unchanged (useRowWindow.ts).
  const win = useRowWindow<HTMLUListElement>(rows.length, { estimate: 58 });
  const listRef = useListRef(win, ordering.zone.ref);
  return (
    <>
      <ul className="checklist" aria-label={say('checklist')} {...ordering.zone} ref={listRef}>
        {win.before > 0 && <li className="checklist-spacer" aria-hidden="true" style={{ height: `${win.before}px` }} />}
        {win.indices.map((index) => {
          const row = ordering.rows[index];
          return (
            <ChecklistRow
              key={keyOf(table, row) ? JSON.stringify(keyOf(table, row)) : index}
              table={table}
              row={row}
              spec={spec}
              interactive={interactive}
              records={records}
              list={list}
              ordering={ordering}
              title={titleOf(row)}
              {...(win.windowed ? { windowed: { index, win } } : {})}
            />
          );
        })}
        {win.after > 0 && <li className="checklist-spacer" aria-hidden="true" style={{ height: `${win.after}px` }} />}
      </ul>
      {ordering.live}
    </>
  );
}

function ChecklistRow({
  table,
  row,
  spec,
  interactive,
  records,
  list,
  ordering,
  windowed,
  title,
}: {
  table: TableMeta;
  row: Record<string, unknown>;
  spec: ChecklistSpec;
  interactive: boolean;
  records: ModalRecord[];
  list?: TrailList;
  ordering: Ordering;
  /** The row's name, a reference primary's said by its record's name. */
  title: string;
  /** Where the row stands in a windowed page, so its drawn height is learned. */
  windowed?: { index: number; win: RowWindow<HTMLUListElement> };
}) {
  const client = useQueryClient();
  const [problem, setProblem] = useState('');
  const identity = useSyncExternalStore(subscribeSessionIdentity, sessionIdentity, sessionIdentity);
  useSyncExternalStore(updateAttempts.subscribe, updateAttempts.version, updateAttempts.version);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const key = keyOf(table, row) as Record<string, unknown> | null;
  const owner: UpdateOwner = { connection: state.activeConnection ?? null, table: table.id, key: key ?? {} };
  const attempt = updateAttempts.get(owner);
  const value = row[spec.checked];
  const checked = value === true || value === 1 || value === '1';
  const known = checked || value === false || value === 0 || value === '0';
  const flag = table.columns.find((c) => c.name === spec.checked);
  const detail = spec.lines?.[0] === undefined ? undefined : table.columns.find((c) => c.name === spec.lines?.[0]);
  const writable = () => {
    const current = findTable(table.id) as TableMeta | undefined;
    const column = current?.columns.find((c) => c.name === spec.checked);
    return (
      interactive &&
      key &&
      known &&
      current &&
      !current.isView &&
      column &&
      !column.primaryKey &&
      column.writable !== false &&
      columnKind(column.type) === 'boolean' &&
      writeAllowed(table.id) &&
      state.connections?.some((c) => c.id === owner.connection && c.writable)
    );
  };
  const toggle = async () => {
    if (!writable() || !key || attempt) return;
    const epoch = identity.epoch;
    setProblem('');
    const values = { [spec.checked]: !checked };
    // The box as the list showed it: ticked by someone else since, the tick is refused rather than undone.
    const expected = expectedValues(table, values, row);
    const outcome = await updateAttempts.run(owner, values, () =>
      api('/api/update', { ...ownedBy(owner.connection), table: table.id, key: recordKey(key), values, ...(expected ? { expected } : {}) }),
    );
    if (!alive.current || epoch !== sessionIdentity().epoch || owner.connection !== state.activeConnection) return;
    if (outcome.kind === 'applied') {
      // Refetch the current question: a completion may leave an Open/Today list.
      void client.invalidateQueries({ queryKey: ['run', owner.connection] });
      void client.invalidateQueries({ queryKey: ['count', owner.connection] });
    } else if (outcome.kind !== 'uncertain') setProblem(outcome.message);
  };
  const id = ordering.id(row);
  return (
    <li
      className={`checklist-row${checked ? ' is-checked' : ''}`}
      aria-busy={attempt?.phase === 'pending'}
      {...(windowed ? { 'data-index': windowed.win.lineOf(windowed.index), ref: windowed.win.measure } : {})}
      {...(id ? ordering.item(id) : {})}
      onKeyDown={id ? (event) => ordering.keyDown(event, id) : undefined}
    >
      {/* The label is the box's hit area: a checkbox cannot be padded, and a
        finger needs 44px where the box draws 22 (structure.css). */}
      <label className="checklist-hit">
        <input
          className={`checklist-toggle${!writable() || !flag ? ' is-readonly' : ''}`}
          type="checkbox"
          checked={checked}
          aria-label={`${checked ? say('reopen') : say('complete')} ${title}`}
          disabled={!writable() || Boolean(attempt) || !flag}
          onChange={() => {
            void toggle();
          }}
        />
      </label>
      <div className="checklist-content">
        <button
          type="button"
          className="checklist-title"
          disabled={!key || !interactive}
          data-order-focus=""
          aria-keyshortcuts={ordering.shortcuts}
          onClick={() => {
            if (key && interactive) void openRecord(table.id, key, title, 'push', { records, list });
          }}
        >
          {title}
        </button>
        {detail && row[detail.name] != null && row[detail.name] !== '' && (
          <div className="checklist-detail">
            <Value tableId={table.id} col={detail} value={row[detail.name]} row={row} compact />
          </div>
        )}
        {attempt && (
          <p className="checklist-status" role={attempt.phase === 'uncertain' ? 'alert' : 'status'}>
            {attempt.phase === 'pending' ? say('common.saving') : say('common.openThisRecordToCheck', { message: attempt.message })}
          </p>
        )}
        {problem && (
          <p className="checklist-status" role="alert">
            {problem}
          </p>
        )}
      </div>
      {id && ordering.menu(id)}
    </li>
  );
}

/** Advanced queries can return aggregates, or omit required fields. Keep their grid. */
export function canShowChecklist(table: TableMeta | undefined, columns: string[] | undefined, spec: ChecklistSpec): table is TableMeta {
  return Boolean(
    table &&
    primaryKey(table).length &&
    [spec.primary, spec.checked, ...(spec.lines ?? []), ...primaryKey(table)].every((name) => columns?.includes(name)) &&
    columnKind(table.columns.find((c) => c.name === spec.checked)?.type ?? '') === 'boolean',
  );
}
