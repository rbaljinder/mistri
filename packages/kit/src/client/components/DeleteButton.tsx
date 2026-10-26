/**
 * Deleting a row, having first said what that would do.
 *
 * The one destructive action here, and the one place the tool has a real
 * advantage: it already counts what points at a row, and the same counts
 * answer "what breaks if this goes" *before* the delete rather than as a
 * constraint violation afterwards. The count alone is not the answer —
 * three rows pointing here means three deleted under `cascade`, three left
 * holding a null under `set null`, a refusal under `restrict` — so the
 * dialog leads with the rule, and a rule the adapter could not determine
 * says so.
 */
import { useRef, useState } from 'react';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { Button } from '@mistriwork/ui/Button.js';
import { useMutation } from '@tanstack/react-query';
import { api, go, state, toast } from '../core.js';
import { recordKey as checkedRecordKey } from '../resourceRequests.js';
import { canDelete } from '../delete.js';
import { countsChanged } from './navCounts.js';
import { captureSessionIdentity, sessionIdentity } from '../sessionIdentity.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { HttpRecordKey } from '@mistriwork/engine/shared/resourceHttp.js';
import { shell } from '../shellMode.js';
import { say } from '../copy/record/components/DeleteButton.js';

interface Impact {
  table: string;
  count: number;
  onDelete?: string;
}
interface Report {
  impact?: Impact[];
  deleted?: boolean | null;
  outcome?: string;
  errors?: Array<{ message: string }>;
  undoId?: unknown;
}
const UNKNOWN = say('deletionWasNotConfirmed');
const refusedError = (err: { status?: number; outcome?: string }) =>
  err.outcome !== 'unknown' &&
  (err.outcome === 'rejected' ||
    err.outcome === 'not_applied' ||
    (err.outcome === undefined && [400, 401, 403, 404, 409, 422, 501].includes(err.status ?? 0)));

const CONSEQUENCE: Record<string, { tone: string; says: (n: string, t: string) => string }> = {
  cascade: { tone: 'bad', says: (n, t) => say('inWillBeDeleted', { n, t }) },
  'set null': { tone: 'warn', says: (n, t) => say('inWillBeKept', { n, t }) },
  'set default': { tone: 'warn', says: (n, t) => say('inWillBeKeptWithTheReference', { n, t }) },
  restrict: { tone: 'stop', says: (n, t) => say('inWillBlockThisTheDatabase', { n, t }) },
  'no action': { tone: 'stop', says: (n, t) => say('inWillBlockThisTheDatabase', { n, t }) },
};

const rows = (n: number) => say('common.rows2', { count: n });

export type DeleteState = 'pending' | 'uncertain' | 'applied' | 'rejected';
export interface DeleteButtonHost {
  /** Supplemental generation/authority predicate. Never replaces URL/session fences. */
  isCurrent: () => boolean;
  onDeleted: () => void;
  /** Store synchronously before confirmation closes. Pending/uncertain must
   * block voluntary host exit/replacement; unmount is NOT settlement. No idle
   * notification is emitted on cleanup. Retirement belongs to the host. */
  onStateChange: (state: DeleteState) => void;
}
const hostCurrent = (host?: DeleteButtonHost) => {
  try {
    return host === undefined || host.isCurrent() === true;
  } catch {
    return false;
  }
};

interface DeleteProps {
  table: TableMeta;
  recordKey: Record<string, unknown>;
  label: string;
  host?: DeleteButtonHost;
}

/**
 * Delete for one record, for a host that draws the trigger itself. A menu
 * item unmounts when its menu closes, so the confirmation lives with the
 * host (`dialog`), not with the item that opened it.
 */
export function useDelete({ table, recordKey, label, host }: DeleteProps) {
  const [report, setReport] = useState<{ data: Report; key: HttpRecordKey; host?: DeleteButtonHost } | null>(null);
  const [blocked, setBlocked] = useState(false);
  const available = canDelete(table);
  const ask = async () => {
    if (blocked || !hostCurrent(host)) return;
    const identity = captureSessionIdentity();
    const connection = state.activeConnection;
    const route = location.href;
    const current = () =>
      identity === sessionIdentity() && connection === state.activeConnection && route === location.href && hostCurrent(host);
    try {
      const key = checkedRecordKey(recordKey);
      const result: Report = await api('/api/delete', { table: table.id, key });
      if (!current()) return;
      if (result.deleted !== false || result.errors?.length || !Array.isArray(result.impact)) {
        toast(result.errors?.[0]?.message ?? say('theDeletionPreviewIsUnavailable'), 'error');
        return;
      }
      setReport({ data: result, key, host });
    } catch (err) {
      if (current()) toast((err as Error).message, 'error');
    }
  };
  const dialog = report ? (
    <DeleteConfirm
      table={table}
      recordKey={report.key}
      label={label}
      report={report.data}
      host={report.host}
      setBlocked={setBlocked}
      onClose={() => setReport(null)}
    />
  ) : null;
  return { available, blocked, ask: () => void ask(), dialog };
}

export function DeleteButton(props: DeleteProps) {
  const { available, blocked, ask, dialog } = useDelete(props);
  if (!available) return null;
  return (
    <>
      <button
        type="button"
        className="ghost record-delete"
        disabled={blocked}
        title={say('deleteThisRow', { name: props.table.name })}
        onClick={ask}
      >
        {say('common.delete')}
      </button>
      {dialog}
    </>
  );
}

function DeleteConfirm({
  table,
  recordKey,
  label,
  report,
  onClose,
  setBlocked,
  host,
}: {
  table: TableMeta;
  recordKey: HttpRecordKey;
  label: string;
  report: Report;
  onClose: () => void;
  setBlocked: (blocked: boolean) => void;
  host?: DeleteButtonHost;
}) {
  const dialog = useRef<ModalHandle>(null);
  const owner = useRef({ identity: captureSessionIdentity(), connection: state.activeConnection, route: location.href }).current;
  const current = () =>
    owner.identity === sessionIdentity() &&
    owner.connection === state.activeConnection &&
    owner.route === location.href &&
    hostCurrent(host);
  const submitted = useRef(false);
  // A presentation failure after dispatch must never reclassify a known result
  // or release a pending/unknown close guard. The host retains its last status.
  const notify = (status: DeleteState) => {
    try {
      host?.onStateChange(status);
    } catch {
      /* presentation only */
    }
  };
  const remove = useMutation({
    mutationFn: async () => {
      if (!current()) throw new Error(say('thisDeletionBelongsToAPrevious'));
      const tracked = shell().mutations.start('delete', owner.identity);
      try {
        const result: Report = await api('/api/delete', { table: table.id, key: recordKey, confirm: true });
        const definite =
          (result.deleted === true && !result.errors?.length && (result.outcome === undefined || result.outcome === 'applied')) ||
          (result.deleted === false && result.outcome === 'rejected');
        if (definite) shell().mutations.settle(tracked);
        else shell().mutations.unknown(tracked);
        return result;
      } catch (error) {
        if (error && typeof error === 'object' && refusedError(error)) shell().mutations.settle(tracked);
        else shell().mutations.unknown(tracked);
        throw error;
      }
    },
    onSuccess: (result: Report) => {
      if (!current()) return;
      if (result.deleted !== true || result.errors?.length || (result.outcome !== undefined && result.outcome !== 'applied')) {
        const rejected = result.deleted === false && result.outcome === 'rejected';
        setBlocked(!rejected);
        notify(rejected ? 'rejected' : 'uncertain');
        if (!rejected) void shell().undo.refresh();
        toast(rejected ? (result.errors?.[0]?.message ?? say('theRowWasNotDeleted')) : UNKNOWN, 'error');
        return;
      }
      void shell().undo.refresh();
      /* The reader is on the list by the time they read this; Undo puts the
         record back into it (the list and its counts refresh, the reader stays). */
      toast(
        say('deleted', { name: table.name, label }),
        'ok',
        shell().undo.toast(result.undoId, () => countsChanged()),
      );
      notify('applied');
      /* Back to the table, not to the record that no longer exists. */
      if (host) {
        if (current())
          try {
            host.onDeleted();
          } catch {
            /* a confirmed deletion is never retried */
          }
      } else go({ kind: 'table', table: table.id, query: table.id, tab: 'rows' }, 'reset');
      // One row fewer on every count of the connection, the menu's included.
      countsChanged();
    },
    onError: (err: Error & { status?: number; outcome?: string }) => {
      if (!current()) return;
      const rejected = refusedError(err);
      setBlocked(!rejected);
      notify(rejected ? 'rejected' : 'uncertain');
      if (!rejected) void shell().undo.refresh();
      toast(rejected ? err.message : UNKNOWN, 'error');
    },
  });
  const impact = report.impact ?? [];
  const blocked = impact.some((i) => i.onDelete === 'restrict' || i.onDelete === 'no action');
  return (
    <Modal className="confirm delete-confirm" ref={dialog} onClose={onClose}>
      <h2>{say('deleteNameLabel', { name: table.name, label })}</h2>
      {impact.length ? (
        <div>
          <p>{say('thisRowIsReferenced')}</p>
          <ul className="delete-impact">
            {impact.map((i, k) => {
              const rule = i.onDelete ? CONSEQUENCE[i.onDelete] : undefined;
              return (
                <li key={k} className={`impact-${rule?.tone ?? 'unknown'}`}>
                  <span className="impact-what">
                    {i.count < 0
                      ? say('couldNotBeCounted', { table: i.table })
                      : rule
                        ? rule.says(rows(i.count), i.table)
                        : say('inThisConstraintsRule', { rows: rows(i.count), table: i.table })}
                  </span>
                  <span className="impact-rule">{i.onDelete ? say('onDeleteRule', { rule: i.onDelete }) : say('ruleUnknown')}</span>
                </li>
              );
            })}
          </ul>
          {impact.some((i) => i.onDelete === 'cascade') && <p className="delete-note">{say('cascadesAreCountedOne')}</p>}
        </div>
      ) : (
        <p>{say('nothingPointsAtThis')}</p>
      )}
      {blocked && <p className="delete-blocked">{say('theDatabaseWillRefuse')}</p>}
      <div className="confirm-actions">
        <Button intent="secondary" onClick={onClose}>
          {say('common.cancel')}
        </Button>
        <Button
          intent="danger"
          onClick={() => {
            if (submitted.current || !current()) return;
            // Fail closed if the host cannot retain the pending operation. This
            // runs before closing the nested confirmation or dispatching a write.
            try {
              host?.onStateChange('pending');
            } catch {
              return;
            }
            if (!current()) return;
            submitted.current = true;
            setBlocked(true);
            onClose();
            remove.mutate();
          }}
        >
          {blocked ? say('tryAnyway') : 'Delete'}
        </Button>
      </div>
    </Modal>
  );
}
