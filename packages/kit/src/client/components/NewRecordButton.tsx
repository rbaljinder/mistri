/**
 * The two New buttons.
 *
 * The workbench's "+ New row" behind the same gate every write affordance
 * uses: writable, write mode on, a table. The app list's "New": offered
 * whenever the connection accepts writes, whether or not editing is on — an
 * app's reader does not know the padlock exists, and a primary action that
 * only appears after finding it is not a primary action. Creating a record
 * does not change the editing mode for existing records. Absent on a read-only connection, where the server would
 * refuse the row anyway.
 */
import { canInsert, openInsert, openNewRecord } from '../insert.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { say } from '../copy/forms/components/NewRecordButton.js';

export interface FormSpec {
  show?: string[];
  defaults?: Record<string, unknown>;
}

export function NewRowButton({ table }: { table: TableMeta }) {
  if (!canInsert(table)) return null;
  return (
    <button type="button" className="ghost table-new-row" title={say('addARow', { name: table.name })} onClick={() => openInsert(table)}>
      {say('newRow')}
    </button>
  );
}

export function NewRecordButton({ table, label, form }: { table: TableMeta | undefined; label?: string; form?: FormSpec }) {
  /* The one rule every New entry point follows (insert.js): a table the reader's `create` grant leaves out is
     `insertable: false` in their catalog, and offering its form only to have the server refuse is a dead end. */
  if (!table || !canInsert(table, true)) return null;
  return (
    <button
      type="button"
      className="ghost table-new-row applist-new"
      title={say('create', { label: label ?? table.name })}
      onClick={() => {
        openNewRecord(table, form);
      }}
    >
      {/* The noun is its own span so a phone's crumb bar can say "+ New"
          beside a long title (structure.css); the name keeps the noun. */}
      {say('plusNew')} <span className="applist-new-noun">{label ?? table.name}</span>
    </button>
  );
}
