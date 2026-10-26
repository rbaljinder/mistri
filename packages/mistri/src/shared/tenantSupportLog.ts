/**
 * What a dealer is shown about support visits into its own tenant, and what
 * the lender is shown about every dealer's.
 *
 * A dealer sees, it does not gate: there is no approve or block route here, by
 * decision. The point is that a lender can already read a dealer's rows, and
 * without this the dealer cannot see that it happened.
 *
 * Neither view carries the operator's email, the native session, any row
 * version or any MAC. The email belongs to the lender's own audit view alone,
 * because the dealer is owed the fact of the visit and the person's name, not
 * a way to contact or correlate the lender's staff.
 */

export const SUPPORT_LOG_PATH = '/api/tenant/support/log';
export const SUPPORT_SESSIONS_PATH = '/api/tenant/support/sessions';
/** How many visits either view shows: the newest, with `more` saying older ones exist. */
export const SUPPORT_LOG_VISITS = 100;

/** One change a support session made, as the viewer's own grants allow it to
 * be read. Columns the resource's `audit` block marks are already a keyed hash
 * in the store; columns this viewer may not read are not sent at all, and are
 * named in `withheld` so the log says something was changed rather than
 * implying nothing was. */
export interface SupportLogChange {
  readonly at: string;
  readonly resource: string;
  readonly operation: string;
  readonly key: Record<string, unknown> | null;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly withheld: readonly string[];
}

/** One visit, as the dealer sees it. */
export interface SupportLogSession {
  readonly supportId: string;
  /** The operator's display name when the session opened, never their email. */
  readonly operatorName: string;
  /** The platform realm's own label, as the App names it — "Lender". */
  readonly realmLabel: string;
  readonly dealerRole: string;
  readonly reason: string;
  readonly openedAt: string;
  readonly endedAt: string | null;
  readonly endReason: string | null;
  readonly state: 'active' | 'ended';
  /** How many reads the session made, and every change it made. */
  readonly reads: number;
  readonly changes: readonly SupportLogChange[];
}

export interface SupportLogReply {
  readonly tenantId: string;
  readonly sessions: readonly SupportLogSession[];
  /** Older visits exist than the SUPPORT_LOG_VISITS shown. */
  readonly more: boolean;
}

/** The lender's audit view: every dealer's sessions, each naming the dealer it
 * entered, and the one place an operator's email is shown. */
export interface SupportAuditSession extends SupportLogSession {
  readonly tenantId: string;
  readonly accountId: string;
  /** Looked up now, not recorded then: null when the account is gone. */
  readonly operatorEmail: string | null;
}

export interface SupportAuditReply {
  readonly sessions: readonly SupportAuditSession[];
  /** Older visits exist than the SUPPORT_LOG_VISITS shown. */
  readonly more: boolean;
}
