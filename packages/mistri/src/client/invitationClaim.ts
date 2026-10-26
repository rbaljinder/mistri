/**
 * Claiming an account-creating invitation, signed out: the one-time token the
 * inviter handed over, a name and a password make a native account under the
 * invitation's email address, and accept the invitation for it. The server
 * owns every decision; this reads its answer into what the form says next.
 *
 * The address is not verified: the token is what vouches for the person, and
 * it works once. Account creation and acceptance happen in two stores, so an
 * answer may say the account exists while the invitation still waits: the
 * person then signs in and accepts it with the same token.
 */
import { INVITATION_HTTP_ROOT } from '../shared/tenantInvitations.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';

export type ClaimOutcome =
  | Readonly<{ kind: 'claimed'; email: string; tenantId: string }>
  /** The name or password was refused before the token was looked at. */
  | Readonly<{ kind: 'invalid' }>
  /** The token is not one that can be claimed now — whatever the reason. */
  | Readonly<{ kind: 'refused' }>
  /** The invitation's address already has an account: sign in and accept. */
  | Readonly<{ kind: 'existing' }>
  /** The account was made; the acceptance was not confirmed. */
  | Readonly<{ kind: 'incomplete' }>
  | Readonly<{ kind: 'limited'; retryAfter: number }>
  | Readonly<{ kind: 'unknown' }>;

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export async function claimInvitation(
  appId: string,
  input: Readonly<{ token: string; name: string; password: string }>,
): Promise<ClaimOutcome> {
  let response: Response;
  try {
    response = await fetchServer(`${INVITATION_HTTP_ROOT}/claim?${new URLSearchParams({ app: appId })}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: input.token, name: input.name, password: input.password }),
    });
  } catch {
    return { kind: 'unknown' };
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { kind: 'unknown' };
  }
  if (!object(data)) return { kind: 'unknown' };
  if (
    response.status === 200 &&
    data.outcome === 'applied' &&
    data.account === 'created' &&
    typeof data.email === 'string' &&
    object(data.result) &&
    data.result.status === 'accepted' &&
    typeof data.result.tenantId === 'string'
  ) {
    return { kind: 'claimed', email: data.email, tenantId: data.result.tenantId };
  }
  if (response.status === 400 && data.code === 'invalid_account') return { kind: 'invalid' };
  if (response.status === 403 && data.code === 'tenant_invitation_unavailable' && data.outcome === 'not_applied')
    return { kind: 'refused' };
  if (response.status === 409 && data.code === 'account_exists') return { kind: 'existing' };
  if (response.status === 429 && Number.isSafeInteger(data.retryAfter)) return { kind: 'limited', retryAfter: data.retryAfter as number };
  if (response.status === 503 && data.code === 'claim_incomplete' && data.account === 'created') return { kind: 'incomplete' };
  return { kind: 'unknown' };
}
