/**
 * The Console's Operations room: one App's jobs, event and webhook
 * deliveries, durable workflows and store layouts, with redrive, Cancel and
 * Retry. Every read and act goes through the Console's own routes, which
 * answer per App from that App's `operations` grants: the room only draws
 * the views its routes said this account may open.
 *
 * The room opens on four figures — what needs attention, what is dead, what
 * is retrying, what is in flight — each with the trend of this visit's
 * readings, over three views. Work is jobs and deliveries in one stream,
 * faceted by state and opened on what needs attention, dead work first; a
 * row opens a drawer beside the list (a sheet on a phone) with its facts,
 * Redrive and every attempt. Workflows keep their own list; stores are a
 * health grid. Everything refreshes itself while the tab is in view.
 *
 * The workflows view is the Keystone lender's room, made a Console view: the
 * same list, history, Cancel (asked twice) and Retry, which wakes a live one.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Dropdown, Empty, Row, Segmented, Stack, Stat, Tone, useSectionSize, useViewer } from '@mistriwork/mistri/ui';
import { useAddressState } from '@mistriwork/mistri/page';
import { useMessageLanguage } from '@mistriwork/kit/client/components/useMessageLanguage.js';
import { say } from '../../copy/console/components/console/OperationsRoom.js';
import { consoleRequest, ConsoleFailure, type ConsoleRequest } from './model.js';
import {
  ConsoleHead,
  ConsoleSplit,
  When,
  pickApp,
  useConsoleApp,
  useListKeys,
  useLiveRead,
  useLiveTick,
  type PaletteEntry,
} from './ConsoleShell.js';
import './ConsoleRoom.css';

/** What a role is granted, as the routes name it. */
type Section = 'jobs' | 'deliveries' | 'workflows' | 'stores';
/** What the room draws: jobs and deliveries are one stream of work. */
type View = 'work' | 'workflows' | 'stores';
type Group = 'attention' | 'scheduled' | 'done';
type Facet = Group | 'all';
type ToneName = 'good' | 'warn' | 'bad' | 'info' | 'neutral';
type Destination = { id: string; kind: 'job' | 'workflow' | 'webhook'; name: string };
interface OperationsApp {
  id: string;
  name: string;
  sections: Section[];
  destinations?: Destination[];
}
interface Job {
  id: string;
  job: string;
  state: string;
  attempts: number;
  maxAttempts: number;
  redrives: number;
  runAt: string | null;
  lastCode: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}
interface Delivery {
  eventId: string;
  ordinal: number;
  state: string;
  attempts: number;
  maxAttempts: number;
  redrives: number;
  nextAt: string | null;
  lastCode: string | null;
}
/** A job or a delivery, as the stream draws either. */
interface Work {
  key: string;
  name: string;
  /** The delivery's destination; a job has none. */
  destination?: Destination;
  state: string;
  attempts: number;
  maxAttempts: number;
  redrives: number;
  lastCode: string | null;
  /** When it runs next, while it waits its turn. */
  next: string | null;
  /** When it last moved (a job), or its schedule (a delivery): the stream's order within a state. */
  at: string | null;
  createdAt?: string | null;
  redrive: { path: string; body: Record<string, string> };
  attemptsPath: string;
}
interface Attempt {
  attempt: number;
  startedAt: string | null;
  outcome: string;
  code: string | null;
  operator: string | null;
}
interface StoreRow {
  database: string;
  dialect: string;
  id: string;
  title: string;
  found: number | null;
  current: number;
  pending: number[];
  refused?: string;
}
type WorkflowState = 'running' | 'waiting' | 'completed' | 'failed' | 'diverged' | 'cancelled';
interface Instance {
  id: string;
  workflow: string;
  version: number;
  key: string;
  state: WorkflowState;
  currentStep: string | null;
  waitEvent: string | null;
  wakeAt: string | null;
  problem: string | null;
  problemStep: string | null;
  /** A workflow_error's error, by name and code: never its message. */
  problemError?: { name: string; code?: string };
  createdAt: string;
  updatedAt: string;
}
interface Step {
  name: string;
  ordinal: number;
  kind: string;
  status: string;
  attempts: number;
  wakeAt: string | null;
  errorCode: string | null;
}
interface Summary {
  jobs?: { dead: number; retrying: number; scheduled: number; recent: number; capped: boolean };
  deliveries?: { dead: number; retrying: number; scheduled: number; delivered: number; capped: boolean };
  workflows?: { failed: number; running: number; completed: number; capped: boolean };
  stores?: { total: number; behind: number; refused: number };
}

const VIEW_WORD: Record<View, () => string> = {
  work: () => say('work'),
  workflows: () => say('workflows'),
  stores: () => say('stores'),
};
const STATE_WORD: Record<string, () => string> = {
  scheduled: () => say('stateScheduled'),
  leased: () => say('stateLeased'),
  retry: () => say('stateRetry'),
  failed: () => say('stateFailed'),
  unknown: () => say('stateUnknown'),
  succeeded: () => say('stateSucceeded'),
  cancelled: () => say('stateCancelled'),
  pending: () => say('statePending'),
  delivered: () => say('stateDelivered'),
};
const STATE_TONE: Record<string, ToneName> = {
  scheduled: 'neutral',
  leased: 'info',
  retry: 'warn',
  failed: 'bad',
  unknown: 'warn',
  succeeded: 'good',
  cancelled: 'neutral',
  pending: 'neutral',
  delivered: 'good',
};
/** The stream's order: dead work first, then what is unsure, retrying, running, waiting, and what is done. */
const STATE_RANK: Record<string, number> = {
  failed: 0,
  unknown: 1,
  retry: 2,
  leased: 3,
  scheduled: 4,
  pending: 4,
  succeeded: 5,
  delivered: 5,
  cancelled: 6,
};
/** An outcome code in words; the code itself stays beside them, in the code face, for the reader who greps a log. */
const CODE_WORD: Record<string, () => string> = {
  succeeded: () => say('codeSucceeded'),
  accepted: () => say('codeAccepted'),
  rejected: () => say('codeRejected'),
  not_authorized: () => say('codeNotAuthorized'),
  timeout: () => say('codeTimeout'),
  shutdown: () => say('codeShutdown'),
  lease_expired: () => say('codeLeaseExpired'),
  cancelled: () => say('codeCancelled'),
  input_invalid: () => say('codeInputInvalid'),
  handler_error: () => say('codeHandlerError'),
  redriven: () => say('codeRedriven'),
  transport: () => say('codeTransport'),
};
const ATTEMPT_WORD: Record<string, () => string> = {
  leased: () => say('outcomeLeased'),
  succeeded: () => say('codeSucceeded'),
  accepted: () => say('codeAccepted'),
  rejected: () => say('codeRejected'),
  failed: () => say('outcomeFailed'),
  retry: () => say('outcomeRetry'),
  unknown: () => say('outcomeUnknown'),
  cancelled: () => say('codeCancelled'),
  redriven: () => say('codeRedriven'),
};
const WF_WORD: Record<WorkflowState, () => string> = {
  running: () => say('wfRunning'),
  waiting: () => say('wfWaiting'),
  completed: () => say('wfCompleted'),
  failed: () => say('wfFailed'),
  diverged: () => say('wfDiverged'),
  cancelled: () => say('wfCancelled'),
};
const WF_TONE: Record<WorkflowState, ToneName> = {
  running: 'info',
  waiting: 'neutral',
  completed: 'good',
  failed: 'bad',
  diverged: 'bad',
  cancelled: 'neutral',
};
const REDRIVABLE = new Set(['failed', 'unknown']);
const REFUSAL: Record<string, () => string> = {
  not_granted: () => say('notGranted'),
  not_authorized: () => say('notGranted'),
  not_found: () => say('notFound'),
  not_redrivable: () => say('notRedrivable'),
  redrive_limit: () => say('redriveLimit'),
  lease_held: () => say('leaseHeld'),
  not_retryable: () => say('notRetryable'),
  unavailable: () => say('unavailable'),
  account_changed: () => say('accountChanged'),
};
/** A list opens on what needs someone; All is asked for by name. */
const asFacet = (value: string | undefined): Facet =>
  value === 'all' || value === 'scheduled' || value === 'done' || value === 'attention' ? value : 'attention';
const groupQuery = (facet: Facet) => (facet === 'all' ? '' : `group=${facet}`);

/** A refusal's code (the Console's `code`, or a workflow route's bare `error`), said as a sentence. */
export function refusalText(error: unknown): string {
  const failure = error as ConsoleFailure;
  const code = failure instanceof ConsoleFailure && failure.code !== 'refused' ? failure.code : failure?.message;
  return REFUSAL[code]?.() ?? (failure instanceof ConsoleFailure ? failure.message : say('refused'));
}
const problem = (read: { error?: string; code?: string } | undefined) =>
  read?.error === undefined ? undefined : (
    <p className="console-problem" role="alert">
      {refusalText(new ConsoleFailure(read.code ?? 'refused', read.error))}
    </p>
  );

export default function OperationsRoom({ props }: { props: { endpoint: string } }) {
  useMessageLanguage();
  const viewer = useViewer();
  const request = useMemo(() => consoleRequest(props.endpoint, viewer.account ?? ''), [props.endpoint, viewer.account]);
  const [app, chooseApp] = useConsoleApp();
  const [section, setSection] = useAddressState('section');
  const [destination, setDestination] = useAddressState('destination'),
    [state, setState] = useAddressState('state');
  const [item, setItem] = useAddressState('item');
  if (!viewer.signedIn || !viewer.account) return <Empty title={say('signIn')} />;
  return (
    <OperationsPanel
      key={viewer.account}
      request={request}
      appId={app}
      section={section as View | undefined}
      destination={destination}
      state={state}
      item={item}
      choose={(next) => {
        if ('app' in next) {
          chooseApp(next.app);
          setSection(undefined);
          setDestination(undefined);
          setState(undefined);
          setItem(undefined);
          return;
        }
        if ('open' in next) {
          // A jump from the palette: the row and its facet, then the view as one step back can undo. The step
          // goes last: once it is pushed, the room's address is a new entry and a later change to the old one is dropped.
          setDestination(undefined);
          setState(next.open.state);
          setItem(next.open.item);
          setSection(next.open.section, { push: true });
          return;
        }
        if ('section' in next) {
          setDestination(undefined);
          setState(undefined);
          setItem(undefined);
          setSection(next.section, { push: true });
          return;
        }
        if ('destination' in next) {
          setDestination(next.destination);
          setItem(undefined);
          return;
        }
        if ('state' in next) {
          setState(next.state);
          setItem(undefined);
          return;
        }
        setItem(next.item);
      }}
    />
  );
}

type Choice =
  | { app: { id: string; name: string } }
  | { section: View | undefined }
  | { open: { section: View; item: string; state?: string } }
  | { destination: string | undefined }
  | { state: string | undefined }
  | { item: string | undefined };

/** The views an App's grants open, in the room's order. */
function viewsOf(app: OperationsApp): View[] {
  return [
    ...(app.sections.includes('jobs') || app.sections.includes('deliveries') ? (['work'] as const) : []),
    ...(app.sections.includes('workflows') ? (['workflows'] as const) : []),
    ...(app.sections.includes('stores') ? (['stores'] as const) : []),
  ];
}

export function OperationsPanel({
  request,
  appId,
  section,
  destination,
  state,
  item,
  choose,
}: {
  request: ConsoleRequest;
  appId?: string;
  section?: View;
  destination?: string;
  state?: string;
  item?: string;
  choose(next: Choice): void;
}) {
  useMessageLanguage();
  const [tick, refresh] = useLiveTick();
  const catalog = useLiveRead<{ apps: OperationsApp[] }>(request, '/operations');
  const apps = catalog?.data?.apps ?? [];
  const app = pickApp(apps, appId);
  const summary = useLiveRead<{ sections: Summary }>(request, app ? `/operations/${app.id}/summary` : undefined, tick);
  const counts = summary?.current ? summary.data?.sections : undefined;
  const views = app ? viewsOf(app) : [];
  const chosen = section && views.includes(section) ? section : views[0];
  const [entries, setEntries] = useState<readonly PaletteEntry[]>([]);
  const tabId = useId(),
    tabs = useRef<Array<HTMLButtonElement | null>>([]),
    panel = useRef<HTMLDivElement>(null);
  useListKeys(panel, item ? () => choose({ item: undefined }) : undefined);
  return (
    <Stack className="console-workspace">
      {problem(catalog)}
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
            onApp={(next) => choose({ app: next })}
            live={{ at: summary?.at, pending: summary?.pending ?? true, onRefresh: refresh }}
            entries={entries}
          />
          <Metrics key={app!.id} summary={counts} at={summary?.current ? summary.at : undefined} />
          <Stack className="page-tabs">
            <div className="page-tabstrip" role="tablist" aria-label={say('sections')}>
              {views.map((name, index) => {
                const attention = counts ? needing(name, counts) : 0;
                return (
                  <button
                    key={name}
                    type="button"
                    className="page-tab"
                    role="tab"
                    id={`${tabId}-${name}`}
                    aria-controls={`${tabId}-panel`}
                    aria-selected={chosen === name}
                    tabIndex={chosen === name ? 0 : -1}
                    ref={(node) => {
                      tabs.current[index] = node;
                    }}
                    onClick={() => choose({ section: name })}
                    onKeyDown={(event) => {
                      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                      const next = step
                        ? (index + step + views.length) % views.length
                        : event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? views.length - 1
                            : -1;
                      if (next < 0) return;
                      event.preventDefault();
                      choose({ section: views[next] });
                      tabs.current[next]?.focus();
                    }}
                  >
                    {VIEW_WORD[name]()}
                    {attention > 0 && (
                      <span className="console-badge" aria-label={say('needsAttention', { count: attention })}>
                        {attention}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="page-tabpanel" role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${chosen}`} ref={panel}>
              {chosen === 'work' ? (
                <WorkStream
                  key={app!.id}
                  request={request}
                  base={`/operations/${app!.id}`}
                  jobs={app!.sections.includes('jobs')}
                  destinations={app!.sections.includes('deliveries') ? (app!.destinations ?? []) : []}
                  source={destination}
                  facet={asFacet(state)}
                  item={item}
                  choose={choose}
                  tick={tick}
                  summary={counts}
                  publish={setEntries}
                />
              ) : chosen === 'workflows' ? (
                <Workflows
                  key={app!.id}
                  request={request}
                  base={`/operations/${app!.id}/workflows`}
                  facet={asFacet(state)}
                  item={item}
                  choose={choose}
                  tick={tick}
                  summary={counts?.workflows}
                  publish={setEntries}
                />
              ) : (
                <Stores key={app!.id} request={request} path={`/operations/${app!.id}/stores`} tick={tick} publish={setEntries} />
              )}
            </div>
          </Stack>
        </>
      )}
    </Stack>
  );
}

/** What a view's tab counts: the rows that need someone. */
function needing(view: View, summary: Summary): number {
  if (view === 'work')
    return (
      (summary.jobs ? summary.jobs.dead + summary.jobs.retrying : 0) +
      (summary.deliveries ? summary.deliveries.dead + summary.deliveries.retrying : 0)
    );
  if (view === 'workflows') return summary.workflows?.failed ?? 0;
  return summary.stores ? summary.stores.behind + summary.stores.refused : 0;
}

interface Figures {
  attention: number;
  dead: number;
  retrying: number;
  flight: number;
}
function figuresOf(summary: Summary): Figures {
  const { jobs, deliveries, workflows, stores } = summary;
  const dead = (jobs?.dead ?? 0) + (deliveries?.dead ?? 0) + (workflows?.failed ?? 0),
    retrying = (jobs?.retrying ?? 0) + (deliveries?.retrying ?? 0);
  return {
    attention: dead + retrying + (stores ? stores.behind + stores.refused : 0),
    dead,
    retrying,
    flight: (jobs?.scheduled ?? 0) + (deliveries?.scheduled ?? 0) + (workflows?.running ?? 0),
  };
}

/**
 * The room's four figures, each with the trend of this visit's readings: the
 * summary is a count of now, not a history, so the line is what the room has
 * seen since it opened, and it appears from the fourth reading.
 */
function Metrics({ summary, at }: { summary: Summary | undefined; at: number | undefined }) {
  useMessageLanguage();
  const [trail, setTrail] = useState<readonly Figures[]>([]);
  useEffect(() => {
    if (summary) setTrail((previous) => [...previous, figuresOf(summary)].slice(-24));
  }, [at]); // eslint-disable-line react-hooks/exhaustive-deps
  const now = summary ? figuresOf(summary) : undefined;
  const capped = !!(summary?.jobs?.capped || summary?.deliveries?.capped || summary?.workflows?.capped);
  const figure = (count: number | undefined) =>
    count === undefined ? <span className="console-faint">—</span> : capped && count >= 50 ? say('atLeast', { count }) : count;
  const trend = (name: keyof Figures) => trail.map((point) => point[name]);
  // Where the attention is, by view, the most pressing first; nothing at all is said as such.
  const where = summary
    ? [
        [(summary.jobs?.dead ?? 0) + (summary.jobs?.retrying ?? 0), (count: number) => say('inJobs', { count })],
        [(summary.deliveries?.dead ?? 0) + (summary.deliveries?.retrying ?? 0), (count: number) => say('inDeliveries', { count })],
        [summary.workflows?.failed ?? 0, (count: number) => say('inWorkflows', { count })],
        [summary.stores ? summary.stores.behind + summary.stores.refused : 0, (count: number) => say('inStores', { count })],
      ]
        .filter(([count]) => (count as number) > 0)
        .map(([count, word]) => (word as (count: number) => string)(count as number))
    : [];
  return (
    <section className="console-metrics" aria-label={say('health')}>
      <Stat
        label={say('mAttention')}
        value={figure(now?.attention)}
        trend={trend('attention')}
        change={now && { text: where.length ? where.join(' · ') : say('allClear'), ...(now.attention ? {} : { tone: 'good' as const }) }}
      />
      <Stat label={say('mDead')} value={figure(now?.dead)} trend={trend('dead')} />
      <Stat label={say('mRetrying')} value={figure(now?.retrying)} trend={trend('retrying')} />
      <Stat label={say('mFlight')} value={figure(now?.flight)} trend={trend('flight')} />
    </section>
  );
}

/** The facets as one segmented row, needs-attention first: what needs someone, what waits its turn, what is done, and all of it. */
function Facets({
  facet,
  choose,
  running = false,
  counts,
}: {
  facet: Facet;
  choose(next: Choice): void;
  running?: boolean;
  counts?: { attention: number; scheduled: number };
}) {
  useMessageLanguage();
  const compact = useSectionSize().compact;
  const options: Array<{ value: Facet; label: string; count?: number }> = [
    { value: 'attention', label: say('groupAttention'), ...(counts ? { count: counts.attention } : {}) },
    { value: 'scheduled', label: running ? say('groupRunning') : say('groupScheduled'), ...(counts ? { count: counts.scheduled } : {}) },
    { value: 'done', label: say('groupDone') },
    { value: 'all', label: say('groupAll') },
  ];
  const pick = (value: Facet) => choose({ state: value === 'attention' ? undefined : value });
  // A phone has no width for four segments beside a source: the same choice, as one menu.
  return compact ? (
    <div className="console-switcher">
      <Dropdown
        ariaLabel={say('show')}
        value={facet}
        onChange={(value) => pick(value as Facet)}
        items={options.map((option) => ({
          value: option.value,
          label: option.label,
          ...(option.count === undefined ? {} : { detail: String(option.count) }),
        }))}
      />
    </div>
  ) : (
    <Segmented label={say('show')} size="compact" value={facet} onChange={pick} options={options} />
  );
}

function StateTone({ state }: { state: string }) {
  return <Tone tone={STATE_TONE[state] ?? 'neutral'}>{STATE_WORD[state]?.() ?? state}</Tone>;
}
/** An outcome in words, its code beside them in the code face. */
function Outcome({ code }: { code: string | null }) {
  if (code === null) return <span className="console-faint">—</span>;
  return (
    <span className="console-outcome">
      <span>{CODE_WORD[code]?.() ?? code}</span> <code className="console-code">{code}</code>
    </span>
  );
}

/** Redrive one row or a selection, one after another; what was refused is said with its reason. */
function useRedrive(request: ConsoleRequest, after: () => void) {
  const [busy, setBusy] = useState<string>();
  const [said, setSaid] = useState<{ ok: boolean; text: string }>();
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const redrive = async (rows: ReadonlyArray<Work['redrive']>, mark: string) => {
    setBusy(mark);
    setSaid(undefined);
    let done = 0;
    let refusal: unknown;
    for (const row of rows) {
      try {
        await request(row.path, row.body);
        done++;
      } catch (error) {
        refusal ??= error;
      }
      if (!live.current) return;
    }
    if (!live.current) return;
    setBusy(undefined);
    if (refusal === undefined) setSaid({ ok: true, text: rows.length === 1 ? say('redriven') : say('redrivenSome', { count: done }) });
    else
      setSaid({
        ok: false,
        text: done ? say('redrivenPartly', { done, refused: rows.length - done, reason: refusalText(refusal) }) : refusalText(refusal),
      });
    after();
  };
  return { busy, said, redrive };
}
const Said = ({ said }: { said?: { ok: boolean; text: string } }) =>
  said ? (
    <p className={said.ok ? 'console-said' : 'console-problem'} role={said.ok ? 'status' : 'alert'}>
      {said.text}
    </p>
  ) : null;

/** The selection a bulk redrive acts on: only rows that can be redriven, and only those still listed. */
function useSelection(ids: readonly string[]) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const key = ids.join('\n');
  useEffect(() => {
    setPicked((previous) => new Set([...previous].filter((id) => ids.includes(id))));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    picked,
    toggle: (id: string) =>
      setPicked((previous) => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    all: () => setPicked((previous) => (previous.size === ids.length ? new Set() : new Set(ids))),
    clear: () => setPicked(new Set()),
  };
}

/** The rows and the opened row's drawer: the list full width until a row is opened, then the drawer beside it (a sheet on a phone). */
function Queue({
  title,
  selected,
  onClose,
  detail,
  children,
}: {
  title?: string;
  selected: boolean;
  onClose(): void;
  detail: ReactNode;
  children: ReactNode;
}) {
  useMessageLanguage();
  return (
    <ConsoleSplit
      className="console-split"
      sentenceTitle
      expandList
      selected={selected}
      detailTitle={title}
      listLabel={say('sections')}
      detailLabel={say('details')}
      onCloseDetail={onClose}
      detail={detail}
      list={children}
    />
  );
}

function SelectHead({ selection, count, label }: { selection: ReturnType<typeof useSelection>; count: number; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const some = selection.picked.size > 0 && selection.picked.size < count;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some;
  }, [some]);
  return (
    <th scope="col" className="console-check">
      {count > 0 && (
        <input
          ref={ref}
          type="checkbox"
          aria-label={label}
          checked={count > 0 && selection.picked.size === count}
          onChange={selection.all}
        />
      )}
    </th>
  );
}

function BulkBar({ count, busy, onRedrive, onClear }: { count: number; busy: boolean; onRedrive(): void; onClear(): void }) {
  useMessageLanguage();
  if (!count) return null;
  return (
    <Row gap="tight" className="console-bulk">
      <span className="console-caption">{say('selected', { count })}</span>
      <Button size="compact" intent="primary" busy={busy} onClick={onRedrive}>
        {say('redriveSelected', { count })}
      </Button>
      <Button size="compact" intent="quiet" onClick={onClear}>
        {say('clearSelection')}
      </Button>
    </Row>
  );
}

const kindWord = (entry: Destination) =>
  entry.kind === 'job' ? say('kindJob') : entry.kind === 'workflow' ? say('kindWorkflow') : say('kindWebhook');
/** Where a row came from: a job, or a delivery to its destination. */
const sourceWord = (row: Work) => (row.destination ? say('deliveryTo', { destination: row.destination.name }) : say('aJob'));

/**
 * Several reads asked as one: the stream's sources (the jobs, each
 * destination) are separate routes, read together on the room's clock so
 * the list is merged once. One source that refuses is said; the rest stand.
 */
function useManyRequest(request: ConsoleRequest): ConsoleRequest {
  return useMemo(
    () =>
      (async (joined: string, _body?: unknown, signal?: AbortSignal) => {
        const settled = await Promise.allSettled(joined.split('\n').map((path) => request(path, undefined, signal)));
        const refused = settled.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
        if (refused && settled.every((entry) => entry.status === 'rejected')) throw refused.reason;
        return {
          parts: settled.map((entry) => (entry.status === 'fulfilled' ? entry.value : undefined)),
          ...(refused ? { refused: refusalText(refused.reason) } : {}),
        };
      }) as unknown as ConsoleRequest,
    [request],
  );
}

function WorkStream({
  request,
  base,
  jobs,
  destinations,
  source,
  facet,
  item,
  choose,
  tick,
  summary,
  publish,
}: {
  request: ConsoleRequest;
  base: string;
  jobs: boolean;
  destinations: readonly Destination[];
  /** `jobs`, a destination's id, or every source. */
  source?: string;
  facet: Facet;
  item?: string;
  choose(next: Choice): void;
  tick: number;
  summary?: Summary;
  publish(entries: readonly PaletteEntry[]): void;
}) {
  useMessageLanguage();
  const [revision, setRevision] = useState(0);
  const many = useManyRequest(request);
  const group = groupQuery(facet);
  const reads: Array<{ path: string; destination?: Destination }> = [
    ...(jobs && (!source || source === 'jobs') ? [{ path: `${base}/jobs${group ? `?${group}` : ''}` }] : []),
    ...destinations
      .filter((entry) => !source || source === entry.id)
      .map((entry) => ({
        path: `${base}/deliveries?destination=${encodeURIComponent(entry.id)}${group ? `&${group}` : ''}`,
        destination: entry,
      })),
  ];
  const list = useLiveRead<{ parts: Array<{ jobs?: Job[]; deliveries?: Delivery[] } | undefined>; refused?: string }>(
    many,
    reads.map((read) => read.path).join('\n') || undefined,
    tick * 1_000 + revision,
  );
  const { busy, said, redrive } = useRedrive(request, () => setRevision((value) => value + 1));
  const rows = useMemo(() => {
    const out: Work[] = [];
    // The parts answer the reads in order; a stale answer (another facet's) still draws until the new one lands.
    (list?.data?.parts ?? []).forEach((part, index) => {
      const read = reads[index];
      if (!part || !read) return;
      for (const job of part.jobs ?? [])
        out.push({
          key: `job:${job.id}`,
          name: job.job,
          state: job.state,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          redrives: job.redrives,
          lastCode: job.lastCode,
          next: job.state === 'scheduled' || job.state === 'retry' ? job.runAt : null,
          at: job.updatedAt ?? job.createdAt ?? null,
          createdAt: job.createdAt ?? null,
          redrive: { path: `${base}/jobs/redrive`, body: { id: job.id } },
          attemptsPath: `${base}/jobs/attempts?id=${encodeURIComponent(job.id)}`,
        });
      const destination = read.destination;
      if (destination)
        for (const delivery of part.deliveries ?? [])
          out.push({
            key: `delivery:${destination.id}:${delivery.eventId}`,
            name: delivery.eventId,
            destination,
            state: delivery.state,
            attempts: delivery.attempts,
            maxAttempts: delivery.maxAttempts,
            redrives: delivery.redrives,
            lastCode: delivery.lastCode,
            next: delivery.state === 'pending' || delivery.state === 'retry' ? delivery.nextAt : null,
            at: delivery.nextAt,
            redrive: { path: `${base}/deliveries/redrive`, body: { destination: destination.id, id: delivery.eventId } },
            attemptsPath: `${base}/deliveries/attempts?destination=${encodeURIComponent(destination.id)}&id=${encodeURIComponent(delivery.eventId)}`,
          });
    });
    return out.sort((a, b) => (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9) || (b.at ?? '').localeCompare(a.at ?? ''));
  }, [list?.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const redrivable = rows.filter((row) => REDRIVABLE.has(row.state)).map((row) => row.key);
  const selection = useSelection(redrivable);
  const selected = rows.find((row) => row.key === item);
  const listed = rows.map((row) => row.key).join('\n');
  useEffect(() => {
    publish(
      rows.slice(0, 200).map((row) => ({
        id: `work:${row.key}`,
        group: say('work'),
        label: row.name,
        detail: `${STATE_WORD[row.state]?.() ?? row.state} · ${sourceWord(row)}`,
        run: () => choose({ open: { section: 'work', item: row.key, ...(facet === 'attention' ? {} : { state: facet }) } }),
      })),
    );
  }, [listed, facet]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => publish([]), []); // eslint-disable-line react-hooks/exhaustive-deps
  const sources = (jobs ? 1 : 0) + destinations.length;
  const work = summary && !source ? { jobs: summary.jobs, deliveries: summary.deliveries } : undefined;
  const counts = work && {
    attention:
      (work.jobs ? work.jobs.dead + work.jobs.retrying : 0) + (work.deliveries ? work.deliveries.dead + work.deliveries.retrying : 0),
    scheduled: (work.jobs?.scheduled ?? 0) + (work.deliveries?.scheduled ?? 0),
  };
  const recent = summary?.jobs;
  return (
    <Stack gap="tight">
      <div className="console-filter">
        <Facets facet={facet} choose={choose} counts={counts} />
        {sources > 1 && (
          <div className="console-switcher">
            <Dropdown
              ariaLabel={say('source')}
              value={source ?? ''}
              items={[
                { value: '', label: say('allWork') },
                ...(jobs ? [{ value: 'jobs', label: say('jobs') }] : []),
                ...destinations.map((entry) => ({ value: entry.id, label: `${entry.name} · ${kindWord(entry)}` })),
              ]}
              onChange={(value) => choose({ destination: value || undefined })}
            />
          </div>
        )}
        <BulkBar
          count={selection.picked.size}
          busy={busy === 'bulk'}
          onClear={selection.clear}
          onRedrive={() =>
            void redrive(
              rows.filter((row) => selection.picked.has(row.key)).map((row) => row.redrive),
              'bulk',
            ).then(selection.clear)
          }
        />
      </div>
      <Said said={said} />
      {problem(list)}
      {list?.data?.refused && (
        <p className="console-problem" role="alert">
          {say('partlyRead', { reason: list.data.refused })}
        </p>
      )}
      {!list ? (
        <p role="status" className="console-reading">
          {say('loading')}
        </p>
      ) : !rows.length ? (
        facet === 'attention' ? (
          <Empty
            title={say('nothingAttention')}
            description={
              recent &&
              (recent.capped && recent.recent >= 50
                ? say('ranRecentlyCapped', { count: recent.recent })
                : say('ranRecently', { count: recent.recent }))
            }
          />
        ) : (
          <Empty title={say('noWork')} />
        )
      ) : (
        <Queue
          title={selected?.name}
          selected={!!selected}
          onClose={() => choose({ item: undefined })}
          detail={
            selected && (
              <WorkDetail
                key={selected.key}
                request={request}
                row={selected}
                busy={busy === selected.key}
                onRedrive={() => void redrive([selected.redrive], selected.key)}
                revision={revision}
              />
            )
          }
        >
          <div className="console-scroll">
            <table className="console-table console-work">
              <caption className="console-sr">{say('work')}</caption>
              <thead>
                <tr>
                  <SelectHead selection={selection} count={redrivable.length} label={say('selectAll')} />
                  <th scope="col">{say('what')}</th>
                  <th scope="col">{say('state')}</th>
                  <th scope="col">{say('outcome')}</th>
                  <th scope="col" className="console-num console-wide">
                    {say('tries')}
                  </th>
                  <th scope="col" className="console-wide">
                    {say('when')}
                  </th>
                  <th scope="col" className="console-act">
                    <span className="console-sr">{say('actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="console-work-line" aria-selected={row.key === item}>
                    <td className="console-check">
                      {REDRIVABLE.has(row.state) && (
                        <input
                          type="checkbox"
                          aria-label={say('selectRow', { name: row.name })}
                          checked={selection.picked.has(row.key)}
                          onChange={() => selection.toggle(row.key)}
                        />
                      )}
                    </td>
                    <td className="console-work-what">
                      <button
                        type="button"
                        className={row.destination ? 'console-open console-key' : 'console-open'}
                        data-list-key
                        aria-expanded={row.key === item}
                        onClick={() => choose({ item: row.key === item ? undefined : row.key })}
                      >
                        {row.name}
                      </button>
                      {sources > 1 && !source && <span className="console-work-source">{sourceWord(row)}</span>}
                    </td>
                    <td className="console-work-state">
                      <StateTone state={row.state} />
                    </td>
                    <td className="console-work-outcome">
                      <Outcome code={row.lastCode} />
                    </td>
                    <td className="console-num console-wide">
                      {row.attempts}/{row.maxAttempts}
                    </td>
                    <td className="console-wide">
                      {/* A delivery keeps only its schedule, which says nothing once it has run. */}
                      <When at={row.next ?? (row.destination ? null : row.at)} />
                    </td>
                    <td className="console-act">
                      {REDRIVABLE.has(row.state) && (
                        <Button
                          size="compact"
                          intent="quiet"
                          busy={busy === row.key}
                          aria-label={say('redriveFor', { name: row.name })}
                          onClick={() => void redrive([row.redrive], row.key)}
                        >
                          {say('redrive')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Queue>
      )}
    </Stack>
  );
}

/** A job or a delivery opened: its state and outcome, its facts, Redrive where it can be, every attempt, and where its payload is read. */
function WorkDetail({
  request,
  row,
  busy,
  onRedrive,
  revision,
}: {
  request: ConsoleRequest;
  row: Work;
  busy: boolean;
  onRedrive(): void;
  revision: number;
}) {
  useMessageLanguage();
  return (
    <Stack gap="field" className="console-detail">
      <Row gap="tight" align="baseline">
        <StateTone state={row.state} />
        <Outcome code={row.lastCode} />
      </Row>
      <dl className="console-facts">
        <div>
          <dt>{say('source')}</dt>
          <dd>{row.destination ? `${row.destination.name} · ${kindWord(row.destination)}` : say('aJob')}</dd>
        </div>
        <div>
          <dt>{say('tries')}</dt>
          <dd className="console-num">
            {row.attempts}/{row.maxAttempts}
          </dd>
        </div>
        <div>
          <dt>{say('redrives')}</dt>
          <dd className="console-num">{row.redrives}</dd>
        </div>
        <div>
          <dt>{say('nextRun')}</dt>
          <dd>{row.next ? <When at={row.next} /> : '—'}</dd>
        </div>
        {row.createdAt !== undefined && (
          <div>
            <dt>{say('created')}</dt>
            <dd>
              <When at={row.createdAt} />
            </dd>
          </div>
        )}
      </dl>
      {REDRIVABLE.has(row.state) && (
        <Row>
          <Button intent="primary" busy={busy} onClick={onRedrive}>
            {say('redrive')}
          </Button>
        </Row>
      )}
      <Attempts key={revision} request={request} path={row.attemptsPath} />
      <section aria-label={say('payload')}>
        <h4 className="console-sub">{say('payload')}</h4>
        <p className="console-caption">{say('notCarried')}</p>
      </section>
    </Stack>
  );
}

/** Every attempt, newest last: what it came to in words, its code, when, and who redrove it. */
function Attempts({ request, path }: { request: ConsoleRequest; path: string }) {
  useMessageLanguage();
  const read = useLiveRead<{ attempts: Attempt[] }>(request, path);
  const rows = read?.data?.attempts ?? [];
  return (
    <section className="console-attempts" aria-label={say('attempts')}>
      <h4 className="console-sub">{say('attempts')}</h4>
      {problem(read)}
      {!read ? (
        <p role="status" className="console-reading">
          {say('loading')}
        </p>
      ) : !rows.length ? (
        <p className="console-caption">{say('noAttempts')}</p>
      ) : (
        <ol className="console-timeline">
          {rows.map((row) => (
            <li key={row.attempt}>
              <span className="console-timeline-head">
                <strong>{say('attemptLine', { attempt: row.attempt })}</strong>
                <span>{ATTEMPT_WORD[row.outcome]?.() ?? row.outcome}</span>
                {row.code && <code className="console-code">{row.code}</code>}
              </span>
              <span className="console-caption">
                <When at={row.startedAt} />
                {row.operator ? ` · ${say('byOperator', { operator: row.operator })}` : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * The stores as a health grid: a card per store, its state as a dot and a
 * word, what it holds and its layout. Every store here is one of this App's,
 * so the card leaves the database out; a store that could not be read says why.
 */
function Stores({
  request,
  path,
  tick,
  publish,
}: {
  request: ConsoleRequest;
  path: string;
  tick: number;
  publish(entries: readonly PaletteEntry[]): void;
}) {
  useMessageLanguage();
  const read = useLiveRead<{ stores: StoreRow[] }>(request, path, tick);
  const rows = (read?.data?.stores ?? []).filter((row) => row.id || row.refused);
  const held = rows.filter((row) => row.found !== null || row.refused);
  useEffect(() => publish([]), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Stack gap="tight">
      {problem(read)}
      {!read ? (
        <p role="status" className="console-reading">
          {say('loading')}
        </p>
      ) : !held.length ? (
        <Empty title={say('noStores')} />
      ) : (
        <ul className="console-stores" aria-label={say('stores')}>
          {held.map((row) => {
            const tone: ToneName = row.refused ? 'bad' : row.pending.length ? 'warn' : 'good';
            return (
              <li key={`${row.database}:${row.id}`} className="console-store">
                <span className="console-store-name">
                  <span className="console-dot" data-tone={tone} aria-hidden="true" />
                  <span className="console-key">{row.id || '—'}</span>
                </span>
                {row.title && <span className="console-caption">{row.title}</span>}
                <span className="console-store-state">
                  {row.refused ? (
                    <Tone tone="bad">{say('refusedStore', { reason: row.refused })}</Tone>
                  ) : row.pending.length ? (
                    <Tone tone="warn">
                      {say('pending', { steps: row.pending.map((from) => say('versionStep', { from, to: from + 1 })).join(', ') })}
                    </Tone>
                  ) : (
                    <Tone tone="good">{say('upToDate')}</Tone>
                  )}
                  {row.id && !row.refused && (
                    <span className="console-num console-caption">{say('layoutVersion', { version: row.found ?? row.current })}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="console-caption">{say('storesHint')}</p>
    </Stack>
  );
}

function Workflows({
  request,
  base,
  facet,
  item,
  choose,
  tick,
  summary,
  publish,
}: {
  request: ConsoleRequest;
  base: string;
  facet: Facet;
  item?: string;
  choose(next: Choice): void;
  tick: number;
  summary?: Summary['workflows'];
  publish(entries: readonly PaletteEntry[]): void;
}) {
  useMessageLanguage();
  const [revision, setRevision] = useState(0);
  const group = groupQuery(facet);
  const list = useLiveRead<{ instances: Instance[] }>(request, `${base}${group ? `?${group}` : ''}`, tick * 1_000 + revision);
  const instances = list?.data?.instances ?? [];
  const selected = instances.find((row) => row.id === item);
  const listed = instances.map((row) => row.id).join('\n');
  useEffect(() => {
    publish(
      instances.slice(0, 200).map((row) => ({
        id: `workflow:${row.id}`,
        group: say('workflows'),
        label: `${row.workflow} · ${row.key}`,
        detail: WF_WORD[row.state](),
        run: () => choose({ open: { section: 'workflows', item: row.id, ...(facet === 'attention' ? {} : { state: facet }) } }),
      })),
    );
  }, [listed, facet]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => publish([]), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Stack gap="tight">
      <div className="console-filter">
        <Facets facet={facet} choose={choose} running counts={summary && { attention: summary.failed, scheduled: summary.running }} />
      </div>
      {problem(list)}
      {!list ? (
        <p role="status" className="console-reading">
          {say('loading')}
        </p>
      ) : !instances.length ? (
        <Empty
          title={facet === 'attention' ? say('nothingAttention') : say('noInstances')}
          description={facet === 'attention' ? undefined : say('noInstancesDetail')}
        />
      ) : (
        <Queue
          title={selected ? `${selected.workflow} · ${selected.key}` : undefined}
          selected={!!selected}
          onClose={() => choose({ item: undefined })}
          detail={
            selected && (
              <WorkflowDetail
                key={selected.id}
                request={request}
                base={base}
                instance={selected}
                changed={() => setRevision((value) => value + 1)}
              />
            )
          }
        >
          <div className="console-scroll">
            <table className="console-table console-work">
              <caption className="console-sr">{say('workflows')}</caption>
              <thead>
                <tr>
                  <th scope="col">{say('instance')}</th>
                  <th scope="col">{say('state')}</th>
                  <th scope="col">{say('key')}</th>
                  <th scope="col" className="console-wide">
                    {say('currentStep')}
                  </th>
                  <th scope="col" className="console-wide">
                    {say('wakeAt')}
                  </th>
                  <th scope="col" className="console-wide">
                    {say('updated')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {instances.map((row) => (
                  <tr key={row.id} className="console-work-line" aria-selected={row.id === item}>
                    <td className="console-work-what">
                      <button
                        type="button"
                        className="console-open"
                        data-list-key
                        aria-expanded={row.id === item}
                        onClick={() => choose({ item: row.id === item ? undefined : row.id })}
                      >
                        {row.workflow}
                      </button>
                    </td>
                    <td className="console-work-state">
                      <Tone tone={WF_TONE[row.state]}>{WF_WORD[row.state]()}</Tone>
                    </td>
                    <td className="console-key console-work-outcome">{row.key}</td>
                    <td className="console-wide">{row.currentStep ?? <span className="console-faint">—</span>}</td>
                    <td className="console-wide">
                      <When at={row.wakeAt} />
                    </td>
                    <td className="console-wide">
                      <When at={row.updatedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Queue>
      )}
    </Stack>
  );
}

function WorkflowDetail({
  request,
  base,
  instance,
  changed,
}: {
  request: ConsoleRequest;
  base: string;
  instance: Instance;
  changed(): void;
}) {
  useMessageLanguage();
  const [again, setAgain] = useState(0),
    [asking, setAsking] = useState(false),
    [busy, setBusy] = useState<'cancel' | 'retry'>();
  const [said, setSaid] = useState<{ ok: boolean; text: string }>();
  const read = useLiveRead<{ steps: Step[] }>(request, `${base}/steps?id=${encodeURIComponent(instance.id)}`, again);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const steps = read?.data?.steps ?? [];
  const running = instance.state === 'running' || instance.state === 'waiting',
    retryable = instance.state === 'failed' || instance.state === 'diverged';
  async function act(kind: 'cancel' | 'retry') {
    setBusy(kind);
    setAsking(false);
    try {
      await request(`${base}/${kind}`, { id: instance.id });
      if (live.current) {
        setSaid({ ok: true, text: kind === 'cancel' ? say('cancelled') : running ? say('woken') : say('retried') });
        setAgain((value) => value + 1);
        changed();
      }
    } catch (error) {
      if (live.current) setSaid({ ok: false, text: refusalText(error) });
    } finally {
      if (live.current) setBusy(undefined);
    }
  }
  const stepStatus = (step: Step) =>
    step.status === 'completed' ? (
      <Tone tone="good">{say('stepCompleted')}</Tone>
    ) : step.status === 'pending' ? (
      <Tone tone="neutral">{say('stepPending')}</Tone>
    ) : (
      <Tone tone="bad">{step.status === 'refused' ? say('stepRefused') : say('stepFailed')}</Tone>
    );
  return (
    <Stack className="console-detail">
      <Row gap="tight" align="baseline">
        <Tone tone={WF_TONE[instance.state]}>{WF_WORD[instance.state]()}</Tone>
        <span className="console-caption">
          {say('startedAt', { version: instance.version, when: '' })}
          <When at={instance.createdAt} />
        </span>
      </Row>
      {instance.problem && (
        <p className="console-problem" role="note">
          {instance.problem === 'diverged' ? say('diverged') : say('stopped', { problem: instance.problem })}
          {instance.problemStep ? ` ${say('step')}: ${instance.problemStep}.` : ''}
          {instance.problemError && (
            <>
              {` ${say('thrown')} `}
              <code className="console-code">
                {instance.problemError.name}
                {instance.problemError.code ? ` ${instance.problemError.code}` : ''}
              </code>
            </>
          )}
        </p>
      )}
      {instance.waitEvent && <p className="console-caption">{say('waitingFor', { event: instance.waitEvent })}</p>}
      {(retryable || running) && (
        <Row gap="tight">
          {retryable && (
            <Button intent="primary" busy={busy === 'retry'} busyLabel={say('retrying')} onClick={() => void act('retry')}>
              {say('retry')}
            </Button>
          )}
          {/* Retry of a live instance wakes it where it is: a wake-up lost to a crash is replaced, and the
              store's epoch lets only the newest run take a step, so waking one that was moving does no harm. */}
          {running && !asking && (
            <Button
              intent="secondary"
              title={say('wakeHint')}
              disabled={busy !== undefined}
              busy={busy === 'retry'}
              busyLabel={say('waking')}
              onClick={() => void act('retry')}
            >
              {say('wake')}
            </Button>
          )}
          {running && !asking && (
            <Button intent="secondary" disabled={busy !== undefined} onClick={() => setAsking(true)}>
              {say('cancel')}
            </Button>
          )}
          {running && asking && (
            <>
              <span>{say('askCancel')}</span>
              <Button intent="danger" onClick={() => void act('cancel')}>
                {say('confirmCancel')}
              </Button>
              <Button intent="quiet" onClick={() => setAsking(false)}>
                {say('keep')}
              </Button>
            </>
          )}
        </Row>
      )}
      <Said said={said} />
      <section aria-label={say('steps')}>
        <h4 className="console-sub">{say('steps')}</h4>
        {problem(read)}
        {!read ? (
          <p role="status" className="console-reading">
            {say('loading')}
          </p>
        ) : !steps.length ? (
          <p className="console-caption">{say('noSteps')}</p>
        ) : (
          <ol className="console-timeline">
            {steps.map((step) => (
              <li key={step.name}>
                <span className="console-timeline-head">
                  <strong>
                    {step.ordinal}. {step.name}
                  </strong>
                  {stepStatus(step)}
                  {step.errorCode && <code className="console-code">{step.errorCode}</code>}
                </span>
                <span className="console-caption">
                  {step.kind} · {say('tries')} {step.attempts}
                  {step.wakeAt ? ' · ' : ''}
                  {step.wakeAt && <When at={step.wakeAt} />}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </Stack>
  );
}
