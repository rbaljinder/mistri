/**
 * What a server-searched list may offer while its answer is on the way.
 *
 * The record picker, a command's reference field and the palette's record
 * hits all ask the server a pause after typing, so for a beat — the pause,
 * then the request — the rows on screen answer earlier text (on first open,
 * the empty search). The first row is lit as you type, and offered whole it
 * is what a quick Enter or click takes: a record the box never named (an
 * empty search's first issue took a new comment on CI). So until the answer
 * for what the box says lands, a list keeps only the rows whose name
 * contains that text, by the same case-blind `contains` the search runs.
 * Those stay under the pointer — the last answer is not blanked, so nothing
 * flickers — and nothing else can be chosen. Folding case here can only be
 * as strict as the server or stricter (an accent-blind collation finds more),
 * so a stale row is hidden early, never offered wrongly.
 *
 * `answered` also says whether "nothing matches" may be said yet: an empty
 * filtered list is not the server's answer.
 */
export function offeredChoices<T>({
  typed,
  asked,
  placeholder = false,
  rows,
  label,
}: {
  /** What the box says now. */
  typed: string;
  /** The text the rows on screen were asked for. */
  asked: string;
  /** Rows kept from an earlier question (Query's `isPlaceholderData`): whatever `asked` is, they answer something else. */
  placeholder?: boolean;
  rows: T[] | undefined;
  label: (row: T) => string;
}): { choices: T[]; answered: boolean } {
  const needle = typed.trim();
  const answered = asked === needle && !placeholder;
  if (answered) return { choices: rows ?? [], answered };
  const folded = needle.toLowerCase();
  return { choices: (rows ?? []).filter((row) => label(row).toLowerCase().includes(folded)), answered };
}
