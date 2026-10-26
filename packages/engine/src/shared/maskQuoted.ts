/**
 * A copy of the query with the contents of quoted values replaced by spaces.
 *
 * Same length as the input and the quote characters left in place, so an index
 * into this string is an index into the original. That is the whole trick: the
 * scan happens on a version where a value cannot be mistaken for syntax, and
 * every position it reports still points at the text the person typed.
 * Scanning raw text turns a value into syntax: `name contains "show me"` was
 * cut at the value's own word and the filter came back holding
 * `"sort name show id, name` — a string assembled out of the query's own
 * punctuation.
 *
 * One copy, because every scanner has to agree on where a value ends. There
 * were three — the query compiler's, the clause splitter's and the view's
 * path check — and the view's had fallen behind: it ended a value at an
 * escaped quote, and blanked a character outside the Basic Multilingual Plane
 * to one space where it was two code units, so every offset after it was off
 * by one.
 *
 * An unterminated quote blanks to the end, which is the safe direction — the
 * alternative is reading the tail of a half-typed value as clauses while
 * someone is still typing it.
 */
export function maskQuoted(text: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && i + 1 < text.length) {
        // An escaped character cannot end the quote, and both halves of it are
        // inside the value.
        out += '  ';
        i += 1;
        continue;
      }
      out += ch === quote ? ((quote = null), ch) : ' ';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}
