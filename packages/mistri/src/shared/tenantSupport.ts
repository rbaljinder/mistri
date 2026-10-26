/** Browser-safe support session data ("enter as dealer"). No native session
 * id, parent membership, policy, audit MAC or operator email crosses here:
 * the email stays with the platform, the dealer sees a display name. */
import type { TenantContextReply } from './tenantContext.js';

export const SUPPORT_HTTP_ROOT = '/api/tenant/support';
export const SUPPORT_HTTP_OPERATIONS = Object.freeze(['open', 'exit', 'status'] as const);
/** Opening needs a native sign-in no older than five minutes; a session lasts
 * at most thirty and is never renewed. Fixed here, not by policy. */
export const SUPPORT_OPENING_AGE_MS = 300_000;
export const SUPPORT_LIFETIME_MS = 1_800_000;
/** The banner warns this long before a session ends. */
export const SUPPORT_WARNING_MS = 120_000;
export const SUPPORT_REASON_MAX_BYTES = 500;

export interface SupportOpenIntent {
  readonly operation: 'openSupport';
  readonly tenantId: string;
  readonly dealerRole: string;
  readonly reason: string;
}
export interface SupportExitIntent {
  readonly operation: 'exitSupport';
  readonly tenantId: string;
  readonly supportId: string;
  readonly expectedSupportVersion: string;
}
type SupportIntent = SupportOpenIntent | SupportExitIntent;
/** The exact attempt a browser keeps until it knows the outcome. */
export interface SupportAttempt<I extends SupportIntent = SupportIntent> {
  readonly idempotencyKey: string;
  readonly intent: I;
}

export interface SupportSessionView {
  readonly supportId: string;
  readonly version: string;
  readonly tenantId: string;
  readonly dealerRole: string;
  readonly operatorName: string;
  readonly reason: string;
  readonly openedAt: string;
  readonly validUntil: number;
  /** What was left by the server's clock when it answered; a browser counts
   * down from its own clock, so a skewed clock never moves the end. */
  readonly remainingMs: number;
  readonly state: 'active' | 'expired' | 'ended';
}
/** A dealer this login may enter now, the roles one grant offers there, and
 * what the dealer is called (its profile record's name) when it has a name. */
export interface SupportChoice {
  readonly tenantId: string;
  readonly roles: readonly string[];
  readonly name?: string;
}
export interface SupportReceiptView {
  readonly operation: 'openSupport' | 'exitSupport';
  readonly receiptId: string;
  readonly completedAt: string;
  readonly session: SupportSessionView;
}
export interface SupportStatusReply {
  /** The live session this very login holds; another login's never shows. */
  readonly session: SupportSessionView | null;
  readonly choices: readonly SupportChoice[];
  /** Whether opening needs a fresh sign-in first. */
  readonly signInRequired: boolean;
  /** Whether that sign-in can be a password here, or must be a full sign-in. */
  readonly passwordSignIn: boolean;
  /** The identity provider this login came through, where confirming it is a fresh sign-in there
      (auth/identityProviders.ts): a password never stands in for it. */
  readonly reauthenticate?: string;
  /** Present when that provider is a SAML one: its sign-in starts at `/sign-in/sso`, not `/sign-in/social`. */
  readonly reauthenticateKind?: 'saml';
  /** Present when the request named an exact attempt: its receipt, or null. */
  readonly recovered?: SupportReceiptView | null;
  /** Present when the request asked to resume a live session. */
  readonly context?: TenantContextReply;
}
export interface SupportOpenReply {
  readonly receipt: SupportReceiptView;
  readonly replayed: boolean;
  /** The support lease, while the session is still live. */
  readonly context?: TenantContextReply;
}
export interface SupportExitReply {
  readonly receipt: SupportReceiptView;
  readonly replayed: boolean;
}

export const SUPPORT_REFUSAL_CODES = Object.freeze({
  /** Business work on a support lease: refused until audited support ships. */
  unavailable: 'tenant_support_unavailable',
  signInRequired: 'tenant_support_sign_in_required',
  refused: 'tenant_support_refused',
  /** Administration or invitations while this account is inside a dealer. */
  active: 'tenant_support_active',
} as const);
export const SUPPORT_UNAVAILABLE_MESSAGE = 'Support access is not available yet.';
