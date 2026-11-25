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
import { installSurfaceSeam } from '@mistriwork/ui';
import * as ui from './index.js';
import * as page from './page.js';
import { mistriSurfaceSeam } from './seam.js';
import './kit.css';
import {
  columnDisplay,
  columnLabel,
  labelPath,
  openRecord,
  pageApi,
  primaryKey,
  quote,
  rowLabel,
  state,
  toast,
} from '@mistriwork/kit/client/core.js';
import { PAGE_LOAD_PATH } from '@mistriwork/engine/shared/pageRoutes.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { sessionIdentity, subscribeSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { batchedBreakdown, batchedView } from '@mistriwork/kit/client/breakdownBatch.js';
import { sameReads } from '@mistriwork/kit/client/liveReads.js';
import { densityChoice } from '@mistriwork/kit/client/density.js';
import { fillComposer as fillPageComposer } from '@mistriwork/kit/client/components/composerDraft.js';
import { assistantDoorOpen, openAssistantDoor } from '../assistantDoor.js';
import { compileWhere } from '@mistriwork/engine/shared/pageWhere.js';
import { andQuery } from '@mistriwork/engine/shared/query.js';
import { findTable, tableNamed, type ColumnMeta, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { COVER_COLUMN } from '@mistriwork/engine/shared/coverPhotos.js';
import { HOST_GLOBAL, uiBreakdownText, uiRowsQuery, uiViewRunBody } from '../../../shared/uiSdk.js';
import { pageBridge } from '@mistriwork/kit/client/uiBridge.js';
import type { DisplayRule } from '@mistriwork/kit/client/components/valueModel.js';
import {
  setPageHost,
  type UiBranding,
  type UiDeployment,
  type UiHost,
  type UiLook,
  type UiOption,
  type UiResourceChoices,
  type UiRow,
} from './context.js';
import type { ResolvedBranding } from '../../../shared/branding.js';
import { createTeamAccess } from '../../teamAccess.js';
import { createAccountProfileAccess } from '../../accountProfileAccess.js';
import { createReadAuditAccess } from '../../readAuditAccess.js';
import { rowsByPath } from './rows.js';
import { sayAppMessage } from './appMessage.js';
import { publicMessages } from './publicMessages.js';
import { say } from '../../copy/components/components/sdk/host.js';
import { served, shownUnplaced } from '@mistriwork/kit/client/addressMount.js';
import { filesOnLease, pictureOnLeaseNow } from '@mistriwork/kit/client/fileSource.js';
import { hrefFor, viewPath } from '../../publicAddress.js';
import { publicFormAddress } from '../../../shared/appAddress.js';
import { createPageAppFlags } from '../../appFlags.js';
import { pageAnalyticsBeacon } from '../../analyticsBeacon.js';
import { navFollow, shellRoot } from '@mistriwork/kit/client/shellHost.js';
import { tenantQualified } from '../../tenantAddress.js';

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
  where?: unknown,
  offset?: number,
): Promise<UiRow[]> {
  const basePaths = show?.length ? [...show] : table.columns.map((column) => column.name);
  const attachCover =
    Boolean(table.cover) && !table.columns.some((column) => column.name === COVER_COLUMN) && !basePaths.includes(COVER_COLUMN);
  const paths = attachCover ? [...basePaths, COVER_COLUMN] : basePaths;
  const body = {
    ...uiViewRunBody(table.id, table.name, paths, query, limit),
    /* Sent as written, not compiled here: the server judges it against the columns this reader is served. */
    ...(where === undefined ? {} : { where }),
    ...(offset ? { offset } : {}),
  };
  /* Asked with the page's other reads of the same moment: nineteen lists on one page are one request, each still its
     own query with its own rows or its own error (kit breakdownBatch.ts). */
  const got = await batchedView<Parameters<typeof rowsByPath>[1]>(body, page);
  /* A refused read (a query the language cannot parse, say) fails this read alone, and says which read it was: a
     page with several reads otherwise shows a parser's words with nothing to tell which of them they belong to. */
  const refusal = (got as { errors?: Array<{ message?: string }> } | null)?.errors?.[0]?.message;
  if (refusal) throw new Error(say('theRowsOfRefused', { name: table.name, reason: refusal }));
  /* Said of the same tables as the answer they were read out of (liveReads.ts): what is made of them below says so
     too, so the read is filed by them and asked again only when one changes (liveInvalidate.ts, commandRefresh.ts). */
  const rows = rowsByPath(paths, got, say('theRowsOfCould', { name: table.name }), { schema: state.schema, base: table.id });
  const cover = table.cover;
  if (cover && (attachCover || basePaths.includes(COVER_COLUMN))) {
    for (const row of rows) {
      const raw = row[COVER_COLUMN];
      row[COVER_COLUMN] =
        raw === null || raw === undefined
          ? null
          : (pageHost.fileAddress(cover.from, { [cover.photoKey]: raw }, cover.thumbnail ? { thumbnail: true } : undefined) ?? null);
    }
  }
  return sameReads(rows, got);
}

/* A resource's own records as a picker's choices (`useOptions('country')`): the ordinary read of the resource — the
   page's own when a free-form page asks, so the server holds it to the manifest — labelled by the title column the
   catalog names, which a record page's breadcrumb uses. Row policy and field projection are the server's, as for any read. */
function choiceShape(resource: string): { table: TableMeta; by: string; label: string } {
  const table = tableOf(resource);
  const by = (primaryKey(table) as string[])[0];
  const label = (labelPath(table) as string | undefined) ?? by;
  return { table, by, label };
}
async function resourceChoices(
  field: UiResourceChoices,
  text: string,
  offset: number,
  limit: number,
): Promise<{ options: UiOption[]; more: boolean }> {
  const { table, by, label } = choiceShape(field.resource);
  const search = text.trim() ? `${label} contains ${quote(text.trim())}` : '';
  const got = await viewRows(
    table,
    [...new Set([by, label])],
    [search, `sort ${label}`].join(' '),
    limit + 1,
    field.page,
    field.where,
    offset,
  );
  const options = got.slice(0, limit).flatMap((row) => {
    const key = row[by];
    return typeof key === 'string' || typeof key === 'number' ? [{ key, label: String(rowLabel(table, row)) }] : [];
  });
  return { options, more: got.length > limit };
}
async function resourceChoiceName(field: UiResourceChoices, key: string | number): Promise<UiOption | null> {
  const { table, by, label } = choiceShape(field.resource);
  const [row] = await viewRows(table, [...new Set([by, label])], `${by} = ${quote(String(key))}`, 1, field.page, field.where);
  return row ? { key, label: String(rowLabel(table, row)) } : null;
}

const root = () => shellRoot();

function look(): UiLook {
  const attribute = root().dataset.theme;
  const dark = attribute === 'dark' || (!attribute && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const density = densityChoice() as UiLook['density'];
  const id = root().dataset.visualTheme ?? 'workshop';
  return { look: id, preset: root().dataset.themePreset ?? id, mode: dark ? 'dark' : 'light', density };
}

/** The App as this deployment presents it: read from the payload the page was served (the overrides are already in it). */
function deployment(): UiDeployment {
  const app = pageBridge.activeApp() as {
    name?: string;
    ui?: { logo?: string | { href?: string; markHref?: string }; theme?: { preset?: string }; locale?: string };
  } | null;
  const logo = app?.ui?.logo;
  return {
    name: app?.name ?? '',
    mark: logo && typeof logo === 'object' ? (logo.markHref ?? logo.href ?? null) : null,
    theme: app?.ui?.theme?.preset ?? null,
    locale: app?.ui?.locale ?? null,
    basePath: served(''),
  };
}

/** The brand the reader sees: a tenant's resolved branding (name, mark, theme accent) over the App's own. */
function branding(): UiBranding {
  const app = pageBridge.activeApp() as {
    name?: string;
    ui?: { logo?: string | { href?: string; markHref?: string }; theme?: { accent?: unknown; branding?: ResolvedBranding } };
  } | null;
  const own = deployment();
  const tenant = app?.ui?.theme?.branding;
  const accent = tenant?.theme?.light?.accent ?? app?.ui?.theme?.accent;
  const light = accent && typeof accent === 'object' ? (accent as { light?: unknown }).light : accent;
  return {
    name: tenant?.content?.name ?? own.name,
    logo: tenant?.mark?.src ?? own.mark,
    accent: typeof light === 'string' ? light : null,
  };
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
  /* One row past the page is asked for and dropped: whether there are more is then the server's answer, where a
     full page would only say there might be. No total is asked for (`count: 'none'`), so none is reported. */
  served(resource) {
    try {
      tableOf(resource);
      return true;
    } catch {
      return false;
    }
  },
  async rows(resource, { where, query, show, sort, limit, page, keys, offset }) {
    const table = tableOf(resource);
    const paths = keys && show?.length ? [...new Set([...show, ...(primaryKey(table) as string[])])] : show;
    const size = limit ?? 20;
    const got = await viewRows(table, paths, uiRowsQuery(query, sort), size + 1, page, where, offset);
    return sameReads({ rows: got.slice(0, size), more: got.length > size }, got);
  },
  async record(resource, key, show, asking = {}) {
    const table = tableOf(resource);
    const keyed = primaryKey(table) as string[];
    const where = keyed.map((column) => `${column} = ${quote(String(key[column]))}`).join(' and ');
    /* The key rides beside `show`, as a read's rows carry it: the record's type says it is there. */
    const paths = show?.length ? [...new Set([...show, ...keyed])] : show;
    const rows = await viewRows(table, paths, where, 1, asking.page);
    return sameReads(rows[0], rows);
  },
  async breakdown(resource, { by, measure, query, limit, page, where }) {
    const table = tableOf(resource);
    /* The server's breakdown reads text alone, so an object condition is written as the text it means here, beside
       the query, as `useRows` asks it. */
    const compiled = compileWhere(where, table);
    if ('error' in compiled) throw new Error(compiled.error);
    const text = uiBreakdownText(table.id, andQuery(compiled.text, query), measure, by);
    /* A page's breakdown rides with that page's other reads, under its name, so the server holds the batch to the
       page's manifest as it would the one read. */
    const got = await batchedBreakdown<{ rows?: UiRow[] }>({ text, limit, ...(page ? { page } : {}) });
    return sameReads(got.rows ?? [], got);
  },
  async load(page, params, loader) {
    /* A tenant's lease answers a refusal as a reply, not a throw (tenantTransport.ts): it is the page's error either way. */
    const got = (await pageApi(page, PAGE_LOAD_PATH, { page, params, ...(loader === undefined ? {} : { loader }) })) as {
      data?: unknown;
      error?: unknown;
    };
    if (typeof got.error === 'string') throw new Error(got.error);
    /* Filed with the tables its loader declares (the reply's `mistri-reads`): a command that wrote none of them leaves it (commandRefresh.ts). */
    return sameReads(got.data, got);
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
  /* The shell's own listener reads the address again (navFollow), so no entry is made by hand and no App is reloaded.
     A tenant's session reads an address with no selector as a link to some other tenant, and that is a fresh document
     (tenantNavigation.ts): so the address goes in the form the shell writes it, with this tenant's selector. */
  follow: (href) => navFollow(tenantQualified(href)),
  /* The page's command pipeline and forms, registered by sdk/commands.tsx (uiBridge.ts says why). */
  openForm(view, prefill = {}) {
    if (!pageBridge.commands) throw new Error(say('thePageCannotOpen'));
    pageBridge.commands.openForm(view, prefill);
  },
  /* Asked of the bridge at each call, not as the handle is made: a page draws before sdk/commands.tsx has loaded. */
  form(view) {
    const served = () => {
      if (!pageBridge.commands) throw new Error(say('thePageCannotOpen'));
      return pageBridge.commands.form(view);
    };
    return {
      state: async () => served().state(),
      open: async (input, options) => served().open(input, options),
      startOver: async () => served().startOver(),
    };
  },
  /* A tenant's link to hand out: a view a visitor reads by the tenant's public address, a public
     form (never one of the payload's rooms) by its intake address. Only the tenant's own lease is served them. */
  publicLink(view) {
    const app = pageBridge.activeApp() as { id?: string; views?: object; addresses?: { intake?: string; public?: string } } | null;
    if (!app?.id || typeof view !== 'string' || !view) return undefined;
    const room = Boolean(app.views && Object.hasOwn(app.views, view));
    const address = room ? app.addresses?.public : app.addresses?.intake;
    const path = room ? viewPath(view) : publicFormAddress(app.id, view);
    if (!address || !path) return undefined;
    return `${window.location.origin}${shownUnplaced(path)}?via=${encodeURIComponent(address)}`;
  },
  href: (to) => hrefFor(to),
  fillComposer(text, mode) {
    return fillPageComposer(text, mode);
  },
  assistantOffered: () => assistantDoorOpen(),
  openAssistant: (handoff) => openAssistantDoor(handoff),
  fileAddress(resource, key, options = {}, drawn) {
    const table = tableOf(resource);
    /* A tenant's file is never a link (fileSource.ts): an <img> sends no lease, so the file route refuses it. It is
       read on the lease into a blob the shell's own attachments share, and has an address once that lands. */
    if (filesOnLease()) return pictureOnLeaseNow(table.id, { ...key }, options.thumbnail ? 'thumb' : undefined, drawn ?? (() => {}));
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
  action: (ref, reads) =>
    pageBridge.commands?.action(ref, reads) ?? {
      label: ref,
      granted: false,
      available: async () => false,
      run: async () => ({ status: 'refused', message: say('thisPageCannotRun') }),
      open: async () => ({ status: 'refused', message: say('thisPageCannotRun') }),
    },
  /* The platform's own picker reads (CommandReference.tsx), through the reader's connection: loaded where a component
     first asks, so a page that draws no picker never carries it. */
  async choices(field, text, { offset, limit }) {
    if ('resource' in field) return resourceChoices(field, text, offset, limit);
    const { commandChoicePage } = await import('../CommandReference.js');
    const page = await commandChoicePage(field, text, state.activeConnection ?? '', offset, limit);
    return {
      options: page.choices.map(({ value, label, detail }) => ({ key: value, label, ...(detail ? { detail } : {}) })),
      more: page.more,
    };
  },
  async choiceName(field, key) {
    if ('resource' in field) return resourceChoiceName(field, key);
    const { readReferenceName } = await import('../CommandReference.js');
    const named = await readReferenceName(field, key, state.activeConnection ?? '');
    return named && { key, ...named };
  },
  viewer() {
    const identity = sessionIdentity();
    if (identity.mode !== 'authenticated' || !identity.accountId) return { signedIn: false, roles: [] };
    const app = pageBridge.activeApp() as { viewerRoles?: readonly string[] } | null;
    return { signedIn: true, account: identity.accountId, roles: app?.viewerRoles ?? [] };
  },
  subscribeViewer: (listener) => subscribeSessionIdentity(listener),
  column(resource, name) {
    const schema = state.schema;
    const table = schema ? (tableNamed(schema, resource) as TableMeta | undefined) : undefined;
    if (!table) return undefined;
    return {
      meta: resolveColumnMeta(schema, table, name),
      rule: columnDisplay(table.id, name) as DisplayRule | null,
      label: (columnLabel(table.id, name) as string | null) ?? name,
    };
  },
  look,
  deployment,
  branding,
  team: createTeamAccess(),
  accountProfile: createAccountProfileAccess(),
  reads: createReadAuditAccess(),
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
  announce: (text, tone) => toast(text, tone),
  rowTitle(resource, row) {
    const table = state.schema ? (tableNamed(state.schema, resource) as TableMeta | undefined) : undefined;
    return table ? (rowLabel(table, row) as string) : undefined;
  },
  /* A public form's page has no App payload: its components say from the catalog served beside them. */
  message: (key, args) =>
    sayAppMessage(
      (pageBridge.activeApp() as { messages?: Readonly<Record<string, readonly unknown[]>> } | null)?.messages ?? publicMessages(),
      key,
      args,
    ),
};

/** Resolve metadata for a stored column, computed column, rollup, or dotted FK path so formatters keep type/name hints. */
function resolveColumnMeta(schema: DatabaseSchema, start: TableMeta, path: string): ColumnMeta | undefined {
  const parts = path.split('.');
  let table: TableMeta | undefined = start;
  for (let i = 0; i < parts.length - 1; i++) {
    const col = table.columns.find((c) => c.name === parts[i]);
    const fk = schema.foreignKeys.find(
      (each) => each.from.table === table!.id && each.from.columns.length === 1 && each.from.columns[0] === parts[i],
    );
    const targetId = col?.references?.table ?? fk?.to.table;
    if (!targetId) return undefined;
    table = findTable(schema, targetId);
    if (!table) return undefined;
  }
  const leaf = parts[parts.length - 1];
  const stored = table.columns.find((c) => c.name === leaf);
  if (stored) return stored;
  const computed = table.computed && Object.hasOwn(table.computed, leaf) ? table.computed[leaf] : undefined;
  if (computed) {
    const type = computed.type === 'text' ? 'text' : 'numeric';
    return { name: leaf, type, nullable: true, primaryKey: false };
  }
  const rollup = table.rollups && Object.hasOwn(table.rollups, leaf) ? table.rollups[leaf] : undefined;
  if (rollup) {
    const type = rollup.fn === 'latest' ? 'text' : 'numeric';
    return { name: leaf, type, nullable: true, primaryKey: false };
  }
  return undefined;
}

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
      /* What the page fetches when a component first asks (shared/uiSdk.ts, LAZY_HOST_MODULES): behaviors, primitives,
         charts and views load as shared on-demand chunks with their shared stylesheet. */
      load: Object.freeze({
        '@mistriwork/mistri/behaviors': () => import('./behaviors.js'),
        '@mistriwork/mistri/primitives': () => import('./primitives.js'),
        '@mistriwork/mistri/charts': () => import('./charts.js'),
        '@mistriwork/mistri/views': () => import('./views.js'),
      }),
    }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
}
setPageHost(pageHost);
installSurfaceSeam(mistriSurfaceSeam);
