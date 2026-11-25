/**
 * Server-side rendering host for public custom pages (`definePage({ public: true })`).
 *
 * Implements `UiHost` backed by the server's in-process loopback reader and the pre-fetched
 * `firstPaint` answers, collects React Query reads during a fast prefetch pass, and evaluates
 * Rolldown-compiled page modules against the SSR bundle's own React and SDK instances so any
 * custom public site page (home, catalog, directory, article, detail, booking, storefront) arrives
 * fully rendered in the first HTML response — photographs, headings, formatted values, and site
 * chrome included.
 */
import type { ComponentType } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { DatabaseSchema, TableMeta, ColumnMeta } from '@mistriwork/engine/shared/schema.js';
import { findTable, primaryKey, tableNamed } from '@mistriwork/engine/shared/schema.js';
import { COVER_COLUMN } from '@mistriwork/engine/shared/coverPhotos.js';
import { compileWhere } from '@mistriwork/engine/shared/pageWhere.js';
import { andQuery } from '@mistriwork/engine/shared/query.js';
import { readKey } from '@mistriwork/engine/shared/firstPaint.js';
import { PAGE_LOAD_PATH } from '@mistriwork/engine/shared/pageRoutes.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { served, shownUnplaced } from '@mistriwork/kit/client/addressMount.js';
import type { DisplayRule } from '@mistriwork/kit/client/components/valueModel.js';
import type { DashboardDef } from '@mistriwork/kit/client/components/dashboardModel.js';
import type { AppPayloadApp } from '../../shared/appPayload.js';
import { viewOrder } from '../../shared/appModel.js';
import { appAddressBook, recordSegments, viewAddress } from '../../shared/appAddress.js';
import { HOST_MODULES, uiBreakdownText, uiRowsQuery, uiViewRunBody } from '../../shared/uiSdk.js';
import type { UiAddress, UiHost, UiPageFrame, UiRow } from '../components/sdk/context.js';
import { rowsByPath } from '../components/sdk/rows.js';

type SsrLoopReader = (
  method: 'GET' | 'POST',
  target: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<{ status: number; body: unknown }>;

export interface SsrPageInput {
  kind: 'page';
  mount: string;
  app: AppPayloadApp;
  schema: DatabaseSchema;
  viewKey: string;
  dashboard: DashboardDef;
  page: NonNullable<DashboardDef['page']>;
  place: Record<string, string>;
  code: string;
  answers?: Readonly<Record<string, { body: unknown }>>;
  read: SsrLoopReader;
}

const HOST_REGISTRY = Symbol.for('mistri.ssr.host');
const MODULE_CACHE_CAP = 64;
const moduleCache = new Map<string, Promise<ComponentType<Record<string, unknown>>>>();

function hashText(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}_${text.length}`;
}

/** Rewrite static ESM imports of Mistri host modules to read from the SSR bundle's own module registry. */
function rewriteHostImports(code: string): string {
  const hostSet = new Set<string>(Object.keys(HOST_MODULES));
  const access = (spec: string) => `globalThis[Symbol.for('mistri.ssr.host')][${JSON.stringify(spec)}]`;
  let counter = 0;
  /* Side-effect imports: `import "@mistriwork/mistri/views";` */
  let out = code.replace(/(^|[\n;])\s*import\s+(['"])([^'"]+)\2\s*;?/g, (full, lead: string, _q: string, spec: string) =>
    hostSet.has(spec) ? `${lead}/* ssr-host:${spec} */` : full,
  );
  /* Binding imports: default, namespace, named, or default + named. */
  out = out.replace(
    /(^|[\n;])\s*import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\3\s*;?/g,
    (full, lead: string, clause: string, _q: string, spec: string) => {
      if (!hostSet.has(spec)) return full;
      const trimmed = clause.trim();
      const mod = access(spec);
      const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
      if (ns) return `${lead}const ${ns[1]} = ${mod};`;
      const destructure = (named: string) => named.replace(/\b([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)\b/g, '$1: $2');
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        return `${lead}const ${destructure(trimmed)} = ${mod};`;
      }
      const combo = /^([A-Za-z_$][\w$]*)\s*,\s*(\{[\s\S]*\})$/.exec(trimmed);
      if (combo) {
        const tmp = `__ssrMod${counter++}`;
        return `${lead}const ${tmp} = ${mod}; const ${combo[1]} = ${tmp}.default ?? ${tmp}; const ${destructure(combo[2])} = ${tmp};`;
      }
      const def = /^([A-Za-z_$][\w$]*)$/.exec(trimmed);
      if (def) {
        const tmp = `__ssrMod${counter++}`;
        return `${lead}const ${tmp} = ${mod}; const ${def[1]} = ${tmp}.default ?? ${tmp};`;
      }
      return full;
    },
  );
  return out;
}

/** Evaluate a compiled page ESM bundle against the SSR bundle's own host modules (cached by content hash). */
export function loadSsrPageComponent(
  code: string,
  hostModules: Readonly<Record<string, unknown>>,
): Promise<ComponentType<Record<string, unknown>>> {
  (globalThis as Record<PropertyKey, unknown>)[HOST_REGISTRY] = hostModules;
  const key = hashText(code);
  const existing = moduleCache.get(key);
  if (existing) return existing;
  const rewritten = rewriteHostImports(code);
  const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(rewritten)}`;
  const loaded = import(url).then((mod: { default?: ComponentType<Record<string, unknown>> }) => {
    if (typeof mod?.default !== 'function') throw new Error('Compiled page module has no default component export.');
    return mod.default;
  });
  moduleCache.set(key, loaded);
  if (moduleCache.size > MODULE_CACHE_CAP) {
    const oldest = moduleCache.keys().next().value;
    if (oldest !== undefined) moduleCache.delete(oldest);
  }
  loaded.catch(() => {
    if (moduleCache.get(key) === loaded) moduleCache.delete(key);
  });
  return loaded;
}

function resolveSsrColumnMeta(schema: DatabaseSchema, table: TableMeta, path: string): ColumnMeta | undefined {
  const parts = path.split('.');
  let current: TableMeta | undefined = table;
  for (let i = 0; i < parts.length - 1; i++) {
    const fk = schema.foreignKeys.find(
      (each) => each.from.table === current!.id && each.from.columns.length === 1 && each.from.columns[0] === parts[i],
    );
    if (!fk) return undefined;
    current = findTable(schema, fk.to.table);
    if (!current) return undefined;
  }
  const leaf = parts[parts.length - 1]!;
  const own = current.columns.find((c) => c.name === leaf);
  if (own) return own;
  const computed = current.computed && Object.hasOwn(current.computed, leaf) ? current.computed[leaf] : undefined;
  if (computed) return { name: leaf, type: computed.type === 'text' ? 'text' : 'numeric', nullable: true, primaryKey: false };
  const rollup = current.rollups && Object.hasOwn(current.rollups, leaf) ? current.rollups[leaf] : undefined;
  if (rollup) return { name: leaf, type: rollup.fn === 'latest' ? 'text' : 'numeric', nullable: true, primaryKey: false };
  return undefined;
}

const NOOP_FLAGS = {
  ready: () => true,
  snapshot: () => ({}),
  load: async () => {},
  get: () => undefined,
  subscribe: () => () => {},
} as unknown as UiHost['flags'];

const NOOP_ANALYTICS = {
  emit: () => {},
};

/** Create a per-request SSR `UiHost` + `UiPageFrame` + `drain()` prefetch runner for one public custom page. */
export function createSsrPageHost(input: SsrPageInput, queryClient: QueryClient) {
  const { app, schema, viewKey, dashboard, page, place, answers, read } = input;
  const pending: Array<Promise<unknown>> = [];
  const queued = new Set<string>();

  const book = appAddressBook({
    views: app.views as never,
    order: viewOrder(app),
    resources: app.resources,
    pages: app.pages ?? [],
    tables: schema.tables,
    inbox: app.inbox === true,
    assistant: app.assistant?.page === true,
    directory: app.directory !== undefined,
    projected: true,
  });

  const tableOf = (resource: string): TableMeta => {
    const table = tableNamed(schema, resource);
    if (!table) throw new Error(`Unknown resource "${resource}" during SSR.`);
    return table;
  };

  const fileAddress: UiHost['fileAddress'] = (resource, key, options = {}) => {
    const table = tableOf(resource);
    return served(
      `/api/file?${new URLSearchParams({
        app: app.id,
        table: table.id,
        key: JSON.stringify(key),
        inline: '1',
        ...(options.thumbnail ? { variant: 'thumb' } : {}),
      })}`,
    );
  };

  const viewRows = async (
    table: TableMeta,
    show: readonly string[] | undefined,
    query: string,
    limit: number,
    askingPage?: string,
    where?: unknown,
    offset?: number,
  ): Promise<UiRow[]> => {
    const basePaths = show?.length ? [...show] : table.columns.map((c) => c.name);
    const attachCover = Boolean(table.cover) && !table.columns.some((c) => c.name === COVER_COLUMN) && !basePaths.includes(COVER_COLUMN);
    const paths = attachCover ? [...basePaths, COVER_COLUMN] : basePaths;
    const body = {
      ...uiViewRunBody(table.id, table.name, paths, query, limit),
      app: app.id,
      ...(where === undefined ? {} : { where }),
      ...(offset ? { offset } : {}),
    };
    const reply = await read('POST', '/api/view/run', body, askingPage ? { 'x-mistri-page': askingPage } : undefined);
    if (reply.status >= 400) return [];
    const got = reply.body as Parameters<typeof rowsByPath>[1];
    const rows = rowsByPath(paths, got, `Could not read ${table.name}`, { schema, base: table.id });
    const cover = table.cover;
    if (cover && (attachCover || basePaths.includes(COVER_COLUMN))) {
      for (const row of rows) {
        const raw = row[COVER_COLUMN];
        row[COVER_COLUMN] =
          raw === null || raw === undefined
            ? null
            : (fileAddress(cover.from, { [cover.photoKey]: raw }, cover.thumbnail ? { thumbnail: true } : undefined) ?? null);
      }
    }
    return rows;
  };

  const href = (to: UiAddress): string | undefined => {
    const root = `/${encodeURIComponent(app.id)}`;
    const withParams = (path: string, params: Readonly<Record<string, string>> | undefined) => {
      const q = params ? new URLSearchParams(params).toString() : '';
      return shownUnplaced(q ? `${path}?${q}` : path);
    };
    if (to.kind === 'signIn') return shownUnplaced(`${root}/sign-in`);
    if (to.kind === 'home') return shownUnplaced(root);
    if (to.kind === 'view' || to.kind === 'page') {
      const segment = book.views.get(to.kind === 'view' ? to.view : to.path);
      return segment ? withParams(`${root}/${encodeURIComponent(segment)}`, to.params) : undefined;
    }
    const target = book.routes.get(book.views.get(to.view) ?? '');
    if (target?.kind !== 'list') return undefined;
    const segments = recordSegments(book, target.table, { key: to.key, ...(to.tab ? { tab: to.tab } : {}) });
    return segments ? shownUnplaced(`${root}/${segments.join('/')}`) : undefined;
  };

  const host: UiHost = {
    flags: NOOP_FLAGS,
    analytics: NOOP_ANALYTICS,
    scope: ['ssr', app.id],
    app: true,
    ssrPrefetch(queryKey, queryFn, enabled, infinite) {
      if (enabled === false) return;
      if (queryClient.getQueryData(queryKey) !== undefined) return;
      const k = JSON.stringify(queryKey);
      if (queued.has(k)) return;
      queued.add(k);
      pending.push(
        Promise.resolve()
          .then(queryFn)
          .then((value) => {
            queryClient.setQueryData(queryKey, infinite ? { pages: [value], pageParams: [0] } : value);
          })
          .catch(() => undefined),
      );
    },
    served(resource) {
      return Boolean(tableNamed(schema, resource));
    },
    async rows(resource, options) {
      const table = tableOf(resource);
      const limit = options.limit ?? 20;
      const show = options.show?.length ? (options.keys ? [...new Set([...primaryKey(table), ...options.show])] : options.show) : undefined;
      const query = uiRowsQuery(options.query, options.sort);
      const rows = await viewRows(table, show, query, limit + 1, options.page, options.where, options.offset);
      const more = rows.length > limit;
      return { rows: more ? rows.slice(0, limit) : rows, more };
    },
    async record(resource, key, show, asking = {}) {
      const table = tableOf(resource);
      const pk = primaryKey(table);
      const paths = show?.length ? [...new Set([...pk, ...show])] : undefined;
      const rows = await viewRows(table, paths, '', 1, asking.page, key);
      return rows[0];
    },
    async breakdown(resource, { by, measure, query, limit, page: askingPage, where }) {
      const table = tableOf(resource);
      const compiled = compileWhere(where, table);
      if ('error' in compiled) return [];
      const text = uiBreakdownText(table.id, andQuery(compiled.text, query), measure, by);
      const reply = await read(
        'POST',
        '/api/breakdown',
        { text, limit, app: app.id },
        askingPage ? { 'x-mistri-page': askingPage } : undefined,
      );
      if (reply.status >= 400) return [];
      return ((reply.body as { rows?: UiRow[] } | undefined)?.rows ?? []) as UiRow[];
    },
    async load(pageName, params, loader) {
      const bodyScoped = { page: pageName, params, ...(loader === undefined ? {} : { loader }), app: app.id };
      const bodyPlain = { page: pageName, params, ...(loader === undefined ? {} : { loader }) };
      const carried =
        answers?.[readKey('POST', PAGE_LOAD_PATH, bodyScoped)]?.body ?? answers?.[readKey('POST', PAGE_LOAD_PATH, bodyPlain)]?.body;
      if (carried && typeof carried === 'object' && 'data' in carried) {
        return (carried as { data?: unknown }).data;
      }
      const reply = await read('POST', PAGE_LOAD_PATH, bodyScoped, { 'x-mistri-page': pageName });
      if (reply.status >= 400) return undefined;
      return (reply.body as { data?: unknown } | undefined)?.data;
    },
    openRecord() {},
    openView() {},
    follow() {},
    openForm() {},
    form: (view) =>
      ({
        state: async () => ({ steps: [], draft: null }),
        open: async () => ({ status: 'cancelled' as const }),
        startOver: async () => false,
        label: view,
      }) as never,
    publicLink: () => undefined,
    fillComposer: () => false,
    fileAddress,
    command(ref) {
      const pub = app.publicCommands && Object.hasOwn(app.publicCommands, ref) ? app.publicCommands[ref] : undefined;
      return {
        label: pub?.label ?? humanName(ref),
        granted: Boolean(pub),
        available: async () => Boolean(pub),
        run: async () => ({ status: 'refused' as const, message: '' }),
        open: async () => ({ status: 'refused' as const, message: '' }),
      };
    },
    action(ref) {
      return {
        label: humanName(ref),
        granted: false,
        available: async () => false,
        run: async () => ({ status: 'refused' as const, message: '' }),
        open: async () => ({ status: 'refused' as const, message: '' }),
      };
    },
    choices: async () => ({ options: [], more: false }),
    choiceName: async () => null,
    viewer: () => ({ signedIn: false, roles: [] }),
    subscribeViewer: () => () => {},
    column(resource, column) {
      const table = tableNamed(schema, resource);
      if (!table) return undefined;
      const meta = resolveSsrColumnMeta(schema, table, column);
      if (!meta) return undefined;
      const res = Object.hasOwn(app.resources, table.id) ? app.resources[table.id] : undefined;
      const label = res?.labels?.[column] ?? humanName(column.split('.').pop() ?? column);
      const rule = (res?.display?.[column] as DisplayRule | undefined) ?? undefined;
      return { label, meta, ...(rule ? { rule } : {}) };
    },
    announce() {},
    href,
    rowTitle: (_resource, row) => {
      const first = Object.values(row).find((v) => typeof v === 'string' && v.trim());
      return typeof first === 'string' ? first : undefined;
    },
    message: (key) => key,
    look: () => ({ look: 'lumen', preset: 'lumen', mode: 'light', density: 'comfortable' }),
    subscribeLook: () => () => {},
    token: () => '',
    team: {} as UiHost['team'],
    accountProfile: {} as UiHost['accountProfile'],
    reads: {} as UiHost['reads'],
    branding: () => ({}) as ReturnType<UiHost['branding']>,
    deployment: () => ({ id: app.id, name: app.name }) as unknown as ReturnType<UiHost['deployment']>,
  };

  const frame: UiPageFrame = {
    view: viewKey,
    label: dashboard.label,
    reads: page.reads,
    ...(page.optionalReads ? { optionalReads: page.optionalReads } : {}),
    commands: page.commands,
    ...(page.actions ? { actions: page.actions } : {}),
    params: page.params,
    ...(page.loader ? { loader: page.loader } : {}),
    ...(page.loader || page.loaders?.length ? { loaders: [...(page.loader ? [page.loader] : []), ...(page.loaders ?? [])] } : {}),
    ...(page.loaderParams ? { loaderParams: page.loaderParams } : {}),
    get: (name) => place[name],
    set: () => {},
  };

  const resolveSiteLinkHref = (link: { view?: string; href?: string }): string => {
    if (link.href) return link.href;
    if (link.view) {
      const found = viewAddress(book, app.id, link.view);
      if (found) return shownUnplaced(found);
    }
    return shownUnplaced(`/${encodeURIComponent(app.id)}/${encodeURIComponent(link.view ?? '')}`);
  };

  async function drain(): Promise<boolean> {
    if (!pending.length) return false;
    const batch = pending.splice(0);
    await Promise.allSettled(batch);
    return true;
  }

  return { host, frame, drain, resolveSiteLinkHref };
}
