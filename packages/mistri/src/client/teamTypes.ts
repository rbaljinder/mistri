/** What `useTeam()` reads and does, apart from the routes that answer it (teamAccess.ts), so a headless surface can name an empty team without them. */
import { say } from './copy/tenancy/teamAccess.js';

export interface TeamMember {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly you: boolean;
}
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

export const EMPTY_TEAM: TeamRead = Object.freeze({ members: [], invitations: [], roles: [], canManage: false });

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
