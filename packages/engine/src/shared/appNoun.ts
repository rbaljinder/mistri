/**
 * What a record is called: the resource's `noun` (appModel.ts), said the way
 * each place needs it — New mid-sentence ("New issue"), a split's detail and
 * a page as a heading ("Issue"), a list that names nothing as several
 * ("Issues"). One rule, read by the parsers and the client alike, so a word an
 * author wrote once is never guessed back out of a label.
 */
import { humanName, type AppNoun } from './model.js';

/** The regular plural of a noun an author wrote: "issue" → "issues", "category" → "categories",
    "address" → "addresses". One no rule makes is written out as `{ one, many }`. */
export function pluralOf(one: string): string {
  if (/[^aeiou]y$/i.test(one)) return `${one.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(one)) return `${one}es`;
  return `${one}s`;
}

/** A noun where a heading starts with it: "issue" → "Issue"; "API key" stays. */
export const headingOf = (noun: string): string => noun.charAt(0).toUpperCase() + noun.slice(1);

/**
 * One record's word, mid-sentence: the resource's `noun`, else its table's
 * name as a person says it ("work_order" → "work order"). Never a list's
 * label, which may name a layout ("Task calendar") or a workspace ("Inbox"),
 * and never singularised by rule: a table named in the plural keeps its name
 * until the resource says its noun.
 */
export function recordNoun(noun: AppNoun | undefined, tableName: string): string {
  if (noun) return noun.one;
  const said = humanName(tableName) || tableName;
  return /^[A-Z][a-z]/.test(said) ? said.charAt(0).toLowerCase() + said.slice(1) : said;
}
