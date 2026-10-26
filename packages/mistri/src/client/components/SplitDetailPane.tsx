/**
 * An App split's detail: the selected row read as the App's record — its
 * page's head (the name, where it is changed, its star and actions), the
 * split's authored fields when it names them (`detail.show`), the pending bar
 * inline — beside the list. It used to be the workbench's record view squeezed
 * into the pane: column types, "As a page", "Copy for agent" and a reference
 * rail are the database's words, not the App's.
 *
 * The walk owns the selection (the row entry), so the pane's owner is current
 * only while that entry is on top: a reply for the record just left lands
 * nowhere, and every pick or step remounts the room with a new owner.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  allowMutationExit,
  captureNavigation,
  currentEntry,
  go,
  openRecord,
  pageFor,
  pageView,
  renderCrumbs,
} from '@mistriwork/kit/client/core.js';
import { keyText } from '@mistriwork/kit/client/recordTrail.js';
import { cancelRecordAutosave } from '@mistriwork/kit/client/write.js';
import { cancelEditInteractions } from '@mistriwork/kit/client/components/editInteraction.js';
import { captureRecordSurfaceOwner } from '@mistriwork/kit/client/components/recordSurface.js';
import { RecordPageBody, type PageSections } from './RecordPageBody.js';
import { RecordTrailNav } from '@mistriwork/kit/client/components/RecordTrailNav.js';
import { clearPicture, enterRecord, keepStill, showPicture, takeStill } from './recordPicture.js';
import type { RowEntry } from '@mistriwork/kit/client/components/Record.js';
import { say } from '../copy/lists/components/SplitDetailPane.js';

type SplitRow = RowEntry & { view?: string };

/* The pane installs no close gate of its own: a pick, a step and Details all
   ask allowMutationExit first, and a write still in flight when the pane goes
   is fenced by its owner (recordSurface.ts). */
const noProbe = () => {};

export function SplitDetailPane({ entry, show, onClose }: { entry: SplitRow; show?: readonly string[]; onClose: () => void }) {
  const owner = useMemo(() => captureRecordSurfaceOwner(() => currentEntry() === entry), [entry]);
  const [pageId, setPageId] = useState<string>();
  const [failed, setFailed] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const pictures = useRef<HTMLDivElement>(null);
  /* The split, not the record: its still passes from one pane to the next. */
  const split = `${entry.table}\u0000${entry.view ?? ''}`;
  useEffect(() => {
    let live = true;
    void (pageFor(entry.table) as Promise<string | null>)
      .then((id) => {
        if (!live || !owner.isCurrent()) return;
        if (id) setPageId(id);
        else setFailed(true);
      })
      .catch(() => {
        if (live && owner.isCurrent()) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [entry, owner]);
  const fields = show?.join('\u0000');
  const sections = useMemo(() => (show?.length ? ([{ kind: 'fields', paths: [...show] }] as PageSections) : undefined), [fields]); // eslint-disable-line react-hooks/exhaustive-deps
  const settle = () => {
    if (stage.current) stage.current.style.minHeight = '';
    if (clearPicture(pictures.current)) enterRecord(body.current);
  };
  /* Every pick remounts the room, so the record being left would collapse to
     "Reading…" and the next grow back: the pane going keeps a still of itself
     (React runs a deleted component's layout cleanup while its nodes are still
     in place), and this one holds it, at its height, until its record settles. */
  useLayoutEffect(() => {
    const still = takeStill(split);
    let failsafe: number | undefined;
    if (still && pictures.current) {
      showPicture(pictures.current, still.picture);
      if (stage.current) stage.current.style.minHeight = `${still.height}px`;
      failsafe = window.setTimeout(settle, 4000);
    }
    return () => {
      window.clearTimeout(failsafe);
      keepStill(split, body.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const named = (name: string) => {
    /* The walk may have moved on while the row was read. */
    if (currentEntry() !== entry) return;
    entry.label = name;
    renderCrumbs();
  };
  return (
    <div className="split-detail-stage" ref={stage}>
      <div className="split-detail-body" ref={body}>
        {failed ? (
          <p className="note">{say('thisRecordHasNoPage')}</p>
        ) : pageId ? (
          <RecordPageBody
            key={keyText(entry.key)}
            owner={owner}
            tableId={entry.table}
            recordKey={entry.key}
            label={entry.label}
            pageId={pageId}
            close={onClose}
            setPendingProbe={noProbe}
            onName={named}
            onSettled={settle}
            sections={sections}
          />
        ) : (
          <p className="note">{say('common.reading')}</p>
        )}
      </div>
      <div className="split-detail-pictures" ref={pictures} aria-hidden="true" />
    </div>
  );
}

/** The pane head's controls: the record's place in the list and the way to its full page. */
export function SplitDetailActions({ entry }: { entry: SplitRow }) {
  const details = async () => {
    cancelEditInteractions();
    cancelRecordAutosave();
    if (currentEntry() !== entry || !allowMutationExit()) return;
    const isCurrent = captureNavigation();
    /* The App's page, by id: a row of a table the App shows only as a split
       would otherwise be answered by the split again. */
    // A failed lookup stays within routed App presentation, never an
    // unhandled rejection from this button or a Workbench inspector.
    const pageId = await (pageFor(entry.table) as Promise<string | null>).catch(() => null);
    if (!isCurrent() || currentEntry() !== entry) return;
    if (pageId) go(pageView(pageId, entry.table, entry.key, entry.label), 'push');
    else void openRecord(entry.table, entry.key, entry.label, 'push', { direct: true });
  };
  return (
    <>
      <RecordTrailNav entry={entry} />
      <button type="button" className="ghost split-list-detail-open" onPointerDown={cancelRecordAutosave} onClick={() => void details()}>
        {say('common.details')}
      </button>
    </>
  );
}
