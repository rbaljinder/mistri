/**
 * `@mistriwork/mistri/react/react-router`: the shell under React Router (v6.4 and v7,
 * `<BrowserRouter>` or a data router). The host's route matches everything
 * under the App's prefix, `<Route path="/crm/*">`; the shell writes below it
 * with `navigate`, its walk in the entry's state beside the router's own, and
 * hears a host `<Link>` or Back through `useLocation`.
 *
 *   const navigator = useReactRouterNavigator();
 *   <Provider endpoint="/api/tw" navigator={navigator}>…
 */
import { useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { routerNavigator, type Navigator } from './navigator.js';

export function useReactRouterNavigator(): Navigator {
  const navigate = useNavigate();
  const location = useLocation();
  const latest = useRef({ navigate, location });
  latest.current = { navigate, location };
  const navigator = useMemo(
    () =>
      routerNavigator({
        read: () => {
          const { pathname, search, state } = latest.current.location;
          return { pathname, search, state };
        },
        push: (href, entry) => void latest.current.navigate(href, { state: entry }),
        replace: (href, entry) => {
          const kept = latest.current.location.state;
          void latest.current.navigate(href, {
            replace: true,
            state: { ...(kept && typeof kept === 'object' ? kept : {}), ...entry },
          });
        },
      }),
    [],
  );
  const seen = useRef(location.key);
  useEffect(() => {
    if (seen.current === location.key) return;
    seen.current = location.key;
    navigator.hostMoved();
  }, [location.key, navigator]);
  return navigator;
}
