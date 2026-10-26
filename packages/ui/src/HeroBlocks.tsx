/**
 * The landing hero's blocks (Preview): a badge over the heading, two to four photo tiles where one photo would stand,
 * and up to four rows of an icon and a line. Props only: the words, the icons (as nodes) and the image addresses are
 * handed in, so the kit draws them with its own icons and the files an App holds. Their rules are hero.css.
 */
import type { ReactNode } from 'react';

export interface BadgeProps {
  /** The few words. */
  children: ReactNode;
  /** A picture before the words, already sized by the caller. */
  icon?: ReactNode;
}

/** A pill of a few words with an optional icon, over a heading. Quiet: a note on the page, never a button. */
export function Badge({ children, icon }: BadgeProps) {
  return (
    <p className="front-badge">
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
export function PhotoTiles({ tiles }: PhotoTilesProps) {
  if (tiles.length < 2) return null;
  const shown = tiles.slice(0, MOST_TILES);
  return (
    <div className={`front-hero-media front-hero-tiles front-hero-tiles-${shown.length}`}>
      {shown.map((tile, index) => (
        <img
          key={`${index}:${tile.src}`}
          src={tile.src}
          srcSet={tile.srcSet}
          sizes={tile.sizes}
          alt={tile.alt}
          decoding="async"
          {...(index === 0 ? { fetchPriority: 'high' as const } : { loading: 'lazy' as const })}
        />
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
export function IconRows({ rows }: IconRowsProps) {
  if (!rows.length) return null;
  return (
    <ul className="front-points">
      {rows.slice(0, MOST_ROWS).map((row, index) => (
        <li key={`${index}:${row.text}`}>
          {row.icon}
          <span>{row.text}</span>
        </li>
      ))}
    </ul>
  );
}
