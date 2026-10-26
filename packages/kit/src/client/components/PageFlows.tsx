/**
 * A page's flows section: the record's row-driven flow runs,
 * newest first — each run's state, what it waits for, the problem a failed
 * one stopped on, and its steps — and a button for each manual flow this
 * reader may start. The server answers for this reader (server/recordFlows.ts):
 * a record they cannot read has no runs for them, and a flow or step they
 * cannot read is named by its number. This module only says what it was handed.
 *
 * `running: false` says the server has no `--jobs` host: the runs below
 * would never move, so the section says how to get one rather than an
 * empty list that reads as "nothing happened".
 *
 * The page hands it its reads and its frame (PageSections.tsx), as it does
 * the history, so this module does not join the page's import cycle.
 */
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime } from '../locale.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { Empty } from './Notes.js';
import { DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
import { say } from '../copy/record/components/PageFlows.js';
import './PageFlows.css';

export interface FlowRunStep {
  label: string;
  status: string;
  at: string;
  /** Where it stands in its flow, where its name says: the position, and its lane where several share one. */
  position?: number;
  member?: number;
}
export interface FlowRun {
  id: string;
  flow: string;
  name: string;
  state: string;
  waitingFor: string | null;
  wakeAt: string | null;
  problem: string | null;
  startedAt: string;
  updatedAt: string;
  steps: FlowRunStep[];
}
interface FlowsReply {
  running: boolean;
  runs: FlowRun[];
  manual: Array<{ id: string; name: string }>;
}
/** A request through the page's connection, as `usePageApi` makes one. */
export type FlowsApi = (path: string, body: Record<string, unknown>) => Promise<unknown>;
interface FlowsProps {
  base: TableMeta;
  recordKey: Record<string, unknown>;
  api: FlowsApi;
  /** An authoring preview has no record to read: the section shows its shape. */
  preview?: boolean;
  /** The section's frame: its heading around `body`, or its heading and a problem where the read failed. */
  frame: (body: ReactNode, broken?: string) => ReactNode;
  /** What stands in the section while the first read is out. */
  loading: ReactNode;
}

/** A run's state in a word; a state this build does not know is said as the server named it. */
function sayState(state: string): string {
  switch (state) {
    case 'running':
      return say('running');
    case 'waiting':
      return say('waiting');
    case 'completed':
      return say('completed');
    case 'failed':
      return say('failed');
    case 'cancelled':
      return say('cancelled');
    case 'diverged':
      return say('diverged');
    default:
      return state.charAt(0).toUpperCase() + state.slice(1);
  }
}

const sayStatus = (status: string): string => (status === 'completed' ? say('stepDone') : status);

function moment(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? iso : formatDateTime(when);
}

/** The record's flow runs, with a Start for each manual flow the reader may begin. */
export function RecordFlows({ base, recordKey, api, preview, frame, loading }: FlowsProps) {
  const client = useQueryClient();
  const queryKey = ['page-flows', base.id, recordKey];
  const flows = useQuery({
    queryKey,
    queryFn: async () => (await api('/api/record-flows', { table: base.id, key: recordKey })) as FlowsReply,
    enabled: !preview,
    staleTime: 0,
  });
  const [refusal, setRefusal] = useState<string | undefined>();
  const start = useMutation({
    mutationFn: async (flow: { id: string; name: string }) => {
      setRefusal(undefined);
      try {
        await api('/api/record-flows/start', { table: base.id, key: recordKey, flow: flow.id });
      } catch (error) {
        setRefusal(say('couldNotStart', { name: flow.name, reason: (error as Error).message }));
        throw error;
      }
    },
    // The run appears a moment after the start: ask again once it is accepted.
    onSuccess: () => client.invalidateQueries({ queryKey }),
  });
  if (preview) return frame(<Empty text={say('flowsOnThisRecord')} />);
  if (flows.isPending) return loading;
  if (flows.isError) return frame(null, (flows.error as Error).message);
  const { running, runs, manual } = flows.data;
  const pending = start.isPending ? start.variables?.id : undefined;
  return frame(
    <div className="flows">
      {!running && <p className="flows-note">{say('notRunning')}</p>}
      {running && !runs.length && <p className="flows-note">{say('noRuns')}</p>}
      {runs.length > 0 && (
        <ol className="flows-runs">
          {runs.map((run, i) => (
            <FlowRunItem key={run.id} run={run} open={i === 0} />
          ))}
        </ol>
      )}
      {manual.length > 0 && (
        <div className="flows-start">
          {manual.length > 2 ? (
            <DropMenu
              className="page-actions-menu"
              triggerClassName="ghost page-action"
              label={start.isPending ? say('starting') : say('startAFlow')}
              popupClassName="page-actions-popup"
              align="start"
            >
              {manual.map((flow) => (
                <DropItem key={flow.id} className="page-actions-item" disabled={start.isPending} onClick={() => start.mutate(flow)}>
                  {say('start', { name: flow.name })}
                </DropItem>
              ))}
            </DropMenu>
          ) : (
            manual.map((flow) => (
              <button
                key={flow.id}
                type="button"
                className="ghost page-action"
                disabled={start.isPending}
                onClick={() => start.mutate(flow)}
              >
                {pending === flow.id ? say('starting') : say('start', { name: flow.name })}
              </button>
            ))
          )}
          {refusal && (
            <p className="flows-problem" role="alert">
              {refusal}
            </p>
          )}
        </div>
      )}
    </div>,
  );
}

function FlowRunItem({ run, open }: { run: FlowRun; open: boolean }) {
  const waiting =
    run.state === 'waiting'
      ? run.waitingFor
        ? say('waitingFor', { what: run.waitingFor })
        : run.wakeAt
          ? say('until', { when: moment(run.wakeAt) })
          : null
      : null;
  return (
    <li className="flows-run">
      <details open={open}>
        <summary className="flows-head">
          <span className="flows-name">{run.name}</span>
          <span className={`flows-state flows-state-${run.state}`}>{sayState(run.state)}</span>
          <time className="flows-when" dateTime={run.startedAt} title={run.startedAt}>
            {say('started', { when: moment(run.startedAt) })}
          </time>
        </summary>
        {waiting && <p className="flows-wait">{waiting}</p>}
        {run.problem && (
          <p className="flows-problem" role="alert">
            {run.problem}
          </p>
        )}
        {run.steps.length > 0 && (
          <ol className="flows-steps" aria-label={say('steps')}>
            {run.steps.map((step, i) => (
              <li key={`${step.at}-${i}`} className="flows-step">
                <span className="flows-step-label">{step.label}</span>
                <span className={`flows-step-status flows-step-${step.status}`}>{sayStatus(step.status)}</span>
              </li>
            ))}
          </ol>
        )}
      </details>
    </li>
  );
}
