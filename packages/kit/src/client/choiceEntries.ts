/**
 * The App's choosers, as a list can reach them. Below the width the bar holds one, a chooser leaves the bar and is an
 * item of the account menu, which opens the same dialog; a list narrowed by a choice (`chosen.site`) opens it from a chip.
 * Each mounted chooser says here what it shows and how to open it. Kept in the kit, which draws the chip, and read by
 * the shell's account menu; the chooser itself is the shell's (ChoiceControl.tsx).
 */
export interface ChoiceEntry {
  /** The choice's name in `choose` (`site`), so a chip on a list it filters can open this chooser. */
  readonly choice: string;
  /** "Site:", the choice's name as the menu says it. */
  readonly word: string;
  /** The picked row's label, or the chooser's "Choose site" where nothing is picked. */
  readonly name: string;
  /** The picked row's label; absent where nothing is picked (or the pick is not yet read). */
  readonly picked?: string;
  readonly open: () => void;
}

let entries: readonly ChoiceEntry[] = [];
const entryListeners = new Set<() => void>();

/** Said by a chooser while it is mounted; undefined takes back the one it replaces, and only that one. */
export function setChoiceEntry(next: ChoiceEntry | undefined, replacing?: ChoiceEntry): void {
  const kept = replacing ? entries.filter((entry) => entry !== replacing) : entries;
  if (next === undefined && kept.length === entries.length) return;
  entries = next ? [...kept, next] : kept;
  for (const listener of [...entryListeners]) listener();
}

export const choiceEntries = (): readonly ChoiceEntry[] => entries;

export function subscribeChoiceEntries(listener: () => void): () => void {
  entryListeners.add(listener);
  return () => {
    entryListeners.delete(listener);
  };
}
