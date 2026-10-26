/** Browser-safe administration data. Policies, native login identifiers,
 * database bindings and durable fingerprints stay server-only. */
import type { InvitationImage } from './tenantInvitations.js';

export const ADMINISTRATION_OPERATIONS = Object.freeze([
  'createTenant',
  'setTenantStatus',
  'grantMembership',
  'replaceMembership',
  'revokeMembership',
  'setTenantAssistant',
  'setTenantDecisions',
  'cloneTenant',
  'importTenant',
] as const);
export type AdministrationOperation = (typeof ADMINISTRATION_OPERATIONS)[number];
export type AdministrationIntent =
  | Readonly<{ operation: 'createTenant'; tenantId: string }>
  | Readonly<{ operation: 'setTenantStatus'; tenantId: string; expectedTenantVersion: string; status: 'active' | 'suspended' | 'closed' }>
  | Readonly<{
      operation: 'grantMembership';
      tenantId: string;
      expectedTenantVersion: string;
      accountId: string;
      roles: readonly string[];
      validUntil: number;
    }>
  | Readonly<{
      operation: 'replaceMembership';
      tenantId: string;
      expectedTenantVersion: string;
      membershipId: string;
      expectedMembershipVersion: string;
      roles: readonly string[];
      validUntil: number;
    }>
  | Readonly<{
      operation: 'revokeMembership';
      tenantId: string;
      expectedTenantVersion: string;
      membershipId: string;
      expectedMembershipVersion: string;
    }>
  /* The in-App assistant for one tenant: on with the customer's consent reference (a contract, a ticket), off with
     a reason or none. A tenant's own admin may turn it off, never on. */
  | Readonly<{
      operation: 'setTenantAssistant';
      tenantId: string;
      expectedTenantVersion: string;
      enabled: boolean;
      consent: string;
    }>
  /* One model provider's switch for one tenant's decisions: on with the customer's consent reference (a DPA id),
     off with a reason or none. A tenant's own admin may turn it off, never on. */
  | Readonly<{
      operation: 'setTenantDecisions';
      tenantId: string;
      expectedTenantVersion: string;
      provider: string;
      enabled: boolean;
      consent: string;
    }>
  /* A fresh sandbox tenant (`tenantId`) made from a copy of the source's configuration, and its samples when asked. A sandbox is marked as one to its members, and imports back only into its source. */
  | Readonly<{
      operation: 'cloneTenant';
      tenantId: string;
      sourceTenantId: string;
      expectedSourceVersion: string;
      samples: boolean;
    }>
  /* The sandbox's configuration changes, applied to its live tenant all at once or not at all: approved by the
     live tenant's own owner, never an operator. */
  | Readonly<{
      operation: 'importTenant';
      tenantId: string;
      expectedTenantVersion: string;
      sandboxTenantId: string;
      expectedSandboxVersion: string;
    }>;
/** The longest consent reference, in characters. */
export const ASSISTANT_CONSENT_MOST = 500;

export interface AdministrationTenantImage {
  readonly tenantId: string;
  readonly status: 'active' | 'suspended' | 'closed';
  readonly version: string;
}
export interface AdministrationMembershipImage {
  readonly membershipId: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly status: 'active' | 'invited' | 'revoked';
  readonly version: string;
  readonly roles: readonly string[];
  readonly validUntil: number;
}
/** A tenant's assistant switch: off, with no consent, until it was first turned on. */
export interface AdministrationAssistantImage {
  readonly enabled: boolean;
  readonly consent: string;
}
/** One provider's decision switch for a tenant: off, with no consent, until it was first turned on. */
export interface AdministrationDecisionSwitch {
  readonly provider: string;
  readonly enabled: boolean;
  readonly consent: string;
}
export interface AdministrationState {
  readonly tenant: AdministrationTenantImage;
  readonly membership?: AdministrationMembershipImage;
  readonly assistant?: AdministrationAssistantImage;
  /** The one provider's switch a `setTenantDecisions` change set. */
  readonly decisions?: AdministrationDecisionSwitch;
}
export interface AdministrationChange {
  readonly operation: AdministrationOperation;
  readonly before: AdministrationState | null;
  readonly after: AdministrationState;
  /** Direct revocation also terminates its linked pending invitation atomically. */
  readonly invitation?: Readonly<{ before: InvitationImage; after: InvitationImage }>;
  /** A clone: whose copy the new sandbox is, and how many rows it took. */
  readonly clone?: Readonly<{ sourceTenantId: string; samples: boolean; rows: number }>;
  /** An import: which sandbox's changes, and how many rows each way. */
  readonly import?: Readonly<{ sandboxTenantId: string; inserted: number; updated: number; deleted: number }>;
}
/** Exact durable attempt meaning, captured before dispatch and retained for
 * recovery. Authentication/administration owner assertions are separate. */
export interface AdministrationAttempt {
  readonly idempotencyKey: string;
  readonly intent: AdministrationIntent;
}
export interface AdministrationResult {
  readonly receiptId: string;
  readonly requestId: string;
  readonly completedAt: string;
  readonly change: AdministrationChange;
  readonly replayed: boolean;
}

/** A non-bearer assertion for the particular native login which opened
 * management. It carries no native session ID or business membership. */
export interface AdministrationSession {
  readonly appId: string;
  readonly accountId: string;
  readonly context: string;
  readonly expiresAt: number;
  readonly maxMembershipLifetimeMs: number;
}

/** Assertions select a previously issued owner; they never authenticate it. */
export interface AdministrationOwner {
  readonly expectedAccount: string;
  readonly context: string;
}
export interface AdministrationPageRequest extends AdministrationOwner {
  /** Exclusive binary key boundary, not authority or a stable snapshot token. */
  readonly after?: string;
  readonly limit?: number;
}
interface AdministrationCapability {
  readonly operation: AdministrationOperation;
  /** Ceiling for this exact operation and tenant, never a union across operations. */
  readonly roles: readonly string[];
}
export interface AdministrationTenantTarget {
  readonly tenantId: string;
  /** What the tenant is called, where the server could say (the profile's record name); words only, every request names the id. */
  readonly name?: string;
  /** Explicitly authorized targets may not have been created yet. */
  readonly tenant: AdministrationTenantImage | null;
  readonly capabilities: readonly AdministrationCapability[];
  /** The assistant switch, where the App declares an assistant and this account may set it. */
  readonly assistant?: AdministrationAssistantImage;
  /** One switch per provider the App's decisions name (sorted by provider; off with consent '' when never set), where this account may set them. */
  readonly decisions?: readonly AdministrationDecisionSwitch[];
  /** This tenant is a sandbox: a clone of `sourceTenantId`, never a live tenant. */
  readonly sandbox?: Readonly<{ sourceTenantId: string }>;
  /** The sandboxes cloned from this tenant, where this account may import one. */
  readonly sandboxes?: readonly AdministrationTenantImage[];
}
export interface AdministrationTenantPage {
  readonly items: readonly AdministrationTenantTarget[];
  readonly next: string | null;
  /** This account may read the assistant's usage (an operator who may set some tenant's assistant). */
  readonly usage?: true;
  /** This account may read the decisions' usage (an operator who may set some tenant's decisions). */
  readonly decisionUsage?: true;
}
export type AdministrationMembershipOperation = 'replaceMembership' | 'revokeMembership';
export interface AdministrationMembershipPageRequest extends AdministrationPageRequest {
  readonly tenantId: string;
  readonly operation: AdministrationMembershipOperation;
}
export interface AdministrationMembershipPage {
  readonly tenant: AdministrationTenantImage | null;
  readonly operation: AdministrationMembershipOperation;
  readonly roles: readonly string[];
  readonly items: readonly AdministrationMembershipImage[];
  readonly next: string | null;
}

/** Assistant tokens one tenant spent on one day (UTC), for the platform owner's bill. */
export interface AdministrationUsageRow {
  readonly tenantId: string;
  readonly day: string;
  readonly tokens: number;
}
export interface AdministrationUsageRequest extends AdministrationOwner {
  /** The first day (YYYY-MM-DD) to read; the most recent days come first, up to the bound. */
  readonly since?: string;
}
export interface AdministrationUsagePage {
  readonly rows: readonly AdministrationUsageRow[];
  /** More rows than the bound: read again from a later `since`. */
  readonly truncated: boolean;
}
/** The most usage rows one read returns. */
export const ASSISTANT_USAGE_MOST = 5000;

/** What one tenant's decisions cost on one day (UTC), for the platform owner's bill. `costMicros` is millionths of a dollar. */
export interface AdministrationDecisionUsageRow {
  readonly tenantId: string;
  readonly day: string;
  readonly calls: number;
  readonly units: number;
  readonly costMicros: number;
}
export interface AdministrationDecisionUsagePage {
  readonly rows: readonly AdministrationDecisionUsageRow[];
  /** More rows than the bound: read again from a later `since`. */
  readonly truncated: boolean;
}
/** The most decision usage rows one read returns. */
export const DECISION_USAGE_MOST = 5000;

/** Why one row of a sandbox cannot be imported: both sides changed it, the live tenant removed what the
 * sandbox changed, the live tenant took the key a new sandbox row has, or the sandbox names a row the live
 * tenant does not have. */
export type AdministrationImportConflictReason = 'changed' | 'removed' | 'taken' | 'reference';
/** What importing a sandbox would do: an approval applies exactly this, or, with any conflict, nothing. */
export interface AdministrationImportPlan {
  readonly inserted: number;
  readonly updated: number;
  readonly deleted: number;
  readonly resources: Readonly<Record<string, Readonly<{ inserted: number; updated: number; deleted: number }>>>;
  /** The row's key within the live tenant is JSON text, as the resource's key columns read. */
  readonly conflicts: readonly Readonly<{ resource: string; key: string; reason: AdministrationImportConflictReason }>[];
  readonly truncated: boolean;
}
export interface AdministrationImportPlanRequest extends AdministrationOwner {
  readonly tenantId: string;
  readonly sandboxTenantId: string;
}

/** Distinct from a business-tenant context: management also works before selection. */
export const ADMINISTRATION_HTTP_HEADER = 'x-mistri-administration-context';
export const ADMINISTRATION_HTTP_ROOT = '/api/tenant/administration';
export interface AdministrationOpenReply {
  readonly session: AdministrationSession | null;
}
export interface AdministrationImportPlanReply {
  readonly plan: AdministrationImportPlan;
}
export interface AdministrationExecuteReply {
  readonly outcome: 'applied';
  readonly result: AdministrationResult;
}
export type AdministrationStatusReply =
  | Readonly<{ status: 'completed'; outcome: 'applied'; result: AdministrationResult }>
  | Readonly<{ status: 'not_found'; outcome: 'unknown'; result: null }>;
