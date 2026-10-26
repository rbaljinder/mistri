/**
 * What a dashboard is made of, before anything is drawn.
 *
 * The reader's window and picks folded into a section's query, the slot
 * they ride the address in, the breakdown text a section asks the server
 * for, and how a measured figure is said. Pure, so the components and
 * the vanilla entry read one rule.
 */
import { andQuery } from '@mistriwork/engine/shared/query.js';
import type { FigureFormat } from '@mistriwork/engine/shared/model.js';
import { breakdownText, sectionPeriod, windowed } from '@mistriwork/engine/shared/dashboardAsks.js';
import { columnDisplay, findTable, quote } from '../core.js';
import { defaultCurrency, formatLocale, formatMoney, formatNumber, formatPercent } from '../locale.js';
import { currencyDigits, currencyPath } from '@mistriwork/engine/shared/money.js';
import { DURATION_STEPS } from '@mistriwork/engine/shared/niceTicks.js';
import { sayDuration, withUnit } from './valueModel.js';
import { say } from '../copy/dashboards/components/dashboardModel.js';
import { ALL_TIME } from '@mistriwork/engine/shared/addressParams.js';

interface DisplayRule {
  format?: string;
  currency?: string;
  minor?: true;
  /** Each row says its own currency in this column (`currency: { column }`). */
  currencyColumn?: string;
}

/**
 * A money measure summed apart per currency, where each row says its own
 * (`currency: { column }`): one figure per currency, never one sum of yen
 * and dollars. As a number it is its figure when there is one currency and
 * NaN when there are several, so a change or a goal is said only where it
 * means something. A class, so the query cache keeps it as it is.
 */
export class CurrencyFigures {
  constructor(readonly figures: ReadonlyArray<readonly [currency: string, value: unknown]>) {}
  valueOf(): number {
    return this.figures.length === 1 ? Number(this.figures[0][1]) : NaN;
  }
}

/** The one currency a query keeps its rows to (`currency = JPY`), if it does. */
export function pinnedCurrency(query: string | undefined, path: string): string | undefined {
  const escaped = path.replace(/[.]/g, '\\.');
  return new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*"?([A-Za-z]{3})"?(?:\\s|$)`).exec(query ?? '')?.[1]?.toUpperCase();
}

export interface Section {
  /** A stat card's window, said under its figure (metricWindow). Set on the client, never served. */
  windowNote?: string;
  sizing?: import('@mistriwork/engine/shared/tableSizing.js').TableSizing;
  kind: string;
  /** custom: the author's component, its named reads (each a rows section's words) and its props. */
  component?: import('@mistriwork/engine/shared/appComponents.js').ComponentDecl;
  reads?: Record<string, import('@mistriwork/engine/shared/appComponents.js').DashCustomRead>;
  aggregates?: Record<string, import('@mistriwork/engine/shared/appComponents.js').DashCustomTotal>;
  props?: Record<string, unknown>;
  table?: string;
  query?: string;
  measure?: string;
  by?: string;
  lanes?: string[];
  limit?: number;
  title?: string;
  width?: string;
  /** The area of the dashboard's `layout` the section stands in. */
  area?: string;
  over?: string;
  compare?: string;
  windowBase?: string;
  comparePeriod?: boolean;
  better?: 'up' | 'down';
  spark?: boolean;
  /** metric: how its figure is said, and the word after it, where its measure has no column's rule to say it. */
  format?: FigureFormat;
  unit?: string;
  shape?: string;
  /** funnel: the stages a row reaches in order (shared/funnel.ts). */
  stages?: import('@mistriwork/engine/shared/funnel.js').FunnelStage[];
  /** chart: a scatter's across measure, its `measure` the up one. */
  x?: string;
  /** breakdown, steps: a line under a step, by its value. */
  notes?: Record<string, string>;
  /** chart: a line's curve, and a donut's words for its middle figure. */
  curve?: 'smooth' | 'straight';
  total?: string;
  height?: number;
  /** metric and chart: a goal, drawn as a meter or a rule and said; a metric's may be a measure read from data. */
  target?: number | { table: string; query?: string; measure: string; by?: string; over?: string; windowBase?: string };
  targetWhole?: true;
  show?: string[];
  labels?: Record<string, string>;
  sort?: string;
  text?: string;
  icon?: import('@mistriwork/engine/shared/appIcons.js').AppIconName;
  action?: { label: string; view: string };
  /** note: the dashboard's banner, its tag and its picture. */
  variant?: 'banner';
  eyebrow?: string;
  image?: import('@mistriwork/engine/shared/servedApp.js').LandingImage;
  error?: string;
  /** An embed: the key of the list view it draws, whose room "open →" opens. */
  view?: string;
  /** metric, breakdown, chart, matrix, funnel: its authored `to: false`, a card or groups that are text. */
  noDrill?: true;
  /** Authored `empty: 'hide'`: the section is left out of the dashboard while it has nothing to draw. */
  emptyMode?: 'hide';
  /** The section's own windows, the first where it starts; `windowKey` names it in the address. */
  windows?: string[];
  windowKey?: string;
  /** An embed that works as its room: search, filters, selection with the room's bulk actions. */
  interactive?: true;
  /** A ⋯ menu on each row with the record's own verbs, as the list over the table offers them (the assistant's tables). */
  rowActions?: true;
  /** activity: the resources whose changes it lists, each with its mark and its word. */
  resources?: Record<string, { icon?: import('@mistriwork/engine/shared/appIcons.js').AppIconName; label?: string }>;
  /** A first run's steps, each served with its view's table (FirstRun.tsx). */
  steps?: import('@mistriwork/engine/shared/servedApp.js').AppFirstRunStep[];
  /** find: the tables its box searches (DashboardFind.tsx), and the box's words before anything is typed. */
  searched?: string[];
  placeholder?: string;
}

/** The chart shapes a part on demand draws (ChartShapes.tsx), so a dashboard of lines and bars never fetches it. */
export const EXTRA_SHAPES: readonly string[] = ['scatter', 'heatmap', 'waterfall', 'treemap'];

export interface DashboardDef {
  /** The view carries a Favorites star. */
  favorite?: true;
  /** The dashboard's view key; its address is `dash-<key>`. */
  id: string;
  label: string;
  /** The words over the sections when they are not the label, the reader already greeted by the server. */
  heading?: string;
  /** The title is not drawn; it stays for a screen reader. */
  headingHidden?: true;
  /** Plain text, authored with the dashboard and served only with it. */
  description?: string;
  sections: Section[];
  /** A separate context flow beside the main dashboard sections. */
  aside?: Section[];
  /** Sections on a grid: a row of cells each, an area's name or `.` (shared/dashLayout.ts). Never with an aside. */
  areas?: string[];
  windows?: string[];
  /** The window it opens on, one of `windows`: unpicked is this, and all time is said `all-time`. */
  window?: string;
  /** The window picked from one date-range button rather than a row of them. */
  windowControl?: 'segmented' | 'button';
  filters?: string[];
  refresh?: number;
  /** A free-form page (definePage): what its component reads and runs, the address parameters it keeps its place in, and its loader. */
  page?: { reads: string[]; commands: string[]; params: string[]; loader?: string; public?: true };
  error?: string;
}

export type Picks = Record<string, string>;
/** The periods the reader picked on sections with windows of their own: the section's `windowKey` → its phrase. */
export type Periods = Record<string, string>;

/** What the dashboard room hands the dashboard it draws (Rooms.tsx, through the shell's `rooms`; Dashboard.tsx). */
export interface DashboardProps {
  dashboard: DashboardDef;
  /** The reader's time window: null is all time. */
  window?: string | null;
  picks?: Picks;
  /** The periods picked on sections with windows of their own, by section. */
  periods?: Periods;
  onWindow?: (w: string | null) => void;
  onPick?: (picks: Picks) => void;
  onPeriods?: (periods: Periods) => void;
}

/** How a section's own window rides the address: `period.<windowKey>` beside the dashboard's `period`. */
const PERIOD_PREFIX = 'period.';

/** The number, spoken the way the grid speaks numbers: the reader's
    separators, and an integer past 2^53 digit for digit. */
export function figure(value: unknown): string {
  if (value === undefined || value === null) return '0';
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return formatNumber(value);
  const n = typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && Number.isSafeInteger(Math.trunc(n)) ? formatNumber(n) : String(value);
}

/**
 * The display rule behind a measured number, read off the measure's own
 * column — "sum amount as pipeline" is dressed by whatever dresses
 * `amount`. A bare "count" measures rows, not a column, so it has none.
 * A computed measure that multiplies or divides — a ratio — is a plain
 * number: dollars over dollars are not dollars. One that adds or
 * subtracts keeps its first term's dress.
 */
function measureRule(section: Section): DisplayRule | null {
  /* The author's word for the figure stands over the column's: "avg resolution_met * 100" is a share. */
  if (section.format) return { format: section.format };
  if (/\s[*/]\s/.test(section.measure ?? '')) return null;
  const m = /^(?:sum|avg|min|max|median)\s+([A-Za-z0-9_.]+)/i.exec(section.measure ?? '');
  const rule = m && section.table ? (columnDisplay(section.table, m[1]) as DisplayRule | null) : null;
  /* A query kept to one currency says its figures in it. */
  const path = rule?.format === 'money' ? currencyPath(rule, m![1]) : undefined;
  const pinned = path ? pinnedCurrency(section.query, path) : undefined;
  return pinned ? { ...rule, currency: pinned } : rule;
}

/** Where money goes compact: a hundred thousand in a table or a breakdown, where a figure is read whole; a
    thousand on a metric card (CARD_COMPACT). */
const COMPACT_FROM = 100_000;
/* A strip of cards said "$414.1K" beside "$27,300": each card measures alone, so no rule over its neighbours could
   hold before every one had answered, and a card that changed its figure's form as they did would shift. One rule
   a card keeps by itself — compact from a thousand, as its axis and its change say it — reads one way across any
   strip; the exact figure is the card's title and what a screen reader hears (docs/design.md, stat cards). */
const CARD_COMPACT = 1000;

/** A measured figure in its dress: compact money reads as "$27.9M" on a
    card, full anywhere small enough to say whole. */
function dressedFigure(rule: DisplayRule | null, value: unknown, cents?: boolean, compactFrom = COMPACT_FROM): string | null {
  if (value instanceof CurrencyFigures)
    return value.figures
      .map(([currency, each]) => dressedFigure({ ...rule, format: 'money', currency }, each, cents, compactFrom) ?? figure(each))
      .join(' · ');
  const stored = Number(value);
  if (rule?.format !== 'money' || !Number.isFinite(stored) || !Number.isSafeInteger(Math.trunc(stored))) {
    return null;
  }
  /* A sum of minor units is said in the major unit: 1999 cents is $19.99. */
  const n = rule.minor ? stored / 10 ** currencyDigits(rule.currency || defaultCurrency()) : stored;
  /* To the cent where the figure, or the set it stands in (`among`), has cents; whole where it has none. */
  const toCent = cents ?? Math.round(n * 100) % 100 !== 0;
  return formatMoney(
    n,
    rule.currency,
    Math.abs(n) >= compactFrom
      ? { notation: 'compact', maximumFractionDigits: 1 }
      : toCent
        ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
        : { minimumFractionDigits: 0, maximumFractionDigits: 0 },
  );
}

/**
 * A measured fraction, said to a headline's precision. An average or a ratio
 * comes back from the database to every digit it has, and the number
 * formatter's default three places put "78.261" on a card whose measure was
 * "avg resolution_met * 100": noise, not news. One place at or past 1, and
 * three significant digits below it, so a ratio such as 0.0345 does not
 * round to 0.
 */
function measuredFraction(value: unknown): string | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+\.\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n) || Number.isInteger(n)) return null;
  return formatNumber(n, Math.abs(n) >= 1 ? { maximumFractionDigits: 1 } : { maximumSignificantDigits: 3 });
}

/**
 * A legend's figures, said by one rule: money compact for all of them where any is large enough to be said compact,
 * whole for all of them else, so "$45,230" never stands beside "$451.2K" on one line.
 */
export function legendSayer(section: Section, totals: readonly number[]): (value: unknown) => string {
  return sayer(section, undefined, { card: totals.some((n) => Math.abs(n) >= COMPACT_FROM) });
}

/** How a section says a figure: in its measure's dress, else as a number. */
export function sayer(
  section: Section,
  measured?: unknown,
  /* A metric card's own figure, its change and its goal: money compact from a thousand (CARD_COMPACT); or the
     figure whole at any size, for the card's title. */
  { card = false, whole = false }: { card?: boolean; whole?: boolean } = {},
): ((value: unknown) => string) & { tick: (value: unknown) => string; among: (values: readonly unknown[]) => (value: unknown) => string } {
  const rule = measureRule(section);
  /* Figures in one currency, read apart per currency: its change and its goal are said in it too. */
  const one = measured instanceof CurrencyFigures && measured.figures.length === 1 ? measured.figures[0][0] : undefined;
  const dress = one && rule ? { ...rule, currency: one } : rule;
  const said = figureSayer(dress, section.unit, whole ? Infinity : card ? CARD_COMPACT : COMPACT_FROM);
  /* Figures said side by side, in one form: where every one is a thousand or more, money drops its cents, so
     "$67,713.40" never stands beside "$17,970" in one breakdown; else every figure says cents if one has some. */
  const among = (values: readonly unknown[]) => {
    if (dress?.format !== 'money') return said;
    const minor = dress.minor ? 10 ** currencyDigits(dress.currency || defaultCurrency()) : 1;
    const majors = values.filter((v) => v !== null && v !== undefined && v !== '').map((v) => Number(v) / minor);
    const large = majors.length > 0 && majors.every((n) => Math.abs(n) >= 1000);
    /* Cents for every figure where one has some and none is large; else none. */
    const cents = !large && majors.some((n) => Number.isFinite(n) && Math.round(n * 100) % 100 !== 0);
    const one = (v: unknown) => dressedFigure(dress, v, cents) ?? said(v);
    return section.unit ? (v: unknown) => withUnit(one(v), section.unit!) : one;
  };
  return Object.assign(said, { tick: tickSayer(dress, section.unit), among });
}

/**
 * How an axis says one of its round levels (shared/niceTicks.ts): compact
 * from a thousand up and never to the cent, so a money axis reads "$0 / $2K /
 * $4K" where the figure itself is said whole. A share and a time taken keep
 * their own words, which are short already.
 */
function tickSayer(rule: DisplayRule | null, unit?: string): ((value: unknown) => string) & { steps?: readonly number[] } {
  const said = figureSayer(rule, unit);
  const tick = (value: unknown) => {
    const stored = Number(value);
    if (value === null || value === '' || !Number.isFinite(stored) || rule?.format === 'percent' || rule?.format === 'duration')
      return said(value);
    const compact = { notation: 'compact', maximumFractionDigits: 1, minimumFractionDigits: 0 } as const;
    if (rule?.format === 'money') {
      const n = rule.minor ? stored / 10 ** currencyDigits(rule.currency || defaultCurrency()) : stored;
      const text = formatMoney(
        n,
        rule.currency,
        Math.abs(n) >= 1000 ? compact : { minimumFractionDigits: 0, maximumFractionDigits: Number.isInteger(n) ? 0 : 2 },
      );
      return unit ? withUnit(text, unit) : text;
    }
    if (Math.abs(stored) < 1000) return said(value);
    const text = formatNumber(stored, compact);
    return unit ? withUnit(text, unit) : text;
  };
  /* A time taken is ruled in days and hours, not in round numbers of seconds. */
  return rule?.format === 'duration' ? Object.assign(tick, { steps: DURATION_STEPS }) : tick;
}

/**
 * A measured figure said in a rule's dress — money, a share (`percent` reads
 * the figure as 0–100: 53.8 is "53.8%", never 0.538) — else as a number, an
 * average or a ratio to a headline's precision; then the unit. A dashboard's
 * metric and a record page's say a figure the same way.
 */
export function figureSayer(rule: DisplayRule | null, unit?: string, compactFrom = COMPACT_FROM): (value: unknown) => string {
  const said = (v: unknown) =>
    dressedFigure(rule, v, undefined, compactFrom) ?? sharedFigure(rule, v) ?? durationFigure(rule, v) ?? measuredFraction(v) ?? figure(v);
  return unit ? (v) => withUnit(said(v), unit) : said;
}

/** A share said as one: 78.261 is "78.3%". */
function sharedFigure(rule: DisplayRule | null, value: unknown): string | null {
  const n = Number(value);
  if (rule?.format !== 'percent' || value === null || value === '' || !Number.isFinite(n)) return null;
  return formatPercent(n, { maximumFractionDigits: 1 });
}

/** A figure of seconds said as a time taken: 36120 is "10h 2m", as a `duration` column says it. */
function durationFigure(rule: DisplayRule | null, value: unknown): string | null {
  const n = Number(value);
  if (rule?.format !== 'duration' || value === null || value === '' || !Number.isFinite(n)) return null;
  return sayDuration(n, formatLocale());
}

/* What a section asks is shared (shared/dashboardAsks.ts): a first page's
   dashboard is asked by the server in the same words. */
export { breakdownText, sectionPeriod, windowed };

/** The section's whole query, as the list page would take it. */
export function fullQuery(section: Section): string {
  return [section.table, section.query].filter(Boolean).join(' ');
}

/** Authored lane visibility narrows every board read and drilldown alike. */
export function boardSection(section: Section): Section {
  if (section.kind !== 'board' || !section.lanes?.length) return section;
  return {
    ...section,
    query: andQuery(section.query, section.lanes.map((value) => `${section.by} = ${quote(value)}`).join(' or ')),
  };
}

/**
 * A windowed section's title, saying the window its figure is over. A title
 * that names the author's own window ("Won, last 90 days") has the reader's
 * picked window stand in its place — "Won, last 30 days" — where appending
 * it read "Won, last 90 days (last 30 days)", two windows for one figure.
 * A title that names none says the window after it. With nothing picked, a
 * section the author windowed says the author's window — "Won (last 90
 * days)", unless its title already names it — and any other says it is over
 * all time: under "All time" a bare "Won" counted ninety days and said so
 * nowhere.
 */
export function windowTitle(title: string, section: Pick<Section, 'query' | 'over' | 'windowBase'>, windowNow: string | null): string {
  if (!section.over) return title;
  const authored = section.windowBase === undefined ? undefined : authoredWindow(section.query ?? '', section.over);
  const at = authored ? title.toLowerCase().indexOf(authored.toLowerCase()) : -1;
  if (!windowNow)
    return section.windowBase === undefined ? say('allTime', { title }) : authored && at < 0 ? `${title} (${authored})` : title;
  if (authored && at >= 0) {
    const said = at === 0 && /^[A-Z]/.test(title) ? windowNow.charAt(0).toUpperCase() + windowNow.slice(1) : windowNow;
    return title.slice(0, at) + said + title.slice(at + authored.length);
  }
  return `${title} (${windowNow})`;
}

/**
 * A stat card's title and the window said under its figure. A card's label is
 * one line over a number, and "Won (all time)" or "Won (last 90 days)" wrapped
 * it, so a card never has the window appended: a title that names the
 * author's window has the reader's pick stand in its place, as a section's
 * does (windowTitle), and one that names none says the author's window
 * quietly under the figure until the reader picks one — then the picker above
 * says it, and a card it does not move says "Right now". Under All time
 * nothing is narrowed and nothing is said.
 */
export function metricWindow(
  title: string,
  section: Pick<Section, 'query' | 'over' | 'windowBase'>,
  windowNow: string | null,
): { title: string; note?: string } {
  if (!section.over) return { title };
  const authored = section.windowBase === undefined ? undefined : authoredWindow(section.query ?? '', section.over);
  const named = authored !== undefined && title.toLowerCase().includes(authored.toLowerCase());
  if (named) return { title: windowNow ? windowTitle(title, section, windowNow) : title };
  if (!windowNow && authored) return { title, note: authored.charAt(0).toUpperCase() + authored.slice(1) };
  return { title };
}

/** The window phrase a query gives its `over` column (`close_date = last 90 days` → "last 90 days"). */
function authoredWindow(query: string, over: string): string | undefined {
  const column = over.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${column}\\s*=\\s*(.+?)(?=\\s+(?:and|or|sort|show|limit)\\b|\\s*\\)|\\s*$)`, 'i').exec(query);
  return match?.[1].trim();
}

/**
 * The window a section's own query sets on its `over` column — "last 90
 * days" — which its title says while the reader has picked none, so a card
 * titled "Won" reads "Won (last 90 days)" under All time and "Won (last 30
 * days)" once the reader picks that, never both windows at once.
 */
export function ownWindow(section: Section): string | undefined {
  if (!section.over || section.windowBase === undefined || !section.query) return undefined;
  const over = section.over.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|[\\s(])${over}\\s*=\\s*(last\\s+\\d+\\s+(?:day|week|month|year)s?)\\b`, 'i').exec(section.query);
  return m?.[1].replace(/\s+/g, ' ').toLowerCase();
}

/** A section with the reader's picks folded in — only the columns its
    own table actually has; the rest pass it over, like the window. */
export function picked(section: Section, picks: Picks): Section {
  if (!section.table) return section;
  const table = findTable(section.table) as { columns: Array<{ name: string }> } | undefined;
  const conds = Object.entries(picks)
    .filter(([column]) => table?.columns.some((c) => c.name === column))
    .map(([column, value]) => `${column} = ${quote(String(value))}`);
  if (!conds.length) return section;
  /* The unwindowed query takes the picks too: a card's trend is drawn over
     it (Dashboard.tsx, Metric), and a picked owner's trend is theirs. */
  const goal = section.target;
  return {
    ...section,
    query: andQuery(section.query, ...conds),
    ...(section.windowBase !== undefined ? { windowBase: andQuery(section.windowBase, ...conds) } : {}),
    /* A whole is the same cohort as the figure: a picked owner's share is of that owner's rows. */
    ...(section.targetWhole && typeof goal === 'object'
      ? {
          target: {
            ...goal,
            query: andQuery(goal.query, ...conds),
            ...(goal.windowBase !== undefined ? { windowBase: andQuery(goal.windowBase, ...conds) } : {}),
          },
        }
      : {}),
  };
}

/** A window phrase as it rides the page token: spaces become hyphens, and
    matching happens slug-to-slug so nothing needs a lossless inverse. */
export const windowSlug = (w: string): string => w.replace(/\s+/g, '-');

/** The root slot, written: the window slug, then `column=value` per pick and
    `period.<section>=<slug>` per section's own window, `;`-separated. Empty
    when there is nothing to say. A dashboard that opens on a window (`opensOn`)
    leaves that one unsaid and says all time as `all-time`. */
export function rootSlot(windowNow: string | null, picks: Picks, periods: Periods = {}, opensOn?: string): string {
  const parts = [windowNow === (opensOn ?? null) ? '' : windowNow ? windowSlug(windowNow) : ALL_TIME];
  for (const [column, value] of Object.entries(picks ?? {})) parts.push(`${column}=${value}`);
  for (const [key, phrase] of Object.entries(periods)) parts.push(`${PERIOD_PREFIX}${key}=${windowSlug(phrase)}`);
  return parts.filter((p, i) => p || (i === 0 && parts.length > 1)).join(';');
}

/** The root slot, read: whatever is not `name=value` is the window; a `period.` name is a section's own. */
export function parseRootSlot(body: unknown): { window: string; picks: Picks; periods?: Periods } {
  const picks: Picks = {};
  const periods: Periods = {};
  let window = '';
  for (const part of String(body ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.startsWith(PERIOD_PREFIX)) periods[part.slice(PERIOD_PREFIX.length, eq)] = part.slice(eq + 1);
    else if (eq > 0) picks[part.slice(0, eq)] = part.slice(eq + 1);
    else if (part) window = part;
  }
  return { window, picks, ...(Object.keys(periods).length ? { periods } : {}) };
}

/** A free-form page's place, read from its slot: the parameters it declares, and nothing else a link carried. */
export function pagePlace(dashboard: DashboardDef, body: unknown): Picks {
  const params = dashboard.page?.params ?? [];
  return Object.fromEntries(Object.entries(parseRootSlot(body).picks).filter(([name]) => params.includes(name)));
}

/** Every section of a dashboard, main flow and aside. */
export const allSections = (dashboard: DashboardDef): Section[] => [...dashboard.sections, ...(dashboard.aside ?? [])];

/** Ignore selections the current dashboard no longer offers: a window, a pick or a section's period it does not have. */
export function dashboardSelection(dashboard: DashboardDef, body: unknown): { window: string | null; picks: Picks; periods: Periods } {
  const linked = parseRootSlot(body);
  const periods: Periods = {};
  for (const section of allSections(dashboard)) {
    const slug = section.windowKey ? linked.periods?.[section.windowKey] : undefined;
    const phrase = slug ? section.windows?.find((w) => windowSlug(w) === slug) : undefined;
    if (phrase) periods[section.windowKey!] = phrase;
  }
  /* What the address says wins; unsaid, or a window no longer offered, is the one the dashboard opens on. */
  const offered = dashboard.windows?.find((w) => windowSlug(w) === linked.window);
  return {
    window: dashboard.window && linked.window === ALL_TIME ? null : (offered ?? dashboard.window ?? null),
    picks: Object.fromEntries(Object.entries(linked.picks).filter(([column]) => (dashboard.filters ?? []).includes(column))),
    periods,
  };
}

/**
 * Groups in the order a reader expects them: a column with a vocabulary (a
 * CHECK list, an enum) in that vocabulary's order — a pipeline reads
 * Prospecting, Qualification, Proposal, Negotiation, never the alphabet —
 * and anything else biggest first. Groups the vocabulary does not name (an
 * empty one, a stray value) come after it, biggest first.
 */
export function orderGroups<T extends Record<string, unknown>>(
  rows: readonly T[],
  key: string,
  value: string,
  vocabulary?: readonly string[],
): T[] {
  const rank = new Map((vocabulary ?? []).map((word, at) => [word, at]));
  const place = (row: T) => (row[key] == null ? undefined : rank.get(String(row[key]))) ?? Number.POSITIVE_INFINITY;
  return [...rows].sort((a, b) => {
    const first = place(a),
      second = place(b);
    if (first !== second) return first - second;
    return (Number(b[value]) || 0) - (Number(a[value]) || 0);
  });
}

/**
 * A bar's length as a share of the largest group, not of the whole: three
 * equal groups each fill the track, rather than a third of it each, and the
 * biggest group always reaches the end. Never under 2%, so a group is seen.
 */
export function barShare(value: unknown, largest: number): number {
  return Math.max(2, Math.round((100 * (Number(value) || 0)) / Math.max(largest, 1)));
}

/**
 * A group's key said by the name of the record it is, where the answer names
 * it (a breakdown by a reference, `names` beside its rows: breakdown.ts,
 * withGroupNames), else as `sayKey` says the key: "Ada Park", not "17", as
 * the grid's cell says the same reference. Not called `say`: the build reads
 * every `say` in a module as the catalog's (vite.config.ts, short-catalog-keys).
 */
export function namedGroups(
  answer: { names?: Record<string, Record<string, string>> } | undefined,
  keyName: string | undefined,
  sayKey: (key: unknown) => string,
): (key: unknown) => string {
  const names = keyName ? answer?.names?.[keyName] : undefined;
  if (!names) return sayKey;
  return (key) => (key != null && Object.hasOwn(names, String(key)) ? names[String(key)] : sayKey(key));
}
