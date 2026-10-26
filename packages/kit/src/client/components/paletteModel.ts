/**
 * Score `text` against a typed query. Higher is better; 0 means no match.
 *
 * The tiers matter more than the numbers: an exact name beats a prefix beats
 * a substring beats a scattered subsequence. Within a tier, shorter names win
 * — `site` should outrank `site_visit_note` for the query "site", because the
 * shorter one is what someone typing four letters usually meant.
 */
export function score(text: string, query: string): number {
  if (!query) return 1;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();

  if (haystack === needle) return 1000;
  if (haystack.startsWith(needle)) return 800 - haystack.length;
  const at = haystack.indexOf(needle);
  if (at >= 0) return 600 - at - haystack.length / 10;

  /* Subsequence: every character of the query, in order, anywhere. Two things
     are rewarded, and between them they are what make `pol` mean
     `purchase_order_line` rather than `employee_skill`: a match at the start
     of a word (the beginning of the name, or the letter after an underscore),
     because initials are how people abbreviate a snake_case name in their
     head; and runs of adjacent characters, so `porder` prefers
     `purchase_order` over a name where those letters merely occur in order.
     Length is a small penalty rather than a large one. */
  let i = 0;
  let run = 0;
  let points = 0;
  for (let index = 0; index < haystack.length; index += 1) {
    const char = haystack[index];
    if (char !== needle[i]) {
      run = 0;
      continue;
    }
    const boundary = index === 0 || /[^a-z0-9]/.test(haystack[index - 1]);
    run += 1;
    points += run + (boundary ? 12 : 0);
    i += 1;
    if (i === needle.length) break;
  }
  return i === needle.length ? 100 + points - haystack.length / 20 : 0;
}
