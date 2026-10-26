/**
 * `@mistriwork/mistri/react`: a mistri App inside a React app's own route, or one of its surfaces inside one of
 * the host's screens. React and React DOM are the host's; a host imports no stylesheet of mistri's.
 *
 *   import { App, Provider } from '@mistriwork/mistri/react';
 *   import { useReactRouterNavigator } from '@mistriwork/mistri/react/react-router';
 *
 *   function Crm() {
 *     const navigator = useReactRouterNavigator();
 *     return (
 *       <Provider endpoint="/api/tw" navigator={navigator}>
 *         <App app="compass" basePath="/crm" />
 *       </Provider>
 *     );
 *   }
 *   // <Route path="/crm/*" element={<Crm />} />
 *
 * The endpoint is the mistri server: the handler mounted in the host's server (`@mistriwork/mistri/handler`), or a
 * mistri process behind a rewrite. The elements draw an empty slot on the server and on the client's first
 * render, and the shell is loaded the first time one is on screen. One App is drawn per page, and one element at a
 * time: the whole App, or one of its surfaces.
 */
import type * as ReactTypes from 'react';
import type { Theme } from '@mistriwork/engine/schema/theme.js';

/** Where the shell is, in the address bar's form, and its entry's mistri state (never the host's). */
export interface Location {
  pathname: string;
  search: string;
  state: unknown;
}

/** The address, as the host's router keeps it: what an adapter (`@mistriwork/mistri/react/react-router`, …) returns. */
export interface Navigator {
  current(): Location;
  push(href: string, state: unknown): void;
  replace(href: string, state: unknown): void;
  /** Called on every navigation the shell did not make itself (Back, a host link). Returns its remover. */
  listen(onChange: () => void): () => void;
  /** Leave the single-page app (sign-out, a deploy reload). Default: `location.assign`. */
  hard?(href: string): void;
}

/** What a router can do, for an adapter of a router mistri has none for (`routerNavigator`). */
export interface RouterMoves {
  /** The router's location now, with the state of its entry as the router keeps it. */
  read(): Location;
  /** Navigate to a new entry whose state is `entry`; what the router held in the entry it leaves is not carried. */
  push(href: string, entry: Record<string, unknown>): void;
  /** Rewrite the current entry: keep what the router holds in its state and add `entry` beside it. */
  replace(href: string, entry: Record<string, unknown>): void;
  hard?(href: string): void;
}

/** The default navigator: `window.history`, for a host with no router or one that only reads the address. */
export declare function browserNavigator(): Navigator;
/** A navigator over a router; the adapter calls `hostMoved` each time the router's location changes. */
export declare function routerNavigator(moves: RouterMoves): Navigator & { hostMoved(): void };

/**
 * `'cookie'` (the default): the page already carries mistri's session. Otherwise the host's own session is
 * exchanged for one: `assertion` returns a short-lived assertion minted on the host's server
 * (`mintEmbedAssertion`, `@mistriwork/mistri/handler`), fresh on every call; a rejection with `status: 401` means the host's
 * person is gone, and mistri signs out too.
 */
export type Auth =
  | 'cookie'
  | {
      assertion: () => Promise<string>;
      onUnauthenticated?: () => void;
    };

export interface ProviderProps {
  /** Where the mistri server answers: `/api/tw` (same origin, recommended) or `https://tw.example.com/tools`. */
  endpoint: string;
  auth?: Auth;
  /** Worn in place of the reader's choice: a look's id (`lumen`, `mono`, `sage`, or one the App defines), or the
   *  host's own `defineTheme(...)` from `@mistriwork/mistri/app`, which dresses the App as its own `ui.theme` would. */
  theme?: string | Theme;
  mode?: 'light' | 'dark' | 'system';
  /** The density a reader who has not chosen one sees. */
  density?: 'compact' | 'comfortable' | 'spacious';
  /** The host router's address, from an adapter. Default: `window.history`. */
  navigator?: Navigator;
  /** What the shell would put in the tab's title; the tab is the host's, so it is not written unless asked. */
  onTitle?: (title: string) => void;
  children?: ReactTypes.ReactNode;
}

/** Every element's: the slot's class, and what it shows until the shell has drawn (and on the server). */
export interface ElementProps {
  className?: string;
  fallback?: ReactTypes.ReactNode;
}

export interface AppProps extends ElementProps {
  /** The App's id, as the server serves it. */
  app: string;
  /** Where the host shows it: the route that matches everything under it (`/crm/*`). */
  basePath: string;
}

/** A record a surface opened, for the host to show its own way. */
export interface OpenedRecord {
  resource: string;
  key: Record<string, unknown>;
  /** The record's address relative to the App's root (`/leads/127`). */
  href: string;
}

export interface ListProps extends ElementProps {
  app: string;
  /** The list view's key. */
  view: string;
  /** One of the view's tabs, by its word in the address (`working`). */
  tab?: string;
  search?: string;
  /** Refinements by field, as the list's address says them (`{ status: 'open', amount: '..500' }`). */
  filters?: Readonly<Record<string, string>>;
  /** A record opened from the list. Given, the host shows it; otherwise it opens in place, with a way back. */
  onOpenRecord?: (to: OpenedRecord) => void;
}

export interface RecordProps extends ElementProps {
  app: string;
  /** The App's resource (its table). */
  resource: string;
  id: string | number;
}

export interface DashboardProps extends ElementProps {
  app: string;
  view: string;
  /** One of its windows (`last-30-days`). */
  period?: string;
}

export interface PageProps extends ElementProps {
  app: string;
  /** The free-form page's path (`definePage`). */
  page: string;
  params?: Readonly<Record<string, string>>;
}

export interface AssistantProps extends ElementProps {
  app: string;
  /** `page` (the default): the assistant's own room, the one placement a surface without the App's chrome holds.
   *  Its panel and its place on a record are the chrome's, shown by `<App>`. */
  placement?: 'page';
  /** One of the person's conversations to open, by its id; the newest otherwise. */
  conversation?: string;
}

/** The server, the sign-in and how mistri looks, for every mistri element inside it. */
export declare function Provider(props: ProviderProps): ReactTypes.ReactElement;
/** The whole App under a prefix of the host's: its chrome, its rooms, its addresses below `basePath`. */
export declare function App(props: AppProps): ReactTypes.ReactElement;
/** One of the App's lists, without its chrome, on an address of its own in memory. */
export declare function List(props: ListProps): ReactTypes.ReactElement;
/** One record, as its page shows it, without the App's chrome. */
export declare function Record(props: RecordProps): ReactTypes.ReactElement;
/** One of the App's dashboards, without its chrome. */
export declare function Dashboard(props: DashboardProps): ReactTypes.ReactElement;
/** One of the App's free-form pages, without its chrome. */
export declare function Page(props: PageProps): ReactTypes.ReactElement;
/** The App's assistant in its own room (an assistant with `placement: 'page'`). */
export declare function Assistant(props: AssistantProps): ReactTypes.ReactElement;
