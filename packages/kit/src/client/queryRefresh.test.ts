import { afterEach, expect, test, vi } from 'vitest';
import { QueryObserver } from '@tanstack/react-query';
import { FOCUS_ALWAYS, queryClient } from './components/mount.js';
import {
  acceptTenantRenewal,
  captureTenantLease,
  establishSessionIdentity,
  establishTenantSelection,
  lockSessionIdentity,
  requireTenantSelection,
  suspendTenantLease,
  tenantLeaseActive,
} from './sessionIdentity.js';

afterEach(() => {
  queryClient.clear();
  lockSessionIdentity();
});

function observe(read: () => Promise<string>) {
  const observer = new QueryObserver(queryClient, { queryKey: ['refresh-proof'], queryFn: read, staleTime: 0 });
  const unsubscribe = observer.subscribe(() => {});
  return { observer, unsubscribe };
}

test('tenant browser wake cannot refetch dirty record sources before or after lease renewal', async () => {
  establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'app' });
  requireTenantSelection();
  const owner = establishTenantSelection({
    appId: 'app',
    accountId: 'alice',
    tenantId: 'north',
    tabId: 'tab',
    context: 'context',
    revision: 1,
    expiresAt: Date.now() + 60_000,
  });
  const read = vi.fn(async () => {
    if (!tenantLeaseActive(owner)) throw new Error('Unavailable tenant context');
    return 'Original record';
  });
  const { observer, unsubscribe } = observe(read);
  try {
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe('Original record'));
    const lease = captureTenantLease(owner)!;
    suspendTenantLease(owner);
    queryClient.getQueryCache().onOnline();
    queryClient.getQueryCache().onFocus();
    await Promise.resolve();
    expect(read).toHaveBeenCalledOnce();
    expect(observer.getCurrentResult().isError).toBe(false);
    expect(observer.getCurrentResult().data).toBe('Original record');
    acceptTenantRenewal(owner, lease.revision, { ...lease, revision: lease.revision + 1 });
    queryClient.getQueryCache().onOnline();
    queryClient.getQueryCache().onFocus();
    await Promise.resolve();
    expect(read).toHaveBeenCalledOnce();
    // Confirmed writes/explicit refresh still use the same shared cache.
    await queryClient.invalidateQueries({ queryKey: ['refresh-proof'] });
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
  }
});

/* A tab coming back re-reads the record on screen, and anything older than a
   minute; what it read a moment ago stands (mount.tsx, FOCUS_ALWAYS). */
test.each(['anonymous', 'account'])(
  'ordinary %s browsing refreshes the shown record and old reads on focus, not fresh ones',
  async (mode) => {
    establishSessionIdentity(mode === 'anonymous' ? { signedIn: false } : { signedIn: true, accountId: 'alice', appId: 'app' });
    const read = vi.fn(async () => 'Record');
    const { observer, unsubscribe } = observe(read);
    const shownRead = vi.fn(async () => 'Shown');
    const shown = new QueryObserver(queryClient, { queryKey: ['refresh-shown'], queryFn: shownRead, staleTime: 0, meta: FOCUS_ALWAYS });
    const unsubscribeShown = shown.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe('Record'));
      await vi.waitFor(() => expect(shown.getCurrentResult().data).toBe('Shown'));
      queryClient.getQueryCache().onFocus();
      await vi.waitFor(() => expect(shownRead).toHaveBeenCalledTimes(2));
      expect(read).toHaveBeenCalledOnce();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
      queryClient.getQueryCache().onFocus();
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      vi.restoreAllMocks();
      await vi.waitFor(() => expect(observer.getCurrentResult().isFetching).toBe(false));
      queryClient.getQueryCache().onOnline();
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    } finally {
      unsubscribe();
      unsubscribeShown();
      vi.restoreAllMocks();
    }
  },
);
