/** Dark-surface modal file lightbox with keyboard navigation and procedural media artwork re-exports. */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon.js';
import { Modal } from '../Modal.js';
import { cx, toDataTone } from '../internal/cx.js';
import {
  SafeMediaPreview,
  fileBadgeMeta,
  formatAttachmentSize,
  inferAttachmentKind,
  isVisualImageKind,
  type AttachmentFileKind,
  type AttachmentItem,
  type MediaArtworkVariant,
} from './mediaShared.js';

export type { AttachmentFileKind, AttachmentItem, MediaArtworkVariant };

/* ============================================================================
 * 3. FileLightbox (Dark-Surface Modal Preview + Next/Prev Keyboard Nav)
 * ========================================================================== */

/** Props for the `FileLightbox` component. */
export interface FileLightboxProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ReadonlyArray<AttachmentItem>;
  activeIndex?: number;
  defaultIndex?: number;
  onIndexChange?: (index: number) => void;
  onDownload?: (item: AttachmentItem) => void;
  className?: string;
}

/** Fullscreen modal file preview lightbox with keyboard Left/Right navigation and code/metadata views. */
export function FileLightbox({
  open,
  onOpenChange,
  items,
  activeIndex,
  defaultIndex = 0,
  onIndexChange,
  onDownload,
  className,
}: FileLightboxProps) {
  const [internalIndex, setInternalIndex] = useState(defaultIndex);
  const [copiedCode, setCopiedCode] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const safeLength = items.length;
  const resolvedIndex = safeLength === 0 ? 0 : Math.max(0, Math.min(safeLength - 1, activeIndex ?? internalIndex));

  const setIndex = useCallback(
    (next: number) => {
      if (safeLength === 0) return;
      const wrapped = ((next % safeLength) + safeLength) % safeLength;
      if (activeIndex === undefined) setInternalIndex(wrapped);
      onIndexChange?.(wrapped);
      setCopiedCode(false);
    },
    [safeLength, activeIndex, onIndexChange],
  );

  useEffect(() => {
    if (!open || safeLength <= 1) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setIndex(resolvedIndex - 1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        setIndex(resolvedIndex + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, safeLength, resolvedIndex, setIndex]);

  const currentItem = items[resolvedIndex];
  if (!currentItem) return null;

  const kind = inferAttachmentKind(currentItem);
  const badge = fileBadgeMeta(kind);
  const formattedSize = formatAttachmentSize(currentItem.size);
  const showImageStage = isVisualImageKind(currentItem, kind);
  const variant = currentItem.artworkVariant ?? (((resolvedIndex % 6) + 1) as MediaArtworkVariant);

  const handleCopySnippet = () => {
    if (!currentItem.codePreview) return;
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(currentItem.codePreview);
    }
    setCopiedCode(true);
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopiedCode(false), 1500);
  };

  const codeLines = currentItem.codePreview ? currentItem.codePreview.split('\n') : [];
  const metaParts = [formattedSize, currentItem.dimensions, currentItem.uploadedBy, currentItem.uploadedAt].filter(Boolean);

  if (!open) return null;

  return (
    <Modal
      onClose={() => onOpenChange(false)}
      ariaLabel={currentItem.name}
      className={cx('nx-dialog-content nx-lightbox-dialog', className)}
    >
      {/* Top Dark Toolbar */}
      <div className="nx-lightbox-header">
        <div className="nx-lightbox-file-info">
          <span className="nx-lightbox-kind-pill" data-tone={toDataTone(badge.tone)}>
            {badge.label}
          </span>
          <div className="nx-lightbox-titles">
            <h2 className="nx-lightbox-title">{currentItem.name}</h2>
            {metaParts.length > 0 ? <p className="nx-lightbox-meta">{metaParts.join(' · ')}</p> : null}
          </div>
        </div>

        <div className="nx-lightbox-toolbar-actions">
          {safeLength > 1 ? (
            <span className="nx-lightbox-counter">
              {resolvedIndex + 1} / {safeLength}
            </span>
          ) : null}

          {currentItem.codePreview ? (
            <button type="button" onClick={handleCopySnippet} className="nx-lightbox-tool-btn nx-focusable">
              {copiedCode ? (
                <>
                  <Icon name="check" size={13} weight="bold" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Icon name="copy" size={13} />
                  <span>Copy</span>
                </>
              )}
            </button>
          ) : null}

          <button type="button" onClick={() => onDownload?.(currentItem)} className="nx-lightbox-tool-btn nx-focusable">
            <Icon name="download-simple" size={14} weight="bold" />
            <span>Download</span>
          </button>

          <button type="button" onClick={() => onOpenChange(false)} aria-label="Close preview" className="nx-lightbox-close nx-focusable">
            <Icon name="x" size={15} weight="bold" />
          </button>
        </div>
      </div>

      {/* Center Preview Stage */}
      <div className="nx-lightbox-stage">
        {safeLength > 1 ? (
          <button
            type="button"
            onClick={() => setIndex(resolvedIndex - 1)}
            aria-label="Previous file"
            className="nx-lightbox-nav nx-lightbox-nav-prev nx-focusable"
          >
            <Icon name="caret-left" size={18} weight="bold" />
          </button>
        ) : null}

        <div className="nx-lightbox-viewport">
          {showImageStage ? (
            <figure className="nx-lightbox-figure">
              <div className="nx-lightbox-canvas">
                <SafeMediaPreview
                  src={currentItem.previewUrl}
                  alt={currentItem.caption ?? currentItem.name}
                  variant={variant}
                  className="nx-lightbox-artwork"
                />
              </div>
              {currentItem.caption ? <figcaption className="nx-lightbox-caption">{currentItem.caption}</figcaption> : null}
            </figure>
          ) : currentItem.codePreview ? (
            <div className="nx-lightbox-code-box">
              <pre className="nx-lightbox-pre">
                <code>
                  {codeLines.map((line, i) => (
                    <div key={i} className="nx-lightbox-code-line">
                      <span className="nx-lightbox-line-no">{i + 1}</span>
                      <span className="nx-lightbox-line-text">{line || ' '}</span>
                    </div>
                  ))}
                </code>
              </pre>
            </div>
          ) : (
            <div className="nx-lightbox-doc-sheet">
              <div className="nx-lightbox-doc-icon" data-tone={badge.tone}>
                {badge.icon}
                <span>{badge.label}</span>
              </div>
              <h4 className="nx-lightbox-doc-name">{currentItem.name}</h4>
              <p className="nx-lightbox-doc-desc">
                {currentItem.caption ?? 'Document metadata verified. Download to open in your native desktop viewer.'}
              </p>
              <dl className="nx-lightbox-doc-facts">
                <div>
                  <dt>MIME Type</dt>
                  <dd>{currentItem.mimeType ?? `application/${kind}`}</dd>
                </div>
                {formattedSize ? (
                  <div>
                    <dt>File size</dt>
                    <dd>{formattedSize}</dd>
                  </div>
                ) : null}
                {currentItem.uploadedBy ? (
                  <div>
                    <dt>Uploaded by</dt>
                    <dd>{currentItem.uploadedBy}</dd>
                  </div>
                ) : null}
                {currentItem.checksum ? (
                  <div>
                    <dt>SHA-256</dt>
                    <dd className="nx-lightbox-mono">{currentItem.checksum}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
          )}
        </div>

        {safeLength > 1 ? (
          <button
            type="button"
            onClick={() => setIndex(resolvedIndex + 1)}
            aria-label="Next file"
            className="nx-lightbox-nav nx-lightbox-nav-next nx-focusable"
          >
            <Icon name="caret-right" size={18} weight="bold" />
          </button>
        ) : null}
      </div>

      {/* Bottom Filmstrip Switcher */}
      {safeLength > 1 ? (
        <div className="nx-lightbox-strip" role="tablist" aria-label="Files in collection">
          {items.map((entry, idx) => {
            const entryKind = inferAttachmentKind(entry);
            const entryBadge = fileBadgeMeta(entryKind);
            const isCurrent = idx === resolvedIndex;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={isCurrent}
                data-active={isCurrent ? '' : undefined}
                onClick={() => setIndex(idx)}
                className="nx-lightbox-strip-item nx-focusable"
              >
                <span className="nx-lightbox-strip-tag">{entryBadge.label}</span>
                <span className="nx-lightbox-strip-name">{entry.name}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </Modal>
  );
}
