/** Shared procedural media artwork, safe preview fallback, and attachment metadata helpers. */
'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { Icon } from '../Icon.js';
import { cx, type Tone } from '../internal/cx.js';

/* ============================================================================
 * 1. Procedural Architectural & Abstract Data SVG Artwork
 *    Guarantees crisp, zero-broken-link visuals across galleries & lightboxes.
 * ========================================================================== */

/** Procedural SVG artwork motif index (`1..6`) for media fallbacks. */
export type MediaArtworkVariant = 1 | 2 | 3 | 4 | 5 | 6;

interface ProceduralMediaArtworkProps {
  variant?: MediaArtworkVariant;
  label?: string;
  className?: string;
}

function ProceduralMediaArtwork({ variant = 1, label, className }: ProceduralMediaArtworkProps) {
  return (
    <svg
      viewBox="0 0 480 320"
      fill="none"
      role={label ? 'img' : 'presentation'}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx('nx-media-artwork-svg', className)}
    >
      {/* Subtle Architectural Grid Base */}
      <rect width="480" height="320" className="nx-art-bg" />
      <g className="nx-art-grid" strokeWidth="1">
        <line x1="0" y1="64" x2="480" y2="64" />
        <line x1="0" y1="128" x2="480" y2="128" />
        <line x1="0" y1="192" x2="480" y2="192" />
        <line x1="0" y1="256" x2="480" y2="256" />
        <line x1="96" y1="0" x2="96" y2="320" />
        <line x1="192" y1="0" x2="192" y2="320" />
        <line x1="288" y1="0" x2="288" y2="320" />
        <line x1="384" y1="0" x2="384" y2="320" />
      </g>

      {variant === 1 && (
        /* Isometric Schema Planes */
        <g>
          <polygon points="240,54 390,132 240,210 90,132" className="nx-art-plane-subtle" strokeWidth="1.5" />
          <polygon points="240,86 368,152 240,218 112,152" className="nx-art-plane-mid" strokeWidth="1.5" />
          <polygon points="240,118 344,172 240,226 136,172" className="nx-art-plane-accent" strokeWidth="1.75" />
          <circle cx="240" cy="118" r="4.5" className="nx-art-node-accent" />
          <circle cx="344" cy="172" r="4" className="nx-art-node-ink" />
          <circle cx="136" cy="172" r="4" className="nx-art-node-ink" />
          <line x1="240" y1="38" x2="240" y2="274" strokeDasharray="4 4" className="nx-art-axis" />
        </g>
      )}

      {variant === 2 && (
        /* Topographic Latency Contours */
        <g>
          <ellipse cx="256" cy="164" rx="176" ry="102" className="nx-art-stroke-muted" strokeWidth="1.25" />
          <ellipse cx="252" cy="162" rx="136" ry="78" className="nx-art-stroke-muted" strokeWidth="1.25" />
          <ellipse cx="248" cy="160" rx="96" ry="54" className="nx-art-plane-mid" strokeWidth="1.5" />
          <ellipse cx="244" cy="158" rx="54" ry="30" className="nx-art-plane-accent" strokeWidth="1.75" />
          <line x1="56" y1="158" x2="424" y2="158" strokeDasharray="3 4" className="nx-art-axis" />
          <line x1="244" y1="42" x2="244" y2="278" strokeDasharray="3 4" className="nx-art-axis" />
          <circle cx="244" cy="158" r="5" className="nx-art-node-accent" />
          <circle cx="344" cy="160" r="3.5" className="nx-art-node-secondary" />
        </g>
      )}

      {variant === 3 && (
        /* Signal Harmonic Telemetry */
        <g>
          {[
            [68, 84],
            [96, 118],
            [124, 96],
            [152, 146],
            [180, 174],
            [208, 134],
            [236, 196],
            [264, 168],
            [292, 122],
            [320, 152],
            [348, 108],
            [376, 138],
            [404, 92],
          ].map(([x, h], idx) => (
            <rect
              key={idx}
              x={x}
              y={264 - h!}
              width="16"
              height={h}
              rx="3"
              className={idx === 6 || idx === 7 ? 'nx-art-bar-accent' : 'nx-art-bar-neutral'}
            />
          ))}
          <path
            d="M 64 190 C 128 160, 184 96, 244 82 C 304 68, 352 146, 420 116"
            className="nx-art-curve-accent"
            strokeWidth="2.25"
            strokeLinecap="round"
          />
          <circle cx="244" cy="82" r="5" className="nx-art-node-accent" />
        </g>
      )}

      {variant === 4 && (
        /* Architectural Blueprint Partitioning */
        <g>
          <rect x="64" y="48" width="352" height="224" rx="8" className="nx-art-plane-subtle" strokeWidth="1.5" />
          <line x1="276" y1="48" x2="276" y2="272" className="nx-art-stroke-strong" strokeWidth="1.5" />
          <line x1="276" y1="176" x2="416" y2="176" className="nx-art-stroke-strong" strokeWidth="1.5" />
          <path d="M 276 272 A 140 140 0 0 1 136 132" strokeDasharray="4 4" className="nx-art-curve-accent" strokeWidth="1.75" />
          <rect x="92" y="76" width="156" height="92" rx="5" className="nx-art-plane-accent" strokeWidth="1.5" />
          <circle cx="276" cy="176" r="4.5" className="nx-art-node-accent" />
          <circle cx="416" cy="176" r="3.5" className="nx-art-node-ink" />
        </g>
      )}

      {variant === 5 && (
        /* Distributed Node Constellation */
        <g>
          <g className="nx-art-stroke-strong" strokeWidth="1.4">
            <line x1="240" y1="156" x2="128" y2="96" />
            <line x1="240" y1="156" x2="356" y2="88" />
            <line x1="240" y1="156" x2="144" y2="232" />
            <line x1="240" y1="156" x2="364" y2="224" />
            <line x1="128" y1="96" x2="248" y2="62" />
            <line x1="356" y1="88" x2="248" y2="62" />
            <line x1="144" y1="232" x2="364" y2="224" strokeDasharray="4 4" />
          </g>
          <circle cx="240" cy="156" r="28" className="nx-art-plane-accent" strokeWidth="1.75" />
          <circle cx="240" cy="156" r="7" className="nx-art-node-accent" />
          {[
            [128, 96],
            [356, 88],
            [144, 232],
            [364, 224],
            [248, 62],
          ].map(([cxPos, cyPos], idx) => (
            <g key={idx}>
              <circle cx={cxPos} cy={cyPos} r="13" className="nx-art-plane-mid" strokeWidth="1.5" />
              <circle cx={cxPos} cy={cyPos} r="4" className="nx-art-node-ink" />
            </g>
          ))}
        </g>
      )}

      {variant === 6 && (
        /* Stratified Ledger Matrix */
        <g>
          <rect x="72" y="62" width="336" height="36" rx="6" className="nx-art-plane-subtle" strokeWidth="1.4" />
          <rect x="72" y="114" width="268" height="36" rx="6" className="nx-art-plane-mid" strokeWidth="1.4" />
          <rect x="116" y="166" width="292" height="36" rx="6" className="nx-art-plane-accent" strokeWidth="1.75" />
          <rect x="72" y="218" width="216" height="36" rx="6" className="nx-art-plane-subtle" strokeWidth="1.4" />
          <line x1="224" y1="42" x2="224" y2="278" className="nx-art-curve-accent" strokeWidth="1.75" />
          <circle cx="224" cy="184" r="5" className="nx-art-node-accent" />
        </g>
      )}
    </svg>
  );
}

export function SafeMediaPreview({
  src,
  alt,
  variant = 1,
  className,
}: {
  src?: string;
  alt: string;
  variant?: MediaArtworkVariant;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (src && !failed) {
    return (
      <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} className={cx('nx-media-img', className)} />
    );
  }

  return <ProceduralMediaArtwork variant={variant} label={alt} className={className} />;
}

/* ============================================================================
 * 2. Attachment Types & File Helpers
 * ========================================================================== */

/** Supported attachment document or media kind in `AttachmentList`, `MediaGallery`, and `FileLightbox`. */
export type AttachmentFileKind = 'pdf' | 'sql' | 'json' | 'png' | 'csv' | 'svg' | 'code' | 'doc';

/** File or media attachment descriptor shared across `AttachmentList`, `MediaGallery`, and `FileLightbox`. */
export interface AttachmentItem {
  id: string;
  name: string;
  size: string | number;
  mimeType?: string;
  kind?: AttachmentFileKind;
  uploadedBy?: string;
  uploadedAt?: string;
  previewUrl?: string;
  artworkVariant?: MediaArtworkVariant;
  codePreview?: string;
  dimensions?: string;
  checksum?: string;
  category?: string;
  caption?: string;
}

export function inferAttachmentKind(item: Pick<AttachmentItem, 'name' | 'mimeType' | 'kind'>): AttachmentFileKind {
  if (item.kind) return item.kind;
  const lower = item.name.toLowerCase();
  const mime = (item.mimeType ?? '').toLowerCase();
  if (lower.endsWith('.pdf') || mime.includes('pdf')) return 'pdf';
  if (lower.endsWith('.sql') || mime.includes('sql')) return 'sql';
  if (lower.endsWith('.json') || mime.includes('json')) return 'json';
  if (lower.endsWith('.csv') || mime.includes('csv')) return 'csv';
  if (lower.endsWith('.svg') || mime.includes('svg')) return 'svg';
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp') || mime.startsWith('image/')) {
    return 'png';
  }
  if (
    lower.endsWith('.ts') ||
    lower.endsWith('.tsx') ||
    lower.endsWith('.js') ||
    lower.endsWith('.py') ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.yml')
  ) {
    return 'code';
  }
  return 'doc';
}

export function formatAttachmentSize(size: string | number): string {
  if (typeof size === 'string') {
    const trimmed = size.trim();
    if (!trimmed) return '';
    if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;
    const num = Number(trimmed);
    return formatAttachmentSize(num);
  }
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'] as const;
  let exp = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  let scaled = size / 1024 ** exp;
  if (exp > 0 && scaled >= 1023.95 && exp < units.length - 1) {
    exp += 1;
    scaled = size / 1024 ** exp;
  }
  return `${exp === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[exp]}`;
}

export function fileBadgeMeta(kind: AttachmentFileKind): {
  label: string;
  tone: Tone;
  icon: ReactNode;
} {
  switch (kind) {
    case 'pdf':
      return { label: 'PDF', tone: 'critical', icon: <Icon name="file-pdf" size={15} weight="bold" /> };
    case 'sql':
      return { label: 'SQL', tone: 'accent', icon: <Icon name="file-sql" size={15} weight="bold" /> };
    case 'json':
      return { label: 'JSON', tone: 'warning', icon: <Icon name="file-code" size={15} weight="bold" /> };
    case 'csv':
      return { label: 'CSV', tone: 'good', icon: <Icon name="file-csv" size={15} weight="bold" /> };
    case 'png':
      return { label: 'PNG', tone: 'info', icon: <Icon name="image" size={15} weight="bold" /> };
    case 'svg':
      return { label: 'SVG', tone: 'info', icon: <Icon name="image" size={15} weight="bold" /> };
    case 'code':
      return { label: 'CODE', tone: 'accent', icon: <Icon name="code" size={15} weight="bold" /> };
    case 'doc':
    default:
      return { label: 'DOC', tone: 'neutral', icon: <Icon name="file-text" size={15} weight="bold" /> };
  }
}

export function isVisualImageKind(item: AttachmentItem, kind: AttachmentFileKind): boolean {
  if (item.codePreview) return false;
  return kind === 'png' || kind === 'svg' || Boolean(item.previewUrl) || item.artworkVariant !== undefined;
}
