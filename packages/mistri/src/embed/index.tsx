/**
 * `@mistriwork/mistri/react`: a mistri App inside a React app's own route, or one
 * of its surfaces (a list, a record, a dashboard, a free-form page, the
 * assistant) inside one of the host's screens.
 *
 *   <Provider endpoint="/api/tw" navigator={useReactRouterNavigator()}>
 *     <App app="compass" basePath="/crm" />
 *   </Provider>
 *
 * This entry is small on purpose and touches no `window` or `document` when
 * it is imported, so a server render of the host's page imports it safely:
 * each element renders an empty slot (or the host's `fallback`) on the server
 * and on the client's first render alike, and the shell — the served client,
 * built once more (vite.embed.config.ts) — is loaded by an effect, in a chunk
 * of its own, the first time a mistri element is on screen (./shell.ts).
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { inward, parseBasePath, type AddressMount } from '@mistriwork/engine/shared/mount.js';
import { EMBED_BOOT_PATH, embedRefusal, type EmbedBoot } from '../shared/embedProtocol.js';
import type { Theme } from '@mistriwork/engine/schema/theme.js';
import { browserNavigator, memoryNavigator, type Navigator } from './navigator.js';
import { crossOrigin, startSession, type EmbedSession, type Auth } from './session.js';
import type { Attachment } from './shell.js';
import { loadShell, type ShellModule } from './loadShell.js';

export { browserNavigator, routerNavigator, type RouterMoves, type Location, type Navigator } from './navigator.js';
export type { Auth } from './session.js';

/** The version this package was built from; under a test or a source server, no build said one. */
const VERSION = typeof __MISTRI_VERSION__ === 'string' ? __MISTRI_VERSION__ : undefined;

export interface ProviderProps {
  /** Where the mistri server answers: `/api/tw` (same origin, recommended) or `https://tw.example.com/tools`. */
  endpoint: string;
  /** `'cookie'` (the default): the page already carries mistri's session. Or exchange the host's own. */
  auth?: Auth;
  /**
   * Worn in place of the reader's choice: a look's id (`lumen`, `mono`, `sage`,
   * or one the App defines), or the host's own `defineTheme(...)` from
   * `@mistriwork/mistri/app`, which dresses the App as its own `ui.theme` would.
   */
  theme?: string | Theme;
  /** Light or dark, instead of the reader's choice; `system` follows the operating system. */
  mode?: 'light' | 'dark' | 'system';
  /** The density a reader who has not chosen one sees. */
  density?: 'compact' | 'comfortable' | 'spacious';
  /** The host router's address, from an adapter (`@mistriwork/mistri/react/react-router`, …). Default: `window.history`. */
  navigator?: Navigator;
  /** What the shell would put in the tab's title; the tab is the host's, so it is not written unless asked. */
  onTitle?: (title: string) => void;
  children?: ReactNode;
}

interface EmbedContext {
  endpoint: string;
  navigator: Navigator | undefined;
  onTitle: ((title: string) => void) | undefined;
  preferences: Attachment['preferences'];
  /** The session begun, once, for every element under the Provider. */
  ready(): Promise<EmbedSession>;
  /** The server checked, and the shell's first answers for this App at this address: one request (server/embed/boot.ts). */
  boot(session: EmbedSession, app: string, at: { path: string; search: string }): Promise<EmbedBoot | undefined>;
}

const Context = createContext<EmbedContext | null>(null);

/* The shell, once an element has loaded it: a surface's navigator asks it which record is opening. */
let shellModule: ShellModule | undefined;

/**
 * The one boot read: which protocol the server speaks — a sentence when this
 * package cannot use it — and, asked for an App, the shell's first answers,
 * so its first draw costs this request instead of five. It carries the
 * session as every request of the shell's does: the cookie on this origin,
 * the bearer from another. Under a test or a source server (no version
 * built in) an answer that does not read is no answer, and the shell asks
 * for itself.
 */
async function bootServer(
  endpoint: string,
  session: Pick<EmbedSession, 'authorization'> | undefined,
  ask?: { app: string; path: string; search: string },
): Promise<EmbedBoot | undefined> {
  const authorization = session?.authorization();
  const query = ask ? `?${new URLSearchParams({ app: ask.app, path: ask.path, ...(ask.search ? { search: ask.search } : {}) })}` : '';
  let answer: unknown;
  try {
    const reply = await fetch(endpoint + EMBED_BOOT_PATH + query, {
      credentials: crossOrigin(endpoint) ? 'omit' : 'same-origin',
      ...(authorization ? { headers: { authorization } } : {}),
    });
    answer = reply.ok ? await reply.json() : null;
  } catch {
    if (!VERSION) return undefined;
    throw new Error(`@mistriwork/mistri/react could not reach a mistri server at ${endpoint}.`);
  }
  if (VERSION) {
    const refused = embedRefusal(VERSION, answer);
    if (refused) throw new Error(refused);
  }
  return answer && typeof answer === 'object' ? (answer as EmbedBoot) : undefined;
}

/** The server, the sign-in and how mistri looks, for every mistri element inside it. */
export function Provider({ endpoint, auth, theme, mode, density, navigator, onTitle, children }: ProviderProps) {
  const base = endpoint.replace(/\/+$/, '');
  const authRef = useRef(auth);
  authRef.current = auth;
  const titleRef = useRef(onTitle);
  titleRef.current = onTitle;
  const session = useRef<{
    endpoint: string;
    started: Promise<EmbedSession>;
    live?: EmbedSession;
    /** Each App's boot, asked once: the first element to need it, and StrictMode's second effect, share it. */
    boots: Map<string, Promise<EmbedBoot | undefined>>;
    /** A close waiting a tick (below). */
    closing?: ReturnType<typeof setTimeout>;
  } | null>(null);
  useEffect(() => {
    /* StrictMode's rehearsal unmounts and mounts again at once: the session it was about to close is still this
       Provider's, and closing it would sign the person in twice (two assertions, two exchanges, two boots). */
    const kept = session.current;
    if (kept?.closing !== undefined && kept.endpoint === base) {
      clearTimeout(kept.closing);
      kept.closing = undefined;
    }
    return () => {
      const held = session.current;
      if (!held) return;
      held.closing = setTimeout(() => {
        held.live?.close();
        if (session.current === held) session.current = null;
      });
    };
  }, [base]);
  const value = useMemo<EmbedContext>(
    () => ({
      endpoint: base,
      navigator,
      onTitle: (title) => titleRef.current?.(title),
      preferences: { theme, mode, density },
      ready() {
        if (session.current?.endpoint !== base) {
          const current = authRef.current;
          /* The host's `auth` as it is when the first element needs it; its assertion is read on every refresh. */
          const live = startSession(
            base,
            current && current !== 'cookie'
              ? {
                  assertion: () => (authRef.current && authRef.current !== 'cookie' ? authRef.current : current).assertion(),
                  onUnauthenticated: () =>
                    (authRef.current && authRef.current !== 'cookie' ? authRef.current : current).onUnauthenticated?.(),
                }
              : 'cookie',
          );
          /* The exchange comes first, so the boot is asked as the person it signed in. When it fails, a server
             this package cannot use says so in its own sentence (the bare boot) rather than as a refused sign-in. */
          const started = live.ready.then(
            () => live,
            async (error: unknown) => {
              await bootServer(base, undefined);
              throw error;
            },
          );
          session.current = { endpoint: base, started, live, boots: new Map() };
        }
        return session.current.started;
      },
      boot(live, app, at) {
        const boots = session.current?.endpoint === base ? session.current.boots : new Map<string, Promise<EmbedBoot | undefined>>();
        let booted = boots.get(app);
        if (!booted) {
          booted = bootServer(base, live, { app, ...at });
          boots.set(app, booted);
          /* A boot that failed is asked again by the next element, not remembered. */
          booted.catch(() => boots.delete(app));
        }
        return booted;
      },
    }),
    [base, navigator, theme, mode, density],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

function useEmbed(component: string): EmbedContext {
  const context = useContext(Context);
  if (!context) throw new Error(`<${component}> must be inside a <Provider>.`);
  return context;
}

export interface ElementProps {
  className?: string;
  /** Shown until the shell has drawn, and on the server. */
  fallback?: ReactNode;
}

/**
 * The element every mistri component renders: a slot the shell's root is
 * put in once it is loaded. The server and the client's first render draw the
 * same slot, so a hydrating host sees no mismatch.
 */
function Slot({
  component,
  className,
  fallback,
  attach,
  keyed,
}: ElementProps & {
  component: string;
  attach: (
    context: EmbedContext,
    session: EmbedSession,
  ) => Omit<Attachment, 'slot' | 'endpoint' | 'authorization' | 'title' | 'preferences'>;
  keyed: readonly unknown[];
}) {
  const context = useEmbed(component);
  const slot = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const attachRef = useRef(attach);
  attachRef.current = attach;
  useEffect(() => {
    let park: (() => void) | undefined;
    let gone = false;
    setProblem(null);
    Promise.all([
      context.ready().then(async (session) => {
        const attachment = attachRef.current(context, session);
        const boot = await context.boot(session, attachment.app, insideAddress(attachment));
        return { session, attachment, boot };
      }),
      loadShell(),
    ])
      .then(([{ session, attachment, boot }, shell]) => {
        shellModule = shell;
        if (gone || !slot.current) return;
        park = shell.attachShell({
          ...attachment,
          slot: slot.current,
          endpoint: context.endpoint,
          authorization: session.authorization,
          title: (text) => context.onTitle?.(text),
          preferences: context.preferences,
          ...(boot?.data ? { firstPaint: boot.data } : {}),
        });
        setDrawn(true);
      })
      .catch((error: unknown) => {
        if (gone) return;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`@mistriwork/mistri/react: ${message}`);
        setProblem(message);
      });
    return () => {
      gone = true;
      park?.();
    };
  }, [context, ...keyed]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={slot} className={className} data-mistri-slot={component}>
      {problem ? <p role="alert">{problem}</p> : drawn ? null : (fallback ?? null)}
    </div>
  );
}

/** Where an element's shell will start, in the inside form the boot plans its answers by: the App's id first. */
function insideAddress(attachment: Pick<Attachment, 'app' | 'navigator' | 'address'>): { path: string; search: string } {
  const here = attachment.navigator.current();
  const path = inward(attachment.address, here.pathname);
  const own = `/${encodeURIComponent(attachment.app)}`;
  return path === own || path?.startsWith(`${own}/`) ? { path, search: here.search } : { path: own, search: '' };
}

/** An address the shell reads as an App's: its id first. */
const inside = (app: string, ...segments: string[]) => `/${[app, ...segments].map(encodeURIComponent).join('/')}`;

const withParams = (path: string, params: Readonly<Record<string, string | undefined>>) => {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(name, value);
  const query = search.toString();
  return query ? `${path}?${query}` : path;
};

/** A surface's address is its own and its App's alone: the address bar's form is the inside one. */
const surfaceMount = (app: string): AddressMount => ({ base: '', apps: { [app]: app } });

export interface AppProps extends ElementProps {
  /** The App's id, as the server serves it. */
  app: string;
  /** Where the host shows it: the route that matches everything under it (`/crm/*`). */
  basePath: string;
}

/** The whole App under a prefix of the host's: its chrome, its rooms, its addresses below `basePath`. */
export function App({ app, basePath, className, fallback }: AppProps) {
  return (
    <Slot
      component="App"
      className={className}
      fallback={fallback}
      keyed={[app, basePath]}
      attach={(context) => ({
        app,
        surface: 'app',
        navigator: context.navigator ?? browserNavigator(),
        address: { base: parseBasePath(basePath, 'basePath'), apps: { [app]: '' } },
      })}
    />
  );
}

/** One surface on an address of its own, in memory: the host's address bar is never written. */
function Surface({
  component,
  app,
  surface,
  href,
  className,
  fallback,
  onOpenRecord,
}: ElementProps & {
  component: string;
  app: string;
  surface: Attachment['surface'];
  href: string;
  onOpenRecord?: (to: OpenedRecord) => void;
}) {
  const opened = useRef(onOpenRecord);
  opened.current = onOpenRecord;
  const navigator = useRef<ReturnType<typeof memoryNavigator> | null>(null);
  const shown = useRef(href);
  useEffect(() => {
    if (shown.current === href) return;
    shown.current = href;
    navigator.current?.reset(href);
  }, [href]);
  return (
    <Slot
      component={component}
      className={className}
      fallback={fallback}
      keyed={[app]}
      attach={() => {
        navigator.current = memoryNavigator(shown.current, {
          refuse: (to) => {
            if (!opened.current) return false;
            const record = openedRecord(app, to);
            if (!record) return false;
            opened.current(record);
            return true;
          },
        });
        return { app, surface, navigator: navigator.current, address: surfaceMount(app) };
      }}
    />
  );
}

/** A record a surface opened, for the host to show its own way. */
export interface OpenedRecord {
  /** The App's resource (its table). */
  resource: string;
  /** The record's key, by column. */
  key: Record<string, unknown>;
  /** The record's address relative to the App's root (`/leads/127`): under a `<App basePath="/crm">`, `/crm/leads/127`. */
  href: string;
}

function openedRecord(app: string, to: string): OpenedRecord | null {
  const record = shellModule?.openingRecord();
  if (!record) return null;
  const prefix = `/${encodeURIComponent(app)}`;
  return { ...record, href: to.startsWith(prefix) ? to.slice(prefix.length) || '/' : to };
}

export interface ListProps extends ElementProps {
  app: string;
  /** The list view's key, as `views.ts` names it. */
  view: string;
  /** One of the view's tabs, by its word in the address (`working`). */
  tab?: string;
  search?: string;
  /** Refinements by field, as the list's address says them (`{ status: 'open', amount: '..500' }`). */
  filters?: Readonly<Record<string, string>>;
  /** A record opened from the list. Given, the host shows it; otherwise it opens in place, with a way back. */
  onOpenRecord?: (to: OpenedRecord) => void;
}

/** One of the App's lists, without the App's chrome. */
export function List({ app, view, tab, search, filters, onOpenRecord, className, fallback }: ListProps) {
  const href = withParams(inside(app, view), { tab, search, ...filters });
  return (
    <Surface component="List" app={app} surface="list" href={href} className={className} fallback={fallback} onOpenRecord={onOpenRecord} />
  );
}

export interface RecordProps extends ElementProps {
  app: string;
  /** The App's resource (its table). */
  resource: string;
  id: string | number;
}

/** One record, as its page shows it, without the App's chrome. */
export function Record({ app, resource, id, className, fallback }: RecordProps) {
  return (
    <Surface
      component="Record"
      app={app}
      surface="record"
      href={`${inside(app, resource)}/~${encodeURIComponent(String(id))}`}
      className={className}
      fallback={fallback}
    />
  );
}

export interface DashboardProps extends ElementProps {
  app: string;
  /** The dashboard view's key. */
  view: string;
  /** One of its windows (`last-30-days`). */
  period?: string;
}

/** One of the App's dashboards, without the App's chrome. */
export function Dashboard({ app, view, period, className, fallback }: DashboardProps) {
  return (
    <Surface
      component="Dashboard"
      app={app}
      surface="dashboard"
      href={withParams(inside(app, view), { period })}
      className={className}
      fallback={fallback}
    />
  );
}

export interface PageProps extends ElementProps {
  app: string;
  /** The free-form page's path (`definePage`, `pages/<path>.page.tsx`). */
  page: string;
  /** The parameters it keeps (`useParam`). */
  params?: Readonly<Record<string, string>>;
}

/** One of the App's free-form pages, without the App's chrome. */
export function Page({ app, page, params, className, fallback }: PageProps) {
  return (
    <Surface
      component="Page"
      app={app}
      surface="page"
      href={withParams(`/${encodeURIComponent(app)}/${page.split('/').map(encodeURIComponent).join('/')}`, { ...params })}
      className={className}
      fallback={fallback}
    />
  );
}

export interface AssistantProps extends ElementProps {
  app: string;
  /**
   * Where the assistant is drawn: `page`, its own room, the one placement a
   * surface without the App's chrome can hold (the App's assistant says
   * `placement: [..., 'page']`). The panel and the record placement belong to
   * the App's chrome, and are `<App>`'s.
   */
  placement?: 'page';
  /** One of the person's conversations to open, by its id; the newest otherwise. */
  conversation?: string;
}

/** The App's assistant, in its own room. */
export function Assistant({ app, placement = 'page', conversation, className, fallback }: AssistantProps) {
  if (placement !== 'page') {
    throw new Error(
      `<Assistant placement="${String(placement)}">: a surface draws the assistant's page; its panel and its place on a record are the App's chrome, shown by <App>.`,
    );
  }
  return (
    <Surface
      component="Assistant"
      app={app}
      surface="assistant"
      href={conversation ? inside(app, 'assistant', conversation) : inside(app, 'assistant')}
      className={className}
      fallback={fallback}
    />
  );
}
