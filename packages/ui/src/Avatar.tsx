/**
 * An avatar: a person's picture, or their initials where there is none.
 * Over UI SDK's Avatar, which shows the fallback only while the picture
 * loads or fails, so a slow picture never leaves a blank disc. The
 * initials are the first letters of the first two words of the name
 * ("Ada Lovelace" → "AL", "Ada" → "A"); the disc itself is decorative,
 * and a name that matters is said beside it by the caller, never by the
 * disc's title.
 */
import { Avatar as Disc, AvatarFallback, AvatarImage } from '@ui-sdk/react/avatar';
import type { ReactNode, Ref } from 'react';
import { cx } from './internal/cx.js';
import { slotted } from './internal/uiKitContext.js';

/** Visual size scale for `Avatar`. */
export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/** Presence indicator status for `Avatar`. */
export type AvatarStatus = 'online' | 'offline' | 'busy' | 'away';

/** Props for the `Avatar` component. */
export interface AvatarProps {
  /** The person's name, for the fallback initials. */
  name?: string;
  /** The picture's address; absent, the fallback shows at once. */
  src?: string;
  alt?: string;
  fallback?: ReactNode;
  size?: AvatarSize;
  shape?: 'circle' | 'rounded';
  status?: AvatarStatus;
  className?: string;
  ref?: Ref<HTMLSpanElement>;
}

const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/* A letter is a grapheme, not a UTF-16 unit: `slice(0, 1)` splits an emoji or an astral letter into a lone surrogate. */
function firstLetter(word: string): string {
  const first = graphemes ? graphemes.segment(word)[Symbol.iterator]().next().value?.segment : Array.from(word)[0];
  return (first ?? '').toUpperCase();
}

/** Extract up to two grapheme-safe initials from a display name. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  if (words.length === 1) return firstLetter(words[0]!);
  return firstLetter(words[0]!) + firstLetter(words[1]!);
}

function DefaultAvatar({ name, src, alt = '', fallback, size = 'md', shape = 'circle', status, className, ref }: AvatarProps) {
  return (
    <Disc
      ref={ref}
      className={cx(status || shape === 'rounded' || size === 'xs' || size === 'xl' ? 'nx-avatar' : undefined, className)}
      data-size={size}
      data-shape={shape === 'rounded' ? 'rounded' : undefined}
    >
      {src ? <AvatarImage src={src} alt={alt} className="nx-avatar-img" /> : null}
      <AvatarFallback aria-hidden="true" className="nx-avatar-fallback">
        {fallback ?? (name ? initialsOf(name) : '')}
      </AvatarFallback>
      {status ? <span className="nx-avatar-status" data-status={status} aria-hidden="true" /> : null}
    </Disc>
  );
}

/** Person or entity avatar disc with image fallback to grapheme-safe initials and optional presence status dot. */
export const Avatar = slotted('Avatar', DefaultAvatar);
