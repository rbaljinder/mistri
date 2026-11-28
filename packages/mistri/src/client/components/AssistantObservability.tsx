/**
 * Editorial Trace Inspector & Live Eval Scorecard views for AssistantRunMonitor.
 * Loaded strictly inside the on-demand Run Monitor chunk so first-paint budgets stay untouched.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@mistriwork/ui/Button.js';
import type { ServedAssistantEvalCase } from '../../shared/appAssistant.js';
import { assistantApi, assistantOwner } from './assistantRequest.js';
import { say } from '../copy/shell/components/AssistantObservability.js';

interface TraceSpan {
  index: number;
  kind: 'reasoning' | 'tool' | 'block' | 'proposal' | 'delegation' | 'answer';
  name: string;
  status: 'ok' | 'error' | 'awaiting' | 'declined';
  durationMs?: number;
  summary?: string;
  input?: unknown;
  outputPreview?: string;
  citations?: number;
  agent?: string;
}

interface TraceSummary {
  totalSteps: number;
  toolCalls: number;
  failedTools: number;
  blocksEmitted: number;
  citationsCount: number;
  proposalsCount: number;
  reasoningChars: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  model?: string;
  provider?: string;
  durationMs: number;
  toolBreakdown: Record<string, number>;
  spans: TraceSpan[];
}

interface TracePayload {
  trace: TraceSummary;
}

interface EvalCaseReport {
  id: string;
  label: string;
  description?: string;
  agent?: string;
  passed: boolean;
  failures: string[];
  answer: string;
  durationMs: number;
  trace: TraceSummary;
}

interface EvalSuiteReport {
  appId: string;
  ranAt: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  meanTokens: number;
  meanDurationMs: number;
  totalCostUsd?: number;
  cases: EvalCaseReport[];
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

function formatUsd(cost: number): string {
  if (cost <= 0) return '$0.00';
  if (cost < 0.001) return say('costSubCent');
  if (cost < 0.1) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function spanKindWord(kind: TraceSpan['kind']): string {
  switch (kind) {
    case 'reasoning':
      return say('spanReasoning');
    case 'tool':
      return say('spanTool');
    case 'block':
      return say('spanBlock');
    case 'proposal':
      return say('spanProposal');
    case 'delegation':
      return say('spanDelegation');
    case 'answer':
      return say('spanAnswer');
  }
}

function spanStatusWord(status: TraceSpan['status']): string {
  switch (status) {
    case 'ok':
      return say('spanStatusOk');
    case 'error':
      return say('spanStatusError');
    case 'awaiting':
      return say('spanStatusAwaiting');
    case 'declined':
      return say('spanStatusDeclined');
  }
}

function TraceSummaryView({ trace }: { trace: TraceSummary }) {
  return (
    <div className="assistant-trace-panel">
      <dl className="assistant-trace-metrics">
        <div className="assistant-trace-metric">
          <dt>{say('metricSteps')}</dt>
          <dd>{trace.totalSteps}</dd>
        </div>
        <div className="assistant-trace-metric">
          <dt>{say('metricTools')}</dt>
          <dd>{trace.toolCalls}</dd>
        </div>
        <div className="assistant-trace-metric">
          <dt>{say('metricCitations')}</dt>
          <dd>{trace.citationsCount}</dd>
        </div>
        <div className="assistant-trace-metric">
          <dt>{say('metricTokens')}</dt>
          <dd>{formatCompactTokens(trace.totalTokens)}</dd>
        </div>
        <div className="assistant-trace-metric">
          <dt>{say('metricDuration')}</dt>
          <dd>{formatDuration(trace.durationMs)}</dd>
        </div>
        {typeof trace.estimatedCostUsd === 'number' && trace.estimatedCostUsd > 0 && (
          <div className="assistant-trace-metric">
            <dt>{say('metricCost')}</dt>
            <dd>{formatUsd(trace.estimatedCostUsd)}</dd>
          </div>
        )}
        {trace.model && (
          <div className="assistant-trace-metric">
            <dt>{say('metricModel')}</dt>
            <dd>{trace.model}</dd>
          </div>
        )}
      </dl>

      {trace.spans.length === 0 ? (
        <p className="assistant-runs-empty">{say('traceEmpty')}</p>
      ) : (
        <ol className="assistant-trace-timeline">
          {trace.spans.map((span) => (
            <li key={`${span.index}-${span.kind}-${span.name}`} className="assistant-trace-span">
              <div className="assistant-trace-span-top">
                <div className="assistant-trace-span-title">
                  <span
                    className="assistant-runs-dot"
                    data-status={
                      span.status === 'ok'
                        ? 'completed'
                        : span.status === 'error'
                          ? 'failed'
                          : span.status === 'awaiting'
                            ? 'awaiting'
                            : 'cancelled'
                    }
                    aria-hidden="true"
                  />
                  <span className="assistant-auto-pill">{spanKindWord(span.kind)}</span>
                  {span.name !== spanKindWord(span.kind) && <span className="assistant-trace-span-name">{span.name}</span>}
                  {span.citations ? <span className="assistant-auto-pill">{say('citationsBadge', { count: span.citations })}</span> : null}
                </div>
                <div className="assistant-trace-span-meta">
                  {typeof span.durationMs === 'number' && span.durationMs > 0 ? (
                    <span className="assistant-runs-whisper">{formatDuration(span.durationMs)}</span>
                  ) : null}
                  <span className="assistant-trace-status" data-status={span.status}>
                    {spanStatusWord(span.status)}
                  </span>
                </div>
              </div>
              {span.summary && <p className="assistant-trace-span-summary">{span.summary}</p>}
              {(span.input !== undefined || span.outputPreview) && (
                <details className="assistant-trace-io">
                  <summary>{say('spanDetails')}</summary>
                  {span.input !== undefined && (
                    <div className="assistant-trace-io-block">
                      <span className="assistant-trace-io-label">{say('spanInput')}</span>
                      <pre className="assistant-trace-pre">{JSON.stringify(span.input, null, 2)}</pre>
                    </div>
                  )}
                  {span.outputPreview && (
                    <div className="assistant-trace-io-block">
                      <span className="assistant-trace-io-label">{say('spanOutput')}</span>
                      <pre className="assistant-trace-pre">{span.outputPreview}</pre>
                    </div>
                  )}
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Fetches and renders structured observability spans for a persisted background run. */
export function RunTraceInspector({ app, runId }: { app: string; runId: string }) {
  const owner = assistantOwner();
  const { data, isLoading, error } = useQuery<TracePayload>({
    queryKey: ['assistant-run-trace', app, owner, runId],
    queryFn: () =>
      assistantApi(`/api/assistant/runs/trace?app=${encodeURIComponent(app)}&id=${encodeURIComponent(runId)}`) as Promise<TracePayload>,
    staleTime: 3_000,
  });

  if (isLoading) return <p className="assistant-runs-empty">{say('traceLoading')}</p>;
  if (error) {
    return (
      <p className="assistant-runs-error" role="alert">
        {say('traceError', { message: error instanceof Error ? error.message : String(error) })}
      </p>
    );
  }
  if (!data?.trace) return <p className="assistant-runs-empty">{say('traceEmpty')}</p>;
  return <TraceSummaryView trace={data.trace} />;
}

function expectationPills(expect: ServedAssistantEvalCase['expect']): string[] {
  const pills: string[] = [];
  if (expect.expectedTools?.length) pills.push(say('expectTools', { tools: expect.expectedTools.join(', ') }));
  if (expect.forbiddenTools?.length) pills.push(say('expectForbidden', { tools: expect.forbiddenTools.join(', ') }));
  if (expect.expectedBlocks?.length) pills.push(say('expectBlocks', { blocks: expect.expectedBlocks.join(', ') }));
  if (expect.expectCitations) pills.push(say('expectCitations'));
  if (expect.expectReasoning) pills.push(say('expectReasoning'));
  if (expect.maxSteps !== undefined) pills.push(say('expectMaxSteps', { count: expect.maxSteps }));
  if (expect.maxTokens !== undefined) pills.push(say('expectMaxTokens', { count: formatCompactTokens(expect.maxTokens) }));
  if (expect.answerMatches) pills.push(say('expectMatches', { text: expect.answerMatches }));
  return pills;
}

/** Interactive declarative evaluation scorecard runner inside the Run Monitor's Evals tab. */
export function EvalSuitePanel({
  app,
  evals,
  agents,
  ready,
}: {
  app: string;
  evals: readonly ServedAssistantEvalCase[];
  agents: ReadonlyArray<{ id: string; name: string }>;
  ready: boolean;
}) {
  const [runningAll, setRunningAll] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suiteReport, setSuiteReport] = useState<EvalSuiteReport | null>(null);
  const [caseResults, setCaseResults] = useState<Record<string, EvalCaseReport>>({});
  const [expandedTrace, setExpandedTrace] = useState<Record<string, boolean>>({});

  const agentNameOf = (id?: string) => (id ? (agents.find((a) => a.id === id)?.name ?? id) : '');

  const runEval = async (id?: string) => {
    setError(null);
    if (id) setRunningId(id);
    else setRunningAll(true);
    try {
      const payload = (await assistantApi('/api/assistant/evals/run', {
        app,
        ...(id ? { id } : {}),
      })) as { report: EvalSuiteReport };
      const report = payload.report;
      setCaseResults((prev) => {
        const next = { ...prev };
        for (const c of report.cases) next[c.id] = c;
        return next;
      });
      if (!id) {
        setSuiteReport(report);
      } else {
        setSuiteReport((prev) => {
          const merged = { ...caseResults };
          for (const c of report.cases) merged[c.id] = c;
          const all = Object.values(merged);
          const passed = all.filter((c) => c.passed).length;
          return {
            ...(prev ?? report),
            ranAt: report.ranAt,
            total: all.length,
            passed,
            failed: all.length - passed,
            passRate: all.length ? Number((passed / all.length).toFixed(4)) : 0,
            meanTokens: all.length ? Math.round(all.reduce((s, c) => s + c.trace.totalTokens, 0) / all.length) : 0,
            meanDurationMs: all.length ? Math.round(all.reduce((s, c) => s + c.durationMs, 0) / all.length) : 0,
            cases: all,
          };
        });
      }
    } catch (err) {
      setError(say('evalError', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setRunningAll(false);
      setRunningId(null);
    }
  };

  return (
    <div className="assistant-runs-section">
      <div className="assistant-eval-toolbar">
        <p className="assistant-auto-desc">{say('evalsIntro')}</p>
        <Button size="sm" variant="primary" disabled={!ready || runningAll || runningId !== null} onClick={() => void runEval()}>
          {runningAll ? say('runningEvals') : say('runAllEvals')}
        </Button>
      </div>

      {error && (
        <p className="assistant-runs-error" role="alert">
          {error}
        </p>
      )}

      {suiteReport && (
        <dl className="assistant-trace-metrics">
          <div className="assistant-trace-metric">
            <dt>{say('scorePassRate')}</dt>
            <dd data-pass={suiteReport.failed === 0 ? 'true' : 'false'}>{Math.round(suiteReport.passRate * 100)}%</dd>
          </div>
          <div className="assistant-trace-metric">
            <dt>{say('scorePassed')}</dt>
            <dd>
              {suiteReport.passed}/{suiteReport.total}
            </dd>
          </div>
          <div className="assistant-trace-metric">
            <dt>{say('scoreAvgTokens')}</dt>
            <dd>{formatCompactTokens(suiteReport.meanTokens)}</dd>
          </div>
          <div className="assistant-trace-metric">
            <dt>{say('scoreAvgLatency')}</dt>
            <dd>{formatDuration(suiteReport.meanDurationMs)}</dd>
          </div>
          {typeof suiteReport.totalCostUsd === 'number' && suiteReport.totalCostUsd > 0 && (
            <div className="assistant-trace-metric">
              <dt>{say('scoreTotalCost')}</dt>
              <dd>{formatUsd(suiteReport.totalCostUsd)}</dd>
            </div>
          )}
        </dl>
      )}

      <ul className="assistant-runs-list">
        {evals.map((item) => {
          const result = caseResults[item.id];
          const isRunning = runningAll || runningId === item.id;
          const pills = expectationPills(item.expect);
          const showTrace = Boolean(expandedTrace[item.id]);
          const agentName = agentNameOf(item.agent);
          return (
            <li key={item.id} className="assistant-auto-row">
              <div className="assistant-auto-top">
                <div className="assistant-auto-heading">
                  <span
                    className="assistant-runs-dot"
                    data-status={isRunning ? 'running' : result ? (result.passed ? 'completed' : 'failed') : 'cancelled'}
                    aria-hidden="true"
                  />
                  <span className="assistant-auto-title">{item.label}</span>
                  {agentName && <span className="assistant-auto-pill">{agentName}</span>}
                </div>
                <div className="assistant-auto-controls">
                  {result && (
                    <span className="assistant-runs-status-label" data-status={result.passed ? 'completed' : 'failed'}>
                      {result.passed ? say('evalPassed') : say('evalFailed')}
                    </span>
                  )}
                  <Button size="xs" variant="ghost" disabled={!ready || isRunning} onClick={() => void runEval(item.id)}>
                    {isRunning ? say('runningEvals') : say('runEval')}
                  </Button>
                </div>
              </div>

              {item.description && <p className="assistant-auto-desc">{item.description}</p>}

              <div className="assistant-eval-pills">
                {pills.map((pill) => (
                  <span key={pill} className="assistant-auto-pill">
                    {pill}
                  </span>
                ))}
              </div>

              {result && (
                <>
                  <div className="assistant-auto-meta">
                    <span className="assistant-runs-whisper">
                      {say('evalMetaLine', {
                        steps: result.trace.totalSteps,
                        tokens: formatCompactTokens(result.trace.totalTokens),
                        duration: formatDuration(result.durationMs),
                      })}
                    </span>
                    <Button size="xs" variant="ghost" onClick={() => setExpandedTrace((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}>
                      {showTrace ? say('hideTrace') : say('viewTrace')}
                    </Button>
                  </div>
                  {result.failures.length > 0 && (
                    <ul className="assistant-eval-failures">
                      {result.failures.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  )}
                  {showTrace && <TraceSummaryView trace={result.trace} />}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
