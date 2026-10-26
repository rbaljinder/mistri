/**
 * addressMount.js, as a server render reads it (vite.config.ts `ssrAddressMount`
 * puts this file in its place for the server renderer only). The page's
 * module reads its mount from the page; a render has no page, so each call
 * asks for the mount of the request being rendered (requestMount.ts). The
 * client bundle never contains this file.
 */
import { inward, outward, serverPath } from '@mistriwork/engine/shared/mount.js';
import { currentMount } from './requestMount.js';

/** A render has no address bar; the server rendered for the address it was asked. */
export function herePath(): string {
  return inward(currentMount(), '/') ?? '/';
}

export function shown(internal: string): string {
  return outward(currentMount(), internal);
}

/* A visitor's tenant placement (`?via=`) is read from the address bar and
   kept only once who-am-I says so (addressMount.js): both happen in the page,
   after the render. A render places nothing, so its links are the unplaced ones
   and the page adds the placement when it keeps one. */
export function arrivedPlacement(): string | null {
  return null;
}

export function keepPlacement(_keep: boolean): string | null {
  return null;
}

export function publicPlacement(): string | null {
  return null;
}

export function shownUnplaced(internal: string): string {
  return shown(internal);
}

/* An App's own file (a font, a stylesheet, a component's chunk) is addressed
   as the page addresses it; a render places nothing, so both are `shown`. */
export function appFile(internal: string): string {
  return shown(internal);
}

export function appFileUnplaced(internal: string): string {
  return shown(internal);
}

export function served(path: string): string {
  return serverPath(currentMount(), path);
}

/** Nor a query string: the render answers the address alone, as herePath does. */
export function hereSearch(): string {
  return '';
}
