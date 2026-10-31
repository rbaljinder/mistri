/**
 * A dashboard: the app's own screen, composed like a page but about the
 * whole table instead of one record.
 *
 * Every section rides machinery that already exists — a metric is the
 * home card's one-group breakdown with a width, a breakdown is the same
 * def the page sections run, a list is the real table view with the
 * chrome off — so this module is composition, not a new engine. The
 * sections wear the page's own layout classes, because a dashboard and a
 * page are the same room at two zoom levels and should read as such.
 *
 * Every fetch is a Query. That is what makes a refresh a refetch — the
 * numbers change in place, the reader never sees a loading state — and
 * what makes fifteen sections on one screen fifteen cache entries rather
 * than fifteen requests per paint: a pick changes the sections it lands
 * on and the rest keep what they have.
 */
import { shell } from '@mistriwork/kit/client/shellMode.js';
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { keepPreviousData, useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  columnDisplay,
  findTable,
  go,
  labelColumn,
  labelPath,
  openRecord,
  primaryKey,
  quote,
  refsFrom,
  tableView,
} from '@mistriwork/kit/client/core.js';
import { splitQuery } from '@mistriwork/kit/client/clauses.js';
import { batchedBreakdown, batchedRun } from '@mistriwork/kit/client/breakdownBatch.js';
import { ListEmpty } from '@mistriwork/kit/client/components/ListEmpty.js';
import { andQuery } from '@mistriwork/engine/shared/query.js';
import { droppedQuery, funnelBasis, funnelChains, funnelText, stageColumn } from '@mistriwork/engine/shared/funnel.js';
import { Funnel, type FunnelDoor } from './Funnel.js';
import { exportOffered, type AppListEmpty } from '@mistriwork/engine/shared/listPresentations.js';
import { gridTemplateAreas, layoutAreas, layoutGrid, reflowLayout, type LayoutGrid } from '@mistriwork/engine/shared/dashLayout.js';
import {
  boardCountText,
  chartLimit,
  dashboardListQuery,
  groupsAskedFor,
  measureText,
  pickQuery,
  type AskLookups,
} from '@mistriwork/engine/shared/dashboardAsks.js';
import { sparkText, sparkWindow } from '@mistriwork/engine/shared/dashboardTrend.js';
import { trendPoints } from '@mistriwork/engine/shared/autoBucket.js';
import type { ColumnMeta, ForeignKey, TableMeta } from '@mistriwork/engine/shared/schema.js';
import { message, messageLanguage, subscribeMessages } from '@mistriwork/kit/client/messages.js';
import { activeApp, inAppMode } from '../appState.js';
import { mayRunAny } from '@mistriwork/kit/client/actionGrants.js';
import { appRooms, isListRoom, offeredBy, resourceOf, viewRoom } from '@mistriwork/kit/client/components/appRooms.js';
import { listEntry, listLink, type ViewLink } from '@mistriwork/kit/client/components/viewLink.js';
import { TableRoom } from '@mistriwork/kit/client/components/TableRoom.js';
import { referenceNames } from '@mistriwork/kit/client/components/appListModel.js';
import { namedCell } from '@mistriwork/kit/client/components/listColumn.js';
import { dressFor, groupLabel, maskedText, ruleSays, type DisplayRule } from '@mistriwork/kit/client/components/valueModel.js';
import { AvatarText, Dressed, Value } from '@mistriwork/kit/client/components/Value.js';
import { avatarOwner, useAvatarPhotos } from '@mistriwork/kit/client/components/avatarPhotos.js';
import { Sparkline, TONE_INK, periodTick } from '@mistriwork/kit/client/components/Chart.js';
import { useAutoChart } from '@mistriwork/kit/client/components/autoChart.js';
import { ChartFigure, ChartShapeFigure, EXTRA_SHAPES, type ExtraShape } from '@mistriwork/kit/client/components/ChartFigure.js';
import { Dropdown } from '@mistriwork/kit/client/components/Dropdown.js';
import { DashboardNote } from '@mistriwork/kit/client/components/DashboardNote.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import { FirstRun, useFirstRun } from './FirstRun.js';
import { ErrorBoundary } from '@mistriwork/kit/client/components/ErrorBoundary.js';
import { Empty, Problem, ProblemScopeProvider } from '@mistriwork/kit/client/components/Notes.js';
import { landingImage } from './LandingData.js';
import type { AppIconName } from '@mistriwork/engine/shared/appIcons.js';
import { currencyPath } from '@mistriwork/engine/shared/money.js';
import { targetText } from '@mistriwork/engine/shared/dashboardAsks.js';
import {
  allSections,
  barShare,
  boardSection,
  breakdownText,
  CurrencyFigures,
  pinnedCurrency,
  figure,
  fullQuery,
  legendSayer,
  namedGroups,
  orderGroups,
  picked,
  sayer,
  sectionPeriod,
  windowed,
  windowTitle,
  metricWindow,
  type DashboardDef,
  type DashboardProps,
  type Periods,
  type Picks,
  type Section,
} from '@mistriwork/kit/client/components/dashboardModel.js';
import { declaredOrder, orderDeclared } from '@mistriwork/kit/client/components/groupOrder.js';
import { formatApprox, formatDate, formatLocale, formatPercent } from '@mistriwork/kit/client/locale.js';
import { dateWindow } from '@mistriwork/engine/shared/queryDates.js';
import { DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
/* The dashboard's own blocks' sheet travels with this chunk (onDemand), not in the first stylesheet. */
import './DashboardBlocks.css';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { say as sayCopy } from '../copy/dashboards/components/Dashboard.js';
import { liveFollowing } from '@mistriwork/kit/client/liveState.js';

/* An author's component, and the page's side of @mistriwork/mistri/ui with it: fetched
   the first time a dashboard holds one, never for a dashboard without. */
const CustomDashSection = onDemand(() => import('./sdk/CustomSection.js'), 'CustomDashSection');
/* A list that works as its room does, and the feed of recent changes: each fetched the first time a dashboard holds one. */
const InteractiveList = onDemand(() => import('@mistriwork/kit/client/components/DashboardList.js'), 'InteractiveList');
const ActivityFeed = onDemand(() => import('./DashboardActivity.js'), 'ActivityFeed');
const FindSection = onDemand(() => import('./DashboardFind.js'), 'FindSection');
const BrandingForm = onDemand(() => import('./BrandingForm.js'), 'BrandingForm');
const IntegrationsForm = onDemand(() => import('./IntegrationsForm.js'), 'IntegrationsForm');
/* A section's own period picker, with the rules of the heading row that holds it. */
const SectionPeriod = onDemand(() => import('@mistriwork/kit/client/components/SectionPeriod.js'), 'SectionPeriod');

interface Breakdown {
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  names?: Record<string, Record<string, string>>;
}
interface Rows {
  rows?: Array<Record<string, unknown>>;
}
type Row = Record<string, unknown>;

/* What a read says about the time it is asked at: a window ("last 30 days"), a day or a period named from now. A
   figure that says none changes only when the data does, and live sync (liveSync.ts) tells the page when. */
const TIME_RELATIVE =
  /\b(?:now|today|yesterday|tomorrow|ago|(?:this|last|next|past|previous)\s+(?:\d+\s+)?(?:day|week|month|quarter|year)s?)\b/i;

/* The youngest answer the minute reads again. Query asks the interval again after every answer, so a tile read at
   :00.2 ticks at the next :00, a minute old; one read at :58 waits for the minute after. */
const TICK_FLOOR = 15_000;

/**
 * The minute tick: asked again on the wall-clock minute, asleep with the tab (Query's refetchIntervalInBackground is
 * off). A read that depends on the time always ticks; every other read ticks while the page follows no changes to its
 * table (an App without `live: true`, `--no-live`, or a resource's own `live: false`), since nothing else would tell a
 * dashboard left on a wall that its data moved.
 */
export const minuteTick = (
  text: string | null | undefined,
  table?: string,
  following: (table?: string) => boolean = liveFollowing,
): ((query?: { state: { dataUpdatedAt: number } }) => number | false) | false => {
  if (!text) return false;
  const timed = TIME_RELATIVE.test(text);
  return (query) => {
    if (!timed && following(table)) return false;
    const now = Date.now();
    const next = 60_000 - (now % 60_000);
    /* An answer read moments before the minute (a page opened at :58, the first paint's carried answers) is not read
       again at :00: the tick that would land on it goes to the minute after. */
    const read = query?.state.dataUpdatedAt;
    return read && now + next - read < TICK_FLOOR ? next + 60_000 : next;
  };
};

/* A tile is an aggregate, and says what it is as of: re-read when a change
   to its tables is announced (liveSync.ts), a write that invalidates it, the
   minute for a read that depends on the time, or after two minutes, not every
   time the dashboard is opened again or its tab regains focus. */
const TILE_FRESH = 120_000;
/* The most currencies a figure says apart: more than this is a report, not a card. */
const CURRENCIES_SAID = 6;

/* Here, not in dashboardModel.ts: only a dashboard sums a measure apart per currency, and that model is first-page code (PageMetrics). */
/** The path a section's money measure is grouped by, where each row says its own currency and the section's query does not pin one. */
function currencySplit(section: Pick<Section, 'table' | 'measure' | 'format' | 'query'>): string | undefined {
  if (section.format || /\s[*/+-]\s/.test(section.measure ?? '')) return undefined;
  const m = /^(?:sum|avg|min|max|median)\s+([A-Za-z0-9_.]+)(?:\s+as\s+\w+)?$/i.exec((section.measure ?? '').trim());
  const rule = m && section.table ? (columnDisplay(section.table, m[1]) as { format?: string; currencyColumn?: string } | null) : null;
  const path = rule?.format === 'money' ? currencyPath(rule, m![1]) : undefined;
  return path && !pinnedCurrency(section.query, path) ? path : undefined;
}

/* `table`: the resource the read is over, whose own `live: false` keeps it on the minute tick on a live App. */
function useBreakdown(text: string | null, table?: string, limit?: number) {
  return useQuery<Breakdown>({
    queryKey: ['breakdown', text, limit ?? null],
    queryFn: () => {
      if (!text) throw new Error(sayCopy('thisSectionHasNoBreakdown'));
      // Asked with the other sections of this paint, in one request (breakdownBatch.ts).
      return batchedBreakdown<Breakdown>({ text, limit });
    },
    enabled: Boolean(text),
    refetchInterval: minuteTick(text, table),
    staleTime: TILE_FRESH,
    placeholderData: keepPreviousData,
  });
}

function useRows(q: string | null, limit: number, table?: string) {
  return useQuery<Rows>({
    queryKey: ['run', q, limit],
    queryFn: () => {
      if (!q) throw new Error(sayCopy('thisSectionHasNoRecord'));
      // With the section's numbers, in one request (breakdownBatch.ts).
      return batchedRun<Rows>({ q, limit, offset: 0, count: 'none' });
    },
    enabled: Boolean(q),
    refetchInterval: minuteTick(q, table),
    staleTime: TILE_FRESH,
    placeholderData: keepPreviousData,
  });
}

/** One measure over one query, as a number — the home card's fetch. */
function useMeasure(section: Pick<Section, 'table' | 'measure' | 'format'>, query: string | undefined, enabled = true) {
  /* Money each row says its own currency for is summed apart per currency (CurrencyFigures). */
  const split = currencySplit({ ...section, query });
  const text = split ? `${measureText(section, query)} by ${split}` : measureText(section, query);
  return useQuery<unknown>({
    queryKey: ['measure', text],
    queryFn: async () => {
      const data = await batchedBreakdown<Breakdown>({ text, limit: split ? CURRENCIES_SAID : 1 });
      if (split) {
        /* The currency first, the figure last, whatever the server says between them. */
        const figures = (data.rows ?? []).flatMap((row) => {
          const keys = Object.keys(row);
          const code = row[keys[0]];
          return typeof code === 'string' && code.trim() ? [[code.trim().toUpperCase(), row[keys[keys.length - 1]]] as const] : [];
        });
        return figures.length ? new CurrencyFigures(figures) : null;
      }
      const row = data.rows?.[0];
      return row ? row[Object.keys(row)[0]] : null;
    },
    enabled,
    refetchInterval: minuteTick(text, section.table),
    staleTime: TILE_FRESH,
    placeholderData: keepPreviousData,
  });
}

/**
 * A section authored `empty: 'hide'` that has nothing to draw says so to the shell round it, which leaves the whole
 * section out — its heading and its place in the grid with it — rather than drawing a title over an empty note.
 * The section stays mounted, so its question keeps being asked and it returns when something arrives.
 */
const LeaveOutContext = createContext<(gone: boolean) => void>(() => {});
function LeaveOut() {
  const leave = useContext(LeaveOutContext);
  useEffect(() => {
    leave(true);
    return () => leave(false);
  }, [leave]);
  return null;
}

/**
 * One dashboard section's own box, hidden while the section inside it has asked to be left out. On a layout the grid
 * decides when (`report` says what each section asks, `hidden` is what the grid has settled on): a section that left
 * out the moment its own answer arrived would move the areas round it once for every tile that answers.
 */
function SectionShell({
  className,
  children,
  at,
  report,
  hidden,
}: {
  className: string;
  children: ReactNode;
  at?: number;
  report?: (at: number, gone: boolean) => void;
  hidden?: boolean;
}) {
  const [gone, setGone] = useState(false);
  const leave = useCallback(
    (now: boolean) => {
      setGone(now);
      if (at !== undefined) report?.(at, now);
    },
    [at, report],
  );
  return (
    <section className={className} hidden={(report ? hidden : gone) || undefined}>
      <LeaveOutContext.Provider value={leave}>{children}</LeaveOutContext.Provider>
    </section>
  );
}

/**
 * Where a section's groups go. In an App that is one of its lists, never the database browser: the list its `to`
 * names, else the one list over its table this reader is served; with none, or several, the groups are text
 * (`null`) and `mistri check` says which. In the browser (`undefined`) a group opens the table's rows.
 */
function drillTarget(section: Section): string | null | undefined {
  if (section.noDrill) return null;
  const app = activeApp() as Parameters<typeof appRooms>[0] | null;
  if (!inAppMode() || !app) return undefined;
  if (section.view) {
    const room = viewRoom(app, section.view);
    return room && isListRoom(room) && !room.error ? section.view : null;
  }
  const lists = appRooms(app).filter((room) => isListRoom(room) && !room.error && room.table === section.table);
  return lists.length === 1 ? lists[0].id : null;
}

/** A group's doorway: followed in place, and where a list takes it, also a link a reader can open in a new tab. */
type Drill = ((value: unknown) => void) & { link: (value: unknown) => ViewLink | undefined };

/**
 * A group is a doorway when the `by` is a plain column path: clicking
 * "on_hold · 70" opens the list filtered to that group, on top of
 * whatever the section (and the reader's window) already narrowed. A
 * bucketed by — "month opened_on" — stays read-only: its groups are
 * derived values the filter grammar does not take as equalities.
 */
function drillFor(section: Section): Drill | null {
  if (!section.by || /\s/.test(section.by)) return null;
  const target = drillTarget(section);
  if (target === null) return null;
  const queryFor = (value: unknown) => `${section.table} ${andQuery(section.query, `${section.by} = ${quote(String(value))}`)}`;
  const open = (value: unknown) => {
    if (value == null) return;
    if (target === undefined) go(tableView(section.table, queryFor(value)), 'push');
    else {
      const entry = listEntry(target, queryFor(value));
      if (entry) go(entry, 'push');
    }
  };
  return Object.assign(open, {
    link: (value: unknown) => (target && value != null ? listLink(target, queryFor(value)) : undefined),
  });
}

/** A group's key as its reader says it: the column's display rule, and in an
    App the column's vocabulary as words (valueModel.ts, groupLabel). */
function sayGroup(table: string | undefined, column: string | undefined) {
  /* A weekday bucket answers 1 (Monday) to 7, an hour bucket 00 to 23: said as the reader's day and hour. */
  const bucket = /^(weekday|hour)\s/i.exec(column ?? '')?.[1]?.toLowerCase();
  if (bucket) return (key: unknown) => sayBucket(bucket, key);
  const rule = columnDisplay(table ?? '', column ?? '') as DisplayRule | null;
  const allowed = (findTable(table ?? '') as TableMeta | undefined)?.columns.find((c) => c.name === column)?.allowed;
  return (key: unknown) => groupLabel(rule, key, allowed);
}

/** A weekday or hour bucket's key in the reader's words: 2024-01-01 was a Monday. */
function sayBucket(bucket: string, key: unknown): string {
  const n = Number(key);
  if (key == null || key === '' || !Number.isInteger(n)) return String(key ?? '—');
  const at = bucket === 'weekday' ? new Date(Date.UTC(2024, 0, n)) : new Date(Date.UTC(2024, 0, 1, n));
  const options: Intl.DateTimeFormatOptions =
    bucket === 'weekday' ? { weekday: 'short', timeZone: 'UTC' } : { hour: 'numeric', timeZone: 'UTC' };
  return at.toLocaleString(formatLocale(), options);
}

/* The schema as the dashboard's asks read it (shared/dashboardAsks.ts), through the walk's own helpers. */
const lookups: AskLookups = {
  table: (id) => findTable(id) as TableMeta | undefined,
  references: (id) => refsFrom(id) as ForeignKey[],
  referenceNames,
  naming: (table) => labelPath(table) as string | undefined,
};

/* ---------- metric ---------- */

/** A section's mark, leading its title: one of the App's curated icons, its glyph in the App payload. */
function Mark({ section }: { section: Section }) {
  return section.icon ? <Icon name={section.icon} size={16} className="dash-section-icon" /> : null;
}

/** A change's news, as a class: ' good' or ' bad' where the metric says which way is better, else nothing. */
export function changeTone(diff: number, better: 'up' | 'down' | undefined): '' | ' good' | ' bad' {
  if (!better || diff === 0 || !Number.isFinite(diff)) return '';
  return diff > 0 === (better === 'up') ? ' good' : ' bad';
}

/** What a compare window is, as a card says it beside its change: "vs prior 90 days". */
export function comparedWith(compare: string | undefined, level = false): string | undefined {
  const period = /\bprevious\s+(\d+)\s+(minute|hour|day|week|month|year)s?\b/i.exec(compare ?? '');
  if (!period) return compare ? sayCopy(level ? 'sameAsTheCompareWindow' : 'vsTheCompareWindow') : undefined;
  const n = Number(period[1]);
  return sayCopy(level ? 'sameAsPrior' : 'vsPrior', { period: n === 1 ? period[2].toLowerCase() : `${n} ${period[2].toLowerCase()}s` });
}

interface MetricProps {
  section: Section;
  /** The section's own period picker, when it has windows of its own (SectionPeriod). */
  period?: ReactNode;
  /** The reader has picked a window on this dashboard: a card it does not move says so. */
  windowed?: boolean;
  /** A card beside it in the row says the window it is over: a card with none says it is the present, so
      the row reads evenly rather than one figure standing with nothing under it. */
  dated?: boolean;
  /** Home keeps its own click and its own way of saying what went wrong. */
  onOpen?: () => void;
  onErrorClick?: () => void;
}

/**
 * One KPI card: the number, its label, its delta when a compare window is
 * given. The app home's cards and a dashboard's metrics are this same
 * card. A card carrying a resolution `error` shows the honest dash.
 */
export const Metric = memo(function Metric({
  section,
  windowed: offered = false,
  dated = false,
  period,
  onOpen,
  onErrorClick,
}: MetricProps) {
  const label = section.title ?? section.table ?? '';
  const windowNote = section.windowNote;
  const live = !section.error;
  const now = useMeasure(section, section.query, live);
  const say = sayer(section, now.data, { card: true });
  /* The figure whole, where the card says it compact: its title, and what a screen reader hears. */
  const sayWhole = sayer(section, now.data, { whole: true });
  const then = useMeasure(section, section.compare, live && Boolean(section.compare));
  /* A goal read from data is a second measure, in the metric's own words; a number needs no read. */
  const goalAsk = typeof section.target === 'object' && section.target ? section.target : undefined;
  const goalData = useMeasure(goalAsk ?? section, goalAsk?.query, live && Boolean(goalAsk));
  /* The spark: over a window, the metric across that window in the span's
     unit — thirty days of "last 30 days", twelve months of "last 12
     months" — drawn under the number beside its change; with none, the
     author's `spark: true` is the last twelve months by the section's own
     clock (`over`). It composes with whatever the card is narrowed to by
     other than time: a picked owner's card shows a picked owner's trend. */
  /* No trend line through several currencies' sums: there is no one line to draw. */
  const sparkAsk = live && !currencySplit(section) ? sparkText(section) : null;
  const spark = useBreakdown(sparkAsk, section.table);

  const shown = section.error ? '—' : now.isError ? '—' : now.data === undefined ? '…' : say(now.data);
  const whole = section.error || now.isError || now.data === undefined ? shown : sayWhole(now.data);
  /* While the figure is read it is a placeholder at the figure's own size, not "…" set at the figure's 32px, which
     stood on the card as three heavy dots. Heard as "…" still (heard, below). */
  const figure = shown === '…' ? <span className="sk-bar home-card-wait" aria-hidden="true" /> : shown;
  let delta: ReactNode = null;
  /* The change's news, which the trend beside it is drawn in too. */
  let tone = '';
  if (section.compare && now.data != null && then.data != null) {
    const a = Number(now.data);
    const b = Number(then.data);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const diff = a - b;
      /* Coloured only when the author said which way is good news. "More"
         is not always "better", so without a word the tone stays neutral. */
      tone = changeTone(diff, section.better);
      /* A change says what it is a change from: "↓ $785.1K" alone left the
         reader to guess the period it was measured against. */
      const against = comparedWith(section.compare, diff === 0);
      /* Unchanged is one phrase, "Same as prior 30 days", not a figure with nothing to say. */
      delta =
        diff === 0 ? (
          <span className="dash-delta" title={sayCopy('inTheCompareWindow', { b: say(b), compare: section.compare })}>
            <span className="dash-delta-whole">{against ?? sayCopy('sameAsBefore')}</span>
          </span>
        ) : (
          <span className={`dash-delta${tone}`} title={sayCopy('inTheCompareWindow', { b: say(b), compare: section.compare })}>
            <span className="dash-delta-figure">{`${diff > 0 ? '↑' : '↓'} ${say(Math.abs(diff))}`}</span>
            {against && (
              <>
                {' '}
                <span className="dash-delta-period">{against}</span>
              </>
            )}
          </span>
        );
    }
  }
  const sparkPoints = useMemo(() => {
    const rows = spark.data;
    if (!rows) return null;
    const [keyName, valueName] = rows.columns ?? [];
    const read = (rows.rows ?? [])
      .map((r) => ({ key: r[keyName], value: r[valueName] }))
      .sort((a, b) => (String(a.key) < String(b.key) ? -1 : String(a.key) > String(b.key) ? 1 : 0));
    const over = sparkWindow(section);
    const now = new Date();
    return over ? trendPoints(read, over.read, over.unit, section.measure, dateWindow(over.phrase, now), now) : read;
  }, [spark.data, section]);
  /* Both slots stand from the first paint: a change the card will show holds its line while the two figures are
     read, and a trend its height, so neither arrives by pushing the card taller. */
  const deltaSlot = delta ?? (
    <span className="dash-delta" aria-hidden={section.compare ? 'true' : undefined}>
      {section.compare && !section.error ? '\u00a0' : null}
    </span>
  );
  const sparkSlot = sparkAsk ? <SparkHost points={sparkPoints} say={say} tone={tone} /> : null;
  /* A goal makes the card a meter: the share reached drawn under the number
     and said beside it, the bar full at the goal and never past it. */
  const goalAt = typeof section.target === 'number' ? section.target : goalAsk ? Number(goalData.data ?? NaN) : NaN;
  const goal = Number.isFinite(goalAt) && goalAt > 0 ? goalAt : undefined;
  const reached =
    goal !== undefined && !section.error && now.data != null && Number.isFinite(Number(now.data)) ? Number(now.data) / goal : undefined;
  /* A whole is the figure's own cohort counted without its extra conditions: said as a share of it, "118 of 159
     (74%)", not as a goal reached. */
  const share = reached === undefined ? undefined : formatPercent(reached * 100, { maximumFractionDigits: 0 });
  const wholeWords = section.targetWhole && goal !== undefined && share !== undefined;
  const goalWords =
    goal === undefined
      ? ''
      : reached === undefined
        ? sayCopy('target', { goal: say(goal) })
        : section.targetWhole
          ? sayCopy('ofWhole', { figure: say(now.data), whole: say(goal), reached: share! })
          : sayCopy('ofTarget', { reached: share!, goal: say(goal) });
  /* What a screen reader hears: the figure once, then its share, never the visible words after the figure again. */
  const heard = wholeWords
    ? `${label}: ${sayCopy('ofWholeSaid', { figure: sayWhole(now.data), whole: sayWhole(goal), percent: String(Math.round(reached! * 100)) })}`
    : `${label}: ${whole}${goalWords ? `, ${goalWords}` : ''}`;
  /* A metric that names a list view opens that room — its tabs, its
     presentation — on the rows it counted, and says so with an arrow: the
     whole card is the way in. One the reader is not served opens the table. */
  const app = activeApp();
  const opens = section.view && app && viewRoom(app, section.view) ? section.view : undefined;
  /* `to: false`: a figure that is read where it stands, not a way into rows, so nothing in it is a control. */
  const still = section.noDrill === true && !section.error;
  const open = section.error
    ? (onErrorClick ?? (() => {}))
    : (onOpen ?? (() => go({ ...tableView(section.table, fullQuery(section)), ...(opens ? { view: opens } : {}) }, 'push')));
  /* A card with its own period holds the picker, and a button cannot hold
     another control: the card is a box, its label the way in. */
  if (period) {
    return (
      <div className={`home-card home-card-period${opens ? ' opens-view' : ''}`} title={section.error ?? fullQuery(section)}>
        <span className="home-card-value" aria-hidden="true" title={whole === shown ? undefined : whole}>
          {figure}
        </span>
        <span className="home-card-label">
          {still ? (
            <span className="home-card-open" aria-label={heard}>
              <Mark section={section} />
              {label}
            </span>
          ) : (
            <button type="button" className="home-card-open" aria-label={heard} onClick={open}>
              <Mark section={section} />
              {label}
              {opens && (
                <>
                  {/* A word joiner: the arrow follows the label's last word, never wraps alone. */}
                  {'\u2060'}
                  <span className="home-card-go" aria-hidden="true">
                    →
                  </span>
                </>
              )}
            </button>
          )}
          {period}
        </span>
        {deltaSlot}
        {windowNote && !section.error && <span className="dash-fixed dash-window">{windowNote}</span>}
        {goal !== undefined && (
          <span className="dash-target">
            <span className="dash-target-meter" aria-hidden="true">
              <span style={{ width: `${Math.round(Math.min(1, Math.max(0, reached ?? 0)) * 100)}%` }} />
            </span>
            <span className="dash-target-text">{goalWords}</span>
          </span>
        )}
        {sparkSlot}
      </div>
    );
  }
  const Card = still ? 'div' : 'button';
  return (
    <Card
      {...(still ? { role: 'group' } : { type: 'button' as const, onClick: open })}
      className={`home-card${still ? ' home-card-still' : opens ? ' opens-view' : ''}`}
      aria-label={heard}
      title={section.error ?? fullQuery(section)}
    >
      <span className="home-card-value" title={whole === shown ? undefined : whole}>
        {figure}
      </span>
      <span className="home-card-label">
        <Mark section={section} />
        {label}
        {opens && (
          <>
            {/* A word joiner: the arrow follows the label's last word, never wraps alone. */}
            {'\u2060'}
            <span className="home-card-go" aria-hidden="true">
              →
            </span>
          </>
        )}
      </span>
      {deltaSlot}
      {/* The window above moves every card that has a clock; once the reader
          has picked one, a card without says so, quietly. Under All time no
          card is narrowed, so the note would only be noise on a card that
          was never about time — what is on order, what is short. */}
      {offered && !section.over && !section.error && (
        <span className="dash-fixed" title={sayCopy('theTimeWindowAbove')}>
          {sayCopy('fixedWindow')}
        </span>
      )}
      {/* A card over a clock with no window counts every time; one with no clock counts what stands now. */}
      {dated && !offered && !windowNote && !section.error && (
        <span className="dash-fixed">{sayCopy(section.over ? 'allTime' : 'fixedWindow')}</span>
      )}
      {/* The window the author set, said under the figure rather than wrapped into its label (metricWindow). */}
      {windowNote && !section.error && <span className="dash-fixed dash-window">{windowNote}</span>}
      {goal !== undefined && (
        <span className="dash-target">
          <span className="dash-target-meter" aria-hidden="true">
            <span style={{ width: `${Math.round(Math.min(1, Math.max(0, reached ?? 0)) * 100)}%` }} />
          </span>
          <span className="dash-target-text">{goalWords}</span>
        </span>
      )}
      {sparkSlot}
    </Card>
  );
});

/** The measure's shape inside the card, its height held while it is read and where it has too few points to draw. */
function SparkHost({
  points,
  say,
  tone,
}: {
  points: Array<{ key: unknown; value: unknown }> | null;
  say: (v: unknown) => string;
  tone: string;
}) {
  return <span className={`spark-host is-reserved${tone}`}>{points && points.length >= 4 && <Sparkline rows={points} say={say} />}</span>;
}

/* ---------- breakdown, chart, matrix ---------- */

/* How many groups a breakdown asks for before it orders them itself (orderGroups): shared/dashboardAsks.ts. */
const askedFor = groupsAskedFor;

/** The order of the column a section groups by, where it declares one (groupOrder.ts, declaredOrder). */
function orderOf(table: string | undefined, by: string | undefined): { vocabulary?: string[]; scale: boolean } {
  /* A computed column (an age in days) is not among the table's own columns: its declared type says whether it is a
     scale (shared/computed.ts). */
  const meta = findTable(table ?? '') as TableMeta | undefined;
  const computed = by && meta?.computed && Object.hasOwn(meta.computed, by) ? meta.computed[by] : undefined;
  const column = meta?.columns.find((c) => c.name === by) ?? (computed ? { type: computed.type } : undefined);
  return declaredOrder(column, by ? (columnDisplay(table ?? '', by) as DisplayRule | null) : null, by);
}

/**
 * A breakdown's goals by group key (G76): each group's goal, the groups with a goal and nothing measured yet (a seller
 * with a quota and no wins is at 0%, not missing), and the goal answer's names for those.
 */
function goalsOf(section: Section, answer: Breakdown | undefined, keyName: string, countName: string) {
  const goal = section.target;
  if (typeof goal !== 'object' || !goal.by || !answer) return undefined;
  const [goalKey, goalValue] = answer.columns ?? [];
  const goals = new Map<string, number>();
  for (const row of answer.rows ?? []) {
    const value = Number(row[goalValue]);
    if (row[goalKey] != null && Number.isFinite(value) && value > 0) goals.set(String(row[goalKey]), value);
  }
  return {
    of: (key: unknown) => (key == null ? undefined : goals.get(String(key))),
    /* Each goal's group the measure has no row for, at nothing reached. */
    unmet: (measured: readonly Record<string, unknown>[]) => {
      const seen = new Set(measured.map((row) => String(row[keyName])));
      return (answer.rows ?? [])
        .filter((row) => row[goalKey] != null && goals.has(String(row[goalKey])) && !seen.has(String(row[goalKey])))
        .map((row) => ({ [keyName]: row[goalKey], [countName]: 0 }));
    },
    sayKey: namedGroups(answer, goalKey, sayGroup(goal.table, goal.by)),
  };
}

/** The vocabulary of the column a section groups by, where one is declared. */
const vocabularyOf = (table: string | undefined, column: string | undefined): string[] | undefined => orderOf(table, column).vocabulary;

const BreakdownRows = memo(function BreakdownRows({ section }: { section: Section }) {
  const data = useBreakdown(breakdownText(section, askedFor(section)), section.table);
  /* A goal per group (G76): the target table's measure by its own column, a seller's quota beside their won. */
  const goals = useBreakdown(targetText(section), typeof section.target === 'object' ? section.target?.table : undefined);
  const drill = drillFor(section);
  const say = sayer(section);
  if (data.isError) return <Problem text={(data.error as Error).message} />;
  if (goals.isError) return <Problem text={(goals.error as Error).message} />;
  /* While read, its rows as they will stand — a group's word, its count's place, its bar — one per group the
     vocabulary or the limit says will come: an empty box was nothing tall, and the rows arriving pushed the sections
     under it down. */
  if (!data.data || (targetText(section) && !goals.data)) {
    const expected = Math.min(Math.max(section.limit ?? vocabularyOf(section.table, section.by)?.length ?? 3, 1), 8);
    return (
      <div className="page-breakdown-rows" role="status" aria-busy="true">
        {Array.from({ length: expected }, (_, i) => (
          <div key={i} className="pbd-row pbd-wait" aria-hidden="true">
            <span className="pbd-label">
              <span className="sk-bar" style={{ width: `${[58, 44, 66, 38][i % 4]}%`, height: '10px' }} />
            </span>
            <span className="pbd-bar" />
            <span className="pbd-count">{'\u00a0'}</span>
          </div>
        ))}
      </div>
    );
  }
  const [keyName, countName] = data.data.columns ?? [];
  const goal = goalsOf(section, goals.data, keyName, countName);
  const { vocabulary, scale } = orderOf(section.table, section.by);
  /* A scale with a limit keeps its largest groups, then reads them in its order: the first five days of an age
     histogram are not its five busiest. */
  const measured = [...(data.data.rows ?? []), ...(goal?.unmet(data.data.rows ?? []) ?? [])];
  const kept = scale && !vocabulary && section.limit ? orderGroups(measured, keyName, countName).slice(0, section.limit) : measured;
  const rows = orderDeclared(kept, keyName, countName, vocabulary, scale).slice(0, section.limit);
  if (!rows.length)
    return section.emptyMode === 'hide' ? (
      <LeaveOut />
    ) : (
      <Empty text={inAppMode() ? sayCopy('nothingToCountYet') : sayCopy('noToCount', { table: section.table ?? '' })} />
    );
  const largest = Math.max(...rows.map((r) => Number(r[countName]) || 0));
  const sayRow = say.among(rows.map((r) => r[countName]));
  const sayKey = namedGroups(data.data, keyName, goal?.sayKey ?? sayGroup(section.table, section.by));
  /* A group of a column that colors its values (a severity, a state) wears that color, as its chip does in a list and
     a chart's bar does (G209). Against a goal the bar is progress, not the group's meaning, so it keeps the accent. */
  const toneOf =
    !goal && section.by && !/\s/.test(section.by)
      ? (key: unknown) => TONE_INK[ruleSays(columnDisplay(section.table ?? '', section.by!) as DisplayRule | null, key).tone ?? '']
      : undefined;
  return (
    <div className="page-breakdown-rows">
      {rows.map((row, i) => {
        const key = row[keyName];
        /* Against a goal the bar is the share reached, full at the goal and never past it, as a metric's meter. */
        const target = goal?.of(key);
        const reached = target ? (Number(row[countName]) || 0) / target : undefined;
        const ink = toneOf?.(key);
        const parts = (
          <>
            <span className="pbd-label">{sayKey(key)}</span>
            <span className="pbd-bar">
              <span
                className={`pbd-fill${ink ? ' is-toned' : ''}`}
                style={{
                  width: `${goal ? Math.round(Math.min(1, Math.max(0, reached ?? 0)) * 100) : barShare(row[countName], largest)}%`,
                  ...(ink ? { ['--bar-ink' as string]: ink } : {}),
                }}
              />
            </span>
            <span className="pbd-count">
              {sayRow(row[countName])}
              {target !== undefined && (
                <span className="pbd-goal">
                  {' '}
                  {sayCopy('ofTarget', { reached: formatPercent(reached! * 100, { maximumFractionDigits: 0 }), goal: say(target) })}
                </span>
              )}
            </span>
          </>
        );
        /* A row that goes somewhere is a button; one that cannot (a null
           group, no drill) stays text — no dead cursors. */
        const link = drill && key != null ? drill.link(key) : undefined;
        const title = sayCopy('openTableWhereBy', { table: section.table ?? '', by: section.by ?? '', key: String(key) });
        if (link)
          return (
            <a key={i} className="pbd-row pbd-drill" href={link.href} title={title} onClick={link.onClick}>
              {parts}
            </a>
          );
        return drill && key != null ? (
          <button key={i} type="button" className="pbd-row pbd-drill" title={title} onClick={() => drill(key)}>
            {parts}
          </button>
        ) : (
          <div key={i} className="pbd-row">
            {parts}
          </div>
        );
      })}
    </div>
  );
});

/**
 * A funnel: how many of a table's rows reach each stage, in order. The stages are counted in one statement
 * (shared/funnel.ts), so a later stage is never longer than the one before it. A stage opens the rows that reached it,
 * and the figure it lost opens the rows that stopped there — where the language can say them exactly.
 */
const FunnelSection = memo(function FunnelSection({ section }: { section: Section }) {
  const data = useBreakdown(funnelText(section), section.table);
  const say = sayer(section);
  const stages = section.stages ?? [];
  if (data.isError) return <Problem text={(data.error as Error).message} />;
  const row = data.data?.rows?.[0];
  if (row && !Number(row[stageColumn(0)]) && section.emptyMode === 'hide') return <LeaveOut />;
  const target = drillTarget(section);
  const door = (query: string | undefined): FunnelDoor | undefined => {
    if (target === null || !section.table) return undefined;
    if (query === undefined) return undefined;
    const text = `${section.table} ${andQuery(section.query, query)}`.trim();
    if (target === undefined) return { open: () => go(tableView(section.table, text), 'push') };
    const entry = listEntry(target, text);
    return entry ? { link: listLink(target, text), open: () => go(entry, 'push') } : undefined;
  };
  const chains = funnelChains(stages);
  const basis = funnelBasis(stages);
  return (
    <Funnel
      table={section.table ?? ''}
      say={say}
      steps={stages.map((stage, i) => ({
        title: stage.label,
        optional: stage.optional,
        count: row ? Number(row[stageColumn(i)]) || 0 : undefined,
        basis: basis[i],
        reached: door(chains[i] || ''),
        dropped: door(droppedQuery(stages, i)),
      }))}
    />
  );
});

/**
 * A breakdown drawn as steps: a card for each value of the column, in its
 * own order (the vocabulary's, else the counts'), joined by arrows — orders
 * received, picked, packed, shipped. A step's mark is the value's icon from
 * the column's display rule, in its tone; one without an icon has no mark (a number beside the count read as a second count).
 * A step goes to its list as a breakdown's row does. Every value of the
 * vocabulary is a step, so a stage with nothing in it still holds its place.
 */
const StepCards = memo(function StepCards({ section }: { section: Section }) {
  const data = useBreakdown(breakdownText(section, askedFor(section)), section.table);
  const drill = drillFor(section);
  const say = sayer(section);
  const vocabulary = vocabularyOf(section.table, section.by);
  const rule = columnDisplay(section.table ?? '', section.by ?? '') as DisplayRule | null;
  const sayKey = sayGroup(section.table, section.by);
  if (data.isError) return <Problem text={(data.error as Error).message} />;
  const [keyName = '', countName = ''] = data.data?.columns ?? [];
  const counted = data.data ? orderGroups(data.data.rows ?? [], keyName, countName, vocabulary) : [];
  const keys = vocabulary ?? counted.map((row) => row[keyName]);
  const countOf = new Map(counted.map((row) => [String(row[keyName]), row[countName]]));
  const steps = keys.filter((key) => key != null).slice(0, section.limit ?? 8);
  if (data.data && !steps.length) return section.emptyMode === 'hide' ? <LeaveOut /> : <Empty text={sayCopy('nothingToCountYet')} />;
  // Rows of four or fewer, as even as the count allows (eight steps are two rows of four, not six and two): the
  // columns are named here so a step that starts a row is known to the looks that part the cells with hairlines.
  const cols = steps.length <= 4 ? Math.max(steps.length, 1) : Math.ceil(steps.length / Math.ceil(steps.length / 4));
  return (
    <ol
      className="dash-steps"
      style={{ ['--steps' as string]: Math.max(steps.length, 1), ['--cols' as string]: cols }}
      aria-busy={!data.data || undefined}
    >
      {steps.map((key, index) => {
        const text = String(key);
        const { tone } = ruleSays(rule, text);
        const icon = rule?.icons && Object.hasOwn(rule.icons, text) ? (rule.icons[text] as AppIconName) : undefined;
        const note = section.notes?.[text];
        const figure = data.data ? say(countOf.get(text) ?? 0) : '\u00a0';
        const body = (
          <>
            {icon && (
              <span className={`dash-step-mark${tone ? ` tone-${tone}` : ''}`} aria-hidden="true">
                <Icon name={icon} size={16} />
              </span>
            )}
            <span className="dash-step-words">
              <span className="dash-step-title">{sayKey(key)}</span>
              {note && <span className="dash-step-note">{note}</span>}
            </span>
            <span className="dash-step-figure">{figure}</span>
          </>
        );
        return (
          <li
            key={text}
            className={`dash-step${tone ? ` is-${tone}` : ''}${index % cols === 0 ? ' is-row-start' : ''}${icon ? '' : ' no-mark'}`}
          >
            {drill ? (
              (() => {
                const link = drill.link(key);
                const title = sayCopy('openTableWhereBy', { table: section.table ?? '', by: section.by ?? '', key: text });
                return link ? (
                  <a className="dash-step-card" href={link.href} title={title} onClick={link.onClick}>
                    {body}
                  </a>
                ) : (
                  <button type="button" className="dash-step-card" title={title} onClick={() => drill(key)}>
                    {body}
                  </button>
                );
              })()
            ) : (
              <div className="dash-step-card">{body}</div>
            )}
            {index < steps.length - 1 && <Icon name="caret-right" size={14} className="dash-step-arrow" />}
          </li>
        );
      })}
    </ol>
  );
});

/**
 * A chart is a breakdown drawn instead of listed: same fetch, same
 * grammar, the rows handed to the SVG. Money measures speak money in the
 * ticks, the tooltips and the legend, through the same rule as everywhere.
 */
/** The unit an `auto` chart chose, in words. */
const sayUnit = (unit: 'day' | 'week' | 'month' | 'quarter'): string =>
  unit === 'day' ? sayCopy('byDay') : unit === 'week' ? sayCopy('byWeek') : unit === 'month' ? sayCopy('byMonth') : sayCopy('byQuarter');

const Chart = memo(function Chart({ section }: { section: Section }) {
  /* Stacked bars cross two keys, as a matrix does: every cross is fetched
     and the chart keeps the longest bars, so `limit` counts bars, not rows. */
  const stacked = section.shape === 'stacked';
  const donut = section.shape === 'donut';
  /* Bars over categories are ordered here, as a donut's slices are, so they ask for every group first. */
  /* `auto` (autoChart.ts): the unit is chosen from the window and the data, so what is asked is the section in that
     unit (or nothing, while the data's extent is read), and what is drawn is the answer coarsened to it. */
  const auto = useAutoChart(section, (text) => useBreakdown(text, section.table));
  const data = useBreakdown(
    auto ? (auto.ask ? breakdownText(auto.ask, chartLimit(section)) : null) : breakdownText(section, chartLimit(section)),
    section.table,
  );
  const drawn = auto?.draw(data);
  const answer = auto ? drawn?.answer : data.data;
  const [firstKey = '', secondKey = ''] = (section.by ?? '').split(',').map((key) => key.trim());
  if (data.isError) return <Problem text={(data.error as Error).message} />;
  const label = namedGroups(answer, answer?.columns?.[0], sayGroup(section.table, firstKey));
  const seriesLabel = namedGroups(answer, secondKey ? answer?.columns?.[1] : undefined, sayGroup(section.table, secondKey));
  const empty = inAppMode() ? sayCopy('nothingToDrawYet') : sayCopy('noToDraw', { table: section.table ?? '' });
  if (section.emptyMode === 'hide' && answer && !(answer.rows ?? []).length) return <LeaveOut />;
  /* The unit the chart chose, said as text under the title: the slot is held from the first paint so naming it moves nothing. */
  const unitNote = auto ? <p className="chart-unit">{drawn?.unit ? sayUnit(drawn.unit) : null}</p> : null;
  if (section.shape && EXTRA_SHAPES.includes(section.shape))
    return (
      <>
        {unitNote}
        <ChartShapeFigure
          shape={section.shape as ExtraShape}
          answer={answer}
          say={sayer(section).among((answer?.rows ?? []).map((row) => row[answer?.columns?.at(-1) ?? '']))}
          /* The section's `format` and `unit` say its measure, the one up the side; the across measure is said by its own column. */
          sayX={section.x ? sayer({ ...section, measure: section.x, format: undefined, unit: undefined }) : undefined}
          names={{ x: section.x ?? '', y: section.measure ?? 'count' }}
          label={label}
          seriesLabel={seriesLabel}
          vocabulary={vocabularyOf(section.table, firstKey)}
          seriesVocabulary={secondKey ? vocabularyOf(section.table, secondKey) : undefined}
          limit={section.limit}
          target={typeof section.target === 'number' ? section.target : undefined}
          height={section.height}
          empty={empty}
        />
      </>
    );
  return (
    <>
      {unitNote}
      <ChartFigure
        answer={answer}
        dots={drawn?.dots}
        shape={section.shape as 'line' | 'bar' | 'donut' | 'stacked' | undefined}
        limit={section.limit}
        target={typeof section.target === 'number' ? section.target : undefined}
        height={section.height}
        say={sayer(section)}
        label={label}
        seriesLabel={seriesLabel}
        vocabulary={vocabularyOf(section.table, firstKey)}
        seriesVocabulary={secondKey ? vocabularyOf(section.table, secondKey) : undefined}
        scale={orderOf(section.table, firstKey).scale}
        seriesScale={secondKey ? orderOf(section.table, secondKey).scale : undefined}
        seriesTone={
          stacked && secondKey
            ? (key) => ruleSays(columnDisplay(section.table ?? '', secondKey) as DisplayRule | null, key).tone
            : undefined
        }
        tone={
          (donut || section.shape === 'bar') && firstKey && !/\s/.test(firstKey)
            ? (key) => ruleSays(columnDisplay(section.table ?? '', firstKey) as DisplayRule | null, key).tone
            : undefined
        }
        sayLegend={stacked ? (totals) => legendSayer(section, totals) : undefined}
        onPick={
          donut || section.shape === 'line'
            ? drillFor(section)
            : stacked && !/\s/.test(firstKey)
              ? drillFor({ ...section, by: firstKey })
              : null
        }
        empty={empty}
        curve={section.curve}
        total={section.total}
      />
    </>
  );
});

/**
 * A matrix: the measure crossed over two keys — rows by the first,
 * columns by the second, heat by the value. The pivot happens here (the
 * breakdown answers flat groups), columns sort ascending when they read
 * as dates and by weight otherwise, and the biggest cell sets the scale.
 */
/**
 * Whether a matrix wider than its section is folded: each row said as its figures, each under its column's name,
 * rather than scrolled sideways (docs/design.md: nothing scrolls sideways inside a section). Its natural width is
 * read while it stands as a table, so it stands as one again when the room grows to hold it; `shape` is its rows
 * and columns, a change of which reads the width afresh.
 */
function useMatrixFold(host: { current: HTMLDivElement | null }, shape: string): boolean {
  const [fold, setFold] = useState<{ shape: string; natural: number } | null>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const judge = () => {
      const table = element.querySelector('table');
      if (!table) return;
      const natural = fold?.shape === shape ? fold.natural : table.offsetWidth;
      const folds = natural > element.clientWidth + 1;
      setFold((was) => (folds ? (was?.shape === shape && was.natural === natural ? was : { shape, natural }) : null));
    };
    judge();
    const observer = new ResizeObserver(judge);
    observer.observe(element);
    return () => observer.disconnect();
  }, [host, shape, fold]);
  return fold?.shape === shape;
}

const Matrix = memo(function Matrix({ section }: { section: Section }) {
  const data = useBreakdown(breakdownText(section, 400), section.table);
  const host = useRef<HTMLDivElement>(null);
  const shape = `${data.data?.rows?.length ?? 0}:${(data.data?.columns ?? []).join(',')}`;
  const folded = useMatrixFold(host, shape);
  if (data.isError) return <Problem text={(data.error as Error).message} />;
  if (!data.data) return <div className="matrix-host" ref={host} />;
  const [rowKey, colKey, valueName] = data.data.columns ?? [];
  const cells = new Map<string, unknown>();
  const rowTotals = new Map<string, number>();
  const colTotals = new Map<string, number>();
  for (const r of data.data.rows ?? []) {
    const a = r[rowKey] == null ? '—' : String(r[rowKey]);
    const b = r[colKey] == null ? '—' : String(r[colKey]);
    const v = Number(r[valueName]) || 0;
    cells.set(`${a}\u0000${b}`, r[valueName]);
    rowTotals.set(a, (rowTotals.get(a) ?? 0) + v);
    colTotals.set(b, (colTotals.get(b) ?? 0) + v);
  }
  if (!cells.size)
    return section.emptyMode === 'hide' ? (
      <LeaveOut />
    ) : (
      <Empty text={inAppMode() ? sayCopy('nothingToCrossYet') : sayCopy('noToCross', { table: section.table ?? '' })} />
    );
  /* Rows in the first key's vocabulary order where it has one (a stage reads
     as a pipeline), else heaviest first; ten at most. */
  const rowKeyColumn = (section.by ?? '').split(',')[0].trim();
  const rows = orderGroups(
    [...rowTotals.entries()].map(([key, total]) => ({ key, total })),
    'key',
    'total',
    vocabularyOf(section.table, rowKeyColumn),
  )
    .slice(0, 10)
    .map(({ key }) => key);
  const dated = [...colTotals.keys()].every((k) => /^\d{4}(-\d{2})?/.test(k) || k === '—');
  /* Columns as the rows are: in the second key's vocabulary order where it
     has one (low, medium, high, urgent), else heaviest first; and said in
     its words, as a breakdown says them ("Urgent", not "urgent"). */
  const colKeyColumn = ((section.by ?? '').split(',')[1] ?? '').trim();
  const cols = dated
    ? [...colTotals.keys()].sort()
    : orderGroups(
        [...colTotals.entries()].map(([key, total]) => ({ key, total })),
        'key',
        'total',
        vocabularyOf(section.table, colKeyColumn),
      )
        .slice(0, 12)
        .map(({ key }) => key);
  const sayCol = namedGroups(data.data, colKey, sayGroup(section.table, colKeyColumn));
  const max = Math.max(...rows.flatMap((a) => cols.map((b) => Number(cells.get(`${a}\u0000${b}`)) || 0)), 1);
  /* One form across the grid: where any cell reaches a thousand every cell is said compact, so "$4,470" never
     stands beside "$548K". The cell's title says the figure whole. */
  const sayWhole = sayer(section);
  const say = max >= 1000 ? sayWhole.tick : sayWhole;
  const firstKey = (section.by ?? '').split(',')[0].trim();
  const sayRow = namedGroups(data.data, rowKey, sayGroup(section.table, firstKey));
  const drill = !/\s/.test(firstKey) ? drillFor({ ...section, by: firstKey }) : null;
  const colLabel = (b: string, at: number) => (dated ? periodTick(b, at ? cols[at - 1] : undefined) : sayCol(b === '—' ? null : b));
  /* Folded, the rows and cells are drawn as a grid, which drops a table's own roles: they are said, so a reader
     still hears each figure under its row and column. */
  return (
    <div className="matrix-host" ref={host} data-fold={folded || undefined}>
      <div className="table-wrap matrix-wrap">
        <table className="matrix" role="table">
          <thead role="rowgroup">
            <tr role="row">
              <th className="matrix-corner" role="columnheader" />
              {cols.map((b, at) => (
                <th key={b} className="matrix-col" role="columnheader">
                  {colLabel(b, at)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {rows.map((a) => (
              <tr key={a} role="row">
                <th className="matrix-row" role="rowheader">
                  {drill ? (
                    <button type="button" className="matrix-drill" onClick={() => drill(a)}>
                      {sayRow(a)}
                    </button>
                  ) : (
                    <span>{sayRow(a)}</span>
                  )}
                </th>
                {cols.map((b, at) => {
                  const raw = cells.get(`${a}\u0000${b}`);
                  const v = Number(raw) || 0;
                  /* Heat says weight; the number stays the fact. Empty stays
                     empty — a zero someone wrote and a cross nobody made are
                     different silences. */
                  return (
                    <td
                      key={b}
                      className="matrix-cell"
                      role="cell"
                      data-label={folded ? String(colLabel(b, at) ?? '') : undefined}
                      style={
                        v
                          ? ({
                              /* Its share of the heaviest; features.css tints it up to the palette's heat top. */
                              '--heat': (v / max).toFixed(3),
                              background: 'var(--heat-fill)',
                            } as CSSProperties)
                          : undefined
                      }
                      title={v ? `${sayRow(a)} × ${dated ? b : sayCol(b === '—' ? null : b)}: ${sayWhole(raw)}` : undefined}
                    >
                      {v ? say(raw) : ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});

/* ---------- list and board ---------- */

/**
 * The full list, with its tabs and filters. An embed opens its view's own
 * room — its tabs, its presentation, its actions — on the rows the section
 * shows; any other section, the list its table and query suggest.
 */
function OpenFull({ section }: { section: Section }) {
  useSyncExternalStore(subscribeMessages, messageLanguage, messageLanguage);
  return (
    <button
      type="button"
      className="ghost dash-open"
      title={sayCopy('theFullListWithItsTabs')}
      onClick={() => go({ ...tableView(section.table, fullQuery(section)), ...(section.view ? { view: section.view } : {}) }, 'push')}
    >
      {message('list.viewAll')}
    </button>
  );
}

/** A column a list says, a label path dressed as the column it ends in. */
function columnAt(table: TableMeta | undefined, name: string): ColumnMeta | undefined {
  if (!table) return undefined;
  if (!name.includes('.')) return table.columns.find((column) => column.name === name);
  const [reference, terminal] = name.split('.');
  const fk = (refsFrom(table.id) as Array<{ from: { columns: string[] }; to: { table: string } }>).find(
    (candidate) => candidate.from.columns.length === 1 && candidate.from.columns[0] === reference,
  );
  const target = fk ? (findTable(fk.to.table) as TableMeta | undefined) : undefined;
  const column = target?.columns.find((candidate) => candidate.name === terminal);
  return column ? { ...column, name } : undefined;
}

/**
 * A list in the aside: names, not a table. The aside is a narrow column,
 * and a grid there cut its names short ("Riley C…") to keep columns nobody
 * compares. Each row is its first column, whole and wrapping; the second a
 * quiet line under it; a third a value at the row's end. The row opens its
 * record, the month's other rows its neighbours.
 */
function AsideRows({
  section,
  table,
  query,
  empty,
  onRows,
}: {
  section: Section;
  table: TableMeta | undefined;
  query: string;
  empty?: ReactNode;
  onRows: (data: { total?: number; exactTotal?: boolean }) => void;
}) {
  const rows = useQuery<Rows & { total?: number; exactTotal?: boolean; errors?: Array<{ message: string }> }>({
    queryKey: ['run', query, section.limit ?? 5],
    queryFn: () => batchedRun({ q: query, limit: section.limit ?? 5, offset: 0 }),
    refetchInterval: minuteTick(query, section.table),
    staleTime: TILE_FRESH,
    placeholderData: keepPreviousData,
  });
  const data = rows.data;
  useEffect(() => {
    if (data && !data.errors?.length) onRows(data);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [first, second, third] = section.show?.length ? section.show : table ? [labelColumn(table) ?? primaryKey(table)[0]] : [];
  /* A person named first wears their photo where the rule names one (avatarPhotos.tsx). */
  const nameRule = first ? (columnDisplay(section.table, first) as DisplayRule | null) : null;
  const photoOwner = first ? avatarOwner(table, first, nameRule, data?.rows?.length ? Object.keys(data.rows[0]) : undefined) : undefined;
  const photoOf = useAvatarPhotos(first ? [{ name: first, display: nameRule, photoOwner }] : [], data?.rows ?? []);
  if (rows.isError || data?.errors?.length) return <Problem text={(rows.error as Error | null)?.message ?? data!.errors![0].message} />;
  if (!data) return <div className="dash-mini" />;
  const got = data.rows ?? [];
  if (!got.length) return <>{empty ?? <Empty text={message('list.nothing')} />}</>;
  const [name, line, value] = [first, second, third].map((path) => (path ? columnAt(table, path) : undefined));
  const pk: string[] = table ? primaryKey(table) : [];
  /* A reference says its record's name, which the section fetched beside it (List). */
  const referenceLabels = table && section.show?.length ? referenceNames(section.table as string, section.show) : undefined;
  const said = (column: ColumnMeta | undefined, row: Row) => {
    if (!column || !table) return null;
    const { column: drawn, value } = namedCell(table, column.name, row, referenceLabels);
    return value != null && value !== '' ? <Value tableId={section.table} col={drawn} value={value} compact /> : null;
  };
  const named = (row: Row) => {
    const photo = photoOwner && name ? photoOf(first, row[photoOwner]) : undefined;
    return photo && name && row[name.name] != null ? <AvatarText text={String(row[name.name])} photo={photo} /> : said(name, row);
  };
  const keyed = got.map((row) => ({ row, key: Object.fromEntries(pk.map((k) => [k, row[k]])), label: String(row[first] ?? '') }));
  const records = keyed.map(({ key, label }) => ({ key, label }));
  return (
    <ul className="dash-mini" aria-label={section.title ?? section.table}>
      {keyed.map(({ row, key, label }, i) => (
        <li key={i}>
          <button
            type="button"
            className="dash-mini-row"
            disabled={!pk.length}
            onClick={() => void openRecord(section.table, key, label, 'push', { records })}
          >
            <span className="dash-mini-text">
              <span className="dash-mini-name">{named(row) ?? label}</span>
              {said(line, row) && <span className="dash-mini-line">{said(line, row)}</span>}
            </span>
            {said(value, row) && <span className="dash-mini-value">{said(value, row)}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * A list is the real table view with the chrome off — the vanilla grid,
 * drawn into a host. Its own stat row (count, timing, Export) is hidden
 * by CSS in here; the one number worth keeping — how many there are in
 * all — moves up beside the title once the answer knows it. In the aside
 * it is names instead (AsideRows), unless it embeds a view drawn its own way.
 */
const List = memo(function List({ section, aside = false, period }: { section: Section; aside?: boolean; period?: ReactNode }) {
  const [count, setCount] = useState('');
  /* How many the section matched, once known: "View all" over none is a door to an empty room. */
  const [matched, setMatched] = useState<number | undefined>();
  const table = findTable(section.table) as TableMeta | undefined;
  /* An explicit view embed keeps the dashboard's already-resolved question,
     but borrows the served view's dress and every column that dress reads.
     A raw dashboard list has no source view, so it stays the vanilla grid. */
  const app = activeApp();
  const room = section.view === undefined || !app ? undefined : viewRoom(app, section.view);
  const source = room && isListRoom(room) && room.table === section.table ? room : undefined;
  // A narrower dashboard question cannot promise the whole source list is empty.
  /* The section's own guidance first: a rows section may say what belongs in it, as a list view does. */
  const authoredEmpty = (section as { empty?: AppListEmpty }).empty;
  const sourceEmpty = authoredEmpty ? (
    <ListEmpty spec={authoredEmpty} />
  ) : source?.empty &&
    splitQuery(`rows ${source.query ?? ''}`).filter.trim() === splitQuery(`rows ${section.query ?? ''}`).filter.trim() ? (
    <ListEmpty spec={source.empty} />
  ) : undefined;
  /* The key columns ride along unseen when the section projects, the same
     bargain the app list strikes: a row with no key on it is a row that
     cannot open, and "see the record" is the whole point of a list. A
     reference is drawn by its record's name, fetched beside it and kept out
     of sight (shared/dashboardAsks.ts, whose words a first page is asked in). */
  const { query, keys, named, referenceLabels } = dashboardListQuery(lookups, section, source?.presentation);
  const onRows = (data: { total?: number; exactTotal?: boolean }) => {
    setMatched(data.total);
    if (!data.total) {
      setCount('');
      return;
    }
    setCount(data.exactTotal === false ? `~${formatApprox(data.total)}` : sayCopy('figureInAll', { figure: figure(data.total) }));
  };
  const presented = source?.presentation && source.presentation.kind !== 'split';
  const mini = aside && !presented && (section.show?.length ?? 0) <= 3;
  /* An embed that opted in works as its room does, under this heading (DashboardList.tsx). */
  const works = section.interactive && source && table;
  return (
    <>
      {section.emptyMode === 'hide' && matched === 0 && <LeaveOut />}
      <div className="dash-list-head">
        <h2 className="page-section-title">
          <Mark section={section} />
          {section.title ?? section.table}
        </h2>
        <span className="stat dash-count">{count}</span>
        {period}
        {matched !== 0 && <OpenFull section={section} />}
      </div>
      {works ? (
        <div className="dash-list dash-list-works">
          <InteractiveList section={section} source={source} onTotal={(total: number | undefined) => onRows({ total })} />
        </div>
      ) : mini ? (
        <AsideRows section={section} table={table} query={query} empty={sourceEmpty} onRows={onRows} />
      ) : (
        <div className="dash-list">
          <TableRoom
            entry={{ kind: 'table', table: section.table as string, query }}
            sizing={section.sizing}
            chrome={false}
            interactive={false}
            embedded
            hide={[...keys, ...named]}
            referenceLabels={referenceLabels}
            labels={section.labels}
            recordNavigation={source?.presentation?.kind === 'cards' || source?.presentation?.kind === 'queue'}
            {...(section.rowActions &&
            app &&
            mayRunAny(app, section.table as string, offeredBy(resourceOf(app, section.table as string)).actions ?? [])
              ? { rowActions: true, actions: offeredBy(resourceOf(app, section.table as string)).actions }
              : {})}
            presentation={source?.presentation}
            present={shell().present ?? undefined}
            listLabel={source?.label}
            order={source?.order}
            empty={sourceEmpty}
            export={exportOffered(app, section.table as string | undefined) ? undefined : false}
            onResult={onRows}
          />
        </div>
      )}
    </>
  );
});

/**
 * A board: lanes of cards by a column's values — the pipeline read every
 * CRM and queue screen is built around, here as one word of config. The
 * lanes are the column's declared vocabulary when the schema states one
 * (every stage shows, empty ones included — an empty lane is a fact),
 * and the observed values by weight when it does not. Read-only on
 * purpose: this layer curates reading, and a drag that writes belongs
 * to the write arc.
 */
const Board = memo(function Board({ section: authored }: { section: Section }) {
  const section = boardSection(authored);
  const table = findTable(section.table) as TableMeta | undefined;
  const counts = useBreakdown(boardCountText(section), section.table);
  const pk: string[] = table ? primaryKey(table) : [];
  const naming = table && labelColumn(table);
  const shown: string[] = section.show?.length ? section.show : naming ? [naming] : pk;
  const rule = columnDisplay(section.table, section.by);
  let lanes: ReactNode;
  if (counts.isError) lanes = <Problem text={(counts.error as Error).message} />;
  else if (counts.data) {
    const [keyName, countName] = counts.data.columns ?? [];
    const byValue = new Map(
      (counts.data.rows ?? []).filter((r) => r[keyName] != null).map((r) => [String(r[keyName]), Number(r[countName]) || 0] as const),
    );
    const vocabulary = (table?.columns.find((c) => c.name === section.by) as (ColumnMeta & { allowed?: string[] }) | undefined)?.allowed;
    const values = section.lanes ?? (vocabulary ?? [...byValue.keys()]).slice(0, 8);
    lanes = values.length ? (
      values.map((value) => (
        <Lane key={value} section={section} value={value} count={byValue.get(value) ?? 0} rule={rule} pk={pk} shown={shown} />
      ))
    ) : (
      <Empty text={inAppMode() ? sayCopy('nothingToLayOut') : sayCopy('noToLayOut', { table: section.table ?? '' })} />
    );
  }
  const nothingOnIt =
    Boolean(counts.data) && [...(counts.data?.rows ?? [])].every((r) => !(Number(r[counts.data?.columns?.[1] ?? '']) || 0));
  return (
    <>
      {authored.emptyMode === 'hide' && nothingOnIt && <LeaveOut />}
      <div className="board-head">
        <h2 className="page-section-title">
          <Mark section={section} />
          {section.title ?? `${section.table} by ${section.by}`}
        </h2>
        <OpenFull section={section} />
      </div>
      <div className="dash-board">{lanes}</div>
    </>
  );
});

function Lane({
  section,
  value,
  count,
  rule,
  pk,
  shown,
}: {
  section: Section;
  value: string;
  count: number;
  rule: unknown;
  pk: string[];
  shown: string[];
}) {
  const laneLimit = section.limit ?? 7;
  const laneQuery = andQuery(section.query, `${section.by} = ${quote(value)}`);
  const q = count
    ? [section.table, laneQuery, section.sort ? `sort ${section.sort}` : '', `show ${[...new Set([...shown, ...pk])].join(', ')}`]
        .filter(Boolean)
        .join(' ')
    : null;
  const rows = useRows(q, laneLimit, section.table);
  const got = rows.data?.rows ?? [];
  const [head, ...rest] = shown;
  return (
    <div className="board-lane">
      <div className="board-lane-head">
        {dressFor(rule as DisplayRule | null, value) ? (
          <Dressed dress={dressFor(rule as DisplayRule | null, value)!} compact={(rule as DisplayRule | null)?.format === 'richText'} />
        ) : (
          <span className="board-lane-name">{value}</span>
        )}
        <span className="board-lane-count">{figure(count)}</span>
      </div>
      <div className="board-cards">
        {got.map((row: Row, i) => {
          const key = Object.fromEntries(pk.map((k) => [k, row[k]]));
          const said =
            row[head] == null
              ? '—'
              : (maskedText(columnDisplay(section.table, head) as DisplayRule | null, row[head]) ?? String(row[head]));
          return (
            <button key={i} type="button" className="board-card" onClick={() => void openRecord(section.table, key, said, 'push')}>
              <span className="board-card-title">{said}</span>
              {rest.map((path) => {
                const v = row[path];
                if (v === null || v === undefined) return null;
                const dress = dressFor(columnDisplay(section.table, path) as DisplayRule | null, v);
                return (
                  <span key={path} className="board-card-line">
                    {dress ? <Dressed dress={dress} compact={dress.kind === 'richText'} /> : <span>{String(v)}</span>}
                  </span>
                );
              })}
            </button>
          );
        })}
        {count > got.length && rows.data && (
          <button
            type="button"
            className="ghost board-more"
            onClick={() => go(tableView(section.table, `${section.table} ${laneQuery}`), 'push')}
          >
            {sayCopy('moreCount', { figure: figure(count - got.length) })}
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- the controls ---------- */

/**
 * The window picker: the unpicked state and the dashboard's offered phrases.
 * Unpicked is "All time" only when it is: where a section keeps a window of
 * its own (`close_date = last 90 days`), the pressed "All time" sat over
 * figures still counting their ninety days, so it says "Default" there, and
 * each figure says its own window (windowTitle, metricWindow).
 */
function WindowRow({
  windows,
  current,
  onPick,
  ownWindows,
  control = 'segmented',
}: {
  windows: string[];
  current: string | null;
  onPick: (w: string | null) => void;
  ownWindows: boolean;
  control?: 'segmented' | 'button';
}) {
  const word = (w: string | null) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : sayCopy(ownWindows ? 'defaultWindow' : 'allTimeWindow'));
  if (control === 'button') {
    /* The dates the window covers, its last day inclusive (the window's end is the next day's start); a phrase the
       calendar cannot place is said as itself. */
    const span = current ? dateWindow(current, new Date()) : undefined;
    const shown = span
      ? sayCopy('windowRange', {
          from: formatDate(span.start, { month: 'short', day: 'numeric' }),
          to: formatDate(new Date(span.end.getTime() - 86_400_000), { month: 'short', day: 'numeric', year: 'numeric' }),
        })
      : word(current);
    return (
      <DropMenu
        className="dash-window-menu"
        triggerClassName="dash-window-button"
        triggerLabel={sayCopy('pickWindow', { window: word(current) })}
        label={
          <>
            <Icon name="calendar-blank" size={15} className="dash-window-icon" />
            <span className="dash-window-range">{shown}</span>
            <Icon name="caret-down" size={12} className="dash-window-caret" />
          </>
        }
        popupClassName="more-list dash-window-list"
        align="end"
      >
        {[null, ...windows].map((w) => (
          <DropItem key={w ?? ''} className="more-item" onClick={() => onPick(w)}>
            <span className="more-tick" aria-hidden="true">
              {w === current ? '✓' : ''}
            </span>
            <span className="more-label">{word(w)}</span>
          </DropItem>
        ))}
      </DropMenu>
    );
  }
  return (
    <div className="dash-windows" role="group" aria-label={sayCopy('timeWindow')}>
      {[null, ...windows].map((w) => (
        <button key={w ?? ''} type="button" className="dash-window" aria-pressed={w === current} onClick={() => onPick(w)}>
          {word(w)}
        </button>
      ))}
    </div>
  );
}

/**
 * The pick controls: one quiet dropdown per configured column. A
 * vocabulary column offers its own values; a whole single-column
 * reference offers the records it points at, said by name and filtered
 * by id — nobody picks an owner by remembering 7.
 */
function Pick({
  dashboard,
  column,
  picks,
  onChange,
}: {
  dashboard: DashboardDef;
  column: string;
  picks: Picks;
  onChange: (column: string, value: string) => void;
}) {
  const home = [...dashboard.sections, ...(dashboard.aside ?? [])].find(
    (s) => s.table && (findTable(s.table) as TableMeta | undefined)?.columns.some((c) => c.name === column),
  );
  const table = home && (findTable(home.table) as TableMeta | undefined);
  const meta = table?.columns.find((c) => c.name === column) as (ColumnMeta & { allowed?: string[] }) | undefined;
  /* A reference: the values are the target's records. Fifty at most —
     a filter over more rows than a dropdown holds wants the list page's
     boxes, not this control. */
  const fk =
    table && !meta?.allowed?.length
      ? (refsFrom(table.id) as Array<{ from: { columns: string[] }; to: { table: string } }>).find(
          (f) => f.from.columns.length === 1 && f.from.columns[0] === column,
        )
      : undefined;
  const target = fk && (findTable(fk.to.table) as TableMeta | undefined);
  const naming = target ? labelColumn(target) : undefined;
  const pk = target ? primaryKey(target)[0] : undefined;
  const q = pickQuery(lookups, [...dashboard.sections, ...(dashboard.aside ?? [])], column);
  const records = useRows(q, 50);
  if (!meta || !table) return null;
  if (!meta.allowed?.length && !naming) return null;
  const label = (labelColumn(table) === column ? column : column.replace(/_id$/, '')).replace(/_/g, ' ');
  const items = meta.allowed?.length
    ? meta.allowed.map((v) => ({ value: v, label: groupLabel(columnDisplay(table!.id, column) as DisplayRule | null, v, meta.allowed) }))
    : (records.data?.rows ?? []).map((r) => ({ value: String(r[pk!]), label: String(r[naming!] ?? r[pk!]) }));
  return (
    <span className="dash-pick">
      <Dropdown
        items={[{ value: '', label: sayCopy('any', { label }) }, ...items]}
        value={picks[column] ?? ''}
        ariaLabel={sayCopy('filter', { label })}
        onChange={(value) => onChange(column, value)}
      />
    </span>
  );
}

/* ---------- the screen ---------- */

const NO_PERIODS: Periods = {};
const NO_SECTIONS: ReadonlySet<number> = new Set();

const Sections = memo(function Sections({
  dashboard,
  sections,
  windowNow,
  picks,
  periods,
  onPeriod,
  served,
  aside = false,
}: {
  dashboard: DashboardDef;
  sections: Section[];
  windowNow: string | null;
  picks: Picks;
  /** The periods picked on sections with windows of their own, and where a new pick goes. */
  periods: Periods;
  onPeriod: (key: string, phrase: string) => void;
  /** Each authored section's place among the dashboard's as served, which is how an activity names itself to the server. */
  served: ReadonlyMap<Section, number>;
  aside?: boolean;
}) {
  /* Each tile is memoized and handed the section it draws, so that section
     is made once per window and pick, not on every paint: a dashboard redrew
     all its tiles each time any one of them answered, some 4,000 component
     renders to draw ten figures. */
  const resolved = useMemo(
    () =>
      sections.map((raw) => {
        /* A section with windows of its own is over the period picked in its
       heading, and its picker says which, so its title says nothing more. */
        if (raw.windows?.length) return picked(windowed(raw, sectionPeriod(raw, periods)), picks);
        /* The title says the window the figure is over (dashboardModel.ts,
       windowTitle): the reader's pick stands where the author's window was
       named, and a section the author windowed says nothing more until then. */
        const said = raw.kind === 'metric' ? metricWindow(raw.title ?? raw.table ?? '', raw, windowNow) : undefined;
        const scoped = said
          ? { ...raw, title: said.title, ...(said.note ? { windowNote: said.note } : {}) }
          : raw.over
            ? { ...raw, title: windowTitle(raw.title ?? raw.table ?? '', raw, windowNow) }
            : raw;
        return picked(windowed(scoped, windowNow), picks);
      }),
    [sections, windowNow, picks, periods],
  );
  /* A layout places every section in an area of a grid (the aside is never beside one: the parser refuses both). */
  const layout = !aside && dashboard.areas?.length ? layoutGrid(dashboard.areas) : undefined;
  /* Sections flow into the page's rows, or into an area of the layout: the same walk over the sections of one flow. */
  const flow = (indices: number[], pairing: boolean, gate?: Gate): ReactNode[] => {
    /* Consecutive metrics coalesce into one KPI strip — the way every
     operations screen reads its top row — and everything else keeps the
     page grid's widths. */
    const out: ReactNode[] = [];
    let strip: ReactNode[] | null = null;
    const there = indices.map((i) => resolved[i]!);
    /* Charts and breakdowns the author gave no width stand two to a row where two come together: one chart a
     page wide under another a page wide made a dashboard a long scroll of short plots with white either side.
     A pair is a pair; a third alone keeps the page's width rather than standing half-empty beside nothing.
     Tables, heat maps, boards and notes keep theirs. Narrow, every half stacks (page.css). In an area nothing
     pairs: the author placed the sections, and the area is as wide as the author made it. */
    const paired = new Set<number>();
    for (let k = 0; pairing && k < there.length; k++) {
      const pairs = (section: Section | undefined) =>
        Boolean(section && (section.kind === 'chart' || section.kind === 'breakdown' || section.kind === 'funnel') && !section.width);
      if (pairs(there[k]) && pairs(there[k + 1])) {
        paired.add(indices[k]!).add(indices[k + 1]!);
        k++;
      }
    }
    /* The rows of metrics in which some card is over a time (see MetricProps.dated), by each card's index. */
    const dated = new Set<number>();
    for (let start = 0; start < there.length; start++) {
      if (there[start]!.kind !== 'metric') continue;
      let end = start;
      while (end < there.length && there[end]!.kind === 'metric') end++;
      if (there.slice(start, end).some((card) => card.windowNote)) for (let k = start; k < end; k++) dated.add(indices[k]!);
      start = end;
    }
    indices.forEach((i) => {
      const section = resolved[i]!;
      const current = sectionPeriod(section, periods);
      const period =
        current && section.windowKey ? (
          <SectionPeriod section={section} current={current} onPick={(phrase) => onPeriod(section.windowKey!, phrase)} />
        ) : undefined;
      if (section.kind === 'metric') {
        if (!strip) {
          strip = [];
          out.push(
            <section key={`strip-${i}`} className="page-section width-full dash-strip">
              <div className="home-cards">{strip}</div>
            </section>,
          );
        }
        /* A card that throws stands as its note in the strip; its neighbours stay. */
        strip.push(
          <ErrorBoundary key={i} fallback={(note) => <div className="home-card home-card-broken">{note}</div>}>
            <Metric
              section={section}
              period={period}
              windowed={Boolean(dashboard.windows?.length) && windowNow !== null && !section.windows}
              dated={dated.has(i)}
            />
          </ErrorBoundary>,
        );
        return;
      }
      strip = null;
      const width = section.kind === 'board' ? 'full' : (section.width ?? (paired.has(i) ? 'half' : 'full'));
      let body: ReactNode;
      if (section.kind === 'note') {
        const image = section.image ? landingImage(section.image) : undefined;
        body = (
          <DashboardNote
            title={section.title}
            text={String(section.text ?? '')}
            icon={section.icon}
            action={section.action}
            variant={section.variant}
            eyebrow={section.eyebrow}
            image={image && section.image ? { src: image, alt: section.image.alt } : undefined}
          />
        );
      } else if (section.kind === 'breakdown' || section.kind === 'chart' || section.kind === 'matrix' || section.kind === 'funnel') {
        const heading = (
          <h2 className="page-section-title">
            <Mark section={section} />
            {section.title ?? `${section.table} by ${section.by}`}
          </h2>
        );
        body = (
          <>
            {period ? (
              <div className="dash-section-head">
                {heading}
                {period}
              </div>
            ) : (
              heading
            )}
            {section.kind === 'chart' ? (
              <Chart section={section} />
            ) : section.kind === 'funnel' ? (
              <FunnelSection section={section} />
            ) : section.shape === 'steps' ? (
              <StepCards section={section} />
            ) : section.kind === 'matrix' ? (
              <Matrix section={section} />
            ) : (
              <BreakdownRows section={section} />
            )}
          </>
        );
      } else if (section.kind === 'board') {
        body = <Board section={section} />;
      } else if (section.kind === 'custom') {
        body = <CustomDashSection section={section} windowNow={windowNow} picks={picks} aside={aside} />;
      } else if (section.kind === 'activity') {
        body = (
          <>
            <h2 className="page-section-title">
              <Mark section={section} />
              {section.title ?? sayCopy('latestChanges')}
            </h2>
            <ActivityFeed section={section} dashboard={dashboard.id} at={served.get(sections[i]) ?? -1} />
          </>
        );
      } else if (section.kind === 'find') {
        body = (
          <>
            {section.title ? (
              <h2 className="page-section-title">
                <Mark section={section} />
                {section.title}
              </h2>
            ) : null}
            <FindSection section={section} />
          </>
        );
      } else if (section.kind === 'branding' || section.kind === 'integrations') {
        /* Alone on its page, the form is the page: the page's heading already names it, and "Branding" said twice
         read as two things. A title of its own that the page does not say is still drawn. */
        const alone = allSections(dashboard).length === 1 && (!section.title || section.title === dashboard.label);
        body = (
          <>
            {alone ? null : (
              <h2 className="page-section-title">
                <Mark section={section} />
                {section.title ?? (section.kind === 'branding' ? sayCopy('branding') : sayCopy('integrations'))}
              </h2>
            )}
            {section.kind === 'branding' ? <BrandingForm /> : <IntegrationsForm />}
          </>
        );
      } else {
        body = <List section={section} aside={aside} period={period} />;
      }
      const app = activeApp();
      const source = section.view && app ? viewRoom(app, section.view) : undefined;
      const cards = source && isListRoom(source) && source.presentation?.kind === 'cards';
      out.push(
        <SectionShell
          key={i}
          {...(gate ? { at: i, report: gate.report, hidden: gate.settled.has(i) } : {})}
          className={`page-section width-${width}${section.kind === 'note' ? ` dash-note${section.variant ? ` dash-${section.variant}` : ''}` : ''}${cards ? ' dash-cards-section' : ''}${section.kind === 'custom' ? ' dash-custom' : ''}`}
        >
          {/* A section that throws says so under its title; the rest of the dashboard stays. */}
          <ErrorBoundary
            fallback={(note) => (
              <>
                {section.title ? <h2 className="page-section-title">{section.title}</h2> : null}
                {note}
              </>
            )}
          >
            {body}
          </ErrorBoundary>
        </SectionShell>,
      );
    });
    return out;
  };
  if (!layout)
    return (
      <>
        {flow(
          resolved.map((_, i) => i),
          true,
        )}
      </>
    );
  const inArea = new Map<string, number[]>();
  resolved.forEach((section, i) => {
    if (section.area) inArea.set(section.area, [...(inArea.get(section.area) ?? []), i]);
  });
  const epoch = `${windowNow}|${JSON.stringify(picks)}|${JSON.stringify(periods)}`;
  return <LaidOut layout={layout} inArea={inArea} epoch={epoch} flow={flow} />;
});

/** What the grid acts on when sections ask to be left out: who asks, and who has been settled as gone. */
interface Gate {
  report: (at: number, gone: boolean) => void;
  settled: ReadonlySet<number>;
}

/** A dashboard's layout drawn: one grid, an area for each name in the template, in reading order. */
function LaidOut({
  layout,
  inArea,
  epoch,
  flow,
}: {
  layout: LayoutGrid;
  inArea: ReadonlyMap<string, number[]>;
  /** What the reader has picked, as one word: the grid is re-shaped once for each. */
  epoch: string;
  flow: (indices: number[], pairing: boolean, gate: Gate) => ReactNode[];
}) {
  /* Which sections ask to be left out is held here, and what the grid acts on is settled once per reader's pick. */
  const queries = useQueryClient();
  const asking = useIsFetching();
  const askedNow = useRef<ReadonlySet<number>>(NO_SECTIONS);
  const [asked, setAsked] = useState<ReadonlySet<number>>(NO_SECTIONS);
  const [settled, setSettled] = useState<ReadonlySet<number>>(NO_SECTIONS);
  const report = useCallback((at: number, gone: boolean) => {
    if (askedNow.current.has(at) === gone) return;
    const next = new Set(askedNow.current);
    if (gone) next.add(at);
    else next.delete(at);
    askedNow.current = next;
    setAsked(next);
  }, []);
  /* The areas are re-flowed once for each thing the reader picks, when every tile has its answer to it: until then the
     tiles keep their last answers (keepPreviousData) and the grid its last shape, so the change lands as one finished
     swap and not a move for every tile that answers. A live refresh is not a pick: a section that empties on one shows
     its empty line where it stands, and the grid is left alone until the reader's next pick. The timer lets the
     tiles' own effects, which start the questions and report the answers, run first. */
  const decided = useRef<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (queries.isFetching() > 0 || decided.current === epoch) return;
      decided.current = epoch;
      setSettled(askedNow.current);
    }, 0);
    return () => clearTimeout(timer);
  }, [queries, epoch, asking, asked]);
  /* In reading order, so the DOM is the order a reader and a keyboard go in whatever the template draws. */
  const areas = layoutAreas(layout);
  const away = new Set(areas.filter((area) => (inArea.get(area) ?? []).every((i) => settled.has(i))));
  const columns = layout[0]?.length ?? 1;
  const gate = { report, settled };
  return (
    <div
      className="dash-grid"
      data-columns={columns}
      style={{ '--dash-columns': columns, '--dash-template': gridTemplateAreas(reflowLayout(layout, away)) } as CSSProperties}
    >
      {areas.map((area) => (
        <div key={area} className="dash-area" style={{ '--area': area } as CSSProperties} hidden={away.has(area) || undefined}>
          {flow(inArea.get(area) ?? [], false, gate)}
        </div>
      ))}
    </div>
  );
}

/* A free-form page's block (sdk/blocks.tsx): one section, as a dashboard draws it, standing among the page's own. */
const BLOCK_DASHBOARD = { id: 'page-block', label: '', sections: [] } as unknown as DashboardDef;
const NO_PICKS: Picks = {};
const NO_SERVED: ReadonlyMap<Section, number> = new Map();
const noPeriod = () => {};

/**
 * One section drawn where a page places it: its own `page-section`, with no dashboard around it, so a page's grid
 * lays it out with its neighbours. A metric is its card in a strip of its own width (a third, unless it says).
 */
export function DashboardBlock({ section }: { section: Section }) {
  const sections = useMemo(() => [section], [section]);
  return (
    <ProblemScopeProvider>
      {section.kind === 'metric' ? (
        <section className={`page-section width-${section.width ?? 'third'} dash-strip`}>
          <div className="home-cards">
            <ErrorBoundary fallback={(note) => <div className="home-card home-card-broken">{note}</div>}>
              <Metric section={section} />
            </ErrorBoundary>
          </div>
        </section>
      ) : (
        <Sections
          dashboard={BLOCK_DASHBOARD}
          sections={sections}
          windowNow={null}
          picks={NO_PICKS}
          periods={NO_PERIODS}
          onPeriod={noPeriod}
          served={NO_SERVED}
        />
      )}
    </ProblemScopeProvider>
  );
}

/**
 * The sections and the reader's controls over them. The window is the
 * query grammar's own phrase, landing on every section that declared
 * `over`; a metric's `compare` is the author's chosen window and stays
 * out of the reader's — two hands on one clock would tell no time. The
 * picks are column → chosen value, landing on every section whose table
 * has the column. Both arrive from a link and every change is reported
 * the same way, so a picked board is a place worth sending someone too.
 */
export function Dashboard({
  dashboard,
  window: fromLink = null,
  picks: pickedFromLink = {},
  periods: periodsFromLink = NO_PERIODS,
  onWindow,
  onPick,
  onPeriods,
}: DashboardProps) {
  const [windowNow, setWindow] = useState<string | null>(fromLink);
  const [picks, setPicks] = useState<Picks>(pickedFromLink);
  const [periods, setPeriods] = useState<Periods>(periodsFromLink);
  /* Where each section stands among the dashboard's as it was served, before a first run is taken out below. */
  const served = useMemo(() => new Map(allSections(dashboard).map((section, at) => [section, at])), [dashboard]);
  const periodsNow = useRef(periods);
  const onPeriod = useMemo(
    () => (key: string, phrase: string) => {
      const next = { ...periodsNow.current, [key]: phrase };
      periodsNow.current = next;
      setPeriods(next);
      onPeriods?.(next);
    },
    [onPeriods],
  );
  /* A first run leads the dashboard until its steps are done; while none is,
     it is the dashboard — charts of empty tables say nothing but "broken". */
  const firstRun = dashboard.sections.find((section) => section.kind === 'firstRun');
  const run = useFirstRun(firstRun);
  if (firstRun && run.stage === 'unknown') return <div className="page-body dash-body" aria-busy="true" />;
  if (firstRun && run.stage === 'fresh') {
    return (
      <div className="page-body dash-body">
        <FirstRun section={firstRun} done={run.done} fresh />
      </div>
    );
  }
  const lead = firstRun && run.stage === 'started' ? <FirstRun section={firstRun} done={run.done} fresh={false} /> : null;
  dashboard = firstRun ? { ...dashboard, sections: dashboard.sections.filter((section) => section !== firstRun) } : dashboard;
  const controls = Boolean(dashboard.windows?.length) || Boolean(dashboard.filters?.length);
  return (
    <ProblemScopeProvider>
      <div>
        {lead && <div className="page-body dash-body">{lead}</div>}
        {controls && (
          <div className="dash-controls">
            {dashboard.windows?.length ? (
              <WindowRow
                windows={dashboard.windows}
                current={windowNow}
                onPick={(w) => {
                  setWindow(w);
                  onWindow?.(w);
                }}
                ownWindows={allSections(dashboard).some((section) => section.over && section.windowBase !== undefined)}
                control={dashboard.windowControl}
              />
            ) : null}
            {dashboard.filters?.length ? (
              <div className="dash-picks">
                {dashboard.filters.map((column) => (
                  <Pick
                    key={column}
                    dashboard={dashboard}
                    column={column}
                    picks={picks}
                    onChange={(c, value) => {
                      const next = { ...picks };
                      if (value === '') delete next[c];
                      else next[c] = value;
                      setPicks(next);
                      onPick?.(next);
                    }}
                  />
                ))}
              </div>
            ) : null}
          </div>
        )}
        {dashboard.aside?.length ? (
          <div className="dashboard-layout page-layout">
            <div className="page-body page-main dash-body">
              <Sections
                dashboard={dashboard}
                sections={dashboard.sections}
                windowNow={windowNow}
                picks={picks}
                periods={periods}
                onPeriod={onPeriod}
                served={served}
              />
            </div>
            <aside className="page-body page-aside dash-body" aria-label={sayCopy('dashboardContext')}>
              <Sections
                dashboard={dashboard}
                sections={dashboard.aside}
                windowNow={windowNow}
                picks={picks}
                periods={periods}
                onPeriod={onPeriod}
                served={served}
                aside
              />
            </aside>
          </div>
        ) : (
          <div className={`page-body dash-body${dashboard.areas?.length ? ' dash-laid' : ''}`}>
            <Sections
              dashboard={dashboard}
              sections={dashboard.sections}
              windowNow={windowNow}
              picks={picks}
              periods={periods}
              onPeriod={onPeriod}
              served={served}
            />
          </div>
        )}
      </div>
    </ProblemScopeProvider>
  );
}
