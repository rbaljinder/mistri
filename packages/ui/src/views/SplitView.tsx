/** Master-detail split layout that collapses to single-pane navigation with a back bar on narrow viewports. */
import { Icon } from '../Icon.js';
import { Modal } from '../Modal.js';
import { Resizable, ResizableHandle, ResizablePanel } from '@ui-sdk/react/resizable';
import { type ReactNode, type Ref, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pick, PickBack, PickList, PickOption, PickPane } from '@mistriwork/ui/behaviors/index.js';
import { cx, isEmptyStateSpec, type EmptyStateSpec, type Tone } from '../internal/cx.js';
import { viewportBox } from '../internal/ruler.js';
import { useSurfaceSeam } from '../internal/surfaceSeam.js';
import { EmptyState } from '../primitives/feedback.js';

type ResizableSize = number | `${number}%` | `${number}px` | `${number}rem`;

/** Master-list item descriptor in `SplitView`. */
export interface SplitViewItem<T = unknown> {
  id: string;
  code?: string;
  title: string;
  subtitle?: string;
  preview?: string;
  meta?: string;
  unread?: boolean;
  badge?: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
  data?: T;
}

/** Item-driven master-detail props for `SplitView`. */
export interface SplitViewItemsProps<T = unknown> {
  items: ReadonlyArray<SplitViewItem<T>>;
  /* Controlled or uncontrolled selected item ID */
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (id: string | null, item: SplitViewItem<T> | null) => void;
  /* Custom renderers */
  renderItem?: (item: SplitViewItem<T>, selected: boolean) => ReactNode;
  renderDetail: (item: SplitViewItem<T>) => ReactNode;
  empty?: EmptyStateSpec | ReactNode;
  detailEmpty?: EmptyStateSpec | ReactNode;
  /* Master List Chrome & Search */
  listTitle?: ReactNode;
  listHeaderActions?: ReactNode;
  searchable?: boolean;
  searchPlaceholder?: string;
  /* Resizable Layout & Responsive Collapse */
  defaultListSize?: ResizableSize;
  minListSize?: ResizableSize;
  maxListSize?: ResizableSize;
  collapseBreakpoint?: number;
  backLabel?: string;
  autoSaveId?: string;
  listLabel?: string;
  listAriaLabel?: string;
  detailLabel?: string;
  detailAriaLabel?: string;
  height?: number | string;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** Custom list + detail pane props for `SplitView`. */
export interface SplitViewPaneProps {
  list: ReactNode;
  detail?: ReactNode;
  detailActions?: ReactNode;
  selected?: boolean;
  detailOpen?: boolean;
  detailTitle?: string;
  onCloseDetail?: () => void;
  isCurrent?: () => boolean;
  listWidth?: 'balanced' | 'compact' | string;
  listLabel?: string;
  listAriaLabel?: string;
  detailLabel?: string;
  detailAriaLabel?: string;
  empty?: EmptyStateSpec | ReactNode;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** Props for the unified `SplitView` component. */
export type SplitViewProps<T = unknown> = SplitViewItemsProps<T> | SplitViewPaneProps;

function renderSplitEmpty(spec: EmptyStateSpec | ReactNode | undefined, fallback: ReactNode): ReactNode {
  if (spec !== undefined) {
    if (isEmptyStateSpec(spec)) {
      return <EmptyState title={spec.title} body={spec.body} action={spec.action} compact />;
    }
    return spec;
  }
  return fallback;
}

function StandalonePaneSplitView(props: SplitViewPaneProps) {
  const {
    list,
    detail,
    detailActions,
    selected,
    detailOpen,
    detailTitle = 'Details',
    onCloseDetail,
    isCurrent,
    listWidth = 'balanced',
    listLabel,
    listAriaLabel,
    detailLabel,
    detailAriaLabel,
    empty,
    className,
    ref,
  } = props;
  const seam = useSurfaceSeam();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const setHostRef = useCallback(
    (node: HTMLDivElement | null) => {
      hostRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as { current: HTMLDivElement | null }).current = node;
    },
    [ref],
  );
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const check = () => {
      const w = viewportBox(el).width;
      if (w > 0) setNarrow(w <= 760);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (seam?.renderPaneSplit) {
    return <>{seam.renderPaneSplit(props as unknown as Record<string, unknown>)}</>;
  }

  const isSelected = selected ?? detailOpen ?? Boolean(detail);
  const resolvedListLabel = listAriaLabel ?? listLabel ?? 'List';
  const resolvedDetailLabel = detailAriaLabel ?? detailLabel ?? 'Details';
  const close = () => {
    if (isCurrent && !isCurrent()) return;
    onCloseDetail?.();
  };

  const detailHeader = (
    <>
      <div className="split-list-detail-head nx-split-master-title-row">
        <h2 className="split-list-detail-title">{detailTitle}</h2>
        {detailActions && <div className="split-list-detail-actions">{detailActions}</div>}
        {onCloseDetail && (
          <button type="button" className="ghost split-list-detail-close" aria-label={`Close ${detailTitle.toLowerCase()}`} onClick={close}>
            ×
          </button>
        )}
      </div>
      <div className="split-list-detail-body nx-split-detail-body">{detail}</div>
    </>
  );

  const customGridCols =
    listWidth === 'compact'
      ? 'minmax(16rem, 22rem) minmax(0, 1fr)'
      : listWidth === 'balanced'
        ? 'minmax(18rem, 1fr) minmax(0, 1.25fr)'
        : `${listWidth} minmax(0, 1fr)`;

  return (
    <div ref={setHostRef} className={cx('split-list-detail-host nx-split-view', className)} data-narrow={narrow ? '' : undefined}>
      <div
        className={cx('split-list-detail', listWidth === 'compact' && 'split-list-detail-compact')}
        data-selected={isSelected ? 'true' : 'false'}
        style={!narrow ? { display: 'grid', gridTemplateColumns: customGridCols, gap: 'var(--space-4, 1rem)' } : undefined}
      >
        <section className="split-list-detail-list" aria-label={resolvedListLabel}>
          {list}
        </section>
        {!narrow && (
          <aside className="split-list-detail-pane nx-split-pane" aria-label={resolvedDetailLabel}>
            {isSelected ? (
              detailHeader
            ) : (
              <div className="split-list-detail-empty nx-split-detail-empty" role="status">
                {renderSplitEmpty(empty, 'Select a record to view its details.')}
              </div>
            )}
          </aside>
        )}
        {narrow && isSelected && (
          <Modal className="split-list-detail-modal" fullscreen="mobile" ariaLabel={resolvedDetailLabel} onClose={close}>
            {detailHeader}
          </Modal>
        )}
      </div>
    </div>
  );
}

function ItemsSplitView<T = unknown>(props: SplitViewItemsProps<T>) {
  const {
    items,
    value: controlledValue,
    defaultValue,
    onValueChange,
    renderItem,
    renderDetail,
    empty,
    detailEmpty,
    listTitle,
    listHeaderActions,
    searchable = false,
    searchPlaceholder = 'Filter list…',
    defaultListSize = 35,
    minListSize = 22,
    maxListSize = 55,
    collapseBreakpoint = 680,
    backLabel = 'Back',
    autoSaveId,
    listLabel,
    listAriaLabel,
    detailLabel,
    detailAriaLabel,
    height,
    className,
    ref: externalRef,
  } = props;
  const legacyProps = props as unknown as {
    emptyListState?: ReactNode;
    emptyDetailState?: ReactNode;
  };
  const resolvedListAria = listAriaLabel ?? listLabel ?? 'Items';
  const resolvedDetailAria = detailAriaLabel ?? detailLabel ?? 'Detail view';
  const emptyListNode = renderSplitEmpty(empty, legacyProps.emptyListState ?? 'No items in view');
  const emptyDetailNode = renderSplitEmpty(
    detailEmpty,
    legacyProps.emptyDetailState ?? (
      <div className="nx-split-placeholder">
        <Icon name="tray" size={24} />
        <span>Select an item from the list to inspect its details.</span>
      </div>
    ),
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const setContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      if (typeof externalRef === 'function') externalRef(node);
      else if (externalRef) (externalRef as { current: HTMLDivElement | null }).current = node;
    },
    [externalRef],
  );
  const [isWide, setIsWide] = useState(true);
  const [query, setQuery] = useState('');

  const initialId = defaultValue !== undefined ? defaultValue : (items[0]?.id ?? null);
  const [internalId, setInternalId] = useState<string | null>(initialId);
  const selectedId = controlledValue !== undefined ? controlledValue : internalId;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const check = () => {
      const w = viewportBox(el).width;
      if (w > 0) setIsWide(w >= collapseBreakpoint);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [collapseBreakpoint]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        (item.subtitle?.toLowerCase().includes(q) ?? false) ||
        (item.preview?.toLowerCase().includes(q) ?? false) ||
        (item.code?.toLowerCase().includes(q) ?? false),
    );
  }, [items, query]);

  const itemKeys = useMemo(() => filteredItems.map((i) => i.id), [filteredItems]);
  const itemMap = useMemo(() => {
    const m = new Map<string, SplitViewItem<T>>();
    for (const item of items) m.set(item.id, item);
    return m;
  }, [items]);

  const selectedItem = selectedId ? (itemMap.get(selectedId) ?? null) : null;

  const handlePickChange = (nextId: string | null) => {
    if (controlledValue === undefined) setInternalId(nextId);
    onValueChange?.(nextId, nextId ? (itemMap.get(nextId) ?? null) : null);
  };

  const renderMasterContent = () => (
    <div className="nx-split-master">
      {(listTitle || listHeaderActions || searchable) && (
        <div className="nx-split-master-head">
          {(listTitle || listHeaderActions) && (
            <div className="nx-split-master-title-row">
              <div className="nx-split-master-title">
                {listTitle}
                <span className="nx-badge" data-pill="">
                  {filteredItems.length}
                </span>
              </div>
              {listHeaderActions && <div className="nx-split-master-actions">{listHeaderActions}</div>}
            </div>
          )}

          {searchable && (
            <div className="nx-split-search">
              <Icon name="magnifying-glass" size={13} className="nx-split-search-icon" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="nx-split-search-input"
              />
              {query.length > 0 && (
                <button type="button" className="nx-split-search-clear" onClick={() => setQuery('')} aria-label="Clear search">
                  <Icon name="x" size={11} weight="bold" />
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {filteredItems.length === 0 ? (
        <div className="nx-split-list-empty">{emptyListNode}</div>
      ) : (
        <PickList aria-label={resolvedListAria} className="nx-split-list">
          {filteredItems.map((item) => {
            const isPicked = item.id === selectedId;
            return (
              <PickOption key={item.id} value={item.id} className="nx-split-option">
                {renderItem ? (
                  renderItem(item, isPicked)
                ) : (
                  <div className="nx-split-item-card">
                    <div className="nx-split-item-top">
                      <span className="nx-split-item-heading">
                        {item.unread && <span className="nx-split-unread-dot" aria-label="Unread" />}
                        {item.icon && <span className="nx-split-item-icon">{item.icon}</span>}
                        {item.code && <span className="nx-split-item-code">{item.code}</span>}
                        <span className="nx-split-item-title">{item.title}</span>
                      </span>
                      {item.meta && <span className="nx-split-item-meta">{item.meta}</span>}
                    </div>

                    {item.subtitle && <div className="nx-split-item-subtitle">{item.subtitle}</div>}

                    {(item.preview || item.badge) && (
                      <div className="nx-split-item-bottom">
                        {item.preview && <span className="nx-split-item-preview">{item.preview}</span>}
                        {item.badge && <span className="nx-split-item-badge">{item.badge}</span>}
                      </div>
                    )}
                  </div>
                )}
              </PickOption>
            );
          })}
        </PickList>
      )}
    </div>
  );

  const renderDetailContent = (showBack: boolean) => (
    <PickPane aria-label={selectedItem ? selectedItem.title : resolvedDetailAria} className="nx-split-pane">
      {showBack && selectedItem && (
        <div className="nx-split-mobile-bar">
          <PickBack className="nx-split-back-btn">
            <Icon name="arrow-left" size={14} weight="bold" />
            <span>{backLabel}</span>
          </PickBack>
          {selectedItem.code && <span className="nx-split-mobile-code">{selectedItem.code}</span>}
        </div>
      )}

      {selectedItem ? (
        <div className="nx-split-detail-body">{renderDetail(selectedItem)}</div>
      ) : (
        <div className="nx-split-detail-empty">{emptyDetailNode}</div>
      )}
    </PickPane>
  );

  return (
    <div
      ref={setContainerRef}
      className={cx('nx-split-view', className)}
      data-narrow={!isWide ? '' : undefined}
      style={height !== undefined ? { height } : undefined}
    >
      <Pick keys={itemKeys} value={selectedId} onValueChange={handlePickChange} follow={isWide} className="nx-split-pick-root">
        {isWide ? (
          <Resizable orientation="horizontal" autoSaveId={autoSaveId} className="nx-split-resizable">
            <ResizablePanel
              id="master"
              defaultSize={defaultListSize}
              minSize={minListSize}
              maxSize={maxListSize}
              className="nx-split-panel nx-split-panel-master"
            >
              {renderMasterContent()}
            </ResizablePanel>

            <ResizableHandle className="nx-split-handle" />

            <ResizablePanel id="detail" className="nx-split-panel nx-split-panel-detail">
              {renderDetailContent(false)}
            </ResizablePanel>
          </Resizable>
        ) : selectedItem ? (
          renderDetailContent(true)
        ) : (
          renderMasterContent()
        )}
      </Pick>
    </div>
  );
}

/** Master-detail split workspace supporting both item-driven inbox splits and custom `list`/`detail` panes. */
export function SplitView<T = unknown>(props: SplitViewProps<T>) {
  if ('items' in props) {
    return <ItemsSplitView {...props} />;
  }
  return <StandalonePaneSplitView {...props} />;
}
