/**
 * What `/api/app` answers with: one type the server builds and the client
 * reads, so a field renamed on one side is a compile error on the other —
 * the client's own copy of this shape is how it drifted before.
 *
 * `app: null` is an answer, not an error: most servers have no App, and the
 * client draws the ordinary sidebar.
 *
 * The App is served in its own nouns: the views it opens as rooms, keyed as
 * authored; nav as the tree of references it was written as; and what each
 * resource says about its rows — captions, dress, actions, New form, page —
 * under the resource, whichever view shows it.
 */
import { servedShellNew, type ServedShellNew } from './appNewMenu.js';
import type { AssistantStarter } from './appAssistant.js';
import type { AppShell } from './appModel.js';
import { appZone } from './appZone.js';
import type { AppFormCommandReference } from './command.js';
import {
  isPublicForm,
  navViewKeys,
  resolveResources,
  resolveViews,
  type AppDashboardView,
  type AppDef,
  type AppNavNode,
  type AppUi,
  type ResolvedFormView,
  type ResolvedListView,
  type ResolvedResource,
} from './app.js';
import { publicView, resolveHome, type HomePrincipal } from './appHome.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { expandSegments } from '@mistriwork/engine/shared/query.js';
import { landingViews } from './appLanding.js';
import type { PageDef } from '@mistriwork/engine/shared/pageModel.js';
import { embedTargets, embeddedOnlyViews } from '@mistriwork/engine/shared/appEmbeds.js';
import { appKeepsInbox } from './appNotify.js';
import { ASSISTANT_ROOM } from './appAddress.js';
import { mentionsMe } from './appMe.js';
export { embeddedOnlyViews } from '@mistriwork/engine/shared/appEmbeds.js';
import type { AppPayloadDocument, AppPayloadNavNode, ServedApp } from '@mistriwork/engine/shared/servedApp.js';
export type { AppPayloadDocument, AppPayloadNavNode } from '@mistriwork/engine/shared/servedApp.js';

/** A record page, as an address reads it. */
interface AppPayloadPage {
  id: string;
  base: string;
  path?: string;
}

/** The App as one principal sees it on one connection. */
export interface AppPayloadApp extends ServedApp<ResolvedListView | AppDashboardView | ResolvedFormView> {
  id: string;
  name: string;
  /** The views this App opens as rooms, by key: a list, a dashboard
      (`sections`), or a signed-in form (`command`) whose command this
      principal is granted. Their order is the menu's (viewOrder), never the
      keys': an object sorts a key like "2024" first. A list view only a
      dashboard embeds is here too, where its "open →" goes
      (embeddedOnlyViews). A public form is never here: it is read from its
      own route, like the landing. */
  views: Record<string, ResolvedListView | AppDashboardView | ResolvedFormView>;
  /** The menu: references to `views`, and groups of them. Empty for an App
      without nav, whose one view is its home and is drawn in no menu. */
  nav: AppPayloadNavNode[];
  /** The view this principal starts on, as the server resolved its home
      rules (withHome): a key of `views`, or the landing or a public form, which
      are read from their public routes. Absent when no rule names a view
      this principal can open; the client draws the App's home card then. */
  home?: string;
  /** The App's landing view key, where it declares a landing (`landing.view`): PublicHome matches its home
      against it instead of probing `/api/landing` — an App without a landing answered that probe 404, and one
      whose landing is another view does not need the probe either. Absent when the App declares no landing. */
  landingView?: string;
  /** What each resource says about its rows, keyed by resolved table id. */
  resources: Record<string, ResolvedResource>;
  /** The App's record pages as its addresses need them (appAddress.ts): each
      page's id, its base as a table id, and its own `path`. In load order,
      so the first over a base is the one its records open through. */
  pages?: AppPayloadPage[];
  /** The App's documents this reader may open, each a verb on its record and the last segment of its address
      (`/orders/12/invoice`). Never among `pages`: no record opens through one. */
  documents?: AppPayloadDocument[];
  /** The App's chrome and formatting; absent authored timezone resolves to the serving process's zone (servedUi). */
  ui: ServedUi;
  /**
   * Which tables this person may write here: a runtime answer, not an
   * authored key. `false` is an App that declares no write at all, so the
   * shell has no padlock to offer; absent, the connection decides every
   * write, as it does without an App.
   */
  writableTables?: string[] | false;
  /**
   * Which tables this person may export: a runtime answer, present only in an App that grants by role
   * (`roles.<role>.export`, and every table a role writes). Absent, `ui.export` alone decides.
   */
  exportableTables?: string[];
  /** Every command an action this principal may run references, whichever view shows it, and each its signed-in forms run (servedCommandIds). */
  grantedCommands?: string[];
  /** The commands this principal runs that name no record and that no signed-in form runs, by id, as a form's
      command is served: a component's `useCommand` sends them, and draws their form, by name. */
  formCommands?: Record<string, AppFormCommandReference>;
  /** The public commands the public pages this principal is served run through their own door, by id
      (http/pageCommandRoutes.ts): a page's `useCommand` checks its input by them and sends them signed out. */
  publicCommands?: Record<string, AppFormCommandReference>;
  /** The fixed actions this principal runs on a table it does not write
      (`roles.<role>.actions`), by table id and action id: a runtime answer. */
  grantedActions?: Record<string, string[]>;
  /**
   * Whether this person may read their tenant's log of support visits into it
   * (a role granted `supportLog`). A runtime answer from the current
   * membership, like `writableTables`: roles are per-tenant, so it can only be
   * known once a lease is held, and the shell offers the screen on it alone.
   */
  supportLog?: true;
  /** Whether this platform-realm lease may read every tenant's support sessions (a role granted `supportAudit`): a runtime answer, like `supportLog`. */
  supportAudit?: true;
  /** Whether this member may make and end API tokens on their tenant's lease (a tenant App with an `api` block): a runtime answer. */
  apiTokens?: true;
  /** The tenant's own public addresses, on its own lease alone: the intake address its public forms are
      published by and the public address its pages are, each only when it resolves back to this tenant. A runtime
      answer, read on every load, so a rotated address shows on the next; `useNavigate().publicLink` says them. */
  addresses?: { intake?: string; public?: string };
  /** Every problem mistri check would report, for the shell's quiet count. */
  problems?: string[];
  /** The drawings of the icons this App names, which the client does not
      bundle (server/app/iconPayload.ts). */
  icons?: Partial<
    Record<import('@mistriwork/engine/shared/appIcons.js').AppIconName, import('@mistriwork/engine/shared/iconGlyphs.js').IconGlyph>
  >;
  /** Where each custom component is served, by id: its module and its stylesheet (packages/mistri/src/server/app/appComponents.ts). */
  components?: Record<string, { kind: import('@mistriwork/engine/shared/appComponents.js').ComponentKind; href: string; css?: string }>;
  /** The App's catalog (`messages/<locale>.ts`) in this reader's words, each message parsed: what a custom
      component's `useMessage` says. Sent only beside `components`, and only by an App with catalogs. */
  messages?: Readonly<Record<string, readonly unknown[]>>;
  /** The App keeps each signed-in person an inbox (`notify`, appNotify.ts): the bell, and `/{app}/notifications`. */
  inbox?: true;
  /**
   * The assistant is offered to this person (appAssistant.ts): the panel's
   * trigger, and `record` when it takes the open record as context. The icon
   * is named here so its glyph rides the payload (iconPayload.ts) rather
   * than every first page's bundle. `page` when it has a room of its own
   * (`/{app}/assistant`), and `starters`, the App's suggestions for an
   * empty conversation: a bare line everywhere, a scoped one in the views
   * this reader was served and on records of its tables (by table id).
   */
  assistant?: { icon: 'chat-circle'; record?: true; page?: true; starters?: Array<string | AssistantStarter> };
  /** The fields a decision answers, by table id then column (decide/decisionServing.ts): where a record reserves a
      suggestion's place, and the command its Accept runs. Only the tables this reader is served. */
  decisions?: Readonly<Record<string, Readonly<Record<string, { readonly decision: string; readonly command: string }>>>>;
}

export interface AppPayload {
  app: AppPayloadApp | null;
  /** Why the latest reload of the App directory failed, while `app` is still
      the last good load. Absent when the directory on disk is healthy. */
  loadError?: string;
  /** The same failure placed for the page's overlay: present beside `loadError` once the server has located it. */
  loadProblem?: AppLoadProblem;
  /** The server watches this App's source and tells `/api/app/live` of each save (server/app/appLive.ts). */
  live?: true;
  /** Which App answered, on a server that selects Apps by id. */
  appId?: string;
  /** Which connection answered, on one that does not. */
  connection?: string;
}

/**
 * A save that did not load, as `mistri check` would place it: the code
 * its words name (check-codes.md), the file and line it was written on where
 * that can be told, and the lines around that one. The file is said from the
 * App's directory (`views.ts`), never as the machine's absolute path.
 */
export interface AppLoadProblem {
  code: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  /** The lines around `line`, numbered as the file numbers them. */
  frame?: Array<{ line: number; text: string }>;
  /** The page that explains the code. */
  docs: string;
}

/**
 * The App as served, before any runtime answer: its identity, its views,
 * nav and resources resolved against this catalog, and its chrome. The
 * ordinary route and the tenant route both start here and add what they
 * decide per request — who may write what, which commands run — on top.
 */
export function servedApp(app: AppDef, schema: DatabaseSchema, pages: readonly PageDef[] = []): AppPayloadApp {
  // API exposure retains a list definition for server-side checking, not a
  // new browser room. Only ordinary UI reachability may publish that view.
  const reachable = new Set([
    ...navViewKeys(app.nav),
    ...app.home.map((rule) => rule.view),
    ...(app.landing ? landingViews(app.landing.content) : []),
  ]);
  for (const key of reachable) {
    const view = app.views[key];
    if (!view || !('sections' in view)) continue;
    for (const section of [...view.sections, ...(view.aside ?? [])]) {
      if (section.view) reachable.add(section.view);
      if (section.kind === 'note' && section.action && 'view' in section.action) reachable.add(section.action.view);
      for (const step of section.kind === 'firstRun' ? (section.steps ?? []) : []) reachable.add(step.view);
    }
  }
  const apiOnly = new Set((app.api?.views ?? []).map((entry) => entry.view).filter((key) => !reachable.has(key)));
  const browserApp = apiOnly.size
    ? { ...app, views: Object.fromEntries(Object.entries(app.views).filter(([key]) => !apiOnly.has(key))) }
    : app;
  const views = Object.fromEntries(Object.entries(resolveViews(browserApp, schema)).filter(([, view]) => !isPublicForm(view)));
  const routed = appPayloadPages(pages, schema);
  const documents = appPayloadDocuments(pages, schema);
  return {
    id: app.id,
    name: app.name,
    ...(app.landing ? { landingView: app.landing.view } : {}),
    views,
    nav: servedNav(app.nav, views),
    resources: resolveResources(app, schema).resources,
    ui: servedUi(app.ui, views),
    ...(routed.length ? { pages: routed } : {}),
    ...(documents.length ? { documents } : {}),
    ...(appKeepsInbox(app) ? { inbox: true as const } : {}),
    ...(app.assistant
      ? {
          assistant: {
            icon: 'chat-circle' as const,
            ...(app.assistant.placement.includes('record') ? { record: true as const } : {}),
            ...(app.assistant.placement.includes('page') ? { page: true as const } : {}),
            ...servedStarters(app.assistant.starters, views, schema),
          },
        }
      : {}),
  };
}

/**
 * The starters as this reader is served them: a view they were not served is left out of a starter's places, a
 * record's table is named by its id (what the browser's walk carries), and a starter left with no place is dropped.
 */
function servedStarters(
  starters: readonly (string | AssistantStarter)[],
  views: Readonly<Record<string, object>>,
  schema: DatabaseSchema,
): { starters?: Array<string | AssistantStarter> } {
  const served = starters.flatMap((starter): Array<string | AssistantStarter> => {
    if (typeof starter === 'string') return [starter];
    const inViews = starter.views?.filter((key) => Object.hasOwn(views, key)) ?? [];
    const onRecords = starter.records?.map((name) => tableNamed(schema, name)?.id ?? name) ?? [];
    if (!inViews.length && !onRecords.length) return [];
    return [{ text: starter.text, ...(inViews.length ? { views: inViews } : {}), ...(onRecords.length ? { records: onRecords } : {}) }];
  });
  return served.length ? { starters: served } : {};
}

/** The pages an address book reads: a base this catalog has, as its table id. */
function appPayloadPages(pages: readonly PageDef[], schema: DatabaseSchema): AppPayloadPage[] {
  return pages.flatMap((page) => {
    const base = page.document ? undefined : tableNamed(schema, page.base);
    return base ? [{ id: page.id, base: base.id, ...(page.path ? { path: page.path } : {}) }] : [];
  });
}

/** The documents a reader is served, each by its key, its record's table id and its name: a base this catalog has. */
function appPayloadDocuments(pages: readonly PageDef[], schema: DatabaseSchema): AppPayloadDocument[] {
  return pages.flatMap((page) => {
    const base = page.document ? tableNamed(schema, page.base) : undefined;
    return base && page.document
      ? [{ id: page.id, base: base.id, label: page.document.label, ...(page.document.size ? { size: page.document.size } : {}) }]
      : [];
  });
}

function servedNav(nav: readonly AppNavNode[], views: Readonly<Record<string, { label: string }>>): AppPayloadNavNode[] {
  return nav.map((node) =>
    'group' in node
      ? {
          group: node.group,
          label: node.label,
          ...(node.icon ? { icon: node.icon } : {}),
          ...(node.placement ? { placement: node.placement } : {}),
          ...(node.inline ? { inline: true as const } : {}),
          ...(node.folded ? { folded: true as const } : {}),
          children: servedNav(node.children, views),
        }
      : 'to' in node
        ? { label: node.label, to: structuredClone(node.to), ...(node.color ? { color: node.color } : {}) }
        : {
            ...(node.color ? { color: node.color } : {}),
            view: node.view,
            /* The assistant's page has no view behind it: its word is the room's own (appAddress.ts ASSISTANT_ROOM). */
            label:
              node.label ??
              (Object.hasOwn(views, node.view) ? views[node.view].label : node.view === ASSISTANT_ROOM ? 'Assistant' : node.view),
          },
  );
}

/**
 * What a signed-out visitor is not offered: a list's tab about `me` — the
 * signed-in person, who is nobody to them, so the tab could only ever be
 * empty — and an inbox and an assistant, which are a signed-in person's. Presentation only:
 * the server resolves `me` to nobody for them either way.
 */
export function withoutSignedInParts<A extends Pick<AppPayloadApp, 'views' | 'inbox' | 'assistant'>>(
  app: A,
  schema?: Pick<DatabaseSchema, 'tables'>,
): A {
  const views = Object.fromEntries(
    Object.entries(app.views).map(([key, view]) => {
      const tabs = (view as { tabs?: ReadonlyArray<{ query?: string }> }).tabs;
      /* A tab names a segment (`my_threads`), so `me` is read in what the name stands for. */
      const segments = schema?.tables.find((table) => table.id === (view as { table?: string }).table)?.segments;
      const aboutMe = (tab: { query?: string }) =>
        mentionsMe(tab.query) || (tab.query !== undefined && mentionsMe(expandSegments(tab.query, segments).text));
      return tabs?.some(aboutMe) ? [key, { ...view, tabs: tabs.filter((tab) => !aboutMe(tab)) }] : [key, view];
    }),
  ) as A['views'];
  const { inbox: _inbox, assistant: _assistant, ...rest } = app;
  return { ...rest, views } as A;
}

/** Remove a presentation action when its destination is not in this
 * principal's final room set. This only changes presentation; it never makes
 * a room reachable or grants it access. */
export function withAvailableEmptyActions<A extends Pick<AppPayloadApp, 'views'>>(app: A): A {
  const available = new Set(
    Object.entries(app.views)
      .filter(([, view]) => !view.error)
      .map(([key]) => key),
  );
  const views = Object.fromEntries(
    Object.entries(app.views).map(([key, view]) => {
      if ('sections' in view) {
        const actionsAvailable = <S extends (typeof view.sections)[number]>(section: S): S => {
          // A first run offers only the steps this reader can open; with none left it says nothing.
          if (section.kind === 'firstRun') return { ...section, steps: (section.steps ?? []).filter((step) => available.has(step.view)) };
          return section.kind !== 'note' || !section.action || 'to' in section.action || available.has(section.action.view)
            ? section
            : (() => {
                const { action: _action, ...note } = section;
                return note as S;
              })();
        };
        const sections = view.sections.map(actionsAvailable);
        const aside = view.aside?.map(actionsAvailable);
        return [key, { ...view, sections, ...(aside === undefined ? {} : { aside }) }];
      }
      if ('command' in view || !view.empty?.action || available.has(view.empty.action.view)) return [key, view];
      const { action: _action, ...empty } = view.empty;
      return [key, { ...view, empty }];
    }),
  ) as A['views'];
  return { ...app, views };
}

export { withAvailablePageEmptyActions } from '@mistriwork/engine/shared/pageEmptyActions.js';

/**
 * The App without the views that cannot be drawn here, for a principal,
 * to whom an author's mistake is nothing at all: nav loses its references
 * to them, and a group left with no children goes too. A view only a
 * dashboard opens goes with the last dashboard that embeds it; one a home
 * rule names (`homes`, appHome.ts homeViews) stays while it can be drawn.
 * The author sees each one with its reason, and in `problems`.
 */
export function withoutBrokenViews<A extends Pick<AppPayloadApp, 'views' | 'nav'>>(app: A, homes: Iterable<string>): A {
  const drawable = Object.fromEntries(Object.entries(app.views).filter(([, view]) => !view.error));
  const embeddedOnly = embeddedOnlyViews(app, homes);
  const stillEmbedded = embedTargets(drawable);
  const views = Object.fromEntries(Object.entries(drawable).filter(([key]) => !embeddedOnly.has(key) || stillEmbedded.has(key)));
  const prune = (nodes: readonly AppPayloadNavNode[]): AppPayloadNavNode[] =>
    nodes.flatMap((node): AppPayloadNavNode[] => {
      // The assistant's page is no view; whether it is offered is the payload's `assistant` (appProjection.ts).
      if (!('group' in node)) return 'to' in node || Object.hasOwn(views, node.view) || node.view === ASSISTANT_ROOM ? [node] : [];
      const children = prune(node.children);
      return children.length ? [{ ...node, children }] : [];
    });
  return { ...app, views, nav: prune(app.nav) };
}

/**
 * The served App with this principal's home. Run last, once field filtering
 * and withoutBrokenViews have taken out what the principal cannot open: a
 * rule naming a view that is gone, or one that cannot be drawn, gives way to
 * the next rule that matches. A public view — the landing, a public form —
 * is never in `views`, and is always open.
 */
export function withHome<A extends Pick<AppPayloadApp, 'views' | 'home'>>(
  served: A,
  app: Pick<AppDef, 'home' | 'landing' | 'views'>,
  principal: HomePrincipal,
): A {
  const { home: _stale, ...rest } = served;
  const home = resolveHome(
    app,
    principal,
    (view) => publicView(app, view) !== undefined || (Object.hasOwn(served.views, view) && !served.views[view].error),
  );
  return (home === undefined ? rest : { ...rest, home }) as A;
}

/** The chrome as a reader is served it: no branding, and the New menu's entries resolved to the views they open. */
type ServedUi = Omit<AppUi, 'branding' | 'shell' | 'timezone' | 'localeColumn' | 'messages'> & {
  shell?: Omit<AppShell, 'new'> & { new?: ServedShellNew[] };
  /** The zone this reader's days are counted in (appZone): the App's, or the one their row names; the serving process's when neither does. */
  timezone?: string;
  /** The wall clock zone-less timestamps are written in: `ui.timezone`, UTC when the App names none (unlike `timezone`, which then is the serving process's). */
  clockZone?: string;
  /** The languages the App has words in, where it has several: what the language picker offers (client messages.ts). */
  languages?: readonly string[];
  /** The reader's own row, where `ui.locale` names a column of it: what the picker writes their pick to. */
  localeRow?: { table: string; key: Record<string, string | number>; column: string };
};

/**
 * The chrome as one reader is served it, where `ui.timezone` read them a zone
 * (readerZone.ts): their days, never the clock the App writes in. Applied after
 * the per-definition cache, so one reader's zone is never another's payload.
 */
export function servedZone<U extends { timezone?: string }>(ui: U, reader: string | undefined): U {
  return reader === undefined ? ui : { ...ui, timezone: reader };
}

/**
 * The chrome as one reader is served it, where their locale was resolved
 * (shared/appLocale.ts `resolveLocale`): `ui.locale` is their tag, so the
 * figures the browser writes agree with the words the server said. Applied
 * after the per-definition cache, as `servedZone` is.
 */
export function servedLocale<U extends { locale?: string }>(ui: U, reader: string | undefined): U {
  return reader === undefined || reader === ui.locale ? ui : { ...ui, locale: reader };
}

/** The chrome with the languages a reader may pick among, where the App has words in more than one. */
export function servedLanguages<U extends object>(ui: U, offered: readonly string[]): U & { languages?: readonly string[] } {
  return offered.length > 1 ? { ...ui, languages: offered } : ui;
}

/**
 * The chrome as served. The shell and editing settings are copied, so a
 * caller that adjusts its answer cannot reach into the loaded App; `export`
 * is served only as the `false` that hides the menu, since true is the default.
 * Called by server projections: the effective zone makes the client's Today
 * agree with server date filters without changing the authored definition.
 */
export function servedUi(ui: AppUi, views: Readonly<Record<string, object>> = {}): ServedUi {
  const { shell, editing, appSwitcher, branding: _branding, localeColumn: _column, messages: _messages, export: exportable, ...rest } = ui;
  /* The New menu as this reader was served the views it opens (appNewMenu.ts); none left, no key. */
  const { new: authoredNew, ...plainShell } = shell ?? {};
  const shellNew = servedShellNew(authoredNew, views);
  return {
    ...rest,
    timezone: appZone(ui) ?? new Intl.DateTimeFormat().resolvedOptions().timeZone,
    clockZone: appZone(ui) ?? 'UTC',
    ...(shell === undefined ? {} : { shell: { ...plainShell, ...(shellNew.length ? { new: shellNew } : {}) } }),
    ...(editing === undefined ? {} : { editing: { ...editing } }),
    ...(appSwitcher === undefined ? {} : { appSwitcher: structuredClone(appSwitcher) }),
    ...(exportable === false ? { export: false } : {}),
  };
}
