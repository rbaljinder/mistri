/**
 * The page's one timeline composer, reachable from outside it: a custom
 * section's `useComposer().fill(...)` puts a template's words in the box
 * the reader then reads, edits and sends. Filling never sends — the send
 * stays the reader's, through the composer's own commands.
 *
 * One slot, not a list: a page draws at most one conversation, and the
 * latest composer mounted is the one in view.
 */
type ComposerMode = 'reply' | 'note';
type Fill = (text: string, mode?: ComposerMode) => void;

let current: Fill | null = null;

/** The composer takes the slot while it is mounted; the returned function gives it back. */
export function holdComposer(fill: Fill): () => void {
  current = fill;
  return () => {
    if (current === fill) current = null;
  };
}

/** Puts `text` in the composer (and chooses its mode, where the page offers it); false when the page draws none. */
export function fillComposer(text: string, mode?: ComposerMode): boolean {
  if (!current) return false;
  current(text, mode);
  return true;
}
