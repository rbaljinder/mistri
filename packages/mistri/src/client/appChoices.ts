/**
 * An App's `choose` in the browser: the rows this person picked (the site they work at), kept where the next visit
 * finds them and sent with every request (the kit's shell answer `chosen`, core.js).
 *
 * A pick is kept per person, per App and per tenant, so a member of two clinics keeps a site in each. The server keeps
 * it for the person (server/app/appPreferences.ts) and tells the shell what it holds with the App's payload
 * (`picks`), so a new tab or another device starts where the last pick left off; the tab's own store holds the tab's
 * pick, so two tabs may work at two sites without one changing the other underneath it. Only what the tab holds that
 * the server does not is sent as `x-mistri-chosen`, and the server falls back to its own for the rest. Where the
 * database keeps no preferences store the payload has no `picks`, and the browser's local store does what the server
 * would. Neither is believed: the server reads each picked row again under the reader on every request
 * (server/app/appChoices.ts), so a pick that is no longer theirs reads as nothing chosen. No cookie, and not the
 * address: a link sent to a colleague opens at their own site.
 */
import type { ServedChoice } from '@mistriwork/engine/shared/servedApp.js';
import type { SessionIdentitySnapshot } from '@mistriwork/kit/client/sessionIdentity.js';

/* A row key the server would take (appChoices.ts KEY_MAX): anything longer is not a pick it sent. */
const KEY_MAX = 128;

/* What this tab picked, by key, for a browser that keeps nothing: a pick still holds until the page is left. */
const held = new Map<string, string | null>();

let version = 0;
const listeners = new Set<() => void>();

/**
 * Where one pick is kept for this reader: the App, the account and the tenant, so another person on this browser, or
 * this person in another tenant, starts with nothing picked. Null where there is no signed-in reader to keep it for,
 * or a tenant App whose tenant is not chosen yet.
 */
export function choiceKey(owner: SessionIdentitySnapshot, name: string): string | null {
  if (owner.mode !== 'authenticated' || !owner.accountId || !owner.appId) return null;
  if (owner.tenantRequired && !owner.tenant) return null;
  return `mistri.chosen.v1:${encodeURIComponent(JSON.stringify([owner.appId, owner.accountId, owner.tenant?.tenantId ?? null, name]))}`;
}

function stored(storage: () => Storage, key: string): string | null {
  try {
    const value = storage().getItem(key);
    return value && value.length <= KEY_MAX ? value : null;
  } catch {
    /* A browser that keeps nothing (a private window's quota, a blocked store): nothing is picked. */
    return null;
  }
}

/**
 * One pick as this tab holds it: the tab's own first, then what the server holds for the person (`picks`, the App's
 * payload), and with no server store the browser's last; null for none.
 */
export function readChoice(owner: SessionIdentitySnapshot, name: string, picks?: Readonly<Record<string, string>>): string | null {
  const key = choiceKey(owner, name);
  if (!key) return null;
  const tab = stored(() => sessionStorage, key);
  if (tab !== null) return tab;
  return picks === undefined ? stored(() => localStorage, key) : (picks[name] ?? null);
}

/**
 * Keep a pick, or forget it (null), in this tab and for the next one: the browser's local store too where the server
 * keeps none (`onServer` false); where it does, the caller sends it there (ChoiceControl.tsx).
 */
export function writeChoice(owner: SessionIdentitySnapshot, name: string, value: string | null, onServer = false): void {
  const key = choiceKey(owner, name);
  if (!key) return;
  for (const storage of onServer ? [() => sessionStorage] : [() => sessionStorage, () => localStorage]) {
    try {
      if (value === null) storage().removeItem(key);
      else storage().setItem(key, value);
    } catch {
      /* Kept nowhere: the tab still sends it until it is reloaded, through `held`. */
    }
  }
  held.set(key, value);
  version++;
  for (const listener of [...listeners]) listener();
}

/**
 * Every declared pick this tab holds that the server does not, by name: what the shell sends as `x-mistri-chosen`. A
 * pick the server holds for the person it sends itself (a request with no header is read as the stored pick), so a
 * tab that has not moved off it sends nothing, and the page's first paint, drawn with the stored picks, stands.
 */
export function chosenNow(
  owner: SessionIdentitySnapshot,
  choose: Readonly<Record<string, ServedChoice>> | undefined,
  picks?: Readonly<Record<string, string>>,
): Record<string, string> {
  const chosen: Record<string, string> = {};
  for (const name of Object.keys(choose ?? {})) {
    const value = heldChoice(owner, name, picks);
    if (value && value !== picks?.[name]) chosen[name] = value;
  }
  return chosen;
}

/** One pick this tab holds, by name: what it was told this visit, else the tab's, else the server's (or the browser's). */
export function heldChoice(owner: SessionIdentitySnapshot, name: string, picks?: Readonly<Record<string, string>>): string | null {
  const key = choiceKey(owner, name);
  if (key && held.has(key)) return held.get(key)!;
  return readChoice(owner, name, picks);
}

/** Told whenever a pick changes, so a chooser and the rooms that read one draw again. */
export function subscribeChoices(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A number that moves with every pick, for `useSyncExternalStore`. */
export const choicesVersion = (): number => version;

export { choiceEntries, setChoiceEntry, subscribeChoiceEntries, type ChoiceEntry } from '@mistriwork/kit/client/choiceEntries.js';
