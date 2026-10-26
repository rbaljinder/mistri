/**
 * A bounded host for collection workspaces.
 *
 * The list owns selection and navigation; this component owns only the
 * presentation seam around the selected detail. Where the host has room the
 * detail is a sibling pane beside the list, and where it does not (a
 * container query on the host, SplitListDetail.css) the pane goes under it.
 * On a phone the same host falls back to the existing Modal primitive, so
 * callers do not invent a second dialog or focus/escape implementation. One
 * branch is mounted at a time: an editor is never duplicated with two
 * competing owners.
 */
import { useCallback, useSyncExternalStore, type ReactNode } from 'react';
import { BesideDetail } from '@mistriwork/kit/client/components/besideDetail.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import { say } from '../copy/lists/components/SplitListDetail.js';

const MOBILE_QUERY = '(max-width: 760px)';

interface SplitListDetailProps {
  /** The collection surface. It remains mounted while a detail is open. */
  list: ReactNode;
  /** The selected record surface, usually an owned PageView or RecordModal body. */
  detail?: ReactNode;
  /** The selected record's controls, drawn in the detail's head between its title and Close. */
  detailActions?: ReactNode;
  /** Whether the detail pane should be presented. */
  selected?: boolean;
  /** Stable name for the detail surface and its close control. */
  detailTitle?: string;
  /** Called only while the host's owner is still current. */
  onCloseDetail?: () => void;
  /** Optional lifetime fence supplied by PageRoom/RecordModal hosts. */
  isCurrent?: () => boolean;
  /** Accessible names for the two regions. */
  listLabel?: string;
  detailLabel?: string;
  /** Compact navigation list, with remaining space reserved for the editor. */
  listWidth?: 'balanced' | 'compact';
  /** Use all available space for the collection until a record is selected. */
  expandList?: boolean;
  className?: string;
  /** The detail's title reads as the record's own name, in sentence case, not as the kit's small-caps eyebrow. */
  sentenceTitle?: boolean;
}

function mobileSnapshot(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_QUERY).matches : false;
}

function subscribeMobile(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener?.('change', listener);
  /* Older WebKit has the deprecated listener pair but no addEventListener. */
  if (!query.addEventListener) query.addListener(listener);
  return () => {
    query.removeEventListener?.('change', listener);
    if (!query.removeEventListener) query.removeListener(listener);
  };
}

function DetailContent({
  title,
  detail,
  actions,
  onClose,
}: {
  title: string;
  detail?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
}) {
  return (
    <>
      <div className="split-list-detail-head">
        <h2 className="split-list-detail-title">{title}</h2>
        {actions && <div className="split-list-detail-actions">{actions}</div>}
        <button
          type="button"
          className="ghost split-list-detail-close"
          aria-label={say('close', { title: title.toLowerCase() })}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="split-list-detail-body">{detail}</div>
    </>
  );
}

export function SplitListDetail({
  list,
  detail,
  detailActions,
  selected = false,
  detailTitle = say('details'),
  onCloseDetail,
  isCurrent,
  listLabel = say('list'),
  detailLabel = say('details'),
  listWidth = 'balanced',
  expandList = false,
  className = '',
  sentenceTitle = false,
}: SplitListDetailProps) {
  const mobile = useSyncExternalStore(subscribeMobile, mobileSnapshot, () => false);
  const close = useCallback(() => {
    if (isCurrent && !isCurrent()) return;
    onCloseDetail?.();
  }, [isCurrent, onCloseDetail]);
  const classes = [
    'split-list-detail',
    listWidth === 'compact' ? 'split-list-detail-compact' : '',
    expandList ? 'split-list-detail-expand' : '',
    sentenceTitle ? 'split-list-detail-sentence' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="split-list-detail-host">
      <div className={classes} data-selected={selected ? 'true' : 'false'}>
        <section className="split-list-detail-list" aria-label={listLabel}>
          <BesideDetail.Provider value={selected && !mobile}>{list}</BesideDetail.Provider>
        </section>
        {!mobile && (
          <aside className="split-list-detail-pane" aria-label={detailLabel}>
            {selected ? (
              <DetailContent title={detailTitle} detail={detail} actions={detailActions} onClose={close} />
            ) : (
              <p className="split-list-detail-empty" role="status">
                {say('selectARecordToSee')}
              </p>
            )}
          </aside>
        )}
        {mobile && selected && (
          <Modal
            className={`split-list-detail-modal${sentenceTitle ? ' split-list-detail-sentence' : ''}`}
            fullscreen="mobile"
            aria-label={detailLabel}
            onClose={close}
          >
            <DetailContent title={detailTitle} detail={detail} actions={detailActions} onClose={close} />
          </Modal>
        )}
      </div>
    </div>
  );
}
