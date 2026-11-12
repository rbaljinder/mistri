/**
 * The words an engine reader (a page's sections, a call to action, a config file's page) refuses as renamed before 1.0, as
 * data in the shape of the App framework's own tables (packages/mistri/src/shared/renamedWords.ts): what each is now
 * (`to`, absent when nothing takes its place under one key), and what follows "which is now" in the refusal. The
 * framework files these under `RENAMED_TABLES`, so `mistri upgrade` answers each and test/upgrade.test.ts holds it.
 *
 * Kept free of imports so the browser and the CLI can both read it.
 */

/** A word renamed: what it is now (`to`, absent when it is gone or moved), and the sentence the loader says. */
export interface RenamedWord {
  from: string;
  to?: string;
  /** What follows "which is now" in the loader's refusal. */
  now: string;
}

/** The `{ old: sentence }` form `allowKeys` takes as its `refused`, which says "which <sentence>". */
export function refusedAsNow(rows: readonly RenamedWord[]): Readonly<Record<string, string>> {
  return Object.fromEntries(rows.map((row) => [row.from, `is now ${row.now}`]));
}

/* A page section's keys (pageConfig's `refuseRenamed`). The renames (docs/apps.md, "The respelling"): `whose` says the
   direction `path` hid, `about` moves the subject the way `of` only implied, `show` and `sort` are the query language's
   own words. */
export const SECTION_RENAMED: readonly RenamedWord[] = [
  {
    from: 'tint',
    to: 'tone',
    now: '"tone", as a display rule says it: { kind: { internal: \'warn\' } } on the timeline, or one tone on a stream',
  },
  { from: 'order', to: 'newest', now: "\"newest\": 'first' (the default) or 'last', the way a conversation reads" },
  { from: 'edit', to: 'editable', now: '"editable", as a list view says it' },
  {
    from: 'path',
    to: 'whose',
    now: '"whose" — the column on the section\'s table that names this record, e.g. "customer_id" or "invoice_id.customer_id"',
  },
  { from: 'of', to: 'about', now: '"about" — the record this section is about, named by a reference column of the base, e.g. "site_id"' },
  { from: 'paths', to: 'show', now: '"show" — the fields to show, e.g. ["name", "account_id.name"]' },
  { from: 'orderBy', to: 'sort', now: '"sort" — written like the query bar, e.g. "due_on desc, name"' },
];

/* A custom section's reads, on a record page and on a dashboard alike. */
export const CUSTOM_SECTION_RENAMED: readonly RenamedWord[] = [
  {
    from: 'totals',
    to: 'figures',
    now: '"figures": the named aggregate reads its component receives as figures.<name> ("totals" is a list\'s footer of sums)',
  },
];

/* A call to action's emphasis is its `intent`, as a button's is; `kind` names what a thing is. */
export const LINK_INTENT_RENAMED: readonly RenamedWord[] = [
  { from: 'kind', to: 'intent', now: '"intent", as a button says it: "primary" or "secondary"' },
];

/* A config file's page (tablewalk.json): an App's page has no connection to name, so this one never reaches App source. */
export const CONFIG_PAGE_RENAMED: readonly RenamedWord[] = [
  { from: 'onlyOn', to: 'connection', now: '"connection", as the root of the config file says it' },
];
