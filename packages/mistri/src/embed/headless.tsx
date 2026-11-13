/**
 * `@mistriwork/mistri/react/headless`: a front end that draws everything itself and uses mistri as its back end.
 *
 *   <Provider endpoint="/api/mistri" app="compass" surface="leads">
 *     <Leads />   // useRows('leads'), useCommand('qualify'), … with the front end's own elements
 *   </Provider>
 *
 * It asks the boot for the surface as this reader may use it, then provides the surface as the page frame the hooks
 * hold a component to (its declared reads and commands) and the host they read through (./host.ts), which names the
 * surface on every request so the server can refuse anything outside it. It draws nothing of mistri's: no shell, no
 * stylesheet, no chrome — only the front end's own children. Its own entry, apart from `@mistriwork/mistri/react`, so
 * the embedding Provider stays as small as it was and this one carries the hooks with no lazy step.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UiHostContext, UiPageContext, type UiHost, type UiPageFrame } from '../client/components/sdk/context.js';
import { EMBED_BOOT_PATH, embedRefusal, type EmbedBoot, type EmbedSurface } from '../shared/embedProtocol.js';
import { embedHost } from './host.js';
import { crossOrigin, startSession, type Auth, type EmbedSession } from './session.js';
import { browserNavigator, type Navigator } from './navigator.js';

export { useAction, useBreakdown, useCommand, useForm, useGranted, useHref, useRecord, useRows } from '../client/components/sdk/hooks.js';
export { useOptions } from '../client/components/sdk/options.js';
export type { Auth } from './session.js';
export type { Navigator } from './navigator.js';

export interface HeadlessProviderProps {
  /** Where the mistri handler answers: this page's origin (`/api/mistri`) or another one. */
  endpoint: string;
  /** `'cookie'` (the default): the page already carries mistri's session. Or exchange the host's own sign-in. */
  auth?: Auth;
  /** The App the surface belongs to. */
  app: string;
  /** The surface's key (`defineSurface`): every read and command the children use is one it declares. */
  surface: string;
  /** Where the front end's own pages live, for `useHref`; the front end keeps its own addresses. */
  basePath?: string;
  /** The front end's router, when a hook moves to another address; the window's history otherwise. */
  navigator?: Navigator;
  /** Drawn until the surface is open, and while no one is signed in. */
  fallback?: ReactNode;
  /** The package's version, to check the server's protocol against; none under a test or a source server. */
  version?: string;
  children?: ReactNode;
}

/**
 * The surface as a free-form page's frame: a hook may name a resource as the surface declared it, or by its name or
 * table in the reader's catalog, and run the commands it runs. It keeps no address: the front end keeps its own.
 */
export function surfaceFrame(surface: EmbedSurface): UiPageFrame {
  return {
    view: surface.key,
    label: surface.label,
    reads: [...new Set([...surface.declared, ...surface.reads.flatMap((read) => [read.name, read.id])])],
    commands: surface.commands.map((command) => command.id),
    actions: [],
    params: [],
    ...(surface.loader ? { loader: surface.key } : {}),
    get: () => undefined,
    set: () => {},
  };
}

/** The boot, asked for the surface: undefined signed out; the server's sentence when it refuses the surface. */
async function bootSurface(
  endpoint: string,
  session: Pick<EmbedSession, 'authorization'>,
  app: string,
  key: string,
  version: string | undefined,
): Promise<EmbedSurface | undefined> {
  const authorization = session.authorization();
  const reply = await fetch(`${endpoint}${EMBED_BOOT_PATH}?${new URLSearchParams({ app, surface: key })}`, {
    credentials: crossOrigin(endpoint) ? 'omit' : 'same-origin',
    ...(authorization ? { headers: { authorization } } : {}),
  });
  const answer = (await reply.json().catch(() => null)) as (EmbedBoot & { error?: string }) | null;
  if (version) {
    const refused = embedRefusal(version, answer);
    if (refused) throw new Error(refused);
  }
  if (!reply.ok) throw new Error(answer?.error ?? `The surface "${key}" could not be opened (${reply.status}).`);
  return answer?.signedIn && answer.surface ? answer.surface : undefined;
}

/** The version this package was built from; under a test or a source server, no build said one. */
const VERSION = typeof __MISTRI_VERSION__ === 'string' ? __MISTRI_VERSION__ : undefined;

/** The surface, its reads and its commands, for every hook inside it; nothing of mistri's is drawn. */
export function Provider({
  endpoint,
  auth,
  app,
  surface: key,
  basePath,
  navigator,
  version = VERSION,
  fallback,
  children,
}: HeadlessProviderProps) {
  const base = endpoint.replace(/\/+$/, '');
  /* The host's `auth` as it is when the session starts; its assertion is read again on every refresh. */
  const authRef = useRef(auth);
  authRef.current = auth;
  const cookie = !auth || auth === 'cookie';
  /* The surface's reads are cached apart from the host's own TanStack client, if it has one: they are this reader's. */
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }));
  const [opened, setOpened] = useState<{ surface: EmbedSurface; host: UiHost } | null>(null);
  useEffect(() => {
    if (!app || !key) return;
    let gone = false;
    setOpened(null);
    const held = authRef.current;
    const session = startSession(
      base,
      !held || held === 'cookie'
        ? 'cookie'
        : {
            assertion: () => (authRef.current && authRef.current !== 'cookie' ? authRef.current : held).assertion(),
            onUnauthenticated: () => (authRef.current && authRef.current !== 'cookie' ? authRef.current : held).onUnauthenticated?.(),
          },
    );
    session.ready
      .then(async () => {
        const found = await bootSurface(base, session, app, key, version);
        if (gone) return;
        if (!found) {
          console.error(`@mistriwork/mistri/react/headless: the surface "${key}" needs a signed-in person; drawing the fallback.`);
          return;
        }
        client.clear();
        /* The host reads the session's bearer on every request, so a refreshed one is used as it arrives. The window's
           history is read here, on the client, never while the server renders. */
        const moves = navigator ?? browserNavigator();
        setOpened({
          surface: found,
          host: embedHost({ surface: found, endpoint: base, authorization: session.authorization, navigator: moves, basePath }),
        });
      })
      .catch((error: unknown) => {
        if (!gone) console.error(`@mistriwork/mistri/react/headless: ${error instanceof Error ? error.message : String(error)}`);
      });
    return () => {
      gone = true;
      session.close();
    };
  }, [base, cookie, app, key, basePath, navigator, version, client]);
  const frame = useMemo(() => (opened ? surfaceFrame(opened.surface) : null), [opened]);
  if (!app || !key)
    throw new Error(
      '<Provider> from @mistriwork/mistri/react/headless names the App and the surface its children use: app="…" surface="…".',
    );
  if (!opened || !frame) return <>{fallback ?? null}</>;
  return (
    <QueryClientProvider client={client}>
      <UiHostContext.Provider value={opened.host}>
        <UiPageContext.Provider value={frame}>{children}</UiPageContext.Provider>
      </UiHostContext.Provider>
    </QueryClientProvider>
  );
}
