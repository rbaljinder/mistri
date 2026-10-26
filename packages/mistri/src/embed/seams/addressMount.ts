/**
 * packages/kit/src/client/addressMount.js as an embedded shell has it. Two bases, where
 * the served page has one: the address bar's (`/rentals`, where the host shows
 * the App, read from the host's router) and the server's (`/api/tw`, the
 * Provider's endpoint). The shell's inside addresses — `/lintel/leases/12` —
 * are unchanged; only their two outward forms move apart.
 */
import { inward, outward } from '@mistriwork/engine/shared/mount.js';
import { binding } from '../binding.js';

/** The address in its inside form: `/rentals/leases/12` with Lintel at the host's `/rentals` is `/lintel/leases/12`. */
export function herePath(): string {
  const { navigator, address } = binding();
  const { pathname } = navigator.current();
  return inward(address, pathname) ?? pathname;
}

export function hereSearch(): string {
  return binding().navigator.current().search;
}

export function shown(internal: string): string {
  return outward(binding().address, internal);
}

/* A tenant's public address (`?via=`) places a visitor who arrived on the
   App's own page. An embedded shell has no such visitor: the host signs its
   reader in through the Provider, and the query string it reads is the host's
   router's, so a `via` there is the host's parameter, never a placement. */
export function arrivedPlacement(): string | null {
  return null;
}

export function keepPlacement(_keep: boolean): string | null {
  return null;
}

export function publicPlacement(): string | null {
  return null;
}

/** With no placement, every address is already unplaced. */
export function shownUnplaced(internal: string): string {
  return shown(internal);
}

/**
 * One of an App's own files (`/ladle/_components/<file>`, a theme's `/ladle/_fonts/…` and `/ladle/_brand/…`) at the
 * Provider's endpoint, not under the host's address: `/api/tw/_components/<file>`. The endpoint serves the App at its root, as the handler does, so the App's segment
 * goes; the address bar's prefix (`/staff`) is the host's and serves no file of the App's.
 */
export function appFile(internal: string): string {
  const apps = Object.fromEntries(Object.keys(binding().address.apps).map((id) => [id, '']));
  return binding().endpoint + outward({ base: '', apps }, internal);
}

/** With no placement, every App file is already unplaced. */
export function appFileUnplaced(internal: string): string {
  return appFile(internal);
}

/** A server path (`/api/…`, `/_mistri/…`) at the Provider's endpoint. */
export function served(path: string): string {
  return binding().endpoint + path;
}
