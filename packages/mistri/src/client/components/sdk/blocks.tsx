/**
 * The platform's blocks as a free-form page's components (`@mistriwork/mistri/page`): `<Rows>`, `<Metric>`, `<Chart>`,
 * `<Breakdown>`, `<RecordCard>`, `<Timeline>`, `<Tree>`, `<Gantt>`, `<Assistant>` and `<Tabs>`.
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
import { createElement, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { pageFor, state } from '@mistriwork/kit/client/core.js';
import { tableNamed, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { parsePresentation } from '../../../shared/appViews.js';
import { BETTER, DASH_CHART_SHAPES } from '../../../shared/appModel.js';
import { FIGURE_FORMATS } from '@mistriwork/engine/shared/model.js';
import { TABLE_SIZINGS } from '@mistriwork/engine/shared/tableSizing.js';
import type { AppGanttList, AppTreeList } from '@mistriwork/engine/shared/listPresentations.js';
import { ErrorBoundary } from '@mistriwork/kit/client/components/ErrorBoundary.js';
import { Problem } from '@mistriwork/kit/client/components/Notes.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { captureRecordSurfaceOwner } from '@mistriwork/kit/client/components/recordSurface.js';
import type { Section } from '@mistriwork/kit/client/components/dashboardModel.js';
import type { PageSections } from '../RecordPageBody.js';
import type { PageEntry } from '@mistriwork/kit/client/components/pageModel.js';
import { UiPageContext, type UiPageFrame } from './context.js';
import { say } from '../../copy/components/components/sdk/blocks.js';

const DashboardBlock = onDemand(() => import('../Dashboard.js'), 'DashboardBlock');
const RecordPageBody = onDemand(() => import('../RecordPageBody.js'), 'RecordPageBody');
const TreeList = onDemand(() => import('../TreeList.js'), 'TreeList');
const GanttList = onDemand(() => import('../GanttList.js'), 'GanttList');
const AssistantRoom = onDemand(() => import('../AssistantPanel.js'), 'AssistantRoom');
const TabStrip = onDemand(() => import('@mistriwork/kit/client/components/PageSections.js'), 'TabStrip');

const WIDTHS = ['full', 'half', 'third', 'two-thirds'] as const;
const CURVES = ['smooth', 'straight'] as const;
const noop = () => {};

type Props = Readonly<Record<string, unknown>>;

/* Words a block once took, refused with the one that replaced them. */
const RENAMED: Readonly<Record<string, string>> = { resource: 'from' };

/* Each prop a block takes is one of its DSL words; anything else is a typo the author should hear about. */
function takes(block: string, props: Props, words: readonly string[]): void {
  for (const name of Object.keys(props)) {
    if (words.includes(name)) continue;
    if (Object.hasOwn(RENAMED, name) && words.includes(RENAMED[name]))
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

/* A block: its props judged against the page it stands in, then drawn by the platform's component behind a boundary. */
function block<R extends object>(judge: (props: Props, page: UiPageFrame | null) => R, draw: (resolved: R) => ReactNode) {
  return function Block(props: Props) {
    const page = useContext(UiPageContext);
    let resolved: R;
    try {
      resolved = judge(props, page);
    } catch (error) {
      const text = (error as Error).message;
      console.error(text);
      return <Problem crashed text={text} />;
    }
    return <ErrorBoundary>{createElement(draw as (props: R) => ReactNode, resolved)}</ErrorBoundary>;
  };
}

/* A dashboard's section, drawn where the page places it. Memoized on its words, so a page's redraw is not a refetch. */
function SectionBlock({ section }: { section: Section }) {
  const words = JSON.stringify(section);
  const held = useMemo(() => section, [words]); // eslint-disable-line react-hooks/exhaustive-deps
  return <DashboardBlock section={held} />;
}

const METRIC = ['title', 'from', 'query', 'measure', 'compare', 'better', 'format', 'unit', 'target', 'width'];
function metricSection(props: Props, page: UiPageFrame | null): { section: Section } {
  takes('Metric', props, METRIC);
  const table = resourceOf('Metric', props.from, page);
  const title = needs('Metric', props, 'title');
  oneOf('Metric', props, 'better', BETTER);
  oneOf('Metric', props, 'format', FIGURE_FORMATS);
  oneOf('Metric', props, 'width', WIDTHS);
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
  return {
    section: {
      kind: 'metric',
      table: table.id,
      ...carried(props, ['query', 'measure', 'compare', 'better', 'format', 'unit', 'width']),
      title,
      ...(target === undefined ? {} : { target }),
    } as Section,
  };
}

/* A chart's and a breakdown's figures are said as a metric's are: `format` and `unit` reach the dashboard's own sayer
   (dashboardModel's figureSayer), so a measure of seconds reads "10h 2m" on a bar, an axis and a tooltip. */
const CHART = [
  'title',
  'from',
  'by',
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
];
function chartSection(props: Props, page: UiPageFrame | null): { section: Section } {
  takes('Chart', props, CHART);
  const table = resourceOf('Chart', props.from, page);
  const title = needs('Chart', props, 'title');
  needs('Chart', props, 'by');
  oneOf('Chart', props, 'shape', DASH_CHART_SHAPES);
  oneOf('Chart', props, 'curve', CURVES);
  oneOf('Chart', props, 'format', FIGURE_FORMATS);
  oneOf('Chart', props, 'width', WIDTHS);
  return {
    section: {
      kind: 'chart',
      table: table.id,
      shape: 'line',
      ...carried(props, ['by', 'query', 'measure', 'shape', 'x', 'curve', 'total', 'target', 'limit', 'height', 'format', 'unit', 'width']),
      title,
    } as Section,
  };
}

const BREAKDOWN = ['title', 'from', 'by', 'query', 'measure', 'limit', 'format', 'unit', 'width'];
function breakdownSection(props: Props, page: UiPageFrame | null): { section: Section } {
  takes('Breakdown', props, BREAKDOWN);
  const table = resourceOf('Breakdown', props.from, page);
  const title = needs('Breakdown', props, 'title');
  needs('Breakdown', props, 'by');
  oneOf('Breakdown', props, 'format', FIGURE_FORMATS);
  oneOf('Breakdown', props, 'width', WIDTHS);
  return {
    section: {
      kind: 'breakdown',
      table: table.id,
      ...carried(props, ['by', 'query', 'measure', 'limit', 'format', 'unit', 'width']),
      title,
    } as Section,
  };
}

const ROWS = ['title', 'from', 'query', 'show', 'sort', 'limit', 'sizing', 'width'];
function rowsSection(props: Props, page: UiPageFrame | null): { section: Section } {
  takes('Rows', props, ROWS);
  const table = resourceOf('Rows', props.from, page);
  const title = needs('Rows', props, 'title');
  oneOf('Rows', props, 'sizing', TABLE_SIZINGS);
  oneOf('Rows', props, 'width', WIDTHS);
  const show = props.show as readonly string[] | undefined;
  return {
    section: {
      kind: 'rows',
      table: table.id,
      ...carried(props, ['query', 'sort', 'limit', 'sizing', 'width']),
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
function RecordBlock({ table, recordKey, show, only }: RecordAsk) {
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
  return (
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
}

/* A tree and a Gantt chart are a list's presentations: their words are the presentation's, read by its own parser. */
interface Presented {
  table: TableMeta;
  spec: AppTreeList | AppGanttList;
  entry: { kind: 'table'; table: string; query: string };
}

function presented(blockName: string, kind: 'tree' | 'gantt', words: string[]) {
  return (props: Props, page: UiPageFrame | null): Presented => {
    takes(blockName, props, ['from', 'query', ...words]);
    const table = resourceOf(blockName, props.from, page);
    const spec = parsePresentation({ kind, ...carried(props, words) }, `<${blockName}>`) as AppTreeList | AppGanttList;
    return { table, spec, entry: { kind: 'table', table: table.id, query: (props.query as string | undefined) ?? '' } };
  };
}

/* Held on their words, so a page's redraw is not a refetch. */
function TreeBlock({ table, spec, entry }: Presented) {
  const words = JSON.stringify([spec, entry]);
  const held = useMemo(() => ({ spec, entry }), [words]); // eslint-disable-line react-hooks/exhaustive-deps
  return <TreeList table={table} spec={held.spec as AppTreeList} entry={held.entry} />;
}

function GanttBlock({ table, spec, entry }: Presented) {
  const words = JSON.stringify([spec, entry]);
  const held = useMemo(() => ({ spec, entry }), [words]); // eslint-disable-line react-hooks/exhaustive-deps
  return <GanttList table={table} spec={held.spec as AppGanttList} entry={held.entry} />;
}

interface TabSpec {
  key: string;
  label: ReactNode;
  content: ReactNode;
}

interface TabsAsk {
  tabs: readonly TabSpec[];
  param?: string;
  label: string;
  page: UiPageFrame | null;
}

function tabsAsk(props: Props, page: UiPageFrame | null): TabsAsk {
  takes('Tabs', props, ['tabs', 'param', 'label']);
  const tabs = props.tabs as readonly TabSpec[] | undefined;
  if (
    !Array.isArray(tabs) ||
    !tabs.length ||
    tabs.some((tab) => !tab || typeof tab.key !== 'string' || !tab.key) ||
    new Set(tabs.map((tab) => tab.key)).size !== tabs.length
  ) {
    throw new Error(say('blockTabs'));
  }
  const param = props.param as string | undefined;
  if (param !== undefined && !page?.params.includes(param)) throw new Error(say('blockTabParam', { param: String(param) }));
  return { tabs, ...(param === undefined ? {} : { param }), label: typeof props.label === 'string' ? props.label : '', page };
}

/* Tabs, as a record page's are drawn: each panel drawn the first time it is opened, and kept in a page param if named. */
function TabsBlock({ tabs, param, label, page }: TabsAsk) {
  const strip = tabs.map((tab) => ({ key: tab.key, token: tab.key, label: tab.label }));
  const entry = useMemo(() => ({ tab: param ? page?.get(param) : undefined }) as PageEntry, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <TabStrip
      tabs={strip}
      name={label}
      entry={entry}
      scoped={false}
      onTab={(token: string | undefined) => {
        if (param) page?.set(param, token);
      }}
      draw={(i: number) => tabs[i].content}
    />
  );
}

export const Metric = block(metricSection, SectionBlock);
export const Chart = block(chartSection, SectionBlock);
export const Breakdown = block(breakdownSection, SectionBlock);
export const Rows = block(rowsSection, SectionBlock);
export const RecordCard = block((props, page) => {
  takes('RecordCard', props, ['from', 'record', 'show']);
  return recordAsk('RecordCard', props, page);
}, RecordBlock);
export const Timeline = block((props, page) => {
  takes('Timeline', props, ['from', 'record']);
  return recordAsk('Timeline', props, page, 'timeline');
}, RecordBlock);
export const Tree = block(presented('Tree', 'tree', ['parent', 'primary', 'lines']), TreeBlock);
export const Gantt = block(presented('Gantt', 'gantt', ['start', 'end', 'primary', 'by', 'progress']), GanttBlock);
export const Assistant = block(
  (props) => {
    takes('Assistant', props, ['conversation']);
    return typeof props.conversation === 'string' ? { conversation: props.conversation } : {};
  },
  (ask: { conversation?: string }) => <AssistantRoom {...ask} />,
);
export const Tabs = block(tabsAsk, TabsBlock);
