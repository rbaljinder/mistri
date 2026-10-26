/**
 * What a support lease is admitted on, and how it is refused. The evidence is
 * minted only by the support owner (tenantSupportOperations.ts) after its
 * fence — the support row, its parent platform membership, `@platform`, the
 * dealer and the audit session of this very native login — and is recognised
 * by identity, so a copy, a spread or a proxy of it admits nothing.
 *
 * A support lease reads the dealer it entered and acts on nothing: each read
 * is ledgered before its answer is released, and every write, Undo and command
 * refuses with one clear, public refusal. The write sink is built and proven
 * (tenantWriteKindSupport.ts); what is missing is a request path that reaches
 * it, so the refusal here is the only honest answer.
 */
import { SUPPORT_REFUSAL_CODES, SUPPORT_UNAVAILABLE_MESSAGE } from '../../shared/tenantSupport.js';
import { captureTenantData, denyTenant, TenantContextError } from '@mistriwork/engine/server/evidence.js';

export interface SupportTarget {
  readonly realm: 'support';
  readonly tenantId: string;
  readonly supportId: string;
}
/** Admission-time evidence of one support session, not a credential or a grant. */
export interface SupportMembershipEvidence {
  readonly realm: 'support';
  readonly appId: string;
  readonly accountId: string;
  readonly source: { readonly id: string; readonly connection: string };
  readonly deployment: string;
  readonly tenantId: string;
  readonly supportId: string;
  /** The support row itself: `membershipId` is `supportId`. */
  readonly membershipId: string;
  readonly membershipVersion: string;
  readonly tenantVersion: string;
  readonly parentId: string;
  readonly parentVersion: string;
  readonly platformVersion: string;
  /** Exactly one: the dealer role asked for, never unioned with another. */
  readonly roles: readonly string[];
  readonly verifiedAt: number;
  readonly validUntil: number;
}
/** How contexts admits a support lease: the owner's fence, per request. */
export interface SupportAdmission<Request> {
  admit(request: Request, target: SupportTarget): Promise<SupportMembershipEvidence>;
  /** Whether this account is inside a dealer now, whichever tab is asking.
   * Fails closed: any doubt answers true. */
  holds(request: Request): Promise<boolean>;
}

const issued = new WeakSet<SupportMembershipEvidence>();
/** Only the support owner calls this, after its fence. */
export function issueSupportEvidence(value: SupportMembershipEvidence): SupportMembershipEvidence {
  const evidence = captureTenantData(value);
  if (evidence.realm !== 'support' || evidence.roles.length !== 1 || evidence.membershipId !== evidence.supportId) return denyTenant();
  issued.add(evidence);
  return evidence;
}
export function isSupportEvidence(value: unknown): value is SupportMembershipEvidence {
  return !!value && typeof value === 'object' && issued.has(value as SupportMembershipEvidence);
}

/** Business work on a support lease: refused, and said so. */
export class TenantSupportUnavailable extends TenantContextError {
  override readonly code: string = SUPPORT_REFUSAL_CODES.unavailable;
  constructor() {
    super();
    this.name = 'TenantSupportUnavailable';
    this.message = SUPPORT_UNAVAILABLE_MESSAGE;
  }
}
/** The account is inside a dealer, so the platform realm's commands are
 * refused until it exits — whichever tab asks, not only the one holding the
 * support lease. A subclass, so every place that already treats a support
 * refusal as one treats this as one too. */
export class TenantSupportActive extends TenantSupportUnavailable {
  override readonly code: string = SUPPORT_REFUSAL_CODES.active;
  constructor() {
    super();
    this.name = 'TenantSupportActive';
    this.message = 'Exit the dealer before acting as the platform.';
  }
}
/** A read the ledger could not record. The body is never released: a read that
 * cannot be ledgered is refused, never truncated and never quietly served. A
 * subclass, so every place that already treats a support refusal as one treats
 * this as one too. */
export class TenantSupportUnledgered extends TenantSupportUnavailable {
  override readonly code: string = SUPPORT_REFUSAL_CODES.refused;
  constructor() {
    super();
    this.name = 'TenantSupportUnledgered';
    this.message = 'The read could not be recorded, so it was not answered.';
  }
}
const refusals = new WeakMap<Error, { readonly code: string; readonly message: string }>();
/** Keep a family's own failure class (a write's, a command's) and mark it as
 * the support refusal it stands for, as lease failures are marked. The
 * refusal's own code and words travel with it, so a reply says which support
 * rule refused rather than the generic one. */
export function markSupportRefusal<T extends Error>(error: T, refusal: TenantSupportUnavailable): T {
  refusals.set(error, { code: refusal.code, message: refusal.message });
  return error;
}
export function tenantSupportRefused(error: unknown): boolean {
  return error instanceof TenantSupportUnavailable || (error instanceof Error && refusals.has(error));
}
/** What to answer a refused request: the marked refusal's own code and words,
 * or the generic one when nothing more precise was recorded. */
export function tenantSupportRefusal(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof TenantSupportUnavailable) return { code: error.code, message: error.message };
  return (
    (error instanceof Error ? refusals.get(error) : undefined) ?? {
      code: SUPPORT_REFUSAL_CODES.unavailable,
      message: SUPPORT_UNAVAILABLE_MESSAGE,
    }
  );
}
