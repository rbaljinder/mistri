/** Aggregate evidence only; identities and conversion facts never reach this room. */
import { useEffect, useRef, useState } from 'react';
import { Button, Dropdown, Row, Stack, Tone } from '@mistriwork/mistri/ui';
import type { ConsoleExperimentResult } from '../../../shared/consoleExperiment.js';
import { Field } from '@mistriwork/ui/Field.js';
import { JsonView } from '@mistriwork/kit/client/components/JsonView.js';
import { ConsoleFailure, type ConsoleRequest } from './model.js';
import { say } from '../../copy/console/components/console/ExperimentResults.js';
/* The verdict is the dashboard's banner block and the blockers its steps block; their stylesheet comes with them. */
import '../DashboardBlocks.css';

interface ConsoleExperiment {
  result: ConsoleExperimentResult;
  canDecide: boolean;
}
const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(2)}%`);
const interval = (value: { lower: number; upper: number } | null) =>
  value === null ? '—' : `${percent(value.lower)} … ${percent(value.upper)}`;
type Statistics = ConsoleExperimentResult['statistics'];
const GUARDRAIL = {
  safe: () => say('guardSafe'),
  breached: () => say('guardBreached'),
  inconclusive: () => say('guardInconclusive'),
  descriptive: () => say('guardDescriptive'),
};
/** A blocker's code said as the thing to wait for or fix. */
function blockerTitle(code: string) {
  const known: Record<string, () => string> = {
    'fixed-horizon': () => say('bHorizon'),
    'immature-cohorts': () => say('bImmature'),
    'incomplete-delivery': () => say('bDelivery'),
    'missing-metric-data': () => say('bMissing'),
    'insufficient-metric-data': () => say('bInsufficient'),
    'guardrails-not-satisfied': () => say('bGuardrails'),
  };
  return known[code]?.() ?? (code.startsWith('srm-') ? say('bSrm') : code);
}
function blockerNote(code: string, stats: Statistics) {
  if (code === 'fixed-horizon')
    return say('nHorizon', {
      date: new Date(stats.finalizesAtMs).toLocaleString(),
    });
  if (code === 'immature-cohorts') return say('nImmature', { count: stats.immature });
  if (code === 'incomplete-delivery') return say('delivery', stats.completeness);
  if (code.startsWith('srm-'))
    return say('srm', {
      status: stats.srm.status,
      p: stats.srm.pValue === null ? '—' : stats.srm.pValue.toFixed(3),
    });
  if (code === 'guardrails-not-satisfied') return say('nGuardrails');
  if (code === 'missing-metric-data' || code === 'insufficient-metric-data') return say('nData');
  return undefined;
}
export function ExperimentResults({
  evidence,
  request,
  id,
  revision,
}: {
  evidence: unknown;
  request: ConsoleRequest;
  id: string;
  revision: number;
}) {
  const data = evidence as Partial<ConsoleExperiment> | null;
  if (!data?.result?.statistics) return <JsonView value={(evidence as object) ?? {}} />;
  return (
    <Results key={`${id}:${data.result.evidenceRevision}`} data={data as ConsoleExperiment} request={request} id={id} revision={revision} />
  );
}
function Results({ data, request, id, revision }: { data: ConsoleExperiment; request: ConsoleRequest; id: string; revision: number }) {
  const { result, canDecide } = data,
    stats = result.statistics;
  const [winner, setWinner] = useState(''),
    [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false),
    [message, setMessage] = useState('');
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const permitted = canDecide && stats.status === 'final-evidence' && stats.complete && stats.finalized && !stats.blockers.length;
  const submit = async () => {
    if (!permitted || busy || blocked) return;
    const arm = result.declaration.arms.find((value) => value.id === winner);
    if (!arm || !reason.trim()) {
      setMessage(say('decisionRequired'));
      return;
    }
    setBusy(true);
    try {
      await request(`/flags/${encodeURIComponent(id)}/decide`, {
        epochFingerprint: result.epoch.fingerprint,
        expectedRevision: revision,
        expectedResultRevision: result.evidenceRevision,
        winnerVariant: arm.value,
        reason,
      });
      if (live.current) {
        setBlocked(true);
        setMessage(say('decided'));
      }
    } catch (error) {
      if (live.current) {
        setMessage((error as Error).message);
        if (error instanceof ConsoleFailure && ['revision_conflict', 'outcome_unknown', 'experiment_conflict'].includes(error.code))
          setBlocked(true);
      }
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const control = stats.arms.find((arm) => arm.id === stats.control);
  const primary = stats.comparisons.filter((comparison) => comparison.guardrail === null);
  const lift = (arm: string) => primary.find((comparison) => comparison.arm === arm);
  const label = (arm: string) => {
    const value = result.declaration.arms.find((item) => item.id === arm)?.value;
    return value === undefined ? arm : typeof value === 'string' ? value : JSON.stringify(value);
  };
  /* One scale for every bar and whisker: the widest interval, so the arms compare by eye. */
  const top = Math.max(0.0001, ...stats.arms.map((arm) => Math.max(arm.primary.interval95?.upper ?? 0, arm.primary.rate ?? 0)));
  /* A little headroom past the widest whisker, so its cap is drawn inside the row. */
  const at = (value: number) => `${Math.min(100, Math.max(0, (value / (top * 1.06)) * 100))}%`;
  const winners = primary.filter((comparison) => comparison.significance === 'positive');
  const losers = primary.filter((comparison) => comparison.significance === 'negative');
  const verdict =
    stats.status === 'descriptive'
      ? {
          tone: 'warn',
          eyebrow: say('provisional'),
          title: say('tooEarly'),
          text: say('descriptive'),
        }
      : stats.status === 'final-blocked'
        ? {
            tone: 'warn',
            eyebrow: say('blocked'),
            title: say('blockedTitle', { count: stats.blockers.length }),
            text: say('decisionBlocked'),
          }
        : winners.length
          ? {
              tone: 'good',
              eyebrow: say('final'),
              title: say('winnerTitle', {
                arm: winners.map((item) => label(item.arm)).join(say('listJoin')),
              }),
              text: say('winnerText'),
            }
          : losers.length
            ? {
                tone: 'bad',
                eyebrow: say('final'),
                title: say('loserTitle'),
                text: say('loserText'),
              }
            : {
                tone: 'neutral',
                eyebrow: say('final'),
                title: say('flatTitle'),
                text: say('flatText'),
              };
  const day = 86_400_000;
  const horizon = stats.horizon;
  const running = horizon ? Math.max(0, Math.floor((Math.min(horizon.nowMs, horizon.endsAtMs) - horizon.startsAtMs) / day)) : undefined;
  const planned = horizon ? Math.max(1, Math.round((horizon.endsAtMs - horizon.startsAtMs) / day)) : undefined;
  const points = (value: number | null) =>
    value === null ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value * 100).toFixed(2)}`;
  return (
    <Stack className="console-results" gap="field">
      <section className="page-section dash-banner console-verdict" data-tone={verdict.tone} aria-label={say('verdict')}>
        <div className="dashboard-note is-banner">
          <div className="dashboard-note-words">
            <span className="dashboard-note-eyebrow">{verdict.eyebrow}</span>
            <p className="dashboard-note-title">{verdict.title}</p>
            <p className="dashboard-note-text">{verdict.text}</p>
          </div>
        </div>
      </section>
      <dl className="console-facts">
        <div>
          <dt>{say('matureUnits')}</dt>
          <dd>{stats.mature.toLocaleString()}</dd>
          <dd className="console-caption">{say('immatureUnits', { count: stats.immature })}</dd>
        </div>
        {running !== undefined && planned !== undefined && (
          <div>
            <dt>{say('running')}</dt>
            <dd>{say('days', { count: running })}</dd>
            <dd className="console-caption">{say('ofDays', { count: planned })}</dd>
          </div>
        )}
        <div>
          <dt>{say('finalizes')}</dt>
          <dd>{new Date(stats.finalizesAtMs).toLocaleDateString()}</dd>
          <dd className="console-caption">{new Date(stats.finalizesAtMs).toLocaleTimeString()}</dd>
        </div>
        <div>
          <dt>{say('deliveryHealth')}</dt>
          <dd>{stats.complete ? say('complete') : say('incomplete')}</dd>
          <dd className="console-caption">{say('delivery', stats.completeness)}</dd>
        </div>
      </dl>
      <section className="console-section" aria-labelledby={`${id}-compare`}>
        <h3 className="console-section-title" id={`${id}-compare`}>
          {say('comparisons')}
        </h3>
        <ol className="console-compare">
          {stats.arms.map((arm) => {
            const comparison = lift(arm.id);
            const rate = arm.primary.rate,
              band = arm.primary.interval95;
            const relative = comparison?.difference != null && control?.primary.rate ? comparison.difference / control.primary.rate : null;
            return (
              <li key={arm.id} data-control={arm.id === stats.control || undefined}>
                <span className="console-compare-name">
                  <code className="console-value">{label(arm.id)}</code>
                  {arm.id === stats.control && <span className="console-kind-pill">{say('control')}</span>}
                  <span className="console-caption">
                    {say('allocation', { weight: arm.weight })} ·{' '}
                    {say('conversion', {
                      converted: arm.primary.converted ?? '—',
                      total: arm.primary.total.toLocaleString(),
                    })}
                  </span>
                </span>
                <span className="console-compare-figures">
                  <span className="console-compare-rate">
                    <strong>{percent(rate)}</strong>
                    <span className="console-caption">{interval(band)}</span>
                  </span>
                  <span className="console-compare-lift">
                    {arm.id === stats.control ? (
                      <span className="console-faint">{say('baseline')}</span>
                    ) : comparison ? (
                      <>
                        <strong data-significance={comparison.significance}>
                          {say('liftPoints', {
                            points: points(comparison.difference),
                          })}
                        </strong>
                        <span className="console-caption">
                          {relative === null
                            ? interval(comparison.adjustedInterval)
                            : say('liftRelative', {
                                relative: points(relative),
                              })}
                        </span>
                      </>
                    ) : (
                      <span className="console-faint">—</span>
                    )}
                  </span>
                </span>
                <span className="console-compare-track" aria-hidden="true">
                  {rate !== null && <span className="console-compare-bar" style={{ width: at(rate) }} />}
                  {band && (
                    <span
                      className="console-compare-whisker"
                      style={{
                        left: at(band.lower),
                        right: `calc(100% - ${at(band.upper)})`,
                      }}
                    />
                  )}
                  {control?.primary.rate != null && <span className="console-compare-control" style={{ left: at(control.primary.rate) }} />}
                </span>
              </li>
            );
          })}
        </ol>
        <p className="console-caption">
          {say('chartHint')}{' '}
          {say('srm', {
            status: stats.srm.status,
            p: stats.srm.pValue === null ? '—' : stats.srm.pValue.toFixed(3),
          })}
        </p>
      </section>
      {stats.guardrails.length > 0 && (
        <section className="console-section" aria-label={say('guardrails')}>
          <h3 className="console-section-title">{say('guardrails')}</h3>
          <div className="console-scroll">
            <table className="console-table">
              <thead>
                <tr>
                  <th scope="col">{say('guardrail')}</th>
                  <th scope="col">{say('variant')}</th>
                  <th scope="col" className="console-num">
                    {say('change')}
                  </th>
                  <th scope="col">{say('guardrailState')}</th>
                </tr>
              </thead>
              <tbody>
                {stats.comparisons
                  .filter((comparison) => comparison.guardrail !== null)
                  .map((comparison) => (
                    <tr key={`${comparison.arm}:${comparison.metric}`}>
                      <td>{comparison.metric}</td>
                      <td>
                        <code className="console-value">{label(comparison.arm)}</code>
                      </td>
                      <td className="console-num">
                        {say('liftPoints', {
                          points: points(comparison.difference),
                        })}
                      </td>
                      <td>
                        <Tone tone={comparison.guardrail === 'safe' ? 'good' : comparison.guardrail === 'breached' ? 'bad' : 'neutral'}>
                          {GUARDRAIL[comparison.guardrail as keyof typeof GUARDRAIL]?.() ?? comparison.guardrail}
                        </Tone>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {!!stats.blockers.length && (
        <section className="console-section" aria-label={say('blockers')}>
          <h3 className="console-section-title">{say('blockers')}</h3>
          <ol
            className="dash-steps console-blockers"
            style={{
              ['--steps' as string]: Math.min(stats.blockers.length, 3),
            }}
          >
            {stats.blockers.map((blocker, index) => (
              <li key={blocker} className="dash-step is-warn">
                <div className="dash-step-card">
                  <span className="dash-step-mark tone-warn" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="dash-step-words">
                    <span className="dash-step-title">{blockerTitle(blocker)}</span>
                    {blockerNote(blocker, stats) && <span className="dash-step-note">{blockerNote(blocker, stats)}</span>}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
      <details>
        <summary>{say('methods')}</summary>
        <Stack gap="tight">
          <p>
            {stats.methods.rate}; {stats.methods.difference}; {stats.methods.intervalAdjustment} (
            {say('family', {
              count: stats.methods.familySize,
              alpha: stats.methods.familyAlpha,
            })}
            ).
          </p>
          <p>
            {stats.methods.family}. {stats.methods.srm}; α {stats.methods.srmAlpha}.
          </p>
          <p>{say('guardrailThresholds')}</p>
          {stats.guardrails.map((guardrail) => (
            <p key={guardrail.id}>
              {guardrail.id}: {percent(guardrail.maxIncrease)}
            </p>
          ))}
          <p>{say('fixedWindow')}</p>
          <p>{say('consumption')}</p>
        </Stack>
      </details>
      {canDecide && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Stack>
            <h3 className="console-section-title">{say('decision')}</h3>
            <p>{say('decisionHint')}</p>
            {!permitted && <p>{say('decisionBlocked')}</p>}
            <Field label={say('winner')}>
              {(control) => (
                <Dropdown
                  id={control.id}
                  ariaLabel={say('winner')}
                  value={winner}
                  disabled={!permitted || busy || blocked}
                  onChange={setWinner}
                  items={[
                    { value: '', label: say('chooseWinner') },
                    ...result.declaration.arms.map((arm) => ({
                      value: arm.id,
                      label: JSON.stringify(arm.value),
                    })),
                  ]}
                />
              )}
            </Field>
            <Field label={say('reason')} required>
              <textarea
                value={reason}
                maxLength={1024}
                disabled={!permitted || busy || blocked}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            <Row>
              <Button type="submit" intent="primary" disabled={!permitted || busy || blocked}>
                {say('applyWinner')}
              </Button>
            </Row>
          </Stack>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </Stack>
  );
}
