/**
 * `@mistriwork/mistri/react/tanstack-router`: the shell under TanStack Router (or
 * Start). The host's route is a splat under the App's prefix (`crm/$`); the
 * shell writes below it through the router's history, its walk in the
 * entry's state beside the router's keys, and hears every other move through
 * the history's subscription.
 *
 *   const navigator = useTanStackNavigator();
 *   <Provider endpoint="/api/tw" navigator={navigator}>…
 */
import { useEffect, useMemo } from 'react';
import { useRouter } from '@tanstack/react-router';
import { routerNavigator, type Navigator } from './navigator.js';

export function useTanStackNavigator(): Navigator {
  const { history } = useRouter();
  const navigator = useMemo(
    () =>
      routerNavigator({
        read: () => {
          const { pathname, search, state } = history.location;
          return { pathname, search, state };
        },
        push: (href, entry) => history.push(href, entry),
        replace: (href, entry) => {
          const kept = history.location.state;
          history.replace(href, { ...(kept && typeof kept === 'object' ? kept : {}), ...entry });
        },
      }),
    [history],
  );
  useEffect(() => history.subscribe(() => navigator.hostMoved()), [history, navigator]);
  return navigator;
}
