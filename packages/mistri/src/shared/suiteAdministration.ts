/** Suite access is administered by stable subject ID within one App. */
export const SUITE_INVITATIONS_PAGE = 25;
export const SUITE_INVITATIONS_MAX_OFFSET = 1_000_000;
/** How many holders and grant changes one App's access list shows: past it the Console says so. */
export const SUITE_ACCESS_PAGE = 200;

export interface SuiteGrantView {
  accountId: string;
  appId: string;
  subjectId: string;
  revision: number;
  roles: readonly string[];
  assignableRoles: readonly string[];
}

export type SuiteInvitationStatus =
  | 'pending'
  | 'consumed'
  | 'revoked'
  | 'expired'
  | 'issuer-changed'
  | 'target-changed'
  | 'roles-changed'
  | 'not-yet-valid';

export interface SuiteInvitationSummary {
  id: string;
  roles: readonly string[];
  expectedRevision: number;
  actorId: string;
  issuedAt: number;
  expiresAt: number;
  status: SuiteInvitationStatus;
  canRevoke: boolean;
}

export interface SuiteInvitationsView {
  accountId: string;
  appId: string;
  subjectId: string;
  invitations: readonly SuiteInvitationSummary[];
  total: number;
  offset: number;
}

/** One App's holders and its latest grant changes, as its administrator reads them in the Console. */
export interface SuiteAccessView {
  appId: string;
  grants: readonly { subjectId: string; revision: number; roles: readonly string[] }[];
  changes: readonly {
    id: string;
    subjectId: string;
    actorId: string;
    at: number;
    revision: number;
    before: readonly string[];
    after: readonly string[];
  }[];
  /** More holders than one page. */
  more: boolean;
}
