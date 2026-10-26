/**
 * The address, as an embedded shell reads and writes it.
 *
 * Served, the shell owns the window's history: it pushes, it replaces, and
 * `popstate` tells it about Back and Forward (packages/kit/src/client/shellHost.ts).
 * Embedded in a React app, the history is the host router's, and the shell
 * borrows it: a `Navigator` is the four things the shell needs of
 * whichever router owns the address, and nothing else.
 *
 * The walk that reached an entry (url.js) rides in that entry's state under
 * `mistri`, beside whatever the router keeps there itself (React Router's
 * `usr`/`key`/`idx`, Next's tree), never in place of it. A router that keeps
 * no state degrades, not breaks: the canonical address alone reopens the
 * room, as a cold link does.
 *
 * Nothing here touches `window` until it is called, so the module can be
 * imported where there is none (a server render).
 */

/** Where the shell is, in the address bar's form: `/crm/leads/127`, `?tab=working`, and the walk. */
export interface Location {
  pathname: string;
  search: string;
  /** This entry's mistri state (the walk), never the host's. */
  state: unknown;
}

export interface Navigator {
  /** The browser address in its outward form, and this entry's mistri state (never the host's). */
  current(): Location;
  push(href: string, state: unknown): void;
  replace(href: string, state: unknown): void;
  /** Called on every navigation the shell did not make itself (Back, a host link). Returns its remover. */
  listen(onChange: () => void): () => void;
  /** Leave the single-page app: sign-out, a deploy reload. Default: location.assign. */
  hard?(href: string): void;
}

/** The key the walk is kept under in a history entry's state. */
const STATE_KEY = 'mistri';

/** This entry's mistri part, from whatever object the router keeps in the entry. */
export const walkOf = (state: unknown): unknown =>
  state && typeof state === 'object' && STATE_KEY in state ? ((state as Record<string, unknown>)[STATE_KEY] ?? null) : null;

const splitHref = (href: string): { pathname: string; search: string } => {
  const url = new URL(href, 'http://x');
  return { pathname: url.pathname, search: url.search };
};

/**
 * The default, for a host with no router of its own (or one that only reads
 * the address): `window.history`, the walk namespaced in the entry, and
 * `popstate` for Back and Forward.
 */
export function browserNavigator(): Navigator {
  return {
    current: () => ({ pathname: window.location.pathname, search: window.location.search, state: walkOf(window.history.state) }),
    /* A new entry carries only ours: the host's state belonged to the entry it was written for. */
    push: (href, state) => window.history.pushState({ [STATE_KEY]: state }, '', href),
    /* The same entry, rewritten: what the host kept in it stays. */
    replace: (href, state) => {
      const kept = window.history.state && typeof window.history.state === 'object' ? window.history.state : {};
      window.history.replaceState({ ...kept, [STATE_KEY]: state }, '', href);
    },
    listen: (onChange) => {
      window.addEventListener('popstate', onChange);
      return () => window.removeEventListener('popstate', onChange);
    },
    hard: (href) => window.location.assign(href),
  };
}

/** What a router adapter can do; `routerNavigator` makes a navigator of it. */
export interface RouterMoves {
  /** The router's location now, with the state of its entry as the router keeps it. */
  read(): Location;
  /** Navigate to a new entry whose state is `entry`; the router's own state for the entry it leaves is not carried. */
  push(href: string, entry: Record<string, unknown>): void;
  /** Rewrite the current entry, keeping what the router holds in its state and adding `entry` beside it. */
  replace(href: string, entry: Record<string, unknown>): void;
  hard?(href: string): void;
}

/**
 * A navigator over a router, and `hostMoved` for the adapter to call each
 * time the router's location changes.
 *
 * A router tells its subscribers about every change, the shell's own pushes
 * among them; the shell must hear only the others (a `popstate` never fires
 * for a push). So the last address the shell wrote is remembered, and the
 * change that lands on it is the shell's. A router may also apply a push a
 * moment later (a data router navigates asynchronously): until it has, the
 * address the shell wrote is the one `current` says, so the shell never reads
 * back the address it just left.
 */
export function routerNavigator(moves: RouterMoves): Navigator & { hostMoved(): void } {
  const listeners = new Set<() => void>();
  let written: { href: string; state: unknown } | null = null;
  /* What was last announced: a router may report one move twice (Next's popstate and its pathname both). */
  let announced: { href: string; state: unknown } | null = null;
  const hrefOf = (at: { pathname: string; search: string }) => at.pathname + at.search;
  /* The walk is the shell's alone: an adapter hands it back only as the entry's state, under a key it never names. */
  const read = (): Location => {
    const now = moves.read();
    return { pathname: now.pathname, search: now.search, state: walkOf(now.state) };
  };
  const write = (how: 'push' | 'replace', href: string, state: unknown) => {
    const { pathname, search } = splitHref(href);
    written = { href: pathname + search, state };
    announced = null;
    moves[how](href, { [STATE_KEY]: state });
  };
  return {
    current() {
      const now = read();
      if (written && hrefOf(now) !== written.href) return { ...splitHref(written.href), state: written.state };
      return now;
    },
    push: (href, state) => write('push', href, state),
    replace: (href, state) => write('replace', href, state),
    listen(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    hard: moves.hard ?? ((href) => window.location.assign(href)),
    hostMoved() {
      const now = read();
      const href = hrefOf(now);
      const ours = written !== null && href === written.href;
      written = null;
      if (ours) return;
      if (announced && announced.href === href && announced.state === now.state) return;
      announced = { href, state: now.state };
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * An address of its own, in memory, for a single surface (a list, a record,
 * a dashboard): the surface never writes the host's address bar. `reset`
 * moves it when the surface's props change; `refuse` lets the surface turn a
 * push down (a record the host opens itself) and send the shell back.
 */
export function memoryNavigator(
  initial: string,
  options: { refuse?: (href: string) => boolean } = {},
): Navigator & { reset(href: string): void } {
  const entries: Array<{ href: string; state: unknown }> = [{ href: initial, state: null }];
  let at = 0;
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    current: () => ({ ...splitHref(entries[at].href), state: entries[at].state }),
    push(href, state) {
      if (options.refuse?.(href)) {
        /* Turned down after the shell had already moved: it reads the entry it is still on. */
        queueMicrotask(tell);
        return;
      }
      entries.splice(at + 1, entries.length, { href, state });
      at = entries.length - 1;
    },
    replace(href, state) {
      entries[at] = { href, state };
    },
    listen(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    hard: (href) => window.location.assign(href),
    reset(href) {
      entries.splice(0, entries.length, { href, state: null });
      at = 0;
      tell();
    },
  };
}
