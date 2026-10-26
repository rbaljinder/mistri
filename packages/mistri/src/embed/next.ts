/**
 * `@mistriwork/mistri/react/next`: the shell under the Next.js App Router (14.1 and
 * later). The host's page is an optional catch-all under the App's prefix,
 * `app/crm/[[...rest]]/page.tsx`. The shell writes the window's history
 * directly, which the App Router keeps in step with `usePathname` and whose
 * entries it keeps its own tree in; the walk rides beside that tree. A host
 * `<Link>` reaches the shell through `usePathname`/`useSearchParams`, Back
 * and Forward through `popstate`.
 *
 *   const navigator = useNextNavigator();
 *   <Provider endpoint="/api/tw" navigator={navigator}>…
 */
import { useEffect, useMemo, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { routerNavigator, type Navigator } from './navigator.js';

export function useNextNavigator(): Navigator {
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? '';
  const navigator = useMemo(
    () =>
      routerNavigator({
        read: () => ({ pathname: window.location.pathname, search: window.location.search, state: window.history.state }),
        push: (href, entry) => window.history.pushState(entry, '', href),
        replace: (href, entry) => {
          const kept = window.history.state;
          window.history.replaceState({ ...(kept && typeof kept === 'object' ? kept : {}), ...entry }, '', href);
        },
      }),
    [],
  );
  useEffect(() => {
    const moved = () => navigator.hostMoved();
    window.addEventListener('popstate', moved);
    return () => window.removeEventListener('popstate', moved);
  }, [navigator]);
  const seen = useRef(`${pathname}?${search}`);
  useEffect(() => {
    const now = `${pathname}?${search}`;
    if (seen.current === now) return;
    seen.current = now;
    navigator.hostMoved();
  }, [pathname, search, navigator]);
  return navigator;
}
