/**
 * The Console's Analytics room (read-only): one App's tracked and
 * business events by day, each declared funnel computed by its own
 * statement, the names counted most, and breakdowns by kind, by who and by
 * tenant. Its route answers per App from that App's `operations:
 * ['analytics']` grant and sends counts only: never a unit id, a field value
 * or a row.
 *
 * The room is three views under one range. Overview leads with the figures
 * as one compact strip, then the days as a chart, then the breakdowns.
 * Events lists the names counted most, and one opened is a view of its own:
 * its figures and its days. Funnels draws one funnel as the dashboard's
 * steps, what dropped away between each. A range is a preset (7, 30 or 90
 * days, ending today) or Custom, whose dates are asked only then. Each
 * figure says its change against the equal period before the range, which
 * the route counts alongside.
 */
import { useId, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { Card, Columns, Dropdown, Empty, Segmented, Stack, useFormat, useSectionSize, useViewer } from '@mistriwork/mistri/ui';
import { useAddressState } from '@mistriwork/mistri/page';
import { useMessageLanguage } from '@mistriwork/kit/client/components/useMessageLanguage.js';
import { say } from '../../copy/console/components/console/AnalyticsRoom.js';
import { consoleRequest, type ConsoleRequest } from './model.js';
import { ConsoleHead, pickApp, useConsoleApp, useLiveRead, useLiveTick, type PaletteEntry } from './ConsoleShell.js';
import '../DashboardBlocks.css';
import './ConsoleRoom.css';

interface AnalyticsApp {
  id: string;
  name: string;
  funnels: string[];
}
interface Count {
  key: string;
  events: number;
  units: number;
}
interface Report {
  from: string;
  to: string;
  units?: number;
  days: { day: string; tracked: number; business: number }[];
  names: { kind: string; name: string; events: number; units: number }[];
  breakdowns: { kind: Count[]; unit: Count[]; tenant?: Count[] };
  funnels: {
    id: string;
    result: {
      unit: 'subject' | 'visitor';
      conversionWindowHours: number;
      steps: { step: number; label: string; units: number; fromPrevious: number; fromStart: number }[];
    };
  }[];
  previous?: { from: string; tracked: number; business: number; units: number; names: { kind: string; name: string; events: number }[] };
}
type Range = '7' | '30' | '90' | 'custom';
const KIND: Record<string, () => string> = {
  view: () => say('kindView'),
  action: () => say('kindAction'),
  form: () => say('kindForm'),
  event: () => say('kindEvent'),
  business: () => say('kindBusiness'),
};
const UNIT: Record<string, () => string> = {
  subject: () => say('unitKeySubject'),
  visitor: () => say('unitKeyVisitor'),
  none: () => say('unitKeyNone'),
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;

function failure(code: string | undefined, message: string) {
  const said =
    code === 'not_granted'
      ? say('notGranted')
      : code === 'invalid_request'
        ? say('invalidWindow')
        : code === 'unavailable'
          ? say('unavailable')
          : undefined;
  return said ?? (message || say('refused'));
}
/** A preset's window: its days ending today (UTC), as the route counts whole UTC days. */
function presetWindow(days: number, now = Date.now()): { from: string; to: string } {
  const today = Math.floor(now / DAY) * DAY;
  return { from: new Date(today - (days - 1) * DAY).toISOString().slice(0, 10), to: new Date(today).toISOString().slice(0, 10) };
}

export default function AnalyticsRoom({ props }: { props: { endpoint: string } }) {
  useMessageLanguage();
  const viewer = useViewer();
  const request = useMemo(() => consoleRequest(props.endpoint, viewer.account ?? ''), [props.endpoint, viewer.account]);
  const [app, chooseApp] = useConsoleApp();
  const [view, setView] = useAddressState('view');
  const [range, setRange] = useAddressState('range'),
    [from, setFrom] = useAddressState('from'),
    [to, setTo] = useAddressState('to');
  const [event, setEvent] = useAddressState('event'),
    [funnel, setFunnel] = useAddressState('funnel');
  const only =
    event && event.includes(':') ? { kind: event.slice(0, event.indexOf(':')), name: event.slice(event.indexOf(':') + 1) } : undefined;
  if (!viewer.signedIn || !viewer.account) return <Empty title={say('signIn')} />;
  return (
    <AnalyticsPanel
      key={viewer.account}
      request={request}
      appId={app}
      view={asView(view)}
      range={range}
      from={from}
      to={to}
      event={only}
      funnel={funnel}
      chooseView={(next, also) => {
        // The step goes last: once it is pushed, a later change to the old address is dropped.
        setEvent(also?.event ? `${also.event.kind}:${also.event.name}` : undefined);
        if (also?.funnel) setFunnel(also.funnel);
        setView(next === 'overview' ? undefined : next, { push: true });
      }}
      chooseEvent={(next) => setEvent(next ? `${next.kind}:${next.name}` : undefined, { push: true })}
      chooseFunnel={(next) => setFunnel(next)}
      chooseApp={(next) => {
        setEvent(undefined);
        setFunnel(undefined);
        chooseApp(next);
      }}
      chooseRange={(next) => {
        setRange(next === '30' ? undefined : next);
        if (next !== 'custom') {
          setFrom(undefined);
          setTo(undefined);
        }
      }}
      chooseWindow={(nextFrom, nextTo) => {
        setRange('custom');
        setFrom(nextFrom);
        setTo(nextTo);
      }}
    />
  );
}

type View = 'overview' | 'events' | 'funnels';
const VIEWS: readonly View[] = ['overview', 'events', 'funnels'];
const VIEW_WORD: Record<View, () => string> = {
  overview: () => say('overview'),
  events: () => say('eventsView'),
  funnels: () => say('funnels'),
};
const asView = (value: string | undefined): View => ((VIEWS as readonly string[]).includes(value ?? '') ? (value as View) : 'overview');

export function AnalyticsPanel({
  request,
  appId,
  view = 'overview',
  range: asked,
  from,
  to,
  event,
  funnel: chosenFunnel,
  chooseView,
  chooseApp,
  chooseRange,
  chooseWindow,
  chooseEvent,
  chooseFunnel,
}: {
  request: ConsoleRequest;
  appId?: string;
  /** Overview (the figures, the chart, the breakdowns), Events (the names, and one opened), or Funnels. */
  view?: View;
  range?: string;
  from?: string;
  to?: string;
  chooseView?(view: View, also?: { event?: { kind: string; name: string }; funnel?: string }): void;
  chooseApp(app: { id: string; name: string }): void;
  chooseRange?(range: Range): void;
  chooseWindow(from: string | undefined, to: string | undefined): void;
  /** One event opened in the Events view: the chart and the figures follow it. */
  event?: { kind: string; name: string };
  chooseEvent?(event: { kind: string; name: string } | undefined): void;
  funnel?: string;
  chooseFunnel?(id: string): void;
}) {
  useMessageLanguage();
  const format = useFormat();
  const compact = useSectionSize().compact;
  const [tick, refresh] = useLiveTick();
  const catalog = useLiveRead<{ apps: AnalyticsApp[] }>(request, '/analytics');
  const apps = catalog?.data?.apps ?? [];
  const app = pickApp(apps, appId);
  // A window in the address is Custom's, whatever the preset says; no window and no preset is the last 30 days.
  const range: Range =
    asked === 'custom' || (asked === undefined && (from || to)) ? 'custom' : asked === '7' || asked === '90' ? asked : '30';
  const preset = range === 'custom' ? undefined : presetWindow(Number(range));
  const window =
    range === 'custom'
      ? [from && DATE.test(from) ? `from=${from}` : '', to && DATE.test(to) ? `to=${to}` : ''].filter(Boolean).join('&')
      : `from=${preset!.from}&to=${preset!.to}`;
  // An event is opened only in the Events view; the other views count every event.
  const opened = view === 'events' ? event : undefined;
  const query = [window, opened ? `kind=${encodeURIComponent(opened.kind)}&name=${encodeURIComponent(opened.name)}` : '']
    .filter(Boolean)
    .join('&');
  const report = useLiveRead<Report>(request, app ? `/analytics/${app.id}${query ? `?${query}` : ''}` : undefined, tick);
  const data = report?.data;
  const shownFrom = from ?? data?.from.slice(0, 10) ?? '',
    shownTo = to ?? (data ? new Date(Date.parse(data.to) - DAY).toISOString().slice(0, 10) : '');
  const span = data ? Math.round((Date.parse(data.to) - Date.parse(data.from)) / DAY) : Number(range === 'custom' ? 30 : range);
  const tracked = data ? data.days.reduce((sum, day) => sum + day.tracked, 0) : 0;
  const business = data ? data.days.reduce((sum, day) => sum + day.business, 0) : 0;
  const change = (now: number, before: number | undefined): Change => {
    if (before === undefined) return { text: say('noPrior') };
    if (!before) return { text: now ? say('fromNothing') : say('same', { days: span }) };
    const rate = format.percent(Math.abs((now - before) / before) * 100);
    return now > before
      ? { text: say('up', { rate, days: span }), tone: 'good' }
      : now < before
        ? { text: say('down', { rate, days: span }), tone: 'bad' }
        : { text: say('same', { days: span }) };
  };
  const previous = data?.previous;
  const shownFunnel = data?.funnels.find((entry) => entry.id === chosenFunnel) ?? data?.funnels[0];
  const number = (value: unknown) => format.number(Number(value));
  const tabId = useId(),
    tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const entries: PaletteEntry[] = [
    ...(data?.names ?? []).map((row) => ({
      id: `event:${row.kind}:${row.name}`,
      group: say('eventsView'),
      label: row.name,
      detail: KIND[row.kind]?.() ?? row.kind,
      run: () => chooseView?.('events', { event: { kind: row.kind, name: row.name } }),
    })),
    ...(app?.funnels ?? []).map((id) => ({
      id: `funnel:${id}`,
      group: say('funnels'),
      label: id,
      run: () => chooseView?.('funnels', { funnel: id }),
    })),
  ];
  const chart = (
    <Card title={opened ? say('overTimeOne', { name: opened.name }) : say('overTime')}>
      {!data ? null : !(tracked + business) ? (
        <Empty title={say('noEvents')} />
      ) : (
        <Columns
          rows={data.days.map((day) => ({ key: day.day, values: { tracked: day.tracked, business: day.business } }))}
          say={number}
          series={[
            { key: 'tracked', label: say('trackedEvents') },
            { key: 'business', label: say('businessEvents') },
          ]}
        />
      )}
    </Card>
  );
  return (
    <Stack className="console-workspace">
      {catalog?.error && (
        <p className="console-problem" role="alert">
          {failure(catalog.code, catalog.error)}
        </p>
      )}
      {!catalog ? (
        <p role="status">{say('loadingApps')}</p>
      ) : !apps.length ? (
        <Empty title={say('noApps')} description={say('noAppsDetail')} />
      ) : (
        <>
          <ConsoleHead
            title={say('title')}
            apps={apps}
            app={app}
            onApp={chooseApp}
            live={{ at: report?.at, pending: report?.pending ?? true, onRefresh: refresh }}
            entries={entries}
          >
            <div className="console-toolbar">
              {compact ? (
                <div className="console-switcher">
                  <Dropdown
                    ariaLabel={say('range')}
                    value={range}
                    onChange={(next) => pickRange(next as Range)}
                    items={[
                      { value: '7', label: say('last7') },
                      { value: '30', label: say('last30') },
                      { value: '90', label: say('last90') },
                      { value: 'custom', label: say('custom') },
                    ]}
                  />
                </div>
              ) : (
                <Segmented
                  label={say('range')}
                  size="compact"
                  value={range}
                  onChange={pickRange}
                  options={[
                    { value: '7', label: say('days7'), name: say('last7') },
                    { value: '30', label: say('days30'), name: say('last30') },
                    { value: '90', label: say('days90'), name: say('last90') },
                    { value: 'custom', label: say('custom') },
                  ]}
                />
              )}
              {range === 'custom' && (
                <span className="console-dates">
                  <label>
                    <span>{say('from')}</span>
                    <input type="date" value={shownFrom} onChange={(change) => chooseWindow(change.target.value || undefined, to)} />
                  </label>
                  <label>
                    <span>{say('to')}</span>
                    <input type="date" value={shownTo} onChange={(change) => chooseWindow(from, change.target.value || undefined)} />
                  </label>
                </span>
              )}
            </div>
          </ConsoleHead>
          {report?.error && (
            <p className="console-problem" role="alert">
              {failure(report.code, report.error)}
            </p>
          )}
          <Stack className="page-tabs">
            <div className="page-tabstrip" role="tablist" aria-label={say('views')}>
              {VIEWS.map((name, index) => (
                <button
                  key={name}
                  type="button"
                  className="page-tab"
                  role="tab"
                  id={`${tabId}-${name}`}
                  aria-controls={`${tabId}-panel`}
                  aria-selected={view === name}
                  tabIndex={view === name ? 0 : -1}
                  ref={(node) => {
                    tabs.current[index] = node;
                  }}
                  onClick={() => chooseView?.(name)}
                  onKeyDown={(key) => {
                    const step = key.key === 'ArrowRight' ? 1 : key.key === 'ArrowLeft' ? -1 : 0;
                    if (!step) return;
                    key.preventDefault();
                    const next = (index + step + VIEWS.length) % VIEWS.length;
                    chooseView?.(VIEWS[next]);
                    tabs.current[next]?.focus();
                  }}
                >
                  {VIEW_WORD[name]()}
                </button>
              ))}
            </div>
            <div className="page-tabpanel" role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${view}`}>
              {!data ? (
                !report?.error && (
                  <p role="status" className="console-reading">
                    {say('loading')}
                  </p>
                )
              ) : view === 'overview' ? (
                <Stack>
                  <Figures
                    figures={[
                      {
                        label: say('totalEvents'),
                        value: format.number(tracked + business),
                        change: change(tracked + business, previous && previous.tracked + previous.business),
                      },
                      { label: say('trackedEvents'), value: format.number(tracked), change: change(tracked, previous?.tracked) },
                      { label: say('businessEvents'), value: format.number(business), change: change(business, previous?.business) },
                      ...(data.units !== undefined
                        ? [{ label: say('people'), value: format.number(data.units), change: change(data.units, previous?.units) }]
                        : []),
                    ]}
                  />
                  {chart}
                  <div className="console-pair console-thirds">
                    <Breakdown title={say('byKind')} rows={data.breakdowns.kind} label={(key) => KIND[key]?.() ?? key} />
                    <Breakdown title={say('byUnit')} rows={data.breakdowns.unit} label={(key) => UNIT[key]?.() ?? key} />
                    {data.breakdowns.tenant && <Breakdown title={say('byTenant')} rows={data.breakdowns.tenant} label={(key) => key} />}
                  </div>
                  <p className="console-caption">{say('privacy')}</p>
                </Stack>
              ) : view === 'events' && opened ? (
                <EventView
                  event={opened}
                  row={data.names.find((row) => row.kind === opened.kind && row.name === opened.name)}
                  before={
                    previous?.names.find((row) => row.kind === opened.kind && row.name === opened.name)?.events ??
                    (previous ? 0 : undefined)
                  }
                  change={change}
                  chart={chart}
                  close={() => chooseEvent?.(undefined)}
                />
              ) : view === 'events' ? (
                <TopEvents data={data} open={(row) => chooseEvent?.(row)} />
              ) : !data.funnels.length ? (
                <Empty title={say('noFunnels')} />
              ) : (
                <Stack>
                  {data.funnels.length > 1 &&
                    (compact ? (
                      <div className="console-switcher">
                        <Dropdown
                          ariaLabel={say('funnel')}
                          value={shownFunnel!.id}
                          onChange={(id) => chooseFunnel?.(id)}
                          items={data.funnels.map((entry) => ({ value: entry.id, label: entry.id }))}
                        />
                      </div>
                    ) : (
                      <Segmented
                        label={say('funnel')}
                        size="compact"
                        value={shownFunnel!.id}
                        onChange={(id) => chooseFunnel?.(id)}
                        options={data.funnels.map((entry) => ({ value: entry.id, label: entry.id }))}
                      />
                    ))}
                  {shownFunnel && <Funnel key={shownFunnel.id} funnel={shownFunnel} />}
                </Stack>
              )}
            </div>
          </Stack>
        </>
      )}
    </Stack>
  );
  function pickRange(next: Range) {
    if (chooseRange) chooseRange(next);
    else if (next === 'custom') chooseWindow(shownFrom || undefined, shownTo || undefined);
    else chooseWindow(undefined, undefined);
  }
}

type Change = { text: string; tone?: 'good' | 'bad' };

/** The figures as one compact strip: a cell each, its label, its number and its change; two by two on a phone. */
function Figures({ figures }: { figures: ReadonlyArray<{ label: string; value: string; change: Change }> }) {
  return (
    <dl className="console-strip" style={{ '--cells': figures.length } as CSSProperties}>
      {figures.map((figure) => (
        <div key={figure.label} className="console-strip-cell">
          <dt>{figure.label}</dt>
          <dd className="console-strip-figure">{figure.value}</dd>
          <dd
            className={`console-strip-change${figure.change.tone === 'good' ? ' console-up' : figure.change.tone === 'bad' ? ' console-down' : ''}`}
          >
            {figure.change.text}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The names counted most, each a way into its own view. */
function TopEvents({ data, open }: { data: Report; open(event: { kind: string; name: string }): void }) {
  useMessageLanguage();
  const format = useFormat();
  const previous = data.previous;
  if (!data.names.length) return <Empty title={say('noEvents')} />;
  return (
    <div className="console-scroll">
      <table className="console-table">
        <caption className="console-sr">{say('topNames')}</caption>
        <thead>
          <tr>
            <th scope="col">{say('name')}</th>
            <th scope="col" className="console-num">
              {say('events')}
            </th>
            <th scope="col" className="console-num">
              {say('distinctUnits')}
            </th>
            <th scope="col" className="console-num">
              {say('trend')}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.names.map((row) => {
            const before = previous?.names.find((entry) => entry.kind === row.kind && entry.name === row.name)?.events;
            return (
              <tr key={`${row.kind}:${row.name}`}>
                <td>
                  <button
                    type="button"
                    className="console-open"
                    data-list-key
                    title={say('showOnly', { name: row.name })}
                    onClick={() => open({ kind: row.kind, name: row.name })}
                  >
                    {row.name}
                  </button>
                  <span className="console-caption console-block">{KIND[row.kind]?.() ?? row.kind}</span>
                </td>
                <td className="console-num">{format.number(row.events)}</td>
                <td className="console-num">{format.number(row.units)}</td>
                <td className="console-num">
                  <Trend now={row.events} before={previous ? (before ?? 0) : undefined} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One event opened: the way back to every event, its figures, and its days. */
function EventView({
  event,
  row,
  before,
  change,
  chart,
  close,
}: {
  event: { kind: string; name: string };
  row?: { events: number; units: number };
  before: number | undefined;
  change(now: number, before: number | undefined): Change;
  chart: ReactNode;
  close(): void;
}) {
  useMessageLanguage();
  const format = useFormat();
  return (
    <Stack>
      <div className="console-event-head">
        <button type="button" className="console-back" aria-label={say('removeEvent', { name: event.name })} onClick={close}>
          <span aria-hidden="true">←</span> {say('allEvents')}
        </button>
        <span className="console-event-name">{event.name}</span>
        <span className="console-caption">{KIND[event.kind]?.() ?? event.kind}</span>
      </div>
      <Figures
        figures={[
          { label: say('events'), value: format.number(row?.events ?? 0), change: change(row?.events ?? 0, before) },
          { label: say('distinctUnits'), value: format.number(row?.units ?? 0), change: { text: say('inWindow') } },
        ]}
      />
      {chart}
    </Stack>
  );
}

/** A name's change against the period before: up, down, new or flat, in words. */
function Trend({ now, before }: { now: number; before: number | undefined }) {
  const format = useFormat();
  if (before === undefined) return <span className="console-faint">—</span>;
  if (!before) return <span>{now ? say('trendNew') : say('trendFlat')}</span>;
  const rate = format.percent(Math.abs((now - before) / before) * 100);
  return (
    <span className={now > before ? 'console-up' : now < before ? 'console-down' : undefined}>
      {now > before ? say('trendUp', { rate }) : now < before ? say('trendDown', { rate }) : say('trendFlat')}
    </span>
  );
}

/**
 * A funnel as the dashboard's steps block: a card per step with its units
 * and its share of the first, and on every card after the first what dropped
 * away since the one before. The head says the whole funnel's conversion.
 */
function Funnel({ funnel }: { funnel: Report['funnels'][number] }) {
  useMessageLanguage();
  const format = useFormat();
  const steps = funnel.result.steps;
  const last = steps.at(-1);
  return (
    <section className="console-funnel" aria-label={funnel.id}>
      <div className="console-funnel-head">
        <h3 className="console-section-title">{funnel.id}</h3>
        {last && steps.length > 1 && (
          <span className="console-strong">{say('converted', { rate: format.percent(last.fromStart * 100) })}</span>
        )}
      </div>
      <p className="console-caption">
        {say('funnelUnit', {
          unit: funnel.result.unit === 'subject' ? say('unitSubject') : say('unitVisitor'),
          hours: funnel.result.conversionWindowHours,
        })}
      </p>
      <ol className="dash-steps console-funnel-steps" style={{ '--steps': Math.max(steps.length, 1) } as CSSProperties}>
        {steps.map((step, index) => (
          <li key={step.step} className="dash-step">
            <div className="dash-step-card">
              <span className="dash-step-mark" aria-hidden="true">
                {index + 1}
              </span>
              <span className="dash-step-figure console-num">{say('units', { count: step.units })}</span>
              <span className="dash-step-words">
                <span className="dash-step-title">{step.label}</span>
                <span className="dash-step-note">{say('ofFirst', { rate: format.percent(step.fromStart * 100) })}</span>
                {index > 0 && (
                  <span className="dash-step-note console-funnel-drop">
                    {say('dropped', { rate: format.percent((1 - step.fromPrevious) * 100), count: format.number(step.units) })}
                  </span>
                )}
              </span>
              <span className="console-funnel-track" aria-hidden="true">
                <span className="console-funnel-bar" style={{ inlineSize: `${Math.max(0, Math.min(1, step.fromStart)) * 100}%` }} />
              </span>
            </div>
            {index < steps.length - 1 && (
              <span className="dash-step-arrow" aria-hidden="true">
                ›
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Breakdown({ title, rows, label }: { title: string; rows: Count[]; label(key: string): string }) {
  useMessageLanguage();
  const format = useFormat();
  const most = Math.max(1, ...rows.map((row) => row.events));
  return (
    <Card title={title}>
      {!rows.length ? (
        <p className="console-caption">{say('noEvents')}</p>
      ) : (
        <ul className="console-breakdown">
          {/* The funnel's bar: one ruler for every share the room draws. */}
          {rows.map((row) => (
            <li key={row.key}>
              <span className="console-funnel-label">{label(row.key)}</span>
              <span className="console-funnel-track" aria-hidden="true">
                <span className="console-funnel-bar" style={{ inlineSize: `${(row.events / most) * 100}%` }} />
              </span>
              <span className="console-num">{format.number(row.events)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
