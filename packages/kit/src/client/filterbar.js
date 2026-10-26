/**
 * Named filter boxes over a table — one grammar, two modes.
 *
 * The boxes are components (components/FilterBoxes.tsx, drawn by the table
 * room); the rules they share —
 * what kind of box a column deserves, which columns get one, how a tail is
 * spelled and unspelled — live here, with the authoring bridge.
 *
 * A box's state is a condition *tail*: `= open`, `= last 30 days`,
 * `is empty`, or '' for none. Tails rather than bare values, because a
 * column's type decides what a condition even looks like — a flag is
 * true/false, a date is a relative phrase or an emptiness, an enum is its
 * vocabulary — and the tail is the part of the language that carries that.
 */
import { findTable, labelColumn, looksLikeDateColumn, quote, state, toast } from './core.js';
import { isFlagColumn } from '@mistriwork/engine/shared/schema.js';

import { conditionTail, squeeze, withCondition } from './conditions.js';
import { joinQuery, splitQuery } from './clauses.js';
import { promptFor } from './prompt.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { slug } from '@mistriwork/engine/shared/slug.js';
import { say } from './copy/workbench/filterbar.js';

/* The condition grammar lives in conditions.js, on the real clause
   splitter — quote-, paren- and between-aware. This module re-exports it
   so the list pages keep one import site. */
export {
  canonicalize,
  conditionTail,
  hasShowClause,
  holdsCondition,
  mentionsColumn,
  ownedTails,
  squeeze,
  stripCondition,
  withCondition,
  WHOLE,
} from './conditions.js';

/** An equality tail for a typed value, through the one quoter the server
    mirrors — an embedded quote written raw terminated the string early and
    could swallow the plumbing clause behind it. */
export const equalsTail = (value) => (value ? `= ${quote(value)}` : '');

/* The exact inverse of quote: strip a wrapping quote pair and unescape what
   quote escaped, so a value round-trips box → text → box unchanged. */
export const unquote = (value) => {
  const t = value.trim();
  if ((t.startsWith('"') && t.endsWith('"') && t.length > 1) || (t.startsWith("'") && t.endsWith("'") && t.length > 1)) {
    return t.slice(1, -1).replace(/\\(["'\\])/g, '$1');
  }
  return t;
};

/** A named integer that is really a yes/no. */
const flaggish = (c) => /^(is|has|can|should|was|allow)_/.test(c.name) && /int|bool/i.test(c.type);

/** What kind of box a column deserves: its type decides, not its position. */
export function boxKind(meta, tableId) {
  if (!meta) return 'text';
  // A record's tags (tagLists.ts): a checklist of its tags, asked with `has`.
  if (meta.type === 'tags') return 'tags';
  if (meta.allowed?.length) return 'enum';
  if (isFlagColumn(meta) || flaggish(meta)) return 'flag';
  if (looksLikeDateColumn(meta)) return 'date';
  /* A whole single-column reference whose target has a label column gets a
     typeahead: the grid beside the box shows "Nia Andersen", and a box that
     demanded her id was the review's "quietly zero rows" finding. A member
     of a composite key is half a hop and stays a plain box. */
  /* Not over an API: its filter takes the whole key, and the picker would ask
     the target for names by `contains`, which an API refuses. */
  if (meta.references && tableId && !findTable(tableId)?.filterable) {
    const whole = (state.schema?.foreignKeys ?? []).some(
      (fk) => fk.from.table === tableId && fk.from.columns.length === 1 && fk.from.columns[0] === meta.name,
    );
    const target = whole && findTable(meta.references.table);
    if (target && labelColumn(target)) return 'ref';
  }
  return 'text';
}

/**
 * Which columns get boxes when nobody chose: the typed ones first — enum
 * vocabularies, flags, dates are what an operational list is filtered by —
 * topped up with leading columns so a table of plain ids and numbers still
 * gets named boxes rather than nothing.
 *
 * A source that can filter only some columns (an API, whose catalog says
 * which in `filterable`) gets boxes for those alone: a box the source would
 * refuse is a control that lies.
 *
 * @param {{ id?: string, filterable?: string[], columns: Array<{name: string, type: string, primaryKey?: boolean, allowed?: string[]}> }} table
 */
export function deriveFilterNames(table) {
  const candidates = table.columns.filter((c) => !c.primaryKey && (!table.filterable || table.filterable.includes(c.name)));
  const typed = candidates.filter((c) => boxKind(c, table.id) !== 'text').map((c) => c.name);
  const rest = candidates.filter((c) => !typed.includes(c.name)).map((c) => c.name);
  /* Up to four typed boxes — every enum, flag and date earns its place —
     and leading columns top the row up to three so a table of plain ids
     still gets named boxes rather than nothing. */
  const names = typed.slice(0, 4);
  for (const name of rest) {
    if (names.length >= 3) break;
    names.push(name);
  }
  return names;
}

/* The relative windows people actually ask operational questions in. The
   phrases are the language's own — unquoted on purpose. */
export const DATE_OPTIONS = [
  ['today', '= today'],
  ['last 7 days', '= last 7 days'],
  ['last 30 days', '= last 30 days'],
  ['this month', '= this month'],
  ['this year', '= this year'],
  ['next 30 days', '= next 30 days'],
  ['empty', 'is empty'],
  ['not empty', 'is not empty'],
];

/**
 * The list on screen, spelled as an App list view — the authoring bridge:
 * refine any list in the workbench, copy, paste into an App.
 *
 * The pieces map exactly: the show clause becomes the view's `show`, the
 * conditions and sort become a tab beside "All", and the table goes by name
 * so the view travels between connections the way a manifest should. A
 * column the grammar renamed with `as` keeps its words as the resource's
 * caption (`resources.<table>.labels`), which is where an App says what a
 * column is called. The same contract as the page builder's Copy layout:
 * what this emits, the parser reads.
 * @param {{ table: string, query?: string }} entry
 * @param {string} tableName
 */
export function listViewFragment(entry, tableName) {
  const parts = splitQuery(squeeze(entry.query ?? ''));
  const show = (parts.show ?? '').replace(/^show\s+/i, '');
  const query = squeeze(joinQuery({ table: '', filter: parts.filter }));
  const sort = (parts.sort ?? '').replace(/^(sort|order\s+by)\s+/i, '').trim();
  const columns = [];
  /** @type {Record<string, string>} */
  const labels = {};
  for (const piece of show
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const m = /^(.*?)\s+as\s+(.+)$/i.exec(piece);
    const column = m ? m[1].trim() : piece;
    columns.push(column);
    if (m) labels[column] = m[2].trim();
  }
  /* The question is a segment the resource declares and the list's first tab names, All after it, as the
     scaffold writes one (a tab says no query of its own); a sort alone is the list's own. */
  const label = say('filtered');
  const segment = query ? { filtered: label === humanName('filtered') ? query : { query, label } } : undefined;
  const view = {
    kind: 'list',
    from: tableName,
    ...(columns.length ? { show: columns } : {}),
    ...(segment ? { tabs: [sort ? { segment: 'filtered', sort } : 'filtered', { label: say('common.all') }] } : sort ? { sort } : {}),
  };
  const resource = { ...(Object.keys(labels).length ? { labels } : {}), ...(segment ? { segments: segment } : {}) };
  return {
    views: { [slug(tableName, 'list').slice(0, 64)]: view },
    /* A view shows a declared resource, so the resource comes with it. */
    resources: { [tableName]: resource },
  };
}

export async function copyListView(entry) {
  const table = findTable(entry.table);
  const text = JSON.stringify(listViewFragment(entry, table?.name ?? entry.table), null, 2);
  try {
    await navigator.clipboard.writeText(text);
    toast(say('copiedPasteTheView'), 'ok');
  } catch {
    /* Clipboard access can be refused; the text is the point. */
    await promptFor({ title: say('copyThisIntoYourApp'), label: say('listView'), value: text, multiline: true });
  }
}
