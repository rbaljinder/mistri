/**
 * Content: everything a visitor can open, keyed in `views`, and the `nav`
 * that only arranges references to them. A view is one of:
 *
 *   - `list`: the rows of one resource — how they read (`show`, `tabs`,
 *     `filters`), how they draw (`presentation`), how they open (`open`);
 *   - `dashboard`: sections about whole tables, which may embed a list view;
 *   - `form`: one command's form, signed in or public (appForms.ts);
 *   - `landing`: the public front page (appLanding.ts).
 *
 * Nav holds a view id, `{ to, label }` for a menu-only word, or a
 * `navGroup` — never an inline definition — and is optional: an App
 * without it has no menu. Every list, dashboard and signed-in form view
 * must be reachable (nav, home, a landing, or a reachable dashboard's embed or
 * note action); a view appears in nav at most once; public views are not in
 * nav, which is signed-in chrome.
 *
 * The App keeps the views it opens as rooms — every view nav references,
 * every list or dashboard a home rule names (the one room of an App without
 * nav), and every list or dashboard a reachable dashboard embeds or names in
 * a note action — under their keys, nav as the tree it was written as, and the home rules as written, for the server
 * to evaluate per visitor. A list view keeps its own words, with its action
 * selector; the New form, the actions and the captions stay the resource's.
 * A dashboard keeps its sections, an embed drawn as the list or board
 * section its view reads as and naming that view, whose room its "open →"
 * opens. Every form is kept under its key, public ones too; the landing
 * under its own.
 */
import { tabKey } from '@mistriwork/engine/shared/addressParams.js';
import { filterAddressWord, listFilterKey } from '@mistriwork/engine/shared/listFilters.js';
import { parseViewImport } from './appImport.js';
import { LABEL_SEGMENT } from '@mistriwork/engine/shared/recordLabel.js';
import { parseCaption } from '@mistriwork/engine/shared/appMessages.js';
import { andQuery, splitClauseTail } from '@mistriwork/engine/shared/query.js';
import { segmentBookOf, unfoldSegments } from './appSegments.js';
import { PREVIOUS_PERIOD } from './dashWindow.js';
import { WIDTHS, type SectionWidth } from '@mistriwork/engine/shared/page.js';
import { parseTableSizing } from '@mistriwork/engine/shared/tableSizing.js';
import { parseListEmpty } from '@mistriwork/engine/shared/listEmpty.js';
import { ASSISTANT_ROOM, parseRoutePath } from './appAddress.js';
import { parseAppLinkAction, parseAppTarget } from '@mistriwork/engine/shared/appLinks.js';
import { checkGreeting } from './appGreeting.js';
import {
  BETTER,
  DASH_CHART_SHAPES,
  DASH_KINDS,
  FILTER_BARS,
  OPEN_MODES,
  SECTION_KEYS,
  VIEW_SECTION_KEYS,
  navViewKeys,
  parseRealm,
  resourceCeiling,
  type AppAuth,
  type AppRoleGrant,
  type SeriesColor,
  type AppDashSection,
  type DashTarget,
  type FilterBar,
  type AppDashboardView,
  type AppFormView,
  type AppHomeRule,
  type AppLanding,
  type AppListView,
  type AppNavNode,
  DEFAULT_WINDOWS,
} from './appModel.js';
import {
  FIGURE_FORMATS,
  FIGURE_FORMAT_WORDS,
  DISPLAY_TONES,
  VIEW_KEY,
  allowKeys,
  humanName,
  isRecord,
  keyHomesOf,
  optionalText,
} from '@mistriwork/engine/shared/model.js';
import {
  CALENDAR_BACKDROPS_MAX,
  type AppBoardFact,
  type AppCalendarBackdrop,
  type AppListPresentation,
  type AppListTab,
  type AppSplitListDetail,
} from '@mistriwork/engine/shared/listPresentations.js';
import { parseEditable } from './appListEditable.js';
import { parseFormView } from './appForms.js';
import { headingOf } from '@mistriwork/engine/shared/appNoun.js';
import { landingViews, parseLandingView } from './appLanding.js';
import { CARDS_MAX_LINES, parseCards } from '@mistriwork/engine/shared/appCards.js';
import { checkDeclaredResource, checkResourceSlot, type ParsedData } from './appResourceBlocks.js';
import { parseHome, type HomeView } from './appHome.js';
import { parseIcon } from '@mistriwork/engine/shared/appIcons.js';
import { unknownKey } from '@mistriwork/engine/shared/suggest.js';
import { isAreaName } from '@mistriwork/engine/shared/dashLayout.js';
import {
  embedInteractive,
  firstRunSection,
  nameSectionWindows,
  parseActivitySection,
  parseCustomDashSection,
  parseFindSection,
  parseSectionWindows,
} from './appDashSections.js';
import { parseCustomList, parsePage } from '@mistriwork/engine/shared/appComponents.js';
import { conditionsOnly, parseChartShape, parseAreas, parseFunnelStages, parseNoteBanner, parseStepsShape } from './appDashShapes.js';
import { AppProblems, gather } from './appProblems.js';
import { autoKeyOf } from '@mistriwork/engine/shared/autoBucket.js';
import { parseOpenRoles } from './appViewRoles.js';
import { isRegisteredCommand, registeredCommand } from './command.js';

/* Each view as parsed: the AppDef view itself, beside what only parsing
   needs — its key and where it was written, and a dashboard's tables and
   embeds, which the home and reachability checks read. */
interface ListView {
  kind: 'list';
  key: string;
  at: string;
  view: AppListView;
}
interface DashboardView {
  kind: 'dashboard';
  key: string;
  at: string;
  view: AppDashboardView;
  /** Every table a section reads, embeds included: what a home rule's roles must read. */
  tables: string[];
  embeds: string[];
}
interface LandingView {
  kind: 'landing';
  key: string;
  at: string;
  raw: Record<string, unknown>;
}
interface FormView {
  kind: 'form';
  key: string;
  at: string;
  form: AppFormView;
}
type ParsedView = ListView | DashboardView | LandingView | FormView;

interface ContentContext {
  data: ParsedData;
  name: string;
  auth?: AppAuth;
  api?: import('./appApi.js').AppApiDef;
}
interface ParsedContent {
  views: Record<string, AppListView | AppDashboardView | AppFormView>;
  nav: AppNavNode[];
  home: AppHomeRule[];
  landing?: { view: string; content: AppLanding };
}

/** A view's Favorites star is opt-in: true, or false, which is the same as leaving it out. */
function favoriteFlag(value: unknown, at: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error(`${at}: "favorite" must be true (a star on the view) or false.`);
  return value;
}

/* Spellings renamed before 1.0, refused with the word that replaced them (allowKeys' `refused`). */
const LIST_VIEW_RENAMED = {
  table: 'is now "from": the resource whose rows the list shows',
  keys: 'is now "shortcuts": a split\'s single keys for the picked record\'s actions',
} as const;
const BACKDROP_RENAMED = {
  resource: 'is now "from", and the date columns a span runs between are "start" and "end"',
  to: 'is now "end"',
  label: 'is now "labelColumn": the column whose value names a span',
} as const;
/* Captioned values are `properties` (a fields section's presentation of that name); `facts` is the dotted line only. */
const PRESENTATION_RENAMED = {
  queue: {
    facts: 'is now "properties": the captioned values under the title (a dotted line is a card\'s "facts")',
  },
  cards: {
    lines: 'is now "properties": the captioned values under the title ("facts" stays the dotted line)',
  },
} as const;
const DASHBOARD_VIEW_RENAMED = {
  table: 'is now "from": the resource every section that names none reads',
  layout: 'is now "areas": the rows of area names its sections stand in ("layout" is a page\'s archetype)',
  refresh: 'is gone: a dashboard follows changes as they happen and re-reads what depends on the time each minute',
} as const;
export const LIST_VIEW_KEYS = [
  'kind',
  'from',
  'label',
  'path',
  'icon',
  'query',
  // Read before the view is (appSegments.ts unfoldSegments): the segment's word joins `query`.
  'segment',
  'show',
  'presentation',
  'board',
  'split',
  'empty',
  'tabs',
  'filters',
  'filterBar',
  'suggest',
  'advancedFilters',
  'quickAdd',
  'favorite',
  'totals',
  'density',
  'rowActions',
  'editable',
  'open',
  'opens',
  'sizing',
  'actions',
  'sort',
  'order',
  'import',
  'shortcuts',
  'heading',
  'roles',
  'count',
] as const;
export const DASHBOARD_VIEW_KEYS = [
  'kind',
  'label',
  'path',
  'heading',
  'description',
  'icon',
  'from',
  'sections',
  'aside',
  'areas',
  'windows',
  'window',
  'windowControl',
  'filters',
  'favorite',
  'roles',
] as const;
export const PRESENTATION_KEYS = {
  checklist: ['kind', 'primary', 'checked', 'lines'],
  queue: ['kind', 'primary', 'lines', 'properties', 'badge', 'openLabel'],
  board: ['kind', 'by', 'lanes', 'order', 'swimlanes', 'limits', 'primary', 'lines', 'category', 'footer', 'sum', 'folded'],
  calendar: ['kind', 'date', 'end', 'primary', 'lines', 'badge', 'backdrop'],
  tree: ['kind', 'parent', 'primary', 'lines'],
  gantt: ['kind', 'start', 'end', 'primary', 'by', 'progress'],
  cards: ['kind', 'primary', 'description', 'value', 'badge', 'icon', 'properties', 'facts', 'footer', 'image', 'media'],
  split: ['kind', 'detail', 'limit', 'row'],
} as const;
/** How many `lines` a card below its primary may carry, by presentation. */
const MAX_LINES = {
  checklist: 1,
  queue: 2,
  board: 1,
  calendar: 1,
  tree: 1,
  cards: CARDS_MAX_LINES,
} as const;
/* A sort as the query bar writes one: columns or label paths, each with an optional direction. */
const SORT_TEXT = /^\s*[A-Za-z_][\w.]*(\s+(asc|desc))?(\s*,\s*[A-Za-z_][\w.]*(\s+(asc|desc))?)*\s*$/i;

export function parseContent(a: Record<string, unknown>, where: string, ctx: ContentContext): ParsedContent {
  if (a.views !== undefined && !isRecord(a.views)) throw new Error(`${where}: "views" must be an object of views keyed by id.`);
  const entries = Object.entries((a.views ?? {}) as Record<string, unknown>);
  const views = new Map<string, ParsedView>();
  /* Two passes: a dashboard's embeds read the list views, so every other
     view is parsed first. */
  /* Each view is judged on its own, so one run names every view's refusal
     (appProblems.ts); the checks across views wait until all of them parse. */
  const problems: string[] = [];
  const failed = new Set<string>();
  const book = segmentBookOf(ctx.data.resources);
  const unfolded = new Map<string, Record<string, unknown>>();
  for (const [key, authored] of entries) {
    const at = `${where}: views "${key}"`;
    const parsed = gather(problems, () => {
      if (!VIEW_KEY.test(key)) throw new Error(`${at}: a view key is its address, and must be lowercase letters, digits and hyphens.`);
      if (!isRecord(authored)) throw new Error(`${at} is not an object.`);
      // A segment named anywhere in the view is its word in a query from here on (appSegments.ts).
      const value = unfoldSegments(authored, book, at) as Record<string, unknown>;
      unfolded.set(key, value);
      const kind = viewKind(value, at);
      if (kind === 'list')
        views.set(key, {
          kind,
          key,
          at,
          view: withOpenRoles(parseListView(value, at, ctx.data), value, at, ctx),
        });
      else if (kind === 'form')
        views.set(key, {
          kind,
          key,
          at,
          form: withOpenRoles(parseFormView(value, at), value, at, ctx),
        });
      else if (kind === 'landing') views.set(key, { kind, key, at, raw: value });
      return true;
    });
    if (!parsed) failed.add(key);
  }
  for (const [key, value] of entries) {
    if (failed.has(key)) continue;
    const said: string[] = [];
    gather(said, () => {
      const at = `${where}: views "${key}"`;
      const raw = unfolded.get(key) ?? (value as Record<string, unknown>);
      const parsed =
        raw.kind === 'dashboard'
          ? parseDashboardView(raw, key, at, ctx.data, views, Boolean(ctx.auth))
          : raw.kind === 'page'
            ? parsePageView(raw, key, at, ctx)
            : undefined;
      if (parsed)
        views.set(key, {
          ...parsed,
          view: withOpenRoles(parsed.view, raw, at, ctx),
        });
    });
    /* A dashboard over a list that did not parse would only restate that list's refusal. */
    problems.push(...said.filter((problem) => ![...failed].some((bad) => problem.includes(`"${bad}"`))));
  }
  if (problems.length) throw new AppProblems(problems);
  /* The checks across views are independent of each other too: each is gathered, so the menu's typo and the home's
     are said in one run, and only the reachability walk, which reads both, waits until they parse. */
  const across: string[] = [];
  const order = entries.map(([key]) => key);
  const apiViews = ctx.api?.views.map((entry) => entry.view) ?? [];
  for (const key of apiViews) {
    if (views.get(key)?.kind !== 'list') across.push(`${where}: api.views.${key} must reference an existing list view.`);
  }
  const ofKind = <K extends ParsedView['kind']>(kind: K) =>
    order.map((key) => views.get(key)!).filter((view): view is Extract<ParsedView, { kind: K }> => view.kind === kind);

  const forms = ofKind('form');
  if (forms.length && !ctx.auth?.roles) {
    across.push(`${where}: form views require "auth" and "auth.roles". A form runs a command, and commands need both.`);
  } else gather(across, () => checkForms(forms, ctx));
  for (const source of ofKind('list')) {
    const action = source.view.empty?.action;
    if (!action) continue;
    const target = views.get(action.view);
    /* A signed-in form is a room too, so "No canned responses: write one" opens the form that writes one. A public
       form is served at its own address, outside the App, and is the landing's to link. */
    const signedInForm = target?.kind === 'form' && !target.form.public;
    if (!target || (target.kind !== 'list' && target.kind !== 'dashboard' && !signedInForm)) {
      across.push(`${source.at}, "empty.action.view" names "${action.view}", which is not a list, a dashboard or a signed-in form view.`);
    }
  }
  /* A dashboard note may point at a list or dashboard. It becomes a
     room only when this dashboard is reached from nav, home, a landing or a
     reachable dashboard; final payload projection still removes lost targets. */
  for (const source of ofKind('dashboard')) {
    for (const section of [...source.view.sections, ...(source.view.aside ?? [])]) {
      if (section.kind !== 'note' || !section.action || 'to' in section.action) continue;
      const target = views.get(section.action.view);
      if (!target || (target.kind !== 'list' && target.kind !== 'dashboard')) {
        across.push(`${source.at}, note action names "${section.action.view}", which is not a list or dashboard view.`);
      }
    }
  }
  const publicForms = new Set(forms.filter((view) => view.form.public).map((view) => view.key));
  /* What a landing may open and show: the public forms, and — with
     `auth.public` — every list and dashboard whose tables the public reads
     all of, as a signed-out home may name (appHome.ts). */
  const publicReads = new Set(ctx.auth?.public?.read ?? []);
  const openLists = new Map(
    ofKind('list')
      .filter((view) => publicReads.has(view.view.table))
      .map((view) => [view.key, view.view]),
  );
  const openViews = new Set([
    ...openLists.keys(),
    ...ofKind('dashboard')
      .filter((view) => view.tables.length && view.tables.every((table) => publicReads.has(table)))
      .map((view) => view.key),
  ]);
  const images = new Set(
    Object.entries(ctx.data.resources ?? {})
      .filter(([name, resource]) => resource.file && publicReads.has(name))
      .map(([name]) => name),
  );
  const landingsSaid = across.length;
  const landings = ofKind('landing').flatMap((view) => {
    const landing = gather(across, () =>
      parseLandingView(view.raw, view.at, {
        forms: publicForms,
        views: openViews,
        lists: openLists,
        images,
      }),
    );
    return landing ? [{ key: view.key, landing }] : [];
  });
  /* A landing that did not parse names nothing: what it would have opened is not known, so nothing is judged unreached. */
  const landingsRead = across.length === landingsSaid;
  const landingKeys = landings.flatMap(({ landing }) => landingViews(landing));
  /* A landing is the signed-out front page: what it shows or opens is for visitors who hold no role. */
  for (const key of landingKeys) {
    const view = views.get(key);
    const roles =
      view?.kind === 'form' ? view.form.roles : view?.kind === 'list' || view?.kind === 'dashboard' ? view.view.roles : undefined;
    if (roles)
      across.push(
        `${view!.at} names "roles", and the landing opens it to signed-out visitors, who hold none. Remove "roles", or the landing's link to it.`,
      );
  }
  if (landings.length > 1)
    across.push(`${where}: views "${landings[0].key}" and "${landings[1].key}" are both landings. An App has one front page.`);
  if (landings.length && !ctx.auth) {
    across.push(
      `${where}: a landing view requires "auth". An App without sign-in has no signed-out front door — every visitor already sees the App.`,
    );
  }

  /* An assistant with a page of its own is a room nav may place, by its word, as a view is (appAssistant.ts). */
  const assistantPage =
    isRecord(a.assistant) && Array.isArray(a.assistant.placement) && (a.assistant.placement as unknown[]).includes('page');
  if (assistantPage && views.has(ASSISTANT_ROOM))
    across.push(
      `${where}: views "${ASSISTANT_ROOM}" takes the word the assistant's page is placed by (assistant placement 'page'). Give the view another key.`,
    );
  const nav = gather(across, () => parseNav(a.nav, where, views, order, assistantPage));
  const homeViews = new Map<string, HomeView>(
    order.map((key) => {
      const view = views.get(key)!;
      if (view.kind === 'form') {
        return [
          key,
          {
            kind: 'form',
            tables: [],
            command: view.form.command.id,
            ...(view.form.public ? { public: true as const } : {}),
            ...(view.form.roles ? { roles: view.form.roles } : {}),
          },
        ];
      }
      const roles = view.kind === 'landing' ? undefined : view.view.roles;
      return [
        key,
        {
          kind: view.kind,
          tables: view.kind === 'list' ? [view.view.table] : view.kind === 'dashboard' ? view.tables : [],
          ...(roles ? { roles } : {}),
        },
      ];
    }),
  );
  const rules = gather(across, () => parseHome(a.home, where, homeViews, ctx.auth, resourceCeiling(ctx.data).read, ctx.name));
  /* What nothing opens is judged only once the menu, the home and the landing are all known: one that did not parse
     would make every room it names look orphaned. */
  if (!nav || !rules || !landingsRead) throw new AppProblems(across);
  // The assistant's room is nav's to place and no view's: nothing below serves it as one.
  const navKeys = navViewKeys(nav).filter((key) => views.has(key));

  /* A list, dashboard or signed-in form view nothing can open is a typo or
     an orphan; either way it would go unserved without a word. A public
     form is opened at its own address. Dashboard embeds, the lists metrics
     open and note actions are
     traversed only after a root reaches their dashboard: two orphan notes
     pointing at each other never manufacture a room. */
  /* A list a record's page embeds is opened by that page: a thread's posts, drawn only on the thread. */
  const pageEmbeds = Object.values(isRecord(a.pages) ? a.pages : {}).flatMap((page) =>
    (isRecord(page) && Array.isArray(page.sections) ? page.sections : []).flatMap((section) =>
      isRecord(section) && section.kind === 'view' && typeof section.view === 'string' ? [section.view] : [],
    ),
  );
  /* The header's New menu opens its views and the forms of its commands (ui.shell.new; app.ts checks the names). */
  const rawNew = (isRecord(a.ui) && isRecord(a.ui.shell) && Array.isArray(a.ui.shell.new) ? a.ui.shell.new.filter(isRecord) : []).flatMap(
    (entry) => (Array.isArray(entry.children) ? entry.children.filter(isRecord) : [entry]),
  );
  const newKeys = [
    ...rawNew.flatMap((entry) => (typeof entry.view === 'string' && views.has(entry.view) ? [entry.view] : [])),
    ...forms.filter(({ form }) => !form.public && rawNew.some((entry) => entry.command === form.command.id)).map(({ key }) => key),
  ];
  const reachable = new Set([...navKeys, ...rules.map((rule) => rule.view), ...landingKeys, ...apiViews, ...pageEmbeds, ...newKeys]);
  for (const key of reachable) {
    const view = views.get(key);
    if (view?.kind !== 'dashboard') continue;
    for (const target of [
      ...view.embeds,
      ...[...view.view.sections, ...(view.view.aside ?? [])].flatMap((section) =>
        section.kind === 'note' && section.action && 'view' in section.action
          ? [section.action.view]
          : section.kind === 'metric' && section.view
            ? [section.view]
            : section.kind === 'firstRun'
              ? (section.steps ?? []).map((step) => step.view)
              : [],
      ),
    ])
      reachable.add(target);
  }
  for (const key of order) {
    const view = views.get(key)!;
    if (view.kind === 'form' && !view.form.public && !reachable.has(key)) {
      across.push(
        `${view.at} is a signed-in form referenced by nothing — not nav, not home, not the New menu (ui.shell.new) — so nothing could open it. Reference it, or remove it.`,
      );
    }
    if (view.kind === 'dashboard' && !reachable.has(key)) {
      across.push(
        `${view.at} is referenced by nothing — not nav, not home, not a reachable dashboard's embed, metric or note action, or a landing's { kind: 'view' } section — so nothing could open it. Reference it, or remove it.`,
      );
    }
  }
  if (across.length) throw new AppProblems(across);
  /* A list nothing links to is still a list: a view is everything a visitor
     can open, and `nav` arranges the menu over some of them. An unlinked one
     is served at its address and offered by ⌘K, and no menu lists it — the
     lookup lists an ops App keeps (a code table, a log) without crowding the
     side menu. A dashboard stays refused: what it opens is only reached
     through it, and an orphan pair must not manufacture rooms. */
  for (const key of order) if (views.get(key)!.kind === 'list') reachable.add(key);
  /* So is a free-form page: served at its address, which another page or a component may link to with nav: false. */
  for (const key of order) {
    const view = views.get(key)!;
    if (view.kind === 'dashboard' && view.view.page) reachable.add(key);
  }

  /* The served set includes every ordinary root and every room a reachable
     dashboard opens. Navigation still decides the sidebar; an action target
     is a room only after its source dashboard is independently reachable. */
  const served: Record<string, AppListView | AppDashboardView | AppFormView> = {};
  for (const key of reachable) {
    const view = views.get(key)!;
    if (view.kind === 'landing' || (view.kind === 'form' && view.form.public)) continue;
    served[key] = view.kind === 'form' ? view.form : view.view;
  }
  /* Then the public forms, which no menu names: each is served at its own address. */
  for (const view of forms) if (view.form.public) served[view.key] = view.form;
  const [landing] = landings;
  return {
    views: served,
    nav,
    home: rules.map(({ at: _at, ...rule }) => rule),
    ...(landing ? { landing: { view: landing.key, content: landing.landing } } : {}),
  };
}

/*
 * A form's command is granted like any other, and for a signed-in form the
 * grant is its whole audience: one whose command no role holds could be
 * opened by nobody. A command a form runs creates its rows and names none,
 * so no action runs it on a record too.
 */
function checkForms(forms: readonly FormView[], ctx: ContentContext): void {
  const grants = Object.values(ctx.auth?.roles ?? {});
  const actions = Object.entries(ctx.data.resources ?? {}).flatMap(([name, resource]) =>
    (resource.actions ?? []).flatMap((action) => (action.command ? [{ name, id: action.command.id }] : [])),
  );
  for (const { at, form } of forms) {
    const id = form.command.id;
    const acting = actions.find((action) => action.id === id);
    if (acting) {
      throw new Error(
        `${at} runs the command "${id}", which an action on resources "${acting.name}" also runs. ` +
          "A form's command creates records and names none; an action's names the record it acts on. Register a command for each.",
      );
    }
    if (form.public) continue;
    /* Under "auth.rows" a signed-in form is served too: its command runs in
       the member's scope, so a row it inserts must land inside it (the scoped
       transaction refuses one that does not), and a tenant's owner column is
       the runtime's to fill, never the handler's. */
    if (!grants.some((grant) => grant.commands?.includes(id))) {
      throw new Error(
        `${at} runs the command "${id}", which no role in auth.roles is granted, so nobody could open the form. Grant it in auth.roles.<role>.commands.`,
      );
    }
  }
}

function viewKind(value: Record<string, unknown>, at: string): ParsedView['kind'] {
  const kind = value.kind;
  if (kind === undefined) {
    /* A view without its kind: say which one its keys suggest. */
    if (Object.hasOwn(value, 'sections')) throw new Error(`${at} has no "kind"; a dashboard view says kind: 'dashboard'.`);
    if (Object.hasOwn(value, 'from')) throw new Error(`${at} has no "kind"; a list view says kind: 'list'.`);
    throw new Error(
      `${at} has no "kind". A view is one of: list, dashboard, form or landing, written with listView(), dashboard(), commandForm() or landing(); a free-form page is a pages/*.page.tsx file.`,
    );
  }
  if (kind !== 'list' && kind !== 'dashboard' && kind !== 'landing' && kind !== 'form' && kind !== 'page') {
    throw new Error(
      `${at} has a "kind" of "${String(kind)}". A view is one of: list, dashboard, form or landing, written with listView(), dashboard(), commandForm() or landing(); a free-form page is a pages/*.page.tsx file.`,
    );
  }
  /* A free-form page is served as the dashboard that draws it (parsePageView). */
  return kind === 'page' ? 'dashboard' : kind;
}

/* ---------- list views ---------- */

/* A board or a split is a key of the list view that carries its options, so the view says which it is by the key and
   the two cannot be written together; the rest draw through `presentation`, written with their helpers. Both parse to
   the one `presentation` the rest of the platform reads. */
function listPresentation(v: Record<string, unknown>, at: string): AppListPresentation | undefined {
  const keyed = (['board', 'split'] as const).filter((key) => v[key] !== undefined);
  const kind = isRecord(v.presentation) ? v.presentation.kind : undefined;
  if (kind === 'board' || kind === 'split') {
    throw new Error(
      `${at} has a "presentation" of kind "${kind}". A ${kind} is a key of the list view: ${kind}: { ${kind === 'board' ? "by: 'status', primary: 'name'" : "detail: ['name']"} }.`,
    );
  }
  if (keyed.length + (v.presentation === undefined ? 0 : 1) > 1) {
    throw new Error(
      `${at} has ${[...keyed.map((key) => `"${key}"`), ...(v.presentation === undefined ? [] : ['"presentation"'])].join(' and ')}. A list draws its rows one way: a board, a split or a presentation.`,
    );
  }
  if (keyed.length === 0) return v.presentation === undefined ? undefined : parsePresentation(v.presentation, at);
  const key = keyed[0];
  if (!isRecord(v[key])) throw new Error(`${at}: "${key}" must be an object${key === 'board' ? ' with at least "by"' : ''}.`);
  allowKeys(
    v[key] as Record<string, unknown>,
    PRESENTATION_KEYS[key].filter((name) => name !== 'kind'),
    `${at}, "${key}"`,
  );
  return parsePresentation({ ...(v[key] as object), kind: key }, at);
}

/* A text filter's suggestions: the distinct values of a few of the list's own columns, offered as the reader types.
   Keyed by the filter they fill, which the list must declare: a suggestion for a box nobody draws is a typo. */
function parseSuggest(raw: unknown, filters: string[] | undefined, at: string): Record<string, string[]> {
  const where = `${at}, "suggest"`;
  if (!isRecord(raw) || !Object.keys(raw).length)
    throw new Error(
      `${where} must name a text filter and the columns whose values it suggests, like suggest: { title: ['make', 'model'] }.`,
    );
  const declared = (filters ?? []).map((name) => name.trim());
  return Object.fromEntries(
    Object.entries(raw).map(([filter, columns]) => {
      if (!declared.includes(filter))
        throw new Error(`${where} names "${filter}", which is not one of this list's "filters". Suggestions fill a filter the list draws.`);
      if (
        !Array.isArray(columns) ||
        !columns.length ||
        columns.some((column) => typeof column !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column.trim()))
      )
        throw new Error(`${where}, "${filter}" must be a list of the resource's own column names, like ['make', 'model'].`);
      return [filter, [...new Set((columns as string[]).map((column) => column.trim()))]];
    }),
  );
}

function parseListView(v: Record<string, unknown>, at: string, data: ParsedData): AppListView {
  allowKeys(v, [...LIST_VIEW_KEYS, 'realm'], at, LIST_VIEW_RENAMED);
  if (typeof v.from !== 'string' || !v.from.trim()) throw new Error(`${at} has no "from": a list view shows the rows of one resource.`);
  const table = v.from.trim();
  checkResourceSlot(table, `${at}, "from"`, data);
  checkDeclaredResource(table, `${at}, "from"`, data);
  const resource = data.resources![table];
  if (v.advancedFilters !== undefined && typeof v.advancedFilters !== 'boolean') {
    throw new Error(`${at}: "advancedFilters" must be true or false.`);
  }
  if (typeof v.filterBar === 'boolean')
    throw new Error(`${at}: "filterBar" is now one of 'bar', 'rail' or 'none': ${v.filterBar ? "true is 'bar'" : "false is 'none'"}.`);
  if (v.filterBar !== undefined && !FILTER_BARS.includes(v.filterBar as FilterBar)) {
    throw new Error(`${at}: "filterBar" must be 'bar', 'rail' (the filters as a rail of facets beside the rows) or 'none'.`);
  }
  if (v.quickAdd !== undefined && typeof v.quickAdd !== 'boolean') {
    throw new Error(`${at}: "quickAdd" must be true (inline resources.${table}.form, or the schema's New form) or false.`);
  }
  if (v.open === 'peek') throw new Error(`${at} has an "open" of "peek", which is now "drawer", as the New form's is.`);
  if (v.open !== undefined && !(OPEN_MODES as readonly unknown[]).includes(v.open)) {
    throw new Error(`${at} has an "open" of "${String(v.open)}". Use "page", "drawer" or "modal".`);
  }
  if (v.filters !== undefined && !Array.isArray(v.filters)) throw new Error(`${at} has "filters" that are not a list of column names.`);
  /* A filter across a reference or over the rows that point at the record is held as the words its condition
     starts with (listFilters.ts), so everything downstream reads one kind of filter. */
  const filters = (v.filters as unknown[] | undefined)?.map((filter) => listFilterKey(filter, at));
  const words = new Map<string, string>();
  for (const filter of filters ?? []) {
    const word = filterAddressWord(filter);
    if (words.has(word)) throw new Error(`${at} names the filter "${words.get(word)}" twice.`);
    words.set(word, filter);
  }
  const suggest = v.suggest === undefined ? undefined : parseSuggest(v.suggest, filters, at);
  const importing = v.import === undefined ? undefined : parseViewImport(v.import, at);
  if (importing && !importing.command && resource.access !== 'write') {
    throw new Error(
      `${at} has "import" over resources "${table}", which the App does not write; importing creates records, which needs access 'write'.`,
    );
  }
  const presentation = listPresentation(v, at);
  if (presentation?.kind === 'calendar')
    for (const [i, span] of (presentation.backdrop ?? []).entries()) {
      const here = `${at}, presentation, backdrop${(presentation.backdrop?.length ?? 0) > 1 ? ` ${i + 1}` : ''}, "from"`;
      checkResourceSlot(span.from, here, data);
      checkDeclaredResource(span.from, here, data);
    }
  const empty = v.empty === undefined ? undefined : parseListEmpty(v.empty, at);
  if (empty && (presentation?.kind === 'calendar' || presentation?.kind === 'tree' || presentation?.kind === 'gantt')) {
    throw new Error(
      `${at} has "empty" and a ${presentation.kind} presentation. A ${presentation.kind} reads its own rows, so use its ordinary empty state.`,
    );
  }
  /* A split's list is the narrow pane beside a record; a rail beside it would leave the rows no room. */
  if (v.filterBar === 'rail' && presentation?.kind === 'split') {
    throw new Error(
      `${at} has filterBar 'rail' and a split presentation. A rail sits beside a full list; a split's list keeps the bar (or filterBar: 'none').`,
    );
  }
  /* A board over a machine's column reads its lanes from the machine (app.ts withMachineLanes): one order, said once. */
  if (presentation?.kind === 'board' && presentation.lanes !== undefined && resource?.machine?.column === presentation.by) {
    throw new Error(
      `${at}: presentation "lanes" orders "${presentation.by}", which the machine of resources.${table} moves; ` +
        'its lanes are the machine\'s states in its order. Drop "lanes".',
    );
  }
  /* A card's place is the reader's to change by hand; a column the resource moves only through its actions never is. */
  if (presentation?.kind === 'board' && presentation.order !== undefined && resource?.machine?.column === presentation.order) {
    throw new Error(
      `${at}: presentation "order" names "${presentation.order}", which the machine of resources.${table} moves. ` +
        "A card's place is the reader's to change; name another numeric column.",
    );
  }
  let totals: string[] | undefined;
  if (v.totals !== undefined) {
    if (
      !Array.isArray(v.totals) ||
      !v.totals.length ||
      v.totals.some((c) => typeof c !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c))
    ) {
      throw new Error(`${at} has "totals" that are not a list of the resource's own numeric columns.`);
    }
    if (new Set(v.totals).size !== v.totals.length) throw new Error(`${at} has "totals" that name one column twice.`);
    if (presentation) throw new Error(`${at} has "totals" and a ${presentation.kind} presentation; a footer of totals belongs to a grid.`);
    totals = v.totals as string[];
  }
  if (v.rowActions !== undefined) {
    if (typeof v.rowActions !== 'boolean') throw new Error(`${at}: "rowActions" must be true (a ⋯ menu on each row) or false.`);
    if (v.rowActions && presentation)
      throw new Error(`${at} has "rowActions" and a ${presentation.kind} presentation; a row menu belongs to a grid.`);
  }
  const editable = parseEditable(v, at, table, resource, presentation);
  if (v.density !== undefined && v.density !== 'comfortable' && v.density !== 'compact') {
    throw new Error(`${at} has a "density" of "${String(v.density)}". Use "comfortable" or "compact".`);
  }
  /* Row height and column sizing are a grid's. A split's list is drawn as
     one; the card presentations draw no grid for either to reach. */
  for (const key of ['density', 'sizing'] as const) {
    if (v[key] !== undefined && presentation && presentation.kind !== 'split') {
      throw new Error(
        `${at} has "${key}" and a ${presentation.kind} presentation; ${key === 'density' ? 'a row height' : 'column sizing'} belongs to a grid.`,
      );
    }
  }
  /* A join table's list opens the record each row is about. The grid's rows only: a card, a lane or a
     split's pick is drawn and acted on as the row it is. */
  if (v.opens !== undefined) {
    if (typeof v.opens !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.opens.trim())) {
      throw new Error(`${at}: "opens" must name one of the resource's reference columns, whose record a row opens.`);
    }
    if (presentation)
      throw new Error(`${at} has "opens" and a ${presentation.kind} presentation; a row opens another record from a grid only.`);
  }
  if (presentation?.kind === 'split' && v.open !== undefined) {
    throw new Error(`${at} has "open" and a split presentation, which opens its rows in its own detail pane. Remove "open".`);
  }
  let actions: string[] | undefined;
  if (v.actions !== undefined) {
    if (!Array.isArray(v.actions)) throw new Error(`${at} has "actions" that are not a list of action ids.`);
    if (presentation?.kind !== 'queue' && presentation?.kind !== 'board' && presentation?.kind !== 'custom') {
      throw new Error(
        `${at} has "actions", which only a queue, a board or a custom list takes: a grid, a checklist or a split draws no actions, and a record page offers every one of resources.${table}.actions.`,
      );
    }
    const declared = (resource.actions ?? []).map((action) => action.id);
    actions = v.actions.map((id, i) => {
      if (typeof id !== 'string' || !id.trim()) {
        throw new Error(`${at}, "actions" entry ${i + 1} is not an action id: a view lists the ids of resources.${table}.actions.`);
      }
      if (!declared.includes(id.trim())) {
        throw new Error(
          `${at}, "actions" names "${id.trim()}", which resources.${table}.actions does not declare. ` +
            (declared.length ? `It declares: ${declared.join(', ')}.` : 'It declares no actions.'),
        );
      }
      return id.trim();
    });
    if (new Set(actions).size !== actions.length) throw new Error(`${at} has "actions" that name one action twice.`);
  }
  /* The list's order, one key: "created_on desc" is how it reads when
     nothing else says one, and a list of named orders is the Sort menu a
     reader chooses from, the first of them the order the list opens in.
     Written like the query bar, so a chosen one is the query's own sort
     clause and the address carries it; the opening one is kept out of the
     bar, as a hand order is: it is the view's reading, not a question
     anyone asked. A tab's sort clause wins over it, and the menu over both.
     A hand order already is one, and a sort in the standing query would
     read every tab its own way. */
  let sort: string | undefined;
  let sorts: Array<{ label: string; sort: string }> | undefined;
  if (v.sort !== undefined) {
    if (Array.isArray(v.sort)) {
      if (v.sort.length < 2 || v.sort.length > 8)
        throw new Error(`${at} has a "sort" list that is not two to eight { label, sort }: one order is a string, "created_on desc".`);
      sorts = v.sort.map((entry, i) => {
        const here = `${at}, sort ${i + 1}`;
        if (!isRecord(entry)) throw new Error(`${here} is not an object { label, sort }.`);
        allowKeys(entry, ['label', 'sort'], here);
        if (typeof entry.label !== 'string' || !entry.label.trim() || entry.label.trim().length > 40)
          throw new Error(`${here} needs a "label" of at most 40 characters.`);
        if (typeof entry.sort !== 'string' || !SORT_TEXT.test(entry.sort)) {
          throw new Error(`${here} has a "sort" that is not written like the query bar: "price", "price desc", "year desc, mileage".`);
        }
        return {
          label: entry.label.trim(),
          sort: entry.sort.trim().replace(/\s+/g, ' '),
        };
      });
      if (new Set(sorts.map((entry) => entry.label)).size !== sorts.length)
        throw new Error(`${at} has a "sort" list with one label twice.`);
      sort = sorts[0]!.sort;
    } else if (typeof v.sort !== 'string' || !SORT_TEXT.test(v.sort)) {
      throw new Error(
        `${at} has a "sort" that is not written like the query bar ("created_on desc", "year desc, mileage") or a list of named orders, [{ label: 'Newest', sort: 'listed_on desc' }, …].`,
      );
    } else sort = v.sort.trim().replace(/\s+/g, ' ');
    if (v.order !== undefined) {
      throw new Error(
        `${at} has "sort" and "order": a hand order is the list's own reading already, kept in "${String(v.order).trim()}". Keep one.`,
      );
    }
    if (presentation?.kind === 'board' || presentation?.kind === 'calendar') {
      throw new Error(`${at} has "sort" and a ${presentation.kind} presentation, which orders its cards itself.`);
    }
  }
  /* A hand order: the numeric column each row's place is kept in, read
     ascending wherever nothing else sorts the question. A sort in the
     standing query would win on every tab, so the order could never be read
     and is refused; a tab's own sort, a header and the Sort menu are readings
     of their own, and hide the handles while they last. */
  let order: string | undefined;
  if (v.order !== undefined) {
    if (typeof v.order !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.order.trim())) {
      throw new Error(`${at}: "order" must name one of the resource's own numeric columns, holding each row's place in the list.`);
    }
    order = v.order.trim();
    if (presentation?.kind === 'board') {
      throw new Error(`${at} has "order" and a board presentation; a board keeps its cards' places in its presentation's "order".`);
    }
    if (
      presentation?.kind === 'calendar' ||
      presentation?.kind === 'split' ||
      presentation?.kind === 'tree' ||
      presentation?.kind === 'gantt'
    ) {
      const which = {
        calendar: 'puts each record on its day',
        split: 'reads its list beside a record',
        tree: 'puts each record under its parent',
        gantt: 'puts each record on its dates',
      }[presentation.kind];
      throw new Error(
        `${at} has "order" and a ${presentation.kind} presentation, which ${which}. ` +
          'A hand order is for a grid, a checklist, a queue or cards.',
      );
    }
    if (resource?.machine?.column === order) {
      throw new Error(
        `${at}: "order" names "${order}", which the machine of resources.${table} moves. ` +
          "A row's place is the reader's to change; name another numeric column.",
      );
    }
  }
  /* Single keys for the picked record's actions, in a split: the pane's header shows each beside its verb.
     Authored `shortcuts`; kept as the view's `keys`. */
  let keys: Record<string, string> | undefined;
  if (v.shortcuts !== undefined) {
    if (presentation?.kind !== 'split')
      throw new Error(`${at} has "shortcuts", which a split takes: they act on the record picked beside the list.`);
    if (!isRecord(v.shortcuts) || !Object.keys(v.shortcuts).length)
      throw new Error(`${at}: "shortcuts" must be an object of one key to an action id: { e: 'escalate' }.`);
    const declared = (resource?.actions ?? []).map((action) => action.id);
    keys = {};
    for (const [key, id] of Object.entries(v.shortcuts)) {
      if (!/^[a-z0-9]$/.test(key) || key === 'j' || key === 'k') {
        throw new Error(`${at}, "shortcuts" has "${key}": a key is one lowercase letter or digit, and J and K are the walk's own.`);
      }
      if (typeof id !== 'string' || !declared.includes(id.trim())) {
        throw new Error(
          `${at}, "shortcuts" maps "${key}" to ${JSON.stringify(id)}, which resources.${table}.actions does not declare. ` +
            (declared.length ? `It declares: ${declared.join(', ')}.` : 'It declares no actions.'),
        );
      }
      keys[key] = id.trim();
    }
    if (new Set(Object.values(keys)).size !== Object.keys(keys).length)
      throw new Error(`${at} has "shortcuts" that give one action two keys.`);
  }
  if (v.heading !== undefined && v.heading !== false) throw new Error(`${at}: "heading" is false, to draw the list without its title.`);
  /* A standing query is the conditions every tab reads under: the order is `sort`, the columns `show`. */
  const standingQuery = optionalText(v, 'query', at);
  if (standingQuery !== undefined) conditionsOnly(standingQuery, at);
  return {
    table,
    ...(sorts ? { sorts } : {}),
    ...(sort ? { sort } : {}),
    ...(order ? { order } : {}),
    ...(v.label === undefined ? {} : { label: parseCaption(v.label, `${at}.label`) }),
    ...(v.path === undefined ? {} : { path: parseRoutePath(v.path, at) }),
    ...(v.icon === undefined ? {} : { icon: parseIcon(v.icon, at) }),
    ...(v.realm === undefined ? {} : { realm: parseRealm(v.realm, at) }),
    ...(standingQuery === undefined ? {} : { query: standingQuery }),
    ...(v.show === undefined ? {} : { show: parseShow(v.show, at) }),
    ...(presentation ? { presentation } : {}),
    ...(empty ? { empty } : {}),
    ...(v.tabs === undefined ? {} : { tabs: parseTabs(v.tabs, at) }),
    ...(filters === undefined ? {} : { filters }),
    ...(v.filterBar === undefined ? {} : { filterBar: v.filterBar as FilterBar }),
    ...(suggest ? { suggest } : {}),
    ...(v.advancedFilters === undefined ? {} : { advancedFilters: v.advancedFilters as boolean }),
    ...(v.quickAdd === true ? { quickAdd: true as const } : {}),
    ...(favoriteFlag(v.favorite, at) ? { favorite: true as const } : {}),
    ...(totals ? { totals } : {}),
    ...(v.density === undefined ? {} : { density: v.density as 'comfortable' | 'compact' }),
    ...(v.rowActions === true ? { rowActions: true as const } : {}),
    ...(editable ? { editable } : {}),
    ...(v.open === undefined ? {} : { open: v.open as AppListView['open'] }),
    ...(v.opens === undefined ? {} : { opens: (v.opens as string).trim() }),
    ...(v.sizing === undefined ? {} : { sizing: parseTableSizing(v.sizing, at) }),
    ...(actions ? { actions } : {}),
    ...(importing === undefined ? {} : { import: importing }),
    ...(keys ? { keys } : {}),
    ...(v.heading === false ? { heading: false as const } : {}),
    ...(countFlag(v.count, at) === undefined ? {} : { count: countFlag(v.count, at) }),
  };
}

/* A list's say on its menu count (shared/menuCounts.ts): true or false over the rule. */
function countFlag(value: unknown, at: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${at}: "count" is true or false: whether the menu counts this list.`);
  return value;
}

/**
 * A view's `show`: plain strings, each a column or a dotted label path. The
 * caption is the resource's (`resources.<table>.labels`), wherever it shows.
 */
function parseShow(raw: unknown, at: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`${at} has a "show" that is not a list of column names.`);
  return raw.map((entry, i) => {
    if (typeof entry !== 'string' || !entry.trim()) throw new Error(`${at}, "show" entry ${i + 1} is not a column name or a label path.`);
    return entry.trim();
  });
}

/** What a list that names nothing is called: its records, several of them, as the resource's noun says, else its table's name. */
function listLabel(table: string, data: ParsedData): string {
  const noun = data.resources?.[table]?.noun;
  return noun ? headingOf(noun.many) : humanName(table);
}

/** A dashboard section's captions: the resource's word for each shown column it has one for. */
function labelsFor(show: readonly string[] | undefined, labels: Record<string, string> | undefined): Record<string, string> | undefined {
  const named = (show ?? []).filter((column) => labels !== undefined && Object.hasOwn(labels, column));
  return named.length ? Object.fromEntries(named.map((column) => [column, labels![column]])) : undefined;
}

function parseTabs(raw: unknown, at: string): AppListTab[] {
  if (!Array.isArray(raw)) throw new Error(`${at} has "tabs" that are not an array.`);
  return raw.map((entry, i) => {
    const here = `${at}, tab ${i + 1}`;
    if (!isRecord(entry)) throw new Error(`${here} is not an object.`);
    /* A tab's own order is its `sort`, kept as a sort clause after its conditions —
       "status = open sort due_on" — which every reader of the tab (its
       count, the address, a dashboard's embed) takes as it is, and which
       wins over the view's `sort`. */
    // `segment` is what a tab naming one unfolds to (appSegments.ts); its name is the tab's address.
    allowKeys(entry, ['label', 'query', 'segment', 'sort'], here);
    if (typeof entry.label !== 'string' || !entry.label.trim()) throw new Error(`${here} has no "label".`);
    const query = optionalText(entry, 'query', here);
    const segment = typeof entry.segment === 'string' ? entry.segment : undefined;
    if (query !== undefined) conditionsOnly(query, here);
    if (entry.sort !== undefined && (typeof entry.sort !== 'string' || !SORT_TEXT.test(entry.sort))) {
      throw new Error(`${here} has a "sort" that is not written like the query bar: "due_on", "created_on desc", "year desc, mileage".`);
    }
    const sort = typeof entry.sort === 'string' ? entry.sort.trim().replace(/\s+/g, ' ') : undefined;
    return {
      label: entry.label.trim(),
      query: sort === undefined ? query : `${query ? `${query} ` : ''}sort ${sort}`,
      ...(segment ? { segment, slug: segment } : {}),
    };
  });
}

/** A local column for a card: bare, non-empty, never a path. */
function localColumn(o: Record<string, unknown>, key: string, at: string): string {
  const value = o[key];
  if (typeof value !== 'string' || !value.trim() || value.includes('.'))
    throw new Error(`${at}: "${key}" must name a local column, not a path.`);
  return value.trim();
}

/** A card's title: its own column, or one read through a reference, one hop (`vehicle_id.title`). */
function cardTitle(value: unknown, at: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(value.trim()))
    throw new Error(`${at}: "primary" must be a local column or a one-hop path like "vehicle_id.title".`);
  return value.trim();
}

/** A queue may say a referenced record's name, but never walk past one join. */
function queueColumn(value: unknown, key: string, at: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${at}: "${key}" must be a local column or a one-hop label path like "employee_id.name".`);
  }
  const name = value.trim();
  /* Keep legacy local names verbatim (apart from outer whitespace): before
     paths, a local column was any non-empty spelling without a dot. */
  if (!name.includes('.')) return name;
  if (/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
  throw new Error(`${at}: "${key}" must be a local column or a one-hop label path like "employee_id.name".`);
}

/**
 * A calendar's shaded spans: one kind or a list of them, each another
 * resource's rows from one of its date columns to another, labeled by a third
 * and shaded in a display tone. The resource is checked as declared where the
 * view is (parseListView), and its columns against the catalog (listProblem).
 */
function parseCalendarBackdrop(raw: unknown, at: string): AppCalendarBackdrop[] {
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length || list.length > CALENDAR_BACKDROPS_MAX) {
    throw new Error(
      `${at}: a calendar shades one to ${CALENDAR_BACKDROPS_MAX} kinds of span, like { from: 'blackout', start: 'starts_on', end: 'ends_on', labelColumn: 'name' }.`,
    );
  }
  return list.map((entry, i) => {
    const here = list.length > 1 ? `${at} ${i + 1}` : at;
    if (!isRecord(entry)) throw new Error(`${here} is not { from, start, end, labelColumn }.`);
    allowKeys(entry, ['from', 'start', 'end', 'labelColumn', 'tone'], here, BACKDROP_RENAMED);
    if (typeof entry.from !== 'string' || !entry.from.trim())
      throw new Error(`${here} has no "from": the resource whose rows are the spans, like 'blackout'.`);
    const start = localColumn(entry, 'start', here);
    const end = localColumn(entry, 'end', here);
    const labelColumn = localColumn(entry, 'labelColumn', here);
    if (entry.tone !== undefined && !(DISPLAY_TONES as readonly unknown[]).includes(entry.tone)) {
      throw new Error(`${here} has a "tone" of "${String(entry.tone)}". Use ${DISPLAY_TONES.join(', ')}.`);
    }
    return {
      from: entry.from.trim(),
      start,
      end,
      labelColumn,
      ...(entry.tone === undefined ? {} : { tone: entry.tone as AppCalendarBackdrop['tone'] }),
    };
  });
}

/**
 * How a list's rows draw: a checklist, a queue, a board — each a card of one
 * `primary` column and up to its `lines` — or a split list/detail workspace.
 * Local readable columns only for the cards, refused by name, so an author
 * learns one grammar.
 */
/** Shared shape validation for authored lists and captured App embeds. */
export function parsePresentation(raw: unknown, at: string): AppListPresentation {
  const here = `${at}, presentation`;
  if (!isRecord(raw)) throw new Error(`${here} must be a checklist, queue, board, calendar, tree, gantt, cards, split or custom object.`);
  const kind = raw.kind;
  /* The author's own component draws the rows; the list around them is the platform's. */
  if (kind === 'custom') return parseCustomList(raw, `${here} (a custom list)`);
  if (
    kind !== 'checklist' &&
    kind !== 'queue' &&
    kind !== 'board' &&
    kind !== 'calendar' &&
    kind !== 'tree' &&
    kind !== 'gantt' &&
    kind !== 'cards' &&
    kind !== 'split'
  ) {
    throw new Error(`${here} needs a "kind" of "checklist", "queue", "board", "calendar", "tree", "gantt", "cards", "split" or "custom".`);
  }
  allowKeys(raw, PRESENTATION_KEYS[kind], `${here} (a ${kind})`, PRESENTATION_RENAMED[kind as keyof typeof PRESENTATION_RENAMED]);
  if (kind === 'split') return parseSplit(raw, `${here} (a split)`);
  if (kind === 'gantt') {
    const start = localColumn(raw, 'start', here);
    const end = localColumn(raw, 'end', here);
    if (end === start) throw new Error(`${here}: "end" names "${end}", the same column as "start"; a bar needs the column it ends on.`);
    return {
      kind,
      start,
      end,
      primary: queueColumn(raw.primary, 'primary', here),
      ...(raw.by === undefined ? {} : { by: queueColumn(raw.by, 'by', here) }),
      ...(raw.progress === undefined ? {} : { progress: localColumn(raw, 'progress', here) }),
    };
  }
  /* A card with no title of its own is titled by its record's name, `$label`, which resolving the view against
     the catalog makes the path that name is read from (appCards.ts cardsTitled). */
  /* A board, a queue or a calendar with no `primary` says the record's name too: resolving the list against the
     catalog reads it where the resource names its records (app.ts titledPresentation). */
  const primary =
    (kind === 'board' || kind === 'queue' || kind === 'calendar') && raw.primary === undefined
      ? LABEL_SEGMENT
      : kind === 'queue' || kind === 'calendar' || kind === 'tree' || kind === 'board'
        ? queueColumn(raw.primary, 'primary', here)
        : kind === 'cards' && raw.primary === undefined
          ? LABEL_SEGMENT
          : kind === 'cards'
            ? cardTitle(raw.primary, here)
            : localColumn(raw, 'primary', here);
  /* A card's captioned values are its `properties`; every other presentation's quiet lines under the title are `lines`.
     The model keeps one list for both. */
  const linesKey = kind === 'cards' ? 'properties' : 'lines';
  const rawLines = raw[linesKey];
  let lines: string[] = [];
  if (rawLines !== undefined) {
    const max = MAX_LINES[kind];
    if (!Array.isArray(rawLines) || rawLines.length > max) {
      throw new Error(`${here}: "${linesKey}" must be a list of at most ${max} local column${max === 1 ? '' : 's'} beneath the primary.`);
    }
    /* Cards, queues and calendars may say a referenced record's name; the
       other presentations' lines stay the row's own columns. */
    lines = rawLines.map((_, i) => {
      const line = (rawLines as unknown[])[i];
      if (kind === 'queue' || kind === 'calendar' || kind === 'tree') return queueColumn(line, String(i), `${here}, lines`);
      if (kind !== 'cards') return localColumn(rawLines as unknown as Record<string, unknown>, String(i), `${here}, lines`);
      if (typeof line !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(line.trim())) {
        throw new Error(`${here}, properties: a card's property is a local column or a one-hop label path like "dealer_id.name".`);
      }
      return line.trim();
    });
  }
  if (kind === 'checklist')
    return {
      kind,
      primary,
      checked: localColumn(raw, 'checked', here),
      ...(lines.length ? { lines } : {}),
    };
  if (kind === 'tree')
    return {
      kind,
      parent: localColumn(raw, 'parent', here),
      primary,
      ...(lines.length ? { lines } : {}),
    };
  if (kind === 'queue') {
    let facts: string[] | undefined;
    if (raw.properties !== undefined) {
      if (!Array.isArray(raw.properties) || !raw.properties.length || raw.properties.length > 6) {
        throw new Error(`${here}: "properties" must be one to 6 local columns or one-hop label paths.`);
      }
      facts = raw.properties.map((fact, i) => queueColumn(fact, String(i), `${here}, properties`));
    }
    const badge = raw.badge === undefined ? undefined : queueColumn(raw.badge, 'badge', here);
    const openLabel = raw.openLabel;
    if (openLabel !== undefined && (typeof openLabel !== 'string' || !openLabel.trim())) {
      throw new Error(`${here}: "openLabel" must be a non-empty string.`);
    }
    return {
      kind,
      primary,
      ...(lines.length ? { lines } : {}),
      ...(facts?.length ? { facts } : {}),
      ...(badge === undefined ? {} : { badge }),
      ...(typeof openLabel === 'string' ? { openLabel: openLabel.trim() } : {}),
    };
  }
  if (kind === 'calendar') {
    const date = localColumn(raw, 'date', here);
    /* A range: the record spans its days from `date` to `end`, both its own
       columns, so a move can shift the two together. */
    const end = raw.end === undefined ? undefined : localColumn(raw, 'end', here);
    if (end !== undefined && end === date)
      throw new Error(`${here}: "end" names "${end}", the same column as "date"; a range needs the column its last day is in.`);
    const badge = raw.badge === undefined ? undefined : queueColumn(raw.badge, 'badge', here);
    const backdrop = raw.backdrop === undefined ? undefined : parseCalendarBackdrop(raw.backdrop, `${here}, backdrop`);
    return {
      kind,
      date,
      ...(end === undefined ? {} : { end }),
      primary,
      ...(lines.length ? { lines } : {}),
      ...(badge === undefined ? {} : { badge }),
      ...(backdrop ? { backdrop } : {}),
    };
  }
  if (kind === 'cards') return parseCards(raw, `${here} (cards)`, primary, lines);
  const by = localColumn(raw, 'by', here);
  let lanes: string[] | undefined;
  if (raw.lanes !== undefined) {
    if (
      !Array.isArray(raw.lanes) ||
      !raw.lanes.length ||
      raw.lanes.length > 8 ||
      raw.lanes.some((lane) => typeof lane !== 'string' || !lane.trim())
    ) {
      throw new Error(`${here}: "lanes" must be one to eight non-empty lane values.`);
    }
    lanes = (raw.lanes as string[]).map((lane) => lane.trim());
    if (new Set(lanes).size !== lanes.length) throw new Error(`${here}: "lanes" must be unique.`);
  }
  const order = raw.order === undefined ? undefined : localColumn(raw, 'order', here);
  const swimlanes = raw.swimlanes === undefined ? undefined : localColumn(raw, 'swimlanes', here);
  /* A row, a lane and a place are three questions; one column cannot answer two of them. */
  if (swimlanes !== undefined && (swimlanes === by || swimlanes === order)) {
    throw new Error(
      `${here}: "swimlanes" names "${swimlanes}", which is already the board's "${swimlanes === by ? 'by' : 'order'}". Rows need a column of their own.`,
    );
  }
  let limits: Record<string, number> | undefined;
  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits) || !Object.keys(raw.limits).length) {
      throw new Error(`${here}: "limits" must be an object of lane values to whole numbers, like { in_progress: 4 }.`);
    }
    limits = {};
    for (const [key, n] of Object.entries(raw.limits)) {
      const lane = key.trim();
      if (!lane) throw new Error(`${here}: "limits" has a blank lane value.`);
      if (lanes && !lanes.includes(lane))
        throw new Error(`${here}: "limits" names "${lane}", which is not one of its "lanes" (${lanes.join(', ')}).`);
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 999) {
        throw new Error(`${here}: "limits.${lane}" must be a whole number from 1 to 999: the lane's work-in-progress limit.`);
      }
      limits[lane] = n;
    }
  }
  const category = raw.category === undefined ? undefined : localColumn(raw, 'category', here);
  if (category !== undefined && category === by)
    throw new Error(`${here}: "category" names "${category}", the board's "by": every card in a lane would wear the lane's chip.`);
  const footer = raw.footer === undefined ? undefined : parseBoardFooter(raw.footer, here);
  const sum = raw.sum === undefined ? undefined : localColumn(raw, 'sum', here);
  if (sum !== undefined && sum === by)
    throw new Error(`${here}: "sum" names "${sum}", the board's "by": a lane's own value is not an amount.`);
  let folded: string[] | undefined;
  if (raw.folded !== undefined) {
    if (
      !Array.isArray(raw.folded) ||
      !raw.folded.length ||
      raw.folded.length > 8 ||
      raw.folded.some((lane) => typeof lane !== 'string' || !lane.trim())
    )
      throw new Error(`${here}: "folded" must be one to eight lane values, like ['won', 'lost'].`);
    folded = (raw.folded as string[]).map((lane) => lane.trim());
    const stray = lanes && folded.find((lane) => !lanes!.includes(lane));
    if (stray) throw new Error(`${here}: "folded" names "${stray}", which is not one of its "lanes" (${lanes!.join(', ')}).`);
  }
  return {
    kind,
    by,
    ...(lanes ? { lanes } : {}),
    ...(order === undefined ? {} : { order }),
    ...(swimlanes === undefined ? {} : { swimlanes }),
    ...(limits ? { limits } : {}),
    primary,
    ...(lines.length ? { lines } : {}),
    ...(category === undefined ? {} : { category }),
    ...(footer ? { footer } : {}),
    ...(sum === undefined ? {} : { sum }),
    ...(folded ? { folded: [...new Set(folded)] } : {}),
  };
}

/** A card's foot: one to four local columns, each bare or `{ column, icon }`. */
function parseBoardFooter(raw: unknown, here: string): AppBoardFact[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 4)
    throw new Error(`${here}: "footer" must be one to four local columns, each a name or { column, icon }.`);
  const facts = raw.map((item, index): AppBoardFact => {
    const at = `${here}, footer[${index}]`;
    if (typeof item === 'string') return { column: localColumn({ column: item }, 'column', at) };
    if (!isRecord(item)) throw new Error(`${at} must be a local column or { column, icon }.`);
    allowKeys(item, ['column', 'icon'], at);
    return {
      column: localColumn(item, 'column', at),
      ...(item.icon === undefined ? {} : { icon: parseIcon(item.icon, at) }),
    };
  });
  const seen = new Set<string>();
  for (const fact of facts) {
    if (seen.has(fact.column)) throw new Error(`${here}: "footer" names "${fact.column}" twice.`);
    seen.add(fact.column);
  }
  return facts;
}

/**
 * A split draws the view's own list — its show, query, tabs and filter bar —
 * beside the record the reader picks, so all it says itself is the detail's
 * fields and the list's page size. The detail is headed by the resource's
 * noun, as New is.
 */
function parseSplit(input: Record<string, unknown>, at: string): AppSplitListDetail {
  const result: AppSplitListDetail = { kind: 'split' };
  if (input.detail !== undefined) {
    if (!Array.isArray(input.detail) || input.detail.length > 64) {
      throw new Error(`${at}: "detail" must be a list of at most 64 columns or label paths: the picked record's fields.`);
    }
    const detail = parseShow(input.detail, `${at}, detail`);
    if (new Set(detail).size !== detail.length) throw new Error(`${at}: "detail" names one column twice.`);
    result.detail = detail;
  }
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 200) {
      throw new Error(`${at}: "limit" must be an integer from 1 to 200: the list's page size.`);
    }
    result.limit = input.limit as number;
  }
  if (input.row !== undefined) {
    /* The queue's vocabulary: a split's rows are the queue's rows, narrowed to the pane beside a record. */
    const here = `${at}, "row"`;
    if (!isRecord(input.row)) throw new Error(`${here} must be an object: { primary, lines, properties, badge, avatar }.`);
    allowKeys(input.row, ['primary', 'lines', 'properties', 'badge', 'avatar'], here, PRESENTATION_RENAMED.queue);
    const row = input.row;
    const primary = queueColumn(row.primary, 'primary', here);
    if (row.lines !== undefined && (!Array.isArray(row.lines) || row.lines.length > MAX_LINES.queue)) {
      throw new Error(`${here}: "lines" must be a list of at most ${MAX_LINES.queue} columns beneath the primary.`);
    }
    const lines = ((row.lines ?? []) as unknown[]).map((line, i) => queueColumn(line, String(i), `${here}, lines`));
    if (row.properties !== undefined && (!Array.isArray(row.properties) || !row.properties.length || row.properties.length > 6)) {
      throw new Error(`${here}: "properties" must be one to 6 local columns or one-hop label paths.`);
    }
    const facts = ((row.properties ?? []) as unknown[]).map((fact, i) => queueColumn(fact, String(i), `${here}, properties`));
    result.row = {
      primary,
      ...(lines.length ? { lines } : {}),
      ...(facts.length ? { facts } : {}),
      ...(row.badge === undefined ? {} : { badge: queueColumn(row.badge, 'badge', here) }),
      ...(row.avatar === undefined ? {} : { avatar: queueColumn(row.avatar, 'avatar', here) }),
    };
  }
  return result;
}

/* ---------- dashboard views ---------- */

function parseDashboardView(
  v: Record<string, unknown>,
  key: string,
  at: string,
  data: ParsedData,
  views: ReadonlyMap<string, ParsedView>,
  signsIn: boolean,
): DashboardView {
  allowKeys(v, [...DASHBOARD_VIEW_KEYS, 'realm'], at, DASHBOARD_VIEW_RENAMED);
  if (typeof v.label !== 'string' || !v.label.trim()) throw new Error(`${at} is a dashboard and has no "label".`);
  /* A dashboard-level "from" is the sections' default — a board over one
     table should not repeat its name six times. A section that names its
     own still wins. */
  const description = optionalText(v, 'description', at);
  /* The words over the sections when they are not the menu's: "Hello, {me.name}". */
  /* false: the title is not drawn (it stays for a screen reader); the menu and the tab keep the label. */
  const heading = v.heading === false ? undefined : optionalText(v, 'heading', at);
  checkGreeting(heading, `${at}, "heading"`, signsIn);
  checkGreeting(description, `${at}, "description"`, signsIn);
  const table = optionalText(v, 'from', at);
  if (table) {
    checkResourceSlot(table, `${at}, "from"`, data);
    checkDeclaredResource(table, `${at}, "from"`, data);
  }
  if (
    v.windows !== undefined &&
    (!Array.isArray(v.windows) || !v.windows.length || v.windows.some((w) => typeof w !== 'string' || !w.trim()))
  ) {
    throw new Error(`${at} has "windows" that are not a list of phrases like "last 30 days".`);
  }
  /* The window it opens on, one of the windows it offers; an address's `?period=` still wins. */
  const offered = ((v.windows as string[] | undefined) ?? DEFAULT_WINDOWS).map((w) => w.trim().replace(/\s+/g, ' '));
  const opensOn = typeof v.window === 'string' ? v.window.trim().replace(/\s+/g, ' ') : undefined;
  if (v.window !== undefined && (!opensOn || !offered.includes(opensOn)))
    throw new Error(
      `${at} has a "window" of ${JSON.stringify(v.window)}, which is not one of the windows it offers: ${offered.map((w) => JSON.stringify(w)).join(', ')}.`,
    );
  if (v.windowControl !== undefined && v.windowControl !== 'segmented' && v.windowControl !== 'button')
    throw new Error(`${at} has a "windowControl" of ${JSON.stringify(v.windowControl)}. Use "segmented" or "button".`);
  if (v.filters !== undefined && (!Array.isArray(v.filters) || v.filters.some((f) => typeof f !== 'string' || !f.trim()))) {
    throw new Error(`${at} has "filters" that are not a list of column names.`);
  }
  if (!Array.isArray(v.sections)) throw new Error(`${at} needs "sections": a list of at least one section.`);
  if (v.aside !== undefined && !Array.isArray(v.aside)) throw new Error(`${at} has an "aside" that is not a list of sections.`);
  const embeds: string[] = [];
  const sections = parseDashSections(v.sections, at, table, data, views, embeds);
  const aside = Array.isArray(v.aside) ? parseDashSections(v.aside, `${at}, "aside"`, table, data, views, embeds, true) : undefined;
  nameSectionWindows([...sections, ...(aside ?? [])], at);
  const areas = parseAreas(v.areas, at, sections, aside !== undefined);
  /* The sections' default is one only while a section inherits it: a table
     every section names again for itself is read by nothing. */
  if (
    table &&
    ![...(v.sections as unknown[]), ...((v.aside as unknown[] | undefined) ?? [])].some(
      (s) =>
        isRecord(s) &&
        s.kind !== 'note' &&
        s.kind !== 'view' &&
        s.kind !== 'firstRun' &&
        s.kind !== 'activity' &&
        s.kind !== 'find' &&
        s.kind !== 'branding' &&
        s.kind !== 'integrations' &&
        s.from === undefined,
    )
  ) {
    throw new Error(`${at} has a "from" that no section inherits: every section names its own "from". Remove it.`);
  }
  return {
    kind: 'dashboard',
    key,
    at,
    embeds,
    tables: [...new Set([...sections, ...(aside ?? [])].map((section) => section.table).filter((name): name is string => Boolean(name)))],
    view: {
      label: v.label.trim(),
      ...(heading === undefined ? {} : { heading }),
      ...(v.heading === false ? { headingHidden: true as const } : {}),
      ...(description === undefined ? {} : { description }),
      sections,
      ...(aside === undefined ? {} : { aside }),
      ...(areas === undefined ? {} : { areas }),
      ...(v.path === undefined ? {} : { path: parseRoutePath(v.path, at) }),
      ...(v.icon === undefined ? {} : { icon: parseIcon(v.icon, at) }),
      ...(v.realm === undefined ? {} : { realm: parseRealm(v.realm, at) }),
      ...(v.windows === undefined ? {} : { windows: (v.windows as string[]).map((w) => w.trim()) }),
      ...(opensOn === undefined ? {} : { window: opensOn }),
      ...(v.windowControl === 'button' ? { windowControl: 'button' as const } : {}),
      ...(v.filters === undefined ? {} : { filters: (v.filters as string[]).map((f) => f.trim()) }),
      ...(favoriteFlag(v.favorite, at) ? { favorite: true as const } : {}),
    },
  };
}

/**
 * The keys of a free-form page as the App loader writes it from a
 * `pages/*.page.tsx` file (packages/mistri/src/server/app/appPages.ts) — never authored in
 * `views`, which refuses the kind. `heading` and `props` are the internal
 * Console's, whose pages are written as data.
 */
const PAGE_VIEW_KEYS = [
  'kind',
  'label',
  'icon',
  'description',
  'heading',
  'favorite',
  'component',
  'reads',
  'commands',
  'params',
  'loader',
  'props',
  'roles',
  'public',
] as const;

/**
 * A free-form page: the whole page drawn by the author's component. It is
 * served as a dashboard of one full-width custom section — so its menu
 * entry, its home rule, its address and its favorite star are a
 * dashboard's, with nothing to learn twice — which says `page`: the
 * resources it reads, which gate it like a section's table gates a
 * dashboard (a reader who cannot read one is not served the page), the
 * commands it runs, the address parameters it keeps its place in and the
 * loader that reads for it on the server.
 *
 * Who is offered it is said once, here, by what it reads: every role a page
 * names must be granted every read, or the page is a mistake some role would
 * meet broken; one that names none is offered to the people's roles that
 * are — never a service role, which no person holds — and never to a
 * signed-out visitor unless it says `public: true`, when every read must be
 * one `auth.public` opens. A command is not a door: a reader the page is
 * offered to who may not run one of its commands meets the page without it
 * (the command's handle says `granted: false`, and the server refuses it as
 * it refuses any command not granted). A command no role offered the page
 * may run is a mistake, as an unreadable read is.
 */
function parsePageView(v: Record<string, unknown>, key: string, at: string, ctx: ContentContext): DashboardView {
  allowKeys(v, PAGE_VIEW_KEYS, `${at} (a free-form page)`);
  if (typeof v.label !== 'string' || !v.label.trim()) throw new Error(`[page-file] ${at} is a free-form page and has no "title".`);
  const page = parsePage(v, at);
  for (const resource of page.reads) {
    checkResourceSlot(resource, `${at}, "reads"`, ctx.data);
    checkDeclaredResource(resource, `${at}, "reads"`, ctx.data);
  }
  for (const command of page.commands) {
    if (!isRegisteredCommand(command)) {
      throw new Error(`[page-commands] ${at} runs the command "${command}", which the commands module does not register.`);
    }
  }
  if (v.public !== undefined && v.public !== true) throw new Error(`[page-public] ${at} has a "public" that is not true.`);
  /* A public page's commands are run by a signed-out visitor through the page's own door (http/pageCommandRoutes.ts),
     as the public principal: only a command that is itself public, and one that makes its record rather than naming
     one, the way a public form's is. A signed-in page's need roles to be granted to. */
  if (v.public === true) {
    for (const command of page.commands) {
      const entry = registeredCommand(command);
      if (entry?.public !== true)
        throw new Error(
          `[page-commands] ${at} is public and runs "${command}", which is not public: a public page runs only commands that say public: true.`,
        );
      if (entry.targets !== 'none')
        throw new Error(`[page-commands] ${at} is public and runs "${command}", which names a record; a public command makes its own.`);
    }
    if (page.commands.length && !ctx.auth)
      throw new Error(`[page-commands] ${at} runs public commands, and a public command needs "auth" (with "auth.public").`);
  } else if (page.commands.length && !ctx.auth?.roles)
    throw new Error(`[page-commands] ${at} runs commands, and commands need "auth" and "auth.roles".`);
  const roles = pageRoles(v, page, at, ctx);
  const description = optionalText(v, 'description', at);
  if (v.heading !== undefined && v.heading !== false) throw new Error(`${at}: a page's "heading" is false, to draw it without its title.`);
  return {
    kind: 'dashboard',
    key,
    at,
    embeds: [],
    tables: page.reads,
    view: {
      ...(v.heading === false ? { headingHidden: true as const } : {}),
      label: v.label.trim(),
      ...(description === undefined ? {} : { description }),
      sections: [
        {
          kind: 'custom',
          component: page.component,
          props: page.props,
          width: 'full',
        },
      ],
      page: {
        reads: page.reads,
        commands: page.commands,
        params: page.params,
        ...(page.loader ? { loader: page.loader } : {}),
        ...(v.public === true ? { public: true as const } : {}),
      },
      ...(v.icon === undefined ? {} : { icon: parseIcon(v.icon, at) }),
      ...(favoriteFlag(v.favorite, at) ? { favorite: true as const } : {}),
      ...(roles ? { roles } : {}),
    },
  };
}

/**
 * The roles a free-form page is offered to. Named, each must be granted
 * what the page reads (`page-coverage`); unnamed, the roles that are, but
 * a service role. Either way each command it runs must be some offered
 * role's. A public page names none: it is everyone's, a signed-out
 * visitor's too, and reads only what `auth.public` opens.
 */
function pageRoles(
  v: Record<string, unknown>,
  page: { reads: string[]; commands: string[] },
  at: string,
  ctx: ContentContext,
): string[] | undefined {
  const grants = ctx.auth?.roles;
  if (v.public === true) {
    if (v.roles !== undefined) throw new Error(`[page-public] ${at} is public and names "roles": a public page is everyone's.`);
    const open = new Set(ctx.auth?.public?.read ?? []);
    if (!ctx.auth?.public)
      throw new Error(`[page-public] ${at} is public, and the App opens nothing to signed-out visitors (auth.public).`);
    const closed = page.reads.find((resource) => !open.has(resource));
    if (closed) throw new Error(`[page-public] ${at} is public and reads "${closed}", which "auth.public" does not open.`);
    return undefined;
  }
  if (!grants) return parseOpenRoles(v.roles, at, ctx.auth);
  const reads = (grant: AppRoleGrant, resource: string) =>
    grant.read === true || (Array.isArray(grant.read) && grant.read.includes(resource));
  const unread = (grant: AppRoleGrant): string | undefined => page.reads.find((resource) => !reads(grant, resource));
  /* Each command is some offered role's to run, or no one could: a mistake, as an unreadable read is. */
  const runnable = (offered: readonly string[]) => {
    const stray = page.commands.find((command) => !offered.some((role) => (grants[role].commands ?? []).includes(command)));
    if (stray !== undefined) {
      throw new Error(
        `[page-coverage] ${at} runs "${stray}", which no role it is offered to is granted. Grant it to one, or leave it out of "commands".`,
      );
    }
  };
  const named = parseOpenRoles(v.roles, at, ctx.auth);
  if (named) {
    for (const role of named) {
      const missing = unread(grants[role]);
      if (missing !== undefined) {
        throw new Error(
          `[page-coverage] ${at} is offered to the role "${role}", which is not granted "${missing}". ` +
            'Every role a page names reads all it reads: grant it, or leave the role out.',
        );
      }
    }
    runnable(named);
    return named;
  }
  const able = Object.keys(grants).filter((role) => !grants[role].service && unread(grants[role]) === undefined);
  if (!able.length) {
    throw new Error(
      `[page-coverage] ${at} reads what no person's role is granted all of, so no one could open it. Grant a role, or narrow the page.`,
    );
  }
  runnable(able);
  return able;
}

/** A view with the roles it names, checked against the App's (appViewRoles.ts). */
function withOpenRoles<V extends object>(view: V, raw: Record<string, unknown>, at: string, ctx: ContentContext): V & { roles?: string[] } {
  const roles = parseOpenRoles(raw.roles, at, ctx.auth);
  return roles ? { ...view, roles } : view;
}

/** A section kind as a noun: "a metric", "a rows section" — "a rows" is not English. */
/** Keys a dashboard section kind took under another name, with what they are now. */
const RENAMED_SECTION_KEYS: Record<string, Record<string, string>> = {
  metric: { view: '"to": metric(title, from, { to: \'overdue_list\' }) opens the list view it names' },
  custom: {
    totals: '"figures": the named aggregate reads its component receives as figures.<name> ("totals" is a list\'s footer of sums)',
  },
};

const sectionWord = (kind: string) => (kind === 'rows' ? 'rows section' : kind);

/** The target's standing filter stays ahead of a metric's own refinement,
    both when parsed and when its compare/window is derived (app.ts). */
export function metricCohortQuery(standingQuery: string | undefined, refinement: string | undefined): string | undefined {
  const standing = andQuery(splitClauseTail(standingQuery ?? '').head);
  const own = andQuery(splitClauseTail(refinement ?? '').head);
  // A normalized section may be parsed again. Only a whole leading
  // conjunction counts as already scoped; an `or` is bracketed above.
  return (standing && own !== standing && !own.startsWith(`${standing} and `) ? andQuery(standing, own) : own) || undefined;
}

function parseDashSections(
  raw: unknown[],
  at: string,
  defaultTable: string | undefined,
  data: ParsedData,
  views: ReadonlyMap<string, ParsedView>,
  embeds: string[],
  aside = false,
): AppDashSection[] {
  if (!raw.length) throw new Error(`${at}: a dashboard needs at least one section.`);
  /* Each section is judged on its own: one run names every section's refusal (appProblems.ts). */
  const problems: string[] = [];
  const sections = raw.map((entry, i) =>
    gather(problems, (): AppDashSection => {
      const here = `${at}, section ${i + 1}`;
      if (!isRecord(entry)) throw new Error(`${here} is not an object.`);
      const s = entry;
      if (s.kind === 'view') {
        const section = embedSection(s, here, views, data, aside);
        embeds.push(s.view as string);
        return section;
      }
      const kind = String(s.kind ?? '');
      if (!(DASH_KINDS as readonly string[]).includes(kind)) {
        throw new Error(
          `${here} has an unknown kind "${kind}". Use "metric", "breakdown", "rows", "chart", "note", "matrix", "funnel", "board", "firstRun", "custom", "activity", "find", "branding", "integrations" or "view", each written with its helper: metric(), breakdown(), rows(), chart(), note(), matrix(), funnel(), board(), firstRun(), custom(), activity(), find(), brandingForm(), integrationsForm(), embed().`,
        );
      }
      if (kind === 'firstRun') {
        if (aside) throw new Error(`${here} is a first run, which stands in the dashboard's main flow: move it into "sections".`);
        if (raw.filter((other) => isRecord(other) && other.kind === 'firstRun').length > 1) {
          throw new Error(`${at} has more than one first run. One list of first steps is the start; put every step in it.`);
        }
        return firstRunSection(s, here, views);
      }
      /* Per kind, so `show` on a metric or `over` on a note is refused rather
       than read by nothing — `over` on a note used to switch the whole
       dashboard's window controls on for a section the window never reached.
       A key another kind reads is named as that kind's ("only a chart
       carries"); a key no kind reads is a typo and gets the list. */
      const takes = SECTION_KEYS[kind as AppDashSection['kind']];
      for (const key of Object.keys(s)) {
        if (takes.includes(key) || /^[$_]/.test(key)) continue;
        /* A key renamed within its own kind is told as the rename: "only a view carries" for a metric's `view` sent the
           author to the embed, when the card's destination is `to`. */
        const renamed = RENAMED_SECTION_KEYS[kind]?.[key];
        if (renamed) throw new Error(`${here} has "${key}", which is now ${renamed}.`);
        const owners = (Object.keys(SECTION_KEYS) as Array<AppDashSection['kind']>).filter((k) => SECTION_KEYS[k].includes(key));
        if (owners.length) throw new Error(`${here} has "${key}", which only a ${owners.map(sectionWord).join(' or ')} carries.`);
        throw new Error(`${here} (a ${sectionWord(kind)}) ${unknownKey(key, takes, keyHomesOf(key))}.`);
      }
      if (kind === 'custom') return parseCustomDashSection(s, here, data);
      if (kind === 'activity') return parseActivitySection(s, here, data);
      if (kind === 'find') return parseFindSection(s, here, data);
      /* The tenant's own Branding form: what it may change is the App's `branding` (checked at the root). The
         integrations' settings form is the same shape: what it shows is the jobs module's, read from the server. */
      if (kind === 'branding' || kind === 'integrations') {
        if (s.title !== undefined && (typeof s.title !== 'string' || !s.title.trim()))
          throw new Error(`${here} has a "title" that is not text.`);
        if (s.width !== undefined && !WIDTHS.includes(String(s.width) as SectionWidth))
          throw new Error(`${here} has a "width" of "${String(s.width)}". Use ${WIDTHS.join(', ')}.`);
        return {
          kind,
          ...(s.title === undefined ? {} : { title: (s.title as string).trim() }),
          ...(s.icon === undefined ? {} : { icon: parseIcon(s.icon, here) }),
          ...(s.width === undefined ? {} : { width: s.width as SectionWidth }),
        };
      }
      let banner: Pick<AppDashSection, 'variant' | 'eyebrow' | 'image'> = {};
      if (kind === 'note') {
        if (typeof s.text !== 'string' || !s.text.trim()) throw new Error(`${here} is a note and has no "text".`);
        if (s.action !== undefined) {
          parseAppLinkAction(s.action, `${here}, "action"`);
        }
        banner = parseNoteBanner(s, here, data);
      } else if (s.from === undefined ? !defaultTable : typeof s.from !== 'string' || !s.from.trim()) {
        throw new Error(
          `${here} has no "from"${
            defaultTable === undefined ? ' — name one, or set a dashboard-level "from" for every section to inherit' : ''
          }.`,
        );
      }
      if (typeof s.from === 'string') {
        checkResourceSlot(s.from.trim(), `${here}, "from"`, data);
        checkDeclaredResource(s.from.trim(), `${here}, "from"`, data);
      }
      if ((kind === 'breakdown' || kind === 'chart') && (typeof s.by !== 'string' || !s.by.trim())) {
        throw new Error(`${here} has no "by" — the column its groups are counted under.`);
      }
      let card: string[] | undefined;
      if (kind === 'board') {
        /* Lanes come from values of one of the table's own columns; a
         bucketed or dotted by has no value a card could sit under. */
        if (typeof s.by !== 'string' || !s.by.trim())
          throw new Error(`${here} is a board and has no "by" — the column whose values are its lanes.`);
        if (/[\s.,]/.test(s.by.trim())) {
          throw new Error(
            `${here} has a "by" of "${String(s.by).trim()}" — a board's lanes come from a bare column of its own table, like "status".`,
          );
        }
        if (s.lanes !== undefined) {
          if (
            !Array.isArray(s.lanes) ||
            s.lanes.length < 1 ||
            s.lanes.length > 8 ||
            s.lanes.some((lane) => typeof lane !== 'string' || !lane.trim())
          ) {
            throw new Error(`${here} has "lanes" that are not a list of 1 to 8 nonblank strings.`);
          }
          if (new Set(s.lanes).size !== s.lanes.length)
            throw new Error(`${here} has duplicate "lanes". Each exact lane value may appear only once.`);
        }
        /* The one card vocabulary: a primary line, then its lines, label
         paths welcome. Absent, the card is the table's label column alone;
         lines beneath an unnamed primary would take its place. */
        if (s.primary !== undefined && (typeof s.primary !== 'string' || !s.primary.trim()))
          throw new Error(`${here} has a "primary" that is not a column or a label path.`);
        if (s.lines !== undefined && (!Array.isArray(s.lines) || s.lines.some((line) => typeof line !== 'string' || !line.trim()))) {
          throw new Error(`${here} has "lines" that are not a list of columns or label paths.`);
        }
        const lines = ((s.lines ?? []) as string[]).map((line) => line.trim());
        if (lines.length && s.primary === undefined) {
          throw new Error(
            `${here} has "lines" and no "primary": name the card's first line — the label column stands alone only on a card with no lines.`,
          );
        }
        if (s.primary !== undefined) card = [(s.primary as string).trim(), ...lines];
      }
      if (kind === 'matrix' && (typeof s.by !== 'string' || !s.by.trim() || !s.by.includes(','))) {
        throw new Error(
          `${here} is a matrix and needs a two-key "by" — "stage, month close_date": rows by the first, columns by the second.`,
        );
      }
      if (s.shape === 'funnel')
        throw new Error(
          `${here} has shape: 'funnel', which is now funnel(title, from, stages): ordered stages counted in one statement. Where rows stand now, by one column's values, is breakdown(title, from, column, { shape: 'steps' }).`,
        );
      const stages = kind === 'funnel' ? parseFunnelStages(s, here) : undefined;
      if (kind === 'breakdown') parseStepsShape(s, here);
      else if (s.shape !== undefined && !(DASH_CHART_SHAPES as readonly string[]).includes(String(s.shape))) {
        throw new Error(
          `${here} has a "shape" of "${String(s.shape)}". Use "line", "bar", "donut", "stacked", "scatter", "heatmap", "waterfall" or "treemap".`,
        );
      }
      if (kind === 'chart') parseChartShape(s, here);
      /* `auto` is a chart's word (autoBucket.ts): a breakdown lists its groups and a matrix crosses two fixed keys, and
         neither can have its unit move with the window; a heatmap's grid is a fixed grid of cells. */
      if (typeof s.by === 'string' && /(^|,)\s*auto\b/i.test(s.by)) {
        if (kind === 'matrix' || s.shape === 'heatmap') {
          throw new Error(
            `${here} is a ${kind === 'matrix' ? 'matrix' : 'heatmap'}, whose keys must both be fixed: "auto" picks a unit from the window, and a grid's cells cannot move with it. Write the unit, like "month close_date".`,
          );
        }
        if (kind !== 'chart') {
          throw new Error(
            `${here} has an "auto" key, which only a chart takes: its unit follows the window. Write the unit, like "month close_date".`,
          );
        }
        if (!autoKeyOf(s.by)) throw new Error(`${here} has a "by" of "${s.by.trim()}": "auto" cuts a date column, like "auto created_at".`);
      }
      if (s.shape === 'stacked' && (typeof s.by !== 'string' || !s.by.trim() || !s.by.includes(','))) {
        throw new Error(`${here} is a stacked chart and needs a two-key "by" — "region, stage": a bar for each region, divided by stage.`);
      }
      /* A goal a line or a bar can be measured against; a donut has no scale to rule it on. */
      /* A metric's goal may be read from data — a measure over a table and a query, in the metric's own words;
       a chart's rule is a number. */
      let target: number | DashTarget | undefined;
      /* A breakdown's goal is a row per group (G76): a seller's won against their quota, the target table's `by`
         matching each group's key, windowed by its own `over` as the section is by its. */
      const grouped = kind === 'breakdown';
      if (grouped && s.target !== undefined && (s.target === null || typeof s.target !== 'object' || Array.isArray(s.target)))
        throw new Error(
          `${here} has a "target" that is not a goal per group: { from, by, measure, over? }, a quota's amount by its owner.`,
        );
      if (grouped && s.target !== undefined && s.shape === 'steps')
        throw new Error(`${here} is drawn as steps, which have no bar to measure a "target" on.`);
      if (
        s.target !== undefined &&
        (kind === 'metric' || grouped) &&
        s.target !== null &&
        typeof s.target === 'object' &&
        !Array.isArray(s.target)
      ) {
        const t = s.target as Record<string, unknown>;
        const keys = grouped ? ['from', 'query', 'measure', 'by', 'over'] : ['from', 'query', 'measure'];
        if (t.table !== undefined)
          throw new Error(`${here} has a "target" with "table", which is now "from": the resource its goal is read from.`);
        const unknown = Object.keys(t).filter((key) => !keys.includes(key));
        if (unknown.length)
          throw new Error(
            grouped
              ? `${here} has a "target" with ${unknown.map((key) => `"${key}"`).join(', ')}. A breakdown's target says "from", "by", "measure", "query" and "over".`
              : `${here} has a "target" with ${unknown.map((key) => `"${key}"`).join(', ')}. A target from data says "from", "query" and "measure", as the metric does.`,
          );
        for (const key of keys) {
          if (t[key] !== undefined && (typeof t[key] !== 'string' || !(t[key] as string).trim()))
            throw new Error(`${here} has a "target" whose "${key}" is not a non-empty string.`);
        }
        if (grouped && (t.by === undefined || /\s|,/.test((t.by as string).trim())))
          throw new Error(`${here} has a "target" with no single "by": the column of its table each group's key is matched on.`);
        if (grouped && typeof s.by === 'string' && /\s|,/.test(s.by.trim()))
          throw new Error(`${here} groups by "${s.by.trim()}"; a target is matched on one plain column's value.`);
        if (t.query === undefined && t.measure === undefined && t.from === undefined)
          throw new Error(`${here} has an empty "target": give a number, or the "from", "query" and "measure" its goal is read from.`);
        if (t.from !== undefined) checkDeclaredResource((t.from as string).trim(), `${here}, "target", "from"`, data);
        if (typeof t.query === 'string') conditionsOnly(t.query, here, 'target');
        target = {
          table: (t.from as string | undefined)?.trim() ?? (typeof s.from === 'string' ? s.from.trim() : defaultTable) ?? '',
          ...(t.query === undefined ? {} : { query: (t.query as string).trim() }),
          measure: ((t.measure ?? s.measure ?? 'count') as string).trim(),
          ...(t.by === undefined ? {} : { by: (t.by as string).trim() }),
          ...(t.over === undefined ? {} : { over: (t.over as string).trim() }),
        };
      } else if (s.target !== undefined) {
        if (typeof s.target !== 'number' || !Number.isFinite(s.target)) {
          throw new Error(
            `${here} has a "target" that is not a number${kind === 'metric' ? ', or the "from", "query" and "measure" its goal is read from' : ''}.`,
          );
        }
        target = s.target;
      }
      if (s.curve !== undefined) {
        if (s.curve !== 'smooth' && s.curve !== 'straight')
          throw new Error(`${here} has a "curve" of ${JSON.stringify(s.curve)}. Use "smooth" or "straight".`);
        if (s.shape !== undefined && s.shape !== 'line')
          throw new Error(`${here} is a ${String(s.shape)} chart; only a line has a "curve".`);
      }
      if (s.total !== undefined) {
        if (s.shape !== 'donut') throw new Error(`${here} has a "total", which names a donut's middle figure; it is not a donut.`);
        if (typeof s.total !== 'string' || !s.total.trim() || s.total.trim().length > 40)
          throw new Error(`${here} has a "total" that is not a few words (at most 40 characters): what the middle figure counts.`);
      }
      if (s.target !== undefined && s.shape === 'donut')
        throw new Error(`${here} is a donut, which has no scale to draw a "target" on. Use a line or stacked bars.`);
      for (const key of ['title', 'query', 'measure', 'x', 'compare', 'by', 'sort', 'over'] as const) {
        if (s[key] !== undefined && (typeof s[key] !== 'string' || !(s[key] as string).trim())) {
          throw new Error(`${here} has a "${key}" that is not a non-empty string.`);
        }
      }
      for (const key of ['query', 'compare'] as const) {
        if (typeof s[key] === 'string' && s[key] !== PREVIOUS_PERIOD) conditionsOnly(s[key] as string, here, key);
      }
      const table = kind === 'note' ? undefined : typeof s.from === 'string' ? s.from.trim() : defaultTable;
      const columns = s.show === undefined ? undefined : parseShow(s.show, here);
      const labels = labelsFor(columns, table ? data.resources?.[table]?.labels : undefined);
      if (s.limit !== undefined && (typeof s.limit !== 'number' || !Number.isInteger(s.limit) || s.limit < 1)) {
        throw new Error(`${here} has a "limit" that is not a positive whole number.`);
      }
      if (s.height !== undefined && (typeof s.height !== 'number' || !Number.isFinite(s.height) || s.height < 120)) {
        throw new Error(`${here} has a "height" that is not a number of pixels (120 or more).`);
      }
      if (s.width !== undefined && !WIDTHS.includes(String(s.width) as SectionWidth)) {
        throw new Error(`${here} has a "width" of "${String(s.width)}". Use ${WIDTHS.join(', ')}.`);
      }
      if (s.better !== undefined) {
        if (!(BETTER as readonly string[]).includes(String(s.better)))
          throw new Error(`${here} has a "better" of "${String(s.better)}". Use "up" or "down".`);
        /* Without "compare" there is no change to colour: advice (appAdvisories), not a refusal. */
      }
      if (s.spark !== undefined && typeof s.spark !== 'boolean') throw new Error(`${here} has a "spark" that is not true or false.`);
      if (s.format !== undefined && !(FIGURE_FORMATS as readonly string[]).includes(String(s.format)))
        throw new Error(`${here} has a "format" of "${String(s.format)}". Use ${FIGURE_FORMAT_WORDS}.`);
      if (s.unit !== undefined && (typeof s.unit !== 'string' || !s.unit.trim() || s.unit.length > 24))
        throw new Error(`${here} has a "unit" that is not a short word said after the figure, like "days".`);
      const windows = parseSectionWindows(s, here);
      /* A metric counts its own query. The list it opens (`to:`) adds only its
       standing conditions — the rows that list can show at all, so the drill
       holds every row counted — never a tab: a tab is where a reader starts,
       not what the list is, and a metric with no query counted the first
       tab's open rows where it meant every row. The drill opens
       the list on exactly the counted rows (its "All" tab, where it has one).
       List plumbing is not part of a measure. Resolve this before windows and
       comparisons are derived, so every read and the drill share a cohort. */
      let opens: string | undefined;
      let query = s.query === undefined ? undefined : (s.query as string).trim();
      let compare = s.compare === undefined ? undefined : (s.compare as string).trim();
      /* A breakdown, chart or matrix says where its groups open the same way (`to: 'view-id'`, or `false` for groups that
         are text); a metric's card is the one doorway of its own. A group's list is judged as a metric's is. */
      const drills = kind === 'breakdown' || kind === 'chart' || kind === 'matrix' || kind === 'funnel';
      /* A metric's card takes false the same way: a figure read where it stands, opening nothing. */
      const doorway = drills || kind === 'metric';
      if (doorway && s.to !== undefined && s.to !== false && typeof s.to !== 'string')
        throw new Error(`${here} has a "to" that is not a list view's key or false.`);
      if ((kind === 'metric' || drills) && s.to !== undefined && s.to !== false) {
        const target = typeof s.to === 'string' ? views.get(s.to.trim()) : undefined;
        if (!target || target.kind !== 'list') {
          const lists = [...views.values()].filter((view) => view.kind === 'list').map((view) => view.key);
          throw new Error(
            `${here} opens "${String(s.to)}", which is not a list view this App declares. Its list views: ${lists.join(', ') || 'none'}.`,
          );
        }
        if (table !== undefined && target.view.table !== table) {
          throw new Error(
            `${here} counts ${table} and opens "${target.key}", a list of ${target.view.table}. ${drills ? 'A group opens a list of the rows it counted.' : 'A metric opens a list of the rows it counted.'}`,
          );
        }
        // An authored clause-only query must not become absent: parsing that
        // section again would silently count every row instead.
        for (const [key, value] of [
          ['query', query],
          ['compare', compare],
        ] as const) {
          if (value !== undefined && !splitClauseTail(value).head) {
            throw new Error(
              `${here} has a "${key}" with no filter conditions. A metric opening a list needs conditions, not only sort, show or limit clauses. ` +
                (key === 'query'
                  ? 'Omit "query" to count every row the target view shows.'
                  : 'Omit "compare" to leave out the comparison.'),
            );
          }
        }
        opens = target.key;
        query = metricCohortQuery(target.view.query, query);
        // A full compare is its own refinement; previous period is derived
        // later from the effective query.
        if (compare && compare !== PREVIOUS_PERIOD) compare = metricCohortQuery(target.view.query, compare);
      }
      /* The aside is a narrow column: rows there read as names, each with a
       quiet line under it and a value at its end — never a table's columns. */
      if (aside && kind === 'rows' && columns && columns.length > 3) {
        throw new Error(
          `${here} shows ${columns.length} columns. Rows in the aside draw as a name, a line under it and a value at its end: show at most three, or move them into "sections".`,
        );
      }
      /* What a section with nothing does: a rows section says so in place (guidance) or leaves itself out; the others
         leave themselves out. A dashboard has no 'collapse': the sections do not sit in a run of empty lists. */
      if (s.empty === false) throw new Error(`${here} has "empty: false", which is now "empty: 'hide'".`);
      if (s.empty === 'collapse')
        throw new Error(
          `${here} has "empty: 'collapse'", which only a record page's related lists take. A dashboard section that has nothing says so in place (rows take guidance) or is left out with "empty: 'hide'".`,
        );
      if (s.empty !== undefined && s.empty !== 'hide' && kind !== 'rows')
        throw new Error(
          `${here} (a ${sectionWord(kind)}) takes "empty: 'hide'", which leaves it out while it has nothing; guidance is a rows section's.`,
        );
      const emptyMode = s.empty === 'hide' ? ('hide' as const) : undefined;
      return {
        ...(opens === undefined ? {} : { view: opens }),
        ...(doorway && s.to === false ? { noDrill: true as const } : {}),
        kind: kind as AppDashSection['kind'],
        title: s.title === undefined ? undefined : String(s.title).trim(),
        table,
        text: s.text === undefined ? undefined : (s.text as string).trim(),
        /* A section's mark: beside its title, or a note's over its guidance. */
        ...(s.icon !== undefined ? { icon: parseIcon(s.icon, here) } : {}),
        ...(kind === 'note' && s.action !== undefined ? { action: parseAppLinkAction(s.action, `${here}, "action"`) } : {}),
        ...banner,
        query,
        measure: s.measure === undefined ? undefined : (s.measure as string).trim(),
        compare,
        better: s.better as AppDashSection['better'],
        spark: s.spark as boolean | undefined,
        ...(s.format === undefined ? {} : { format: s.format as AppDashSection['format'] }),
        ...(s.unit === undefined ? {} : { unit: (s.unit as string).trim() }),
        by: s.by === undefined ? undefined : (s.by as string).trim(),
        ...(stages ? { stages } : {}),
        ...(s.lanes === undefined ? {} : { lanes: [...(s.lanes as string[])] }),
        shape: s.shape as AppDashSection['shape'],
        ...(typeof s.x === 'string' ? { x: s.x.trim() } : {}),
        ...(s.curve === undefined ? {} : { curve: s.curve as 'smooth' | 'straight' }),
        ...(typeof s.total === 'string' ? { total: s.total.trim() } : {}),
        ...(s.notes === undefined
          ? {}
          : {
              notes: Object.fromEntries(Object.entries(s.notes as Record<string, string>).map(([k, v]) => [k, v.trim()])),
            }),
        over: s.over === undefined ? undefined : (s.over as string).trim(),
        ...(windows ? { windows } : {}),
        show: card ?? columns,
        ...(labels ? { labels } : {}),
        sort: s.sort === undefined ? undefined : (s.sort as string).trim(),
        ...(s.sizing === undefined ? {} : { sizing: parseTableSizing(s.sizing, here) }),
        ...(kind === 'rows' && s.empty !== undefined && !emptyMode ? { empty: parseListEmpty(s.empty, here) } : {}),
        ...(emptyMode ? { emptyMode } : {}),
        limit: s.limit as number | undefined,
        width: s.width as SectionWidth | undefined,
        ...(s.height === undefined ? {} : { height: s.height as number }),
        ...(target === undefined ? {} : { target }),
      };
    }),
  );
  /* Where a section stands on the layout is read beside its kind's keys, since every kind takes it the same way. */
  raw.forEach((entry, i) => {
    if (!isRecord(entry) || entry.area === undefined) return;
    gather(problems, () => {
      const here = `${at}, section ${i + 1}`;
      if (aside) throw new Error(`${here} has an "area", and the aside is not on the areas: an aside is a column of its own.`);
      if (entry.kind === 'firstRun')
        throw new Error(`${here} is a first run, which leads the dashboard outside its areas: it takes no "area".`);
      if (typeof entry.area !== 'string' || !isAreaName(entry.area.trim()))
        throw new Error(
          `${here} has an "area" that is not an area name: a lowercase word like "trend" (letters, digits and hyphens, at most 24).`,
        );
      if (entry.width !== undefined)
        throw new Error(`${here} has a "width" beside its "area": the area sets its width. Remove the "width".`);
      const section = sections[i];
      if (section) section.area = entry.area.trim();
    });
  });
  if (problems.length) throw new AppProblems(problems);
  return sections as AppDashSection[];
}

/**
 * A list view drawn inside a dashboard, read-only like any dashboard list:
 * the rows the view's room opens on (its standing query and a tab, or the
 * split's list query), drawn as its presentation reads — a grid or split as
 * a list of its show, a checklist or queue as a list of its card, a board as
 * a board. The dashboard's window and pick filters apply as to any section.
 */
function embedSection(
  s: Record<string, unknown>,
  at: string,
  views: ReadonlyMap<string, ParsedView>,
  data: ParsedData,
  aside: boolean,
): AppDashSection {
  allowKeys(s, VIEW_SECTION_KEYS, `${at} (a view)`);
  const listViews = [...views.values()].filter((view) => view.kind === 'list').map((view) => view.key);
  const parsed = typeof s.view === 'string' ? views.get(s.view) : undefined;
  if (!parsed || parsed.kind !== 'list') {
    throw new Error(
      `${at} embeds "${String(s.view)}", which is not a list view this App declares. Its list views: ${listViews.join(', ') || 'none'}.`,
    );
  }
  const { key, view } = parsed;
  const title = optionalText(s, 'title', at);
  const over = optionalText(s, 'over', at);
  if (s.width !== undefined && !WIDTHS.includes(String(s.width) as SectionWidth)) {
    throw new Error(`${at} has a "width" of "${String(s.width)}". Use ${WIDTHS.join(', ')}.`);
  }
  if (s.limit !== undefined && (typeof s.limit !== 'number' || !Number.isInteger(s.limit) || s.limit < 1)) {
    throw new Error(`${at} has a "limit" that is not a positive whole number.`);
  }
  let tab = view.tabs?.[0];
  if (s.tab !== undefined) {
    /* A tab is named by its address word, the one its URL carries (`?tab=`): a label is said in the reader's
       language and changes with `msg()`, the word does not. */
    tab = view.tabs?.find((candidate) => tabKey(candidate) === s.tab);
    if (!tab) {
      const byLabel = view.tabs?.find((candidate) => candidate.label === s.tab);
      throw new Error(
        byLabel
          ? `${at} names the tab "${String(s.tab)}" by its label. Name a tab by its address word: "${tabKey(byLabel)}".`
          : `${at} names the tab "${String(s.tab)}", which the view "${key}" does not have. ` +
              (view.tabs?.length ? `Its tabs: ${view.tabs.map((candidate) => tabKey(candidate)).join(', ')}.` : 'It has no tabs.'),
      );
    }
  }
  const presentation = view.presentation;
  const windows = parseSectionWindows(s, at);
  if (windows && presentation?.kind === 'board')
    throw new Error(`${at} embeds "${key}", a board, which takes the dashboard's window; its own "windows" are for a list.`);
  const interactive = embedInteractive(s, at, key, presentation?.kind, aside);
  const query = andQuery(view.query, tab?.query) || undefined;
  // The view's default order, where its tab says none of its own.
  const tabSorts = Boolean(tab?.query && /(^|\s)(sort|order\s+by)\b/i.test(splitClauseTail(tab.query).tail));
  const base = {
    title: title ?? view.label ?? listLabel(view.table, data),
    table: view.table,
    ...(s.icon === undefined ? {} : { icon: parseIcon(s.icon, at) }),
    ...(query ? { query } : {}),
    ...(view.sort && !tabSorts ? { sort: view.sort } : {}),
    ...(s.width === undefined ? {} : { width: s.width as SectionWidth }),
    ...(s.limit === undefined ? {} : { limit: s.limit as number }),
    ...(over ? { over } : {}),
    ...(windows ? { windows } : {}),
    ...(interactive ? { interactive } : {}),
    view: key,
  };
  if (!presentation || presentation.kind === 'split') {
    const show = view.show;
    const labels = labelsFor(show, data.resources?.[view.table]?.labels);
    return {
      kind: 'rows',
      ...base,
      ...(show ? { show } : {}),
      ...(labels ? { labels } : {}),
      ...(view.sizing === undefined ? {} : { sizing: view.sizing }),
    };
  }
  /* A custom list embedded is still its component's to draw (the rows section hands the view's presentation on). */
  if (presentation.kind === 'custom') return { kind: 'rows', ...base, show: [...presentation.show] };
  const card = [presentation.primary, ...('lines' in presentation ? (presentation.lines ?? []) : [])];
  if (presentation.kind === 'board') {
    if (s.width !== undefined) throw new Error(`${at} embeds "${key}", a board, which a dashboard draws full width. Remove "width".`);
    return {
      kind: 'board',
      ...base,
      by: presentation.by,
      ...(presentation.lanes ? { lanes: [...presentation.lanes] } : {}),
      show: card,
    };
  }
  return { kind: 'rows', ...base, show: card };
}

/* ---------- nav: references and groups ---------- */

/** Local references normalize to `{ view, label? }`, checked static destinations
 * to `{ label, to }`, and groups to `{ group, label, children }`. */
function parseNav(
  raw: unknown,
  where: string,
  views: ReadonlyMap<string, ParsedView>,
  order: readonly string[],
  assistantPage = false,
): AppNavNode[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${where}: "nav" must be an array.`);
  const groups = new Set<string>();
  const placed = new Set<string>();
  const visiting = new Set<object>();
  const leaf = (key: unknown, label: string | undefined, at: string, color?: SeriesColor): AppNavNode => {
    const view = typeof key === 'string' ? views.get(key) : undefined;
    if (!view && key === ASSISTANT_ROOM && assistantPage) {
      if (placed.has(ASSISTANT_ROOM)) throw new Error(`${at} names the assistant a second time; it appears in nav at most once.`);
      placed.add(ASSISTANT_ROOM);
      return {
        view: ASSISTANT_ROOM,
        ...(label === undefined ? {} : { label }),
        ...(color === undefined ? {} : { color }),
      };
    }
    if (!view) {
      throw new Error(
        `${at} names the view "${String(key)}", which this App does not declare. It declares: ${order.join(', ') || 'no views'}. See \`mistri docs nav-and-shell\`.`,
      );
    }
    if (view.kind === 'landing' || (view.kind === 'form' && view.form.public)) {
      throw new Error(
        `${at} names the ${view.kind === 'landing' ? 'landing' : 'public form'} view "${view.key}". Public views are not in nav, which is signed-in chrome: ` +
          "a landing is reached through home, a public form through its address and a landing's call to action.",
      );
    }
    if (placed.has(view.key)) throw new Error(`${at} names the view "${view.key}" a second time; a view appears in nav at most once.`);
    placed.add(view.key);
    return {
      view: view.key,
      ...(label === undefined ? {} : { label }),
      ...(color === undefined ? {} : { color }),
    };
  };
  /* `depth` is the number of groups around these entries. */
  const walk = (entries: unknown[], parent: string, depth: number): AppNavNode[] =>
    entries.map((node, i) => {
      const at = `${parent}: nav entry ${i + 1}`;
      if (typeof node === 'string') return leaf(node, undefined, at);
      if (!isRecord(node)) throw new Error(`${at} is not a view id, a { label, to } or a navGroup.`);
      if (Object.hasOwn(node, 'children')) {
        if (visiting.has(node)) throw new Error(`${at} contains a navigation cycle.`);
        if (depth >= 8) throw new Error(`${at} exceeds the maximum navigation group depth of 8.`);
        allowKeys(node, ['id', 'label', 'icon', 'realm', 'placement', 'inline', 'folded', 'children'], `${at} (a navigation group)`);
        if (typeof node.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(node.id)) {
          throw new Error(`${at} needs a group "id" using lowercase letters, digits and hyphens.`);
        }
        if (groups.has(node.id)) throw new Error(`${at} repeats navigation group id "${node.id}".`);
        if (typeof node.label !== 'string' || !node.label.trim()) throw new Error(`${at} needs a non-empty group "label".`);
        if (!Array.isArray(node.children) || !node.children.length) throw new Error(`${at} needs a non-empty "children" array.`);
        if (node.placement !== undefined && node.placement !== 'footer')
          throw new Error(
            `${at} has a "placement" of ${JSON.stringify(node.placement)}: the one placement is "footer", the group held at the foot of the sidebar.`,
          );
        if (node.placement !== undefined && depth > 0)
          throw new Error(`${at} is a group inside a group with a "placement". Only a group of the top level goes to the foot.`);
        /* `inline` is the top bar's: the group's rooms stand in the bar as links of their own, so a portal's few
           places need no menu to open. The sidebar draws the group as ever. Only the top level is in the bar. */
        if (node.inline !== undefined && node.inline !== true)
          throw new Error(`${at} has an "inline" of ${JSON.stringify(node.inline)}: it is true, or left out.`);
        if (node.inline !== undefined && depth > 0)
          throw new Error(`${at} is a group inside a group with "inline". Only a group of the top level stands in the top bar.`);
        /* `folded` is where a section starts for someone who has never opened or closed it: a rarely used
           section stays one line until it is wanted. Their own choice, once made, is kept over it. */
        if (node.folded !== undefined && node.folded !== true)
          throw new Error(`${at} has a "folded" of ${JSON.stringify(node.folded)}: it is true, or left out.`);
        groups.add(node.id);
        visiting.add(node);
        const children = walk(node.children, `${at} (${node.id})`, depth + 1);
        visiting.delete(node);
        return {
          group: node.id,
          label: node.label.trim(),
          ...(node.icon === undefined ? {} : { icon: parseIcon(node.icon, `${at} (${node.id})`) }),
          ...(node.realm === undefined ? {} : { realm: parseRealm(node.realm, `${at} (${node.id})`) }),
          ...(node.placement === undefined ? {} : { placement: 'footer' as const }),
          ...(node.inline === undefined ? {} : { inline: true as const }),
          ...(node.folded === undefined ? {} : { folded: true as const }),
          children,
        };
      }
      if (Object.hasOwn(node, 'to')) {
        allowKeys(node, ['label', 'to', 'color'], at);
        if (typeof node.label !== 'string' || !node.label.trim() || node.label.length > 120 || /[\p{Cc}\p{Cs}]/u.test(node.label)) {
          throw new Error(`${at}: { label, to } needs a non-blank label of at most 120 characters.`);
        }
        /* A colored dot in the icon's place: a project or a label told apart at a glance, in a theme's own series color. */
        if (
          node.color !== undefined &&
          (typeof node.color !== 'number' || !Number.isInteger(node.color) || node.color < 1 || node.color > 8)
        )
          throw new Error(`${at} has a "color" of ${JSON.stringify(node.color)}: one of the theme's eight chart colors, 1 to 8.`);
        const color = node.color as SeriesColor | undefined;
        if (typeof node.to === 'string') return leaf(node.to, node.label.trim(), at, color);
        return {
          label: node.label.trim(),
          to: parseAppTarget(node.to, `${at}.to`, false) as import('../../schema/app.js').StaticAppTarget,
          ...(color === undefined ? {} : { color }),
        };
      }
      throw new Error(`${at} is not a view id, a { label, to } or a navGroup.`);
    });
  const nav = walk(raw, where, 0);
  /* The assistant's page is always reachable: where nav does not place it, it closes the menu. */
  return assistantPage && !placed.has(ASSISTANT_ROOM) ? [...nav, { view: ASSISTANT_ROOM }] : nav;
}
