/**
 * The pattern behind `contains`, `starts with` and `ends with`.
 *
 * A user typing `contains 50%` means a literal percent sign. Interpolated
 * straight into a LIKE pattern it becomes a wildcard, so the search matches
 * every row and the tool reports a hit on data that does not contain the
 * value — the worst shape of wrong answer, because nothing about it looks
 * like a failure. `a_c` matching `abc` is the same bug, quieter.
 *
 * So the value is escaped and the statement declares an escape character.
 * `#` rather than the conventional backslash: engines differ on backslash escapes
 * inside string literals, which would make the `ESCAPE` clause itself
 * dialect-specific text.
 *
 * Lives in shared/ because the SQL the adapters compile and the SQL the query
 * bar *shows* you have to agree — a preview that promises a wildcard the
 * compiler escapes is a lie in the one place the tool is teaching.
 */
export const LIKE_ESCAPE = '#';

/** The wildcards, plus the escape character itself, which must escape too. */
const SPECIAL = /[#%_]/g;

export function likePattern(value: unknown, op: 'contains' | 'startsWith' | 'endsWith'): string {
  const literal = String(value ?? '').replace(SPECIAL, (ch) => `${LIKE_ESCAPE}${ch}`);
  if (op === 'startsWith') return `${literal}%`;
  if (op === 'endsWith') return `%${literal}`;
  return `%${literal}%`;
}
