/**
 * Durable Background Run Monitor & Live Trace Viewer for AssistantPanel.tsx.
 * Loaded on demand via `onDemand()` so first-paint CSS/JS budgets stay untouched.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppPayloadApp } from '../../shared/appPayload.js';
import { api } from '@mistriwork/kit/client/core.js';
import { Button } from '@mistriwork/ui/Button.js';
import { Select } from '@mistriwork/ui/Select.js';
import { Switch } from '@mistriwork/ui/Switch.js';
import { AiReasoning } from '@mistriwork/ui/views/AiReasoning.js';
import { CitationPill, CitationsCard, MemoryEventChip } from './AssistantCitations.js';
import { EvalSuitePanel, RunTraceInspector } from './AssistantObservability.js';
import { assistantApi, assistantOwner, executeExternalProposal } from './assistantRequest.js';
import {
  applyEvent,
  grouped,
  inside,
  streamRun,
  waitingProposal,
  wordsOf,
  type Citation,
  type PanelItem,
  type Proposal,
  type Run as TextRun,
} from './assistantStream.js';
import { say } from '../copy/shell/components/AssistantRunMonitor.js';
import './AssistantRunMonitor.css';

type RunStatus = 'queued' | 'running' | 'awaiting' | 'completed' | 'failed' | 'cancelled';

interface BackgroundRunRecord {
  id: string;
  conversation: string;
  title: string;
  prompt: string;
  agent: string;
  source?: string;
  preset?: string;
  status: RunStatus;
  steps: number;
  tokens: number;
  summary: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string;
  live?: boolean;
}

interface RunsListPayload {
  runs: BackgroundRunRecord[];
  ready: boolean;
}

interface AutomationScheduleRecord {
  id: string;
  label: string;
  description?: string;
  every: string;
  timezone: string;
  agent?: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunId: string | null;
  lastRunAt: string | null;
}

interface AutomationTriggerRecord {
  id: string;
  label: string;
  description?: string;
  resource: string;
  on: Array<'create' | 'update'>;
  fields?: string[];
  agent?: string;
  cooldownSeconds: number;
  enabled: boolean;
  lastRunId: string | null;
  lastRunAt: string | null;
}

interface AutomationsPayload {
  schedules: AutomationScheduleRecord[];
  triggers: AutomationTriggerRecord[];
  ready: boolean;
}

interface RunDetailPayload {
  run: BackgroundRunRecord;
  items: PanelItem[];
  awaiting?: boolean;
}

interface AssistantRunMonitorProps {
  app: string;
  config: NonNullable<NonNullable<AppPayloadApp['assistant']>['backgroundRuns']>;
  evals?: NonNullable<AppPayloadApp['assistant']>['evals'];
  externalTools?: NonNullable<AppPayloadApp['assistant']>['externalTools'];
  webhooks?: NonNullable<AppPayloadApp['assistant']>['webhooks'];
  agents: ReadonlyArray<{ id: string; name: string }>;
  reasoning?: 'collapsed' | 'expanded' | 'hidden';
  initialRunId?: string | null;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
  onFollow: (address: string) => void;
  onRunsChanged?: () => void;
}

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return say('today');
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

function statusWord(status: RunStatus): string {
  switch (status) {
    case 'queued':
      return say('status_queued');
    case 'running':
      return say('status_running');
    case 'awaiting':
      return say('status_awaiting');
    case 'completed':
      return say('status_completed');
    case 'failed':
      return say('status_failed');
    case 'cancelled':
      return say('status_cancelled');
  }
}

function turnCitations(items: readonly PanelItem[], textAt: number): readonly Citation[] | undefined {
  let lastPerson = -1;
  for (let i = textAt - 1; i >= 0; i--) {
    if (items[i].type === 'person') {
      lastPerson = i;
      break;
    }
  }
  const found: Citation[] = [];
  for (let i = lastPerson + 1; i < items.length; i++) {
    if (items[i].type === 'person') break;
    const each = items[i];
    if (each.type === 'citations') found.push(...each.items);
  }
  return found.length ? found : undefined;
}

function TraceRuns({
  runs,
  onFollow,
  citations,
  onFocusCitation,
}: {
  runs: TextRun[];
  onFollow: (address: string) => void;
  citations?: readonly Citation[];
  onFocusCitation?: (ref: number) => void;
}) {
  return (
    <>
      {runs.map((run, at) => {
        if ('cite' in run) {
          const match = citations?.find((c) => c.ref === run.cite);
          if (!match) return <span key={at}>{run.text}</span>;
          return <CitationPill key={at} citation={match} onFocusSource={onFocusCitation} onFollow={onFollow} />;
        }
        if ('link' in run) {
          return inside(run.link) ? (
            <a
              key={at}
              href={run.link}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                event.preventDefault();
                onFollow(run.link);
              }}
            >
              {run.text}
            </a>
          ) : (
            <span key={at}>{run.text}</span>
          );
        }
        if (run.mark === 'strong') return <strong key={at}>{run.text}</strong>;
        if (run.mark === 'code') return <code key={at}>{run.text}</code>;
        return <span key={at}>{run.text}</span>;
      })}
    </>
  );
}

function TraceWords({
  text,
  onFollow,
  citations,
  onFocusCitation,
}: {
  text: string;
  onFollow: (address: string) => void;
  citations?: readonly Citation[];
  onFocusCitation?: (ref: number) => void;
}) {
  return (
    <div className="assistant-run-text">
      {wordsOf(text).map((part, at) => {
        if ('table' in part) {
          return (
            <table key={at} className="assistant-table">
              <thead>
                <tr>
                  {part.table.head.map((cell, ci) => (
                    <th key={ci}>
                      <TraceRuns runs={cell} onFollow={onFollow} citations={citations} onFocusCitation={onFocusCitation} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {part.table.rows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci}>
                        <TraceRuns runs={cell} onFollow={onFollow} citations={citations} onFocusCitation={onFocusCitation} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }
        if (part.list) {
          return (
            <ul key={at}>
              {part.lines.map((line, idx) => (
                <li key={idx}>
                  <TraceRuns runs={line} onFollow={onFollow} citations={citations} onFocusCitation={onFocusCitation} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={at}>
            {part.lines.map((line, idx) => (
              <span key={idx}>
                {idx > 0 && <br />}
                <TraceRuns runs={line} onFollow={onFollow} citations={citations} onFocusCitation={onFocusCitation} />
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

export function AssistantRunMonitor({
  app,
  config,
  evals,
  externalTools,
  webhooks,
  agents,
  reasoning,
  initialRunId,
  onClose,
  onOpenConversation,
  onFollow,
  onRunsChanged,
}: AssistantRunMonitorProps) {
  const queryClient = useQueryClient();
  const owner = assistantOwner();
  const listKey = useMemo(() => ['assistant-runs', app, owner] as const, [app, owner]);
  const automationsKey = useMemo(() => ['assistant-automations', app, owner] as const, [app, owner]);
  const automationCount = (config.schedules?.length ?? 0) + (config.triggers?.length ?? 0);
  const evalList = evals ?? [];
  const externalToolList = externalTools ?? [];
  const webhookList = webhooks ?? [];

  const [activeTab, setActiveTab] = useState<'runs' | 'automations' | 'evals'>('runs');
  const [detailMode, setDetailMode] = useState<'conversation' | 'trace'>('conversation');
  const [selectedId, setSelectedId] = useState<string | null>(initialRunId ?? null);
  const [prompt, setPrompt] = useState('');
  const [agentId, setAgentId] = useState<string>(agents[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [liveRun, setLiveRun] = useState<BackgroundRunRecord | null>(null);
  const [traceItems, setTraceItems] = useState<PanelItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [highlightedCitation, setHighlightedCitation] = useState<number | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (initialRunId) setSelectedId(initialRunId);
  }, [initialRunId]);

  const {
    data: listData,
    isLoading: listLoading,
    error: listError,
  } = useQuery({
    queryKey: listKey,
    queryFn: () => assistantApi(`/api/assistant/runs?app=${encodeURIComponent(app)}`) as Promise<RunsListPayload>,
    refetchInterval: (query) => {
      const runs = query.state.data?.runs ?? [];
      return runs.some((r) => r.status === 'running' || r.status === 'queued' || r.live) ? 2500 : false;
    },
  });

  const { data: automationsData } = useQuery({
    queryKey: automationsKey,
    enabled: automationCount > 0,
    queryFn: () => assistantApi(`/api/assistant/automations?app=${encodeURIComponent(app)}`) as Promise<AutomationsPayload>,
  });

  const runs = listData?.runs ?? [];
  const ready = listData?.ready ?? true;
  const activeCount = runs.filter((r) => r.status === 'running' || r.status === 'queued').length;

  const agentNameOf = useCallback(
    (id: string) => {
      if (!id) return '';
      return agents.find((a) => a.id === id)?.name ?? id;
    },
    [agents],
  );

  const refreshRuns = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: listKey });
    if (automationCount > 0) await queryClient.invalidateQueries({ queryKey: automationsKey });
    onRunsChanged?.();
  }, [queryClient, listKey, automationsKey, automationCount, onRunsChanged]);

  const loadDetail = useCallback(
    async (runId: string) => {
      const detail = (await assistantApi(
        `/api/assistant/runs/detail?app=${encodeURIComponent(app)}&id=${encodeURIComponent(runId)}`,
      )) as RunDetailPayload;
      setLiveRun(detail.run);
      setTraceItems(detail.items);
      return detail;
    },
    [app],
  );

  const attachStream = useCallback(
    async (runId: string) => {
      streamAbortRef.current?.abort();
      const ctrl = new AbortController();
      streamAbortRef.current = ctrl;
      setStreaming(true);
      try {
        await streamRun(
          `/api/assistant/runs/stream?app=${encodeURIComponent(app)}&id=${encodeURIComponent(runId)}`,
          (event) => {
            if (event.event === 'run_status' && event.data.run && typeof event.data.run === 'object') {
              setLiveRun(event.data.run as BackgroundRunRecord);
              return;
            }
            if (event.event === 'done') return;
            setTraceItems((prev) => applyEvent(prev, event));
          },
          ctrl.signal,
        );
        if (!ctrl.signal.aborted) {
          await loadDetail(runId);
          await refreshRuns();
        }
      } catch {
        /* Aborted or connection closed: refresh durable state when still mounted. */
      } finally {
        if (streamAbortRef.current === ctrl) {
          setStreaming(false);
        }
      }
    },
    [app, loadDetail, refreshRuns],
  );

  useEffect(() => {
    if (!selectedId) {
      streamAbortRef.current?.abort();
      setLiveRun(null);
      setTraceItems([]);
      setStreaming(false);
      return;
    }
    let cancelled = false;
    setActionError(null);
    void (async () => {
      try {
        const detail = await loadDetail(selectedId);
        if (cancelled) return;
        if (detail.run.live || detail.run.status === 'running' || detail.run.status === 'queued') {
          void attachStream(selectedId);
        }
      } catch (err) {
        if (!cancelled) setActionError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      streamAbortRef.current?.abort();
    };
  }, [selectedId, loadDetail, attachStream]);

  const startRun = async (payload: { prompt?: string; preset?: string }) => {
    setSubmitting(true);
    setActionError(null);
    try {
      const result = (await assistantApi('/api/assistant/runs', {
        app,
        ...payload,
        ...(!payload.preset && agentId && agents.length > 1 ? { agent: agentId } : {}),
      })) as { run: BackgroundRunRecord };
      if (!payload.preset) setPrompt('');
      await refreshRuns();
      setSelectedId(result.run.id);
    } catch (err) {
      setActionError(say('runsActionError', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSubmitting(false);
    }
  };

  const cancelRun = async (runId: string) => {
    setActionError(null);
    try {
      const result = (await assistantApi('/api/assistant/runs/cancel', { app, id: runId })) as { run: BackgroundRunRecord };
      if (selectedId === runId) {
        streamAbortRef.current?.abort();
        setLiveRun(result.run);
        setStreaming(false);
      }
      await refreshRuns();
    } catch (err) {
      setActionError(say('runsActionError', { message: err instanceof Error ? err.message : String(err) }));
    }
  };

  const resumeRun = async (runId: string) => {
    setActionError(null);
    try {
      const result = (await assistantApi('/api/assistant/runs/resume', { app, id: runId })) as { run: BackgroundRunRecord };
      setLiveRun(result.run);
      await refreshRuns();
      void attachStream(runId);
    } catch (err) {
      setActionError(say('runsActionError', { message: err instanceof Error ? err.message : String(err) }));
    }
  };

  const deleteRun = async (runId: string) => {
    setActionError(null);
    try {
      await assistantApi('/api/assistant/runs/delete', { app, id: runId });
      if (selectedId === runId) setSelectedId(null);
      await refreshRuns();
    } catch (err) {
      setActionError(say('runsActionError', { message: err instanceof Error ? err.message : String(err) }));
    }
  };

  const resolveCheckpoint = async (runId: string, proposal: Proposal, decision: 'confirm' | 'decline') => {
    setResolvingId(proposal.id);
    setActionError(null);
    try {
      let outcome: 'done' | 'declined' | 'failed' = decision === 'decline' ? 'declined' : 'done';
      let detail: string | undefined;
      if (decision === 'confirm' && proposal.kind === 'set' && proposal.key) {
        try {
          await api('/api/update', {
            table: proposal.resource,
            key: proposal.key as Record<string, string | number>,
            values: proposal.values as Record<string, string | number | boolean | null>,
          });
        } catch (err) {
          outcome = 'failed';
          detail = err instanceof Error ? err.message : String(err);
        }
      } else if (decision === 'confirm' && proposal.kind === 'external') {
        const res = await executeExternalProposal(app, proposal.action, proposal.values);
        outcome = res.status;
        detail = res.detail;
      }
      const result = (await assistantApi('/api/assistant/runs/resolve', {
        app,
        id: runId,
        proposal: proposal.id,
        outcome,
        ...(detail ? { detail } : {}),
      })) as { run: BackgroundRunRecord };
      setLiveRun(result.run);
      await refreshRuns();
      void attachStream(runId);
    } catch (err) {
      setActionError(say('runsActionError', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setResolvingId(null);
    }
  };

  const toggleAutomation = async (kind: 'schedule' | 'trigger', id: string, enabled: boolean) => {
    const key = `${kind}:${id}`;
    setTogglingKey(key);
    setActionError(null);
    try {
      await assistantApi('/api/assistant/automations/toggle', { app, kind, id, enabled });
      await queryClient.invalidateQueries({ queryKey: automationsKey });
    } catch (err) {
      setActionError(say('runsActionError', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setTogglingKey(null);
    }
  };

  const runScheduleNow = async (scheduleId: string) => {
    setSubmitting(true);
    setActionError(null);
    try {
      const result = (await assistantApi('/api/assistant/automations/run', { app, id: scheduleId })) as {
        run: BackgroundRunRecord;
      };
      await refreshRuns();
      setActiveTab('runs');
      setSelectedId(result.run.id);
    } catch (err) {
      setActionError(say('runsActionError', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSubmitting(false);
    }
  };

  const formatScheduleTime = (iso: string, timeZone?: string): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    try {
      return date.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        ...(timeZone ? { timeZone } : {}),
      });
    } catch {
      return date.toLocaleString();
    }
  };

  const onPromptKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && prompt.trim() && !submitting && ready) {
      event.preventDefault();
      void startRun({ prompt: prompt.trim() });
    }
  };

  const metadataLine = (run: BackgroundRunRecord) => {
    const parts: string[] = [];
    if (run.source?.startsWith('schedule:')) parts.push(say('sourceScheduled'));
    else if (run.source?.startsWith('trigger:')) parts.push(say('sourceTriggered'));
    else if (run.source?.startsWith('webhook:')) parts.push(say('sourceWebhook'));
    const agentLabel = agentNameOf(run.agent);
    if (agentLabel) parts.push(agentLabel);
    if (run.steps > 0) parts.push(run.steps === 1 ? say('stepOne') : say('stepsCount', { count: run.steps }));
    if (run.tokens > 0) parts.push(say('tokensCount', { count: formatTokens(run.tokens) }));
    const when = formatDay(run.updatedAt || run.createdAt);
    if (when) parts.push(when);
    return parts.join(' · ');
  };

  const activeDetail = selectedId ? (liveRun ?? runs.find((r) => r.id === selectedId) ?? null) : null;
  const drawn = useMemo(() => grouped(traceItems), [traceItems]);
  const waiting = useMemo(() => waitingProposal(traceItems), [traceItems]);

  if (selectedId && activeDetail) {
    const isRunning = activeDetail.status === 'running' || activeDetail.status === 'queued';
    const canCancel = isRunning || activeDetail.status === 'awaiting';
    const canResume =
      !streaming &&
      !waiting &&
      (activeDetail.status === 'failed' || activeDetail.status === 'cancelled' || (isRunning && activeDetail.live === false));

    return (
      <section className="assistant-runs" aria-label={activeDetail.title}>
        <header className="assistant-runs-head">
          <div className="assistant-run-detail-head">
            <div className="assistant-run-detail-bar">
              <Button size="xs" variant="ghost" onClick={() => setSelectedId(null)}>
                ← {say('backToRuns')}
              </Button>
              <div className="assistant-run-detail-actions">
                {canCancel && (
                  <Button size="xs" variant="ghost" onClick={() => void cancelRun(activeDetail.id)}>
                    {say('cancel')}
                  </Button>
                )}
                {canResume && (
                  <Button size="xs" variant="secondary" onClick={() => void resumeRun(activeDetail.id)}>
                    {say('resume')}
                  </Button>
                )}
                <Button size="xs" variant="secondary" onClick={() => onOpenConversation(activeDetail.conversation)}>
                  {say('openInChat')}
                </Button>
                <Button size="xs" variant="ghost" ariaLabel={say('closeRuns')} onClick={onClose}>
                  ×
                </Button>
              </div>
            </div>
            <div className="assistant-run-detail-title">
              <span className="assistant-runs-dot" data-status={activeDetail.status} aria-hidden="true" />
              <h3>{activeDetail.title}</h3>
              <span className="assistant-runs-status-label" data-status={activeDetail.status}>
                {statusWord(activeDetail.status)}
              </span>
            </div>
            <span className="assistant-runs-whisper">{metadataLine(activeDetail)}</span>
            <div className="assistant-runs-tabs" role="tablist" aria-label={activeDetail.title}>
              <button
                type="button"
                role="tab"
                className="assistant-runs-tab"
                aria-selected={detailMode === 'conversation'}
                onClick={() => setDetailMode('conversation')}
              >
                {say('detailConversation')}
              </button>
              <button
                type="button"
                role="tab"
                className="assistant-runs-tab"
                aria-selected={detailMode === 'trace'}
                onClick={() => setDetailMode('trace')}
              >
                {say('detailTrace')}
              </button>
            </div>
          </div>
        </header>

        <div className="assistant-runs-body">
          <div className="assistant-runs-body-inner">
            {actionError && (
              <p className="assistant-runs-error" role="alert">
                {actionError}
              </p>
            )}
            <p className="assistant-run-prompt">{activeDetail.prompt}</p>
            {detailMode === 'trace' ? (
              <RunTraceInspector app={app} runId={activeDetail.id} />
            ) : (
              <div className="assistant-run-trace">
                {drawn.map((entry, idx) => {
                  if (entry.type === 'steps') {
                    const count = entry.steps.length;
                    return (
                      <details key={`s${entry.at}`} className="assistant-run-steps">
                        <summary>{count === 1 ? say('stepOneHeading') : say('stepsHeading', { count })}</summary>
                        <ul>
                          {entry.steps.map((step) => (
                            <li key={step.id} className={step.failed ? 'assistant-run-step-failed' : undefined}>
                              {step.label}
                            </li>
                          ))}
                        </ul>
                      </details>
                    );
                  }
                  const { item, at } = entry;
                  if (item.type === 'person') return null;
                  if (item.type === 'reasoning') {
                    if (reasoning === 'hidden') return null;
                    return (
                      <AiReasoning
                        key={`r${item.id}`}
                        text={item.text}
                        redacted={item.redacted}
                        durationMs={item.durationMs}
                        streaming={Boolean(streaming && idx === drawn.length - 1 && item.open)}
                        defaultOpen={reasoning === 'expanded'}
                        words={{
                          thinking: say('thinking'),
                          thought: say('reasoning'),
                          thoughtFor: (duration) => say('thoughtFor', { duration }),
                          redacted: say('reasoningRedacted'),
                          regionLabel: say('reasoningRegion'),
                        }}
                      />
                    );
                  }
                  if (item.type === 'text') {
                    return (
                      <TraceWords
                        key={`t${at}`}
                        text={item.text}
                        onFollow={onFollow}
                        citations={turnCitations(traceItems, at)}
                        onFocusCitation={(ref) => setHighlightedCitation(ref)}
                      />
                    );
                  }
                  if (item.type === 'citations') {
                    return <CitationsCard key={`cit${item.id}`} item={item} highlightedRef={highlightedCitation} onFollow={onFollow} />;
                  }
                  if (item.type === 'memory') {
                    return <MemoryEventChip key={`mem${item.id}`} item={item} />;
                  }
                  if (item.type === 'delegation') {
                    return (
                      <div key={`d${item.id}`} className="assistant-run-delegation">
                        <strong>{say('delegatedTo', { agent: item.agentName })}</strong>
                        <span>{item.summary ?? item.task}</span>
                      </div>
                    );
                  }
                  if (item.type === 'proposal') {
                    const isLiveProposal = !streaming && waiting?.id === item.id;
                    const entries = Object.entries(item.proposal.values);
                    return (
                      <div key={`p${item.id}`} className="assistant-run-checkpoint" data-settled={item.outcome ? 'true' : 'false'}>
                        {isLiveProposal && <p className="assistant-run-checkpoint-notice">{say('awaitingNotice')}</p>}
                        <p className="assistant-run-checkpoint-title">
                          {item.proposal.label}
                          {item.proposal.record ? ` · ${item.proposal.record}` : ''}
                        </p>
                        {item.proposal.why && <p className="assistant-run-checkpoint-why">{item.proposal.why}</p>}
                        {entries.length > 0 && (
                          <dl className="assistant-run-checkpoint-values">
                            {entries.map(([k, v]) => (
                              <div key={k} style={{ display: 'contents' }}>
                                <dt>{k}</dt>
                                <dd>{String(v ?? '')}</dd>
                              </div>
                            ))}
                          </dl>
                        )}
                        {item.outcome ? (
                          <p className="assistant-run-checkpoint-outcome">
                            {item.outcome.status === 'done'
                              ? say('proposalOutcomeDone')
                              : item.outcome.status === 'declined'
                                ? say('proposalOutcomeDeclined')
                                : say('proposalOutcomeFailed')}
                            {item.outcome.detail ? ` — ${item.outcome.detail}` : ''}
                          </p>
                        ) : isLiveProposal ? (
                          <div className="assistant-run-checkpoint-actions">
                            {item.proposal.kind === 'set' || item.proposal.kind === 'external' ? (
                              <Button
                                size="xs"
                                variant="primary"
                                disabled={resolvingId === item.id}
                                onClick={() => void resolveCheckpoint(activeDetail.id, item.proposal, 'confirm')}
                              >
                                {say('confirmAndResume')}
                              </Button>
                            ) : (
                              <Button size="xs" variant="primary" onClick={() => onOpenConversation(activeDetail.conversation)}>
                                {say('openInChat')}
                              </Button>
                            )}
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={resolvingId === item.id}
                              onClick={() => void resolveCheckpoint(activeDetail.id, item.proposal, 'decline')}
                            >
                              {say('declineAndResume')}
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    );
                  }
                  return null;
                })}
                {streaming && (
                  <div className="assistant-run-live-bar" role="status" aria-live="polite">
                    <span className="assistant-runs-dot" data-status="running" aria-hidden="true" />
                    <span>{say('liveStream')}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>
    );
  }

  const presets = config.presets ?? [];
  const schedules =
    automationsData?.schedules ??
    (config.schedules ?? []).map((s) => ({
      ...s,
      timezone: s.timezone ?? 'UTC',
      nextRunAt: null,
      lastRunId: null,
      lastRunAt: null,
    }));
  const triggers =
    automationsData?.triggers ??
    (config.triggers ?? []).map((t) => ({
      ...t,
      lastRunId: null,
      lastRunAt: null,
    }));
  const liveAutomationCount = schedules.length + triggers.length + externalToolList.length + webhookList.length;
  const showTabs = liveAutomationCount > 0 || evalList.length > 0;

  return (
    <section className="assistant-runs" aria-label={say('runsTitle')}>
      <header className="assistant-runs-head">
        <div className="assistant-runs-head-inner">
          <div>
            <div className="assistant-runs-title-row">
              <h3 className="assistant-runs-title">{say('runsTitle')}</h3>
              <span className="assistant-runs-quota">{say('runsActiveQuota', { active: activeCount, max: config.maxConcurrent })}</span>
            </div>
            <p className="assistant-runs-desc">{say('runsDescription')}</p>
          </div>
          <Button size="xs" variant="ghost" ariaLabel={say('closeRuns')} onClick={onClose}>
            ×
          </Button>
        </div>
        {showTabs && (
          <div className="assistant-runs-tabs" role="tablist" aria-label={say('runsTitle')}>
            <button
              type="button"
              role="tab"
              className="assistant-runs-tab"
              aria-selected={activeTab === 'runs'}
              onClick={() => setActiveTab('runs')}
            >
              {say('tabRuns')}
            </button>
            {liveAutomationCount > 0 && (
              <button
                type="button"
                role="tab"
                className="assistant-runs-tab"
                aria-selected={activeTab === 'automations'}
                onClick={() => setActiveTab('automations')}
              >
                {say('tabAutomations', { count: liveAutomationCount })}
              </button>
            )}
            {evalList.length > 0 && (
              <button
                type="button"
                role="tab"
                className="assistant-runs-tab"
                aria-selected={activeTab === 'evals'}
                onClick={() => setActiveTab('evals')}
              >
                {say('tabEvals', { count: evalList.length })}
              </button>
            )}
          </div>
        )}
      </header>

      <div className="assistant-runs-body">
        <div className="assistant-runs-body-inner">
          {!ready && <p className="assistant-runs-empty">{say('noModel')}</p>}
          {(actionError || listError) && (
            <p className="assistant-runs-error" role="alert">
              {actionError ??
                say('runsLoadError', {
                  message: listError instanceof Error ? listError.message : String(listError),
                })}
            </p>
          )}

          {activeTab === 'evals' && evalList.length > 0 ? (
            <EvalSuitePanel app={app} evals={evalList} agents={agents} ready={ready} />
          ) : activeTab === 'automations' && liveAutomationCount > 0 ? (
            <>
              {schedules.length > 0 && (
                <div className="assistant-runs-section">
                  <h4 className="assistant-runs-section-label">{say('schedulesHeading')}</h4>
                  <ul className="assistant-runs-list">
                    {schedules.map((schedule) => {
                      const meta: string[] = [];
                      const agentName = schedule.agent ? agentNameOf(schedule.agent) : '';
                      if (agentName) meta.push(agentName);
                      if (schedule.enabled && schedule.nextRunAt) {
                        meta.push(say('nextRun', { when: formatScheduleTime(schedule.nextRunAt, schedule.timezone) }));
                      } else if (!schedule.enabled) {
                        meta.push(say('paused'));
                      }
                      if (schedule.lastRunAt) meta.push(say('lastRun', { when: formatDay(schedule.lastRunAt) }));
                      return (
                        <li key={schedule.id} className="assistant-auto-row">
                          <div className="assistant-auto-top">
                            <div className="assistant-auto-heading">
                              <span className="assistant-auto-title">{schedule.label}</span>
                              <span className="assistant-auto-pill">
                                {schedule.every} · {schedule.timezone}
                              </span>
                            </div>
                            <div className="assistant-auto-controls">
                              <Switch
                                size="xs"
                                checked={schedule.enabled}
                                loading={togglingKey === `schedule:${schedule.id}`}
                                ariaLabel={say('toggleAutomation', { label: schedule.label })}
                                onCheckedChange={(next) => void toggleAutomation('schedule', schedule.id, next)}
                              />
                            </div>
                          </div>
                          {schedule.description && <p className="assistant-auto-desc">{schedule.description}</p>}
                          <div className="assistant-auto-meta">
                            <span className="assistant-runs-whisper">{meta.join(' · ')}</span>
                            <div className="assistant-runs-actions">
                              {schedule.lastRunId && (
                                <Button size="xs" variant="ghost" onClick={() => setSelectedId(schedule.lastRunId)}>
                                  {say('lastTrace')}
                                </Button>
                              )}
                              <Button
                                size="xs"
                                variant="ghost"
                                disabled={submitting || !ready}
                                onClick={() => void runScheduleNow(schedule.id)}
                              >
                                {say('runNow')}
                              </Button>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {triggers.length > 0 && (
                <div className="assistant-runs-section">
                  <h4 className="assistant-runs-section-label">{say('triggersHeading')}</h4>
                  <ul className="assistant-runs-list">
                    {triggers.map((trigger) => {
                      const meta: string[] = [];
                      const agentName = trigger.agent ? agentNameOf(trigger.agent) : '';
                      if (agentName) meta.push(agentName);
                      if (trigger.fields?.length) meta.push(say('fieldsFilter', { fields: trigger.fields.join(', ') }));
                      if (trigger.cooldownSeconds > 0) meta.push(say('cooldown', { seconds: trigger.cooldownSeconds }));
                      if (!trigger.enabled) meta.push(say('paused'));
                      if (trigger.lastRunAt) meta.push(say('lastRun', { when: formatDay(trigger.lastRunAt) }));
                      return (
                        <li key={trigger.id} className="assistant-auto-row">
                          <div className="assistant-auto-top">
                            <div className="assistant-auto-heading">
                              <span className="assistant-auto-title">{trigger.label}</span>
                              <span className="assistant-auto-pill">
                                {trigger.resource} · {trigger.on.join(' / ')}
                              </span>
                            </div>
                            <div className="assistant-auto-controls">
                              <Switch
                                size="xs"
                                checked={trigger.enabled}
                                loading={togglingKey === `trigger:${trigger.id}`}
                                ariaLabel={say('toggleAutomation', { label: trigger.label })}
                                onCheckedChange={(next) => void toggleAutomation('trigger', trigger.id, next)}
                              />
                            </div>
                          </div>
                          {trigger.description && <p className="assistant-auto-desc">{trigger.description}</p>}
                          <div className="assistant-auto-meta">
                            <span className="assistant-runs-whisper">{meta.join(' · ')}</span>
                            <div className="assistant-runs-actions">
                              {trigger.lastRunId && (
                                <Button size="xs" variant="ghost" onClick={() => setSelectedId(trigger.lastRunId)}>
                                  {say('lastTrace')}
                                </Button>
                              )}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {externalToolList.length > 0 && (
                <div className="assistant-runs-section">
                  <h4 className="assistant-runs-section-label">{say('externalToolsHeading')}</h4>
                  <ul className="assistant-runs-list">
                    {externalToolList.map((tool) => {
                      const protocol =
                        tool.kind === 'mcp'
                          ? say('externalProtocolMcp', { tool: tool.mcpTool ?? tool.id })
                          : say('externalProtocolHttp', { method: tool.method });
                      const modeText = tool.access === 'write' ? say('externalModeWrite') : say('externalModeRead');
                      return (
                        <li key={tool.id} className="assistant-auto-row">
                          <div className="assistant-auto-top">
                            <div className="assistant-auto-heading">
                              <span className="assistant-auto-title">{tool.label}</span>
                              <span className="assistant-auto-pill">{protocol}</span>
                            </div>
                          </div>
                          {tool.description && <p className="assistant-auto-desc">{tool.description}</p>}
                          <div className="assistant-auto-meta">
                            <span className="assistant-runs-whisper">
                              {tool.id} · {modeText}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {webhookList.length > 0 && (
                <div className="assistant-runs-section">
                  <h4 className="assistant-runs-section-label">{say('webhooksHeading')}</h4>
                  <ul className="assistant-runs-list">
                    {webhookList.map((hook) => {
                      const meta: string[] = [say('webhookSignature', { header: hook.signatureHeader })];
                      const agentName = hook.agent ? agentNameOf(hook.agent) : '';
                      if (agentName) meta.push(agentName);
                      meta.push(hook.enabled ? say('webhookEnabled') : say('webhookDisabled'));
                      return (
                        <li key={hook.id} className="assistant-auto-row">
                          <div className="assistant-auto-top">
                            <div className="assistant-auto-heading">
                              <span className="assistant-auto-title">{hook.label}</span>
                              <span className="assistant-auto-pill">{say('webhookEndpoint', { app, id: hook.id })}</span>
                            </div>
                          </div>
                          {hook.description && <p className="assistant-auto-desc">{hook.description}</p>}
                          <div className="assistant-auto-meta">
                            <span className="assistant-runs-whisper">{meta.join(' · ')}</span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <>
              {presets.length > 0 && (
                <div className="assistant-runs-section">
                  <h4 className="assistant-runs-section-label">{say('presetsHeading')}</h4>
                  <div className="assistant-runs-presets">
                    {presets.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        className="assistant-runs-preset"
                        disabled={submitting || !ready}
                        onClick={() => void startRun({ preset: preset.id })}
                      >
                        <span className="assistant-runs-preset-title">{preset.label}</span>
                        {preset.description && <span className="assistant-runs-preset-desc">{preset.description}</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <form
                className="assistant-runs-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!prompt.trim() || submitting || !ready) return;
                  void startRun({ prompt: prompt.trim() });
                }}
              >
                <textarea
                  className="assistant-runs-input"
                  rows={2}
                  value={prompt}
                  disabled={!ready || submitting}
                  placeholder={say('launchPlaceholder')}
                  aria-label={say('launchPlaceholder')}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={onPromptKey}
                />
                <div className="assistant-runs-form-bar">
                  <div className="assistant-runs-form-left">
                    {agents.length > 1 && (
                      <Select<string>
                        size="xs"
                        value={agentId}
                        onValueChange={(next) => {
                          if (next) setAgentId(next);
                        }}
                        options={agents.map((a) => ({ value: a.id, label: a.name }))}
                        ariaLabel={say('agentLabel')}
                      />
                    )}
                  </div>
                  <Button size="xs" variant="primary" type="submit" disabled={!ready || submitting || !prompt.trim()}>
                    {submitting ? say('launching') : say('launchAction')}
                  </Button>
                </div>
              </form>

              {listLoading ? (
                <p className="assistant-runs-empty">{say('runsLoading')}</p>
              ) : runs.length === 0 ? (
                <p className="assistant-runs-empty">{say('runsEmpty')}</p>
              ) : (
                <ul className="assistant-runs-list">
                  {runs.map((run) => {
                    const isActive = run.status === 'running' || run.status === 'queued';
                    return (
                      <li key={run.id} className="assistant-runs-row">
                        <div className="assistant-runs-row-top">
                          <button type="button" className="assistant-runs-open" onClick={() => setSelectedId(run.id)}>
                            <span className="assistant-runs-dot" data-status={run.status} aria-hidden="true" />
                            <span className="assistant-runs-open-title">{run.title}</span>
                          </button>
                          <span className="assistant-runs-status-label" data-status={run.status}>
                            {statusWord(run.status)}
                          </span>
                        </div>
                        <p className="assistant-runs-summary">{run.summary || run.prompt}</p>
                        <div className="assistant-runs-meta">
                          <span className="assistant-runs-whisper">{metadataLine(run)}</span>
                          <div className="assistant-runs-actions">
                            {(isActive || run.status === 'awaiting') && (
                              <Button size="xs" variant="ghost" onClick={() => void cancelRun(run.id)}>
                                {say('cancel')}
                              </Button>
                            )}
                            <Button size="xs" variant="ghost" onClick={() => setSelectedId(run.id)}>
                              {say('inspect')}
                            </Button>
                            <Button size="xs" variant="ghost" onClick={() => onOpenConversation(run.conversation)}>
                              {say('openInChat')}
                            </Button>
                            <Button size="xs" variant="ghost" onClick={() => void deleteRun(run.id)}>
                              {say('delete')}
                            </Button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
