/**
 * What a page is made of, before anything is drawn: the shapes the server
 * hands back, and the small rules the page and its sections share.
 */
import { ownedBy } from '../requestIdentity.js';
import { api } from '../core.js';
import { whenBody } from '@mistriwork/engine/shared/recordReads.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { FigureFormat } from '@mistriwork/engine/shared/model.js';
import type { RelatedCreate } from '@mistriwork/engine/schema/model.js';
import type { ResolvedWorkflowStatus } from '@mistriwork/engine/shared/page.js';
import type { HttpViewDefinition, HttpBreakdownDefinition } from '@mistriwork/engine/shared/resourceHttp.js';
import { say } from '../copy/record/components/pageModel.js';

export interface PageSection {
  sizing?: import('@mistriwork/engine/shared/tableSizing.js').TableSizing;
  kind: import('@mistriwork/engine/shared/pageModel.js').PageSection['kind'];
  /** A chart's shape, height and goal, as a dashboard chart's. */
  shape?: 'line' | 'bar' | 'donut' | 'stacked';
  /** A bar chart's or donut's category order (shared/pageModel.ts, PageChart.sort). */
  sort?: string;
  height?: number;
  target?: number;
  /** A note's words, mark and one way on. */
  text?: string;
  icon?: import('@mistriwork/engine/shared/appIcons.js').AppIconName;
  action?: import('@mistriwork/engine/shared/appLinks.js').AppLinkAction;
  /** An embed: the key of the list view this related list draws. */
  view?: string;
  /** A custom section: the author's component, the record's fields it reads, its named reads and props. */
  component?: import('@mistriwork/engine/shared/appComponents.js').ComponentDecl;
  record?: string[];
  reads?: Record<string, import('@mistriwork/engine/shared/appComponents.js').PageCustomRead>;
  aggregates?: Record<string, import('@mistriwork/engine/shared/appComponents.js').PageCustomTotal>;
  props?: Record<string, unknown>;
  region?: 'main' | 'aside';
  /** The section strip's tab this section is drawn in. */
  tab?: string;
  title?: string;
  /** The tab and title in the source catalog's words, where the reader's differ (server apps.ts keepAddresses): what an address calls its tab. */
  addressWords?: { tab?: string; title?: string };
  from?: string;
  of?: string;
  path?: string;
  by?: string;
  /** A timeline's streams, as the page model keeps them. */
  streams?: Array<{
    from: string;
    path: string;
    at: string;
    show: string;
    detail?: string;
    by?: string;
    filter?: string;
    side?: string;
    /** Every row of the stream in this tone, and drawn as one line: in place of the section's rules. */
    tone?: import('@mistriwork/engine/shared/pageModel.js').TimelineTone;
    compact?: true;
  }>;
  /** A timeline read as a conversation: oldest first, its composer under the rows, rows tinted or drawn as one line by a column's value. */
  newest?: 'last';
  composer?: import('@mistriwork/engine/shared/pageModel.js').TimelineComposer;
  tone?: Record<string, Record<string, import('@mistriwork/engine/shared/pageModel.js').TimelineTone>>;
  compact?: Record<string, string[]>;
  /** The other party's rows, drawn against the far edge: asked by the server as each stream's `side` read (SectionPlan). */
  side?: string;
  filter?: string;
  fn?: string;
  column?: string;
  /** A metric's figure said as a dashboard's: `percent` reads it as 0–100, and a unit word follows it. */
  format?: FigureFormat;
  unit?: string;
  paths?: string[];
  names?: boolean;
  /** A note: quiet small print, or a callout on a ground of its own. */
  variant?: 'quiet' | 'callout';
  /** Properties edited in place, through an action where the reader has no write grant. */
  edit?: true;
  presentation?:
    | 'summary'
    | 'gallery'
    | 'headline'
    | 'facts'
    | 'table'
    | 'properties'
    | 'card'
    | 'header'
    | import('@mistriwork/engine/shared/appCards.js').AppCardsList
    | import('@mistriwork/engine/shared/appComponents.js').CustomListPresentation;
  /** An embedded list view's board or calendar, held to the record (shared/pageModel.ts, PageList.lanes). */
  lanes?: import('@mistriwork/engine/shared/pageModel.js').PageList['lanes'];
  actions?: import('@mistriwork/engine/shared/pageModel.js').PageHeadlineAction[];
  /** A record header's status column, fact words, filled verb and destructive verbs (shared/pageModel.ts). */
  status?: string;
  factLabels?: Record<string, import('@mistriwork/engine/shared/appCards.js').FactLabel>;
  primary?: string;
  destructive?: string[];
  headerActions?: string[];
  /** A headline's second figure, its figure's earlier value, and small print. */
  subfigure?: string;
  was?: string;
  note?: string;
  /** A similar list: rows of the page's own table sharing the record's `same` values, `near` its numbers. */
  similar?: import('@mistriwork/engine/shared/pageModel.js').PageSimilar;
  workflow?: ResolvedWorkflowStatus;
  create?: RelatedCreate<string>;
  empty?: import('@mistriwork/engine/shared/listPresentations.js').AppListEmpty;
  /** Authored `empty: 'hide' | 'collapse'`: the list is left out, or said in one line, while it has no rows. */
  emptyMode?: 'hide' | 'collapse';
  /** The rows under a header for each record they share (shared/pageModel.ts, PageGroup); `limit` is then the rows to a group. */
  group?: import('@mistriwork/engine/shared/pageModel.js').PageGroup;
  /** Columns summed in the list's footer, over every row it matches. */
  totals?: string[];
  /** A ⋯ at the end of each row with the row's own verbs. */
  rowActions?: true;
  /** A related list's authored `create: false`, and the record's verbs it draws in its head (shared/pageModel.ts). */
  noCreate?: true;
  listActions?: string[];
  columns?: string[] | number;
  limit?: number;
  width?: string;
  offsetLeft?: string;
  offsetRight?: string;
  when?: string;
  hidden?: boolean;
}

export interface PageDef {
  id: string;
  name: string;
  base: string;
  source: 'saved' | 'config' | 'suggested';
  sections: PageSection[];
  listTabs?: boolean;
  empty?: 'hide' | 'collapse';
  /** Its archetype (shared/pageLayouts.ts): which regions it has and their order. Absent, or 'record', is the record's own. */
  layout?: import('@mistriwork/engine/shared/pageLayouts.js').PageLayoutWord;
  error?: string;
}

export type ViewDef = HttpViewDefinition;

export interface SectionPlan {
  index: number;
  error?: string;
  empty?: boolean;
  view?: ViewDef;
  query?: string;
  viewText?: string;
  counts?: boolean;
  /** A related list's footer sums: one row measured over every related row, a column's or a rollup's. */
  totals?: HttpBreakdownDefinition;
  /** A grouped list's groups: one row for each record its rows share, with their counts and subtotals. */
  groups?: HttpBreakdownDefinition;
  breakdown?: HttpBreakdownDefinition;
  streams?: Array<{
    error?: string;
    empty?: boolean;
    view?: ViewDef;
    from: string;
    at: string;
    show: string;
    detail?: string;
    by?: string;
    /** A timeline's `side`: the stream's key columns, and its read narrowed to the other party's rows. */
    key?: string[];
    side?: { error?: string; empty?: boolean; view?: ViewDef };
  }>;
  /** A custom section's reads, each planned as a list, by name. */
  reads?: Record<string, { error?: string; empty?: boolean; view?: ViewDef }>;
  /** A custom section's aggregate reads, each planned as a breakdown, by name. */
  aggregates?: Record<string, { error?: string; empty?: boolean; breakdown?: HttpBreakdownDefinition }>;
}

export interface PageEntry {
  kind: 'page';
  pageId: string;
  table?: string;
  key?: Record<string, unknown>;
  label?: string;
  tab?: string;
  rootBody?: string;
  chooserQuery?: string;
}

/** A key, when there is no label to show instead. */
export function rootLabel(key: Record<string, unknown>): string {
  return Object.values(key).join(' · ');
}

/**
 * Whether the root record satisfies a condition written in the query
 * language — the `when` of a section or an action. One bounded query,
 * key and condition composed the way every fold is.
 */
export async function rootMatches(base: TableMeta, key: Record<string, unknown>, when: string, connection?: string): Promise<boolean> {
  try {
    /* Built as the server builds it for the page's compose (shared/recordReads.ts). */
    const data = await api('/api/run', { ...whenBody(base, key, when), ...(connection ? ownedBy(connection) : {}) });
    return Boolean(data.rows?.length);
  } catch {
    return false;
  }
}

/**
 * The column values every row of a list already satisfies: a page's list is
 * "the children of this record", one equality on the child's reference
 * column that is deliberately not shown, so it has to be put back before
 * anything reads the row's key. One group only, bare `=` on the view's own
 * base.
 */
export function pinnedBy(view: ViewDef | undefined): Record<string, unknown> {
  const groups = view?.filter?.groups ?? [];
  if (groups.length !== 1) return {};
  const pinned: Record<string, unknown> = {};
  for (const condition of groups[0]) {
    if (condition.op !== '=' || typeof condition.path !== 'string') continue;
    if (condition.path.includes('.')) continue;
    pinned[condition.path] = condition.value;
  }
  return pinned;
}

/** The classes a section wears, on the skeleton and on the settled box alike. */
export function sectionClass(section: PageSection): string {
  return (
    `page-section page-${section.kind} width-${section.width ?? (section.kind === 'metric' ? 'auto' : 'full')}` +
    `${section.offsetLeft ? ` offset-l-${section.offsetLeft}` : ''}` +
    `${section.offsetRight ? ` offset-r-${section.offsetRight}` : ''}`
  );
}

/** Where a page came from, which is the same question as who may change it. */
export function sourceOf(page: { source: string }): string {
  return page.source === 'saved'
    ? say('savedOnThisServer')
    : page.source === 'config'
      ? say('fromTheAppOrConnection')
      : say('builtFromTheSchema');
}

/** The page's record header, if it declares one, with the index its plan and label are keyed by. */
export function headerOf(page: PageDef): { section: PageSection; index: number } | undefined {
  const index = page.sections.findIndex((section) => section.kind === 'fields' && section.presentation === 'header' && !section.hidden);
  return index === -1 ? undefined : { section: page.sections[index], index };
}
