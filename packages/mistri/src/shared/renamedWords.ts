/**
 * The words renamed before 1.0 that an App's source can still carry, as data: each load-time reader refuses them with
 * the word that replaced them, and `mistri upgrade` (server/cli/upgradeRenames.ts) imports the same rows to rewrite or
 * refuse them. One table means a rename cannot reach `check` without reaching `upgrade`; test/upgrade.test.ts holds
 * that every row here is handled there.
 *
 * Kept free of imports so the browser's block reader (client/components/sdk/blocks.tsx) and the CLI can both read it.
 */

/** A word renamed: what it is now (`to`, absent when it is gone or moved), and the sentence the loader says. */
interface RenamedWord {
  from: string;
  to?: string;
  /** What follows "which is now" in the loader's refusal. */
  now: string;
}

/** The loader's `{ old: sentence }` form of a table. */
export function renamedMessages(rows: readonly RenamedWord[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.from, row.now]));
}

/* The page file: `definePage({ … })` and its `nav`. */
export const PAGE_RENAMED: readonly RenamedWord[] = [
  { from: 'title', to: 'label', now: '"label", as a view says it' },
  { from: 'path', now: "the file's name: pages/pick-walk.page.tsx is the page at /pick-walk, so leave it out" },
];
export const PAGE_NAV_RENAMED: readonly RenamedWord[] = [
  { from: 'icon', now: 'the page\'s own "icon", beside its "label"' },
  { from: 'order', to: 'position', now: 'nav.position' },
];

/* A list view, and a dashboard view (`allowKeys`' `refused`). */
export const LIST_VIEW_RENAMED: readonly RenamedWord[] = [
  { from: 'table', to: 'from', now: 'is now "from": the resource whose rows the list shows' },
  { from: 'keys', to: 'shortcuts', now: 'is now "shortcuts": a split\'s single keys for the picked record\'s actions' },
];
export const DASHBOARD_VIEW_RENAMED: readonly RenamedWord[] = [
  { from: 'table', to: 'from', now: 'is now "from": the resource every section that names none reads' },
  { from: 'layout', to: 'areas', now: 'is now "areas": the rows of area names its sections stand in ("layout" is a page\'s archetype)' },
  { from: 'refresh', now: 'is gone: a dashboard follows changes as they happen and re-reads what depends on the time each minute' },
];

/* A calendar's backdrop span. */
export const BACKDROP_RENAMED: readonly RenamedWord[] = [
  { from: 'resource', to: 'from', now: 'is now "from", and the date columns a span runs between are "start" and "end"' },
  { from: 'to', to: 'end', now: 'is now "end"' },
  { from: 'label', to: 'labelColumn', now: 'is now "labelColumn": the column whose value names a span' },
];

/* Captioned values are `properties` (a fields section's presentation of that name); `facts` is the dotted line only. */
export const QUEUE_RENAMED: readonly RenamedWord[] = [
  {
    from: 'facts',
    to: 'properties',
    now: 'is now "properties": the captioned values under the title (a dotted line is a card\'s "facts")',
  },
];
export const CARDS_RENAMED: readonly RenamedWord[] = [
  { from: 'lines', to: 'properties', now: 'is now "properties": the captioned values under the title ("facts" stays the dotted line)' },
];

/* A dashboard section's key renamed within its own kind (`metric(title, from, { to })`, `embed(view, { listTab })`). */
export const METRIC_SECTION_RENAMED: readonly RenamedWord[] = [
  { from: 'view', to: 'to', now: '"to": metric(title, from, { to: \'overdue_list\' }) opens the list view it names' },
];
export const CUSTOM_SECTION_RENAMED: readonly RenamedWord[] = [
  {
    from: 'totals',
    to: 'figures',
    now: '"figures": the named aggregate reads its component receives as figures.<name> ("totals" is a list\'s footer of sums)',
  },
];
export const VIEW_SECTION_RENAMED: readonly RenamedWord[] = [
  { from: 'tab', to: 'listTab', now: 'is now "listTab": the list tab\'s address word' },
];

/* A tenant's own branding row: `fromRecord(table, { fallback, fields })`. */
export const BRANDING_RENAMED: readonly RenamedWord[] = [
  { from: 'base', to: 'preset', now: 'preset' },
  { from: 'brandColor', to: 'accent', now: 'accent' },
];

/* A kit block's prop (`<Rows resource="…">`). */
export const BLOCK_RENAMED: readonly RenamedWord[] = [{ from: 'resource', to: 'from', now: 'from' }];

/**
 * A timeline stream's words, from the CHANGELOG (no loader reads them as a table): `stream(from, whose, at, text,
 * { badge })`. The positional one has no key to rename, so what these two need is a reader.
 */
const STREAM_RENAMED: readonly RenamedWord[] = [
  { from: 'show', to: 'text', now: 'text' },
  { from: 'detail', to: 'badge', now: 'badge' },
];

/** Every table above by the name `mistri upgrade` files its rows under, for the test that holds none is dropped. */
export const RENAMED_TABLES: Readonly<Record<string, readonly RenamedWord[]>> = {
  page: PAGE_RENAMED,
  'page.nav': PAGE_NAV_RENAMED,
  list: LIST_VIEW_RENAMED,
  dashboard: DASHBOARD_VIEW_RENAMED,
  backdrop: BACKDROP_RENAMED,
  queue: QUEUE_RENAMED,
  cards: CARDS_RENAMED,
  metric: METRIC_SECTION_RENAMED,
  custom: CUSTOM_SECTION_RENAMED,
  view: VIEW_SECTION_RENAMED,
  branding: BRANDING_RENAMED,
  block: BLOCK_RENAMED,
  stream: STREAM_RENAMED,
};
