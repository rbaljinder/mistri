/**
 * Which page an embedded shell is in: the elements that stand for `<html>`,
 * `<body>` and the popups' layer, the router that owns the address, where
 * the server is, and how a request proves who sent it.
 *
 * The client's seams (packages/kit/src/client/shellHost.ts, addressMount.js,
 * transport.ts) are exactly the globals they name when served. The embed
 * build swaps each for its twin in ./seams/ (vite.embed.config.ts,
 * `seamsForEmbed`), and every twin reads the binding set here. So the shell's
 * four hundred call sites are the same code in both builds, and the served
 * client does not carry a byte of this.
 */
import type { AddressMount } from '@mistriwork/engine/shared/mount.js';
import type { Navigator } from './navigator.js';

export interface EmbedBinding {
  /** Stands for `<html>`: the look, the color scheme, the density zoom and the tokens are written on it. */
  root: HTMLElement;
  /** Stands for `<body>`: the chrome, and the classes the shell hangs on it. */
  body: HTMLElement;
  /** Where popups, dialogs and measuring mirrors are appended: inside `body`, so the scoped sheets reach them. */
  portals: HTMLElement;
  /** The address: the host's router for a whole App, an address in memory for a single surface. */
  navigator: Navigator;
  /** Where the host shows the App (`/crm`) and which App is at its root: the address bar's form. */
  address: AddressMount;
  /** Where the server answers: `/api/tw`, or `https://tw.example.com/tools`. No trailing slash. */
  endpoint: string;
  /** The `Authorization` header a request carries (a cross-origin embed session), or undefined for the cookie. */
  authorization(): string | undefined;
  /** What the shell would put in the tab's title. The tab is the host's. */
  title(text: string): void;
}

let bound: EmbedBinding | null = null;
const navigated = new Set<() => void>();
let unlisten: (() => void) | null = null;

/*
 * A router tells its listeners from inside its own render's effects (React
 * Router's `useLocation`, an adapter's `useEffect`), and the shell answers a
 * navigation by drawing, some of it with `flushSync`. React refuses to flush
 * from inside another root's commit, so the shell hears a move a microtask
 * later, as it hears a `popstate` after the event, not during it.
 */
const heard = () => queueMicrotask(announceNavigation);

/** The page the shell is in. The shell's modules are loaded only after `bind`, so it is always there when asked. */
export function binding(): EmbedBinding {
  if (!bound) throw new Error('@mistriwork/mistri/react: the shell ran before its host was bound.');
  return bound;
}

/** Whether a host is bound (a seam asked from a test, or after `unbind`). */
export const isBound = (): boolean => bound !== null;

/** Point the seams at a host. Listens to its navigator for the moves the shell did not make. */
export function bind(next: EmbedBinding): void {
  unlisten?.();
  bound = next;
  unlisten = next.navigator.listen(heard);
}

/** Change the navigator (a surface's props moved it, or a parked shell is re-attached under another). */
export function rebindNavigator(navigator: Navigator): void {
  binding().navigator = navigator;
  unlisten?.();
  unlisten = navigator.listen(heard);
}

/** Stop hearing the host's navigations: a parked shell does not follow an address it is not shown at. */
export function pauseNavigation(): void {
  unlisten?.();
  unlisten = null;
}

/** Hear them again, after `pauseNavigation`. */
export function resumeNavigation(): void {
  unlisten?.();
  unlisten = binding().navigator.listen(heard);
}

export function unbind(): void {
  unlisten?.();
  unlisten = null;
  bound = null;
}

/** The shell's `onNavigate` listeners, which a `popstate` would have reached when served. */
export function onEmbedNavigation(listener: () => void): () => void {
  navigated.add(listener);
  return () => navigated.delete(listener);
}

/** Tell the shell to read the address again. */
export function announceNavigation(): void {
  for (const listener of [...navigated]) listener();
}
