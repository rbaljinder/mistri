/**
 * A React app of someone else's, with a router of its own, that shows
 * Compass at `/crm` through @mistriwork/mistri/react. Its router is the smallest one
 * that behaves like the real ones: the location is React state, a link
 * pushes, Back pops, and the location a component reads lags the address bar
 * by a render — which is what `routerNavigator` exists to absorb.
 *
 * `window.__bareHost` (set by the spec before the page loads) leaves the
 * host's stylesheet out, so the spec can compare tablewalk's computed styles
 * with and without it. `window.__signIn` hands the Provider the host's
 * sign-in (`auth.assertion`, from its own server's `/host/assertion`), for
 * e2e/embed-react-signin.spec.ts.
 */
import { StrictMode, createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  App,
  List,
  Provider,
  Record,
  routerNavigator,
  type OpenedRecord,
  type Navigator,
} from '../../../packages/mistri/src/embed/index.tsx';
import hostCss from './host.css?inline';

interface Place {
  pathname: string;
  search: string;
  state: unknown;
  key: number;
}

interface Router {
  place: Place;
  navigate(href: string, options?: { replace?: boolean; state?: unknown }): void;
}

const RouterContext = createContext<Router | null>(null);
const useRouter = () => useContext(RouterContext)!;

let keys = 0;
const read = (): Place => ({ pathname: location.pathname, search: location.search, state: history.state, key: ++keys });

function HostRouter({ children }: { children: ReactNode }) {
  const [place, setPlace] = useState(read);
  useEffect(() => {
    const popped = () => setPlace(read());
    addEventListener('popstate', popped);
    return () => removeEventListener('popstate', popped);
  }, []);
  const router = useMemo<Router>(
    () => ({
      place,
      navigate(href, options = {}) {
        if (options.replace) history.replaceState(options.state ?? null, '', href);
        else history.pushState(options.state ?? null, '', href);
        setPlace(read());
      },
    }),
    [place],
  );
  return <RouterContext.Provider value={router}>{children}</RouterContext.Provider>;
}

function Link({ to, children }: { to: string; children: ReactNode }) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      onClick={(event) => {
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/** The adapter a host writes for a router tablewalk has none for: the same few lines as react-router.ts. */
function useHostNavigator(): Navigator {
  const router = useRouter();
  const latest = useRef(router);
  latest.current = router;
  const navigator = useMemo(
    () =>
      routerNavigator({
        read: () => latest.current.place,
        push: (href, entry) => latest.current.navigate(href, { state: entry }),
        replace: (href, entry) => latest.current.navigate(href, { replace: true, state: entry }),
      }),
    [],
  );
  const seen = useRef(router.place.key);
  useEffect(() => {
    if (seen.current === router.place.key) return;
    seen.current = router.place.key;
    navigator.hostMoved();
  }, [router.place.key, navigator]);
  return navigator;
}

function Bar() {
  return (
    <nav className="host-bar" aria-label="Host">
      <Link to="/">Home</Link>
      <Link to="/crm/leads">Leads</Link>
      <Link to="/crm/accounts">Accounts</Link>
      <Link to="/lead-list">Lead list</Link>
    </nav>
  );
}

function Home() {
  return (
    <main>
      <h1>The host</h1>
      <p>Someone else’s app.</p>
      <button type="button">Host button</button>
    </main>
  );
}

function LeadList() {
  const [opened, setOpened] = useState<OpenedRecord | null>(null);
  return (
    <main>
      <output aria-label="Opened record">{opened ? `${opened.resource} ${JSON.stringify(opened.key)} ${opened.href}` : ''}</output>
      <List app="compass" view="leads" tab="working" onOpenRecord={setOpened} className="host-app" />
    </main>
  );
}

const auth = (window as { __signIn?: boolean }).__signIn
  ? { assertion: () => fetch('/host/assertion', { method: 'POST' }).then((reply) => reply.text()) }
  : undefined;

function Host() {
  const { place } = useRouter();
  const navigator = useHostNavigator();
  return (
    <Provider endpoint="/api/tw" auth={auth} navigator={navigator} onTitle={(title) => (document.title = `${title} · Host`)}>
      <Bar />
      {place.pathname === '/crm' || place.pathname.startsWith('/crm/') ? (
        <App app="compass" basePath="/crm" className="host-app" fallback={<p>Loading the CRM…</p>} />
      ) : place.pathname === '/lead-list' ? (
        <LeadList />
      ) : place.pathname.startsWith('/lead/') ? (
        <Record app="compass" resource="lead" id={place.pathname.slice('/lead/'.length)} className="host-app" />
      ) : (
        <Home />
      )}
    </Provider>
  );
}

if (!(window as { __bareHost?: boolean }).__bareHost) {
  const style = document.createElement('style');
  style.textContent = hostCss;
  document.head.append(style);
}

createRoot(document.getElementById('host')!).render(
  <StrictMode>
    <HostRouter>
      <Host />
    </HostRouter>
  </StrictMode>,
);
