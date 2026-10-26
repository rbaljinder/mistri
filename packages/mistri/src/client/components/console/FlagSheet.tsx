/**
 * One flag, in the sheet beside the list (a full-screen dialog on a phone).
 *
 * It opens on what the flag does: its state, the kill switch, and the
 * Serving sentence that says in one line who gets what. Rules are an ordered
 * list of one-line cards; what everyone else gets is a value, a share and its
 * bar. An edit is staged: nothing is sent until the reader reviews the list
 * of what changes, says why, and applies it — one complete override at the
 * revision the sheet read, so a change made meanwhile is refused (a conflict
 * keeps the draft and asks for an explicit refetch; an unknown outcome is
 * never retried). Turning the flag off or on, restoring a revision and the
 * experiment's lifecycle go through the same review and the same transport.
 * Which of these a reader is offered follows the actions the server granted
 * for this flag; the server checks them again at commit.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button, Empty, Stack, Tone } from '@mistriwork/mistri/ui';
import { Field } from '@mistriwork/ui/Field.js';
import { JsonView } from '@mistriwork/kit/client/components/JsonView.js';
import { useMessageLanguage } from '@mistriwork/kit/client/components/useMessageLanguage.js';
import { say } from '../../copy/console/components/console/FlagSheet.js';
import { ConsoleFailure, type ConsoleRequest, type FlagDetail } from './model.js';
import { OverrideEditor, controlDraft, editedOverride, valueText, type OverrideDraft } from './OverrideEditor.js';
import { ExperimentResults } from './ExperimentResults.js';
import { When } from './ConsoleShell.js';
import { KIND } from './FlagTable.js';
import { RolloutBar, RuleLine, Serving, currentControls, stagedChanges, valueWord, type ServingControls } from './flagWords.js';

type Lifecycle = 'activate' | 'pause' | 'resume';
const LIFECYCLE: Record<Lifecycle, () => string> = {
  activate: () => say('activate'),
  pause: () => say('pause'),
  resume: () => say('resume'),
};
/** What the review is about to send. */
type Pending =
  | { kind: 'set' }
  | { kind: 'kill' }
  | { kind: 'on' }
  | { kind: 'revert'; revision: string }
  | { kind: 'lifecycle'; operation: Lifecycle };

interface HistoryEntry {
  revision: number;
  operation: string;
  reason: string;
  at: string;
  before: unknown;
  after: unknown;
}

function useRead<T>(request: ConsoleRequest, path: string | undefined, revision?: number) {
  const [state, setState] = useState<{
    path: string;
    request: ConsoleRequest;
    revision?: number;
    data?: T;
    error?: string;
  }>();
  useEffect(() => {
    if (!path) return;
    let current = true;
    const cancel = new AbortController();
    void request<T>(path, undefined, cancel.signal).then(
      (data) => {
        if (current) setState({ path, request, revision, data });
      },
      (error: Error) => {
        if (current) setState({ path, request, revision, error: error.message });
      },
    );
    return () => {
      current = false;
      cancel.abort();
    };
  }, [request, path, revision]);
  return state && state.path === path && state.request === request && state.revision === revision ? state : undefined;
}

/** A history entry's controls as the sentence reads them. */
function entryControls(value: unknown): ServingControls | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as ServingControls & { experimentAllocated?: boolean };
  return { ...raw, experiment: raw.experimentAllocated ?? raw.experiment };
}

export function FlagRecord({ request, id, onChanged }: { request: ConsoleRequest; id: string; onChanged?(): void }) {
  useMessageLanguage();
  const initial = useRead<FlagDetail>(request, `/flags/${encodeURIComponent(id)}`);
  const [fresh, setFresh] = useState<{
    request: ConsoleRequest;
    id: string;
    detail: FlagDetail;
  }>();
  const detail = fresh?.request === request && fresh.id === id ? fresh.detail : initial?.data;
  /* The staged edit: undefined until the reader touches it, so the sheet reads the flag's own controls until then. */
  const [draft, setDraft] = useState<OverrideDraft>();
  const [text, setText] = useState<string>();
  const [pending, setPending] = useState<Pending>();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false),
    [message, setMessage] = useState<{ text: string; ok: boolean }>();
  const [tab, setTab] = useState<'record' | 'history' | 'results'>('record');
  const tabId = useId(),
    tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const [before, setBefore] = useState<number>();
  const canView = !!detail?.actions.includes('view');
  const history = useRead<{
    entries: HistoryEntry[];
    nextBeforeRevision: number | null;
  }>(
    request,
    canView && (tab === 'history' || tab === 'record')
      ? `/flags/${encodeURIComponent(id)}/history${tab === 'history' && before !== undefined ? `?beforeRevision=${before}` : ''}`
      : undefined,
    detail?.revision,
  );
  const results = useRead<{ evidence: object }>(
    request,
    tab === 'results' ? `/flags/${encodeURIComponent(id)}/results` : undefined,
    detail?.revision,
  );
  const identity = useRef({ request, id });
  identity.current = { request, id };
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const current = () => live.current && identity.current.request === request && identity.current.id === id;
  /** Read the flag again. After an applied change the staged edit is done with; after a refusal it is kept for review. */
  const refresh = async (done: boolean) => {
    setBusy(true);
    try {
      const value = await request<FlagDetail>(`/flags/${encodeURIComponent(id)}`);
      if (!current()) return;
      setFresh({ request, id, detail: value });
      setBlocked(false);
      if (done) {
        setDraft(undefined);
        setText(undefined);
        setReason('');
        setPending(undefined);
      } else setMessage({ text: say('refreshed'), ok: true });
    } catch (error) {
      if (current()) setMessage({ text: (error as Error).message, ok: false });
    } finally {
      if (current()) setBusy(false);
    }
  };
  if (!detail) return <p role={initial?.error ? 'alert' : 'status'}>{initial?.error ?? say('loadingFlag')}</p>;
  const can = (action: 'view' | 'manage' | 'kill') => detail.actions.includes(action);
  const baseText = valueText(detail, detail.value),
    baseDraft = controlDraft(detail);
  const shownText = text ?? baseText,
    shownDraft = draft ?? baseDraft;
  const changes = can('manage') ? stagedChanges({ text: baseText, ...baseDraft }, { text: shownText, ...shownDraft }) : [];
  let invalid: string | undefined;
  try {
    if (changes.length) editedOverride(detail, shownText, shownDraft);
  } catch (error) {
    invalid = (error as Error).message;
  }
  const off = detail.disabled === true;
  const ask = (next: Pending) => {
    setPending(next);
    setMessage(undefined);
  };
  const submit = async () => {
    if (!pending || busy || blocked) return;
    try {
      if (!reason.trim()) throw new Error(say('reasonRequired'));
      if (pending.kind === 'revert' && (!/^\d+$/.test(pending.revision) || !Number.isSafeInteger(Number(pending.revision))))
        throw new Error(say('revisionRequired'));
      const base = { expectedRevision: detail.revision, reason };
      const [endpoint, body] =
        pending.kind === 'set'
          ? [
              'set',
              {
                ...base,
                override: editedOverride(detail, shownText, shownDraft),
              },
            ]
          : pending.kind === 'on'
            ? [
                'set',
                {
                  ...base,
                  override: editedOverride(detail, baseText, {
                    ...baseDraft,
                    disabled: false,
                  }),
                },
              ]
            : pending.kind === 'kill'
              ? ['kill', base]
              : pending.kind === 'revert'
                ? ['revert', { ...base, revertRevision: Number(pending.revision) }]
                : ['lifecycle', { ...base, operation: pending.operation }];
      setBusy(true);
      const reply = await request<{ revision?: number; outcome: string }>(`/flags/${encodeURIComponent(id)}/${endpoint}`, body);
      if (!current()) return;
      setMessage({
        text: reply.revision === undefined ? say('lifecycleApplied') : say('applied', { revision: reply.revision }),
        ok: true,
      });
      onChanged?.();
      setBusy(false);
      await refresh(true);
    } catch (error) {
      if (current()) {
        setMessage({ text: (error as Error).message, ok: false });
        if (error instanceof ConsoleFailure && ['revision_conflict', 'outcome_unknown'].includes(error.code)) setBlocked(true);
      }
    } finally {
      if (current()) setBusy(false);
    }
  };
  const tabs = ['record', ...(canView ? ['history'] : []), ...(detail.resultsAvailable ? ['results'] : [])] as Array<typeof tab>;
  const lifecycle: Lifecycle[] = detail.lifecycleAvailable
    ? [...(can('manage') ? (['activate', 'resume'] as const) : []), ...(can('kill') ? (['pause'] as const) : [])]
    : [];
  const reviewing = pending !== undefined;
  return (
    <Stack className="console-record" gap="field">
      <p className="console-sheet-meta">
        {detail.kind && <span className="console-kind-pill">{KIND[detail.kind]()}</span>}
        <span>{detail.environment}</span>
        <span>{detail.scope === 'tenant' ? say('tenantScope') : say('globalScope')}</span>
        <span>{say('revision', { revision: detail.revision })}</span>
        {detail.owner && <span>{say('ownedBy', { owner: detail.owner })}</span>}
        {detail.changedAt && (
          <span>
            {say('changed')} <When at={detail.changedAt} />
          </span>
        )}
      </p>
      <div className="console-sheet-state">
        {detail.disabled === undefined ? (
          <span className="console-faint">{say('stateHidden')}</span>
        ) : off ? (
          <Tone tone="neutral">{say('stateOff')}</Tone>
        ) : (
          <Tone tone="good">{say('stateOn')}</Tone>
        )}
        <span className="console-sheet-actions">
          {lifecycle.map((operation) => (
            <Button key={operation} size="compact" disabled={busy || reviewing} onClick={() => ask({ kind: 'lifecycle', operation })}>
              {LIFECYCLE[operation]()}
            </Button>
          ))}
          {!off && can('kill') && (
            <Button size="compact" intent="danger" disabled={busy || reviewing} onClick={() => ask({ kind: 'kill' })}>
              {say('turnOff')}
            </Button>
          )}
          {off && can('manage') && canView && (
            <Button size="compact" intent="primary" disabled={busy || reviewing} onClick={() => ask({ kind: 'on' })}>
              {say('turnOn')}
            </Button>
          )}
        </span>
      </div>
      {reviewing ? (
        <Review
          pending={pending}
          detail={detail}
          changes={changes}
          draftControls={{
            value: (() => {
              try {
                return editedOverride(detail, shownText, shownDraft).value;
              } catch {
                return undefined;
              }
            })(),
            rollout: shownDraft.rollout.trim() === '' ? undefined : Number(shownDraft.rollout),
            disabled: shownDraft.disabled,
            rules: shownDraft.rules,
          }}
          reason={reason}
          setReason={setReason}
          setRevision={(revision) => setPending({ kind: 'revert', revision })}
          busy={busy}
          blocked={blocked}
          submit={() => void submit()}
          back={() => {
            setPending(undefined);
            setMessage(undefined);
          }}
        />
      ) : (
        <Stack className="page-tabs">
          <div className="page-tabstrip" role="tablist" aria-label={say('flagDetails')}>
            {tabs.map((item, index) => (
              <button
                key={item}
                type="button"
                className="page-tab"
                role="tab"
                id={`${tabId}-${item}`}
                aria-controls={`${tabId}-panel`}
                aria-selected={tab === item}
                tabIndex={tab === item ? 0 : -1}
                ref={(node) => {
                  tabButtons.current[index] = node;
                }}
                onClick={() => setTab(item)}
                onKeyDown={(event) => {
                  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                  const next = step
                    ? (index + step + tabs.length) % tabs.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : -1;
                  if (next < 0) return;
                  event.preventDefault();
                  setTab(tabs[next]);
                  tabButtons.current[next]?.focus();
                }}
              >
                {item === 'record' ? say('record') : item === 'history' ? say('history') : say('results')}
              </button>
            ))}
          </div>
          <div className="page-tabpanel" role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`} tabIndex={0}>
            {tab === 'history' ? (
              <History
                history={history}
                canRestore={can('manage')}
                restore={(revision) => ask({ kind: 'revert', revision: String(revision) })}
                earlier={setBefore}
                detail={detail}
              />
            ) : tab === 'results' ? (
              <>
                {results?.error && <p role="alert">{results.error}</p>}
                {!results && <p role="status">{say('loadingResults')}</p>}
                {results?.data && (
                  <ExperimentResults evidence={results.data.evidence} request={request} id={id} revision={detail.revision} />
                )}
              </>
            ) : (
              <Stack gap="field">
                {!canView ? (
                  <p>{say('restricted')}</p>
                ) : (
                  <section className="console-live" aria-label={say('serving')}>
                    <span className="console-eyebrow">{say('serving')}</span>
                    <Serving detail={detail} controls={currentControls(detail)} />
                    {/* A manager's editor draws the bar under the share it edits; once is enough. */}
                    {!can('manage') && <RolloutBar detail={detail} controls={currentControls(detail)} />}
                  </section>
                )}
                {can('manage') ? (
                  <OverrideEditor
                    detail={detail}
                    draft={shownDraft}
                    onChange={setDraft}
                    disabled={busy}
                    text={shownText}
                    setText={setText}
                  />
                ) : (
                  canView && <ReadOnlyRules detail={detail} />
                )}
                {canView && detail.variants && <Variants detail={detail} />}
                {canView && (
                  <section className="console-section" aria-label={say('recent')}>
                    <div className="console-section-head">
                      <h3 className="console-section-title">{say('recent')}</h3>
                      <Button size="compact" intent="quiet" onClick={() => setTab('history')}>
                        {say('allHistory')}
                      </Button>
                    </div>
                    <Timeline entries={history?.data?.entries?.slice(0, 3)} loading={!history} detail={detail} />
                  </section>
                )}
                {detail.scope && (
                  <p className="console-caption">{detail.scope === 'tenant' ? say('tenantScopeHint') : say('globalScopeHint')}</p>
                )}
                {!can('manage') && !can('kill') && <p className="console-caption">{say('readOnly')}</p>}
              </Stack>
            )}
          </div>
        </Stack>
      )}
      {can('manage') && !reviewing && (changes.length > 0 || invalid) && (
        <div className="console-staged" role="region" aria-label={say('staged')}>
          <span className="console-staged-words">
            {invalid ? <span className="console-problem">{invalid}</span> : say('stagedCount', { count: changes.length })}
          </span>
          <Button
            size="compact"
            intent="quiet"
            disabled={busy}
            onClick={() => {
              setDraft(undefined);
              setText(undefined);
            }}
          >
            {say('discard')}
          </Button>
          <Button size="compact" intent="primary" disabled={busy || !!invalid || !changes.length} onClick={() => ask({ kind: 'set' })}>
            {say('review')}
          </Button>
        </div>
      )}
      {message && (
        <p className={message.ok ? 'console-said' : 'console-problem'} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
      {blocked && (
        <div>
          <Button size="compact" disabled={busy} onClick={() => void refresh(false)}>
            {say('refetch')}
          </Button>
        </div>
      )}
    </Stack>
  );
}

/** The review: what is about to be sent, said in the terms it will be served in, a reason, and Apply. */
function Review({
  pending,
  detail,
  changes,
  draftControls,
  reason,
  setReason,
  setRevision,
  busy,
  blocked,
  submit,
  back,
}: {
  pending: Pending;
  detail: FlagDetail;
  changes: ReturnType<typeof stagedChanges>;
  draftControls: ServingControls;
  reason: string;
  setReason(value: string): void;
  setRevision(value: string): void;
  busy: boolean;
  blocked: boolean;
  submit(): void;
  back(): void;
}) {
  const kill = pending.kind === 'kill';
  return (
    <form
      className="console-review"
      aria-label={say('reviewTitle')}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Stack gap="field">
        <h3 className="console-section-title">
          {pending.kind === 'set'
            ? say('reviewSet', { count: changes.length })
            : pending.kind === 'kill'
              ? say('reviewKill')
              : pending.kind === 'on'
                ? say('reviewOn')
                : pending.kind === 'revert'
                  ? say('reviewRevert')
                  : LIFECYCLE[pending.operation]()}
        </h3>
        {pending.kind === 'set' && (
          <>
            <ol className="console-diff" aria-label={say('changes')}>
              {changes.map((change, index) => (
                <li key={index}>
                  <span className="console-diff-what">{change.what}</span>
                  <span className="console-diff-was">{change.before ?? <span className="console-faint">{say('added')}</span>}</span>
                  <span className="console-diff-arrow" aria-hidden="true">
                    →
                  </span>
                  <span className="console-diff-now">{change.after ?? <span className="console-faint">{say('removed')}</span>}</span>
                </li>
              ))}
            </ol>
            <div className="console-live">
              <span className="console-eyebrow">{say('servingAfter')}</span>
              <Serving detail={detail} controls={draftControls} />
            </div>
          </>
        )}
        {kill && <p>{detail.safeValue === undefined ? say('killHint') : say('killHintValue', { value: valueWord(detail.safeValue) })}</p>}
        {pending.kind === 'on' && <p>{say('onHint')}</p>}
        {pending.kind === 'lifecycle' && <p>{say('lifecycleHint')}</p>}
        {pending.kind === 'revert' && (
          <Field size="compact" label={say('revisionToRestore')} hint={say('revertHint')}>
            <input
              type="number"
              min="0"
              step="1"
              value={pending.revision}
              disabled={busy}
              onChange={(event) => setRevision(event.target.value)}
            />
          </Field>
        )}
        <Field label={say('reason')} required>
          <textarea
            rows={2}
            placeholder={say('reasonPlaceholder')}
            value={reason}
            maxLength={1024}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <div className="console-review-actions">
          <Button intent={kill ? 'danger' : 'primary'} type="submit" busy={busy} disabled={blocked}>
            {kill ? say('confirmOff') : say('apply')}
          </Button>
          <Button intent="quiet" disabled={busy} onClick={back}>
            {say('back')}
          </Button>
        </div>
      </Stack>
    </form>
  );
}

/** The flag's rules for a reader who may not change them: the same one-line cards, without their tools. */
function ReadOnlyRules({ detail }: { detail: FlagDetail }) {
  const rules = detail.control?.rules ?? [];
  if (!rules.length) return null;
  return (
    <section className="console-section" aria-label={say('rules')}>
      <h3 className="console-section-title">
        {say('rules')}
        <span className="console-count-pill">{rules.length}</span>
      </h3>
      <ol className="console-rules">
        {rules.map((rule, index) => (
          <li key={index} className="console-rule">
            <div className="console-rule-line">
              <span className="console-rule-number" aria-hidden="true">
                {index + 1}
              </span>
              <span className="console-rule-words">
                <RuleLine rule={rule} />
              </span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Each declared variant and who is served it now: by rule, by the rollout, as the default, as the safe value. */
function Variants({ detail }: { detail: FlagDetail }) {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const rules = detail.control?.rules ?? [];
  const controls = currentControls(detail);
  return (
    <section className="console-section" aria-label={say('variants')}>
      <h3 className="console-section-title">{say('variants')}</h3>
      <table className="console-table console-variants">
        <thead>
          <tr>
            <th scope="col">{say('variant')}</th>
            <th scope="col">{say('servedTo')}</th>
          </tr>
        </thead>
        <tbody>
          {(detail.variants ?? []).map((variant) => {
            const who: ReactNode[] = [];
            rules.forEach((rule, index) => {
              if (same(rule.value, variant)) who.push(say('byRule', { number: index + 1 }));
            });
            if (controls && !controls.disabled && !controls.experiment && controls.value !== undefined && same(controls.value, variant))
              who.push(say('byRollout', { share: controls.rollout ?? 100 }));
            if (same(detail.defaultValue, variant)) who.push(say('byDefault'));
            if (same(detail.safeValue, variant)) who.push(say('bySafe'));
            return (
              <tr key={JSON.stringify(variant)}>
                <td>
                  <code className="console-value">{valueWord(variant)}</code>
                </td>
                <td>{who.length ? who.join(say('listJoin')) : <span className="console-faint">{say('nobody')}</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** Changes as a timeline: revision, what was done, when, and why. */
function Timeline({
  entries,
  loading,
  detail,
  canRestore,
  restore,
}: {
  entries: HistoryEntry[] | undefined;
  loading: boolean;
  detail: FlagDetail;
  canRestore?: boolean;
  restore?(revision: number): void;
}) {
  if (loading)
    return (
      <p role="status" className="console-reading">
        {say('loadingHistory')}
      </p>
    );
  if (!entries?.length) return <Empty title={say('noHistory')} />;
  return (
    <ol className="console-timeline console-history" aria-label={say('history')}>
      {entries.map((entry) => (
        <li key={entry.revision}>
          <span className="console-timeline-head">
            <strong>{say('revision', { revision: entry.revision })}</strong>
            <span className="console-kind">{OPERATION[entry.operation as keyof typeof OPERATION]?.() ?? entry.operation}</span>
            <When at={entry.at} />
          </span>
          <p>{entry.reason}</p>
          {restore && (
            <>
              <div className="console-timeline-after">
                <Serving detail={detail} controls={entryControls(entry.after)} />
              </div>
              <details>
                <summary>{say('inspectChange')}</summary>
                <Stack>
                  <span>{say('beforeChange')}</span>
                  <JsonView value={(entry.before as object) ?? {}} />
                  <span>{say('afterChange')}</span>
                  <JsonView value={(entry.after as object) ?? {}} />
                </Stack>
              </details>
              {canRestore && (
                <div>
                  <Button size="compact" intent="quiet" onClick={() => restore(entry.revision)}>
                    {say('restoreRevision', { revision: entry.revision })}
                  </Button>
                </div>
              )}
            </>
          )}
        </li>
      ))}
    </ol>
  );
}
const OPERATION = {
  set: () => say('opSet'),
  kill: () => say('opKill'),
  revert: () => say('opRevert'),
};

function History({
  history,
  canRestore,
  restore,
  earlier,
  detail,
}: {
  history:
    | {
        data?: { entries: HistoryEntry[]; nextBeforeRevision: number | null };
        error?: string;
      }
    | undefined;
  canRestore: boolean;
  restore(revision: number): void;
  earlier(revision: number): void;
  detail: FlagDetail;
}) {
  return (
    <Stack>
      {history?.error && <p role="alert">{history.error}</p>}
      <Timeline entries={history?.data?.entries} loading={!history} detail={detail} canRestore={canRestore} restore={restore} />
      {history?.data?.nextBeforeRevision != null && (
        <div>
          <Button onClick={() => earlier(history.data!.nextBeforeRevision!)}>{say('earlier')}</Button>
        </div>
      )}
    </Stack>
  );
}
