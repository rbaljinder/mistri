/**
 * An avatar: a person's picture, or their initials where there is none.
 * Over Base UI's Avatar, which shows the fallback only while the picture
 * loads or fails, so a slow picture never leaves a blank disc. The
 * initials are the first letters of the first two words of the name
 * ("Ada Lovelace" → "AL", "Ada" → "A"); the disc itself is decorative,
 * and a name that matters is said beside it by the caller, never by the
 * disc's title. Sizes are the house ones: `sm` 28px, `md` 36px, `lg` 48px.
 */
import { Avatar as BaseAvatar } from '@base-ui/react/avatar';

export type AvatarSize = 'sm' | 'md' | 'lg';

export interface AvatarProps {
  /** The person's name, for the fallback initials. */
  name?: string;
  /** The picture's address; absent, the fallback shows at once. */
  src?: string;
  size?: AvatarSize;
  className?: string;
}

const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/* A letter is a grapheme, not a UTF-16 unit: `slice(0, 1)` splits an emoji or an astral letter into a lone surrogate. */
function firstLetter(word: string): string {
  const first = graphemes ? graphemes.segment(word)[Symbol.iterator]().next().value?.segment : Array.from(word)[0];
  return (first ?? '').toUpperCase();
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  if (words.length === 1) return firstLetter(words[0]!);
  return firstLetter(words[0]!) + firstLetter(words[1]!);
}

export function Avatar({ name, src, size = 'md', className }: AvatarProps) {
  return (
    <BaseAvatar.Root className={['ui-avatar', `ui-avatar-${size}`, className].filter(Boolean).join(' ')}>
      {src ? <BaseAvatar.Image className="ui-avatar-image" src={src} alt="" /> : null}
      <BaseAvatar.Fallback className="ui-avatar-fallback" aria-hidden="true">
        {name ? initialsOf(name) : ''}
      </BaseAvatar.Fallback>
    </BaseAvatar.Root>
  );
}
