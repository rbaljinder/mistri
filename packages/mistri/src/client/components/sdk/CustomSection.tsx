/**
 * A custom section, on a page and on a dashboard: the platform reads what the
 * section declares — the record's fields, each named read of rows, planned
 * and narrowed like any list — and hands it to the author's component, which
 * only draws. Loading and a failed read are the section's to say, in the
 * words every section says them; the component is drawn once its data is
 * here, so it never paints a spinner of its own (docs/design.md, motion 8).
 *
 * Loaded on demand (onDemand.tsx) the first time a page holds one, with the
 * page's side of `@mistriwork/mistri/ui` (host.tsx): an App without custom sections
 * never fetches either. The section stands behind the boundary every section
 * has (ErrorBoundary.tsx), so a component that throws says so in its place.
 * A signed-out visitor meets one only where the public grant reads (the App
 * refused any other placement as it loaded), and each of its reads is the
 * public grant's on the server.
 */
import { ComponentStyleScope } from '@mistriwork/ui/internal/ComponentStyleScope.js';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, primaryKey, state } from '@mistriwork/kit/client/core.js';
import { pathEqualityFilter } from '@mistriwork/kit/client/resourceRequests.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { Problem } from '@mistriwork/kit/client/components/Notes.js';
import type { CustomSectionFrame as PageFrame, SlotProps } from '@mistriwork/kit/client/components/pageContext.js';
import { picked, windowed, type Picks, type Section } from '@mistriwork/kit/client/components/dashboardModel.js';
import { COMPACT_BELOW, UiSizeContext, useUiHost, type UiPageFrame, type UiRow, type UiSize } from './context.js';
import { loadComponent } from './componentLoader.js';
import { useComponentKey } from './componentKey.js';
import { rowsByPath } from './rows.js';
import { batchedBreakdown } from '@mistriwork/kit/client/breakdownBatch.js';
import { breakdownText, measureText } from '@mistriwork/engine/shared/dashboardAsks.js';
import { groupsAsked } from '@mistriwork/engine/shared/appComponents.js';
import { totalFigure, totalGroups, type TotalGroup, type TotalValue } from '../../../shared/customTotals.js';
import { say } from '../../copy/components/components/sdk/CustomSection.js';

/** What a section component receives: `SectionProps` in packages/mistri/schema/ui.d.ts; a free-form page's receives `PageProps` (packages/mistri/schema/page.d.ts). */
type SectionComponentProps =
  | {
      record: UiRow | undefined;
      rows: Record<string, UiRow[]>;
      /** Each aggregate read: one figure, or a group for each value of its `by`. */
      figures: Record<string, TotalValue | TotalGroup[]>;
      props: Record<string, unknown>;
      section: { title?: string; width: string; region: 'main' | 'aside' };
      state: 'ready' | 'empty';
      /** On a dashboard: the window its reads are over, in the query grammar's words. */
      period?: string;
    }
  | { props: Record<string, unknown>; data: unknown };

/* One loader per build of a component (componentKey.ts), kept for the page's
   life: a part that has arrived draws at once on its next mount, one that
   could not be fetched offers the Reload every on-demand chunk does, and a
   save that changed its code is a new part. */
const parts = new Map<string, ComponentType<SectionComponentProps>>();
function partFor(id: string, key: string): ComponentType<SectionComponentProps> {
  let part = parts.get(key);
  if (!part) {
    part = onDemand(
      () => loadComponent(id).then((component) => ({ component: component as ComponentType<SectionComponentProps> })),
      'component',
    );
    parts.set(key, part);
  }
  return part;
}

/** The component's own element: what its scoped stylesheet is scoped to, and what `useSectionSize` measures. */
export function CustomBody({
  id,
  given,
  className = 'custom-section',
  onBlank,
}: {
  id: string;
  given: SectionComponentProps;
  className?: string;
  /** Told whether the component draws nothing at all, as it changes. */
  onBlank?: (blank: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = box.current;
    if (!node || !onBlank) return;
    const look = () => onBlank(node.childNodes.length === 0);
    look();
    const observer = new MutationObserver(look);
    observer.observe(node, { childList: true });
    return () => observer.disconnect();
  }, [onBlank]);
  const [size, setSize] = useState<UiSize>({ width: 1024, compact: false });
  useEffect(() => {
    const node = box.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const width = node.clientWidth;
      setSize((before) => (before.width === width ? before : { width, compact: width < COMPACT_BELOW }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const Part = partFor(id, useComponentKey(id));
  return (
    <div className={className} data-component={id} ref={box}>
      <ComponentStyleScope.Provider value={id}>
        <UiSizeContext.Provider value={size}>
          <Part {...given} />
        </UiSizeContext.Provider>
      </ComponentStyleScope.Provider>
    </div>
  );
}

/** What `/api/breakdown` answers, as far as a total reads it. */
type Reply = { rows?: Array<Record<string, unknown>> };

/** A total's answer as its component receives it: the one figure, or each group (customTotals.ts). */
const figures = (reply: Reply, grouped: boolean): TotalValue | TotalGroup[] =>
  grouped ? totalGroups(reply.rows) : totalFigure(reply.rows);

const stateOf = (record: UiRow | undefined, rows: Record<string, UiRow[]>, declaredRecord: boolean): 'ready' | 'empty' => {
  const reads = Object.values(rows);
  const noRows = reads.length > 0 && reads.every((list) => !list.length);
  return noRows && (!declaredRecord || !record) ? 'empty' : 'ready';
};

/** A custom section on a record's page: its record fields and its planned reads, then the component. */
export function CustomPageSection({ page, section, index, plan, base, recordKey, frame }: SlotProps & { frame: PageFrame }) {
  const { pageApi, preview, Loading, SectionBox } = frame;
  /* A component that draws nothing (an author's section for a role this reader does not hold) takes no place:
     its heading, rule and margin go with it, and come back if it draws again. */
  const [blank, setBlank] = useState(false);
  const fields = section.record ?? [];
  const record = useQuery({
    queryKey: ['page-custom', 'record', page.id, base.id, recordKey, fields],
    enabled: fields.length > 0,
    staleTime: 0,
    queryFn: async () => {
      const key = Object.fromEntries((primaryKey(base) as string[]).map((column) => [column, recordKey[column]]));
      const got = await pageApi('/api/view/run', {
        count: 'none',
        view: {
          id: `page:${page.id}:${index}:record`,
          name: base.name,
          base: base.id,
          columns: fields.map((path) => ({ path })),
          filter: pathEqualityFilter(key),
          limit: 1,
        },
      });
      return rowsByPath(fields, got, say('thisRecordCouldNotBeRead'), { schema: state.schema, base: base.id })[0] ?? null;
    },
  });
  const reads = useQuery({
    queryKey: ['page-custom', 'reads', plan.reads],
    staleTime: 0,
    queryFn: async () =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(plan.reads ?? {}).map(async ([name, read]) => {
            if (read.error) throw new Error(read.error);
            if (read.empty || !read.view) return [name, []] as const;
            const paths = (read.view.columns ?? []).map((column) => column.path);
            const got = await pageApi('/api/view/run', { view: read.view, offset: 0, count: 'none' });
            return [
              name,
              rowsByPath(paths, got, say('theRowsCouldNotBeRead', { name }), { schema: state.schema, base: read.view.base }),
            ] as const;
          }),
        ),
      ) as Record<string, UiRow[]>,
  });
  /* Asked as the page's own reads are (owned by its connection, first paint's answer used), one breakdown for each. */
  const totals = useQuery({
    queryKey: ['page-custom', 'totals', plan.aggregates],
    staleTime: 0,
    enabled: Object.keys(plan.aggregates ?? {}).length > 0,
    queryFn: async () =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(plan.aggregates ?? {}).map(async ([name, total]) => {
            if (total.error) throw new Error(total.error);
            if (total.empty || !total.breakdown) return [name, figures({}, Boolean(section.aggregates?.[name]?.by))] as const;
            const reply = (await pageApi('/api/breakdown', { def: total.breakdown })) as Reply;
            return [name, figures(reply, Boolean(section.aggregates?.[name]?.by))] as const;
          }),
        ),
      ) as Record<string, TotalValue | TotalGroup[]>,
  });
  if (!section.component) return null;
  if ((fields.length && record.isPending) || reads.isPending || (totals.fetchStatus !== 'idle' && totals.isPending))
    return <Loading section={section} />;
  const failed = (fields.length ? record.error : null) ?? reads.error ?? totals.error;
  if (failed) return <SectionBox section={section} body={null} foldable={false} broken={(failed as Error).message} />;
  const rows = reads.data ?? {};
  const row = record.data ?? undefined;
  const given: SectionComponentProps = {
    record: row,
    rows,
    figures: totals.data ?? {},
    props: section.props ?? {},
    section: { title: section.title, width: section.width ?? 'full', region: section.region ?? 'main' },
    state: stateOf(row, rows, fields.length > 0),
  };
  const body = <CustomBody id={section.component.id} given={given} onBlank={setBlank} />;
  return <SectionBox section={section} foldable={false} hidden={blank} body={preview ? <div inert>{body}</div> : body} />;
}

/**
 * A free-form page's component, drawn inside its frame (definePage): with
 * its loader's result as `data` once the server has run it for this reader,
 * asked again as the page's place in the address changes. Loading and a
 * refusal are said here, in the words every section says them, so the
 * component is drawn once its data is here.
 */
export function CustomPageBody({ frame, section }: { frame: UiPageFrame; section: Section }) {
  const host = useUiHost();
  const place = Object.fromEntries(frame.params.flatMap((name) => (frame.get(name) === undefined ? [] : [[name, frame.get(name)!]])));
  const loaded = useQuery({
    queryKey: ['mistri-page', 'load', ...host.scope, frame.view, place],
    queryFn: async () => (await host.load(frame.view, place)) ?? null,
    enabled: frame.loader !== undefined,
    placeholderData: keepPreviousData,
  });
  if (!section.component) return null;
  if (frame.loader !== undefined) {
    if (loaded.isError) return <Problem text={loaded.error.message} retry={() => void loaded.refetch()} />;
    if (loaded.data === undefined) return <div className="sk-bar" role="status" aria-label={say('common.loading')} />;
  }
  return <CustomBody id={section.component.id} className="custom-room" given={{ props: section.props ?? {}, data: loaded.data ?? null }} />;
}

/** The ops-board clock, as the dashboard's own sections keep it. */
const every = (refresh?: number) => (refresh ? Math.max(refresh, 5) * 1000 : false);

/**
 * A custom section on a dashboard: each read is a rows section in all but
 * drawing, so the reader's window and picks narrow it exactly as they narrow
 * one, and the refresh clock refetches it. Titled like the others.
 */
export function CustomDashSection({
  section,
  windowNow,
  picks,
  refresh,
  aside = false,
}: {
  section: Section;
  windowNow: string | null;
  picks: Picks;
  refresh?: number;
  /** Drawn in the dashboard's aside: the component is told its region, as a page's is. */
  aside?: boolean;
}) {
  return <DashReads section={section} windowNow={windowNow} picks={picks} refresh={refresh} aside={aside} />;
}

function DashReads({
  section,
  windowNow,
  picks,
  refresh,
  aside,
}: {
  section: Section;
  windowNow: string | null;
  picks: Picks;
  refresh?: number;
  aside: boolean;
}) {
  const asked = useMemo(
    () =>
      Object.entries(section.reads ?? {}).map(([name, read]) => {
        const narrowed = picked(
          windowed({ kind: 'rows', table: read.table, query: read.query, over: read.over, windowBase: read.windowBase }, windowNow),
          picks,
        );
        return {
          name,
          base: read.table,
          show: read.show,
          query: [narrowed.query ?? '', read.sort ? `sort ${read.sort}` : ''].join(' ').trim(),
          limit: read.limit ?? 20,
        };
      }),
    [section.reads, windowNow, picks],
  );
  /* Each total is a metric or a breakdown in all but drawing: the window and the picks narrow it as they narrow one,
     and it is asked with the dashboard's other figures in one request (breakdownBatch.ts). */
  const askedTotals = useMemo(
    () =>
      Object.entries(section.aggregates ?? {}).map(([name, total]) => {
        const narrowed = picked(
          windowed({ kind: 'metric', table: total.table, query: total.query, over: total.over, windowBase: total.windowBase }, windowNow),
          picks,
        );
        const grouped = total.by !== undefined;
        const text = grouped
          ? breakdownText({ table: total.table, query: narrowed.query, measure: total.measure, by: total.by }, groupsAsked(total.limit))
          : measureText({ table: total.table, measure: total.measure }, narrowed.query);
        return { name, text, grouped };
      }),
    [section.aggregates, windowNow, picks],
  );
  const totals = useQuery({
    queryKey: ['dash-custom', 'totals', section.component?.id, askedTotals],
    refetchInterval: every(refresh),
    placeholderData: keepPreviousData,
    enabled: askedTotals.length > 0,
    queryFn: async () =>
      Object.fromEntries(
        await Promise.all(
          askedTotals.map(async ({ name, text, grouped }) => [name, figures(await batchedBreakdown<Reply>({ text }), grouped)] as const),
        ),
      ) as Record<string, TotalValue | TotalGroup[]>,
  });
  const reads = useQuery({
    queryKey: ['dash-custom', section.component?.id, asked],
    refetchInterval: every(refresh),
    placeholderData: keepPreviousData,
    queryFn: async () =>
      Object.fromEntries(
        await Promise.all(
          asked.map(async ({ name, base, show, query, limit }) => {
            const got = await api('/api/view/run', {
              count: 'none',
              ...(query ? { query } : {}),
              view: { id: `dash:custom:${name}`, name, base, columns: show.map((path) => ({ path })), limit },
            });
            return [name, rowsByPath(show, got, say('theRowsCouldNotBeRead', { name }), { schema: state.schema, base })] as const;
          }),
        ),
      ) as Record<string, UiRow[]>,
  });
  if (!section.component) return null;
  /* Loading and a failed read are said as a record page's section says them (PageSectionBox): its skeleton bar under
     the title, then the problem in place of the drawing, with a retry. */
  let body: ReactNode;
  if (reads.isPending || (askedTotals.length > 0 && totals.isPending))
    body = <div className="sk-bar" role="status" aria-label={say('common.loading')} />;
  else if (reads.isError || totals.isError) {
    const failed = (reads.isError ? reads : totals) as typeof reads;
    body = <Problem text={(failed.error as Error).message} retry={() => void failed.refetch()} />;
  } else {
    const rows = reads.data ?? {};
    body = (
      <CustomBody
        id={section.component.id}
        given={{
          record: undefined,
          rows,
          figures: totals.data ?? {},
          props: section.props ?? {},
          section: { title: section.title, width: section.width ?? 'full', region: aside ? 'aside' : 'main' },
          state: stateOf(undefined, rows, false),
          ...(windowNow ? { period: windowNow } : {}),
        }}
      />
    );
  }
  return (
    <>
      {section.title ? <h2 className="page-section-title">{section.title}</h2> : null}
      {body}
    </>
  );
}
