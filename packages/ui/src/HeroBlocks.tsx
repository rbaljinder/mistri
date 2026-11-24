/**
 * Badges and landing hero blocks: a status or hero badge, two to four photo tiles where one photo would stand,
 * and up to four rows of an icon and a line. Props only: the words, the icons (as nodes) and the image addresses are
 * handed in, so the kit draws them with its own icons and the files an App holds.
 */
import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { cx, toDataTone, type Tone } from './internal/cx.js';
import { slotted } from './internal/uiKitContext.js';

/** Semantic badge tone alias pointing to the canonical `Tone` union. */
export type BadgeTone = Tone;

/** Props for the `Badge` component. */
export interface BadgeProps extends Omit<HTMLAttributes<HTMLElement>, 'children' | 'onChange' | 'aria-label' | 'inlist'> {
  /** The few words. */
  children?: ReactNode;
  /** Semantic tone; when omitted without pill/onRemove, draws as the quiet hero badge (`data-kind="hero"`). */
  tone?: Tone;
  pill?: boolean;
  /** A picture before the words, already sized by the caller. */
  icon?: ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
  ariaLabel?: string;
  ref?: Ref<HTMLElement>;
}

/** A badge: quiet hero eyebrow when untoned, or a semantic status/tag chip when `tone`, `pill`, or `onRemove` is given. */
function DefaultBadge({
  children,
  tone,
  pill = false,
  icon,
  onRemove,
  removeLabel = 'Remove',
  ariaLabel,
  className,
  ref,
  ...rest
}: BadgeProps) {
  const legacyAriaLabel = (rest as Record<string, unknown>)['aria-label'] as string | undefined;
  const resolvedAriaLabel = ariaLabel ?? legacyAriaLabel;
  const isChip = tone !== undefined || pill || onRemove !== undefined;
  if (!isChip) {
    return (
      <p
        {...rest}
        ref={ref as Ref<HTMLParagraphElement>}
        aria-label={resolvedAriaLabel}
        data-slot="badge"
        data-kind="hero"
        className={className}
      >
        {icon}
        <span>{children}</span>
      </p>
    );
  }
  const resolvedTone = toDataTone(tone ?? 'neutral');
  return (
    <span
      {...rest}
      ref={ref as Ref<HTMLSpanElement>}
      aria-label={resolvedAriaLabel}
      data-slot="badge"
      data-tone={resolvedTone}
      data-pill={pill ? '' : undefined}
      className={cx('nx-badge', className)}
    >
      {icon ? (
        <span className="nx-badge-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span>{children}</span>
      {onRemove ? (
        <button type="button" className="nx-badge-remove" aria-label={removeLabel} onClick={onRemove}>
          <svg
            width={11}
            height={11}
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>
      ) : null}
    </span>
  );
}

/** Image tile descriptor for `PhotoTiles`. */
export interface PhotoTile {
  src: string;
  alt: string;
  srcSet?: string;
  sizes?: string;
}

/** Props for the `PhotoTiles` component. */
export interface PhotoTilesProps {
  tiles: readonly PhotoTile[];
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** The most tiles a mosaic cuts the box into. */
const MOST_TILES = 4;

/**
 * Two to four photos in the one photo's 4:3 box, cut into a mosaic, so the box has its size before any photo arrives
 * and nothing moves. The first is the one the page waits for; the rest load as they come near. Fewer than two is no
 * mosaic, and more than four are cut off.
 */
function DefaultPhotoTiles({ tiles, className, ref }: PhotoTilesProps) {
  if (tiles.length < 2) return null;
  const shown = tiles.slice(0, MOST_TILES);
  return (
    <div ref={ref} data-slot="photo-tiles" data-count={shown.length} className={className || undefined}>
      {shown.map((tile, index) => (
        <figure key={`${index}:${tile.src}`}>
          {tile.src ? (
            <img
              src={tile.src}
              srcSet={tile.srcSet || undefined}
              sizes={tile.sizes || undefined}
              alt={tile.alt}
              decoding="async"
              {...(index === 0 ? { fetchPriority: 'high' as const } : { loading: 'lazy' as const })}
            />
          ) : (
            <span role="img" aria-label={tile.alt} data-slot="photo-tile-placeholder" />
          )}
        </figure>
      ))}
    </div>
  );
}

/** Props for the `IconRows` component. */
export interface IconRowsProps {
  rows: readonly { icon: ReactNode; text: string }[];
  className?: string;
  ref?: Ref<HTMLUListElement>;
}

/** The most rows the block draws. */
const MOST_ROWS = 4;

/** Up to four rows, each an icon in the accent and a line in the muted ink. Nothing for no rows. */
function DefaultIconRows({ rows, className, ref }: IconRowsProps) {
  if (!rows.length) return null;
  return (
    <ul ref={ref} data-slot="icon-rows" data-kind="plain" className={className || undefined}>
      {rows.slice(0, MOST_ROWS).map((row, index) => (
        <li key={`${index}:${row.text}`}>
          {/* The icon is a picture beside the line: the line is what the row says. */}
          <span data-slot="icon-rows-icon" aria-hidden="true">
            {row.icon}
          </span>
          <span>{row.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** Semantic status chip or hero eyebrow badge with optional icon, pill rounding, and remove button. */
export const Badge = slotted('Badge', DefaultBadge);

/** Fixed-aspect mosaic of two to four hero photographs with safe placeholder fallback. */
export const PhotoTiles = slotted('PhotoTiles', DefaultPhotoTiles);

/** Compact list of up to four accented icon-and-caption rows. */
export const IconRows = slotted('IconRows', DefaultIconRows);
