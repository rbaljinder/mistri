/*
 * Reading pages from configuration: the `pages` section of a tablewalk.json
 * and an App's page bodies. A malformed page throws with the page and, where
 * there is one, the fix; nothing is skipped.
 */
import { isMessageRef, parseCaption } from './appMessages.js';
import { parseTableSizing } from './tableSizing.js';
import { parseRelatedCreate } from './relatedCreate.js';
import { parseListEmpty } from './listEmpty.js';
import { CHART_SHAPES, FIGURE_FORMATS, FIGURE_FORMAT_WORDS, allowKeys, humanName } from './model.js';
import { headingOf } from './appNoun.js';
import { CARDS_MAX_LINES, parseCards, parseFacts, type AppCardsList } from './appCards.js';
import { parseIcon } from './appIcons.js';
import { slug } from './slug.js';
import { parsePageLayout } from './pageLayouts.js';
import { parseSortText } from './sortText.js';
import { componentPropValues, parseComponentDecl, parsePageReads, parsePageTotals, parseRecordFields } from './appComponents.js';
import { parseAppLinkAction, parseAppTarget, type AppLinkAction } from './appLinks.js';
import {
  type PageChart,
  type SectionWidth,
  WIDTHS,
  type SectionOffset,
  OFFSETS,
  type FieldColumns,
  type SectionRegion,
  SECTION_REGIONS,
  FIELD_COLUMNS,
  type PageMetric,
  type PageList,
  MAX_STREAMS,
  MAX_HISTORY_LIMIT,
  type TimelineComposer,
  type TimelineTone,
  type PageSection,
  type PageDef,
  MAX_SECTIONS,
  MAX_PAGE_SECTIONS,
  screenSections,
  type PageHeadlineAction,
  type PageSimilar,
  type PageGroup,
  GROUPS_MOST,
  GROUP_ROWS_MOST,
} from './pageModel.js';

/* ---------- config ---------- */

/**
 * Read the `pages` section of a tablewalk.json.
 *
 * Throws on a malformed file rather than skipping the bad entry: a page that
 * silently did not appear is a bug report that starts "I definitely wrote
 * it". Everything a config file can get wrong is named with the page it is
 * in and, where there is one, the fix.
 */
export function parsePagesConfig(raw: unknown, where: string): PageDef[] {
  const pages = (raw as { pages?: unknown })?.pages;
  if (pages === undefined) return [];
  if (!Array.isArray(pages)) throw new Error(`${where}: "pages" must be an array.`);

  const seen = new Set<string>();
  return pages.map((entry, i) => {
    const at = `${where}: page ${i + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${at} is not an object.`);
    }
    const p = entry as Record<string, unknown>;
    const said = typeof p.label === 'string' && p.label.trim() ? ` ("${p.label.trim()}")` : '';
    if (p.id !== undefined && (typeof p.id !== 'string' || !p.id.trim())) {
      throw new Error(`${at}${said} has an "id" that is not a non-empty string.`);
    }
    const named = p.label !== undefined ? parseCaption(p.label, `${at}.label`) : typeof p.base === 'string' ? humanName(p.base.trim()) : '';
    const id = p.id === undefined ? `config-${slug(named, 'page')}` : String(p.id);
    const page = parsePageBody(p, at, id, true);
    /* An embed and a note's action name an App's views; a tablewalk.json has none to name. */
    for (const [n, section] of page.sections.entries()) {
      if (section.kind === 'list' && section.view !== undefined) {
        throw new Error(
          `${at} ("${page.name}") section ${n + 1} embeds the view "${section.view}", and a config file has no views: write a related list ({ kind: "list", from, whose }) instead.`,
        );
      }
      if (section.kind === 'note' && section.action) {
        throw new Error(
          `${at} ("${page.name}") section ${n + 1} is a note whose "action" needs an App, and a config file has no views to open. Remove "action".`,
        );
      }
    }
    if (seen.has(id)) throw new Error(`${at} ("${page.name}") repeats the id "${id}".`);
    seen.add(id);
    return page;
  });
}

/* Spellings renamed before 1.0, refused with the word that replaced them (allowKeys' `refused`). */
/* A call to action's emphasis is its `intent`, as a button's is; `kind` names what a thing is. */
const CUSTOM_RENAMED = {
  totals: 'is now "figures": the named aggregate reads its component receives as figures.<name> ("totals" is a list\'s footer of sums)',
} as const;
const INTENT_RENAMED = { kind: 'is now "intent", as a button says it: "primary" or "secondary"' } as const;
const PAGE_RENAMED = { onlyOn: 'is now "connection", as the root of the config file says it' } as const;
/** The keys a page takes. A tablewalk.json page also names its `id`; an App page is keyed by it. */
export const PAGE_KEYS = ['label', 'base', 'connection', 'listTabs', 'empty', 'sections', 'aside', 'layout'] as const;
/** An App page has no `connection`: the App names its one connection, and a page scoped to another would never show. Nor a `label`: it is called its resource's `noun`. */
export const APP_PAGE_KEYS = PAGE_KEYS.filter((key) => key !== 'connection' && key !== 'label');
/* `aside` and `layout` are an App page's alone: the Workbench's pages draw what they say, in the record's one skeleton. */
const WORKBENCH_PAGE_KEYS = PAGE_KEYS.filter((key) => key !== 'aside' && key !== 'layout');
const SECTION_COMMON = ['kind', 'title', 'region', 'tab', 'width', 'offsetLeft', 'offsetRight', 'hidden', 'when'] as const;
/** A tab's name is a word or two across the strip, not a sentence. */
const MAX_TAB_NAME = 40;
/** The keys each page section kind takes. Anything else is refused by name. A `segment` is read before the
    section is (appSegments.ts unfoldSegments), as its word in `query`. */
/* `view` is an authored kind with no section of its own: `embed(view, { whose })`
   is read into a related list that remembers the view (PageList.view). */
export const PAGE_SECTION_KEYS: Record<PageSection['kind'] | 'view' | 'header' | 'current' | 'card' | 'headline', readonly string[]> = {
  fields: [...SECTION_COMMON, 'show', 'columns', 'names', 'presentation', 'editable'],
  /* The record a reference names, in a box of its own: the first shown field is its title, the rest its facts. */
  card: [...SECTION_COMMON, 'show'],
  /* A figure with its facts, its earlier value, its estimate and the calls to action beside it. */
  headline: [...SECTION_COMMON, 'show', 'links', 'subfigure', 'was', 'note'],
  /* The record's head: drawn where the head is, so nothing that would place it elsewhere. */
  header: ['kind', 'status', 'facts', 'primary', 'destructive', 'actions'],
  /* The one current related row as a card: nothing to page, sum or add under it. */
  current: ['kind', 'title', 'region', 'tab', 'width', 'when', 'from', 'whose', 'show', 'query', 'sort', 'empty'],
  timeline: [...SECTION_COMMON, 'streams', 'limit', 'create', 'newest', 'composer', 'tone', 'compact', 'side'],
  history: [...SECTION_COMMON, 'limit'],
  flows: [...SECTION_COMMON],
  diagram: [...SECTION_COMMON],
  custom: [...SECTION_COMMON, 'component', 'record', 'rows', 'figures', 'props'],
  metric: [...SECTION_COMMON, 'from', 'whose', 'about', 'measure', 'query', 'segment', 'format', 'unit'],
  breakdown: [...SECTION_COMMON, 'from', 'whose', 'about', 'by', 'measure', 'query', 'segment', 'limit', 'format', 'unit'],
  chart: [
    ...SECTION_COMMON,
    'from',
    'whose',
    'about',
    'by',
    'measure',
    'shape',
    'sort',
    'query',
    'segment',
    'limit',
    'height',
    'target',
    'format',
    'unit',
  ],
  note: [...SECTION_COMMON, 'text', 'icon', 'action', 'variant'],
  view: [...SECTION_COMMON, 'view', 'whose', 'about', 'limit'],
  list: [
    ...SECTION_COMMON,
    'from',
    'whose',
    'show',
    'query',
    'segment',
    'limit',
    'sort',
    'create',
    'empty',
    'sizing',
    'presentation',
    'totals',
    'same',
    'near',
    'rowActions',
    'actions',
    'group',
  ],
};
export const STREAM_KEYS = ['from', 'whose', 'at', 'show', 'detail', 'author', 'query', 'about', 'side', 'tone', 'compact'] as const;

/**
 * One page body: a tablewalk.json page, whose `id` is its own or derives
 * from the name, or an App page, whose id is its key. The body is the same
 * either way, so the page builder, the scaffold and mistri check emit one
 * shape. Every key is checked: an unknown one is refused with the list.
 */
export function parsePageBody(
  p: Record<string, unknown>,
  at: string,
  id: string,
  withId = false,
  noun?: string,
  keys: readonly string[] = WORKBENCH_PAGE_KEYS,
): PageDef {
  const caption = p.label === undefined ? undefined : parseCaption(p.label, `${at}.label`);
  if (typeof p.base !== 'string' || !p.base.trim()) {
    throw new Error(`${at}${typeof p.label === 'string' ? ` ("${p.label.trim()}")` : ''} has no "base" table.`);
  }
  /* A page is called what its records are: its resource's noun, else its table's name. */
  const name = caption ?? (noun ? headingOf(noun) : humanName(p.base.trim()));
  /* Said by name rather than as an unknown key: an author who copied an App's page into a tablewalk.json is told
     why it does not apply there, not that the word does not exist. */
  if (p.layout !== undefined && !keys.includes('layout')) {
    throw new Error(
      `[page-layout] ${at} ("${name}") has "layout", which is an App page's: a config file's page draws the record's one skeleton. Remove it.`,
    );
  }
  allowKeys(p, withId ? [...keys, 'id'] : keys, `${at} ("${name}")`, keys.includes('connection') ? PAGE_RENAMED : undefined);
  if (p.connection !== undefined && typeof p.connection !== 'string') {
    throw new Error(`${at} ("${name}") has a "connection" that is not a string.`);
  }
  /* Refused rather than coerced, like every other boolean in this file:
     `"listTabs": "false"` is a truthy string. */
  if (p.listTabs !== undefined && typeof p.listTabs !== 'boolean') {
    throw new Error(`${at} ("${name}") has "listTabs": ${JSON.stringify(p.listTabs)}. It must be true or false, without quotes.`);
  }
  /* The only value is the opt-out: a default aside is not something an author switches on. */
  if (p.aside !== undefined && p.aside !== false) {
    throw new Error(`${at} ("${name}") has "aside": ${JSON.stringify(p.aside)}. It can only be false, to leave the default aside out.`);
  }
  /* What every related list that says nothing of its own does while it has no rows. A list's own `empty` wins. */
  if (p.empty !== undefined && p.empty !== 'hide' && p.empty !== 'collapse') {
    throw new Error(
      `${at} ("${name}") has "empty": ${JSON.stringify(p.empty)}. A page's is 'hide' (leave an empty list out) or 'collapse' (say so in one line); a list takes guidance of its own.`,
    );
  }
  const pageEmpty = p.empty as 'hide' | 'collapse' | undefined;
  const sections = parseSections(p.sections, at, name, keys.includes('connection')).map((section) =>
    pageEmpty && section.kind === 'list' && section.presentation !== 'card' && !section.empty && !section.emptyMode
      ? { ...section, emptyMode: pageEmpty }
      : section,
  );
  return {
    id,
    name,
    base: p.base.trim(),
    sections,
    connection: p.connection as string | undefined,
    /* Stored as written: an App's page draws a tab strip of its lists only
       when it says `true`, and the Workbench's only unless it says `false`. */
    ...(typeof p.listTabs === 'boolean' ? { listTabs: p.listTabs } : {}),
    ...(pageEmpty ? { empty: pageEmpty } : {}),
    ...(p.aside === false ? { aside: false as const } : {}),
    ...(p.layout !== undefined ? { layout: parsePageLayout(p.layout, `${at} ("${name}")`) } : {}),
    source: 'config' as const,
  };
}

function parseSections(raw: unknown, at: string, name: string, config: boolean): PageSection[] {
  if (raw === undefined) return [{ kind: 'fields', width: 'full' }];
  if (!Array.isArray(raw)) throw new Error(`${at} ("${name}") has "sections" that are not an array.`);
  if (raw.length > MAX_PAGE_SECTIONS) {
    throw new Error(`${at} ("${name}") has more than ${MAX_PAGE_SECTIONS} sections, its tabs' included.`);
  }
  const sections = raw.map((entry, i) => parseSection(entry, `${at} ("${name}") section ${i + 1}`, config));
  /* A page is a screen, not a report: what one screen draws is counted, so a record that holds more says it in
     tabs, each a screen of its own (a major incident's comms log, bridge and review beside the ticket's work). */
  const drawn = screenSections(sections);
  if (drawn > MAX_SECTIONS) {
    throw new Error(
      `${at} ("${name}") has more than ${MAX_SECTIONS} sections on one screen (${drawn}). A page is a screen, not a report: ` +
        'give some of them a "tab", and each tab is counted as a screen of its own.',
    );
  }
  /* A record has one head. */
  if (sections.filter((s) => s.kind === 'fields' && s.presentation === 'header').length > 1) {
    throw new Error(`${at} ("${name}") has two record headers. A record has one head: say every fact in one header({ … }).`);
  }
  /* A strip of one tab is a heading with a border round it: the name says
     "these are tabs of each other", which takes two. Each region has its own. */
  for (const region of SECTION_REGIONS) {
    const tabs = new Set(sections.filter((s) => (s.region ?? 'main') === region && s.tab).map((s) => s.tab));
    if (tabs.size === 1) {
      throw new Error(
        `${at} ("${name}") names one tab, "${[...tabs][0]}"${region === 'aside' ? ' in its side panel' : ''}. A tab strip needs two tabs or more: name another, or leave "tab" out.`,
      );
    }
  }
  return sections;
}

/**
 * A column count, refused rather than clamped.
 *
 * Clamping `"columns": 7` to 3 would render a layout nobody asked for and say
 * nothing about it; the file is the thing being edited, so the file is where
 * the mistake belongs.
 */
function parseFieldColumns(value: unknown, at: string): FieldColumns | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!FIELD_COLUMNS.includes(n as FieldColumns)) {
    throw new Error(`${at} has "columns" of ${JSON.stringify(value)}. Use 1, 2 or 3.`);
  }
  return n as FieldColumns;
}

/** A boolean the file must spell as one — `"true"` is a truthy string. */
function parseFlag(raw: unknown, at: string, key: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') {
    throw new Error(`${at} has "${key}": ${JSON.stringify(raw)}. It must be true or false, without quotes.`);
  }
  return raw || undefined;
}

/* The spellings a section may not use any more, each mapped to the word
   that replaced it. Refused by name, in the parser's usual voice, so a page
   written against the pre-rename format fails with its fix rather than
   half-working. The renames (docs/apps.md, "The respelling"): `whose`
   says the direction `path` hid, `about` moves the subject the
   way `of` only implied, `show` and `sort` are the query
   language's own words. */
const RENAMED: Record<string, string> = {
  tint: '"tone", as a display rule says it: { kind: { internal: \'warn\' } } on the timeline, or one tone on a stream',
  order: "\"newest\": 'first' (the default) or 'last', the way a conversation reads",
  edit: '"editable", as a list view says it',
  path: '"whose" — the column on the section\'s table that names this record, e.g. "customer_id" or "invoice_id.customer_id"',
  of: '"about" — the record this section is about, named by a reference column of the base, e.g. "site_id"',
  paths: '"show" — the fields to show, e.g. ["name", "account_id.name"]',
  orderBy: '"sort" — written like the query bar, e.g. "due_on desc, name"',
};

function refuseRenamed(s: Record<string, unknown>, at: string, keys: string[]): void {
  for (const key of keys) {
    if (s[key] !== undefined) throw new Error(`${at} has "${key}", which is now ${RENAMED[key]}.`);
  }
}

/* The forms of a fields section that are gone, and what each is now, in one place: they were refused one at a time,
   each in its own words, so an upgrade met them one load after another with no sight of the rest. Every refusal of
   one of them ends with this whole table. */
const RETIRED_FIELDS_FORMS: ReadonlyArray<readonly [string, string]> = [
  ["fields(…, { presentation: 'card' })", "card(title, 'dealer_id', ['rating', 'city']): a section of its own"],
  ["fields(…, { presentation: 'headline' })", "headline('price', { was, subfigure, note, links }): a section of its own"],
  ["fields(…, { presentation: 'accordion' })", "gone: a group of fields is always open; use 'summary', 'facts', 'table' or 'properties'"],
  ['fields(…, { collapsed })', 'gone with the accordion: leave it out'],
  ['fields(…, { actions })', 'headline(figure, { links })'],
  ['fields(…, { subfigure | was | note })', 'headline(figure, { subfigure | was | note })'],
];
/** The mapping as lines for a refusal's end, without a closing full stop. */
const retiredFieldsForms = (): string =>
  `Fields forms that are gone, and what each is now:\n${RETIRED_FIELDS_FORMS.map(([was, now]) => `  ${was} → ${now}`).join('\n')}`;

type FieldPresentation = 'summary' | 'headline' | 'facts' | 'table' | 'properties' | 'card';
/* What `fields` itself says; a headline and a card are sections of their own, and read into fields on the way. */
const FIELD_PRESENTATIONS: readonly FieldPresentation[] = ['summary', 'facts', 'table', 'properties', 'headline', 'card'];
/* A field name or a label path, as `show` takes them: "price", "dealer_id.name". */
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * `measure` is the dashboard's word — "count", "sum amount" — and the one a
 * page metric or chart says, read into the planner's fn and column. Absent
 * is a count.
 */
function parseMeasure(raw: unknown, at: string): { fn: PageMetric['fn']; column?: string } {
  if (raw === undefined) return { fn: 'count' };
  const m = /^\s*(count|sum|avg|min|max)(?:\s+(?:distinct\s+)?([A-Za-z_][\w]*))?(?:\s+as\s+\w+)?\s*$/i.exec(String(raw));
  if (!m) throw new Error(`${at} has a "measure" of "${String(raw)}" — write it like "count", "sum amount" or "avg total as mean".`);
  const fn = m[1].toLowerCase() as PageMetric['fn'];
  if (fn !== 'count' && !m[2])
    throw new Error(`${at} has a "measure" of "${String(raw).trim()}" with no column to ${fn}: write it like "${fn} amount".`);
  return { fn, ...(m[2] === undefined ? {} : { column: m[2].trim() }) };
}

function parseSection(entry: unknown, at: string, config: boolean): PageSection {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${at} is not an object.`);
  }
  let s = entry as Record<string, unknown>;
  let kind = s.kind === undefined ? 'fields' : String(s.kind);
  /* What a tablewalk.json page may say that an App's page may not: the options only the Workbench's page builder
     sets, which an App leaves out as it leaves out a section (a hidden one is simply not written). */
  if (!config) {
    for (const key of ['hidden', 'offsetLeft', 'names', 'sizing'] as const) {
      if (s[key] !== undefined)
        throw new Error(
          `${at} has "${key}", which only a config file page takes. ${
            key === 'hidden'
              ? 'An App leaves a section out instead of hiding it'
              : key === 'sizing'
                ? /* Nothing on a page's related list keeps its columns from crowding; said so, rather than a replacement invented. */
                  'An App page does not use it: a related table fits its pane. For a wide one, name fewer columns in "show", or give the table a list view of its own, where `sizing: \'scroll\'` is taken, and link to it'
                : 'An App page does not use it'
          }.`,
        );
    }
  }
  /* The record's head and the current card are kinds of their own as they
     are written, so a refusal says "header" and "current" as the author
     did; the page draws them as the fields and the list they are. */
  if (kind === 'header') {
    /* `factLabels` is the page model's reading of the facts (pageModel.ts),
       and its type is published, so an author finds it there and writes it.
       A fact's word has one spelling, in `facts` itself. */
    if (Object.hasOwn(s, 'factLabels'))
      throw new Error(
        `${at} has no "factLabels": a fact's word is said in "facts" itself, as { column: 'steps', after: 'step' }. It takes: ${PAGE_SECTION_KEYS.header.join(', ')}.`,
      );
    allowKeys(s, PAGE_SECTION_KEYS.header, at);
    return parseHeader(s, at);
  }
  const current = kind === 'current';
  if (current) {
    allowKeys(s, PAGE_SECTION_KEYS.current, at);
    s = { ...s, kind: 'list', presentation: 'card' };
    kind = 'list';
  } else if (kind === 'list' && s.presentation === 'card') {
    throw new Error(
      `${at}: a related list's presentation is "gallery" or a cards object; the one current row as a card is its own section, current(title, from, whose, { query, sort, show }).`,
    );
  }
  /* A card and a headline are written as the sections they are and drawn as the fields they show. */
  const written = kind;
  if (written === 'card' || written === 'headline') {
    allowKeys(
      s,
      PAGE_SECTION_KEYS[written],
      at,
      written === 'headline' ? { actions: 'is now "links": the calls to action beside the figure' } : {},
    );
    s = { ...s, kind: 'fields', presentation: written };
    kind = 'fields';
  }
  if (s.sizing !== undefined && kind !== 'list') throw new Error(`${at}: sizing belongs on a related list.`);
  if (s.region !== undefined && !SECTION_REGIONS.includes(s.region as SectionRegion)) {
    throw new Error(`${at} has an invalid "region". Use "main" or "aside".`);
  }
  const tab = s.tab === undefined ? undefined : parseCaption(s.tab, `${at}.tab`);
  if (tab && tab.length > MAX_TAB_NAME) {
    throw new Error(`${at} has a "tab" that is not a name of at most ${MAX_TAB_NAME} characters, like "Details".`);
  }
  /* Where a section is drawn: its region, and the tab of that region's strip. The sections that are about the
     record's surroundings rather than the record — a card of another record, the one current row, the change
     history — stand beside it unless the author puts them in the main column. */
  const region =
    (s.region as SectionRegion | undefined) ?? (written === 'card' || current || kind === 'history' ? ('aside' as const) : undefined);
  const placement = {
    ...(region === undefined ? {} : { region }),
    ...(tab === undefined ? {} : { tab }),
  };
  if (s.create !== undefined && kind !== 'list' && kind !== 'timeline')
    throw new Error(`${at}: create belongs on a related list or a timeline.`);
  if (s.presentation !== undefined && kind !== 'fields' && kind !== 'list')
    throw new Error(`${at}: presentation belongs on fields (summary, facts, table, properties) or a related list (gallery, cards).`);
  const width = parseWidth(s.width, at);
  const offsetLeft = parseOffset(s.offsetLeft, at, 'offsetLeft');
  const offsetRight = parseOffset(s.offsetRight, at, 'offsetRight');
  const title = s.title === undefined ? undefined : isMessageRef(s.title) ? parseCaption(s.title, `${at}.title`) : String(s.title);
  const hidden = parseFlag(s.hidden, at, 'hidden');
  if (s.when !== undefined && (typeof s.when !== 'string' || !s.when.trim())) {
    throw new Error(`${at} has a "when" that is not a condition like "status = converted".`);
  }
  const when = s.when === undefined ? undefined : (s.when as string).trim();

  if (kind === 'fields') {
    refuseRenamed(s, at, ['paths', 'edit']);
    if (s.presentation === 'header')
      throw new Error(`${at}: the record's head is a section of its own, header({ status, facts, primary }), not a fields presentation.`);
    if (written === 'fields' && (s.presentation === 'card' || s.presentation === 'headline'))
      throw new Error(
        `${at}: a ${s.presentation} is its own section, ${
          s.presentation === 'card' ? "card(title, 'dealer_id', ['rating', 'city'])" : "headline('price', { was, subfigure, note, links })"
        }, not a fields presentation. ${retiredFieldsForms()}.`,
      );
    const authored =
      written === 'card' || written === 'headline' ? Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'presentation')) : s;
    allowKeys(authored, PAGE_SECTION_KEYS[written === 'card' || written === 'headline' ? written : 'fields'], at, {
      collapsed: `is gone with the accordion: a group of fields is always open. ${retiredFieldsForms()}`,
      ...(written === 'fields'
        ? {
            actions: `belongs on a headline(figure, { links }). ${retiredFieldsForms()}`,
            subfigure: `belongs on a headline(figure, { subfigure }). ${retiredFieldsForms()}`,
            was: `belongs on a headline(figure, { was }). ${retiredFieldsForms()}`,
            note: `belongs on a headline(figure, { note }). ${retiredFieldsForms()}`,
          }
        : {}),
    });
    if (s.show !== undefined && !Array.isArray(s.show)) {
      throw new Error(`${at} has a "show" that is not an array of field names.`);
    }
    if (s.presentation !== undefined && !FIELD_PRESENTATIONS.includes(s.presentation as FieldPresentation)) {
      throw new Error(
        `${at}: a fields presentation is "summary", "facts", "table" or "properties"${
          s.presentation === 'accordion' ? `; the accordion is gone: a group of fields is always open. ${retiredFieldsForms()}` : ''
        }.`,
      );
    }
    if (written === 'headline' && (!Array.isArray(s.show) || !s.show.length)) {
      throw new Error(`${at}: a headline shows its figure and its facts; name them in "show", the figure first.`);
    }
    if (s.presentation === 'facts' && (!Array.isArray(s.show) || !s.show.length)) {
      throw new Error(`${at}: a facts line says the values it names; name them in "show".`);
    }
    if (written === 'card' && (!Array.isArray(s.show) || !s.show.length)) {
      throw new Error(`${at}: a card is titled by its first field and says the rest as facts; name them in "show", the title first.`);
    }
    if (s.editable !== undefined && s.editable !== true)
      throw new Error(
        `${at} has "editable": ${JSON.stringify(s.editable)}. It is true, to edit the properties in place; leave it out otherwise.`,
      );
    if (s.editable === true && s.presentation !== undefined && !['summary', 'properties'].includes(s.presentation as string)) {
      throw new Error(
        `${at}: "editable" belongs on the fields a reader edits — a summary or a property rail; a ${String(s.presentation)} says values, it does not hold them.`,
      );
    }
    if (s.was !== undefined && (typeof s.was !== 'string' || !FIELD_PATH.test(s.was.trim()))) {
      throw new Error(`${at} has a "was" that is not a field name, like "was_price": the figure's earlier value.`);
    }
    if (s.subfigure !== undefined && (typeof s.subfigure !== 'string' || !FIELD_PATH.test(s.subfigure.trim()))) {
      throw new Error(`${at} has a "subfigure" that is not a field name or a label path like "account_id.name".`);
    }
    if (s.note !== undefined && (typeof s.note !== 'string' || !s.note.trim() || s.note.trim().length > 300)) {
      throw new Error(`${at} has a "note" that is not text of at most 300 characters.`);
    }
    /* A reference says the record it names by default in an App, so the
       one thing worth writing is the opt-out. */
    if (s.names !== undefined && s.names !== false) {
      throw new Error(
        `${at} has "names": ${JSON.stringify(s.names)}. A reference shows the record it names by default; say false to keep the raw id, or leave it out.`,
      );
    }
    return {
      kind: 'fields',
      ...placement,
      title,
      width,
      offsetLeft,
      offsetRight,
      hidden,
      ...(when ? { when } : {}),
      paths: (s.show as string[] | undefined)?.map(String),
      columns: parseFieldColumns(s.columns, at),
      names: s.names === false ? false : undefined,
      ...(s.presentation === undefined ? {} : { presentation: s.presentation as FieldPresentation }),
      ...(s.editable === true ? { edit: true as const } : {}),
      ...(s.links === undefined ? {} : { actions: parseHeadlineActions(s.links, at) }),
      ...(s.subfigure === undefined ? {} : { subfigure: (s.subfigure as string).trim() }),
      ...(s.was === undefined ? {} : { was: (s.was as string).trim() }),
      ...(s.note === undefined ? {} : { note: (s.note as string).trim() }),
    };
  }

  if (kind === 'timeline') {
    refuseRenamed(s, at, ['tint', 'order']);
    allowKeys(s, PAGE_SECTION_KEYS.timeline, at);
    if (!Array.isArray(s.streams) || !s.streams.length) {
      throw new Error(`${at} is a timeline and needs "streams" — the dated child rows it merges.`);
    }
    if (s.streams.length > MAX_STREAMS) {
      throw new Error(`${at} merges more than ${MAX_STREAMS} streams.`);
    }
    const streams = (s.streams as unknown[]).map((raw, i) => {
      const here = `${at}, stream ${i + 1}`;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${here} is not an object.`);
      const t = raw as Record<string, unknown>;
      refuseRenamed(t, here, ['path', 'tint']);
      allowKeys(t, STREAM_KEYS, here);
      const from = typeof t.from === 'string' ? t.from.trim() : '';
      if (!from) throw new Error(`${here} has no "from" table.`);
      const path = typeof t.whose === 'string' ? t.whose.trim() : '';
      if (!path) throw new Error(`${here} has no "whose" — the column that leads back to this record.`);
      const atCol = typeof t.at === 'string' ? t.at.trim() : '';
      if (!atCol) throw new Error(`${here} has no "at" — the date column the stream is ordered by.`);
      const show = typeof t.show === 'string' ? t.show.trim() : '';
      if (!show) throw new Error(`${here} has no "show" — the line each row becomes.`);
      /* `query` is the one spelling; the internal stream keeps its `filter`.
         `author` says who wrote a row, where `by` groups one everywhere else;
         the internal stream keeps its `by`. */
      const filterRaw = t.query;
      /* `about` as a list's: the stream's rows lead to the row a reference of the record names (a deal's company),
         not to the record, so a timeline reaches its parent's other children. */
      if (t.about !== undefined && (typeof t.about !== 'string' || !t.about.trim() || t.about.includes('.')))
        throw new Error(`${here} has an "about" that is not a reference column of the page's table, e.g. "company_id".`);
      /* The stream's own far side, where its rows name the other party in their own words (`person_id`, not `author_id`). */
      if (t.side !== undefined && (typeof t.side !== 'string' || !t.side.trim()))
        throw new Error(`${here} has a "side" that is not a condition like "person_id = record.caller_id".`);
      /* The stream's own dress, where every row of it is one kind (time logged, a system event): no column to name. */
      if (t.tone !== undefined && !(TIMELINE_TONES as readonly unknown[]).includes(t.tone))
        throw new Error(`${here} has a "tone" that is not one of ${TIMELINE_TONES.join(', ')}: every row of this stream wears it.`);
      if (t.compact !== undefined && t.compact !== true)
        throw new Error(`${here} has a "compact" that is not true: every row of this stream is one line, or leave it out.`);
      return {
        ...(typeof t.about === 'string' ? { of: t.about.trim() } : {}),
        from,
        path,
        at: atCol,
        show,
        detail: t.detail === undefined ? undefined : String(t.detail).trim() || undefined,
        by: t.author === undefined ? undefined : String(t.author).trim() || undefined,
        filter: filterRaw === undefined ? undefined : String(filterRaw).trim() || undefined,
        ...(typeof t.side === 'string' ? { side: t.side.trim() } : {}),
        ...(t.tone === undefined ? {} : { tone: t.tone as TimelineTone }),
        ...(t.compact === true ? { compact: true as const } : {}),
      };
    });
    const limit = s.limit === undefined ? undefined : Number(s.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new Error(`${at} has a "limit" that is not a positive whole number.`);
    }
    if (s.newest !== undefined && s.newest !== 'first' && s.newest !== 'last') {
      throw new Error(`${at} has a "newest" that is neither 'first' (the default) nor 'last' (a conversation, read down to the latest).`);
    }
    const composer = s.composer === undefined ? undefined : parseTimelineComposer(s.composer, at);
    const tone = s.tone === undefined ? undefined : parseTimelineTone(s.tone, at);
    const compact = s.compact === undefined ? undefined : parseTimelineCompact(s.compact, at);
    /* The other party's rows: a condition in the query language over each stream's rows, where `record.<column>` is
       the page's record. Judged per stream against the catalog with the rest of the section (page.ts timelineSides). */
    if (s.side !== undefined && (typeof s.side !== 'string' || !s.side.trim())) {
      throw new Error(`${at} has a "side" that is not a condition like "author_id = record.caller_id".`);
    }
    const side = typeof s.side === 'string' ? s.side.trim() : undefined;
    if (composer && s.create !== undefined) {
      throw new Error(
        `${at} has both "composer" and "create": a conversation's composer is the commands' (reply, note), and "create" is the form's. Keep one.`,
      );
    }
    return {
      kind: 'timeline',
      ...placement,
      title,
      streams,
      limit,
      width,
      offsetLeft,
      offsetRight,
      hidden,
      ...(s.newest === 'last' ? { newest: 'last' as const } : {}),
      ...(composer ? { composer } : {}),
      ...(tone ? { tone } : {}),
      ...(compact ? { compact } : {}),
      ...(side ? { side } : {}),
      ...(s.create === undefined ? {} : { create: parseRelatedCreate(s.create, at) }),
      ...(when ? { when } : {}),
    };
  }

  if (kind === 'custom') {
    allowKeys(s, PAGE_SECTION_KEYS.custom, at, CUSTOM_RENAMED);
    /* The author's own component, placed like any section: its reads are
       declared, so the planner checks and runs them (appComponents.ts). */
    const component = parseComponentDecl(s.component, `${at}, "component"`, 'section');
    const parsed = parsePageReads(s.rows, at);
    const reads =
      parsed &&
      Object.fromEntries(
        Object.entries(parsed).map(([name, read]) => [
          name,
          read.sort === undefined ? read : { ...read, orderBy: parseSort(read.sort, `${at}, rows "${name}"`) },
        ]),
      );
    const totals = parsePageTotals(s.figures, at);
    return {
      kind: 'custom',
      ...placement,
      title,
      width,
      offsetLeft,
      offsetRight,
      hidden,
      ...(when ? { when } : {}),
      component,
      ...(s.record === undefined ? {} : { record: parseRecordFields(s.record, at) }),
      ...(reads ? { reads } : {}),
      ...(totals ? { aggregates: totals } : {}),
      props: componentPropValues(component, s.props, at),
    };
  }

  if (kind === 'history') {
    allowKeys(s, PAGE_SECTION_KEYS.history, at);
    const limit = s.limit === undefined ? undefined : Number(s.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT)) {
      throw new Error(`${at} has a "limit" that is not a whole number from 1 to ${MAX_HISTORY_LIMIT}.`);
    }
    return {
      kind: 'history',
      ...placement,
      title,
      width,
      offsetLeft,
      offsetRight,
      hidden,
      ...(limit === undefined ? {} : { limit }),
      ...(when ? { when } : {}),
    };
  }

  if (kind === 'flows' || kind === 'diagram') {
    allowKeys(s, PAGE_SECTION_KEYS[kind], at);
    return {
      kind,
      ...placement,
      title,
      width,
      offsetLeft,
      offsetRight,
      hidden,
      ...(when ? { when } : {}),
    };
  }

  if (kind === 'note') {
    allowKeys(s, PAGE_SECTION_KEYS.note, at);
    if (typeof s.text !== 'string' || !s.text.trim()) throw new Error(`${at} is a note and has no "text" — the words it says.`);
    let action: AppLinkAction | undefined;
    if (s.action !== undefined) {
      action = parseAppLinkAction(s.action, `${at}, "action"`, true);
    }
    if (s.variant !== undefined && s.variant !== 'quiet' && s.variant !== 'callout') {
      throw new Error(
        `${at} has a "variant" of ${JSON.stringify(s.variant)}: a note is "quiet" (small print, no mark) or a "callout" (a ground of its own); leave it out for the plain note.`,
      );
    }
    return {
      kind: 'note',
      ...placement,
      title,
      width,
      offsetLeft,
      offsetRight,
      hidden,
      ...(when ? { when } : {}),
      ...(s.variant === undefined ? {} : { variant: s.variant as 'quiet' | 'callout' }),
      text: s.text.trim(),
      ...(s.icon === undefined ? {} : { icon: parseIcon(s.icon, at) }),
      ...(action ? { action } : {}),
    };
  }

  if (kind === 'view') {
    allowKeys(s, PAGE_SECTION_KEYS.view, at);
    if (typeof s.view !== 'string' || !s.view.trim()) throw new Error(`${at} embeds no "view" — the key of one of the App's list views.`);
    const path = typeof s.whose === 'string' ? s.whose.trim() : '';
    if (!path) {
      throw new Error(
        `${at} embeds "${s.view.trim()}" with no "whose" — on a page, an embedded list shows the rows *whose* named column ` +
          "is this record: embed('invoices', { whose: 'customer_id' }).",
      );
    }
    if (s.about !== undefined && (typeof s.about !== 'string' || !s.about.trim())) {
      throw new Error(`${at} has an "about" that is not a non-empty string.`);
    }
    if (s.limit !== undefined && (typeof s.limit !== 'number' || !Number.isInteger(s.limit) || s.limit < 1)) {
      throw new Error(`${at} has a "limit" that is not a positive whole number.`);
    }
    return {
      kind: 'list',
      ...placement,
      title,
      width,
      offsetLeft,
      offsetRight,
      hidden,
      ...(when ? { when } : {}),
      view: s.view.trim(),
      from: '',
      path,
      ...(s.about === undefined ? {} : { of: (s.about as string).trim() }),
      ...(s.limit === undefined ? {} : { limit: s.limit as number }),
    };
  }

  if (kind !== 'metric' && kind !== 'list' && kind !== 'breakdown' && kind !== 'chart') {
    throw new Error(
      `${at} has an unknown kind "${kind}". Use "fields", "metric", "list", "breakdown", "chart", "note", "timeline", "history", "flows", "diagram", "custom" or "view" (an embedded list view); ` +
        'in an App, each is written with its helper: fields(), metric(), related(), breakdown(), chart(), note(), timeline(), history(), flows(), diagram(), custom(), embed().',
    );
  }

  refuseRenamed(s, at, kind === 'list' ? ['path', 'of', 'orderBy'] : ['path', 'of', 'orderBy', 'edit']);
  if (kind === 'list' && s.columns !== undefined) {
    throw new Error(`${at} has "columns", which is now "show" — the columns the list shows, e.g. ["due_on", "status"].`);
  }
  allowKeys(
    s,
    PAGE_SECTION_KEYS[kind],
    at,
    kind === 'list'
      ? {
          about: 'a related list no longer takes: a row that shares a column with the record is found by { same: [column] }',
          similar: "is now the list's own match: related(title, from, { same: [column], near: { column: 0.25 } })",
          editable: 'is gone: the lines of a record are edited in its form (a form\'s "lines")',
          order: 'is gone with the editable lines; a list sorts with "sort"',
        }
      : {},
  );
  const from = typeof s.from === 'string' ? s.from.trim() : '';
  if (!from) throw new Error(`${at} has no "from" table.`);
  const similar = kind === 'list' && s.same !== undefined ? parseMatch(s, at) : undefined;
  if (kind === 'list' && s.near !== undefined && s.same === undefined)
    throw new Error(`${at} has "near" without "same": a match is the columns a row shares with the record, and the numbers it keeps near.`);
  const path = similar ? '' : typeof s.whose === 'string' ? s.whose.trim() : '';
  if (!path && !similar) {
    throw new Error(
      `${at} has no "whose" — the rows shown are the ${from} rows *whose* named column ` +
        'is this record: "customer_id" for the customer\'s own rows, ' +
        '"invoice_id.customer_id" for rows two references away; or, to list the rows that share its values, "same".',
    );
  }
  /* `query` is the one word for narrowing rows, on a page section as on a
     dashboard's; the internal section keeps its `filter`. */
  const filter = s.query === undefined ? undefined : String(s.query).trim() || undefined;
  /* `about` moves a figure's subject one reference away from the
     root: "tickets at this order's site" is { from: "ticket", whose:
     "site_id", about: "site_id" }. Absent means the root itself. */
  if (s.about !== undefined && (typeof s.about !== 'string' || !s.about.trim())) {
    throw new Error(`${at} has an "about" that is not a non-empty string.`);
  }
  const of = s.about === undefined ? undefined : (s.about as string).trim();

  /* A figure said as a dashboard's is (appViews.ts): an average of a 1–5 rating has no column rule to say it, and
     drew "3.333" with nothing after it; a win rate `avg won * 100` is a percent (G111). */
  if (s.format !== undefined && !(FIGURE_FORMATS as readonly string[]).includes(String(s.format)))
    throw new Error(`${at} has a "format" of "${String(s.format)}". Use ${FIGURE_FORMAT_WORDS}.`);
  if (s.unit !== undefined && (typeof s.unit !== 'string' || !s.unit.trim() || s.unit.length > 24))
    throw new Error(`${at} has a "unit" that is not a short word said after the figure, like "days".`);
  const figureWords = {
    ...(s.format === undefined ? {} : { format: s.format as PageMetric['format'] }),
    ...(s.unit === undefined ? {} : { unit: (s.unit as string).trim() }),
  };

  if (kind === 'metric') {
    const { fn, column: columnRaw } = parseMeasure(s.measure, at);
    return {
      kind: 'metric',
      ...placement,
      title,
      width,
      offsetLeft,
      offsetRight,
      hidden,
      ...(when ? { when } : {}),
      fn: fn as PageMetric['fn'],
      from,
      path,
      of,
      column: columnRaw === undefined ? undefined : String(columnRaw).trim(),
      filter,
      ...figureWords,
    };
  }

  if (kind === 'chart') {
    const by = typeof s.by === 'string' ? s.by.trim() : '';
    if (!by) throw new Error(`${at} has no "by" — what its groups are: "status", or a bucketed date like "month issued_on".`);
    if (s.shape !== undefined && !(CHART_SHAPES as readonly string[]).includes(String(s.shape))) {
      throw new Error(`${at} has a "shape" of "${String(s.shape)}". Use "line", "bar", "donut" or "stacked".`);
    }
    if (s.shape === 'stacked' && !by.includes(',')) {
      throw new Error(
        `${at} is a stacked chart and needs a two-key "by" — "month issued_on, status": a bar for each month, divided by status.`,
      );
    }
    if (s.limit !== undefined && (typeof s.limit !== 'number' || !Number.isInteger(s.limit) || s.limit < 1)) {
      throw new Error(`${at} has a "limit" that is not a positive whole number.`);
    }
    if (s.height !== undefined && (typeof s.height !== 'number' || !Number.isFinite(s.height) || s.height < 120)) {
      throw new Error(`${at} has a "height" that is not a number of pixels (120 or more).`);
    }
    if (s.target !== undefined && (typeof s.target !== 'number' || !Number.isFinite(s.target))) {
      throw new Error(`${at} has a "target" that is not a number.`);
    }
    if (s.target !== undefined && s.shape === 'donut')
      throw new Error(`${at} is a donut, which has no scale to draw a "target" on. Use a line or stacked bars.`);
    let sort: string | undefined;
    if (s.sort !== undefined) {
      if (s.shape !== 'bar' && s.shape !== 'donut')
        throw new Error(`${at} has a "sort", which orders the categories of a bar chart or a donut; a line runs along its key.`);
      if (s.sort === 'value' || s.sort === 'category') sort = s.sort;
      else {
        const parsed = parseSortText(s.sort, at, 'starts_on');
        if (parsed!.length !== 1 || parsed![0].column.includes('.'))
          throw new Error(
            `${at} has a "sort" of more than one column or a path; categories are ordered by 'value', 'category' or one column of the rows: "starts_on desc".`,
          );
        sort = parsed![0].direction === 'desc' ? `${parsed![0].column} desc` : parsed![0].column;
      }
    }
    const { fn, column } = parseMeasure(s.measure, at);
    return {
      kind: 'chart',
      ...placement,
      title,
      width,
      offsetLeft,
      offsetRight,
      hidden,
      ...(when ? { when } : {}),
      from,
      path,
      of,
      by,
      fn,
      ...(column === undefined ? {} : { column }),
      ...(s.shape === undefined ? {} : { shape: s.shape as PageChart['shape'] }),
      ...(sort ? { sort } : {}),
      filter,
      ...(s.limit === undefined ? {} : { limit: s.limit as number }),
      ...(s.height === undefined ? {} : { height: s.height as number }),
      ...(s.target === undefined ? {} : { target: s.target as number }),
      ...figureWords,
    };
  }

  if (kind === 'breakdown') {
    const by = typeof s.by === 'string' ? s.by.trim() : '';
    if (!by) {
      throw new Error(`${at} has no "by" — the column its groups are counted under.`);
    }
    if (s.limit !== undefined && (typeof s.limit !== 'number' || !Number.isInteger(s.limit) || s.limit < 1)) {
      throw new Error(`${at} has a "limit" that is not a positive whole number.`);
    }
    const measure = parseMeasure(s.measure, at);
    return {
      kind: 'breakdown',
      // A count is what a breakdown says when it says nothing.
      ...(measure.fn === 'count' && measure.column === undefined
        ? {}
        : { fn: measure.fn, ...(measure.column === undefined ? {} : { column: measure.column }) }),
      ...placement,
      title,
      width,
      offsetLeft,
      offsetRight,
      hidden,
      ...(when ? { when } : {}),
      from,
      path,
      of,
      by,
      filter,
      limit: s.limit as number | undefined,
      ...figureWords,
    };
  }

  if (s.limit !== undefined && (typeof s.limit !== 'number' || !Number.isInteger(s.limit) || s.limit < 1)) {
    throw new Error(`${at} has a "limit" that is not a positive whole number.`);
  }
  if (s.show !== undefined && !Array.isArray(s.show)) {
    throw new Error(`${at} has a "show" that is not an array of column names.`);
  }
  const shown = s.show === undefined ? undefined : parseShowEntries(s.show as unknown[], at);
  /* A gallery draws a related list of image files; whether the rows are
     files is the App's to say (`file` on the resource), judged where the
     page meets the App. */
  /* Or its rows as cards, in the list view's own cards grammar: the same
     keys, judged against the catalog where the page meets the App. */
  let cards: AppCardsList | undefined;
  /* The one current row as a card — the active lease, the latest visit —
     chosen by the list's query and sort: one row, so nothing to page, sum
     or add under it. */
  if (current && (s.empty === false || s.empty === 'hide' || s.empty === 'collapse'))
    throw new Error(`${at} is a current() card; say what no row means with "empty" guidance rather than leaving it out.`);
  if (s.presentation !== undefined && s.presentation !== 'gallery' && !current) {
    const raw = s.presentation;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as Record<string, unknown>).kind !== 'cards') {
      throw new Error(`${at}: a related list's presentation is "gallery" or a cards object { kind: 'cards', primary, … }.`);
    }
    const c = raw as Record<string, unknown>;
    allowKeys(
      c,
      ['kind', 'primary', 'description', 'value', 'badge', 'icon', 'properties', 'facts', 'footer', 'image', 'media'],
      `${at}, presentation (cards)`,
      { lines: 'is now "properties": the captioned values under the title ("facts" stays the dotted line)' },
    );
    if (typeof c.primary !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(c.primary.trim()))
      throw new Error(`${at}, presentation (cards): "primary" must be a local column or a one-hop path like "vehicle_id.title".`);
    if (
      c.properties !== undefined &&
      (!Array.isArray(c.properties) ||
        c.properties.length > CARDS_MAX_LINES ||
        c.properties.some((line) => typeof line !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(line.trim())))
    ) {
      throw new Error(`${at}, presentation (cards): "properties" must be at most ${CARDS_MAX_LINES} local columns or one-hop label paths.`);
    }
    cards = parseCards(
      c,
      `${at}, presentation (cards)`,
      c.primary.trim(),
      ((c.properties as string[] | undefined) ?? []).map((line) => line.trim()),
    );
  }
  /* `empty` is the guidance a list with no rows shows, or what to do with the list instead: 'hide' leaves it out
     until it has a row (a manager's direct reports, on a page most people's are none), 'collapse' says it in one
     quiet line with the other empty lists beside it. Where the reader may add a row, 'hide' collapses rather than
     hides: a list that offers a door is never taken away (PageSections.tsx). */
  if (s.empty === true)
    throw new Error(
      `${at} has "empty: true". "empty" is guidance ({ title, description, action }), 'hide' to leave the list out while it has no rows, or 'collapse' to say so in one line.`,
    );
  if (s.empty === false) throw new Error(`${at} has "empty: false", which is now "empty: 'hide'".`);
  const emptyMode = s.empty === 'hide' || s.empty === 'collapse' ? s.empty : undefined;
  /* A footer of sums, the list view's `totals`: over every row that points
     at the record, not the page, so it is one aggregate over the rows the
     path reaches and never through a filter. */
  let totals: string[] | undefined;
  if (s.totals !== undefined) {
    if (
      !Array.isArray(s.totals) ||
      !s.totals.length ||
      s.totals.some((c) => typeof c !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c))
    ) {
      throw new Error(`${at} has "totals" that are not a list of the rows' numeric columns, rollups or computed numbers.`);
    }
    if (new Set(s.totals).size !== s.totals.length) throw new Error(`${at} has "totals" that name one column twice.`);
    if (s.presentation !== undefined)
      throw new Error(
        `${at} has "totals" and a ${s.presentation === 'gallery' ? 'gallery' : 'cards'} presentation; a footer of totals belongs to a table.`,
      );
    const narrowed = ['query', 'near'].filter((key) => s[key] !== undefined && s[key] !== false);
    if (narrowed.length) {
      throw new Error(
        `${at} has "totals" and "${narrowed[0]}". Totals sum every row that points at the record and cannot be narrowed; drop one, or add a total() metric beside the list.`,
      );
    }
    totals = s.totals as string[];
  }
  const group = parseGroup(s, at, { similar: Boolean(similar), presentation: s.presentation, current });
  /* The child's own verbs, from a ⋯ at the end of each row, as its own page offers them: a table's, never a card's or a photo's. */
  if (s.rowActions !== undefined && s.rowActions !== true && s.rowActions !== false)
    throw new Error(`${at}: "rowActions" must be true (a ⋯ menu on each row with the row's own actions) or false.`);
  if (s.rowActions === true && s.presentation !== undefined)
    throw new Error(`${at} has "rowActions" and a presentation; a row menu belongs to a table.`);
  /* The record's own verbs that add to this list — "Add to the committee" on a deal — drawn in the list's head
     rather than the record's, by the ids its resource's actions have (checked against them where the App is). */
  let listActions: string[] | undefined;
  if (s.actions !== undefined) {
    if (
      !Array.isArray(s.actions) ||
      !s.actions.length ||
      s.actions.length > 4 ||
      s.actions.some((id) => typeof id !== 'string' || !id.trim())
    )
      throw new Error(`${at}: "actions" is one to four of the record's own action ids, drawn in the list's head: ['addBuyer'].`);
    listActions = (s.actions as string[]).map((id) => id.trim());
    if (new Set(listActions).size !== listActions.length) throw new Error(`${at} has "actions" naming one action twice.`);
  }
  return {
    kind: 'list',
    ...placement,
    ...(s.sizing === undefined ? {} : { sizing: parseTableSizing(s.sizing, at) }),
    ...(s.presentation === 'gallery' || s.presentation === 'card'
      ? { presentation: s.presentation }
      : cards
        ? { presentation: cards }
        : {}),
    ...(similar ? { similar } : {}),
    title,
    width,
    offsetLeft,
    offsetRight,
    hidden,
    ...(when ? { when } : {}),
    from,
    path,
    columns: shown?.columns,
    ...(shown?.labels ? { labels: shown.labels } : {}),
    filter,
    limit: s.presentation === 'card' ? 1 : (s.limit as number | undefined),
    orderBy: parseSort(s.sort, at),
    ...(s.create === undefined ? {} : s.create === false ? { noCreate: true as const } : { create: parseRelatedCreate(s.create, at) }),
    ...(s.empty === undefined || emptyMode ? {} : { empty: parseListEmpty(s.empty, at) }),
    ...(emptyMode ? { emptyMode } : {}),
    ...(group ? { group } : {}),
    ...(totals ? { totals } : {}),
    ...(s.rowActions === true ? { rowActions: true as const } : {}),
    ...(listActions ? { listActions } : {}),
  };
}

/**
 * A related list's `group`: one header for each record its rows share through `by`, the rows to a group under it.
 * One level only. `limit` beside it is the rows to a group, so it is held to what a group opens to.
 */
function parseGroup(
  s: Record<string, unknown>,
  at: string,
  beside: { similar: boolean; presentation: unknown; current: boolean },
): PageGroup | undefined {
  if (s.group === undefined) return undefined;
  const raw = s.group;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(
      `${at} has a "group" that is not an object: group: { by: 'estimate_id', show: ['vehicle_id', 'total'], sort: 'created_on desc', limit: 5 }.`,
    );
  if (beside.current) throw new Error(`${at} is a current() card, which is one row and has nothing to group.`);
  if (beside.similar)
    throw new Error(`${at} has "group" and "same": a matched list is not the record's children, so it has no chain worth grouping.`);
  if (beside.presentation !== undefined)
    throw new Error(
      `${at} has "group" and a ${beside.presentation === 'gallery' ? 'gallery' : 'cards'} presentation; groups are drawn as tables.`,
    );
  const g = raw as Record<string, unknown>;
  allowKeys(g, ['by', 'show', 'sort', 'limit', 'empty', 'sum'], `${at}, group`);
  if (typeof g.by !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(g.by.trim()))
    throw new Error(`${at}, group has no "by": the column or reference the rows are grouped under, like "estimate_id".`);
  if (g.show !== undefined) {
    if (
      !Array.isArray(g.show) ||
      !g.show.length ||
      g.show.length > 4 ||
      g.show.some((c) => typeof c !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c))
    )
      throw new Error(`${at}, group has a "show" that is not one to four columns of the record each group is: ['vehicle_id', 'total'].`);
    if (new Set(g.show).size !== g.show.length) throw new Error(`${at}, group has a "show" that names one column twice.`);
  }
  let sort: PageGroup['sort'];
  if (g.sort !== undefined) {
    const parsed = parseSortText(g.sort, `${at}, group`, 'created_on desc')!;
    if (parsed.length !== 1 || parsed[0].column.includes('.'))
      throw new Error(
        `${at}, group has a "sort" of more than one column or a path; groups are ordered by one column of their record: "created_on desc".`,
      );
    sort = { column: parsed[0].column, direction: parsed[0].direction };
  }
  if (g.limit !== undefined && (typeof g.limit !== 'number' || !Number.isInteger(g.limit) || g.limit < 1 || g.limit > GROUPS_MOST))
    throw new Error(`${at}, group has a "limit" that is not a whole number of groups from 1 to ${GROUPS_MOST}.`);
  // A msg() is said by the loader before a page is read; one that reaches here has no catalog to say it.
  if (isMessageRef(g.empty)) parseCaption(g.empty, `${at}.group.empty`);
  if (g.empty !== undefined && (typeof g.empty !== 'string' || !g.empty.trim() || g.empty.length > 60))
    throw new Error(`${at}, group has an "empty" that is not a short name for the rows with no value: 'Backlog'.`);
  let sum: string[] | undefined;
  if (g.sum !== undefined) {
    const named = typeof g.sum === 'string' ? [g.sum] : g.sum;
    if (
      !Array.isArray(named) ||
      named.length < 1 ||
      named.length > 2 ||
      named.some((c) => typeof c !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c))
    )
      throw new Error(`${at}, group has a "sum" that is not one or two numeric columns of the rows: 'points' or ['points', 'hours'].`);
    if (new Set(named).size !== named.length) throw new Error(`${at}, group has a "sum" that names one column twice.`);
    sum = named as string[];
  }
  if (typeof s.limit === 'number' && s.limit > GROUP_ROWS_MOST)
    throw new Error(`${at} has a "limit" of ${s.limit} beside "group", where it is the rows to a group: at most ${GROUP_ROWS_MOST}.`);
  return {
    by: g.by.trim(),
    ...(g.show ? { show: g.show as string[] } : {}),
    ...(sort ? { sort } : {}),
    ...(g.limit === undefined ? {} : { limit: g.limit as number }),
    ...(g.empty === undefined ? {} : { empty: (g.empty as string).trim() }),
    ...(sum ? { sum } : {}),
  };
}

/* The record's header: the head the page already draws — its noun over the
   name, the verbs beside it — with the status chip and the facts line an
   author names. It is drawn in the head, not where it is written, so what
   would move it (a region, a tab, a width) is refused rather than ignored. */
function parseHeader(s: Record<string, unknown>, at: string): PageSection {
  if (s.status !== undefined && (typeof s.status !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.status.trim()))) {
    throw new Error(`${at} has a "status" that is not one of the record's own columns, like "stage".`);
  }
  if (
    s.destructive !== undefined &&
    (!Array.isArray(s.destructive) || !s.destructive.length || s.destructive.some((id) => typeof id !== 'string' || !id.trim()))
  ) {
    throw new Error(`${at} has a "destructive" that is not a list of the record's action ids, like ['markLost'].`);
  }
  /* The one verb drawn filled: the one the record most needs next, which
     is never one that takes something away. Whether each id is one of the
     base resource's actions is the App's to judge (apps.ts), where both are known. */
  if (s.primary !== undefined && (typeof s.primary !== 'string' || !s.primary.trim())) {
    throw new Error(`${at} has a "primary" that is not the id of one of the record's actions, like 'renew'.`);
  }
  if (
    s.actions !== undefined &&
    (!Array.isArray(s.actions) ||
      !s.actions.length ||
      s.actions.some((id) => typeof id !== 'string' || !id.trim()) ||
      new Set(s.actions.map((id) => String(id).trim())).size !== s.actions.length)
  ) {
    throw new Error(`${at} has "actions" that are not a list of the record's action ids, each once, like ['resolve', 'reassign'].`);
  }
  /* The filled verb is one the head draws. */
  if (
    Array.isArray(s.actions) &&
    typeof s.primary === 'string' &&
    !s.actions.some((id) => String(id).trim() === (s.primary as string).trim())
  ) {
    throw new Error(`${at} has "primary" "${s.primary}", which is not one of its "actions": the head cannot fill a verb it does not draw.`);
  }
  if (
    typeof s.primary === 'string' &&
    Array.isArray(s.destructive) &&
    s.destructive.some((id) => typeof id === 'string' && id.trim() === (s.primary as string).trim())
  ) {
    throw new Error(
      `${at} names "${s.primary}" both "primary" and "destructive": the filled button is the forward verb, and a destructive one is drawn last and quiet.`,
    );
  }
  /* A header with only a `primary` or its `destructive` verbs is the head
     the page draws anyway, told which verb to fill: worth writing. One that
     says nothing is a slip. */
  if (['status', 'facts', 'primary', 'destructive', 'actions'].every((key) => s[key] === undefined)) {
    throw new Error(
      `${at}: a record header says something: a "status", "facts", its "primary" verb, its "destructive" ones or the "actions" it draws.`,
    );
  }
  const facts = s.facts === undefined ? undefined : parseFacts(s.facts, `${at}, header`);
  return {
    kind: 'fields',
    presentation: 'header',
    paths: facts?.facts ?? [],
    ...(facts?.factLabels ? { factLabels: facts.factLabels } : {}),
    ...(s.status === undefined ? {} : { status: (s.status as string).trim() }),
    ...(s.primary === undefined ? {} : { primary: (s.primary as string).trim() }),
    ...(s.destructive === undefined ? {} : { destructive: (s.destructive as string[]).map((id) => id.trim()) }),
    ...(s.actions === undefined ? {} : { headerActions: (s.actions as string[]).map((id) => id.trim()) }),
  };
}

/* A conversation's composer: the commands its two modes run, named as the App's actions name them. */
function parseTimelineComposer(raw: unknown, at: string): TimelineComposer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(`${at} has a "composer" that is not { reply, note? }: the names of the commands a Reply and an Internal note run.`);
  const c = raw as Record<string, unknown>;
  allowKeys(c, ['reply', 'note', 'templates'], `${at}, composer`);
  for (const key of ['reply', 'note'] as const) {
    if (c[key] !== undefined && (typeof c[key] !== 'string' || !(c[key] as string).trim()))
      throw new Error(`${at}: composer.${key} is not a command's name.`);
  }
  if (typeof c.reply !== 'string') throw new Error(`${at}: a composer needs "reply", the command a Reply runs.`);
  const reply = c.reply.trim();
  const note = typeof c.note === 'string' ? c.note.trim() : undefined;
  if (note !== undefined && note === reply)
    throw new Error(
      `${at}: composer.reply and composer.note name the same command "${reply}"; a note is a different command from a reply.`,
    );
  const templates = c.templates === undefined ? undefined : parseComposerTemplates(c.templates, at);
  return { reply, ...(note === undefined ? {} : { note }), ...(templates ? { templates } : {}) };
}

/* Canned replies: the rows of a resource, each a label to pick and the text it puts in the box. */
function parseComposerTemplates(raw: unknown, at: string): NonNullable<TimelineComposer['templates']> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(
      `${at}: composer.templates is not { from, labelColumn, text, query? }: the resource whose rows are canned replies, and their two columns.`,
    );
  const t = raw as Record<string, unknown>;
  allowKeys(t, ['from', 'labelColumn', 'text', 'query'], `${at}, composer.templates`, {
    label: 'is now "labelColumn": the column a reader picks a reply by',
  });
  for (const key of ['from', 'labelColumn', 'text'] as const) {
    if (typeof t[key] !== 'string' || !(t[key] as string).trim())
      throw new Error(
        `${at}: composer.templates needs "${key}", ${key === 'from' ? 'the resource whose rows are the canned replies' : key === 'labelColumn' ? 'the column a reader picks by' : 'the column whose words fill the box'}.`,
      );
  }
  /* Which rows are offered, beyond what the reader may read: a retired response is still readable. */
  if (t.query !== undefined && (typeof t.query !== 'string' || !t.query.trim()))
    throw new Error(`${at}: composer.templates has a "query" that is not a condition, like 'active = true'.`);
  return {
    from: (t.from as string).trim(),
    labelColumn: (t.labelColumn as string).trim(),
    text: (t.text as string).trim(),
    ...(typeof t.query === 'string' ? { query: t.query.trim() } : {}),
  };
}

const TIMELINE_TONES = ['good', 'warn', 'bad', 'info', 'neutral'] as const;
/* A tone rule says "this column's value → a tone": one or two columns at most, each a short list. */
function parseTimelineTone(raw: unknown, at: string): Record<string, Record<string, TimelineTone>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length) {
    throw new Error(`${at} has a "tone" that is not { column: { value: tone } }, like { kind: { internal: 'warn' } }.`);
  }
  const out: Record<string, Record<string, TimelineTone>> = {};
  for (const [column, values] of Object.entries(raw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column))
      throw new Error(`${at}: tone names "${column}", which is not one of the stream's own columns.`);
    if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) {
      throw new Error(`${at}: tone.${column} is not { value: tone }, like { internal: 'warn' }.`);
    }
    out[column] = {};
    for (const [value, tone] of Object.entries(values)) {
      if (!(TIMELINE_TONES as readonly unknown[]).includes(tone))
        throw new Error(`${at}: tone.${column}.${value} is "${String(tone)}", not one of ${TIMELINE_TONES.join(', ')}.`);
      out[column][value] = tone as TimelineTone;
    }
  }
  return out;
}

/* Rows of these column values are one line: { kind: ['system'] }. */
function parseTimelineCompact(raw: unknown, at: string): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length) {
    throw new Error(`${at} has a "compact" that is not { column: [values] }, like { kind: ['system'] }.`);
  }
  const out: Record<string, string[]> = {};
  for (const [column, values] of Object.entries(raw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column))
      throw new Error(`${at}: compact names "${column}", which is not one of the stream's own columns.`);
    if (!Array.isArray(values) || !values.length || values.some((value) => typeof value !== 'string' || !value)) {
      throw new Error(`${at}: compact.${column} is not a list of values, like ['system'].`);
    }
    out[column] = values.map(String);
  }
  return out;
}

/* Few enough columns that each still says why a row is on the list. */
const MATCH_MAX_SAME = 4;
const MATCH_MAX_NEAR = 2;

/**
 * A list's match: the rows that share the record's own values, `same` equal
 * and `near` within a fraction. It is found by those values rather than by a
 * reference, so each word that only means something beside a reference is
 * refused here rather than ignored: there is no `whose` to walk, no parent
 * to `create` under (`empty` is kept: a match that finds nothing says so), and where the rows are the page's own table the record
 * is always left out.
 */
function parseMatch(s: Record<string, unknown>, section: string): PageSimilar {
  /* Named by its title where it has one: a page may hold several related lists, and "section 3" alone is a count. */
  const at = typeof s.title === 'string' && s.title.trim() ? `${section} ("${s.title.trim()}")` : section;
  const beside: Record<string, string> = {
    whose: "its rows share the record's values rather than point at it",
    create:
      "its rows are not the record's children: a row added here would need the record's values in every matched column, and a near column has no value to fill, so there is nothing to add them under (add through the list's own page)",
  };
  for (const [key, why] of Object.entries(beside)) {
    if (s[key] !== undefined && s[key] !== false) throw new Error(`${at} has "${key}" beside "same" — ${why}.`);
  }
  const column = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (
    !Array.isArray(s.same) ||
    !s.same.length ||
    s.same.length > MATCH_MAX_SAME ||
    s.same.some((c) => typeof c !== 'string' || !column.test(c))
  ) {
    throw new Error(`${at}: "same" must be one to ${MATCH_MAX_SAME} columns a row shares with the record, e.g. ['body_type'].`);
  }
  const same = s.same as string[];
  if (new Set(same).size !== same.length) throw new Error(`${at}: "same" names a column twice.`);
  if (s.near === undefined) return { same };
  if (!s.near || typeof s.near !== 'object' || Array.isArray(s.near)) {
    throw new Error(`${at}: "near" must be an object of number columns and fractions, e.g. { price: 0.25 }.`);
  }
  const near = Object.entries(s.near as Record<string, unknown>);
  if (!near.length || near.length > MATCH_MAX_NEAR) {
    throw new Error(`${at}: "near" must name one or ${MATCH_MAX_NEAR === 2 ? 'two' : MATCH_MAX_NEAR} columns.`);
  }
  for (const [name, fraction] of near) {
    if (!column.test(name)) throw new Error(`${at}: "near" names "${name}", which is not a column name.`);
    if (same.includes(name)) throw new Error(`${at}: "${name}" is in both "same" and "near" — equal already is near.`);
    if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
      throw new Error(`${at}: "near" on "${name}" must be a fraction above 0 and at most 1 — 0.25 is within ±25% of the record's value.`);
    }
  }
  return { same, near: Object.fromEntries(near) as Record<string, number> };
}

/**
 * A list's `show`, in the nav's grammar: a column path, or `{ column,
 * label }` with the app's word over it. The paths stay the planner's
 * `columns`; the labels ride beside them for whoever draws the header.
 */
function parseShowEntries(raw: unknown[], at: string): { columns: string[]; labels?: Record<string, string> } {
  const labels: Record<string, string> = {};
  const columns = raw.map((entry, i) => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const c = entry as Record<string, unknown>;
      for (const key of Object.keys(c)) {
        if (key !== 'column' && key !== 'label') throw new Error(`${at}, "show" entry ${i + 1} has no "${key}". It takes: column, label.`);
      }
      if (typeof c.column !== 'string' || !c.column.trim()) throw new Error(`${at}, "show" entry ${i + 1} has no "column".`);
      if (c.label !== undefined && (typeof c.label !== 'string' || !c.label.trim())) {
        throw new Error(`${at}, "show" entry ${i + 1} has a "label" that is not a non-empty string.`);
      }
      if (c.label !== undefined) labels[c.column.trim()] = (c.label as string).trim();
      return c.column.trim();
    }
    throw new Error(`${at}, "show" entry ${i + 1} is not a column name or a { "column", "label" } object.`);
  });
  return { columns, ...(Object.keys(labels).length ? { labels } : {}) };
}

/**
 * A headline's calls to action: one or two, each opening one of the App's
 * views — a public form, a list, a dashboard — by its key: the landing's
 * call-to-action shape. Whether the key names such a view is judged where
 * the page meets the App.
 */
function parseHeadlineActions(raw: unknown, at: string): PageHeadlineAction[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 2) throw new Error(`${at}: "links" must be one or two { label, to }.`);
  return raw.map((entry, i) => {
    const here = `${at}, link ${i + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${here} is not an object { label, to }.`);
    const a = entry as Record<string, unknown>;
    if (a.to !== undefined && typeof a.to !== 'string') {
      allowKeys(a, ['label', 'to', 'intent'], here, INTENT_RENAMED);
      if (typeof a.label !== 'string' || !a.label.trim() || a.label.trim().length > 60)
        throw new Error(`${here} needs a "label" of at most 60 characters.`);
      if (a.intent !== undefined && a.intent !== 'primary' && a.intent !== 'secondary')
        throw new Error(`${here} has an "intent" of "${String(a.intent)}". Use "primary" or "secondary".`);
      return {
        label: a.label.trim(),
        to: parseAppTarget(a.to, `${here}.to`, true),
        ...(a.intent === undefined ? {} : { intent: a.intent as 'primary' | 'secondary' }),
      };
    }
    allowKeys(a, ['label', 'to', 'intent', 'prefill', 'defaults', 'open'], here, INTENT_RENAMED);
    if (typeof a.label !== 'string' || !a.label.trim() || a.label.trim().length > 60)
      throw new Error(`${here} needs a "label" of at most 60 characters.`);
    if (typeof a.to !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(a.to))
      throw new Error(`${here} needs a "to": the key of one of the App's views, or an appLink().`);
    if (a.intent !== undefined && a.intent !== 'primary' && a.intent !== 'secondary')
      throw new Error(`${here} has an "intent" of "${String(a.intent)}". Use "primary" or "secondary".`);
    /* A public form over the record, rather than a page of its own. Only
       'modal': "drawer" is a list's word for a row, and a page is the default
       because it is what an address opens. */
    if (a.open !== undefined && a.open !== 'modal')
      throw new Error(`${here} has an "open" of "${String(a.open)}". Use "modal", or leave it out for a page.`);
    /* Where the form the action opens starts: an input filled from this
       record (input → field path), or with the author's words — `defaults`, the
       word a New form and a related list's create say a stated starting value with. */
    const inputs = (raw: unknown, key: 'prefill' | 'defaults'): Record<string, string> | undefined => {
      if (raw === undefined) return undefined;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length)
        throw new Error(`${here} has a "${key}" that is not an object of form input → ${key === 'prefill' ? 'field path' : 'text'}.`);
      return Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).map(([input, value]) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input)) throw new Error(`${here}, ${key}: "${input}" is not a form input's name.`);
          if (key === 'prefill' && (typeof value !== 'string' || !FIELD_PATH.test(value.trim())))
            throw new Error(`${here}, prefill: "${input}" must name one of this record's fields.`);
          if (key === 'defaults' && (typeof value !== 'string' || !value.trim() || value.length > 500))
            throw new Error(`${here}, defaults: "${input}" must be text of at most 500 characters.`);
          return [input, (value as string).trim()];
        }),
      );
    };
    const prefill = inputs(a.prefill, 'prefill');
    const defaults = inputs(a.defaults, 'defaults');
    return {
      label: a.label.trim(),
      view: a.to,
      ...(a.intent === undefined ? {} : { intent: a.intent as 'primary' | 'secondary' }),
      ...(prefill ? { prefill } : {}),
      ...(defaults ? { defaults } : {}),
      ...(a.open === undefined ? {} : { open: 'modal' as const }),
    };
  });
}

function parseWidth(raw: unknown, at: string): SectionWidth | undefined {
  if (raw === undefined) return undefined;
  const width = String(raw);
  if (!WIDTHS.includes(width as SectionWidth)) {
    throw new Error(`${at} has a "width" of "${width}". Use ${WIDTHS.join(', ')}.`);
  }
  return width as SectionWidth;
}

function parseOffset(raw: unknown, at: string, side: string): SectionOffset | undefined {
  if (raw === undefined) return undefined;
  const offset = String(raw);
  if (!OFFSETS.includes(offset as SectionOffset)) {
    throw new Error(`${at} has an "${side}" of "${offset}". Use ${OFFSETS.join(', ')}.`);
  }
  return offset as SectionOffset;
}

function parseSort(raw: unknown, at: string): PageList['orderBy'] {
  return parseSortText(raw, at, 'due_on desc, name');
}
