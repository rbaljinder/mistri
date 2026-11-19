/**
 * `useOpenTenant('createClinicProfile')`: open a tenant in one request from a platform App's own screen. The App's
 * platform command runs first, through the same command path as `useCommand`, under a key derived from the request key;
 * then the administration door's `openTenant` creates the tenant and issues its first invitation, journaled under that
 * key. The profile step is not atomic with the other two: a failure after it leaves the profile written and the tenant
 * not yet opened, and `open` sent again with the same key completes the rest without running anything twice (each step
 * answers a run it already has with its receipt). The same key with other details is refused and applies nothing.
 */
import { useCallback, useRef, useState } from 'react';
import { captureAccountIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import type {
  AdministrationOpenTenantAttempt,
  AdministrationOpenTenantResult,
  AdministrationSession,
} from '../../../shared/tenantAdministration.js';
import { openAdministration, openTenant } from '../../tenantAdministration.js';
import type { UiCommandRef } from './context.js';
import { useCommand } from './hooks.js';
import { say } from '../../copy/components/components/sdk/openTenant.js';

interface UiOpenTenantInput {
  /** The request's key, made once for this intent and kept (in the address, say) so a retry after a reload is the same request. */
  key: string;
  /** The platform command's input. */
  input?: Readonly<Record<string, unknown>>;
  tenant: AdministrationOpenTenantAttempt['tenant'];
  invitation: AdministrationOpenTenantAttempt['invitation'];
}

interface UiOpenTenant {
  /** Resolves with the opened tenant, or null when it did not open (`error` says why); send it again with the same key to complete it. */
  open(input: UiOpenTenantInput): Promise<AdministrationOpenTenantResult | null>;
  pending: boolean;
  error: Error | null;
  result: AdministrationOpenTenantResult | null;
}

const KEY = /^[A-Za-z0-9_-]{16,128}$/;

/** The profile run's key: a UUID named by the request key (`${key}:profile`), so every retry sends the same run. */
export async function profileAttempt(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${key}:profile`)));
  // A name-based UUID's version and variant bits (RFC 9562), so the command path reads it as the UUID it asks for.
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function useOpenTenant(ref: UiCommandRef): UiOpenTenant {
  const command = useCommand(ref);
  const [state, setState] = useState<{ pending: boolean; error: Error | null; result: AdministrationOpenTenantResult | null }>({
    pending: false,
    error: null,
    result: null,
  });
  const session = useRef<AdministrationSession | null>(null);
  const open = useCallback(
    async (request: UiOpenTenantInput): Promise<AdministrationOpenTenantResult | null> => {
      setState({ pending: true, error: null, result: null });
      const fail = (error: Error) => (setState({ pending: false, error, result: null }), null);
      try {
        if (typeof request.key !== 'string' || !KEY.test(request.key)) return fail(new TypeError(say('keyIsInvalid')));
        const attempt = await profileAttempt(request.key);
        const ran = await command.run({}, request.input ?? {}, { attempt, quiet: true });
        if (ran.status !== 'applied') {
          return fail(new Error(ran.status === 'closed' ? say('profileNotApplied', { label: command.label }) : ran.message));
        }
        // The record the profile command made, where it says one; else its receipt, which the attempt names.
        const made = (ran.output as { id?: unknown } | undefined)?.id;
        const profile = typeof made === 'string' || typeof made === 'number' ? String(made) : attempt;
        const owner = captureAccountIdentity();
        const held = session.current;
        const admin =
          held && held.accountId === owner.accountId && held.appId === owner.appId && held.expiresAt > Date.now() + 5_000
            ? held
            : (session.current = await openAdministration(owner));
        if (!admin) return fail(new Error(say('noAdministration')));
        const result = await openTenant(owner, admin, {
          key: request.key,
          profile,
          tenant: request.tenant,
          invitation: request.invitation,
        });
        setState({ pending: false, error: null, result });
        return result;
      } catch (error) {
        // A session the door no longer honors is asked for again on the retry.
        session.current = null;
        return fail(error instanceof Error ? error : new Error(String(error)));
      }
    },
    [command],
  );
  return { open, pending: state.pending, error: state.error, result: state.result };
}
