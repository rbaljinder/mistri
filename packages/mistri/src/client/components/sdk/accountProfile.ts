/**
 * `useAccountProfile()`: the signed-in reader's own account profile (`name`, `email`, `providers`), and saving changes
 * to their display name or requesting an email change. Read through the page's query cache like `useTeam()`, scoped by
 * the signed-in account so signing out or switching accounts never shows a stale profile.
 */
import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useUiHost } from './context.js';
import { useViewer } from './hooks.js';
import type { AccountProfile } from '../../../shared/accountProfile.js';

interface UiAccountProfile {
  profile: AccountProfile | null;
  isPending: boolean;
  isSaving: boolean;
  error: Error | null;
  save(name: string): Promise<AccountProfile>;
  changeEmail(newEmail: string): Promise<void>;
}

export function useAccountProfile(): UiAccountProfile {
  const host = useUiHost();
  const viewer = useViewer();
  const client = useQueryClient();
  const [savingCount, setSavingCount] = useState(0);
  const accountKey = viewer.signedIn ? viewer.account : 'guest';
  const scope = host.scope;
  const scopeKey = scope.map(String).join('\0');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const key = useMemo(() => ['mistri-ui', 'account-profile', accountKey, ...scope], [accountKey, scopeKey]);
  const query = useQuery({
    queryKey: key,
    queryFn: () => (viewer.signedIn ? host.accountProfile.read() : Promise.resolve(null)),
  });
  const save = useCallback(
    async (name: string): Promise<AccountProfile> => {
      setSavingCount((n) => n + 1);
      try {
        const updated = await host.accountProfile.save(name);
        client.setQueryData(key, updated);
        return updated;
      } finally {
        setSavingCount((n) => n - 1);
      }
    },
    [client, host, key],
  );
  const changeEmail = useCallback(
    async (newEmail: string): Promise<void> => {
      setSavingCount((n) => n + 1);
      try {
        await host.accountProfile.changeEmail(newEmail);
      } finally {
        setSavingCount((n) => n - 1);
      }
    },
    [host],
  );
  return {
    profile: viewer.signedIn ? (query.data ?? null) : null,
    isPending: viewer.signedIn ? query.isPending : false,
    isSaving: savingCount > 0,
    error: query.error,
    save,
    changeEmail,
  };
}
