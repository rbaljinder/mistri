/**
 * The dashboard sections that are not about one table's figures — a new
 * App's first run, an author's own component with its declared reads, the
 * activity feed across resources — and a section's own time windows.
 * Parsed here, beside the dashboard parser that calls them (appViews.ts).
 */
import { ACTIVITY_MAX, FIRST_RUN_MAX_STEPS, SECTION_KEYS, type AppActivityResource, type AppDashSection } from './appModel.js';
import { allowKeys, isRecord, optionalText } from '@mistriwork/engine/shared/model.js';
import { parseIcon } from '@mistriwork/engine/shared/appIcons.js';
import { slug } from '@mistriwork/engine/shared/slug.js';
import { WIDTHS, type SectionWidth } from '@mistriwork/engine/shared/page.js';
import { checkDeclaredResource, checkResourceSlot, type ParsedData } from './appResourceBlocks.js';
import { componentPropValues, parseComponentDecl, parseDashReads, parseDashTotals } from '@mistriwork/engine/shared/appComponents.js';

/** A new App's first steps, each a list view whose New form it opens: drawn until every step's
    table has a row, and alone while none has — next actions, not charts of nothing (Dashboard.tsx). */
/* The sentence under a heading is `description` everywhere (renamed before 1.0). */
const FIRST_RUN_RENAMED = { text: 'is now "description": the sentence under the title' } as const;
/* A destination's words are its `label` (renamed before 1.0). */
const FIRST_RUN_STEP_RENAMED = { ...FIRST_RUN_RENAMED, title: 'is now "label": the next action' } as const;

export function firstRunSection(
  s: Record<string, unknown>,
  at: string,
  views: ReadonlyMap<string, { kind: string; key: string }>,
): AppDashSection {
  allowKeys(s, SECTION_KEYS.firstRun, `${at} (a first run)`, FIRST_RUN_RENAMED);
  const title = optionalText(s, 'title', at);
  const text = optionalText(s, 'description', at);
  const listViews = [...views.values()].filter((view) => view.kind === 'list').map((view) => view.key);
  if (!Array.isArray(s.steps) || !s.steps.length || s.steps.length > FIRST_RUN_MAX_STEPS) {
    throw new Error(
      `${at} is a first run and needs "steps": 1 to ${FIRST_RUN_MAX_STEPS} list views to start, like { label: 'Add your first customer', to: 'customers' }.`,
    );
  }
  const steps = s.steps.map((raw, i) => {
    const here = `${at}, step ${i + 1}`;
    if (!isRecord(raw)) throw new Error(`${here} is not an object with "label" and "to".`);
    allowKeys(raw, ['label', 'description', 'to'], here, FIRST_RUN_STEP_RENAMED);
    const label = optionalText(raw, 'label', here);
    if (!label) throw new Error(`${here} needs a "label": the next action, like "Add your first customer".`);
    const target = typeof raw.to === 'string' ? views.get(raw.to.trim()) : undefined;
    if (!target || target.kind !== 'list') {
      throw new Error(
        `${here} opens "${String(raw.to)}", which is not a list view this App declares. Its list views: ${listViews.join(', ') || 'none'}.`,
      );
    }
    const detail = optionalText(raw, 'description', here);
    return { label, view: target.key, ...(detail ? { detail } : {}) };
  });
  const repeated = steps.find((step, i) => steps.findIndex((other) => other.view === step.view) !== i);
  if (repeated)
    throw new Error(
      `${at} names the view "${repeated.view}" in two steps. A step is done when its list has a row, so each view is one step.`,
    );
  return { kind: 'firstRun', ...(title ? { title } : {}), ...(text ? { text } : {}), steps };
}

/**
 * An author's component on a dashboard: its reads are rows sections in all
 * but drawing — each names its resource, narrows by a query, and may say the
 * `over` the reader's window narrows it by — so the catalog check, the window
 * and the pick filters reach them as they reach every section.
 */
export function parseCustomDashSection(s: Record<string, unknown>, at: string, data: ParsedData): AppDashSection {
  const component = parseComponentDecl(s.component, `${at}, "component"`, 'section');
  const title = optionalText(s, 'title', at);
  if (s.width !== undefined && !WIDTHS.includes(String(s.width) as SectionWidth)) {
    throw new Error(`${at} has a "width" of "${String(s.width)}". Use ${WIDTHS.join(', ')}.`);
  }
  const reads = parseDashReads(s.rows, at);
  for (const [name, read] of Object.entries(reads ?? {})) {
    checkResourceSlot(read.table, `${at}, rows "${name}", "from"`, data);
    checkDeclaredResource(read.table, `${at}, rows "${name}", "from"`, data);
  }
  const totals = parseDashTotals(s.figures, at);
  for (const [name, total] of Object.entries(totals ?? {})) {
    checkResourceSlot(total.table, `${at}, figures "${name}", "from"`, data);
    checkDeclaredResource(total.table, `${at}, figures "${name}", "from"`, data);
  }
  return {
    kind: 'custom',
    component,
    ...(title === undefined ? {} : { title }),
    ...(reads ? { reads } : {}),
    ...(totals ? { aggregates: totals } : {}),
    props: componentPropValues(component, s.props, at),
    ...(s.width === undefined ? {} : { width: s.width as SectionWidth }),
  };
}

/**
 * A section's own windows: the reader picks this section's period in its
 * heading, apart from the dashboard's window, the first phrase where it
 * starts. They narrow by the section's `over`, as the dashboard's do, so a
 * section without one is refused rather than given a picker that moves
 * nothing. Each phrase is judged against the catalog with the rest of the
 * section (app.ts, resolveDashboard).
 */
export function parseSectionWindows(s: Record<string, unknown>, at: string): string[] | undefined {
  if (s.windows === undefined) return undefined;
  if (!Array.isArray(s.windows) || !s.windows.length || s.windows.length > 8 || s.windows.some((w) => typeof w !== 'string' || !w.trim())) {
    throw new Error(`${at} has "windows" that are not a list of one to eight phrases like "last 7 days".`);
  }
  const windows = (s.windows as string[]).map((w) => w.trim().replace(/\s+/g, ' '));
  if (new Set(windows.map((w) => w.toLowerCase())).size !== windows.length) throw new Error(`${at} names one of its "windows" twice.`);
  if (typeof s.over !== 'string' || !s.over.trim()) {
    throw new Error(`${at} has "windows" and no "over": name the date column its period narrows, like over: 'moved_at'.`);
  }
  return windows;
}

/**
 * An embed that works as its room does — its search and filters, and its
 * selection with the bulk actions its room offers the reader — rather than
 * read-only. Opt-in, since most dashboard lists are a glance. The aside draws
 * a list as names, not a table, so there is no room there for its controls,
 * and a board or a calendar is drawn by the dashboard as a board or not at all.
 */
export function embedInteractive(
  s: Record<string, unknown>,
  at: string,
  view: string,
  presentation: string | undefined,
  aside: boolean,
): true | undefined {
  if (s.interactive === undefined || s.interactive === false) return undefined;
  if (s.interactive !== true) throw new Error(`${at} has an "interactive" that is not true or false.`);
  if (aside) throw new Error(`${at} embeds "${view}" as interactive in the aside, which draws a list as names. Move it into "sections".`);
  if (presentation === 'board' || presentation === 'calendar') {
    throw new Error(
      `${at} embeds "${view}", a ${presentation}, as interactive; a dashboard draws a ${presentation} read-only. Open its room to work it.`,
    );
  }
  return true;
}

/**
 * Each section with windows of its own is named in the address by its title
 * (`?period.lines-moved-by-day=last-7-days`), or by its place (`section-3`) where the
 * title has no letters or digits: a name no other windowed
 * section on the dashboard has, and never an empty one.
 */
export function nameSectionWindows(sections: AppDashSection[], at: string): void {
  const seen = new Map<string, string>();
  for (const [index, section] of sections.entries()) {
    if (!section.windows) continue;
    const title = section.title ?? '';
    /* A title with no Latin letters or digits (日本語, a reader's words) slugs to nothing: the section's place names it
       instead, so the key is stable in every language and never empty. */
    const key = slug(title, '') || `section-${index + 1}`;
    const other = seen.get(key);
    if (other !== undefined) {
      throw new Error(
        `${at}: "${other}" and "${title}" both have their own "windows" and read as "${key}" in the address. Give one another title.`,
      );
    }
    seen.set(key, title);
    section.windowKey = key;
  }
}

/** How many resources one find box searches: each is a question per keystroke pause. */
const FIND_MAX = 6;

/**
 * One box over several resources' records, by their names: each resource
 * named is one the App declares, searched as the reader reads it.
 */
export function parseFindSection(s: Record<string, unknown>, at: string, data: ParsedData): AppDashSection {
  const title = optionalText(s, 'title', at);
  const placeholder = optionalText(s, 'placeholder', at);
  if (
    !Array.isArray(s.resources) ||
    !s.resources.length ||
    s.resources.length > FIND_MAX ||
    s.resources.some((name) => typeof name !== 'string')
  ) {
    throw new Error(
      `${at} is a find and needs "resources": one to ${FIND_MAX} resource names whose records it searches, like ['article', 'catalog_item'].`,
    );
  }
  const searched = [...new Set(s.resources as string[])];
  for (const name of searched) {
    checkResourceSlot(name, `${at}, resources "${name}"`, data);
    checkDeclaredResource(name, `${at}, resources "${name}"`, data);
  }
  if (s.width !== undefined && !WIDTHS.includes(String(s.width) as SectionWidth)) {
    throw new Error(`${at} has a "width" of "${String(s.width)}". Use ${WIDTHS.join(', ')}.`);
  }
  return {
    kind: 'find',
    searched,
    ...(title === undefined ? {} : { title }),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(s.icon === undefined ? {} : { icon: parseIcon(s.icon, at) }),
    ...(s.width === undefined ? {} : { width: s.width as SectionWidth }),
  };
}

/**
 * Recent changes across resources, read from their record history: each
 * resource named is one the App declares, carries at most a mark and its word
 * in the feed, and keeps a history from then on (server/recordHistory.ts),
 * as a page's `history()` makes its resource keep one.
 */
export function parseActivitySection(s: Record<string, unknown>, at: string, data: ParsedData): AppDashSection {
  const title = optionalText(s, 'title', at);
  if (!isRecord(s.resources) || !Object.keys(s.resources).length || Object.keys(s.resources).length > 12) {
    throw new Error(
      `${at} is an activity and needs "resources": one to twelve resources whose changes it lists, like { pick_list: { icon: 'truck' } }.`,
    );
  }
  const resources: Record<string, AppActivityResource> = {};
  for (const [name, raw] of Object.entries(s.resources)) {
    const here = `${at}, resources "${name}"`;
    checkResourceSlot(name, here, data);
    checkDeclaredResource(name, here, data);
    if (!isRecord(raw)) throw new Error(`${here} is not an object: { icon?, label? }.`);
    allowKeys(raw, ['icon', 'label'], here);
    const label = optionalText(raw, 'label', here);
    resources[name] = { ...(raw.icon === undefined ? {} : { icon: parseIcon(raw.icon, here) }), ...(label ? { label } : {}) };
  }
  if (s.limit !== undefined && (typeof s.limit !== 'number' || !Number.isInteger(s.limit) || s.limit < 1 || s.limit > ACTIVITY_MAX)) {
    throw new Error(`${at} has a "limit" that is not a whole number from 1 to ${ACTIVITY_MAX}: the changes drawn before "Show more".`);
  }
  if (s.width !== undefined && !WIDTHS.includes(String(s.width) as SectionWidth)) {
    throw new Error(`${at} has a "width" of "${String(s.width)}". Use ${WIDTHS.join(', ')}.`);
  }
  return {
    kind: 'activity',
    resources,
    ...(title === undefined ? {} : { title }),
    ...(s.icon === undefined ? {} : { icon: parseIcon(s.icon, at) }),
    ...(s.limit === undefined ? {} : { limit: s.limit as number }),
    ...(s.width === undefined ? {} : { width: s.width as SectionWidth }),
  };
}
