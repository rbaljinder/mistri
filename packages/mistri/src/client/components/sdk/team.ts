/**
 * `useTeam()`: the current tenant's members and pending invitations, and what the reader may do with them. Read through
 * the page's one query cache like every other hook, so each action refreshes it; `canManage` is whether the reader's
 * grant lets them change the team at all. Outside a tenant App it is an empty team that manages nothing. The server
 * judges every request: the roles offered (`roles`) and `canManage` only say what to draw.
 */
import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useUiHost } from './context.js';
import { EMPTY_TEAM, type TeamHandoff, type TeamInvitation, type TeamMember } from '../../teamTypes.js';

interface UiTeam {
  members: readonly TeamMember[];
  invitations: readonly TeamInvitation[];
  roles: readonly string[];
  canManage: boolean;
  isPending: boolean;
  error: Error | null;
  /** Invite by email into a role; the one-time `token` is what the invitee is handed, where the server returned one. */
  invite(email: string, role: string): Promise<TeamHandoff>;
  changeRole(memberId: string, role: string): Promise<void>;
  remove(memberId: string): Promise<void>;
  /** A new invitation in place of a pending one; its one-time `token` is handed over like `invite`'s. */
  reissue(invitationId: string): Promise<TeamHandoff>;
  cancel(invitationId: string): Promise<void>;
}

export function useTeam(): UiTeam {
  const host = useUiHost();
  const client = useQueryClient();
  const key = useMemo(() => ['mistri-ui', 'team', ...host.scope], [host]);
  const query = useQuery({ queryKey: key, queryFn: () => host.team.read() });
  /* Each action settles, then the team is read again, whether it applied or not: a refusal means the page was stale. */
  const act = useCallback(
    async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } finally {
        await client.invalidateQueries({ queryKey: ['mistri-ui', 'team'] });
      }
    },
    [client],
  );
  const read = query.data ?? EMPTY_TEAM;
  return {
    members: read.members,
    invitations: read.invitations,
    roles: read.roles,
    canManage: read.canManage,
    isPending: query.isPending,
    error: query.error,
    invite: (email, role) => act(() => host.team.invite(email, role)),
    changeRole: (memberId, role) => act(() => host.team.changeRole(memberId, role)),
    remove: (memberId) => act(() => host.team.remove(memberId)),
    reissue: (invitationId) => act(() => host.team.reissue(invitationId)),
    cancel: (invitationId) => act(() => host.team.cancel(invitationId)),
  };
}
