/**
 * The landing hero's blocks (Preview): a badge over the heading, two to four photo tiles where one photo would stand,
 * and up to four rows of an icon and a line. Props only: the words, the icons (as nodes) and the image addresses are
 * handed in, so the kit draws them with its own icons and the files an App holds. Their rules are hero.css.
 */
import type { ReactNode } from 'react';
import { slotted } from './internal/uiKitContext.js';

export interface BadgeProps {
  /** The few words. */
  children: ReactNode;
  /** A picture before the words, already sized by the caller. */
  icon?: ReactNode;
}

/** A pill of a few words with an optional icon, over a heading. Quiet: a note on the page, never a button. */
function DefaultBadge({ children, icon }: BadgeProps) {
  return (
    <p data-slot="badge" data-kind="hero">
      {icon}
      <span>{children}</span>
    </p>
  );
}

export interface PhotoTile {
  src: string;
  alt: string;
  srcSet?: string;
  sizes?: string;
}

export interface PhotoTilesProps {
  tiles: readonly PhotoTile[];
}

/** The most tiles a mosaic cuts the box into. */
const MOST_TILES = 4;

/**
 * Two to four photos in the one photo's 4:3 box, cut into a mosaic, so the box has its size before any photo arrives
 * and nothing moves. The first is the one the page waits for; the rest load as they come near. Fewer than two is no
 * mosaic, and more than four are cut off.
 */
function DefaultPhotoTiles({ tiles }: PhotoTilesProps) {
  if (tiles.length < 2) return null;
  const shown = tiles.slice(0, MOST_TILES);
  return (
    <div data-slot="photo-tiles" data-count={shown.length}>
      {shown.map((tile, index) => (
        <figure key={`${index}:${tile.src}`}>
          <img
            src={tile.src}
            srcSet={tile.srcSet}
            sizes={tile.sizes}
            alt={tile.alt}
            decoding="async"
            {...(index === 0 ? { fetchPriority: 'high' as const } : { loading: 'lazy' as const })}
          />
        </figure>
      ))}
    </div>
  );
}

export interface IconRowsProps {
  rows: readonly { icon: ReactNode; text: string }[];
}

/** The most rows the block draws. */
const MOST_ROWS = 4;

/** Up to four rows, each an icon in the accent and a line in the muted ink. Nothing for no rows. */
function DefaultIconRows({ rows }: IconRowsProps) {
  if (!rows.length) return null;
  return (
    <ul data-slot="icon-rows" data-kind="plain">
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

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const Badge = slotted('Badge', DefaultBadge);
export const PhotoTiles = slotted('PhotoTiles', DefaultPhotoTiles);
export const IconRows = slotted('IconRows', DefaultIconRows);
