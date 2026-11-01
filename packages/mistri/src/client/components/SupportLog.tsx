/**
 * A dealer's own log of support visits into its tenant.
 *
 * The lender can read this dealer's records under an audited support session.
 * This is the other half of that: the dealer sees who came in, when, why, and
 * what they did. It shows, it does not gate — there is no approve or block
 * here, by decision; ending access is administration's.
 *
 * It carries the operator's name and never their email, because the dealer is
 * owed the fact of the visit and the person, not a way to correlate the
 * lender's staff. Columns the viewer's own grants do not cover are withheld by
 * the server and said as a count, so a change is never silently shown short.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@mistriwork/kit/client/core.js';
import { formatDateTime } from '@mistriwork/kit/client/locale.js';
import { SUPPORT_LOG_PATH, type SupportLogChange, type SupportLogReply, type SupportLogSession } from '../../shared/tenantSupportLog.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import './SupportLog.css';
import { say } from '../copy/tenancy/components/SupportLog.js';
import { roleName } from '../tenantNames.js';

const when = (value: string) => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? formatDateTime(at) : value;
};
/** How a visit ended, in the dealer's words rather than the store's. */
const ENDINGS: Record<string, string> = {
  exit: 'left',
  expired: say('timedOut'),
  revoked: 'revoked',
  parent_revoked: say('accessRevoked'),
  tenant_inactive: say('tenantClosed'),
  superseded: say('replacedByANewer'),
};

function Change({ change }: { change: SupportLogChange }) {
  const columns = [...new Set([...Object.keys(change.before ?? {}), ...Object.keys(change.after ?? {})])];
  return (
    <li>
      <p className="support-log-change-head">
        <bdi>{change.resource}</bdi> · {change.operation} · <time>{when(change.at)}</time>
      </p>
      {columns.length > 0 && (
        <dl>
          {columns.map((column) => (
            <div key={column}>
              <dt>
                <bdi>{column}</bdi>
              </dt>
              <dd>
                {change.before && column in change.before && (
                  <>
                    <s>{String(change.before[column] ?? '—')}</s>{' '}
                  </>
                )}
                {change.after && column in change.after ? String(change.after[column] ?? '—') : null}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {change.withheld.length > 0 && (
        <p className="support-log-withheld">
          {change.withheld.length === 1 ? say('n1MoreColumnWas') : say('moreColumnsWereChanged', { withheldCount: change.withheld.length })}{' '}
          {say('thatYourAccessDoes')}
        </p>
      )}
    </li>
  );
}

/** One visit; `children` is what a reader beyond the dealer is also owed (the platform's audit says which dealer, and who). */
export function Visit({ session, children }: { session: SupportLogSession; children?: ReactNode }) {
  return (
    <li className="support-log-visit">
      {children}
      <p className="support-log-who">
        <bdi>{session.operatorName}</bdi>
        {' · '}
        <bdi>{session.realmLabel}</bdi>
        {say('dotAs')} <bdi>{roleName(session.dealerRole)}</bdi>
        {session.state === 'active' && (
          <span className="support-log-live">
            {' '}
            · <span aria-hidden="true">●</span> {say('hereNow')}
          </span>
        )}
      </p>
      <p className="support-log-when">
        <time>{when(session.openedAt)}</time>
        {session.endedAt !== null && (
          <>
            {' '}
            — <time>{when(session.endedAt)}</time>
          </>
        )}
        {session.endReason !== null && <> · {ENDINGS[session.endReason] ?? session.endReason}</>}
      </p>
      <p className="support-log-reason">
        {say('reasonColon')} <q>{session.reason}</q>
      </p>
      <p className="support-log-counts">
        {session.reads === 1 ? say('n1Read') : say('reads', { reads: session.reads })}
        {' · '}
        {session.changes.length === 1 ? say('n1Change') : say('changes', { changesCount: session.changes.length })}
      </p>
      {session.changes.length > 0 && (
        <ul className="support-log-changes">
          {session.changes.map((change, index) => (
            <Change key={`${change.at}-${index}`} change={change} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Loaded once when it opens: a log is read, not watched. */
export function SupportLog({ onClose }: { onClose: () => void }) {
  const [reply, setReply] = useState<SupportLogReply | null>(null);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const answer = (await api(SUPPORT_LOG_PATH)) as unknown as SupportLogReply;
        if (live) setReply(answer);
      } catch {
        if (live) setError(say('theSupportLogCould'));
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  return (
    <Modal className="support-log" ariaLabel={say('supportVisits')} fullscreen="mobile" onClose={onClose}>
      <header>
        <h2>{say('supportVisits')}</h2>
        <button type="button" className="ghost" aria-label={say('closeSupportVisits')} onClick={onClose}>
          ×
        </button>
      </header>
      <p className="note">{say('everyTimeSupportEntered')}</p>
      {error && <p role="alert">{error}</p>}
      {!reply && !error && <p role="status">{say('loadingSupportVisits')}</p>}
      {reply && reply.sessions.length === 0 && <p role="status">{say('noOneHasEntered')}</p>}
      {reply && reply.sessions.length > 0 && (
        <ul className="support-log-visits">
          {reply.sessions.map((session) => (
            <Visit key={session.supportId} session={session} />
          ))}
        </ul>
      )}
      {reply?.more && <p className="note">{say('theNewestVisitsOlder', { sessionsCount: reply.sessions.length })}</p>}
    </Modal>
  );
}
