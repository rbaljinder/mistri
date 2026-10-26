/** One availability projection for every presentation of an App's authored nav. */
import { useSyncExternalStore } from 'react';
import type { AppPayloadApp, AppPayloadNavNode } from '../shared/appPayload.js';
import { parseAppTarget, type BoundAppTarget } from '@mistriwork/engine/shared/appLinks.js';
import { appAddressBook, recordSegments } from '../shared/appAddress.js';
import { viewOrder } from '../shared/appModel.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { shown } from '@mistriwork/kit/client/addressMount.js';
import { captureAppTargetLinks, resolveAppTargetLink, subscribeAppTargetLinks } from './appTargetLinks.js';
import {
  captureSessionIdentity,
  subscribeSessionIdentity,
  subscribeTenantLease,
  tenantLeaseActive,
  type SessionIdentitySnapshot,
} from '@mistriwork/kit/client/sessionIdentity.js';
import { addHostListener, removeHostListener } from '@mistriwork/kit/client/shellHost.js';
import type { ShownApp } from '@mistriwork/kit/client/components/appRooms.js';

/** The App a nav target is read against: the kit's reading of it (the sidebar passes the App on screen), with
    the pages and inbox the App framework serves where it has them. */
export type NavTargetApp = Pick<ShownApp, 'nav' | 'views' | 'resources' | 'home'> &
  Partial<Pick<ShownApp, 'id' | 'assistant'>> &
  Partial<Pick<AppPayloadApp, 'pages' | 'inbox'>>;
export const appNavTargetKey = (target: BoundAppTarget): string => {
  try {
    const parsed = parseAppTarget(target) as BoundAppTarget;
    return JSON.stringify(
      parsed.kind === 'record'
        ? { ...parsed, key: Object.fromEntries(Object.entries(parsed.key).sort(([a], [b]) => a.localeCompare(b))) }
        : parsed,
    );
  } catch {
    return '';
  }
};
const empty: ReadonlyMap<string, string> = new Map();
const unavailable = { hrefs: empty, pending: false };
const safeHref = (href: string) => href.startsWith('/') && !href.startsWith('//') && !/[\\\p{Cc}]/u.test(href);

/** Only the current principal's served declarations can supply standalone routes.
 * Native discovery lists memberships but supplies no per-target access projection;
 * explicit tenant intent therefore requires S3 here. */
export function localAppNavTarget(
  app: NavTargetApp,
  schema: DatabaseSchema | null | undefined,
  raw: BoundAppTarget,
  outward: (path: string) => string = shown,
): string | undefined {
  try {
    const target = parseAppTarget(raw) as BoundAppTarget;
    if (!app.id || target.app !== app.id || target.tenant || !schema) return;
    const book = appAddressBook({
      views: app.views,
      order: viewOrder(app),
      resources: app.resources,
      pages: app.pages ?? [],
      tables: schema.tables,
      inbox: app.inbox,
      assistant: app.assistant?.page === true,
      projected: true,
    });
    if (book.problems.length) return;
    let segments: string[] = [];
    if (target.kind === 'home' || target.kind === 'view') {
      const view = target.kind === 'home' ? app.home : target.view;
      if (!view || !Object.hasOwn(app.views, view) || app.views[view].error || !book.views.has(view)) return;
      const declaration = app.views[view];
      if (
        'table' in declaration &&
        (!Object.hasOwn(app.resources, declaration.table) || !schema.tables.some((table) => table.id === declaration.table))
      )
        return;
      if (target.kind === 'view') segments = [encodeURIComponent(book.views.get(view)!)];
    } else {
      const table = tableNamed(schema, target.resource);
      if (!table || !Object.hasOwn(app.resources, table.id)) return;
      const keys = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
      if (!keys.length || keys.length !== Object.keys(target.key).length || keys.some((key) => !Object.hasOwn(target.key, key))) return;
      const record = recordSegments(book, table.id, { key: target.key });
      if (!record) return;
      segments = record;
    }
    const path = `/${encodeURIComponent(app.id)}${segments.length ? `/${segments.join('/')}` : ''}`;
    if (new URL(path, 'http://app-nav.invalid').pathname !== path) return;
    const href = outward(path);
    return safeHref(href) ? href : undefined;
  } catch {
    return;
  }
}

function targets(nav: readonly AppPayloadNavNode[]): BoundAppTarget[] {
  return nav.flatMap((node) => {
    if ('group' in node) return targets(node.children);
    if (!('to' in node)) return [];
    try {
      return [parseAppTarget(node.to) as BoundAppTarget];
    } catch {
      return [];
    }
  });
}
const owners = new WeakMap<object, SessionIdentitySnapshot>();
const stores = new WeakMap<object, Projection>();
const active = new Set<Projection>();
function ownerReady(owner: SessionIdentitySnapshot): boolean {
  return (
    owner === captureSessionIdentity() &&
    (owner.mode === 'authenticated' || owner.mode === 'anonymous') &&
    (!owner.tenantRequired || Boolean(owner.tenant && tenantLeaseActive(owner)))
  );
}
class Projection {
  readonly owner = captureSessionIdentity();
  readonly suite = captureAppTargetLinks();
  readonly listeners = new Set<() => void>();
  controller?: AbortController;
  hrefs: ReadonlyMap<string, string> = empty;
  state = unavailable;
  constructor(
    readonly app: NavTargetApp,
    readonly schema: DatabaseSchema | null | undefined,
  ) {
    if (!owners.has(app) && ownerReady(this.owner)) owners.set(app, this.owner);
  }
  current = () =>
    owners.get(this.app) === this.owner &&
    ownerReady(this.owner) &&
    (!this.app.id || !this.owner.appId || this.app.id === this.owner.appId) &&
    this.suite === captureAppTargetLinks();
  snapshot = () => (this.current() ? this.hrefs : empty);
  stateSnapshot = () => (this.current() ? this.state : unavailable);
  emit = () => {
    for (const listener of this.listeners) listener();
  };
  clear = (pending = false) => {
    this.controller?.abort();
    this.hrefs = empty;
    this.state = { hrefs: empty, pending };
    this.emit();
  };
  refresh = () => {
    const unique = new Map(targets(this.app.nav).map((target) => [appNavTargetKey(target), target]));
    this.clear(this.current() && unique.size > 0);
    if (!this.current() || !unique.size) return;
    const controller = (this.controller = new AbortController());
    const results = [...unique].map(async ([key, target]): Promise<[string, string] | undefined> => {
      // Tenant hosts must obtain fresh target eligibility; no source context is copied.
      const local = !this.suite && target.app === this.app.id && !target.tenant && !this.owner.tenantRequired;
      const result = local
        ? Promise.resolve(localAppNavTarget(this.app, this.schema, target))
        : this.suite
          ? resolveAppTargetLink(this.suite, target, controller.signal).then((result) => result?.href)
          : Promise.resolve(undefined);
      try {
        const href = await result;
        return href && safeHref(href) ? [key, href] : undefined;
      } catch {
        return;
      }
    });
    // A target must arrive with its styles, including when the first authored
    // target appears in a later payload. Ordinary nav loads neither checks nor CSS.
    void Promise.all([Promise.all(results), import('./appNavTargets.css')])
      .then(([entries]) => {
        if (controller.signal.aborted || !this.current()) return;
        this.hrefs = new Map(entries.filter((entry): entry is [string, string] => Boolean(entry)));
        this.state = { hrefs: this.hrefs, pending: false };
        this.emit();
      })
      .catch(() => {
        if (!controller.signal.aborted && this.current()) this.clear();
      });
  };
  wake = () => {
    if (document.visibilityState !== 'hidden') this.refresh();
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      active.add(this);
      this.refresh();
      addHostListener(window, 'focus', this.wake);
      addHostListener(window, 'pageshow', this.wake);
      addHostListener(document, 'visibilitychange', this.wake);
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        active.delete(this);
        this.clear();
        removeHostListener(window, 'focus', this.wake);
        removeHostListener(window, 'pageshow', this.wake);
        removeHostListener(document, 'visibilitychange', this.wake);
      }
    };
  };
}
const retire = () => {
  for (const store of active) if (!store.current()) store.clear();
};
subscribeSessionIdentity(retire);
subscribeTenantLease(retire);
subscribeAppTargetLinks(retire);
function projection(app: NavTargetApp, schema: DatabaseSchema | null | undefined): Projection {
  let store = stores.get(app);
  if (!store || store.schema !== schema || store.owner !== captureSessionIdentity() || store.suite !== captureAppTargetLinks()) {
    store = new Projection(app, schema);
    stores.set(app, store);
  }
  return store;
}
/** Non-React consumers (sidebar keyboard/model) see exactly the mounted projection. */
export function appNavTargetHrefs(app: NavTargetApp, schema: DatabaseSchema | null | undefined): ReadonlyMap<string, string> {
  const store = stores.get(app);
  return store && store.schema === schema ? store.snapshot() : empty;
}
export function refreshAppNavTargets(app: NavTargetApp, schema: DatabaseSchema | null | undefined): void {
  const store = stores.get(app);
  if (store && store.schema === schema) store.refresh();
}
const noSubscribe = () => () => {};
const unavailableSnapshot = () => unavailable;
/** Pending checks retain no hrefs; consumers may keep non-actionable menu scaffolding. */
export function useAppNavTargetState(app: NavTargetApp | null | undefined, schema: DatabaseSchema | null | undefined) {
  useSyncExternalStore(subscribeSessionIdentity, captureSessionIdentity, captureSessionIdentity);
  useSyncExternalStore(subscribeAppTargetLinks, captureAppTargetLinks, captureAppTargetLinks);
  const store = app ? projection(app, schema) : undefined;
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.stateSnapshot ?? unavailableSnapshot, unavailableSnapshot);
}
export function useAppNavTargets(
  app: NavTargetApp | null | undefined,
  schema: DatabaseSchema | null | undefined,
): ReadonlyMap<string, string> {
  return useAppNavTargetState(app, schema).hrefs;
}

/** The nav's targets as the kit's side menu follows them (shellMode.ts `navTargets`). */
export const navTargets = {
  useFollow: useAppNavTargets,
  refresh: refreshAppNavTargets,
  hrefs(app: NavTargetApp, schema: DatabaseSchema | null | undefined) {
    const hrefs = appNavTargetHrefs(app, schema);
    return (target: BoundAppTarget) => hrefs.get(appNavTargetKey(target));
  },
};
