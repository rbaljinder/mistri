/**
 * packages/kit/src/client/shellHost.ts as an embedded shell has it: the same names, each
 * answered by the host the shell is bound to (../binding.ts) instead of the
 * document's globals. vite.embed.config.ts puts this module wherever the
 * shell imports that one; test/embed-seams.test.ts holds the two to the same
 * exports.
 */
import { drawPopupsIn } from '@mistriwork/ui/popups.js';
import { measureFrom } from '@mistriwork/ui/ruler.js';
import { announceNavigation, binding, onEmbedNavigation } from '../binding.js';

export const shellRoot = (): HTMLElement => binding().root;

export const shellBody = (): HTMLElement => binding().body;

export const portalRoot = (): HTMLElement => binding().portals;

/* Base UI would choose the document's body, outside the scoped sheets and the density zoom. */
export const popupContainer = (): HTMLElement | undefined => binding().portals;

export const shellById = (id: string): HTMLElement | null => binding().root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);

export const shellQuery = <E extends Element = HTMLElement>(selector: string): E | null => binding().root.querySelector<E>(selector);

export const shellQueryAll = <E extends Element = HTMLElement>(selector: string): NodeListOf<E> =>
  binding().root.querySelectorAll<E>(selector);

export function setTabTitle(title: string): void {
  binding().title(title);
}

/* The host's origin is the server's (its handler answers there), so a choice the server reads is a cookie as served. */
export function setHostCookie(name: string, value: string): void {
  const secure = window.location.protocol === 'https:' ? ['secure'] : [];
  document.cookie = [`${name}=${encodeURIComponent(value)}`, 'path=/', 'max-age=31536000', 'samesite=lax', ...secure].join(';');
}

/* The tab's icon is the host page's. */
export const tabIcon = (): HTMLLinkElement | null => null;

type Options = boolean | AddEventListenerOptions;

/*
 * A key pressed in the host's own page is not the shell's: `/` in the host's
 * search box must not jump to the shell's. Keys whose target is outside the
 * shell are kept from its window and document handlers; a key with no target
 * of its own (focus on the body, nowhere in particular) still reaches them,
 * as it does when served, and none does while the shell is parked.
 */
const KEYS = new Set(['keydown', 'keyup', 'keypress']);
const wrapped = new WeakMap<object, Map<string, EventListener>>();

function hostsKey(event: Event): boolean {
  const { root } = binding();
  if (!root.isConnected) return true;
  const target = event.target;
  if (!(target instanceof Node) || target === document.body || target === document.documentElement || target === document) return false;
  return !root.contains(target);
}

function shellOnly(type: string, fn: EventListenerOrEventListenerObject): EventListenerOrEventListenerObject {
  if (!KEYS.has(type)) return fn;
  let byType = wrapped.get(fn);
  if (!byType) wrapped.set(fn, (byType = new Map()));
  let guard = byType.get(type);
  if (!guard) {
    guard = (event: Event) => {
      if (hostsKey(event)) return;
      if (typeof fn === 'function') fn(event);
      else fn.handleEvent(event);
    };
    byType.set(type, guard);
  }
  return guard;
}

export function addHostListener<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  fn: (event: WindowEventMap[K]) => unknown,
  options?: Options,
): () => void;
export function addHostListener<K extends keyof DocumentEventMap>(
  target: Document,
  type: K,
  fn: (event: DocumentEventMap[K]) => unknown,
  options?: Options,
): () => void;
export function addHostListener(target: EventTarget, type: string, fn: EventListenerOrEventListenerObject, options?: Options): () => void;
export function addHostListener(target: EventTarget, type: string, fn: EventListenerOrEventListenerObject, options?: Options): () => void {
  const listener = shellOnly(type, fn);
  target.addEventListener(type, listener, options);
  return () => target.removeEventListener(type, listener, options);
}

export function removeHostListener<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  fn: (event: WindowEventMap[K]) => unknown,
  options?: Options,
): void;
export function removeHostListener<K extends keyof DocumentEventMap>(
  target: Document,
  type: K,
  fn: (event: DocumentEventMap[K]) => unknown,
  options?: Options,
): void;
export function removeHostListener(target: EventTarget, type: string, fn: EventListenerOrEventListenerObject, options?: Options): void;
export function removeHostListener(target: EventTarget, type: string, fn: EventListenerOrEventListenerObject, options?: Options): void {
  target.removeEventListener(type, shellOnly(type, fn), options);
}

export const navState = (): any => binding().navigator.current().state ?? null;

export const navPush = (href: string, walk: unknown = null): void => binding().navigator.push(href, walk);

export const navReplace = (href: string, walk: unknown = null): void => binding().navigator.replace(href, walk);

export const onNavigate = (fn: () => void, _options?: Options): (() => void) => onEmbedNavigation(fn);

export function navFollow(href: string): void {
  navPush(href);
  announceNavigation();
}

/* The ui primitives (packages/ui) measure against the page's root and draw their popups where Base UI chooses, which
   is the served shell's answer; bound to a host, they take the host's, as everything above does. */
measureFrom(shellRoot);
drawPopupsIn(popupContainer);
