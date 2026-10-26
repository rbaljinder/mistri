/**
 * A row's own menu: the record's actions, as its page offers them, from a ⋯
 * at the end of the row — the trailing host, so the grid is not told.
 *
 * Nothing is asked until the menu is opened: a list of twenty rows is not
 * sixty condition reads. The first press mounts that record's action bar in
 * its menu-only mode, so a verb here is the same verb as on the page — its
 * condition judged by the server, its confirmation, its command form, its
 * Undo — and choosing one never opens the row.
 */
import { shell } from '../shellMode.js';
import { useState } from 'react';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { AppAction } from '@mistriwork/engine/schema/model.js';
import { keyOf, rowLabel, state, writeAllowed } from '../core.js';
import { grantedActionIds } from '../actionGrants.js';
import { bulkKey } from '../bulkActions.js';
import { rootMatches } from './pageModel.js';
import { RowDecoration, useRowTrailScope } from './RowHost.js';
import { say } from '../copy/lists/components/RowActions.js';

function RowMenu({
  table,
  record,
  label,
  actions,
  onDone,
}: {
  table: TableMeta;
  record: Record<string, unknown>;
  label: string;
  actions: AppAction[];
  onDone: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);
  /* The verbs are the App's (Actions.tsx), drawn through the shell's slot: a shell with none has no menu to offer. */
  const { ActionBar } = shell().slots;
  if (!ActionBar) return null;
  if (!armed) {
    return (
      <button
        type="button"
        className="ghost row-actions-trigger"
        aria-label={say('common.actions', { label })}
        title={say('common.actions', { label })}
        aria-haspopup="menu"
        onClick={(event) => {
          event.stopPropagation();
          setArmed(true);
          setOpen(true);
        }}
      >
        ⋯
      </button>
    );
  }
  const connection = state.activeConnection ?? undefined;
  return (
    <span className="row-actions" onClick={(event) => event.stopPropagation()}>
      <ActionBar
        tableId={table.id}
        actions={actions}
        recordKey={record}
        label={label}
        matches={(when) => rootMatches(table, record, when, connection)}
        canUpdate={writeAllowed(table.id)}
        grantedCommands={shell().app()?.grantedCommands ?? []}
        grantedActions={grantedActionIds(shell().app(), table.id)}
        menuOnly={{ label, open, onOpenChange: setOpen }}
        onDone={onDone}
      />
    </span>
  );
}

export function RowActions({
  table,
  rows,
  actions,
  onDone,
}: {
  table: TableMeta;
  rows: Array<Record<string, unknown>>;
  actions: AppAction[];
  onDone: () => void;
}) {
  const store = useRowTrailScope();
  if (!store) return null;
  return (
    <>
      {rows.map((row) => {
        const key = keyOf(table, row) as Record<string, unknown> | null;
        if (!key) return null;
        const id = bulkKey(table, key);
        const label = String(rowLabel(table, row) ?? say('common.untitled'));
        return (
          <RowDecoration key={id} rowKey={id} store={store}>
            <RowMenu table={table} record={key} label={label} actions={actions} onDone={onDone} />
          </RowDecoration>
        );
      })}
    </>
  );
}
