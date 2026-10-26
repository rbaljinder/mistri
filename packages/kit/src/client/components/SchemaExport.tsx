/**
 * Export the diagram. Deliberately the same `.export` menu
 * chrome the result-table Export uses: two menus that do the same kind of
 * thing in the same product should not have to be learned twice. The
 * writers stay in `schemaexport.js`.
 */
import { useState } from 'react';
import { toast } from '../core.js';
import { exportSchema } from '../schemaexport.js';
import type { SchemaSubset } from '@mistriwork/engine/shared/schema.js';
import { DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
import { say } from '../copy/workbench/components/SchemaExport.js';

const FORMATS: Array<[string, string, string]> = [
  ['svg', 'SVG', say('theDrawingAnySize')],
  ['png', 'PNG', say('forChatAndSlides')],
  ['mermaid', say('mermaid'), say('rendersInAReadme')],
  ['markdown', say('markdown'), say('columnsAndKeys')],
  ['json', 'JSON', say('theStructuredSchema')],
];

interface SchemaExportProps {
  schema: SchemaSubset;
  only?: Set<string> | null;
  /** Called at click time rather than captured: the diagram is rebuilt on every focus change. */
  picture?: () => { svg?: SVGSVGElement; size?: { width: number; height: number } };
}

export function SchemaExportControl({ schema, only, picture }: SchemaExportProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (kind: string) => {
    setBusy(kind);
    try {
      await exportSchema(kind, { schema, only, ...(picture?.() ?? {}) });
      setOpen(false);
      toast(say('exported', { what: only?.size ? say('tables', { count: only.size }) : say('theSchema'), kind: kind.toUpperCase() }));
    } catch (error) {
      toast((error as Error).message ?? say('theExportFailed'), 'error');
    } finally {
      setBusy(null);
    }
  };
  /* Said once, at the top: whichever format you pick, you get what is on screen. */
  const scope = only?.size
    ? say('tablesWhatTheDiagram', { count: only.size })
    : say('allTables', { tables: say('tables', { count: schema.tables.length }) });
  return (
    <DropMenu
      className="export schema-export"
      triggerClassName="export-summary"
      triggerTitle={say('exportThisSchema')}
      label={say('export')}
      popupClassName="export-menu"
      open={open}
      onOpenChange={setOpen}
    >
      <p className="export-note export-scope">{scope}</p>
      {FORMATS.map(([kind, name, detail]) => (
        <DropItem key={kind} className="export-item" disabled={busy === kind} closeOnClick={false} onClick={() => void run(kind)}>
          {busy === kind ? (
            say('exporting')
          ) : (
            <>
              <span className="export-kind">{name}</span>
              <span className="export-count">{detail}</span>
            </>
          )}
        </DropItem>
      ))}
    </DropMenu>
  );
}
