/** Attachment lists, photo mosaics, and filterable media galleries with modal lightbox integration. */
'use client';

import { type ComponentProps, type ReactNode, useMemo, useState } from 'react';
import { Icon } from '../Icon.js';
import { cx, isEmptyStateSpec, type EmptyStateSpec } from '../internal/cx.js';
import { IconButton } from '../primitives/actions.js';
import { Badge } from '../primitives/display.js';
import { FileLightbox } from './MediaLightbox.js';
import {
  SafeMediaPreview,
  fileBadgeMeta,
  formatAttachmentSize,
  inferAttachmentKind,
  isVisualImageKind,
  type AttachmentItem,
  type MediaArtworkVariant,
} from './mediaShared.js';

/* ============================================================================
 * 4. AttachmentList
 * ========================================================================== */

/** Display mode for `AttachmentList`. */
export type AttachmentListLayout = 'list' | 'grid';

/** Props for the `AttachmentList` component. */
export interface AttachmentListProps extends Omit<ComponentProps<'div'>, 'title' | 'onSelect' | 'onChange' | 'aria-label' | 'inlist'> {
  title?: ReactNode;
  items?: ReadonlyArray<AttachmentItem>;
  defaultItems?: ReadonlyArray<AttachmentItem>;
  layout?: AttachmentListLayout;
  defaultLayout?: AttachmentListLayout;
  onLayoutChange?: (layout: AttachmentListLayout) => void;
  showLayoutToggle?: boolean;
  disableLightbox?: boolean;
  empty?: EmptyStateSpec | ReactNode;
  ariaLabel?: string;
  onSelect?: (item: AttachmentItem, index: number) => void;
  onDownload?: (item: AttachmentItem) => void;
  onDelete?: (id: string) => void;
}

const EMPTY_ATTACHMENTS: ReadonlyArray<AttachmentItem> = [];

/** File attachment list and thumbnail grid with download, delete, and modal preview lightbox. */
export function AttachmentList({
  title,
  items,
  defaultItems = EMPTY_ATTACHMENTS,
  layout,
  defaultLayout = 'list',
  onLayoutChange,
  showLayoutToggle = true,
  disableLightbox = false,
  empty,
  ariaLabel,
  onSelect,
  onDownload,
  onDelete,
  className,
  ...props
}: AttachmentListProps) {
  const legacyAriaLabel = (props as Record<string, unknown>)['aria-label'] as string | undefined;
  const [internalItems, setInternalItems] = useState<AttachmentItem[]>(() => [...defaultItems]);
  const [internalLayout, setInternalLayout] = useState<AttachmentListLayout>(defaultLayout);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const activeItems = items ?? internalItems;
  const activeLayout = layout ?? internalLayout;

  const setViewLayout = (next: AttachmentListLayout) => {
    if (layout === undefined) setInternalLayout(next);
    onLayoutChange?.(next);
  };

  const handleOpenItem = (item: AttachmentItem, idx: number) => {
    onSelect?.(item, idx);
    if (!disableLightbox) {
      setActiveIndex(idx);
      setLightboxOpen(true);
    }
  };

  const handleDeleteItem = (id: string) => {
    if (items === undefined) {
      setInternalItems((prev) => prev.filter((item) => item.id !== id));
    }
    onDelete?.(id);
  };

  return (
    <div aria-label={ariaLabel ?? legacyAriaLabel} data-slot="attachment-list" className={cx('nx-attachments', className)} {...props}>
      {(title !== undefined || showLayoutToggle) && (
        <div className="nx-attachments-bar">
          <div className="nx-attachments-heading">
            {title !== undefined ? (
              <h4 className="nx-attachments-title">{title}</h4>
            ) : (
              <span className="nx-attachments-title">Attachments</span>
            )}
            <Badge tone="neutral" pill>
              {activeItems.length}
            </Badge>
          </div>

          {showLayoutToggle ? (
            <div className="nx-attachments-view-switch" role="group" aria-label="Attachment layout">
              <IconButton
                variant={activeLayout === 'list' ? 'secondary' : 'ghost'}
                size="xs"
                ariaLabel="List view"
                icon={<Icon name="list" size={14} />}
                onClick={() => setViewLayout('list')}
              />
              <IconButton
                variant={activeLayout === 'grid' ? 'secondary' : 'ghost'}
                size="xs"
                ariaLabel="Grid view"
                icon={<Icon name="squares-four" size={14} />}
                onClick={() => setViewLayout('grid')}
              />
            </div>
          ) : null}
        </div>
      )}

      {activeItems.length === 0 ? (
        <div className="nx-attachments-empty">
          <Icon name="file" size={18} />
          <span>{empty !== undefined ? (isEmptyStateSpec(empty) ? empty.title : empty) : 'No attachments in this record.'}</span>
        </div>
      ) : (
        <div role="list" data-layout={activeLayout} className="nx-attachments-items">
          {activeItems.map((item, idx) => {
            const kind = inferAttachmentKind(item);
            const badge = fileBadgeMeta(kind);
            const sizeText = formatAttachmentSize(item.size);
            const isVisual = isVisualImageKind(item, kind);
            const subParts = [sizeText, item.uploadedBy, item.uploadedAt].filter(Boolean);

            return (
              <div key={item.id} role="listitem" data-layout={activeLayout} className="nx-attachment-card">
                <button type="button" onClick={() => handleOpenItem(item, idx)} className="nx-attachment-trigger nx-focusable">
                  {activeLayout === 'grid' && isVisual ? (
                    <div className="nx-attachment-thumb">
                      <SafeMediaPreview
                        src={item.previewUrl}
                        alt={item.name}
                        variant={item.artworkVariant ?? (((idx % 6) + 1) as MediaArtworkVariant)}
                      />
                    </div>
                  ) : (
                    <span className="nx-attachment-badge" data-tone={badge.tone}>
                      {badge.icon}
                      <span className="nx-attachment-badge-code">{badge.label}</span>
                    </span>
                  )}

                  <div className="nx-attachment-copy">
                    <div className="nx-attachment-name-row">
                      <span className="nx-attachment-name">{item.name}</span>
                      {activeLayout === 'grid' && isVisual ? (
                        <span className="nx-attachment-inline-ext" data-tone={badge.tone}>
                          {badge.label}
                        </span>
                      ) : null}
                    </div>
                    {subParts.length > 0 ? <div className="nx-attachment-sub">{subParts.join(' · ')}</div> : null}
                  </div>
                </button>

                <div className="nx-attachment-actions">
                  <IconButton
                    variant="ghost"
                    size="xs"
                    ariaLabel={`Download ${item.name}`}
                    title="Download"
                    icon={<Icon name="download-simple" size={14} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDownload?.(item);
                    }}
                  />
                  <IconButton
                    variant="ghost"
                    size="xs"
                    ariaLabel={`Delete ${item.name}`}
                    title="Remove attachment"
                    icon={<Icon name="trash" size={14} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteItem(item.id);
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!disableLightbox ? (
        <FileLightbox
          open={lightboxOpen}
          onOpenChange={setLightboxOpen}
          items={activeItems}
          activeIndex={activeIndex}
          onIndexChange={setActiveIndex}
          onDownload={onDownload}
        />
      ) : null}
    </div>
  );
}

/* ============================================================================
 * 5. PhotoMosaic (Asymmetric 2-to-4 Tile Mosaic + Lightbox)
 * ========================================================================== */

/** Image tile descriptor rendered in `PhotoMosaic`. */
export interface PhotoMosaicTile {
  id: string;
  title: string;
  alt?: string;
  caption?: string;
  src?: string;
  artworkVariant?: MediaArtworkVariant;
  dimensions?: string;
  uploadedBy?: string;
  size?: string;
}

/** Props for the `PhotoMosaic` component. */
export interface PhotoMosaicProps extends Omit<ComponentProps<'div'>, 'onChange' | 'aria-label' | 'inlist'> {
  tiles?: ReadonlyArray<PhotoMosaicTile>;
  disableLightbox?: boolean;
  empty?: EmptyStateSpec | ReactNode;
  ariaLabel?: string;
  onTileClick?: (tile: PhotoMosaicTile, index: number) => void;
}

const EMPTY_MOSAIC_TILES: ReadonlyArray<PhotoMosaicTile> = [];

/** Asymmetric two-to-four tile photo mosaic opening a full-screen `FileLightbox` on click. */
export function PhotoMosaic({
  tiles = EMPTY_MOSAIC_TILES,
  disableLightbox = false,
  empty,
  ariaLabel,
  onTileClick,
  className,
  ...props
}: PhotoMosaicProps) {
  const legacyAriaLabel = (props as Record<string, unknown>)['aria-label'] as string | undefined;
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const visibleTiles = useMemo(() => tiles.slice(0, 4), [tiles]);

  const lightboxItems = useMemo<AttachmentItem[]>(
    () =>
      visibleTiles.map((tile, idx) => ({
        id: tile.id,
        name: `${tile.title.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.svg`,
        size: tile.size ?? '',
        kind: 'svg',
        previewUrl: tile.src,
        artworkVariant: tile.artworkVariant ?? (((idx % 6) + 1) as MediaArtworkVariant),
        dimensions: tile.dimensions,
        uploadedBy: tile.uploadedBy,
        caption: tile.caption ?? tile.title,
      })),
    [visibleTiles],
  );

  if (visibleTiles.length === 0) {
    return (
      <div
        aria-label={ariaLabel ?? legacyAriaLabel}
        data-slot="photo-mosaic"
        data-empty=""
        className={cx('nx-attachments-empty', className)}
        {...props}
      >
        <Icon name="image" size={18} />
        <span>{empty !== undefined ? (isEmptyStateSpec(empty) ? empty.title : empty) : 'No photos to display.'}</span>
      </div>
    );
  }

  const tileCount = Math.min(4, Math.max(2, visibleTiles.length));

  return (
    <>
      <div
        aria-label={ariaLabel ?? legacyAriaLabel}
        data-slot="photo-mosaic"
        data-count={visibleTiles.length === 1 ? 1 : tileCount}
        className={cx('nx-photo-mosaic', className)}
        {...props}
      >
        {visibleTiles.map((tile, idx) => (
          <button
            key={tile.id}
            type="button"
            onClick={() => {
              onTileClick?.(tile, idx);
              if (!disableLightbox) {
                setActiveIndex(idx);
                setLightboxOpen(true);
              }
            }}
            className="nx-mosaic-tile nx-focusable"
          >
            <SafeMediaPreview
              src={tile.src}
              alt={tile.alt ?? tile.title}
              variant={tile.artworkVariant ?? (((idx % 6) + 1) as MediaArtworkVariant)}
              className="nx-mosaic-media"
            />
            <div className="nx-mosaic-overlay">
              <div className="nx-mosaic-copy">
                <span className="nx-mosaic-title">{tile.title}</span>
                {tile.caption && idx === 0 ? <span className="nx-mosaic-caption">{tile.caption}</span> : null}
              </div>
              <span className="nx-mosaic-expand" aria-hidden="true">
                <Icon name="arrows-out-simple" size={13} weight="bold" />
              </span>
            </div>
          </button>
        ))}
      </div>

      {!disableLightbox ? (
        <FileLightbox
          open={lightboxOpen}
          onOpenChange={setLightboxOpen}
          items={lightboxItems}
          activeIndex={activeIndex}
          onIndexChange={setActiveIndex}
        />
      ) : null}
    </>
  );
}

/* ============================================================================
 * 6. MediaGallery (Responsive Filterable Visual Gallery + Lightbox)
 * ========================================================================== */

/** Media asset item rendered in `MediaGallery`. */
export interface MediaGalleryItem {
  id: string;
  title: string;
  caption?: string;
  category?: string;
  src?: string;
  artworkVariant?: MediaArtworkVariant;
  dimensions?: string;
  size?: string;
  uploadedBy?: string;
  uploadedAt?: string;
}

/** Props for the `MediaGallery` component. */
export interface MediaGalleryProps extends Omit<ComponentProps<'div'>, 'onChange' | 'aria-label' | 'inlist'> {
  items?: ReadonlyArray<MediaGalleryItem>;
  columns?: 2 | 3 | 4;
  showFilters?: boolean;
  disableLightbox?: boolean;
  empty?: EmptyStateSpec | ReactNode;
  ariaLabel?: string;
  onItemClick?: (item: MediaGalleryItem, index: number) => void;
}

const EMPTY_GALLERY_ITEMS: ReadonlyArray<MediaGalleryItem> = [];

/** Responsive category-filterable visual media gallery with modal `FileLightbox` preview. */
export function MediaGallery({
  items = EMPTY_GALLERY_ITEMS,
  columns = 3,
  showFilters = true,
  disableLightbox = false,
  empty,
  ariaLabel,
  onItemClick,
  className,
  ...props
}: MediaGalleryProps) {
  const legacyAriaLabel = (props as Record<string, unknown>)['aria-label'] as string | undefined;
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const categories = useMemo(() => {
    const unique = new Set<string>();
    for (const item of items) {
      if (item.category) unique.add(item.category);
    }
    return Array.from(unique);
  }, [items]);

  const filteredItems = useMemo(
    () => (selectedCategory === 'all' ? items : items.filter((item) => item.category === selectedCategory)),
    [items, selectedCategory],
  );

  const lightboxItems = useMemo<AttachmentItem[]>(
    () =>
      filteredItems.map((item, idx) => ({
        id: item.id,
        name: `${item.title.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.png`,
        size: item.size ?? '',
        kind: 'png',
        previewUrl: item.src,
        artworkVariant: item.artworkVariant ?? (((idx % 6) + 1) as MediaArtworkVariant),
        dimensions: item.dimensions,
        uploadedBy: item.uploadedBy,
        uploadedAt: item.uploadedAt,
        caption: item.caption ?? item.title,
      })),
    [filteredItems],
  );

  return (
    <div aria-label={ariaLabel ?? legacyAriaLabel} data-slot="media-gallery" className={cx('nx-media-gallery', className)} {...props}>
      {showFilters && categories.length > 0 ? (
        <div className="nx-gallery-filters" role="tablist" aria-label="Filter media by category">
          <button
            type="button"
            role="tab"
            aria-selected={selectedCategory === 'all'}
            data-active={selectedCategory === 'all' ? '' : undefined}
            onClick={() => setSelectedCategory('all')}
            className="nx-gallery-filter-pill nx-focusable"
          >
            All <span className="nx-gallery-filter-count">{items.length}</span>
          </button>
          {categories.map((cat) => {
            const count = items.filter((i) => i.category === cat).length;
            const active = selectedCategory === cat;
            return (
              <button
                key={cat}
                type="button"
                role="tab"
                aria-selected={active}
                data-active={active ? '' : undefined}
                onClick={() => setSelectedCategory(cat)}
                className="nx-gallery-filter-pill nx-focusable"
              >
                {cat} <span className="nx-gallery-filter-count">{count}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {filteredItems.length === 0 ? (
        <div className="nx-attachments-empty">
          <Icon name="image" size={18} />
          <span>{empty !== undefined ? (isEmptyStateSpec(empty) ? empty.title : empty) : 'No media items to display.'}</span>
        </div>
      ) : (
        <div data-columns={columns} className="nx-gallery-grid">
          {filteredItems.map((item, idx) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onItemClick?.(item, idx);
                if (!disableLightbox) {
                  setActiveIndex(idx);
                  setLightboxOpen(true);
                }
              }}
              className="nx-gallery-card nx-focusable"
            >
              <div className="nx-gallery-card-stage">
                <SafeMediaPreview
                  src={item.src}
                  alt={item.title}
                  variant={item.artworkVariant ?? (((idx % 6) + 1) as MediaArtworkVariant)}
                />
                <span className="nx-gallery-card-zoom" aria-hidden="true">
                  <Icon name="arrows-out-simple" size={12} weight="bold" />
                </span>
              </div>
              <div className="nx-gallery-card-body">
                <div className="nx-gallery-card-head">
                  <span className="nx-gallery-card-title">{item.title}</span>
                  {item.category ? <span className="nx-gallery-card-cat">{item.category}</span> : null}
                </div>
                {item.caption ? <p className="nx-gallery-card-caption">{item.caption}</p> : null}
                {(item.dimensions || item.size) && (
                  <div className="nx-gallery-card-meta">
                    {item.dimensions ? <span>{item.dimensions}</span> : null}
                    {item.dimensions && item.size ? <span>·</span> : null}
                    {item.size ? <span>{item.size}</span> : null}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {!disableLightbox ? (
        <FileLightbox
          open={lightboxOpen}
          onOpenChange={setLightboxOpen}
          items={lightboxItems}
          activeIndex={activeIndex}
          onIndexChange={setActiveIndex}
        />
      ) : null}
    </div>
  );
}
