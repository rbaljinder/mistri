/**
 * A board card's field, edited in place with the record page's own editor
 * and pending bar, so the edit is staged, saved, recorded and undoable the
 * way a field on a record is. Loaded when a card first opens one: a board
 * that nobody edits never pays for the editors.
 *
 * Enter saves (Editable's own), Escape puts the value back and closes, the
 * bar's Save and Discard do what they do on a record. Once a save lands the
 * editor closes and the bar stays to say so, with its Undo.
 */
import { useEffect, useRef } from 'react';
import type { ColumnMeta, TableMeta } from '@mistriwork/engine/shared/schema.js';
import { discardStaged } from '@mistriwork/kit/client/write.js';
import { Editable, PendingBar } from '@mistriwork/kit/client/components/Editable.js';

export type CloseReason = 'saved' | 'closed';

interface BoardCardEditorProps {
  table: TableMeta;
  row: Record<string, unknown>;
  /** The field being edited; absent once a save has landed and only the bar is left. */
  column?: ColumnMeta & { allowed?: string[] };
  recordKey: Record<string, unknown>;
  isCurrent: () => boolean;
  onClose: (reason: CloseReason) => void;
}

export default function BoardCardEditor({ table, row, column, recordKey, isCurrent, onClose }: BoardCardEditorProps) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (column) root.current?.querySelector<HTMLElement>('input, select, .dd-button')?.focus();
  }, [column?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div
      ref={root}
      className="triage-card-editor"
      onKeyDownCapture={(event) => {
        // Editable restores the value on Escape; the card closes after it has.
        if (event.key === 'Escape' && column)
          queueMicrotask(() => {
            discardStaged();
            onClose('closed');
          });
      }}
    >
      {column && (
        <Editable
          table={table}
          row={row}
          column={column}
          recordKey={recordKey}
          app
          isCurrent={isCurrent}
          onSaved={(opts) => {
            if (opts?.inPlace) onClose('saved');
          }}
        />
      )}
      <PendingBar
        table={table}
        recordKey={recordKey}
        placement="inline"
        isCurrent={isCurrent}
        onDone={(opts) => onClose(opts?.inPlace ? 'saved' : 'closed')}
      />
    </div>
  );
}
