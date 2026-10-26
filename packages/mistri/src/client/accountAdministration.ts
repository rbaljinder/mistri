/**
 * The accounts screen's requests: `/api/accounts`, as the signed-in account
 * that opened it. Each carries the account it was opened as, so a request
 * made after a sign-out or a switch in another tab is refused by the server
 * (the stale-account precondition) rather than made as somebody else.
 */
import type { AccountAuditPage, AccountChange, AccountSummary, AccountsPage } from '../shared/accountAdministration.js';
import { assertSessionCurrent, type SessionIdentitySnapshot } from '@mistriwork/kit/client/sessionIdentity.js';
import { invalidateSession } from '@mistriwork/kit/client/sessionLifecycle.js';
import { say } from './copy/account/accountAdministration.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';

/** A change that was not made, or whose outcome is not known, in the reader's words. */
class AccountAdminError extends Error {
  constructor(
    message: string,
    readonly outcome: 'not_applied' | 'unknown',
  ) {
    super(message);
  }
}

async function request<T>(
  owner: SessionIdentitySnapshot,
  method: 'GET' | 'POST',
  query: Record<string, string>,
  body?: AccountChange,
): Promise<T> {
  assertSessionCurrent(owner);
  if (owner.mode !== 'authenticated') throw new AccountAdminError(say('signInToManage'), 'not_applied');
  let response: Response;
  try {
    response = await fetchServer(`/api/accounts?${new URLSearchParams({ app: owner.appId!, ...query })}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
      headers: { 'x-mistri-account': owner.accountId!, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify({ app: owner.appId, ...body }) } : {}),
    });
  } catch {
    throw new AccountAdminError(body ? say('theChangeCouldNotBeConfirmed') : say('theAccountsCouldNot'), body ? 'unknown' : 'not_applied');
  }
  if (response.status === 401) invalidateSession('expired');
  assertSessionCurrent(owner, response.headers.get('x-mistri-account'));
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    /* said below */
  }
  if (!response.ok) {
    throw new AccountAdminError(
      typeof data.error === 'string' ? data.error : say('theAccountsCouldNotBeReached'),
      data.outcome === 'unknown' ? 'unknown' : 'not_applied',
    );
  }
  return data as T;
}

export const listAccounts = (owner: SessionIdentitySnapshot, search: string, offset: number) =>
  request<AccountsPage>(owner, 'GET', { ...(search.trim() ? { q: search.trim() } : {}), ...(offset ? { offset: String(offset) } : {}) });

export const changeAccount = (owner: SessionIdentitySnapshot, change: AccountChange) =>
  request<{ account: AccountSummary }>(owner, 'POST', {}, change).then((answer) => answer.account);

/** A page of the account-administration trail, newest first: every account's, or one account's. */
export const listAccountTrail = (owner: SessionIdentitySnapshot, offset: number, accountId?: string) =>
  request<AccountAuditPage>(owner, 'GET', {
    trail: '1',
    ...(accountId ? { account: accountId } : {}),
    ...(offset ? { offset: String(offset) } : {}),
  }).then((page) => ({
    entries: Array.isArray(page.entries) ? page.entries : [],
    total: Number(page.total) || 0,
    offset: Number(page.offset) || 0,
  }));
