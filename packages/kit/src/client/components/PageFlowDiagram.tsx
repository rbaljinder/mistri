/**
 * A page's diagram section: a flow drawn from its step rows. Each
 * position is a column, left to right in the order a run takes them; the
 * steps that share a position are its lanes, stacked, since they start
 * together; and a branch, which goes on when its condition holds, has a
 * second way for when it does not — to its `goto`, or to the end of the run.
 *
 * On a flow's own page it draws the flow. On the page of a record that runs
 * flows it draws the record's run — its live one, else its newest — over the
 * steps of the flow that run follows: what is done and when, where the run
 * stands, and what it has not reached. A record with no run says so.
 *
 * The steps are read as the reader's rows through the page's own reads, so a
 * step a row policy hides from them is not drawn: the diagram never says more
 * than the steps table would. It draws what the rows say, not whether a run
 * could take them; a row the form refused is the form's to say.
 *
 * It is HTML on a grid, not a picture: a title wraps to two lines in its
 * box, the columns share the section's width, and where a column's share is
 * too narrow for a box (a phone, a narrow panel, a long flow) it turns to run
 * top to bottom — a container query on that share, so nothing is measured,
 * the drawing neither waits a frame nor shifts once painted, and nothing is
 * cut off or scrolls sideways. Being a list, it
 * is its own text alternative: the steps in order, each with its kind, its
 * words and where the run stands at it.
 *
 * The page hands it its reads, its frame and the steps table (PageSections.tsx),
 * as it does the flows section, so this module does not join the page's import cycle.
 */
import type { CSSProperties, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ServedFlowDiagram } from '@mistriwork/engine/shared/servedApp.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { formatDateTime } from '../locale.js';
import { Empty } from './Notes.js';
import { Icon, type IconName } from './Icon.js';
import { say } from '../copy/record/components/PageFlowDiagram.js';
import type { FlowRun, FlowsApi } from './PageFlows.js';
import './PageFlowDiagram.css';

/** The most steps one flow runs (shared/appFlows.ts): a flow with more runs none, so more are never drawn. */
const STEPS_MOST = 100;
/** The columns a step is drawn from, read where the table has them. */
const DRAWN = ['id', 'position', 'kind', 'title', 'goto', 'condition'] as const;

interface DiagramStep {
  id: string;
  position: number;
  kind: string;
  title?: string;
  goto?: number;
  condition?: string;
}

/** Where a run stands at a step: walked, at it now, stopped on it, jumped over by a branch, or not reached. */
type StepState = 'done' | 'current' | 'stopped' | 'skipped' | 'ahead';
interface StepRun {
  state: StepState;
  /** When it was done: the latest moment of its run steps. */
  at?: string;
}

interface DiagramProps {
  base: TableMeta;
  recordKey: Record<string, unknown>;
  /** The binding as the App serves it for this page's table (shared/app.ts); none where it does not run here. */
  diagram: ServedFlowDiagram | undefined;
  /** The binding's steps table, as this reader's catalog has it; none where they cannot read it. */
  steps: TableMeta | undefined;
  api: FlowsApi;
  /** An authoring preview has no flow to read: the section shows its shape. */
  preview?: boolean;
  frame: (body: ReactNode, broken?: string) => ReactNode;
  loading: ReactNode;
}

const whole = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isInteger(n) ? n : undefined;
};
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : undefined;

/** The rows as steps, in the order a run takes them; a row with no position or kind is not a step a run could take. */
export function diagramSteps(rows: readonly Record<string, unknown>[]): DiagramStep[] {
  const steps: DiagramStep[] = [];
  for (const row of rows) {
    const position = whole(row.position);
    const kind = text(row.kind);
    if (position === undefined || kind === undefined) continue;
    const title = text(row.title);
    const goto = whole(row.goto);
    const condition = text(row.condition);
    steps.push({
      id: String(row.id ?? `${position}:${kind}`),
      position,
      kind,
      ...(title ? { title } : {}),
      ...(goto === undefined ? {} : { goto }),
      ...(condition ? { condition } : {}),
    });
  }
  // As flowPlan orders them (shared/appFlows.ts), so a lane holds the place a run's step is named by.
  return steps.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

interface Column {
  position: number;
  /** Its place left to right, from 0. */
  index: number;
  lanes: DiagramStep[];
}
interface Way {
  from: DiagramStep;
  /** The column it leaves from, and the one it lands on: `columns.length` is the end. */
  fromIndex: number;
  toIndex: number;
  to: number | 'end';
  /** Its row under the lanes: each way after the first runs one lower, so two never draw over each other. */
  row: number;
}
interface Layout {
  columns: Column[];
  ways: Way[];
}

/** Where everything goes: a column per position, and a branch's other way to the first column at or past its goto, else the end. */
export function layoutDiagram(steps: readonly DiagramStep[]): Layout {
  const byPosition = new Map<number, DiagramStep[]>();
  for (const step of steps) byPosition.set(step.position, [...(byPosition.get(step.position) ?? []), step]);
  const columns = [...byPosition.entries()].map(([position, lanes], index) => ({ position, index, lanes }));
  const ways = columns
    .flatMap((column) => column.lanes.filter((step) => step.kind === 'branch').map((step) => ({ step, column })))
    .map(({ step, column }, row): Way => {
      const goto = step.goto;
      const target = goto === undefined ? undefined : columns.find((each) => each.position >= goto);
      return {
        from: step,
        fromIndex: column.index,
        toIndex: target ? target.index : columns.length,
        to: target ? target.position : 'end',
        row,
      };
    });
  return { columns, ways };
}

/* A run step's name places it (server/recordFlows.ts): its position, and its lane where several share one. */
const laneOf = (step: DiagramStep, columns: readonly Column[]) =>
  columns.find((column) => column.position === step.position)!.lanes.indexOf(step) + 1;

/**
 * Where the run stands at each step. The furthest position it has touched is
 * where a live run is; a stopped run stopped there. Before it, a step it took
 * is done and one it did not was jumped over by a branch; past it, nothing is
 * reached — unless the run completed, when nothing more ever will be.
 */
export function runStates(steps: readonly DiagramStep[], run: FlowRun): Map<string, StepRun> {
  const { columns } = layoutDiagram(steps);
  const placed = run.steps.filter((step) => typeof step.position === 'number');
  const furthest = placed.length ? Math.max(...placed.map((step) => step.position!)) : undefined;
  const live = run.state === 'running' || run.state === 'waiting';
  const states = new Map<string, StepRun>();
  for (const step of steps) {
    const lane = laneOf(step, columns);
    const own = placed.filter((each) => each.position === step.position && (each.member ?? 1) === lane);
    const at = own
      .map((each) => each.at)
      .sort()
      .at(-1);
    const finished = own.length > 0 && own.every((each) => each.status === 'completed');
    let state: StepState;
    if (own.some((each) => each.status === 'failed' || each.status === 'refused')) state = 'stopped';
    else if (furthest === undefined) state = live && step.position === columns[0]?.position ? 'current' : 'ahead';
    else if (step.position < furthest) state = own.length ? 'done' : 'skipped';
    else if (step.position > furthest) state = run.state === 'completed' ? 'skipped' : 'ahead';
    else if (live) {
      // Lanes that start together: one already done while another is still out is done.
      const others = placed.filter((each) => each.position === furthest && (each.member ?? 1) !== lane);
      state = finished && others.some((each) => each.status === 'pending') ? 'done' : 'current';
    } else if (run.state === 'completed') state = own.length ? 'done' : 'skipped';
    else state = finished ? 'done' : own.length ? 'stopped' : 'ahead';
    states.set(step.id, state === 'done' && at ? { state, at } : { state });
  }
  return states;
}

/** The record's run the diagram draws: its live one, else its newest. */
const runToDraw = (runs: readonly FlowRun[]) => runs.find((run) => run.state === 'running' || run.state === 'waiting') ?? runs[0];

/** The flow's steps, drawn: on a record's page, over its run. */
export function FlowDiagram({ base, recordKey, diagram, steps, api, preview, frame, loading }: DiagramProps) {
  const onRecord = diagram?.run === true;
  const runs = useQuery({
    queryKey: ['page-flows', base.id, recordKey],
    queryFn: async () => (await api('/api/record-flows', { table: base.id, key: recordKey })) as { runs?: FlowRun[] },
    enabled: !preview && onRecord,
    staleTime: 0,
  });
  const run = onRecord ? runToDraw(runs.data?.runs ?? []) : undefined;
  const flow = onRecord ? run?.flow : recordKey.id;
  const readable = !preview && steps !== undefined && flow !== undefined && flow !== null;
  const rows = useQuery({
    queryKey: ['page-flow-diagram', base.id, steps?.id, flow],
    enabled: readable,
    queryFn: async () => {
      const columns = DRAWN.filter((name) => steps!.columns.some((column) => column.name === name));
      const data = (await api('/api/query', {
        table: steps!.id,
        columns,
        filter: { groups: [[{ column: 'flow_id', op: '=', value: flow }]] },
        limit: STEPS_MOST,
        offset: 0,
      })) as { rows?: Record<string, unknown>[] };
      return data.rows ?? [];
    },
  });
  if (preview) return frame(<Empty text={say('stepsOfThisFlow')} />);
  if (onRecord) {
    if (runs.isPending) return loading;
    if (runs.isError) return frame(null, (runs.error as Error).message);
    if (!run) return frame(<Empty text={say('noRun')} />);
  }
  if (!readable) return frame(<Empty text={say('noSteps')} />);
  if (rows.isPending) return loading;
  if (rows.isError) return frame(null, (rows.error as Error).message);
  const drawn = diagramSteps(rows.data);
  if (!drawn.length) return frame(<Empty text={say('noSteps')} />);
  return frame(<Diagram steps={drawn} kinds={diagram?.kinds} run={run} />);
}

const RUN_STATE: Record<string, () => string> = {
  running: () => say('runRunning'),
  waiting: () => say('runWaiting'),
  completed: () => say('runCompleted'),
  failed: () => say('runFailed'),
  cancelled: () => say('runCancelled'),
  diverged: () => say('runDiverged'),
};
/** A run's state as its dot says it: done is good news, a live one is under way, a stopped one is bad news. */
const RUN_TONE: Record<string, string> = {
  completed: 'good',
  running: 'info',
  waiting: 'info',
  failed: 'bad',
  diverged: 'bad',
  cancelled: 'neutral',
};

const moment = (iso: string) => {
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? iso : formatDateTime(when, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

/** A step's moment in the room a box has: its time today, its day before that; the whole moment is its tooltip. */
const briefly = (iso: string) => {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  return when.toDateString() === new Date().toDateString()
    ? formatDateTime(when, { hour: 'numeric', minute: '2-digit' })
    : formatDateTime(when, { month: 'short', day: 'numeric' });
};

function Diagram({ steps, kinds, run }: { steps: DiagramStep[]; kinds: ServedFlowDiagram['kinds']; run: FlowRun | undefined }) {
  const { columns, ways } = layoutDiagram(steps);
  const states = run ? runStates(steps, run) : undefined;
  const stateOf = (step: DiagramStep) => states?.get(step.id)?.state;
  // A column the run has reached: the way into it is drawn in the ink, as the workflow strip's is (docs/design.md).
  const reached = (column: Column) => column.lanes.some((step) => ['done', 'current', 'stopped'].includes(stateOf(step) ?? ''));
  const ended = run?.state === 'completed';
  // Each column's way down, out of a branch or into its goto: both meet the ways' rows under the lanes.
  const legs = new Map<number, { out?: true; in?: true }>();
  for (const way of ways) {
    legs.set(way.fromIndex, { ...legs.get(way.fromIndex), out: true });
    legs.set(way.toIndex, { ...legs.get(way.toIndex), in: true });
  }
  const most = Math.max(...columns.map((column) => column.lanes.length));
  /* Every box is as tall as the fullest needs — a branch's test under its title, a run's word under that — so the
     boxes of a row line up on the one line the way runs along, and the height is known before anything is drawn. */
  const lines = (steps.some((step) => step.kind === 'branch' && step.title && step.condition) ? 1 : 0) + (run ? 1 : 0);
  const style = { '--flow-n': columns.length, '--flow-most': most, '--flow-lines': lines, '--flow-ways': ways.length } as CSSProperties;
  return (
    <div className="flow-diagram" data-run={run ? run.state : undefined} style={style}>
      {run && (
        <p className="flow-diagram-run">
          <span className="flow-diagram-run-name">{run.name}</span>
          <span className={`tone tone-${RUN_TONE[run.state] ?? 'neutral'}`}>{RUN_STATE[run.state]?.() ?? run.state}</span>
          <time className="flow-diagram-run-when" dateTime={run.startedAt}>
            {say('runStarted', { when: moment(run.startedAt) })}
          </time>
        </p>
      )}
      <div className="flow-diagram-fit">
        <div className="flow-diagram-body">
          <ol className="flow-diagram-flow" aria-label={say('diagram')}>
            {columns.map((column) => {
              const together = column.lanes.length > 1;
              const leg = legs.get(column.index);
              return (
                <li
                  key={column.position}
                  className="flow-diagram-position"
                  data-position={column.position}
                  data-reached={reached(column) ? '' : undefined}
                  data-together={together ? '' : undefined}
                  style={{ '--flow-lanes': column.lanes.length, gridColumn: `${column.index * 3 + 1} / span 2` } as CSSProperties}
                >
                  <span className="flow-diagram-number">{say('position', { position: column.position })}</span>
                  <ul className="flow-diagram-lanes" aria-label={together ? say('together', { count: column.lanes.length }) : undefined}>
                    {column.lanes.map((step) => (
                      <StepBox
                        key={step.id}
                        step={step}
                        kinds={kinds}
                        run={states?.get(step.id)}
                        waiting={run?.state === 'waiting'}
                        way={ways.find((way) => way.from === step)}
                      />
                    ))}
                  </ul>
                  {leg && <span className="flow-diagram-leg" aria-hidden="true" data-in={leg.in ? '' : undefined} />}
                </li>
              );
            })}
            <li
              className="flow-diagram-position flow-diagram-end"
              data-position="end"
              data-reached={ended ? '' : undefined}
              style={{ '--flow-lanes': 1, gridColumn: `${columns.length * 3 + 1} / span 2` } as CSSProperties}
            >
              <span className="flow-diagram-number">{say('end')}</span>
              <span className="flow-diagram-end-mark" aria-hidden="true" />
              {legs.get(columns.length) && <span className="flow-diagram-leg" aria-hidden="true" data-in="" />}
            </li>
          </ol>
          {ways.length > 0 && (
            <div className="flow-diagram-ways" aria-hidden="true">
              {ways.map((way) => {
                const [left, right] = [way.fromIndex, way.toIndex].sort((a, b) => a - b);
                // Taken where the run went its other way: every step between was jumped over.
                const between = steps.filter((step) => step.position > way.from.position && (way.to === 'end' || step.position < way.to));
                const taken =
                  Boolean(states) &&
                  stateOf(way.from) === 'done' &&
                  between.length > 0 &&
                  between.every((step) => stateOf(step) === 'skipped');
                return (
                  <span
                    key={way.from.id}
                    className="flow-diagram-way"
                    data-branch={way.from.position}
                    data-to={way.to}
                    data-taken={taken ? '' : undefined}
                    data-back={way.toIndex < way.fromIndex ? '' : undefined}
                    style={{ gridColumn: `${left * 3 + 2} / ${right * 3 + 2}`, '--flow-way-row': way.row } as CSSProperties}
                  >
                    <span className="flow-diagram-way-label">{say('otherwise')}</span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A step kind in words: the platform's own by name, an App's as its name reads ("sendOrder" is "Send order"). */
function kindWord(kind: string): string {
  switch (kind) {
    case 'branch':
      return say('kindBranch');
    case 'wait':
      return say('kindWait');
    case 'until':
      return say('kindUntil');
    case 'waitFor':
      return say('kindWaitFor');
    case 'set':
      return say('kindSet');
    case 'notify':
      return say('kindNotify');
    default: {
      const words = kind
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .toLowerCase();
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
  }
}

/* A quiet mark per kind, from the App icon set: a person's word for a kind that waits for one (an approval), a
   spark for one that only runs a command, a branch drawn as the decision diamond flow charts have always used. */
const KIND_ICON: Record<string, IconName> = {
  wait: 'hourglass',
  until: 'calendar',
  waitFor: 'bell',
  set: 'pencil-simple',
  notify: 'envelope',
};
const iconOf = (kind: string, kinds: ServedFlowDiagram['kinds']): IconName =>
  KIND_ICON[kind] ?? (kinds?.[kind] === 'asks' ? 'user-circle' : kinds?.[kind] === 'runs' ? 'lightning' : 'circle-dashed');

function stateWords(run: StepRun, waiting: boolean): string {
  switch (run.state) {
    case 'done':
      return say('stateDone');
    case 'current':
      return waiting ? say('stateWaiting') : say('stateRunning');
    case 'stopped':
      return say('stateStopped');
    case 'skipped':
      return say('stateSkipped');
    default:
      return say('stateAhead');
  }
}
const STATE_TONE: Partial<Record<StepState, string>> = { done: 'good', current: 'info', stopped: 'bad' };

function StepBox({
  step,
  kinds,
  run,
  waiting,
  way,
}: {
  step: DiagramStep;
  kinds: ServedFlowDiagram['kinds'];
  run: StepRun | undefined;
  /** The run waits (for a word, a date, a time) rather than working. */
  waiting: boolean;
  way: Way | undefined;
}) {
  const branch = step.kind === 'branch';
  const kind = kindWord(step.kind);
  const name = step.title ?? (branch && step.condition ? say('ifHolds', { condition: step.condition }) : kind);
  // A branch says what it tests under its title; any other step says its kind above it.
  const under = branch && step.title && step.condition ? say('ifHolds', { condition: step.condition }) : undefined;
  const tone = run && STATE_TONE[run.state];
  const otherwise = way && say('ifNot', { to: way.to === 'end' ? say('toEnd') : say('toStep', { position: way.to }) });
  return (
    <li
      className="flow-diagram-step"
      data-step={step.id}
      data-kind={step.kind}
      data-state={run?.state}
      title={[name, under, otherwise].filter(Boolean).join('\n')}
    >
      <span className="flow-diagram-kind">
        {branch ? <span className="flow-diagram-diamond" aria-hidden="true" /> : <Icon name={iconOf(step.kind, kinds)} size={14} />}
        <span className="flow-diagram-kind-word">{kind}</span>
      </span>
      <span className="flow-diagram-name">{name}</span>
      {under && <span className="flow-diagram-test">{under}</span>}
      {run && (
        <span className="flow-diagram-state">
          {tone ? <span className={`tone tone-${tone}`}>{stateWords(run, waiting)}</span> : stateWords(run, waiting)}
          {/* When it was done beside its word, which never gives way to it: a narrow box shortens the time, not the word. */}
          {run.at && (
            <>
              {' '}
              <time className="flow-diagram-when" dateTime={run.at} title={moment(run.at)}>
                {briefly(run.at)}
              </time>
            </>
          )}
        </span>
      )}
      {otherwise && <span className="flow-diagram-otherwise">{otherwise}</span>}
    </li>
  );
}
