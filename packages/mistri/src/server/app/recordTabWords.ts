/**
 * The words a record's page already says as tabs, against the words its free-form page tabs take
 * (pages/<list view>/[id]/<tab>.page.tsx): an address names one tab by its word, so a page tab that
 * shares one makes one of the two unreachable. Judged against the catalog, because a related list's
 * word is its table's name until the App titles it.
 */
import { tabWord } from '@mistriwork/engine/shared/addressParams.js';
import { HISTORY_TAB, isInferredPage, type PageDef } from '@mistriwork/engine/shared/pageModel.js';
import { tabbedSection } from '@mistriwork/engine/shared/recordReads.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { AppDef } from '../../shared/app.js';
import { appDefaultPage } from '../http/appProjection.js';

/** What a tab word is, by word, on one table's record page (its related lists, section tabs and history), and the
    other way out of a collision: history's word is the platform's, so only the file can move. */
type Held = { said: string; or: string };
function pageWords(page: PageDef, schema: DatabaseSchema): Map<string, Held> {
  const words = new Map<string, Held>();
  const inferred = isInferredPage(page, true);
  for (const section of page.sections) {
    if (section.hidden) continue;
    if (section.kind !== 'history' && section.kind !== 'list') {
      if (section.tab)
        words.set(tabWord(`tab:${section.tab}`), { said: `its section tab "${section.tab}"`, or: ', or rename the section tab' });
      continue;
    }
    if (!tabbedSection(section, true, inferred)) continue;
    const title =
      section.kind === 'history' ? HISTORY_TAB : (section.title ?? tableNamed(schema, section.from ?? '')?.name ?? section.from ?? '');
    words.set(
      tabWord(title),
      section.kind === 'history'
        ? { said: 'its history', or: '' }
        : { said: `its related list "${section.title ?? title}"`, or: ', or give the related list another title' },
    );
  }
  return words;
}

/** The [page-tab] problems of an App's record tabs that take a word their record's page already has. */
export function recordTabCollisions(app: AppDef, pages: readonly PageDef[], schema: DatabaseSchema): string[] {
  const problems: string[] = [];
  const held = new Map<string, Map<string, Held>>();
  for (const view of Object.values(app.views ?? {})) {
    const record = (view as { page?: { record?: { view: string; table: string; tab: string } } }).page?.record;
    if (!record) continue;
    let words = held.get(record.table);
    if (!words) {
      const declared = pages.find((page) => page.base === record.table);
      const page = declared ?? appDefaultPage(app, pages, schema, record.table);
      held.set(record.table, (words = page ? pageWords(page, schema) : new Map()));
    }
    const taken = words.get(record.tab);
    if (taken === undefined) continue;
    problems.push(
      `[page-tab] pages/${record.view}/[id]/${record.tab}.page.tsx: "${record.tab}" is already a tab on ${/^[aeiou]/i.test(record.view) ? 'an' : 'a'} ${record.view} record (${taken.said}). ` +
        `One word, one tab: rename the file (pages/${record.view}/[id]/<another word>.page.tsx)${taken.or}.`,
    );
  }
  return problems;
}

/**
 * The tab words each list view's record can be opened on, by view key: what `useHref().record(view, key, { tab })` is
 * typed by (typegen.ts, `RecordTabs`). A record's own tabs (its related lists, section tabs and history, as the
 * declared page or the inferred one has them) and the page tabs filed under the view. A view over no table, or one
 * whose records have no tabs, says none.
 */
export function recordTabWordsByView(app: AppDef, pages: readonly PageDef[], schema: DatabaseSchema): Record<string, string[]> {
  const byTable = new Map<string, Set<string>>();
  const wordsOf = (table: string) => {
    let words = byTable.get(table);
    if (!words) {
      const page = pages.find((candidate) => candidate.base === table) ?? appDefaultPage(app, pages, schema, table);
      byTable.set(table, (words = new Set(page ? pageWords(page, schema).keys() : [])));
    }
    return words;
  };
  const views = Object.entries(app.views ?? {});
  const tabbed = new Map<string, string[]>();
  for (const [, view] of views) {
    const record = (view as { page?: { record?: { view: string; tab: string } } }).page?.record;
    if (record) tabbed.set(record.view, [...(tabbed.get(record.view) ?? []), record.tab]);
  }
  const out: Record<string, string[]> = {};
  for (const [key, view] of views) {
    const table = (view as { table?: unknown }).table;
    if ('sections' in view || typeof table !== 'string') continue;
    const id = tableNamed(schema, table)?.id ?? table;
    out[key] = [...new Set([...wordsOf(id), ...(tabbed.get(key) ?? [])])].sort();
  }
  return out;
}
