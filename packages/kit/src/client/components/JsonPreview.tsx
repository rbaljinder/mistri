/**
 * A JSON document in a grid cell: one line that says its shape, and the
 * whole document laid out in an overlay, on a click or on Enter.
 *
 * The line is a button, so a click on it opens the document rather than
 * the row. It is out of the tab order because the grid is one tab stop:
 * the cell cursor's Enter presses it instead (`data-cell-opens`, read by
 * useGridKeyboard), and the row is a cell away.
 */
import { useRef, useState } from 'react';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { JsonValue as JsonView } from './JsonValue.js';
import { useArrived } from './onDemand.js';
import { previewOf } from './jsonModel.js';
import { say } from '../copy/record/components/JsonPreview.js';

export function JsonPreview({ value, name, type }: { value: object; name: string; type?: string }) {
  const [open, setOpen] = useState(false);
  const here = useArrived(JsonView, open);
  const modal = useRef<ModalHandle>(null);
  return (
    <>
      <button
        type="button"
        className="json-preview"
        data-cell-opens=""
        tabIndex={-1}
        aria-haspopup="dialog"
        title={say('openName', { name })}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {previewOf(value)}
      </button>
      {open && here && (
        <Modal ref={modal} className="confirm json-overlay" ariaLabel={`${name} (JSON)`} onClose={() => setOpen(false)}>
          <header className="json-overlay-head">
            <h2>{name}</h2>
            {type && <span className="json-overlay-type">{type.toLowerCase()}</span>}
            <button type="button" className="ghost json-overlay-close" onClick={() => modal.current?.close()}>
              {say('common.close')}
            </button>
          </header>
          <JsonView value={value} />
        </Modal>
      )}
    </>
  );
}
