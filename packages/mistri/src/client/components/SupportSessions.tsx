/**
 * The platform's audit of support sessions: every visit into every tenant,
 * read on a platform lease by a role granted `supportAudit`
 * (GET /api/tenant/support/sessions, tenantHttp.ts). A dealer's own log
 * (SupportLog.tsx) is the same visits, one tenant at a time and without the
 * operator's email; this is the one view that carries it. It shows and never
 * gates: ending a session is the support flow's.
 */
import { useEffect, useState } from 'react';
import { api } from '@mistriwork/kit/client/core.js';
import { SUPPORT_SESSIONS_PATH, type SupportAuditReply } from '../../shared/tenantSupportLog.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import { Visit } from './SupportLog.js';
import './SupportLog.css';
import { say } from '../copy/tenancy/components/SupportSessions.js';
import { tenantNames } from '../tenantNames.js';

/** Loaded once when it opens: an audit is read, not watched. */
export function SupportSessions({ onClose }: { onClose: () => void }) {
  const [reply, setReply] = useState<SupportAuditReply | null>(null);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const answer = (await api(SUPPORT_SESSIONS_PATH)) as unknown as SupportAuditReply;
        if (live) setReply(answer);
      } catch {
        if (live) setError(say('failed'));
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  const names = tenantNames();
  return (
    <Modal className="support-log" ariaLabel={say('supportSessions')} fullscreen="mobile" onClose={onClose}>
      <header>
        <h2>{say('supportSessions')}</h2>
        <button type="button" className="ghost" aria-label={say('closeSupportSessions')} onClick={onClose}>
          ×
        </button>
      </header>
      <p className="note">{say('everySession')}</p>
      {error && <p role="alert">{error}</p>}
      {!reply && !error && <p role="status">{say('loading')}</p>}
      {reply && reply.sessions.length === 0 && <p role="status">{say('none')}</p>}
      {reply && reply.sessions.length > 0 && (
        <ul className="support-log-visits">
          {reply.sessions.map((session) => (
            <Visit key={session.supportId} session={session}>
              <p className="support-log-when">
                <bdi>{say('into', { tenant: names[session.tenantId] ?? session.tenantId })}</bdi>
                {session.operatorEmail && (
                  <>
                    {' · '}
                    <bdi>{session.operatorEmail}</bdi>
                  </>
                )}
              </p>
            </Visit>
          ))}
        </ul>
      )}
      {reply?.more && <p className="note">{say('newest', { count: reply.sessions.length })}</p>}
    </Modal>
  );
}
