/**
 * Every place the shell touches the page around it: the address bar and its
 * history, the tab's title, the root element that carries the look, the
 * density zoom and the tokens, the body its chrome hangs classes on, where
 * popups are drawn, which document its ids are looked up in, and the
 * listeners it puts on the window and the document.
 *
 * Served, the page is the shell's own, and each of these is exactly the
 * global it names. They are gathered here so that the shell can one day run
 * inside a page that is not its own — a React host's route, with the host's
 * router owning the history, the host's `<title>`, a `.tw-root` element in
 * place of `<html>` — by changing this module rather than four hundred call
 * sites. test/check-client-host.mjs keeps it the only place: a new
 * `window.history`, `document.title`, `document.documentElement`, `document.body`,
 * document-wide lookup or window/document listener elsewhere fails the check.
 *
 * Kept tiny on purpose: it is on every first page, and the budget there is
 * counted in hundreds of bytes (scripts/bundle-budget.mjs).
 */

/** The element the look, the color scheme, the density zoom and the tokens are written on. */
export const shellRoot = (): HTMLElement => document.documentElement;

/** The element the shell's chrome hangs its state classes on (`app-mode`, `sidebar-hidden`, …). */
export const shellBody = (): HTMLElement => document.body;

/** Where a floating panel, a dialog or a measuring mirror is appended. */
export const portalRoot = (): HTMLElement => document.body;

/**
 * The container handed to Base UI's portals. Undefined lets Base UI choose,
 * which is the body — or the enclosing portal for a popup inside a popup,
 * which an explicit body would not keep.
 */
export const popupContainer = (): HTMLElement | undefined => undefined;

/** The shell's element with this id. */
export const shellById = (id: string): HTMLElement | null => document.getElementById(id);

/** The shell's first element matching a selector. */
export const shellQuery = <E extends Element = HTMLElement>(selector: string): E | null => document.querySelector<E>(selector);

/** Every shell element matching a selector. */
export const shellQueryAll = <E extends Element = HTMLElement>(selector: string): NodeListOf<E> => document.querySelectorAll<E>(selector);

/** Say what the tab shows. */
export function setTabTitle(title: string): void {
  document.title = title;
}

/** Keep a choice the server reads with every request (a reader's language, messages.ts) for a year, on every path of this origin. */
export function setHostCookie(name: string, value: string): void {
  const secure = window.location.protocol === 'https:' ? ['secure'] : [];
  document.cookie = [`${name}=${encodeURIComponent(value)}`, 'path=/', 'max-age=31536000', 'samesite=lax', ...secure].join(';');
}

/** The tab's icon, which an App's mark is drawn into; none where the page around the shell keeps its own. */
export const tabIcon = (): HTMLLinkElement | null => document.querySelector<HTMLLinkElement>('link[rel="icon"]');

type Options = boolean | AddEventListenerOptions;

/**
 * A listener on the window or the document, with the remover it needs.
 * Overloaded as the DOM's own `addEventListener` is, so a key handler still
 * receives a KeyboardEvent.
 */
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
  target.addEventListener(type, fn, options);
  return () => target.removeEventListener(type, fn, options);
}

/** Take back a listener `addHostListener` put on, where the remover it returned is not to hand. */
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
  target.removeEventListener(type, fn, options);
}

/*
 * The address. Every href below is in the browser's form — through
 * addressMount.js `shown` — and the state is the walk (url.js) the entry
 * stands for, or null.
 */

/** The walk the current history entry carries. */
export const navState = (): any => window.history.state;

/** A new history entry. */
export const navPush = (href: string, walk: unknown = null): void => window.history.pushState(walk, '', href);

/** The current history entry, rewritten. */
export const navReplace = (href: string, walk: unknown = null): void => window.history.replaceState(walk, '', href);

/** Back, Forward, or an address followed by `navFollow`: the shell reads the address again. */
export const onNavigate = (fn: () => void, options?: Options): (() => void) => addHostListener(window, 'popstate', fn, options);

/** Follow an address inside the shell without a reload: a new entry, painted by the `onNavigate` listener. */
export function navFollow(href: string): void {
  navPush(href);
  window.dispatchEvent(new window.PopStateEvent('popstate'));
}
