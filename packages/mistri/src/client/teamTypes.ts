/** What `useTeam()` reads and does, apart from the routes that answer it (teamAccess.ts), so a headless surface can name an empty team without them. */
import { say } from './copy/tenancy/teamAccess.js';

export interface TeamMember {
  readonly id: string;
  /** The member's account id: what `useViewer().account` and a command's `actor.id` say, so what a pick is stored by. */
  readonly account: string;
  readonly name: string;
  /** Up to two letters of the name, for a mark beside it; empty where the member has no name. */
  readonly initials: string;
  /** Empty in a `'names'` read: an address is the administration's to say. */
  readonly email: string;
  /** Empty in a `'names'` read, as `email` is. */
  readonly role: string;
  readonly you: boolean;
}
/** Which list a team read is: the administration's (a manager's), the members' names (any member's), or neither. */
export type TeamReadKind = 'administration' | 'names' | 'none';

/** Up to two letters a name is marked by: the first of its first and last words. */
export const initialsOf = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = (word: string | undefined) => (word ? (Array.from(word)[0] ?? '') : '');
  return (first(words[0]) + (words.length > 1 ? first(words[words.length - 1]) : '')).toLocaleUpperCase();
};
export interface TeamInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly expiresAt: number;
}
export interface TeamRead {
  readonly members: readonly TeamMember[];
  readonly invitations: readonly TeamInvitation[];
  readonly roles: readonly string[];
  readonly canManage: boolean;
  readonly read: TeamReadKind;
}
/** What a one-time handoff carries: the token an issuer hands the invitee (absent where the server kept none). */
export interface TeamHandoff {
  readonly token?: string;
}
export interface TeamAccess {
  read(): Promise<TeamRead>;
  invite(email: string, role: string): Promise<TeamHandoff>;
  changeRole(memberId: string, role: string): Promise<void>;
  remove(memberId: string): Promise<void>;
  reissue(invitationId: string): Promise<TeamHandoff>;
  cancel(invitationId: string): Promise<void>;
}

export const EMPTY_TEAM: TeamRead = Object.freeze({ members: [], invitations: [], roles: [], canManage: false, read: 'none' });

/** An access with no team: nothing listed, nothing managed, every action refused. */
const noTeam = async () => Promise.reject(new Error(say('noTeam')));
export const noTeamAccess: TeamAccess = {
  read: async () => EMPTY_TEAM,
  invite: noTeam,
  changeRole: noTeam,
  remove: noTeam,
  reissue: noTeam,
  cancel: noTeam,
};
