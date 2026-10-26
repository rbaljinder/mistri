/** An authored record page in a transient dialog. Reads, drafts, writes and
 * commands retain their existing owners; only presentation/navigation is local. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { allowMutationExit, findTable, openRecord, pageFor } from '@mistriwork/kit/client/core.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { canStep, keyText, trailFor, type TrailList } from '@mistriwork/kit/client/recordTrail.js';
import { cancelRecordAutosave } from '@mistriwork/kit/client/write.js';
import { cancelEditInteractions } from '@mistriwork/kit/client/components/editInteraction.js';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { captureRecordSurfaceOwner, type RecordSurfaceOwner } from '@mistriwork/kit/client/components/recordSurface.js';
import { TrailSteps, useTrailStep } from '@mistriwork/kit/client/components/RecordTrailNav.js';
import { RecordPageBody } from './RecordPageBody.js';
import { clearPicture, enterRecord, showPicture, takePicture, type RecordPicture } from './recordPicture.js';
import { say } from '../copy/record/components/RecordModal.js';
import { addHostListener, removeHostListener } from '@mistriwork/kit/client/shellHost.js';

export interface ModalRecord {
  key: Record<string, unknown>;
  label?: string;
}
export interface RecordModalProps {
  tableId: string;
  recordKey: Record<string, unknown>;
  label?: string;
  records?: ModalRecord[];
  /** The list's question and page, so a step past the page reads the next one (recordTrail.ts). */
  list?: TrailList;
  owner: RecordSurfaceOwner;
  onClose: () => void;
  /** Install synchronously before controls can dispatch. Cleanup does not
   * release unresolved operations; the host retires the whole generation. */
  setPendingProbe: (probe: () => boolean) => void;
}

export function RecordModal(props: RecordModalProps) {
  const { owner, tableId, onClose } = props;
  /* The dialog steps through the list it was opened from, past its page too;
     a record that is not among the list's opens alone. */
  const [trail, setTrail] = useState(() => trailFor(tableId, props.recordKey, props.records, props.list));
  const [single] = useState<ModalRecord>(() => ({ key: props.recordKey, label: props.label }));
  const selected: ModalRecord = trail ? trail.records[trail.index] : single;
  const { key: recordKey, label } = selected;
  const [caption, setCaption] = useState<{ record: ModalRecord; name: string }>();
  const title = caption?.record === selected ? caption.name : label;
  const kind = humanName((findTable(tableId) as { name?: string } | undefined)?.name ?? tableId) || 'Record details';
  const active = useRef(selected);
  active.current = selected;
  const recordOwner = useMemo(() => captureRecordSurfaceOwner(() => owner.isCurrent() && active.current === selected), [owner, selected]);
  const [pageId, setPageId] = useState<string>();
  const [failed, setFailed] = useState(false);
  const dialog = useRef<ModalHandle>(null);
  const body = useRef<HTMLDivElement>(null);
  const pictures = useRef<HTMLDivElement>(null);
  const departing = useRef<RecordPicture | null>(null);
  useEffect(() => {
    let mounted = true;
    void pageFor(tableId)
      .then((id) => {
        if (!mounted || !owner.isCurrent()) return;
        if (id) setPageId(id);
        else setFailed(true);
      })
      .catch(() => {
        if (mounted && owner.isCurrent()) setFailed(true);
      });
    return () => {
      mounted = false;
    };
  }, [owner, tableId]);
  const close = () => dialog.current?.close();
  const { step, reading } = useTrailStep(trail, setTrail, () => owner.isCurrent());
  /* Asked only where the step leads somewhere: at the end of the list there
     is nothing to leave, so an unsaved draft is not asked about. The still of
     this record is taken before the step and shown only once the next record
     is the selected one; a step that goes nowhere lets it go. */
  const move = (by: 1 | -1) => {
    cancelEditInteractions();
    cancelRecordAutosave();
    if (!trail || !canStep(trail, by) || !owner.isCurrent() || !allowMutationExit()) return;
    departing.current = takePicture(body.current);
    void step(by).finally(() => {
      departing.current = null;
    });
  };
  /* Each record remounts its page (the key below), so between records the
     body would collapse to "Reading…" and grow back: the still of the record
     being left covers it, before paint, until the next one settles. */
  const shownKey = keyText(recordKey);
  useLayoutEffect(() => {
    const picture = departing.current;
    departing.current = null;
    if (!picture || !pictures.current) return;
    showPicture(pictures.current, picture);
    if (body.current) body.current.scrollTop = 0;
    // A page that never settles must not leave a still over it.
    const failsafe = window.setTimeout(() => clearPicture(pictures.current), 4000);
    return () => window.clearTimeout(failsafe);
  }, [shownKey]);
  const settled = () => {
    if (clearPicture(pictures.current)) enterRecord(body.current);
  };
  /* J and K, as on a record page and in a glance: inside this dialog only,
     never while one of its fields is being typed in, and never with a
     modifier. Re-bound each render so the step reads the current place. */
  useEffect(() => {
    if (!trail) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'j' && e.key !== 'k') || e.metaKey || e.ctrlKey || e.altKey) return;
      const active = document.activeElement as HTMLElement | null;
      if (!active?.closest('.record-modal') || /^(input|textarea|select)$/i.test(active.tagName) || active.isContentEditable) return;
      e.preventDefault();
      move(e.key === 'j' ? 1 : -1);
    };
    addHostListener(document, 'keydown', onKey);
    return () => removeHostListener(document, 'keydown', onKey);
  });
  return (
    <Modal
      ref={dialog}
      className="peekpanel peekpanel-modal record-modal"
      fullscreen="mobile"
      aria-label={title ? say('titleDetails', { title }) : say('recordDetails')}
      onClose={onClose}
      beforeClose={() => {
        cancelEditInteractions();
        cancelRecordAutosave();
        return allowMutationExit();
      }}
    >
      <div className="peekpanel-head">
        {/* The kind, as the split's pane says it: the record's name is the page's
          own heading an inch below, and said twice it cost the dialog a line. */}
        <h2 className="peekpanel-title">{kind}</h2>
        {trail && <TrailSteps trail={trail} reading={reading} onStep={move} onPointerDown={cancelRecordAutosave} />}
        <button
          type="button"
          className="ghost peekpanel-open"
          onPointerDown={cancelRecordAutosave}
          onClick={() => {
            if (!owner.isCurrent() || !allowMutationExit()) return;
            close();
            void openRecord(tableId, recordKey, title, 'push', { direct: true });
          }}
        >
          {say('common.details')}
        </button>
        <button
          type="button"
          className="peekpanel-close"
          aria-label={say('common.close')}
          onPointerDown={cancelRecordAutosave}
          onClick={close}
        >
          ×
        </button>
      </div>
      <div className="record-modal-stage">
        <div className="peekpanel-body" ref={body}>
          {failed ? (
            <p className="note">{say('thisRecordLayoutIsUnavailable')}</p>
          ) : pageId ? (
            <RecordPageBody
              key={shownKey}
              owner={recordOwner}
              tableId={tableId}
              recordKey={recordKey}
              label={label}
              pageId={pageId}
              close={close}
              setPendingProbe={props.setPendingProbe}
              onName={(name) => setCaption({ record: selected, name })}
              onSettled={settled}
            />
          ) : (
            <p className="note">{say('common.reading')}</p>
          )}
        </div>
        <div className="record-modal-pictures" ref={pictures} aria-hidden="true" />
      </div>
    </Modal>
  );
}
