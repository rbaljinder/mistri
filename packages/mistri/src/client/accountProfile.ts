import { profileName, type AccountProfile } from '../shared/accountProfile.js';
import { assertSessionCurrent, sessionIdentity, type SessionIdentitySnapshot } from '@mistriwork/kit/client/sessionIdentity.js';
import { invalidateSession } from '@mistriwork/kit/client/sessionLifecycle.js';
import { say } from './copy/account/accountProfile.js';
import { served } from '@mistriwork/kit/client/addressMount.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';

export class AccountProfileError extends Error {
  constructor(
    message: string,
    readonly outcome: 'not_applied' | 'unknown',
  ) {
    super(message);
  }
}

function profile(value: unknown, owner: SessionIdentitySnapshot): AccountProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(say('invalidProfile'));
  const p = value as Record<string, unknown>;
  if (
    p.accountId !== owner.accountId ||
    p.appId !== owner.appId ||
    typeof p.name !== 'string' ||
    p.name.length > 4096 ||
    typeof p.email !== 'string' ||
    p.email.length > 4096 ||
    !Array.isArray(p.providers) ||
    p.providers.length > 100 ||
    p.providers.some((provider) => typeof provider !== 'string' || provider.length > 256)
  )
    throw new Error(say('invalidProfile'));
  return {
    accountId: p.accountId as string,
    appId: p.appId as string,
    name: p.name,
    email: p.email,
    providers: [...p.providers],
    ...(p.emailChange === true ? { emailChange: true as const } : {}),
    ...(p.connectedClients === true ? { connectedClients: true as const } : {}),
  };
}

async function request(owner: SessionIdentitySnapshot, name?: string): Promise<AccountProfile> {
  const saving = name !== undefined;
  assertSessionCurrent(owner);
  if (owner.mode !== 'authenticated') throw new AccountProfileError(say('signInToView'), 'not_applied');
  try {
    const response = await fetchServer(`/api/auth/profile?${new URLSearchParams({ app: owner.appId! })}`, {
      method: saving ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
      headers: { 'x-mistri-account': owner.accountId!, ...(saving ? { 'content-type': 'application/json' } : {}) },
      ...(saving ? { body: JSON.stringify({ name }) } : {}),
    });
    if (sessionIdentity() === owner && response.status === 401) invalidateSession('expired');
    if (
      sessionIdentity() === owner &&
      response.headers.get('x-mistri-account') &&
      response.headers.get('x-mistri-account') !== owner.accountId
    )
      invalidateSession('account-changed');
    assertSessionCurrent(owner, response.headers.get('x-mistri-account'));
    const body: unknown = await response.json();
    assertSessionCurrent(owner, response.headers.get('x-mistri-account'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(say('invalidProfileResponse'));
    const data = body as Record<string, unknown>;
    if (!response.ok) {
      if (data.outcome === 'not_applied')
        throw new AccountProfileError(
          data.code === 'profile_busy' ? say('aProfileSaveIsStill') : say('theProfileRequestWasNotApplied'),
          'not_applied',
        );
      throw new Error(say('unconfirmedProfileResponse'));
    }
    const result = profile(data.profile, owner);
    if (saving && (data.outcome !== 'applied' || result.name !== name)) throw new Error(say('unconfirmedProfileSave'));
    return result;
  } catch (error) {
    if (error instanceof AccountProfileError) throw error;
    throw new AccountProfileError(
      saving ? say('theProfileSaveCould') : say('yourProfileCouldNotBeLoaded'),
      saving ? 'unknown' : 'not_applied',
    );
  }
}

export const loadAccountProfile = (owner: SessionIdentitySnapshot) => request(owner);
export function saveAccountProfile(owner: SessionIdentitySnapshot, input: string): Promise<AccountProfile> {
  const name = profileName(input);
  if (name === undefined) return Promise.reject(new AccountProfileError(say('enterANameBetween'), 'not_applied'));
  return request(owner, name);
}

/** Asks for the address to change: a link goes to the new one, and, where the old one was verified, a notice to it.
    Nothing changes until the links are followed, so the profile still reads the old address afterwards. */
export async function requestEmailChange(owner: SessionIdentitySnapshot, newEmail: string): Promise<void> {
  assertSessionCurrent(owner);
  if (owner.mode !== 'authenticated') throw new AccountProfileError(say('signInToView'), 'not_applied');
  const address = newEmail.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254)
    throw new AccountProfileError(say('enterAnEmailAddress'), 'not_applied');
  let response: Response;
  try {
    response = await fetchServer('/api/auth/change-email', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newEmail: address, callbackURL: served('/') }),
    });
  } catch {
    throw new AccountProfileError(say('theEmailChangeCouldNotBeRequested'), 'unknown');
  }
  assertSessionCurrent(owner);
  if (!response.ok) throw new AccountProfileError(say('theEmailChangeWasNotRequested'), 'not_applied');
}
