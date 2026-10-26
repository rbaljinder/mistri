/**
 * Import, beside a list's New: offered where the list or its resource opts
 * in (`import`) and the reader could make the records it would make — a plain
 * import where they may insert, a command import where the App served them
 * the command (the server strips it otherwise). The server judges every row
 * again; this only decides whether to offer. The dialog is a part of its own,
 * loaded when the button is pressed.
 */
import { useState } from 'react';
import { state, writeAllowed } from '@mistriwork/kit/client/core.js';
import { activeApp } from '../appState.js';
import { importDeclaration, type ImportApp } from '../../shared/appImportDeclaration.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { say } from '../copy/lists/components/ImportButton.js';

const ImportDialog = onDemand(() => import('./ImportDialog.js'), 'ImportDialog', { quiet: true });

export function ImportButton({ table, view, noun }: { table: TableMeta | undefined; view?: string; noun: { one: string; many: string } }) {
  const [open, setOpen] = useState(false);
  const app = activeApp() as ImportApp | null;
  const declared = table && app ? importDeclaration(app, table.id, view) : undefined;
  if (!table || !declared) return null;
  const s = state as { connections?: Array<{ id: string; writable?: boolean }>; activeConnection?: string };
  const writable = Boolean(s.connections?.find((c) => c.id === s.activeConnection)?.writable);
  if (!writable || (!declared.def.command && (table.isView || table.insertable === false || !writeAllowed(table.id)))) return null;
  return (
    <>
      <button
        type="button"
        className="ghost applist-import"
        title={say('importFromACsv', { many: noun.many })}
        onClick={() => setOpen(true)}
      >
        {/* On a phone the button is its mark, as Export is (structure.css): as a word beside New and ⋯ it pushed
            Depot's list verbs onto a second row of the crumb bar. */}
        <svg
          className="applist-import-mark"
          viewBox="0 0 16 16"
          width="16"
          height="16"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        >
          <path d="M8 10.5V2.5M5 5.5l3-3 3 3M2.5 10v3.5h11V10" />
        </svg>
        <span className="applist-import-word">{say('importButton')}</span>
      </button>
      {open && <ImportDialog table={table} view={view} def={declared.def} noun={noun} onClose={() => setOpen(false)} />}
    </>
  );
}
