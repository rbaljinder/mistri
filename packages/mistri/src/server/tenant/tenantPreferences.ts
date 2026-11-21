/**
 * A tenant App's picks (an App's `choose`) for one member in one tenant, kept in the preferences store beside the
 * tenant source (app/appPreferences.ts): the scope is the tenant's id, so a pick made in one tenant is never read in
 * another. The store is the host's own and the lease names whose pick it is; nothing a request says chooses another
 * member or tenant. Absent a store, picks stay in the browser, as a single App's do.
 */
import type { PreferencesStore } from '../../adapters/preferences/preferences.js';
import type { AppDef } from '../../shared/appModel.js';
import { provenPicks, readChosen } from '../app/appChoices.js';
import { chooseBody } from '../app/appChoosing.js';
import { storedPicks, storePick } from '../app/appPreferences.js';

type Reader = Parameters<typeof provenPicks>[2];
type Schema = Parameters<typeof provenPicks>[1];

/** A lease's member and tenant, as text: both or neither. A platform or support lease holds neither. */
const memberOf = (principal: unknown): { account: string; tenant: string } | undefined => {
  const { accountId, tenantId } = (principal ?? {}) as { accountId?: unknown; tenantId?: unknown };
  return typeof accountId === 'string' && typeof tenantId === 'string' ? { account: accountId, tenant: tenantId } : undefined;
};

export function tenantPreferences(app: AppDef, opened: () => Promise<PreferencesStore | undefined>) {
  return Object.freeze({
    /** What this member stored in this tenant, by choice name: nothing where there is no store (a command's fallback). */
    stored: async (account: string | undefined, tenant: string | undefined): Promise<Record<string, string>> =>
      app.choose && account && tenant ? storedPicks(app, await opened(), account, tenant) : {},
    /** What this lease's member stored in their tenant: nothing for a lease that is no member's (`own` false). */
    storedFor: async (principal: unknown, own: boolean): Promise<Record<string, string>> => {
      const member = own ? memberOf(principal) : undefined;
      return member ? storedPicks(app, await opened(), member.account, member.tenant) : {};
    },
    /** The payload's `picks` for this lease's member; undefined where nothing is kept or the lease is no member's. */
    picksFor: async (principal: unknown, own: boolean, schema: Schema, reader: Reader): Promise<Record<string, string> | undefined> => {
      const member = own ? memberOf(principal) : undefined;
      const store = member && app.choose ? await opened() : undefined;
      return member && store ? provenPicks(app, schema, reader, await storedPicks(app, store, member.account, member.tenant)) : undefined;
    },
    /**
     * `/api/choose`: one pick kept for the lease's own member in the lease's own tenant. The lease names both, and the
     * value is read again under `reader` before it is stored. True where it was kept, else the refusal to answer with.
     */
    choose: async (
      principal: unknown,
      schema: Schema,
      reader: Reader,
      input: unknown,
    ): Promise<true | { status: number; body: Record<string, unknown> }> => {
      if (!app.choose) return { status: 404, body: { error: 'Not found.', code: 'not_found' } };
      const member = memberOf(principal);
      if (!member) return { status: 403, body: { error: 'Not available.' } };
      let asked: ReturnType<typeof chooseBody>;
      try {
        asked = chooseBody(app, input as Record<string, unknown>);
      } catch (error) {
        return { status: 400, body: { error: error instanceof Error ? error.message : 'Invalid choice.' } };
      }
      const store = await opened();
      if (!store) return { status: 409, body: { error: 'This deployment keeps no choices for people.', code: 'preferences_unavailable' } };
      if (asked.value !== null) {
        const proven = await readChosen(app, schema, reader, new URLSearchParams({ [asked.name]: asked.value }).toString());
        if (proven?.[asked.name] == null) return { status: 422, body: { error: 'That is not a choice you can make.' } };
      }
      await storePick(app, store, member.account, member.tenant, asked.name, asked.value);
      return true;
    },
  });
}

export type TenantPreferences = ReturnType<typeof tenantPreferences>;
