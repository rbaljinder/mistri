/**
 * The peek drawer, opened and closed from the vanilla client. The drawer
 * itself is `components/PeekPanel.tsx`; this is its one host on the body, so an
 * entry that says `open: "drawer"` has somewhere to send a row click, and Space
 * on a list's row (useGridKeyboard) has somewhere to send a glance.
 */
import { createElement } from 'react';
import { mount, unmount } from './components/mount.js';
import { onDemand } from './components/onDemand.js';
import { captureRecordSurfaceOwner } from './components/recordSurface.js';
import { allowMutationExit, currentEntry, registerSurfaceMutationPendingProbe, subscribeWalk } from './core.js';
import { subscribeSessionIdentity } from './sessionIdentity.js';
import { cancelRecordAutosave } from './write.js';
import { cancelEditInteractions } from './components/editInteraction.js';
import { registerPeek } from './uiBridge.js';
import { portalRoot } from './shellHost.js';

/* Capture the host's owner and retirement hooks before loading either dialog.
   Their Modal frames arrive with their bodies; a retired host cannot reopen. */
const PeekPanel = onDemand(() => import('./components/PeekPanel.js'), 'PeekPanel', { quiet: true });

/**
 * @typedef {{ key: Record<string, unknown>, label?: string }} PeekRecord
 * @typedef {{ tableId: string, recordKey: Record<string, unknown>, label?: string, owner: import('./components/recordSurface.js').RecordSurfaceOwner, onClose: () => void, records?: PeekRecord[], list?: import('./recordTrail.js').TrailList, setPendingProbe: (probe: () => boolean) => void }} RecordDialogProps
 */
/**
 * The record dialog a view that says `open: "modal"` opens: the App
 * framework's (components/RecordModal.tsx), named by its chrome (appnav.js).
 * The Workbench has no such view, and its glance is the drawer.
 * @type {import('react').ComponentType<RecordDialogProps> | null}
 */
let RecordModal = null;
/** @param {import('react').ComponentType<RecordDialogProps>} dialog */
export function setRecordDialog(dialog) {
  RecordModal = dialog;
}

let host = null;
let pending = () => false;
let retire = () => {};
/** Where the glance was opened from, handed the focus back when it is closed. */
let returnTo = null;
registerSurfaceMutationPendingProbe(() => host !== null && pending());
/* Space on a row glances at its record (appnav.js, the shell's `peekRecord`):
   it holds the focus while it is open, and gives it back to the row when it
   closes. */
registerPeek((tableId, key, label, mode) => openPeek(tableId, key, label, mode));

export function closePeek() {
  if (!host) return true;
  if (!allowMutationExit()) return false;
  cancelEditInteractions();
  cancelRecordAutosave();
  const back = returnTo;
  retire();
  // Back to the row it was opened from, when that is still on the page.
  if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
  return true;
}

/** Open the drawer for one record.
 * @param {string} tableId
 * @param {Record<string, unknown>} key
 * @param {string | undefined} label
 * @param {'drawer' | 'modal'} mode
 * @param {PeekRecord[] | undefined} records
 * @param {import('./recordTrail.js').TrailList | undefined} list the question and page `records` came from, for a step past the page
 */
export function openPeek(tableId, key, label, mode = 'drawer', records = undefined, list = undefined) {
  /* A glance replaced from inside itself still hands the focus back to the row
     it began on. The glance and the record dialog are Modals, drawn in the
     dialog portal rather than in the host, so they are asked for by name. */
  const active = document.activeElement;
  const inside = host !== null && (host.contains(active) || Boolean(active?.closest('.peekpanel-glance, .record-modal')));
  const opener = inside ? returnTo : active;
  if (!closePeek()) return;
  const node = document.createElement('div'),
    route = currentEntry();
  host = node;
  returnTo = opener;
  const owner = captureRecordSurfaceOwner(() => host === node && node.isConnected && currentEntry() === route);
  const stopWalk = subscribeWalk(() => {
    if (!owner.isCurrent()) retireCurrent();
  });
  const stopIdentity = subscribeSessionIdentity(() => retireCurrent());
  function retireCurrent() {
    stopWalk();
    stopIdentity();
    if (host === node) {
      host = null;
      pending = () => false;
      retire = () => {};
      returnTo = null;
    }
    unmount(node);
    node.remove();
  }
  retire = retireCurrent;
  node.className = 'peekpanel-host';
  portalRoot().append(node);
  const closeCurrent = () => {
    if (host === node) closePeek();
  };
  const neighbors = records?.map((record) => ({ key: { ...record.key }, label: record.label }));
  const page = list ? { ...list } : undefined;
  mount(
    node,
    mode === 'modal' && RecordModal
      ? createElement(RecordModal, {
          tableId,
          recordKey: { ...key },
          label,
          owner,
          onClose: closeCurrent,
          records: neighbors,
          list: page,
          setPendingProbe: (probe) => {
            if (host === node) pending = probe;
          },
        })
      : createElement(PeekPanel, { tableId, recordKey: { ...key }, label, onClose: closeCurrent, records: neighbors, list: page }),
  );
}
