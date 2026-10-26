/**
 * Where a key belongs, for the refusal of one put in the wrong place:
 * `"lines" belongs inside "presentation" (checklist, queue, board,
 * calendar, cards) or inside a dashboard section (board)`. Read from the parsers' own key lists, never a copy of
 * them, so a key a place starts taking is known here the same day. A key
 * most places take (`kind`, `title`) has no one home worth naming and is
 * given none.
 */
import { SECTION_KEYS, THEME_KEYS, VIEW_SECTION_KEYS } from './appModel.js';
import { DASHBOARD_VIEW_KEYS, LIST_VIEW_KEYS, PRESENTATION_KEYS } from './appViews.js';
import { FORM_VIEW_KEYS } from './appForms.js';
import { PAGE_KEYS, PAGE_SECTION_KEYS, STREAM_KEYS } from '@mistriwork/engine/shared/pageConfig.js';
import { RESOURCE_BLOCK_KEYS } from './appResourceBlocks.js';
import { SHELL_KEYS, UI_KEYS } from './appUi.js';
import { DOCUMENT_KEYS } from '@mistriwork/engine/shared/appDocuments.js';

/** More homes than this and the key is a common word, not a misplaced one. */
const MOST_HOMES = 2;
/* The words a place uses for itself. A page without an `id` is not missing
   the App's; it is keyed by one. */
const OWN_WORDS = new Set(['id', 'name', 'kind', 'label', 'title']);

type Keys = readonly string[];

/**
 * The homes for allowKeys (model.ts setKeyHomes), read off the key lists on
 * the first refusal that asks, not as app.ts loads: a parse that refuses
 * nothing never builds them. The root's keys are app.ts's, which this module
 * cannot import.
 */
export function keyHomesFor(root: Keys): (key: string) => readonly string[] {
  let homes: ReadonlyMap<string, readonly string[]> | undefined;
  return (key) => {
    homes ??= homesOf(root);
    const found = homes.get(key) ?? [];
    return found.length > MOST_HOMES || OWN_WORDS.has(key) ? [] : found;
  };
}

function homesOf(root: Keys): ReadonlyMap<string, readonly string[]> {
  const places: Array<[string, Keys | Readonly<Record<string, Keys>>]> = [
    ["at the App's root", root],
    ['inside "ui"', UI_KEYS],
    ['inside "ui.shell"', SHELL_KEYS],
    ['inside "ui.theme"', THEME_KEYS],
    ['inside a resource block', RESOURCE_BLOCK_KEYS],
    ['on a view', { list: LIST_VIEW_KEYS, dashboard: DASHBOARD_VIEW_KEYS, form: FORM_VIEW_KEYS }],
    ['inside "presentation"', PRESENTATION_KEYS],
    ['inside a dashboard section', { ...SECTION_KEYS, view: VIEW_SECTION_KEYS }],
    /* A config page's `connection` scopes that page; a misplaced one in an App
       means the App's own, so the root is the one home said. */
    ['on a page', PAGE_KEYS.filter((key) => key !== 'connection')],
    /* The record's head is drawn where the head is, so what places a section
       is not its; said on its own, "a page section" still means every other. */
    ['inside a page section', Object.fromEntries(Object.entries(PAGE_SECTION_KEYS).filter(([kind]) => kind !== 'header'))],
    ['inside a record header', PAGE_SECTION_KEYS.header],
    ['inside a timeline stream', STREAM_KEYS],
    ['inside a page\'s "document"', DOCUMENT_KEYS],
  ];
  const homes = new Map<string, string[]>();
  for (const [place, keys] of places) {
    const lists = isKeys(keys) ? [['', keys] as const] : Object.entries(keys);
    const kinds = new Map<string, string[]>();
    for (const [kind, list] of lists) {
      for (const key of list) kinds.set(key, [...(kinds.get(key) ?? []), kind]);
    }
    for (const [key, of] of kinds) {
      const every = of.length === lists.length;
      homes.set(key, [...(homes.get(key) ?? []), every ? place : `${place} (${of.join(', ')})`]);
    }
  }
  return homes;
}

const isKeys = (keys: Keys | Readonly<Record<string, Keys>>): keys is Keys => Array.isArray(keys);
