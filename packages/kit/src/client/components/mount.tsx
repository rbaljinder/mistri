/**
 * Where React meets the rest of the client.
 *
 * The workbench is hand-written DOM and stays that way; app mode is being
 * rebuilt as components, one surface at a time, starting with the ones
 * still being built. Each surface crosses over here: a vanilla caller hands
 * a host element and gets a React tree drawn into it, plus a way to take it
 * down again. Nothing else about the caller changes — app.js still says
 * "show the sign-in screen in #content" the way it always did.
 *
 * One QueryClient for the whole page, so a record the picker fetched and a
 * list the dashboard fetched are the same cache entry, and a write that
 * invalidates one invalidates both.
 */
import { createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryCache, QueryClient, QueryClientProvider, type Query } from '@tanstack/react-query';
import { fileQueryReads, forgetQueryReads } from '../liveReads.js';
import { sessionIdentity } from '../sessionIdentity.js';
import { ListNavigationProvider } from './listNavigation.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { shellRoot } from '../shellHost.js';

/**
 * What a tab coming back to the front re-reads.
 *
 * Query's default is everything stale, and with a five-second staleTime that
 * was everything: a dashboard re-ran all its aggregates each time its tab
 * was alt-tabbed back to, fourteen requests a glance, hundreds a working
 * day. Now a return re-reads what is older than a minute, and the record on
 * screen always — the one read whose change someone is likely to have come
 * back to see. A query says it is that read with `meta: FOCUS_ALWAYS`.
 */
export const FOCUS_ALWAYS = { focus: 'always' } as const;
const FOCUS_AGE = 60_000;
function refetchOnFocus(query: Query<any, any, any, any>): boolean | 'always' {
  // Tenant wake/reconnect is owned by verified lease renewal. Query's
  // browser events otherwise race that check and replace dirty record
  // sections with an unavailable-context error. Renewal explicitly refreshes
  // eligibility; confirmed writes and authored refresh still invalidate data.
  if (sessionIdentity().tenantRequired) return false;
  if (query.meta?.focus === 'always') return 'always';
  return query.state.dataUpdatedAt < Date.now() - FOCUS_AGE;
}

/**
 * Whether a failed read is asked again: only when the server said it was busy
 * (503, code `server_busy`: no connection was free, nothing ran), a few
 * times. Any other refusal is a full sentence and a retry does not change it.
 * A write is never retried here: a mutation does not take this option.
 */
export const BUSY_RETRIES = 3;
export function retryWhenBusy(failures: number, error: unknown): boolean {
  const failed = error as { status?: unknown; code?: unknown } | null;
  return failed?.status === 503 && failed?.code === 'server_busy' && failures < BUSY_RETRIES;
}

/** How long before the next ask: the server's Retry-After, doubled each time, with jitter so a crowd that was refused together does not return together. */
export function busyDelay(failures: number, error: unknown): number {
  const said = (error as { retryAfter?: unknown } | null)?.retryAfter;
  const base = typeof said === 'number' && said > 0 ? said : 1_000;
  return Math.min(base * 2 ** failures, 8_000) * (0.5 + Math.random());
}

const queryCache = new QueryCache({ onSuccess: fileQueryReads });
/* A query the cache lets go of takes its tables with it. */
queryCache.subscribe((event) => {
  if (event.type === 'removed') forgetQueryReads(event.query.queryHash);
});

export const queryClient = new QueryClient({
  queryCache,
  defaultOptions: {
    queries: {
      /* The API answers in full sentences and a retry does not change them;
         a refused request is a refusal, not a blip. Except a busy server's. */
      retry: retryWhenBusy,
      retryDelay: busyDelay,
      staleTime: 5_000,
      refetchOnWindowFocus: refetchOnFocus,
      // As on focus: renewal owns a tenant's reconnect.
      refetchOnReconnect: () => !sessionIdentity().tenantRequired,
    },
  },
});

const roots = new Map<Element, Root>();

/* The vanilla client repaints by replacing whole subtrees, and never
   tells anyone. A tree whose host left the page that way would keep its
   queries and their refetch clocks alive. So one observer over the whole
   document notices any removal and takes down every tree whose host is
   no longer connected. */
let watching = false;
function watch(): void {
  if (watching || typeof MutationObserver === 'undefined') return;
  watching = true;
  new MutationObserver((records) => {
    if (!records.some((r) => r.removedNodes.length)) return;
    for (const host of [...roots.keys()]) if (!host.isConnected) unmount(host);
  }).observe(shellRoot(), { childList: true, subtree: true });
}

/**
 * Draw a tree into a host element. Drawing again into the same host
 * updates the tree in place rather than starting over, which is what a
 * vanilla caller that re-renders on every state change needs.
 */
export function mount(host: Element, tree: ReactNode, takeOver?: (host: Element, tree: ReactNode) => Root): () => void {
  let root = roots.get(host);
  const drawn = rooted(tree);
  if (!root) {
    /* A public page the server drew is taken over where it stands, by the
       public chunk's own starter (serverDrawing.js), not drawn again. */
    root = takeOver ? takeOver(host, drawn) : createRoot(host);
    roots.set(host, root);
    watch();
    if (takeOver) return () => unmount(host);
  }
  root.render(drawn);
  return () => unmount(host);
}

/* Every root stands behind a boundary: a tree that throws while drawing
   says so where it stood rather than leaving its host blank, and the
   browser suites see the mark it leaves (ErrorBoundary.tsx). The server
   draws a public page inside the same wrappers, so the two trees match. */
export function rooted(tree: ReactNode): ReactNode {
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(ListNavigationProvider, null, createElement(ErrorBoundary, null, tree)),
  );
}

/** Whether a tree is already drawn into this host. */
export const isMounted = (host: Element): boolean => roots.has(host);

export function unmountAll(preserve?: Element | null): void {
  for (const host of [...roots.keys()]) if (host !== preserve) unmount(host);
  queryClient.clear();
}

/** Take a tree down and forget the host, so the next mount starts clean. */
export function unmount(host: Element): void {
  const root = roots.get(host);
  if (!root) return;
  roots.delete(host);
  /* Later, not now: React refuses to unmount from inside its own render
     or effect, and a repaint can be one. */
  queueMicrotask(() => root.unmount());
}

/** A fresh element with a tree in it, for callers that insert a node. */
export function element(tag: string, tree: ReactNode, className?: string): HTMLElement {
  const host = document.createElement(tag);
  if (className) host.className = className;
  mount(host, tree);
  return host;
}
