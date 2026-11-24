/**
 * The platform's blocks as a free-form page's components (`@mistriwork/mistri/page`): `<Rows>`, `<Metric>`, `<Chart>`,
 * `<Breakdown>`, `<RecordCard>`, `<Timeline>`, `<Tree>`, `<Gantt>`, `<Board>`, `<Calendar>`, `<Gallery>`,
 * `<RecordSplit>` and `<Assistant>`.
 *
 * Each is the component that draws the same thing on a dashboard, a record page or a list, handed the section it
 * would be handed there: no block draws anything of its own. Their props are the DSL's words for that section
 * (`metric('Open', 'ticket', { query, measure })` is `<Metric title="Open" from="ticket" query measure />`), so
 * there is one vocabulary, and each read goes through the same routes as the room's, under the reader's grants.
 *
 * This module is a part loaded when a page draws a block (page.tsx), and each block's own component is a part
 * loaded when that block is drawn: a page of metrics never fetches the Gantt.
 *
 * Each block's props are judged before it draws: a word it does not take, a value outside its words or a resource
 * the page does not read stands as the shared problem note in its place, saying which, marked as a part that could
 * not be drawn (an authoring mistake, which the browser suites fail on), while the rest of the page stays. What
 * throws while drawing stands behind the block's own boundary, as a dashboard section does.
 */
import { createElement, useContext, type ComponentProps, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { pageFor, state } from '@mistriwork/kit/client/core.js';
import { tableNamed, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { parsePresentation, PRESENTATION_KEYS } from '../../../shared/appViews.js';
import { BETTER, DASH_CHART_SHAPES } from '../../../shared/appModel.js';
import { FIGURE_FORMATS } from '@mistriwork/engine/shared/model.js';
import { TABLE_SIZINGS } from '@mistriwork/engine/shared/tableSizing.js';
import type { AppGanttList, AppSplitListDetail, AppTreeList } from '@mistriwork/engine/shared/listPresentations.js';
import { primaryKey } from '@mistriwork/engine/shared/schema.js';
import { ErrorBoundary } from '@mistriwork/kit/client/components/ErrorBoundary.js';
import { Problem } from '@mistriwork/kit/client/components/Notes.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { captureRecordSurfaceOwner } from '@mistriwork/kit/client/components/recordSurface.js';
import type { Section } from '@mistriwork/kit/client/components/dashboardModel.js';
import type { PageSections } from '../RecordPageBody.js';
import { andQuery } from '@mistriwork/engine/shared/query.js';
import { windowed } from '@mistriwork/engine/shared/dashboardAsks.js';
import { windowPhraseOf } from '@mistriwork/engine/shared/autoBucket.js';
import { ALL_TIME, readPeriod } from '@mistriwork/engine/shared/addressParams.js';
import { metricWindow } from '@mistriwork/kit/client/components/dashboardModel.js';
import { withoutWindowPhrase } from '../../../shared/dashWindow.js';
import { compileWhere } from '@mistriwork/engine/shared/pageWhere.js';
import { scopedCondition, UiPageContext, UiParamKindsContext, UiScopeContext, type UiPageFrame, type UiScope } from './context.js';
import { say } from '../../copy/components/components/sdk/blocks.js';
import { BLOCK_RENAMED, renamedMessages } from '../../../shared/renamedWords.js';
import { useRows } from './hooks.js';
import { useInCard, Value } from './kit.js';

const DashboardBlock = onDemand(() => import('../Dashboard.js'), 'DashboardBlock');
const RecordPageBody = onDemand(() => import('../RecordPageBody.js'), 'RecordPageBody');
const TreeList = onDemand(() => import('../TreeList.js'), 'TreeList');
const GanttList = onDemand(() => import('../GanttList.js'), 'GanttList');
const PresentedList = onDemand(() => import('./PresentedList.js'), 'PresentedList');
const SplitListDetail = onDemand(() => import('../SplitListDetail.js'), 'SplitListDetail');
const AssistantRoom = onDemand(() => import('../AssistantPanel.js'), 'AssistantRoom');

const WIDTHS = ['full', 'half', 'third', 'two-thirds'] as const;
const CURVES = ['smooth', 'straight'] as const;
const noop = () => {};

type Props = Readonly<Record<string, unknown>>;

/* Words a block once took, refused with the one that replaced them. */
const RENAMED = renamedMessages(BLOCK_RENAMED);

/* Each prop a block takes is one of its DSL words; anything else is a typo the author should hear about. */
function takes(block: string, props: Props, words: readonly string[]): void {
  const accepted = words.includes('className') ? words : [...words, 'className'];
  for (const name of Object.keys(props)) {
    if (accepted.includes(name)) continue;
    if (Object.hasOwn(RENAMED, name) && accepted.includes(RENAMED[name]))
      throw new Error(say('blockRenamed', { block, name, now: RENAMED[name] }));
    throw new Error(say('blockHasNo', { block, name, takes: words.join(', ') }));
  }
}

function needs(block: string, props: Props, name: string): string {
  const value = props[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(say('blockNeeds', { block, name }));
  return value.trim();
}

function oneOf<T extends string>(block: string, props: Props, name: string, allowed: readonly T[]): T | undefined {
  const value = props[name];
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    throw new Error(say('blockValue', { block, name, value: String(value), allowed: allowed.map((each) => `"${each}"`).join(', ') }));
  }
  return value as T;
}

/* The words a section carries as they are: text, a number, a list of text. The server's parser judges their sense. */
function carried(props: Props, names: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of names) if (props[name] !== undefined) out[name] = props[name];
  return out;
}

/** The table a block reads: one of the page's own reads, named as the App names it. */
function resourceOf(block: string, resource: unknown, page: UiPageFrame | null): TableMeta {
  if (typeof resource !== 'string' || !resource) throw new Error(say('blockNeeds', { block, name: 'from' }));
  if (page && !page.reads.includes(resource)) {
    throw new Error(
      say('blockReadsUndeclared', { block, resource, label: page.label, reads: page.reads.map((name) => `"${name}"`).join(', ') }),
    );
  }
  const table = state.schema ? (tableNamed(state.schema, resource) as TableMeta | undefined) : undefined;
  if (!table) throw new Error(say('blockNotAResource', { block, resource }));
  return table;
}

/* The resource a block reads: its own `from`, or the Scope's around it. */
function fromOf(props: Props, scope: UiScope | null): unknown {
  return props.from ?? scope?.from;
}

/* A block's condition as the one query text a section carries: the Scope's (when it reads the Scope's resource), then
   the block's own `where` and `query`, each object compiled against the table's columns as the server compiles them. */
function conditionOf(block: string, props: Props, scope: UiScope | null, table: TableMeta): string | undefined {
  const asked = scopedCondition(scope, fromOf(props, scope) as string, props.where, props.query as string | undefined);
  const compiled = compileWhere(asked.where, table);
  if ('error' in compiled) throw new Error(say('blockWhere', { block, problem: compiled.error }));
  const query = andQuery(asked.query, compiled.text);
  return query || undefined;
}

/* A block: its props judged against the page and Scope it stands in, then drawn by the platform's component behind a boundary. */
function block<R extends object>(
  judge: (props: Props, page: UiPageFrame | null, scope: UiScope | null) => R,
  draw: (resolved: R) => ReactNode,
  options: { handlesClassName?: boolean } = {},
) {
  return function Block(props: Props) {
    const page = useContext(UiPageContext);
    const scope = useContext(UiScopeContext);
    let resolved: R;
    try {
      resolved = judge(props, page, scope);
    } catch (error) {
      const text = (error as Error).message;
      console.error(text);
      return <Problem crashed text={text} />;
    }
    const content = <ErrorBoundary>{createElement(draw as (props: R) => ReactNode, resolved)}</ErrorBoundary>;
    const className = !options.handlesClassName && typeof props.className === 'string' && props.className ? props.className : undefined;
    return className ? <div className={className}>{content}</div> : content;
  };
}

/* A true-or-false word: written bare (`previous`) it is true. */
function flag(block: string, props: Props, name: string): void {
  const value = props[name];
  if (value !== undefined && typeof value !== 'boolean')
    throw new Error(say('blockValue', { block, name, value: String(value), allowed: 'true, false' }));
}

/* A dashboard's section, drawn where the page places it. Memoized on its words, so a page's redraw is not a refetch.
   Inside a kit Card the Card is the frame: the section's own box and inset are dropped (DashboardBlocks.css), and its
   title is the Card's head where the Card names none, so a chart in a card reads as one surface with one title. A
   metric keeps its own label, which is part of the name its card is opened by. */
function SectionBlock({ section }: { section: Section }) {
  const frame = useInCard();
  const words = JSON.stringify(section);
  const held = useMemo(() => section, [words]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!frame) return <DashboardBlock section={held} />;
  const Head = `h${frame.level}` as 'h2' | 'h3' | 'h4';
  return (
    <div className={`kit-card-part kit-card-part-${section.kind}`}>
      {!frame.titled && section.kind !== 'metric' && section.title && <Head className="kit-card-title">{section.title}</Head>}
      <DashboardBlock section={held} />
    </div>
  );
}

const METRIC = [
  'title',
  'from',
  'where',
  'query',
  'measure',
  'compare',
  'better',
  'format',
  'unit',
  'target',
  'width',
  'over',
  'window',
  'previous',
  'spark',
];
interface MetricAsk {
  section: Section;
  /** The page param the reader's window is kept in. */
  window?: string;
}
function metricSection(props: Props, page: UiPageFrame | null, scope: UiScope | null): MetricAsk {
  takes('Metric', props, METRIC);
  const table = resourceOf('Metric', fromOf(props, scope), page);
  const query = conditionOf('Metric', props, scope, table);
  const title = needs('Metric', props, 'title');
  oneOf('Metric', props, 'better', BETTER);
  oneOf('Metric', props, 'format', FIGURE_FORMATS);
  oneOf('Metric', props, 'width', WIDTHS);
  flag('Metric', props, 'previous');
  flag('Metric', props, 'spark');
  /* A window is kept in one of the page's params, so a link carries it and a control bound to the param moves it;
     a name the page does not declare would be a window nobody can pick. */
  const window = props.window;
  if (window !== undefined && (typeof window !== 'string' || !page?.params.includes(window))) {
    const params = page?.params.length ? page.params.map((name) => `"${name}"`).join(', ') : 'none';
    throw new Error(say('blockWindowParam', { param: String(window), params }));
  }
  const over = props.over === undefined ? undefined : needs('Metric', props, 'over');
  if ((window !== undefined || props.previous) && over === undefined) throw new Error(say('blockNeeds', { block: 'Metric', name: 'over' }));
  /* A goal read from data is the metric's three words again; its table, where it names one, is one the page reads. */
  const goal = props.target;
  let target: Section['target'];
  if (goal !== null && typeof goal === 'object') {
    const asked = goal as { from?: string; table?: string; query?: string; measure?: string };
    if (asked.table !== undefined) throw new Error(say('blockRenamed', { block: 'Metric', name: 'target.table', now: 'target.from' }));
    target = {
      table: asked.from === undefined ? table.id : resourceOf('Metric', asked.from, page).id,
      ...(asked.query === undefined ? {} : { query: asked.query }),
      measure: asked.measure ?? (props.measure as string | undefined) ?? 'count',
    };
  } else if (goal !== undefined) target = goal as number;
  /* As the server serves a dashboard's metric (shared/app.ts): its own window lifted out into `windowBase`, so the
     reader's stands in its place rather than intersecting it, and `previous` the compare re-derived against it. */
  const follows = window !== undefined || props.previous === true;
  return {
    section: {
      kind: 'metric',
      table: table.id,
      ...(query === undefined ? {} : { query }),
      ...carried(props, ['measure', 'compare', 'better', 'format', 'unit', 'width', 'over', 'spark']),
      ...(follows && over ? { windowBase: withoutWindowPhrase(query, over) ?? query ?? '' } : {}),
      ...(props.previous === true ? { comparePeriod: true } : {}),
      title,
      ...(target === undefined ? {} : { target }),
    } as Section,
    ...(typeof window === 'string' ? { window } : {}),
  };
}

/* A param's word as the query's phrase: `last-30-days` is `last 30 days`; all time is no window at all. */
const phraseOf = (word: string | undefined): string | null =>
  !word || readPeriod(word) === ALL_TIME ? null : word.replace(/-/g, ' ').trim() || null;

/* A metric over the page's window: the param's word now, else the first the param offers, else the metric's own
   window. Drawn by the dashboard's own card, windowed as the dashboard windows it (one path, one batched read). */
function MetricBlock({ section, window }: MetricAsk) {
  const page = useContext(UiPageContext);
  const kinds = useContext(UiParamKindsContext);
  const kind = window ? kinds[window] : undefined;
  const offered = Array.isArray(kind) ? kind.map(String) : undefined;
  const asked = window ? page?.get(window) : undefined;
  /* A list param holds one of its words; one it does not offer (an old link) reads as its first, as a picker would. */
  const word = offered && (asked === undefined || !offered.includes(asked)) ? offered[0] : asked;
  const picked = window ? phraseOf(word) : null;
  const allTime = window !== undefined && picked === null;
  const at = picked ?? (section.comparePeriod && !window ? windowPhraseOf(section.query, section.over) : null);
  const drawn = useMemo(() => {
    const said = metricWindow(section.title ?? '', section, picked);
    const moved = allTime ? { ...section, query: section.windowBase || undefined, compare: undefined } : windowed(section, at);
    return { ...moved, title: said.title, ...(said.note && !window ? { windowNote: said.note } : {}) } as Section;
  }, [section, picked, at, allTime, window]);
  return <SectionBlock section={drawn} />;
}

/* A chart's and a breakdown's figures are said as a metric's are: `format` and `unit` reach the dashboard's own sayer
   (dashboardModel's figureSayer), so a measure of seconds reads "10h 2m" on a bar, an axis and a tooltip. */
const CHART = [
  'title',
  'from',
  'by',
  'where',
  'query',
  'measure',
  'shape',
  'x',
  'curve',
  'total',
  'target',
  'limit',
  'height',
  'format',
  'unit',
  'width',
  'fill',
];
const FILLS = ['window', 'observed', false] as const;
function chartSection(props: Props, page: UiPageFrame | null, scope: UiScope | null): { section: Section } {
  takes('Chart', props, CHART);
  const table = resourceOf('Chart', fromOf(props, scope), page);
  const query = conditionOf('Chart', props, scope, table);
  const title = needs('Chart', props, 'title');
  needs('Chart', props, 'by');
  oneOf('Chart', props, 'shape', DASH_CHART_SHAPES);
  oneOf('Chart', props, 'curve', CURVES);
  oneOf('Chart', props, 'format', FIGURE_FORMATS);
  oneOf('Chart', props, 'width', WIDTHS);
  if (props.fill !== undefined && !(FILLS as readonly unknown[]).includes(props.fill))
    throw new Error(
      say('blockValue', {
        block: 'Chart',
        name: 'fill',
        value: String(props.fill),
        allowed: FILLS.map((f) => JSON.stringify(f)).join(', '),
      }),
    );
  return {
    section: {
      kind: 'chart',
      table: table.id,
      shape: 'line',
      ...(query === undefined ? {} : { query }),
      ...carried(props, ['by', 'measure', 'shape', 'x', 'curve', 'total', 'target', 'limit', 'height', 'format', 'unit', 'width', 'fill']),
      title,
    } as Section,
  };
}

const BREAKDOWN = ['title', 'from', 'by', 'where', 'query', 'measure', 'limit', 'format', 'unit', 'width', 'shape', 'also'];
function breakdownSection(props: Props, page: UiPageFrame | null, scope: UiScope | null): { section: Section } {
  takes('Breakdown', props, BREAKDOWN);
  const table = resourceOf('Breakdown', fromOf(props, scope), page);
  const query = conditionOf('Breakdown', props, scope, table);
  const title = needs('Breakdown', props, 'title');
  needs('Breakdown', props, 'by');
  oneOf('Breakdown', props, 'format', FIGURE_FORMATS);
  oneOf('Breakdown', props, 'width', WIDTHS);
  oneOf('Breakdown', props, 'shape', ['bars'] as const);
  /* The second measure is said beside a bar; the default rows have no place for it, so it is not silently dropped. */
  if (props.also !== undefined) {
    needs('Breakdown', props, 'also');
    if (props.shape !== 'bars') throw new Error(say('blockNeeds', { block: 'Breakdown', name: 'shape="bars"' }));
  }
  return {
    section: {
      kind: 'breakdown',
      table: table.id,
      ...(query === undefined ? {} : { query }),
      ...carried(props, ['by', 'measure', 'limit', 'format', 'unit', 'width', 'shape', 'also']),
      title,
    } as Section,
  };
}

const ROWS = ['title', 'from', 'where', 'query', 'show', 'sort', 'limit', 'sizing', 'width'];
function rowsSection(props: Props, page: UiPageFrame | null, scope: UiScope | null): { section: Section } {
  takes('Rows', props, ROWS);
  const table = resourceOf('Rows', fromOf(props, scope), page);
  const query = conditionOf('Rows', props, scope, table);
  const title = needs('Rows', props, 'title');
  oneOf('Rows', props, 'sizing', TABLE_SIZINGS);
  oneOf('Rows', props, 'width', WIDTHS);
  const show = props.show as readonly string[] | undefined;
  return {
    section: {
      kind: 'rows',
      table: table.id,
      ...(query === undefined ? {} : { query }),
      ...carried(props, ['sort', 'limit', 'sizing', 'width']),
      ...(show ? { show: [...show] } : {}),
      title,
    } as Section,
  };
}

interface RecordAsk {
  table: TableMeta;
  recordKey: Record<string, unknown>;
  show?: readonly string[];
  only?: string;
  compact?: boolean;
}

function recordAsk(blockName: string, props: Props, page: UiPageFrame | null, only?: string): RecordAsk {
  const table = resourceOf(blockName, props.from, page);
  const record = props.record;
  if (!record || typeof record !== 'object' || Array.isArray(record))
    throw new Error(say('blockNeeds', { block: blockName, name: 'record' }));
  return {
    table,
    recordKey: record as Record<string, unknown>,
    ...(props.show === undefined ? {} : { show: props.show as readonly string[] }),
    ...(only ? { only } : {}),
  };
}

/* A record's own page, drawn in the page: its fields (or `show`'s) under its name and verbs, or only its timeline. */
function RecordBlock({ table, recordKey, show, only, compact }: RecordAsk) {
  const keyText = JSON.stringify(recordKey);
  const fields = show?.join('\u0000');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const owner = useMemo(() => captureRecordSurfaceOwner(() => mounted.current), [table.id, keyText]);
  const [pageId, setPageId] = useState<string | null>();
  useEffect(() => {
    let live = true;
    void (pageFor(table.id) as Promise<string | null>).then(
      (id) => live && setPageId(id ?? null),
      () => live && setPageId(null),
    );
    return () => {
      live = false;
    };
  }, [table.id]);
  const sections = useMemo(() => (show?.length ? ([{ kind: 'fields', paths: [...show] }] as PageSections) : undefined), [fields]); // eslint-disable-line react-hooks/exhaustive-deps
  if (pageId === null) return <p className="note">{say('blockNoPage')}</p>;
  if (pageId === undefined) return null;
  const body = (
    <RecordPageBody
      key={keyText}
      owner={owner}
      tableId={table.id}
      recordKey={recordKey}
      pageId={pageId}
      close={noop}
      setPendingProbe={noop}
      onName={noop}
      onSettled={noop}
      {...(sections ? { sections } : {})}
      {...(only ? { only } : {})}
    />
  );
  return compact ? <div className="kit-record-card">{body}</div> : body;
}

/* A tree and a Gantt chart are a list's presentations: their words are the presentation's, read by its own parser. */
interface Presented {
  table: TableMeta;
  spec: AppTreeList | AppGanttList;
  entry: { kind: 'table'; table: string; query: string };
  limit?: number;
}

function presented(blockName: string, kind: 'tree' | 'gantt', words: string[]) {
  return (props: Props, page: UiPageFrame | null, scope: UiScope | null): Presented => {
    takes(blockName, props, ['from', 'where', 'query', 'limit', ...words]);
    const table = resourceOf(blockName, fromOf(props, scope), page);
    const spec = parsePresentation({ kind, ...carried(props, words) }, `<${blockName}>`) as AppTreeList | AppGanttList;
    if (props.limit !== undefined && (!Number.isInteger(props.limit) || (props.limit as number) < 1))
      throw new Error(say('blockValue', { block: blockName, name: 'limit', value: String(props.limit), allowed: say('blockWholeNumber') }));
    return {
      table,
      spec,
      entry: { kind: 'table', table: table.id, query: conditionOf(blockName, props, scope, table) ?? '' },
      ...(props.limit === undefined ? {} : { limit: props.limit as number }),
    };
  };
}

/* Held on their words, so a page's redraw is not a refetch. */
function TreeBlock({ table, spec, entry, limit }: Presented) {
  const words = JSON.stringify([spec, entry, limit]);
  const held = useMemo(() => ({ spec, entry, limit }), [words]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <TreeList
      table={table}
      spec={held.spec as AppTreeList}
      entry={held.entry}
      {...(held.limit === undefined ? {} : { limit: held.limit })}
    />
  );
}

function GanttBlock({ table, spec, entry, limit }: Presented) {
  const words = JSON.stringify([spec, entry, limit]);
  const held = useMemo(() => ({ spec, entry, limit }), [words]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <GanttList
      table={table}
      spec={held.spec as AppGanttList}
      entry={held.entry}
      {...(held.limit === undefined ? {} : { limit: held.limit })}
    />
  );
}

/* A board, a calendar and a gallery are list presentations too, but they read through the list's own room (the lanes'
   counts, the month, the cards), which PresentedList draws. Their words are the presentation's, and `where`, `query`,
   `sort` and `limit` ask the question as a `<Rows>` asks it; a gallery is the list's cards, led by their `image`. */

type PresentedAsk = ComponentProps<typeof PresentedList>;

function listed(blockName: string, kind: 'board' | 'calendar' | 'cards', required: readonly string[]) {
  const words = PRESENTATION_KEYS[kind].filter((word) => word !== 'kind');
  return (props: Props, page: UiPageFrame | null, scope: UiScope | null): PresentedAsk => {
    takes(blockName, props, [
      'from',
      'where',
      'query',
      'sort',
      'limit',
      'label',
      'ariaLabel',
      ...(kind === 'board' ? ['move'] : []),
      ...words,
    ]);
    /* A gallery's `image` is a column or the related file resource's `{ from, whose, sort }`: parsed as the cards' own. */
    for (const name of required)
      if (!(name === 'image' && props[name] !== null && typeof props[name] === 'object')) needs(blockName, props, name);
    const table = resourceOf(blockName, fromOf(props, scope), page);
    const spec = parsePresentation({ kind, ...carried(props, words) }, `<${blockName}>`);
    if (props.limit !== undefined && (!Number.isInteger(props.limit) || (props.limit as number) < 1))
      throw new Error(say('blockValue', { block: blockName, name: 'limit', value: String(props.limit), allowed: say('blockWholeNumber') }));
    return {
      table,
      spec,
      query: conditionOf(blockName, props, scope, table) ?? '',
      ...carried(props, ['sort', 'limit']),
      label: typeof props.ariaLabel === 'string' ? props.ariaLabel : typeof props.label === 'string' ? props.label : blockName,
      moves: movesOf(blockName, props, page),
    };
  };
}

/* What a drop may run: the commands and fixed actions the page declared, or the ones `move` names out of them. */
function movesOf(blockName: string, props: Props, page: UiPageFrame | null): readonly string[] {
  const declared = [...(page?.commands ?? []), ...(page?.actions ?? [])];
  const named = props.move as readonly string[] | undefined;
  if (named === undefined) return declared;
  for (const name of named) {
    if (!declared.includes(name)) {
      throw new Error(
        say('blockMoveUndeclared', {
          block: blockName,
          name,
          label: page?.label ?? '',
          declared: declared.length ? declared.map((each) => `"${each}"`).join(', ') : say('blockNothing'),
        }),
      );
    }
  }
  return named;
}

function PresentedBlock(ask: PresentedAsk) {
  return <PresentedList {...ask} />;
}

/* A record split: the rows in a queue beside the picked record's own page, the pick kept in a page param when it names one. */
interface SplitAsk {
  table: TableMeta;
  spec: AppSplitListDetail & { row: NonNullable<AppSplitListDetail['row']> };
  query: string;
  sort?: string;
  param?: string;
  label: string;
  className?: string;
  page: UiPageFrame | null;
}

function splitAsk(props: Props, page: UiPageFrame | null, scope: UiScope | null): SplitAsk {
  takes('RecordSplit', props, ['from', 'where', 'query', 'sort', 'param', 'label', 'ariaLabel', 'detail', 'limit', 'row', 'className']);
  if (props.row === null || typeof props.row !== 'object') throw new Error(say('blockNeeds', { block: 'RecordSplit', name: 'row' }));
  const table = resourceOf('RecordSplit', fromOf(props, scope), page);
  const spec = parsePresentation({ kind: 'split', ...carried(props, ['detail', 'limit', 'row']) }, '<RecordSplit>') as SplitAsk['spec'];
  if (primaryKey(table).length !== 1)
    throw new Error(say('blockSplitKey', { resource: table.id, count: String(primaryKey(table).length) }));
  const param = props.param as string | undefined;
  if (param !== undefined && !page?.params.includes(param)) throw new Error(say('blockSplitParam', { param: String(param) }));
  const resolvedLabel =
    typeof props.ariaLabel === 'string' ? props.ariaLabel : typeof props.label === 'string' ? props.label : 'RecordSplit';
  const className = typeof props.className === 'string' && props.className ? props.className : undefined;
  return {
    table,
    spec,
    query: conditionOf('RecordSplit', props, scope, table) ?? '',
    ...carried(props, ['sort', 'param']),
    label: resolvedLabel,
    ...(className === undefined ? {} : { className }),
    page,
  };
}

function SplitBlock({ table, spec, query, sort, param, label, className, page }: SplitAsk) {
  const [local, setLocal] = useState<string | undefined>();
  const [key] = primaryKey(table);
  const picked = param ? page?.get(param) : local;
  const pick = (value: string | undefined) => (param ? page?.set(param, value) : setLocal(value));
  const { primary, lines = [] } = spec.row;
  const rows = useRows(table.id, {
    query: query || undefined,
    sort,
    limit: spec.limit ?? 20,
    show: [primary, ...lines],
    keys: true,
  });
  const list = rows.data ?? [];
  const row = picked === undefined ? undefined : list.find((each) => String(each[key]) === picked);
  // A refused or failed read says so: an empty queue would tell a moderator there is nothing to do.
  const problem = rows.isError ? <Problem text={(rows.error as Error).message} retry={() => void rows.refetch()} /> : null;
  /* A refresh that fails keeps the rows it had, and the record open beside them, with the problem above: only a first
     read that never answered, or a refusal (the grant is gone), takes the list away. */
  const refused = [401, 403].includes((rows.error as { status?: number } | null)?.status ?? 0);
  if (problem && (rows.data === undefined || refused)) return problem;
  return (
    <>
      {problem}
      <SplitListDetail
        className={className}
        listLabel={label}
        detailLabel={say('blockSplitDetail')}
        detailTitle={row ? String(row[primary] ?? '') : say('blockSplitDetail')}
        selected={Boolean(row)}
        onCloseDetail={() => pick(undefined)}
        sentenceTitle
        list={
          <div className="queue queue-pick-list">
            <ul className="queue-list" aria-label={label}>
              {list.map((each) => {
                const id = String(each[key]);
                return (
                  <li key={id} className="queue-row">
                    <button type="button" className="queue-pick" aria-current={id === picked ? 'true' : undefined} onClick={() => pick(id)}>
                      <strong>
                        <Value value={each[primary]} resource={table.id} column={primary} compact />
                      </strong>
                      {lines.map((line) => (
                        <span key={line}>
                          <Value value={each[line]} resource={table.id} column={line} compact />
                        </span>
                      ))}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        }
        detail={
          row ? <RecordBlock table={table} recordKey={{ [key]: row[key] }} {...(spec.detail ? { show: spec.detail } : {})} /> : undefined
        }
      />
    </>
  );
}

export const Metric = block(metricSection, MetricBlock);
export const Chart = block(chartSection, SectionBlock);
export const Breakdown = block(breakdownSection, SectionBlock);
export const Rows = block(rowsSection, SectionBlock);
export const RecordCard = block((props, page) => {
  takes('RecordCard', props, ['from', 'record', 'show']);
  const ask = recordAsk('RecordCard', props, page);
  const defaultShow = ask.table.columns
    .filter((c) => !c.primaryKey)
    .slice(0, 8)
    .map((c) => c.name);
  const boundedShow = defaultShow.length ? defaultShow : ask.table.columns.slice(0, 8).map((c) => c.name);
  return { ...ask, show: ask.show ?? boundedShow, compact: true };
}, RecordBlock);
export const Timeline = block((props, page) => {
  takes('Timeline', props, ['from', 'record']);
  return recordAsk('Timeline', props, page, 'timeline');
}, RecordBlock);
export const Tree = block(presented('Tree', 'tree', ['parent', 'primary', 'lines']), TreeBlock);
export const Gantt = block(presented('Gantt', 'gantt', ['start', 'end', 'primary', 'by', 'progress']), GanttBlock);
export const Board = block(listed('Board', 'board', ['by']), PresentedBlock);
export const Calendar = block(listed('Calendar', 'calendar', ['date']), PresentedBlock);
export const Gallery = block(listed('Gallery', 'cards', []), PresentedBlock);
export const RecordSplit = block(splitAsk, SplitBlock, { handlesClassName: true });
export const Assistant = block(
  (props) => {
    takes('Assistant', props, ['conversation']);
    return typeof props.conversation === 'string' ? { conversation: props.conversation } : {};
  },
  (ask: { conversation?: string }) => <AssistantRoom {...ask} />,
);
/* `<Steps>` (steps.tsx): a command's form over several steps, its stepper and the intake style's sheets loaded with
   it, so a page that draws none carries none. */
export const Steps = onDemand(() => import('./steps.js'), 'Steps', { quiet: true });
