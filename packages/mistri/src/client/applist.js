/**
 * An app's list page, as the vanilla client reaches it.
 *
 * The page is a component (components/AppList.tsx), the room around it —
 * the redirect a bare table takes to its first tab, the New button — is
 * components/Rooms.tsx, and what it is made of is components/appListModel.ts. What
 * stays here is the saved-views warm-up (the store is components/myViews.ts)
 * and the model's exports under the names the rest of the client has always
 * imported.
 */
import { queryClient } from '@mistriwork/kit/client/components/mount.js';
import { fetchSavedViews, savedViewsKey } from '@mistriwork/kit/client/components/myViews.js';
import { sessionIdentity, subscribeSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { say } from './copy/workbench/applist.js';

subscribeSessionIdentity(() => queryClient.removeQueries({ queryKey: ['filters'] }));

export { appListFor, appListQuery, appCrumbLabel } from '@mistriwork/kit/client/components/appListModel.js';

/**
 * Warm the per-connection saved-filters cache off the critical path. The
 * first app list of a connection used to pay a filters round trip in front
 * of its rows fetch; prefetched at connection load, the in-render read is a
 * cache hit. Same key the list reads.
 */
export function loadSavedFilters() {
  const owner = sessionIdentity();
  return queryClient
    .prefetchQuery({
      queryKey: savedViewsKey(),
      queryFn: async () => {
        if (owner !== sessionIdentity()) throw new Error(say('theSavedFiltersBelong'));
        const saved = await fetchSavedViews();
        if (owner !== sessionIdentity()) throw new Error(say('theSavedFiltersBelong'));
        return saved;
      },
      staleTime: Infinity,
    })
    .then(
      () => undefined,
      () => undefined,
    );
}
