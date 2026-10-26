/**
 * A page's archetype: `page(…, { layout })`, the arrangement of its regions.
 *
 * Every record page used to be one skeleton, a main column with an aside a
 * third of its width beside it, and a look could recolour that skeleton but
 * never move it. Three kinds of record read badly in it: one worked by
 * talking (the thread was pushed down by the lists above it), one chosen from
 * photos (on a phone the asking rent and its call to action fell to the
 * bottom, after every list) and one that is mostly words (a full-width column
 * with no measure). Each is a word here. A layout decides which regions a
 * page has, what each may hold and the DOM order; it never sets a colour, a
 * rule or a type size, which stay the looks' recipes.
 *
 * The words are refused where they cannot hold: what a layout cannot place is
 * said by the section and with the fix, so a page never draws an arrangement
 * nobody asked for.
 *
 * A page that names none is given the one its sections already make
 * (chooseLayout): a gallery first is a showcase, a timeline the main column
 * ends with a conversation, a page of the record's own words an article, and
 * anything else the record's skeleton, `'record'`. Chosen when the App is
 * read, from what the page declares, never from a row: a page keeps one shape
 * for every record and from its first frame. Writing a word is still worth
 * it: a written layout refuses a section it cannot place, where a chosen one
 * falls back to the record; `'record'` is how a page that would be chosen as
 * something else keeps the skeleton.
 */
import type { PageDef, PageSection } from './pageModel.js';
import { isLongText, MAX_PROPERTIES } from './pageAnatomy.js';

/** The archetypes a page is drawn in. The record's own skeleton draws no `data-layout`. */
export type PageLayoutName = 'conversation' | 'showcase' | 'article';
const PAGE_LAYOUTS: readonly PageLayoutName[] = ['conversation', 'showcase', 'article'];
/** What a page may say: an archetype, or `'record'`, the skeleton, kept where another would be chosen. */
export type PageLayoutWord = 'record' | PageLayoutName;
export const PAGE_LAYOUT_WORDS: readonly PageLayoutWord[] = ['record', ...PAGE_LAYOUTS];

/* A showcase's panel stands beside the photos and ends with them: more than three sections there grew the band
   past the gallery's height at a desk, and the body under it stood a screen down. */
const PANEL_MOST = 3;

const WORDS =
  "'record' (the record's own: its lists beside a rail), 'conversation' (a thread with its facts beside it), 'showcase' (photos with the price beside them) or 'article' (one column at a reading measure)";

/** `layout`, read: one of the words, else refused with all four. */
export function parsePageLayout(raw: unknown, at: string): PageLayoutWord {
  if (PAGE_LAYOUT_WORDS.includes(raw as PageLayoutWord)) return raw as PageLayoutWord;
  /* Renamed before 1.0: "listing" is what a list view is called everywhere else in an App. */
  if (raw === 'listing')
    throw new Error(`[page-layout] ${at} has "layout": "listing", which is now "showcase": photos with the price beside them.`);
  throw new Error(
    `[page-layout] ${at} has "layout": ${JSON.stringify(raw)}. A page's layout is ${WORDS}; leave it out for the one its sections make.`,
  );
}

/** The layout a renderer draws: an archetype, or none for the record's own. */
export function drawnLayout(page: { layout?: string }): PageLayoutName | undefined {
  return PAGE_LAYOUTS.find((word) => word === page.layout);
}

/* Structural, so the client's own page shapes (components/pageModel.ts) are read by the same rule. */
type Placed = {
  kind: string;
  region?: string;
  presentation?: unknown;
  hidden?: boolean;
};
const isHeader = (section: Placed) => section.kind === 'fields' && section.presentation === 'header';
const inMain = (section: Placed) => (section.region ?? 'main') === 'main' && !isHeader(section) && !section.hidden;
const inAside = (section: Placed) => section.region === 'aside' && !section.hidden;

/**
 * A showcase's lead: the index of its first main section, the photos, which stand beside the panel. The head
 * is drawn above it, so a header() is not the first.
 */
export function showcaseIndex(page: { layout?: string; sections: readonly Placed[] }): number | undefined {
  if (page.layout !== 'showcase') return undefined;
  const index = page.sections.findIndex(inMain);
  return index < 0 ? undefined : index;
}

/** A section as a refusal names it: its kind and, where it has one, its title. */
function named(section: PageSection): string {
  const title = 'title' in section && typeof section.title === 'string' ? ` "${section.title}"` : '';
  if (section.kind === 'fields') {
    const kind = section.presentation === 'card' || section.presentation === 'headline' ? section.presentation : 'fields';
    return `a ${kind}${title}`;
  }
  if (section.kind === 'list') return `${section.view !== undefined ? 'an embed' : 'a related list'}${title}`;
  return `a ${section.kind}${title}`;
}

/**
 * Judge a parsed App page against its layout, and place what the layout places unasked. `at` names the page as
 * the App's other page refusals do. Mutates `page`: under `conversation` a headline that names no region stands
 * in the aside, as a card and the history already do; under `showcase` and `article` no default rail is drawn.
 */
export function applyPageLayout(page: PageDef, at: string): void {
  const layout = drawnLayout(page);
  if (!layout) return;
  const each = page.sections.map((section, index) => ({
    section,
    index,
    where: `${at}, section ${index + 1}`,
  }));

  if (layout === 'conversation') {
    const say = (text: string) => new Error(`[layout-conversation] ${text}`);
    const fix = "A conversation is its one timeline, last in main: put the rest in region: 'aside'";
    for (const { section } of each) {
      if (section.kind === 'fields' && section.presentation === 'headline' && section.region === undefined) section.region = 'aside';
    }
    const timelines = each.filter(({ section }) => section.kind === 'timeline' && !section.hidden);
    if (!timelines.length)
      throw say(
        `${at} is a conversation with no timeline. ${fix}, and add timeline('Conversation', [stream(…)]) to the main column, or leave out "layout".`,
      );
    if (timelines.length > 1)
      throw say(
        `${at} is a conversation with ${timelines.length} timelines. A conversation is its one timeline: say every stream in one timeline('…', [stream(…), stream(…)]).`,
      );
    const thread = timelines[0];
    if (thread.section.region === 'aside')
      throw say(`${thread.where} puts the conversation's timeline in the aside. ${fix}; leave its region out.`);
    for (const { section, where } of each) {
      if (!inMain(section)) continue;
      if (section.tab !== undefined) {
        throw say(
          `${where} names the tab "${section.tab}" in the main column. A thread is not one tab among others: leave out "tab", or give it to a section in region: 'aside'.`,
        );
      }
      if (section.kind === 'list' || section.kind === 'metric' || section.kind === 'chart' || section.kind === 'breakdown') {
        throw say(
          `${where} is ${named(section)} in the main column. ${fix}: ${section.kind === 'list' ? `related(${typeof section.title === 'string' ? `'${section.title}'` : '…'}, …, { region: 'aside' })` : "{ region: 'aside' }"}.`,
        );
      }
    }
    const after = each.find(({ section, index }) => index > thread.index && inMain(section));
    if (after) {
      throw say(
        `${after.where} (${named(after.section)}) stands after the timeline in the main column. ${fix}, or above the timeline, so the composer ends the thread.`,
      );
    }
    return;
  }

  if (layout === 'showcase') {
    const say = (text: string) => new Error(`[layout-showcase] ${text}`);
    const fix =
      "A showcase opens with its photos: related('Photos', …, { presentation: 'gallery' }) first, its price headline in the aside";
    if (page.aside === false)
      throw say(`${at} is a showcase that says aside: false. A showcase is its panel beside the photos: leave out "layout" instead.`);
    const first = each.find(({ section }) => inMain(section));
    if (!first || first.section.kind !== 'list' || first.section.presentation !== 'gallery') {
      throw say(
        `${first ? `${first.where} is ${named(first.section)}, first in the main column` : `${at} has nothing in its main column`}. ${fix}.`,
      );
    }
    const panel = each.filter(({ section }) => inAside(section));
    if (!panel.length) throw say(`${at} is a showcase with nothing in the aside. ${fix}: headline('…', { region: 'aside' }).`);
    if (panel.length > PANEL_MOST) {
      throw say(
        `${at} has ${panel.length} sections in the aside, and a showcase's panel holds 1 to ${PANEL_MOST} beside the photos: move the rest into the main column, where they stand under the photos at full width.`,
      );
    }
    const tabbed = panel.find(({ section }) => section.tab !== undefined);
    if (tabbed)
      throw say(
        `${tabbed.where} names the tab "${tabbed.section.tab}" in the aside. A showcase's panel stands beside the photos whole: leave out "tab".`,
      );
    // The panel is a price, not a property rail: the author's own fields say what a buyer reads.
    delete page.defaultAside;
    return;
  }

  // article
  const say = (text: string) => new Error(`[layout-article] ${text}`);
  if (page.aside === false) throw say(`${at} is an article that says aside: false. An article has no aside already: remove "aside".`);
  for (const { section, where } of each) {
    if (section.region === 'aside') {
      const call =
        section.kind === 'fields' && section.presentation === 'card' && typeof section.title === 'string'
          ? `card('${section.title}', …)`
          : named(section);
      throw say(
        `${where} (${named(section)}) stands in the aside. An article has no aside: move ${call} into the column with region: 'main', or leave out "layout".`,
      );
    }
    if (section.width === 'third' || section.width === 'two-thirds') {
      throw say(
        `${where} has width: '${section.width}'. An article is one column at a reading measure, where a third is too narrow for a value: use 'half' or leave "width" out.`,
      );
    }
  }
  delete page.defaultAside;
}

/** A refusal as a reason: its text without the code, which names a word the author did not write. */
function refusal(page: PageDef, layout: PageLayoutName): string | undefined {
  // The rule's own mutations (a headline beside the thread, no default rail) land on the copy.
  const trial: PageDef = {
    ...page,
    layout,
    sections: page.sections.map((section) => ({ ...section }) as PageSection),
  };
  try {
    applyPageLayout(trial, 'the page');
    return undefined;
  } catch (error) {
    return (error as Error).message.replace(/^\[[a-z-]+\]\s*/, '');
  }
}

const quoted = (section: PageSection) => ('title' in section && typeof section.title === 'string' ? ` "${section.title}"` : '');

/**
 * The layout a page's sections already make, where it names none. Each archetype is chosen by the section it is
 * named for — a showcase by the photos it opens with, a conversation by the timeline it ends with, an article by
 * the record's long text with nothing but its facts and notes around it — and only where applyPageLayout takes the
 * page as written, so a chosen layout is never a refusal. The first that holds wins: photos lead the page they open,
 * a thread ends one. Read from the declarations alone, never a row, so every record of a page has one shape from the
 * first frame. Anything else is the record's own skeleton. The why is what `mistri check --defaults` says.
 */
export function chooseLayout(page: PageDef): { layout: PageLayoutWord; why: string } {
  const main = page.sections.filter(inMain);
  const missed: string[] = [];
  const first = main[0];
  if (first?.kind === 'list' && first.presentation === 'gallery') {
    const no = refusal(page, 'showcase');
    if (!no)
      return {
        layout: 'showcase',
        why: `it opens with the gallery${quoted(first)}, with a panel beside it`,
      };
    missed.push(`it opens with a gallery, but a showcase would refuse it: ${no}`);
  } else missed.push('it opens with no gallery');
  const thread = main.find((section) => section.kind === 'timeline');
  if (thread) {
    const no = refusal(page, 'conversation');
    if (!no)
      return {
        layout: 'conversation',
        why: `its main column ends with the timeline${quoted(thread)}, and no list stands in it`,
      };
    missed.push(`it has a timeline, but a conversation would refuse it: ${no}`);
  } else missed.push('it has no timeline');
  const shown = page.sections.filter((section) => !section.hidden);
  const words = shown.every(
    (section) =>
      section.kind === 'note' || (section.kind === 'fields' && section.presentation !== 'card' && section.presentation !== 'headline'),
  );
  // The record's own long text, read in the column; a header's facts are a line under its name, never the words.
  const long = shown.flatMap((section) =>
    section.kind === 'fields' && section.presentation !== 'header'
      ? (section.paths ?? []).filter((path) => !path.includes('.') && isLongText(path))
      : [],
  );
  const facts = [...new Set(shown.flatMap((section) => (section.kind === 'fields' ? (section.paths ?? []) : [])))].filter(
    (path) => !long.includes(path),
  ).length;
  if (!words) missed.push('it holds more than fields and notes');
  else if (!long.length) missed.push('it names no long text, a description or a body');
  // As many facts as a rail holds: more is a record with a note on it, which keeps its rail.
  else if (facts > MAX_PROPERTIES) missed.push(`it has ${facts} facts beside its words, more than a rail's ${MAX_PROPERTIES}`);
  else {
    const no = refusal(page, 'article');
    if (!no)
      return {
        layout: 'article',
        why: `it is the record's words, ${long.map((path) => `"${path}"`).join(' and ')}, with ${facts} fact${facts === 1 ? '' : 's'} and nothing else`,
      };
    missed.push(`it is the record's words, but an article would refuse it: ${no}`);
  }
  return { layout: 'record', why: missed.join('; ') };
}
