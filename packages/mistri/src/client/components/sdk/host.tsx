/**
 * The page's side of `@mistriwork/mistri/ui`: the host a component's kit and hooks
 * read (context.ts), over the App payload and the session endpoints, and the
 * page's own modules put on one frozen global for the host modules a
 * served component imports (packages/mistri/src/server/app/componentSdk.ts).
 *
 * Loaded with the first custom section or value renderer a page draws, never
 * before: an App without components pays nothing for it. Every read is an
 * ordinary request under the reader's session (`/api/view/run`,
 * `/api/breakdown`), authorized on the server; a resource is named as the
 * App names it, and one the App does not declare is refused here as a
 * mistake before it is refused there as a denial.
 */
import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
import * as ui from './index.js';
import * as page from './page.js';
import './kit.css';
import { api, columnDisplay, columnLabel, openRecord, pageApi, primaryKey, quote, state } from '@mistriwork/kit/client/core.js';
import { PAGE_LOAD_PATH } from '@mistriwork/engine/shared/pageRoutes.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { sessionIdentity, subscribeSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { batchedBreakdown } from '@mistriwork/kit/client/breakdownBatch.js';
import { densityChoice } from '@mistriwork/kit/client/density.js';
import { fillComposer as fillPageComposer } from '@mistriwork/kit/client/components/composerDraft.js';
import { tableNamed, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { HOST_GLOBAL } from '../../../shared/uiSdk.js';
import { pageBridge } from '@mistriwork/kit/client/uiBridge.js';
import type { DisplayRule } from '@mistriwork/kit/client/components/valueModel.js';
import { setPageHost, type UiHost, type UiLook, type UiRow } from './context.js';
import { rowsByPath } from './rows.js';
import { sayAppMessage } from './appMessage.js';
import { say } from '../../copy/components/components/sdk/host.js';
import { served, shownUnplaced } from '@mistriwork/kit/client/addressMount.js';
import { viewPath } from '../../publicAddress.js';
import { createPageAppFlags } from '../../appFlags.js';
import { pageAnalyticsBeacon } from '../../analyticsBeacon.js';
import { shellRoot } from '@mistriwork/kit/client/shellHost.js';

function tableOf(resource: string): TableMeta {
  const table = state.schema ? (tableNamed(state.schema, resource) as TableMeta | undefined) : undefined;
  const declared = (pageBridge.activeApp() as { resources?: Record<string, unknown> } | null)?.resources ?? {};
  if (!table || (Object.keys(declared).length && !Object.hasOwn(declared, table.id) && !table.union)) {
    throw new Error(say('isNotOneOfThisApps', { resource }));
  }
  return table;
}

/* A free-form page's own reads say which page asks, so the server holds them to its manifest too. */
async function viewRows(
  table: TableMeta,
  show: readonly string[] | undefined,
  query: string,
  limit: number,
  page?: string,
): Promise<UiRow[]> {
  const paths = show?.length ? [...show] : table.columns.map((column) => column.name);
  const body = {
    count: 'none' as const,
    ...(query.trim() ? { query: query.trim() } : {}),
    view: { id: `ui:${table.id}`, name: table.name, base: table.id, columns: paths.map((path) => ({ path })), limit },
  };
  const got = page ? await pageApi(page, '/api/view/run', body) : await api('/api/view/run', body);
  return rowsByPath(paths, got, say('theRowsOfCould', { name: table.name }), { schema: state.schema, base: table.id });
}

const root = () => shellRoot();

function look(): UiLook {
  const attribute = root().dataset.theme;
  const dark = attribute === 'dark' || (!attribute && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const density = densityChoice() as UiLook['density'];
  return { look: root().dataset.visualTheme ?? 'workshop', mode: dark ? 'dark' : 'light', density };
}

let flags: ReturnType<typeof createPageAppFlags> | undefined;
let beacon: ReturnType<typeof pageAnalyticsBeacon> | undefined;
const pageHost: UiHost = {
  analytics: { emit: (name, fields) => (beacon ??= pageAnalyticsBeacon()).emit(name, fields) },
  get flags() {
    return (flags ??= createPageAppFlags(() => {
      const app = pageBridge.activeApp() as { id?: string } | null;
      return app?.id && app.id === state.activeConnection ? app.id : null;
    }));
  },
  /* The connection and the session's epoch: a sign-in, a sign-out or another account never reads another's cached rows. */
  get scope() {
    return [state.activeConnection ?? '', sessionIdentity().epoch];
  },
  rows(resource, { query, show, sort, limit, page }) {
    const table = tableOf(resource);
    return viewRows(table, show, [query ?? '', sort ? `sort ${sort}` : ''].join(' '), limit ?? 20, page);
  },
  async record(resource, key, show, asking = {}) {
    const table = tableOf(resource);
    const where = (primaryKey(table) as string[]).map((column) => `${column} = ${quote(String(key[column]))}`).join(' and ');
    return (await viewRows(table, show, where, 1, asking.page))[0];
  },
  async breakdown(resource, { by, measure, query, limit, page }) {
    const table = tableOf(resource);
    const text = [table.id, query ?? '', `${measure ?? 'count'} by ${by}`].filter(Boolean).join(' ');
    /* A page's breakdown is asked alone: a batch is many sections' and carries no one page's name. */
    const got = page
      ? ((await pageApi(page, '/api/breakdown', { text, ...(limit ? { limit } : {}) })) as { rows?: UiRow[] })
      : await batchedBreakdown<{ rows?: UiRow[] }>({ text, limit });
    return got.rows ?? [];
  },
  async load(page, params) {
    /* A tenant's lease answers a refusal as a reply, not a throw (tenantTransport.ts): it is the page's error either way. */
    const got = (await pageApi(page, PAGE_LOAD_PATH, { page, params })) as { data?: unknown; error?: unknown };
    if (typeof got.error === 'string') throw new Error(got.error);
    return got.data;
  },
  openRecord(resource, key, options = {}) {
    const table = tableOf(resource);
    const label = options.label ?? '';
    if ((options.mode === 'drawer' || options.mode === 'modal') && pageBridge.openPeek)
      pageBridge.openPeek(table.id, { ...key }, label, options.mode);
    else void openRecord(table.id, { ...key }, label);
  },
  openView(view, options) {
    if (!pageBridge.openView?.(view, options)) throw new Error(say('isNotAList', { view }));
  },
  /* The page's command pipeline and forms, registered by sdk/commands.tsx (uiBridge.ts says why). */
  openForm(view, prefill = {}) {
    if (!pageBridge.commands) throw new Error(say('thePageCannotOpen'));
    pageBridge.commands.openForm(view, prefill);
  },
  /* A tenant's link to hand out: a view a visitor reads by the tenant's public address, a public
     form (never one of the payload's rooms) by its intake address. Only the tenant's own lease is served them. */
  publicLink(view) {
    const app = pageBridge.activeApp() as { id?: string; views?: object; addresses?: { intake?: string; public?: string } } | null;
    if (!app?.id || typeof view !== 'string' || !view) return undefined;
    const room = Boolean(app.views && Object.hasOwn(app.views, view));
    const address = room ? app.addresses?.public : app.addresses?.intake;
    const path = room ? viewPath(view) : `/${encodeURIComponent(app.id)}/form/${encodeURIComponent(view)}`;
    if (!address || !path) return undefined;
    return `${window.location.origin}${shownUnplaced(path)}?via=${encodeURIComponent(address)}`;
  },
  fillComposer(text, mode) {
    return fillPageComposer(text, mode);
  },
  fileAddress(resource, key, options = {}) {
    const table = tableOf(resource);
    return served(
      `/api/file?${new URLSearchParams({
        ...ownedBy(state.activeConnection ?? null),
        table: table.id,
        key: JSON.stringify(key),
        inline: '1',
        ...(options.thumbnail ? { variant: 'thumb' } : {}),
      })}`,
    );
  },
  command: (ref, page) =>
    pageBridge.commands?.command(ref, page) ?? {
      label: ref,
      granted: false,
      available: async () => false,
      run: async () => ({ status: 'refused', message: say('thisPageCannotRun') }),
      open: async () => ({ status: 'refused', message: say('thisPageCannotRun') }),
    },
  viewer() {
    const identity = sessionIdentity();
    return identity.mode === 'authenticated' && identity.accountId ? { signedIn: true, account: identity.accountId } : { signedIn: false };
  },
  subscribeViewer: (listener) => subscribeSessionIdentity(listener),
  column(resource, name) {
    const table = state.schema ? (tableNamed(state.schema, resource) as TableMeta | undefined) : undefined;
    if (!table) return undefined;
    return {
      meta: table.columns.find((column) => column.name === name),
      rule: columnDisplay(table.id, name) as DisplayRule | null,
      label: (columnLabel(table.id, name) as string | null) ?? name,
    };
  },
  look,
  token: (name) => getComputedStyle(root()).getPropertyValue(name).trim(),
  subscribeLook(listener) {
    const observer = new MutationObserver(listener);
    observer.observe(root(), { attributes: true, attributeFilter: ['data-theme', 'data-visual-theme', 'data-palette', 'style', 'class'] });
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener?.('change', listener);
    return () => {
      observer.disconnect();
      media?.removeEventListener?.('change', listener);
    };
  },
  get app() {
    return pageBridge.inAppMode();
  },
  message: (key, args) =>
    sayAppMessage((pageBridge.activeApp() as { messages?: Readonly<Record<string, readonly unknown[]>> } | null)?.messages, key, args),
};

/* The page's modules, for the host modules a component's bare imports reach.
   Frozen: a component may read them, and none may swap one for another. */
if (!(HOST_GLOBAL in globalThis)) {
  Object.defineProperty(globalThis, HOST_GLOBAL, {
    value: Object.freeze({
      modules: Object.freeze({
        react: React,
        'react/jsx-runtime': JsxRuntime,
        'react-dom': ReactDOM,
        '@mistriwork/mistri/ui': ui,
        '@mistriwork/mistri/page': page,
      }),
    }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
}
setPageHost(pageHost);
