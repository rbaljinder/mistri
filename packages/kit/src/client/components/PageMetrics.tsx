/**
 * A page's counting sections: a metric (one number over the record's related
 * rows, reopenable as the query it counted), a breakdown (those rows in
 * groups, biggest first, each group a way into its rows) and a chart (those
 * groups measured and drawn). All read a plan the server compiled; none writes.
 */
import { metricMeasure } from '@mistriwork/engine/shared/recordReads.js';
import { useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { batchedBreakdown } from '../breakdownBatch.js';
import { ownedBy } from '../requestIdentity.js';
import type { ResourceClientReply } from '@mistriwork/engine/shared/resourceHttp.js';
import { columnDisplay, columnLabel, findTable, go, quote, state, tableView } from '../core.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { presentationColumns } from './columnPresentation.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { andQuery } from '@mistriwork/engine/shared/query.js';
import { formatNumber } from '../locale.js';
import { inAppPage, PageRenderContext, usePageApi, type SlotProps } from './pageContext.js';
import { Loading, SectionBox } from './PageSectionBox.js';
import { dressFor, groupLabel, withUnit, type DisplayRule } from './valueModel.js';
import { barShare, CurrencyFigures, figureSayer, namedGroups, orderGroups, sayer } from './dashboardModel.js';
import { currencyPath } from '@mistriwork/engine/shared/money.js';
import { onDemand, useArrived } from './onDemand.js';
import { Empty } from './Notes.js';
import { say as sayCopy } from '../copy/dashboards/components/PageMetrics.js';

/* The drawing (and the chart kit under it) is fetched the first time a page
   holds a chart, beside the chart's read: most pages have none, and a first
   page is held to a budget (scripts/bundle-budget.mjs). */
const ChartFigure = onDemand(() => import('./ChartFigure.js'), 'ChartFigure');

/** One number, and a way to see what it counted. */
export function MetricSection({ section, plan }: SlotProps) {
  const api = usePageApi();
  const { connection } = useContext(PageRenderContext);
  /* A count is the rows its view names, counted: the same filter as one
     group with no key, so it is asked as a breakdown and goes with the page's
     other figures in one request (breakdownBatch.ts) — a record with three
     counted tabs sent three reads, each a tenant request of its own. */
  const planned = metricMeasure(plan);
  /* Money each row says its own currency for is summed apart per currency: one figure each, never yen added to dollars. */
  const ownRule =
    !section.format && !plan.counts && section.fn !== 'count' && section.column
      ? (columnDisplay(section.from, section.column) as (DisplayRule & { currencyColumn?: string }) | null)
      : null;
  const split = planned && !planned.by.length && ownRule?.format === 'money' ? currencyPath(ownRule, section.column ?? '') : undefined;
  const measure = planned && split ? { ...planned, by: [{ path: split, alias: 'currency' }], limit: 6 } : planned;
  const counted = plan.counts && plan.view && !plan.breakdown ? measure : undefined;
  const data = useQuery<ResourceClientReply<'/api/view/run'>>({
    queryKey: ['page-metric', plan.view],
    queryFn: () => {
      if (!plan.view) throw new Error(sayCopy('thisMetricHasNoView'));
      return api('/api/view/run', { view: plan.view });
    },
    enabled: !plan.empty && Boolean(plan.view) && !measure,
    staleTime: 0,
  });
  /* A narrowed or distant measure is one group of the child's own rows —
     a breakdown with no key — and its figure is that group's `value`. */
  const measured = useQuery<ResourceClientReply<'/api/breakdown'>>({
    queryKey: ['page-metric-measure', measure],
    queryFn: () => batchedBreakdown<ResourceClientReply<'/api/breakdown'>>({ def: measure!, owner: ownedBy(connection) }),
    enabled: !plan.empty && Boolean(measure),
    staleTime: 0,
  });
  if (plan.empty) {
    return (
      <SectionBox
        section={section}
        foldable={false}
        body={
          <span
            className="page-metric-value page-metric-empty"
            title={sayCopy('thisRecordHasNoToCount', { of: section.of ?? 'reference' })}
          >
            —
          </span>
        }
      />
    );
  }
  if (!plan.view && !plan.breakdown)
    return <SectionBox section={section} body={null} foldable={false} broken={sayCopy('thisMetricHasNoView')} />;
  const reading = measure ? measured : data;
  /* Pending, the figure's own box, unseen: a row of metrics is as tall as its
     figures, and a loading bar of another height moved every section under
     the row when they came (test/built-client-vitals.mjs). */
  if (reading.isPending)
    return (
      <SectionBox
        section={section}
        foldable={false}
        body={
          <button type="button" className="page-metric-value" disabled tabIndex={-1} aria-hidden="true" style={{ visibility: 'hidden' }}>
            <span className="metric-number">0</span>
            <span className="metric-of">{section.title ? '' : section.from}</span>
          </button>
        }
      />
    );
  if (reading.isError) return <SectionBox section={section} body={null} foldable={false} broken={(reading.error as Error).message} />;
  let aggregate: unknown;
  if (measure) {
    const got = measured.data;
    if (!got || 'errors' in got)
      return (
        <SectionBox
          section={section}
          body={null}
          foldable={false}
          broken={(got && 'errors' in got ? got.errors[0]?.message : undefined) ?? sayCopy('thisMetricCouldNotBeRead')}
        />
      );
    const figures = got.rows.flatMap((row) =>
      typeof row.currency === 'string' && row.currency.trim() ? [[row.currency.trim().toUpperCase(), row.value] as const] : [],
    );
    aggregate = split ? (figures.length ? new CurrencyFigures(figures) : undefined) : got.rows[0]?.value;
  } else {
    const got = data.data;
    if (!got || !('view' in got))
      return (
        <SectionBox
          section={section}
          body={null}
          foldable={false}
          broken={got?.errors[0]?.message ?? sayCopy('thisMetricCouldNotBeRead')}
        />
      );
    const row = got.rows[0] ?? {};
    aggregate = 'value' in row ? row.value : Object.entries(row).find(([k]) => k !== 'id')?.[1];
  }
  const got = data.data && 'view' in data.data ? data.data : undefined;
  const value = plan.counts ? (counted ? (aggregate ?? 0) : (got?.total ?? '—')) : (aggregate ?? (section.fn === 'sum' ? 0 : '—'));
  const open = plan.query
    ? () => go(tableView(section.from, plan.query), 'push')
    : plan.viewText
      ? () => go(tableView(section.from, section.from, `view+${encodeURIComponent(plan.viewText!).replace(/!/g, '%21')}`), 'push')
      : null;
  /* The author's word for the figure stands over its column's, as on a dashboard. */
  const { format, unit } = section;
  const rule: DisplayRule | null = format
    ? { format }
    : !plan.counts && section.fn !== 'count' && section.column
      ? (columnDisplay(section.from, section.column) as DisplayRule | null)
      : null;
  const dress = rule?.format === 'money' && !(value instanceof CurrencyFigures) ? dressFor(rule, value) : null;
  /* An average is said to one place at or past 1, as a dashboard's is: "3.3", not "3.333". */
  const said = value === '—' ? value : dress?.text ? withUnit(dress.text, unit) : figureSayer(rule, unit)(value);
  return (
    <SectionBox
      section={section}
      foldable={false}
      body={
        <button
          type="button"
          className="page-metric-value"
          disabled={!open}
          title={
            open
              ? sayCopy('openTheThisCounted', { from: section.from ?? '' })
              : sayCopy('thisCountCannotBeReopened', { from: section.from ?? '' })
          }
          onClick={open ?? undefined}
        >
          <span className="metric-number">{said}</span>
          <span className="metric-of">{section.title ? '' : section.from}</span>
        </button>
      }
    />
  );
}

/** Groups of related rows, biggest first: the "mostly what?" answer. */
export function BreakdownSection({ section, plan, base }: SlotProps) {
  const { connection } = useContext(PageRenderContext);
  const data = useQuery<ResourceClientReply<'/api/breakdown'>>({
    queryKey: ['page-breakdown', plan.breakdown],
    queryFn: () => {
      if (!plan.breakdown) throw new Error(sayCopy('thisSectionHasNo'));
      return batchedBreakdown<ResourceClientReply<'/api/breakdown'>>({ def: plan.breakdown, owner: ownedBy(connection) });
    },
    enabled: !plan.empty && Boolean(plan.breakdown),
    staleTime: 0,
  });
  if (plan.empty) {
    /* Said as the reader would: which reference is unset, not a column's name. */
    const reference = section.of
      ? inAppPage()
        ? ((columnLabel(base.id, section.of) as string | null) ?? humanName(section.of)).replace(/[\s_]+id$/i, '').toLocaleLowerCase()
        : section.of
      : 'reference';
    return <SectionBox section={section} foldable={false} body={<Empty text={sayCopy('noIsSetSo', { reference })} />} />;
  }
  if (!plan.breakdown) return <SectionBox section={section} body={null} foldable={false} broken={sayCopy('thisSectionHasNo')} />;
  if (data.isPending) return <Loading section={section} />;
  if (data.isError) return <SectionBox section={section} body={null} foldable={false} broken={(data.error as Error).message} />;
  const got = data.data;
  if (!got) return <SectionBox section={section} body={null} foldable={false} broken={sayCopy('theseGroupsCouldNotBeRead')} />;
  if ('errors' in got)
    return (
      <SectionBox section={section} body={null} foldable={false} broken={got.errors[0]?.message ?? sayCopy('theseGroupsCouldNotBeRead')} />
    );
  const [keyName, countName] = got.columns;
  /* Biggest first, as the plan asks the server — or, where the column has a
     vocabulary, in its order (dashboardModel.ts, orderGroups). */
  /* The grouped column read through its path, so `campaign_id.kind` finds the vocabulary of the campaign's kind. */
  const allowed = presentationColumns(state.schema, findTable(section.from) as TableMeta | undefined, [section.by ?? '']).get(
    section.by ?? '',
  )?.allowed;
  const rows = orderGroups(got.rows, keyName, countName, allowed);
  // A table's name ("campaign_member") is the Workbench's vocabulary, not an
  // App reader's; a breakdown's title names groups, so it cannot be reused.
  if (!rows.length)
    return (
      <SectionBox
        section={section}
        foldable={false}
        body={<Empty text={inAppPage() ? sayCopy('nothingToCountYet') : sayCopy('noForThisRecord', { from: section.from ?? '' })} />}
      />
    );
  /* A group as a doorway: the anchoring condition comes off the compiled plan. */
  const conds = plan.breakdown.filter?.groups?.length === 1 ? plan.breakdown.filter.groups[0] : null;
  const anchor = conds?.find((c) => c.path === section.path && c.op === '=' && c.value != null);
  const drill =
    anchor && section.by
      ? (value: unknown) => {
          const where = andQuery(
            `${anchor.path} = ${quote(String(anchor.value))}`,
            section.filter,
            `${section.by} = ${quote(String(value))}`,
          );
          go(tableView(plan.breakdown!.base, `${plan.breakdown!.base} ${where}`), 'push');
        }
      : null;
  const largest = Math.max(...rows.map((r) => Number(r[countName]) || 0));
  // A measured breakdown ("sum open_value") dresses its figures as the column it reads, as a metric does.
  /* The author's word for the figures stands over the column's, as on a metric (G111). */
  const rule: DisplayRule | null = section.format
    ? { format: section.format }
    : section.fn && section.fn !== 'count' && section.column
      ? (columnDisplay(section.from, section.column) as DisplayRule | null)
      : null;
  const sayFigure = section.format || section.unit ? figureSayer(rule, section.unit) : formatNumber;
  const more = typeof got.total === 'number' && got.total > rows.length ? got.total - rows.length : 0;
  const sayKey = namedGroups(got, keyName, (key) =>
    groupLabel(columnDisplay(section.from, section.by) as DisplayRule | null, key, allowed),
  );
  return (
    <SectionBox
      section={section}
      foldable={false}
      body={
        <div className="page-breakdown-rows">
          {rows.map((row, i) => {
            const count = Number(row[countName]) || 0;
            const dress = rule?.format === 'money' && row[countName] != null ? dressFor(rule, row[countName]) : null;
            const shown = row[countName] == null ? '0' : dress?.text ? withUnit(dress.text, section.unit) : sayFigure(row[countName]);
            const parts = (
              <>
                <span className="pbd-label">{sayKey(row[keyName])}</span>
                <span className="pbd-bar">
                  <span className="pbd-fill" style={{ width: `${barShare(count, largest)}%` }} />
                </span>
                <span className="pbd-count">{shown}</span>
              </>
            );
            return drill && row[keyName] != null ? (
              <button
                key={i}
                type="button"
                className="pbd-row pbd-drill"
                title={sayCopy('openWhere', { from: section.from ?? '', by: section.by ?? '', row: String(row[keyName]) })}
                onClick={() => drill(row[keyName])}
              >
                {parts}
              </button>
            ) : (
              <div key={i} className="pbd-row">
                {parts}
              </div>
            );
          })}
          {more > 0 && <p className="note pbd-more">{sayCopy('andSmallerGroups', { count: more })}</p>}
        </div>
      }
    />
  );
}

/**
 * The related rows measured and drawn — the dashboard's chart about one
 * record. The plan is a breakdown anchored on the record (page.ts, chartPlan);
 * the drawing is the dashboard's own (ChartFigure).
 */
export function ChartSection({ section, plan, base }: SlotProps) {
  const { connection } = useContext(PageRenderContext);
  /* The section's own skeleton stands until the drawing has come as well as the answer. */
  const drawable = useArrived(ChartFigure, !plan.empty && Boolean(plan.breakdown));
  const data = useQuery<ResourceClientReply<'/api/breakdown'>>({
    queryKey: ['page-breakdown', 'chart', plan.breakdown],
    queryFn: () => {
      if (!plan.breakdown) throw new Error(sayCopy('thisChartHasNoBreakdown'));
      return batchedBreakdown<ResourceClientReply<'/api/breakdown'>>({ def: plan.breakdown, owner: ownedBy(connection) });
    },
    enabled: !plan.empty && Boolean(plan.breakdown),
    staleTime: 0,
  });
  if (plan.empty) {
    const reference = section.of
      ? inAppPage()
        ? ((columnLabel(base.id, section.of) as string | null) ?? humanName(section.of)).replace(/[\s_]+id$/i, '').toLocaleLowerCase()
        : section.of
      : 'reference';
    return <SectionBox section={section} foldable={false} body={<Empty text={sayCopy('noIsSetSoThere', { reference })} />} />;
  }
  if (!plan.breakdown) return <SectionBox section={section} body={null} foldable={false} broken={sayCopy('thisChartHasNoBreakdown')} />;
  if (data.isPending || (!drawable && !data.isError)) return <Loading section={section} />;
  if (data.isError) return <SectionBox section={section} body={null} foldable={false} broken={(data.error as Error).message} />;
  const got = data.data;
  if (!got || 'errors' in got)
    return (
      <SectionBox
        section={section}
        body={null}
        foldable={false}
        broken={(got && 'errors' in got ? got.errors[0]?.message : undefined) ?? sayCopy('thisChartCouldNotBeRead')}
      />
    );
  const from = section.from ?? '';
  /* Each key's column, its period dropped: "month issued_on" is labelled as issued_on is. */
  const [first = '', second = ''] = (section.by ?? '').split(',').map((key) => key.trim().split(/\s+/).pop() ?? '');
  const say = sayer({
    kind: 'chart',
    table: from,
    measure: section.fn && section.fn !== 'count' ? `${section.fn} ${section.column ?? ''}` : undefined,
    format: section.format,
    unit: section.unit,
  });
  const labelFor = (path: string) => {
    const allowed = presentationColumns(state.schema, findTable(from) as TableMeta | undefined, [path]).get(path)?.allowed;
    const rule = columnDisplay(from, path) as DisplayRule | null;
    return { say: (key: unknown) => groupLabel(rule, key, allowed), allowed };
  };
  const firstLabel = labelFor(first);
  /* The column a category order reads rides after the figures (page.ts, chartOrder): it is no series of the drawing. */
  const drawn = { ...got, columns: got.columns.slice(0, (second ? 2 : 1) + 1) };
  /* A slice — or a line's point — is a way into its rows where the key is a plain column, as a breakdown's group is. */
  const conds = plan.breakdown.filter?.groups?.length === 1 ? plan.breakdown.filter.groups[0] : null;
  const anchor = conds?.find((c) => c.path === section.path && c.op === '=' && c.value != null);
  const plainKey = !/\s/.test((section.by ?? '').split(',')[0].trim());
  const drill =
    anchor && plainKey && (section.shape === 'donut' || section.shape === 'line')
      ? (value: unknown) => {
          if (value == null) return;
          const where = andQuery(`${anchor.path} = ${quote(String(anchor.value))}`, section.filter, `${first} = ${quote(String(value))}`);
          go(tableView(plan.breakdown!.base, `${plan.breakdown!.base} ${where}`), 'push');
        }
      : null;
  return (
    <SectionBox
      section={section}
      foldable={false}
      body={
        <ChartFigure
          answer={drawn}
          arrange={section.sort === 'value' ? 'value' : plan.breakdown.orderBy?.[0]?.name === 'value' ? undefined : 'answer'}
          shape={section.shape}
          limit={section.limit}
          target={section.target}
          height={section.height}
          say={say}
          label={namedGroups(got, got.columns[0], firstLabel.say)}
          seriesLabel={namedGroups(got, second ? got.columns[1] : undefined, labelFor(second).say)}
          vocabulary={firstLabel.allowed}
          onPick={drill}
          empty={inAppPage() ? sayCopy('nothingToDrawYet') : sayCopy('noForThisRecord', { from })}
        />
      }
    />
  );
}
