/**
 * Who an @ names, as a rich text column or input declares it:
 * `mentions: { from, by, labelColumn }`. `by` is what is stored (the span's
 * `data-id`, which a `notify` rule finds); `labelColumn` is what the list and the
 * mention say — one column, or a record label template of the people's own
 * columns, `'{first_name} {last_name}'` (recordLabel.ts's grammar), so two
 * Morgans read as "Morgan Hughes" and "Morgan Tran".
 *
 * One reading for the browser, which asks, and the server, which checks the
 * declaration: the query an @ sends, and the name a row is said by.
 */
import { columnKind } from './schema.js';
import { quoteValue } from './query.js';
import { isLabelTemplate, parseLabelTemplate } from './recordLabel.js';
import { mentionLabelColumns, type MentionSource } from './mentionLabel.js';
import { MENTION_QUERY_WORDS } from './richText.js';

export type { MentionSource };

/** A person's name as the label says it, from their row: the column, or the template filled and its spaces tidied. */
export function mentionLabelText(source: MentionSource, row: Record<string, unknown>): string {
  const label = source.labelColumn ?? source.by;
  const said = (value: unknown) => (value === null || value === undefined ? '' : String(value));
  if (!isLabelTemplate(label)) return said(row[label]);
  const parsed = parseLabelTemplate(label);
  if ('problem' in parsed) return '';
  return parsed.parts
    .map((part) => ('text' in part ? part.text : said(row[part.path])))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/* A column a word can be looked for in: text the engine compares as text. A UUID is not one — Postgres has no
   ILIKE for it, and nobody types a key's first letters — nor is JSON. */
const searchable = (column: { type?: string } | undefined) =>
  !column?.type || (columnKind(column.type) === 'text' && !/uuid|json/i.test(column.type));

/** The most words of what was typed that are each looked for; the rest narrow nothing. */
const MOST_WORDS = MENTION_QUERY_WORDS;

/**
 * The query an @ sends for what was typed after it: the people whose label's
 * words — any of them, by its start, in any case — or whose `by` value start
 * with each typed word, shown by the label's columns and sorted by them.
 * `columns` are the resource's, where the catalog has them, so a key or a
 * number is not searched as text.
 */
export function mentionQuery(
  source: MentionSource,
  typed: string,
  columns?: readonly { name: string; type?: string }[],
  /** Read beside the label, never looked in: a team's key its link rows name. */
  also: readonly string[] = [],
): string {
  const read = mentionLabelColumns(source.labelColumn ?? source.by);
  const shown = 'problem' in read ? [source.by] : read.columns;
  const column = (name: string) => columns?.find((c) => c.name === name);
  const looked = [...new Set([...shown, source.by])].filter((name) => searchable(column(name)));
  /* A word's start: the value's, or after a space in it ("Mary Ann"). The language spreads the ands over the ors,
     which it caps, so the words looked for are few. */
  const words = typed
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, looked.length > 4 ? 1 : MOST_WORDS);
  const filter = looked.length
    ? words.map(
        (word) =>
          `(${looked.flatMap((name) => [`${name} startswith ${quoteValue(word)}`, `${name} contains ${quoteValue(` ${word}`)}`]).join(' or ')})`,
      )
    : [];
  return [source.from, filter.join(' and '), `show ${[...new Set([source.by, ...shown, ...also])].join(', ')}`, `sort ${shown.join(', ')}`]
    .filter(Boolean)
    .join(' ');
}
