/**
 * The account-administration trail, as the accounts screen shows it: every
 * change an administrator made here, and every account the operator's
 * maintenance step or an invitation's claim made, newest first, read from the auth store
 * where each was written in the change's own transaction
 * (server/auth/accountAudit.ts). Every account's, or one account's.
 *
 * Three facts a row, under the table's rule like the account list: when, what
 * changed (and for whom, on the whole trail), and who changed it. Nothing is
 * a target; a row is read, not opened.
 */
import { useEffect, useRef, useState } from 'react';
import { ACCOUNT_AUDIT_PAGE, ADMIN_ROLE, type AccountAuditEntry, type AccountAuditPage } from '../../shared/accountAdministration.js';
import { listAccountTrail } from '../accountAdministration.js';
import { roleLabel } from '@mistriwork/kit/client/roleLabels.js';
import type { SessionIdentitySnapshot } from '@mistriwork/kit/client/sessionIdentity.js';
import { formatDateTime } from '@mistriwork/kit/client/locale.js';
import { Button } from '@mistriwork/ui/Button.js';
import { say } from '../copy/account/components/AccountTrail.js';

/** A role as a person reads it: the App's label for it, else its name with the underscores spoken. */
export const roleName = (role: string) =>
  roleLabel(role) ??
  (role === ADMIN_ROLE ? say('administrator') : role.replace(/[_-]+/g, ' ').replace(/^./, (first) => first.toUpperCase()));

const rolesSaid = (value: unknown) => (Array.isArray(value) && value.length ? value.map(String).map(roleName).join(', ') : 'none');

/** What a row changed, in a sentence: the fields as they were and became. */
function changeSaid(entry: AccountAuditEntry): string {
  const after = entry.after ?? {},
    before = entry.before ?? {};
  switch (entry.action) {
    case 'create':
      return say('added', { rolesSaid: rolesSaid(after.roles) });
    case 'setRoles':
      return say('rolesChanged', { before: rolesSaid(before.roles), after: rolesSaid(after.roles) });
    case 'deactivate':
      return say('deactivated');
    case 'reactivate':
      return say('reactivated');
    case 'setPassword':
      return after.sessionsEnded === true ? say('newPasswordSessionsEnded') : say('newPassword');
    default:
      return say('changed');
  }
}

/* Who, and through what when it was not their own session: an administrator
   impersonating them, the operator's maintenance step (which has no account),
   an invitation whose holder made their own account by claiming it, or an
   identity provider's claims at a sign-in (auth/identityRoles.ts), named by
   its label. */
function bySaid(entry: AccountAuditEntry) {
  if (entry.principal === 'maintenance') return say('maintenance');
  const through = entry.principal.startsWith('impersonation:')
    ? 'impersonated'
    : entry.principal.startsWith('invitation:')
      ? say('byInvitation')
      : entry.principal.startsWith('sign-in:')
        ? say('atSignIn')
        : '';
  return (
    <>
      {entry.actorEmail}
      {through && <span className="account-admin-email">{through}</span>}
    </>
  );
}

export function AccountTrail({
  owner,
  current,
  accountId,
}: {
  owner: SessionIdentitySnapshot;
  current: () => boolean;
  accountId?: string;
}) {
  const [page, setPage] = useState<AccountAuditPage | null>(null);
  const [problem, setProblem] = useState('');
  const [loading, setLoading] = useState(true);
  const asked = useRef(0);
  const load = async (from: number) => {
    const ask = ++asked.current;
    setLoading(true);
    try {
      const answer = await listAccountTrail(owner, from, accountId);
      if (current() && ask === asked.current) {
        setPage(answer);
        setProblem('');
      }
    } catch (error) {
      if (current() && ask === asked.current) setProblem(error instanceof Error ? error.message : say('theHistoryCouldNotBeLoaded'));
    } finally {
      if (current() && ask === asked.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load(0);
  }, [accountId]);

  const range =
    page && page.entries.length
      ? say('changesRange', { first: page.offset + 1, last: page.offset + page.entries.length, total: page.total })
      : '';
  return (
    <>
      {problem && (
        <p className="account-admin-said alert" role="alert">
          {problem}
        </p>
      )}
      {loading && !page && <p role="status">{say('loadingHistory')}</p>}
      {page && !page.entries.length && <p className="note">{accountId ? say('noChangesToThisAccount') : say('noChangesHaveBeen')}</p>}
      {page && page.entries.length > 0 && (
        <>
          <div className="account-admin-heads account-trail-heads" aria-hidden="true">
            <span>{say('when')}</span>
            <span>{say('change')}</span>
            <span>{say('by')}</span>
          </div>
          <ul className="account-admin-list account-trail" aria-label={say('changes', { range })}>
            {page.entries.map((entry) => (
              <li key={entry.id}>
                <span className="account-admin-fact">
                  <span className="account-admin-caption">{say('when')} </span>
                  <time dateTime={entry.at}>{formatDateTime(entry.at)}</time>
                </span>
                <span className="account-admin-fact">
                  <span className="account-admin-caption">{say('change')} </span>
                  {changeSaid(entry)}
                  {!accountId && <span className="account-admin-email">{entry.targetEmail}</span>}
                </span>
                <span className="account-admin-fact">
                  <span className="account-admin-caption">{say('by')} </span>
                  {bySaid(entry)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {page && page.total > ACCOUNT_AUDIT_PAGE && (
        <nav className="account-admin-pager" aria-label={say('historyPages')}>
          <span>{range}</span>
          <Button
            intent="secondary"
            size="compact"
            disabled={page.offset === 0 || loading}
            onClick={() => void load(Math.max(0, page.offset - ACCOUNT_AUDIT_PAGE))}
          >
            {say('newer')}
          </Button>
          <Button
            intent="secondary"
            size="compact"
            disabled={page.offset + page.entries.length >= page.total || loading}
            onClick={() => void load(page.offset + ACCOUNT_AUDIT_PAGE)}
          >
            {say('older')}
          </Button>
        </nav>
      )}
    </>
  );
}
