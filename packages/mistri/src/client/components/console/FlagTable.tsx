/**
 * The Feature flags room's list, as LaunchDarkly's and Unleash's read: one
 * line per flag with its key, kind, state in each scope, rollout, owner and
 * last change; the view (all, on, off, rolling out, needs cleanup) as one
 * segmented row whose counts say where the scope stands, the kind as chips,
 * and a search. A person who may turn a flag off (or back on) does it from
 * the row, and the row asks first and records why — the same kill and set the
 * sheet sends, with the revision the list read, so a change made meanwhile is
 * refused. On a phone each line is a card (ConsoleRoom.css).
 */
import { useState, type ReactNode } from 'react';
import { Button, Dropdown, Segmented, Tone, useSectionSize } from '@mistriwork/mistri/ui';
import { useMessageLanguage } from '@mistriwork/kit/client/components/useMessageLanguage.js';
import { say } from '../../copy/console/components/console/FlagTable.js';
import { controlDraft, editedOverride, valueText } from './OverrideEditor.js';
import { When } from './ConsoleShell.js';
import type { ConsoleRequest, FlagDetail, FlagRow } from './model.js';

const DAY = 86_400_000;
type FlagView = 'all' | 'on' | 'off' | 'rolling' | 'cleanup';
export interface FlagFilter {
  view?: FlagView;
  kind?: NonNullable<FlagRow['kind']>;
}

const rolling = (row: FlagRow) => row.disabled !== true && row.rollout !== undefined && row.rollout > 0 && row.rollout < 100;
/**
 * Settled: fully rolled out or turned off, and untouched for 30 days. A flag
 * whose history holds no change cannot be dated, so it is never counted here.
 */
export const needsCleanup = (row: FlagRow, now = Date.now()) =>
  row.changedAt !== undefined &&
  now - Date.parse(row.changedAt) >= 30 * DAY &&
  (row.disabled === true || (row.disabled === false && row.rollout === 100));

const inView = (row: FlagRow, view: FlagView | undefined) =>
  !view ||
  view === 'all' ||
  (view === 'on' && row.disabled === false) ||
  (view === 'off' && row.disabled === true) ||
  (view === 'rolling' && rolling(row)) ||
  (view === 'cleanup' && needsCleanup(row));

export function filtered(rows: readonly FlagRow[], filter: FlagFilter, query: string) {
  const asked = query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (row.flagId.toLowerCase().includes(asked) || (row.owner ?? '').toLowerCase().includes(asked)) &&
      inView(row, filter.view) &&
      (!filter.kind || row.kind === filter.kind),
  );
}

/** The view as one segmented row, each choice carrying its count; the kinds as chips beside it. */
export function FlagFilters({
  rows,
  filter,
  onFilter,
}: {
  rows: readonly FlagRow[];
  filter: FlagFilter;
  onFilter(next: FlagFilter): void;
}) {
  useMessageLanguage();
  const count = (view: FlagView) => rows.filter((row) => inView(row, view)).length;
  const kinds = (['boolean', 'variant', 'experiment'] as const).filter((kind) => rows.some((row) => row.kind === kind));
  /* Five views do not fit a phone's row; there they are one choice, each with its count. */
  const compact = useSectionSize().compact;
  const views = ['all', 'on', 'off', 'rolling', 'cleanup'] as const;
  return (
    <>
      {compact ? (
        <div className="console-switcher">
          <Dropdown
            ariaLabel={say('view')}
            value={filter.view ?? 'all'}
            onChange={(view) => onFilter({ ...filter, view: view as FlagView })}
            items={views.map((view) => ({ value: view, label: VIEW[view](), detail: String(count(view)) }))}
          />
        </div>
      ) : (
        <Segmented
          label={say('view')}
          size="compact"
          value={filter.view ?? 'all'}
          onChange={(view) => onFilter({ ...filter, view })}
          options={(['all', 'on', 'off', 'rolling', 'cleanup'] as const).map((view) => ({
            value: view,
            label: VIEW[view](),
            count: count(view),
          }))}
        />
      )}
      {kinds.length > 1 && (
        <div className="console-chips" role="group" aria-label={say('kinds')}>
          {kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              className="console-chip"
              aria-pressed={filter.kind === kind}
              onClick={() =>
                onFilter({
                  ...filter,
                  kind: filter.kind === kind ? undefined : kind,
                })
              }
            >
              {KIND[kind]()}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
const VIEW = {
  all: () => say('viewAll'),
  on: () => say('viewOn'),
  off: () => say('viewOff'),
  rolling: () => say('viewRolling'),
  cleanup: () => say('viewCleanup'),
};
export const KIND = {
  boolean: () => say('kindBoolean'),
  variant: () => say('kindVariant'),
  experiment: () => say('kindExperiment'),
};

/** A flag's state in a scope that is not the one open: a dot and its word, as every status here is said. */
function ScopeState({ row }: { row: FlagRow | undefined }) {
  if (!row || row.disabled === undefined) return <span className="console-faint">—</span>;
  return row.disabled ? <Tone tone="neutral">{say('off')}</Tone> : <Tone tone="good">{say('on')}</Tone>;
}

/** One flag per line: key, kind, state per scope (a switch in the open scope where it can change), rollout, owner, last change. */
export function FlagTable({
  request,
  rows,
  chosen,
  onOpen,
  rowRef,
  onChanged,
  scopes,
}: {
  request: ConsoleRequest;
  rows: readonly FlagRow[];
  chosen?: string;
  onOpen(row: FlagRow): void;
  rowRef(flagId: string, node: HTMLButtonElement | null): void;
  onChanged(): void;
  /** The scope open, then the App's others (at most three), each with its flags' rows by name. */
  scopes: readonly { label: string; rows?: ReadonlyMap<string, FlagRow> }[];
}) {
  useMessageLanguage();
  const [asking, setAsking] = useState<{ id: string; on: boolean }>();
  const [said, setSaid] = useState<{ ok: boolean; text: string }>();
  const several = scopes.length > 1;
  return (
    <>
      {said && (
        <p className={said.ok ? 'console-said' : 'console-problem'} role={said.ok ? 'status' : 'alert'}>
          {said.text}
        </p>
      )}
      <div className="console-scroll">
        <table className="console-table console-flags">
          <caption className="console-sr">{say('flags')}</caption>
          <thead>
            <tr>
              <th scope="col">{say('flag')}</th>
              <th scope="col">{say('kind')}</th>
              {scopes.map((scope, index) => (
                <th scope="col" key={scope.label} className={index ? 'console-wide' : undefined}>
                  {several ? scope.label : say('state')}
                </th>
              ))}
              <th scope="col">{say('rollout')}</th>
              <th scope="col" className="console-wide">
                {say('owner')}
              </th>
              <th scope="col" className="console-wide">
                {say('changed')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <FlagLine
                key={row.id}
                row={row}
                chosen={row.id === chosen}
                onOpen={onOpen}
                rowRef={rowRef}
                others={scopes.slice(1).map((scope) => scope.rows?.get(row.flagId))}
                loading={scopes.slice(1).map((scope) => !scope.rows)}
                asking={asking?.id === row.id ? asking.on : undefined}
                ask={(on) => {
                  setSaid(undefined);
                  setAsking(on === undefined ? undefined : { id: row.id, on });
                }}
                request={request}
                done={(text, ok) => {
                  setSaid({ ok, text });
                  if (ok) {
                    setAsking(undefined);
                    onChanged();
                  }
                }}
                span={5 + scopes.length}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function FlagLine({
  row,
  chosen,
  onOpen,
  rowRef,
  others,
  loading,
  asking,
  ask,
  request,
  done,
  span,
}: {
  row: FlagRow;
  chosen: boolean;
  onOpen(row: FlagRow): void;
  rowRef(flagId: string, node: HTMLButtonElement | null): void;
  others: readonly (FlagRow | undefined)[];
  loading: readonly boolean[];
  asking: boolean | undefined;
  ask(on: boolean | undefined): void;
  request: ConsoleRequest;
  done(text: string, ok: boolean): void;
  span: number;
}) {
  const canOff = row.actions.includes('kill') || row.actions.includes('manage'),
    canOn = row.actions.includes('manage');
  const known = row.disabled !== undefined,
    on = row.disabled === false;
  const status: ReactNode =
    known && (on ? canOff : canOn) ? (
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className="console-switch"
        aria-label={on ? say('turnOff', { flag: row.flagId }) : say('turnOn', { flag: row.flagId })}
        onClick={() => ask(asking === undefined ? !on : undefined)}
      >
        <span className="console-switch-word">{on ? say('on') : say('off')}</span>
      </button>
    ) : known ? (
      on ? (
        <Tone tone="good">{say('on')}</Tone>
      ) : (
        <Tone tone="neutral">{say('off')}</Tone>
      )
    ) : (
      <span className="console-faint">{canOn ? '—' : canOff ? say('offOnly') : say('viewOnly')}</span>
    );
  return (
    <>
      <tr aria-selected={chosen} className="console-flag-line">
        <td className="console-flag-cell">
          <button
            type="button"
            className="console-open console-flag-key"
            aria-pressed={chosen}
            data-list-key
            ref={(node) => rowRef(row.flagId, node)}
            onClick={() => onOpen(row)}
          >
            {row.flagId}
          </button>
          {row.expiry && <span className="console-flag-about">{say('expires', { when: row.expiry.slice(0, 10) })}</span>}
        </td>
        <td className="console-kind-cell">
          {row.kind ? <span className="console-kind">{KIND[row.kind]()}</span> : <span className="console-faint">—</span>}
        </td>
        <td className="console-state-cell">{status}</td>
        {others.map((other, index) => (
          <td key={index} className="console-wide">
            {loading[index] ? <span className="console-faint">…</span> : <ScopeState row={other} />}
          </td>
        ))}
        <td className="console-rollout-cell">
          {row.rollout === undefined || row.disabled ? (
            <span className="console-faint">—</span>
          ) : (
            <span className="console-rollout" aria-label={say('rolloutOf', { rollout: row.rollout })}>
              <span className="console-rollout-bar" aria-hidden="true">
                <span style={{ inlineSize: `${row.rollout}%` }} />
              </span>
              <span className="console-num">{row.rollout}%</span>
            </span>
          )}
        </td>
        <td className="console-wide">{row.owner ?? <span className="console-faint">—</span>}</td>
        <td className="console-wide console-changed-cell">
          {row.changedAt ? (
            <When at={row.changedAt} />
          ) : (
            <span className="console-faint" title={say('never')} aria-label={say('never')}>
              —
            </span>
          )}
        </td>
      </tr>
      {asking !== undefined && (
        <tr className="console-confirm">
          <td colSpan={span}>
            <Confirm row={row} on={asking} request={request} cancel={() => ask(undefined)} done={done} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Turning a flag off or on is recorded with a reason, like any change from the sheet; on keeps the controls it has. */
async function turn(request: ConsoleRequest, row: Pick<FlagRow, 'id' | 'revision'>, on: boolean, reason: string) {
  const path = `/flags/${encodeURIComponent(row.id)}`;
  if (!on)
    return request<{ revision?: number }>(`${path}/kill`, {
      expectedRevision: row.revision,
      reason,
    });
  const detail = await request<FlagDetail>(path);
  return request<{ revision?: number }>(`${path}/set`, {
    expectedRevision: detail.revision,
    reason,
    override: editedOverride(detail, valueText(detail, detail.value), {
      ...controlDraft(detail),
      disabled: false,
    }),
  });
}

/** The row's question: turning a flag off or on is recorded with a reason, like any change from the sheet. */
function Confirm({
  row,
  on,
  request,
  cancel,
  done,
}: {
  row: FlagRow;
  on: boolean;
  request: ConsoleRequest;
  cancel(): void;
  done(text: string, ok: boolean): void;
}) {
  useMessageLanguage();
  const [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!reason.trim()) {
      done(say('reasonRequired'), false);
      return;
    }
    setBusy(true);
    try {
      const reply = await turn(request, row, on, reason);
      done(
        on
          ? say('turnedOn', {
              flag: row.flagId,
              revision: reply.revision ?? row.revision + 1,
            })
          : say('turnedOff', {
              flag: row.flagId,
              revision: reply.revision ?? row.revision + 1,
            }),
        true,
      );
    } catch (error) {
      done((error as Error).message, false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="console-confirm-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <span>{on ? say('askOn', { flag: row.flagId }) : say('askOff', { flag: row.flagId })}</span>
      <label className="console-confirm-reason">
        <span className="console-sr">{say('reason')}</span>
        <input
          type="text"
          value={reason}
          maxLength={1024}
          placeholder={say('reasonPlaceholder')}
          disabled={busy}
          onChange={(event) => setReason(event.target.value)}
          autoFocus
        />
      </label>
      <Button size="compact" intent={on ? 'primary' : 'danger'} type="submit" busy={busy}>
        {on ? say('confirmOn') : say('confirmOff')}
      </Button>
      <Button size="compact" intent="quiet" disabled={busy} onClick={cancel}>
        {say('keep')}
      </Button>
    </form>
  );
}
