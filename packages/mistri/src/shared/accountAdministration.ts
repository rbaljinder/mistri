/**
 * Account administration in an App that signs people in (not a tenant App,
 * whose members are its tenants' own): the accounts, the roles each holds and
 * whether it may sign in, as the administrator's screen reads and changes
 * them. The shapes both sides speak, and the one rule for who administers.
 *
 * An administrator is an account holding the `admin` role — the role Better
 * Auth's admin plugin answers to, and the one the server's bootstrap account
 * (`MISTRI_AUTH_ADMIN_EMAIL`) is made with. The App's own roles are what
 * it may hand out; `admin` is always among them, so an App that declares no
 * `admin` grant can still name its next administrator.
 */

/** The role that administers accounts. */
export const ADMIN_ROLE = 'admin';

/** Accounts per page of the list. */
export const ACCOUNTS_PAGE = 25;

export interface AccountSummary {
  id: string;
  name: string;
  email: string;
  /** Every role the account holds, in the order it was given. */
  roles: string[];
  /** False once an administrator deactivates it: it cannot sign in, and its sessions ended. */
  active: boolean;
  /** When the account was made, as the store keeps it (ISO text). */
  createdAt?: string;
}

export interface AccountsPage {
  accounts: AccountSummary[];
  total: number;
  offset: number;
  /** The roles this App hands out, `admin` among them. */
  roles: string[];
  /** Whether a new account signs in with a password (the email provider), so one is asked. */
  passwords: boolean;
}

export type AccountChange =
  | { operation: 'create'; email: string; name: string; roles: string[]; password?: string }
  | { operation: 'setRoles'; accountId: string; roles: string[] }
  | { operation: 'deactivate'; accountId: string }
  | { operation: 'reactivate'; accountId: string }
  | { operation: 'setPassword'; accountId: string; password: string };

/** One row of the account-administration trail (server/auth/accountAudit.ts), as the screen reads it. */
export interface AccountAuditEntry {
  id: string;
  /** When, as ISO text. */
  at: string;
  action: AccountChange['operation'];
  actorId: string;
  actorEmail: string;
  /** `session` — the actor's own — or `impersonation:<id>`, the administrator impersonating them;
   * for an account made on someone's behalf, `maintenance` (the operator's step, with no actor
   * account) or `invitation:<id>`, the invitation the new account's holder claimed; `sign-in:<provider>`,
   * the roles an identity provider's claims gave at a sign-in, the actor its label. */
  principal: string;
  targetId: string;
  targetEmail: string;
  /** The fields the change touched, as they were and became; `before` is null for a new account. */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface AccountAuditPage {
  entries: AccountAuditEntry[];
  total: number;
  offset: number;
}

/** Trail rows per page. */
export const ACCOUNT_AUDIT_PAGE = 25;

/** The roles a stored role field names: Better Auth keeps several as one comma-separated line. */
export function rolesOf(stored: unknown): string[] {
  if (typeof stored !== 'string') return [];
  return [
    ...new Set(
      stored
        .split(',')
        .map((role) => role.trim())
        .filter(Boolean),
    ),
  ];
}

/** Whether a verified session's roles administer accounts. */
export function administersAccounts(role: string | undefined): boolean {
  return rolesOf(role).includes(ADMIN_ROLE);
}

/** The roles an App hands out: its declared ones, its default, and `admin`, in that order. */
export function assignableRoles(auth: { roles?: Record<string, unknown>; defaultRole?: string } | undefined): string[] {
  return [...new Set([...Object.keys(auth?.roles ?? {}), ...(auth?.defaultRole ? [auth.defaultRole] : []), ADMIN_ROLE])];
}

/** Better Auth's own password length bounds (its defaults), said before the request rather than after. */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
