import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { TransactionOutcomeUnknown } from '@mistriwork/engine/adapters/adapter.js';
import type { AppAuthRuntimeBinding, VerifiedSessionInstance } from '../auth/auth.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import type { TenantStoreBinding } from './tenantStore.js';
import type { StoredAdministrationReceipt } from './tenantAdministrationJournal.js';
import {
  captureInvitationIntent,
  captureInvitationPolicy,
  invitationFingerprint,
  invitationGrant,
  invitationIssuePrincipal,
  invitationOperatorGrant,
  invitationPrincipalEmail,
  assertInvitationTermsWithin,
  type InvitationPolicy,
} from './tenantInvitationModel.js';
import type { StoredTenantInvitation } from './tenantInvitationStore.js';
import type { InvitationTransaction } from './tenantInvitationTransaction.js';
import { invitationTokenId, matchesInvitationToken, mintInvitationToken } from './tenantInvitationToken.js';
import {
  createInvitationLifetime,
  assertInvitationEligibility,
  assertInvitationCurrentTerms,
  observeInvitationEligibility,
  type InvitationEligibilityOptions,
} from './tenantInvitationProof.js';
import { captureInvitationChange } from './tenantInvitationChange.js';
import { applyInvitationClaim } from './tenantInvitationClaim.js';
import { assertDelegateMembership, delegateCeiling } from './tenantDelegation.js';
import { NativeAccountRefusal, nativeAccountPassword, type NativeAccountInput } from '../auth/authAccounts.js';
import { profileName } from '../../shared/accountProfile.js';
import type { AdministrationMembershipImage, AdministrationOwner, AdministrationTenantImage } from '../../shared/tenantAdministration.js';
import type {
  InvitationImage,
  InvitationIssueReply,
  InvitationPair,
  InvitationPreview,
  InvitationRecipientSession,
  InvitationRequest,
  InvitationResult,
  InvitationAcceptanceResult,
  InvitationExecutionReply,
  InvitationIssuerSession,
  InvitationPageRequest,
  InvitationTargetPage,
  InvitationListRequest,
  InvitationListPage,
  InvitationIssuerOperation,
  InvitationClaimReply,
} from '../../shared/tenantInvitations.js';
import { INVITATION_ISSUER_OPERATIONS } from '../../shared/tenantInvitations.js';

export class TenantInvitationFailure extends Error {
  readonly code = 'tenant_invitation_unavailable';
  constructor(readonly outcome: 'not_applied' | 'unknown') {
    super('The invitation operation could not be confirmed.');
    this.name = 'TenantInvitationFailure';
  }
}
/** A signed-out claim's refusal, each read by the HTTP owner into one fixed
 * answer. `unavailable` is every token that cannot be claimed now, alike;
 * `account_exists` and `incomplete` are only reached with a valid token. */
export class TenantInvitationClaimRefusal extends Error {
  readonly code = 'tenant_invitation_claim';
  constructor(
    readonly reason: 'unavailable' | 'invalid_account' | 'account_exists' | 'incomplete',
    readonly outcome: 'not_applied' | 'unknown' = 'not_applied',
  ) {
    super('The invitation claim could not be completed.');
    this.name = 'TenantInvitationClaimRefusal';
  }
}
/** The owner's capability over the native auth store (authAccounts.ts), for
 * email invitations: an account's address, an address's account, and making one. */
interface InvitationAccounts {
  /** Whether the App signs in with email: without it a made account could never sign in. */
  readonly emailSignIn: boolean;
  emailOf(accountId: string): Promise<string | null>;
  findByEmail(email: string): Promise<string | null>;
  /** The invitation the account claims: its row of the account trail names it. */
  create(input: NativeAccountInput, invitationId: string): Promise<string>;
}
export interface TenantInvitations {
  /** Signed out: create the invitation's account under its address and accept it.
   * Optional so a host without claims (or a narrower double) offers none. */
  claim?(request: IncomingMessage, input: { token: string; name: string; password: string }): Promise<InvitationClaimReply>;
  openIssuer(request: IncomingMessage, input: { expectedAccount: string }): Promise<InvitationIssuerSession | null>;
  openRecipient(request: IncomingMessage, input: { expectedAccount: string; invitationId: string }): Promise<InvitationRecipientSession>;
  preview(request: IncomingMessage, input: AdministrationOwner & { token: string }): Promise<InvitationPreview>;
  execute(request: IncomingMessage, input: InvitationRequest & { token?: string }): Promise<InvitationExecutionReply>;
  status(request: IncomingMessage, input: InvitationRequest): Promise<InvitationResult | InvitationAcceptanceResult | null>;
  targets(request: IncomingMessage, input: InvitationPageRequest): Promise<InvitationTargetPage>;
  list(request: IncomingMessage, input: InvitationListRequest): Promise<InvitationListPage>;
}
interface InvitationOwner {
  binding: TenantStoreBinding;
  policy: InvitationPolicy;
  auth: AppAuthRuntimeBinding;
  /** Absent: no email invitation can be issued, accepted or claimed. */
  accounts?: InvitationAccounts;
  deployment: string;
  lifetime: number;
  clock(): number;
  tracked<T>(work: () => Promise<T>): Promise<T>;
  /** An outcome could not be confirmed: the administration store closes behind the work admitted and reopens
   * (tenantWriterLifecycle.ts). This operation's refusal stands; the ones after it are answered again. */
  uncertain(): void;
  /** Borrow the administration writer/queue; this module cannot open another. */
  transact<T>(
    checks: { active: () => void; observe: () => Promise<void> },
    work: (bind: (active: () => void) => InvitationTransaction, assertCurrent: () => void) => Promise<T>,
  ): Promise<T>;
}
type Session = { value: InvitationRecipientSession; proof: VerifiedSessionInstance; kind: 'issuer' | 'recipient'; invitationId?: string };
function exact(value: unknown, fields: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  tenantRecord(value, [...fields, ...optional]);
  if (fields.some((field) => !Object.hasOwn(value, field))) denyTenant();
}
const next = (value: string) => String(BigInt(value) + 1n);
const image = (row: StoredTenantInvitation): InvitationImage => {
  const { digest: _digest, ...visible } = row;
  return captureTenantData(visible);
};

/** Private composition only. Contexts here never enter the administration map
 * or business tenant selection. All work uses the owner's queue and drain. */
export function createTenantInvitationOperations(owner: InvitationOwner): TenantInvitations {
  const policy = captureInvitationPolicy(owner.policy),
    { auth, binding, accounts } = owner;
  const sessions = new Map<string, Session>();
  /* Delegation (tenantDelegation.ts): what a member's roles earn, per issuer
     operation, and the delegate's own membership, read in the caller's
     transaction — on PostgreSQL locked FOR UPDATE after the tenant row. */
  const delegateCapabilities = (memberRoles: readonly string[]) =>
    INVITATION_ISSUER_OPERATIONS.flatMap((operation) => {
      const roles = delegateCeiling(policy.delegates, memberRoles, operation);
      return roles ? [{ operation, roles }] : [];
    });
  const delegatedTargets = async (transaction: InvitationTransaction, accountId: string) => {
    if (!policy.delegates) return new Map<string, ReturnType<typeof delegateCapabilities>>();
    const tenants = await transaction.accountTenants(accountId, owner.clock());
    return new Map(
      tenants.map((tenant) => [tenant.tenantId, delegateCapabilities(tenant.roles)] as const).filter(([, found]) => found.length),
    );
  };
  const delegatedCeiling = async (
    transaction: InvitationTransaction,
    accountId: string,
    tenantId: string,
    operation: InvitationIssuerOperation,
  ) => {
    if (!policy.delegates) return denyTenant();
    const own = assertDelegateMembership(await transaction.accountMembership(tenantId, accountId), accountId, tenantId, owner.clock());
    return Object.freeze({ roles: delegateCeiling(policy.delegates, own.roles, operation) ?? denyTenant(), validUntil: own.validUntil });
  };
  /** The recorded inviter's authority now: its operator grant, or its own
   * delegate membership, which only the store can say. */
  const inviterAuthority = async (
    transaction: InvitationTransaction,
    row: StoredTenantInvitation,
  ): Promise<InvitationEligibilityOptions> => {
    if (invitationOperatorGrant(policy, row.inviterId, row.tenantId, row.issuanceOperation)) return {};
    return { ceiling: (await delegatedCeiling(transaction, row.inviterId, row.tenantId, row.issuanceOperation)).roles };
  };
  /** An account invitation is its account's; an email invitation is the
   * account whose address — read from the auth store — is the invited one. */
  const recipientOwns = async (row: StoredTenantInvitation, accountId: string): Promise<boolean> => {
    const email = invitationPrincipalEmail(row.accountId);
    if (email === null) return row.accountId === accountId;
    return !!accounts?.emailSignIn && (await accounts.emailOf(accountId)) === email;
  };
  const open = (kind: Session['kind'], request: IncomingMessage, input: { expectedAccount: string; invitationId?: string }) => {
    let accountId: string, started: number, invitationId: string | undefined;
    try {
      const value = captureTenantData(input);
      exact(value, kind === 'recipient' ? ['expectedAccount', 'invitationId'] : ['expectedAccount']);
      if (kind === 'recipient') {
        if (
          typeof value.invitationId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.invitationId)
        )
          return denyTenant();
        invitationId = value.invitationId;
      }
      tenantIdentifier(value.expectedAccount, 1024);
      accountId = value.expectedAccount;
      started = owner.clock();
      if (started > Number.MAX_SAFE_INTEGER - owner.lifetime) return denyTenant();
    } catch {
      return Promise.reject(new TenantInvitationFailure('not_applied'));
    }
    return owner.tracked(async () => {
      try {
        const proof = await auth.sessionInstance(request);
        let instant = owner.clock();
        if (!proof || proof.identity.id !== accountId || request.aborted || instant < started) return denyTenant();
        auth.assertSessionCurrent(proof);
        if (!auth.synchronous) {
          await auth.observeSession(proof);
          const before = instant;
          instant = owner.clock();
          auth.assertSessionCurrent(proof);
          if (request.aborted || instant < before || instant >= Math.min(started + owner.lifetime, proof.expiresAt)) return denyTenant();
        }
        if (kind === 'issuer' && !policy.operators.some((entry) => entry.accountId === accountId)) {
          // A delegate is one only while its own membership says so: read now, and again at every step.
          if (!policy.delegates) return null;
          const fence = () => {
            owner.clock();
            auth.assertSessionCurrent(proof);
            if (request.aborted) denyTenant();
          };
          const delegated = await owner.transact(
            {
              active: fence,
              observe: async () => {
                if (!auth.synchronous) await auth.observeSession(proof);
                fence();
              },
            },
            async (bind) => (await delegatedTargets(bind(fence), accountId)).size,
          );
          if (!delegated) return null;
        }
        const fresh = await auth.sessionInstance(request);
        const before = instant;
        instant = owner.clock();
        if (!fresh || fresh.identity.id !== accountId || fresh.sessionId !== proof.sessionId || request.aborted || instant < before)
          return denyTenant();
        auth.assertSessionCurrent(proof);
        auth.assertSessionCurrent(fresh);
        if (!auth.synchronous)
          for (const observed of [proof, fresh]) {
            await auth.observeSession(observed);
            const before = instant;
            instant = owner.clock();
            auth.assertSessionCurrent(proof);
            auth.assertSessionCurrent(fresh);
            if (request.aborted || instant < before || instant >= Math.min(started + owner.lifetime, proof.expiresAt, fresh.expiresAt))
              return denyTenant();
          }
        const expiresAt = Math.min(started + owner.lifetime, proof.expiresAt, fresh.expiresAt);
        if (instant >= expiresAt) return denyTenant();
        for (const [key, entry] of sessions) if (entry.value.expiresAt <= instant) sessions.delete(key);
        if (sessions.size >= 1024 || [...sessions.values()].filter((entry) => entry.value.accountId === accountId).length >= 16)
          return denyTenant();
        const value = captureTenantData({
          appId: binding.appId,
          accountId,
          context: randomUUID(),
          expiresAt,
          ...(kind === 'issuer'
            ? {
                maxMembershipLifetimeMs: policy.maxMembershipLifetimeMs,
                maxRedemptionLifetimeMs: policy.maxRedemptionLifetimeMs,
                maxPendingPerTenant: policy.maxPendingPerTenant,
              }
            : {}),
        });
        sessions.set(value.context, { value, proof: fresh, kind, ...(invitationId ? { invitationId } : {}) });
        return value;
      } catch {
        throw new TenantInvitationFailure('not_applied');
      }
    });
  };
  const admission = (input: AdministrationOwner, kind: Session['kind']) => {
    tenantIdentifier(input.expectedAccount, 1024);
    tenantIdentifier(input.context);
    const session = sessions.get(input.context);
    if (!session || session.kind !== kind || session.value.accountId !== input.expectedAccount) return denyTenant();
    const started = owner.clock();
    if (started > Number.MAX_SAFE_INTEGER - owner.lifetime) return denyTenant();
    return { session, started };
  };
  const lifetime = (request: IncomingMessage, session: Session, started: number) =>
    createInvitationLifetime({
      auth,
      request,
      proof: session.proof,
      accountId: session.value.accountId,
      contextExpiresAt: session.value.expiresAt,
      started,
      lifetime: owner.lifetime,
      clock: () => owner.clock(),
    });
  const eligible = (row: StoredTenantInvitation, now: number, options: InvitationEligibilityOptions = {}) =>
    auth.synchronous
      ? assertInvitationEligibility(row, policy, now, auth, options)
      : assertInvitationCurrentTerms(row, policy, now, options.ceiling);
  const pageLimit = (input: InvitationPageRequest) => {
    if (Object.hasOwn(input, 'after')) tenantIdentifier(input.after, 128);
    const limit = input.limit === undefined ? 20 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (Object.hasOwn(input, 'limit') && input.limit === undefined))
      return denyTenant();
    return limit;
  };
  const bounded = <T>(items: readonly T[], limit: number, key: (item: T) => string) => {
    const visible: T[] = [];
    let bytes = 0;
    for (const item of items) {
      const size = Buffer.byteLength(JSON.stringify(item));
      if (visible.length >= limit || bytes + size > 2_000_000) {
        if (!visible.length) return denyTenant();
        return { items: visible, next: key(visible[visible.length - 1]) };
      }
      visible.push(item);
      bytes += size;
    }
    return { items: visible, next: null };
  };
  const readOwned = <T>(
    request: IncomingMessage,
    input: InvitationPageRequest,
    inspect: (transaction: InvitationTransaction, active: () => void) => Promise<T>,
  ) => {
    const { session, started } = admission(input, 'issuer');
    return owner.tracked(async () => {
      try {
        const { live, current } = lifetime(request, session, started);
        await current();
        const value = await owner.transact(
          {
            active: () => {
              live();
            },
            observe: async () => {
              await current();
              live();
            },
          },
          async (bind, assertCurrent) => {
            const active = () => {
              live();
              assertCurrent();
            };
            await current();
            active();
            const result = await inspect(bind(active), active);
            await current();
            active();
            return result;
          },
        );
        await current();
        live();
        return captureTenantData(value);
      } catch (error) {
        if (error instanceof TransactionOutcomeUnknown) owner.uncertain();
        throw new TenantInvitationFailure('not_applied');
      }
    });
  };
  const targets = async (request: IncomingMessage, input: InvitationPageRequest): Promise<InvitationTargetPage> => {
    try {
      const value = captureTenantData(input);
      exact(value, ['expectedAccount', 'context'], ['after', 'limit']);
      const limit = pageLimit(value),
        grants = policy.operators.filter((entry) => entry.accountId === value.expectedAccount);
      if (!grants.length && !policy.delegates) return denyTenant();
      return await readOwned(request, value, async (transaction, active) => {
        const delegated = await delegatedTargets(transaction, value.expectedAccount);
        active();
        const ids = [...new Set([...grants.flatMap((entry) => entry.tenants), ...delegated.keys()])]
          .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
          .filter((id) => value.after === undefined || Buffer.compare(Buffer.from(id), Buffer.from(value.after)) > 0)
          .slice(0, limit + 1);
        const items = [];
        for (const tenantId of ids) {
          active();
          const tenant = await transaction.optionalTenant(tenantId);
          active();
          items.push({
            tenantId,
            tenant,
            capabilities: INVITATION_ISSUER_OPERATIONS.flatMap((operation) => {
              // Where an operator grant covers the operation, it decides.
              const grant = grants.find((entry) => entry.tenants.includes(tenantId) && entry.operations.includes(operation));
              const roles = grant?.roles ?? delegated.get(tenantId)?.find((found) => found.operation === operation)?.roles;
              return roles ? [{ operation, roles }] : [];
            }),
          });
        }
        return bounded(items, limit, (item) => item.tenantId);
      });
    } catch {
      throw new TenantInvitationFailure('not_applied');
    }
  };
  const list = async (request: IncomingMessage, input: InvitationListRequest): Promise<InvitationListPage> => {
    try {
      const value = captureTenantData(input);
      exact(value, ['expectedAccount', 'context', 'tenantId', 'operation'], ['after', 'limit']);
      const limit = pageLimit(value);
      if (value.operation !== 'revokeInvitation' && value.operation !== 'reissueInvitation') return denyTenant();
      const operator = invitationOperatorGrant(policy, value.expectedAccount, value.tenantId, value.operation);
      if (!operator && !policy.delegates) return denyTenant();
      return await readOwned(request, value, async (transaction, active) => {
        active();
        const grant = operator ?? (await delegatedCeiling(transaction, value.expectedAccount, value.tenantId, value.operation));
        active();
        const currentTenant = await transaction.optionalTenant(value.tenantId);
        active();
        const ids = await transaction.pendingIds(value.tenantId, value.after ?? '', grant.roles, limit + 1);
        active();
        const store = transaction.invitations,
          items: InvitationPair[] = [];
        for (const id of ids) {
          const row = await store.read(id);
          if (!row || row.tenantId !== value.tenantId || row.status !== 'pending' || row.roles.some((role) => !grant.roles.includes(role)))
            return denyTenant();
          items.push(await transaction.pair(row));
          active();
        }
        return {
          tenant: currentTenant,
          operation: value.operation,
          roles: grant.roles,
          ...bounded(items, limit, (item) => item.invitation.invitationId),
        };
      });
    } catch {
      throw new TenantInvitationFailure('not_applied');
    }
  };
  const preview = async (request: IncomingMessage, input: AdministrationOwner & { token: string }): Promise<InvitationPreview> => {
    try {
      const value = captureTenantData(input);
      exact(value, ['expectedAccount', 'context', 'token']);
      const { session, started } = admission(value, 'recipient');
      const id = invitationTokenId(value.token);
      if (session.invitationId !== id) return denyTenant();
      return await owner.tracked(async () => {
        const { current, live } = lifetime(request, session, started);
        let required: StoredTenantInvitation | undefined,
          requiredOptions: InvitationEligibilityOptions = {};
        const active = () => {
          const instant = live();
          if (required) eligible(required, instant, requiredOptions);
        };
        const checkpoint = async () => {
          await current();
          active();
          if (required && !auth.synchronous) {
            await observeInvitationEligibility(required, policy, auth, live, requiredOptions);
            active();
          }
        };
        await checkpoint();
        const result = await owner.transact({ active, observe: checkpoint }, async (bind, assertCurrent) => {
          await checkpoint();
          assertCurrent();
          const transaction = bind(active),
            store = transaction.invitations;
          const row = await store.read(id);
          if (!row || row.status !== 'pending' || !(await recipientOwns(row, value.expectedAccount))) return denyTenant();
          // Authenticate account ownership before testing the secret.
          if (!matchesInvitationToken(binding, row.invitationId, row.accountId, value.token, row.digest)) return denyTenant();
          const state = await transaction.pair(row);
          active();
          const currentTenant = await transaction.tenant(row.tenantId);
          active();
          if (currentTenant.status !== 'active' || currentTenant.version !== row.expectedTenantVersion) return denyTenant();
          requiredOptions = { ...(await inviterAuthority(transaction, row)), recipient: value.expectedAccount };
          required = row;
          active();
          if (!auth.synchronous) {
            await observeInvitationEligibility(row, policy, auth, live, requiredOptions);
            active();
          }
          // An email invitation is claimed: its placeholder pair ends and the account's begins.
          const intent = {
            operation: invitationPrincipalEmail(row.accountId) === null ? ('acceptInvitation' as const) : ('claimInvitation' as const),
            tenantId: row.tenantId,
            expectedTenantVersion: currentTenant.version,
            invitationId: row.invitationId,
            expectedInvitationVersion: row.version,
            membershipId: row.membershipId,
            expectedMembershipVersion: state.membership.version,
          };
          await checkpoint();
          return { intent, roles: row.roles, redeemUntil: row.redeemUntil, validUntil: row.validUntil };
        });
        await checkpoint();
        return captureTenantData(result);
      });
    } catch (error) {
      if (error instanceof TransactionOutcomeUnknown) owner.uncertain();
      throw new TenantInvitationFailure('not_applied');
    }
  };
  const run = (
    execute: boolean,
    request: IncomingMessage,
    input: InvitationRequest & { token?: string },
  ): Promise<InvitationIssueReply | null> => {
    let value: InvitationRequest & { token?: string }, session: Session, started: number;
    try {
      value = captureTenantData(input);
      exact(value, ['expectedAccount', 'context', 'idempotencyKey', 'intent'], execute ? ['token'] : []);
      tenantIdentifier(value.idempotencyKey);
      if (Buffer.byteLength(value.idempotencyKey) > 256) return denyTenant();
      value = { ...value, intent: captureInvitationIntent(value.intent) };
      const recipientStep = value.intent.operation === 'acceptInvitation' || value.intent.operation === 'claimInvitation';
      if (Object.hasOwn(value, 'token') && (!recipientStep || typeof value.token !== 'string')) return denyTenant();
      ({ session, started } = admission(value, recipientStep ? 'recipient' : 'issuer'));
      if (
        (value.intent.operation === 'acceptInvitation' || value.intent.operation === 'claimInvitation') &&
        session.invitationId !== value.intent.invitationId
      )
        return denyTenant();
    } catch {
      return Promise.reject(new TenantInvitationFailure('not_applied'));
    }
    return owner.tracked(async () => {
      let completed = false,
        attempted = false,
        entered = false;
      const intent = value.intent,
        recipient = intent.operation === 'acceptInvitation' || intent.operation === 'claimInvitation';
      const { current, live } = lifetime(request, session, started);
      let required: StoredTenantInvitation | undefined,
        requiredOptions: InvitationEligibilityOptions = {};
      // An issuer is an operator, whose grant the policy says, or a delegate,
      // whose ceiling its own membership earns inside the transaction below.
      const issuing = intent.operation as InvitationIssuerOperation;
      const operator = recipient ? null : invitationOperatorGrant(policy, value.expectedAccount, intent.tenantId, issuing);
      let delegated: Readonly<{ roles: readonly string[]; validUntil: number }> | undefined;
      const issuerRoles = (): readonly string[] =>
        recipient
          ? denyTenant()
          : operator
            ? invitationGrant(policy, value.expectedAccount, intent.tenantId, issuing).roles
            : (delegated?.roles ?? denyTenant());
      const active = () => {
        const now = live();
        if (!recipient && (operator || delegated)) {
          issuerRoles();
          if (delegated && now >= delegated.validUntil) denyTenant();
        }
        if (required) eligible(required, now, requiredOptions);
      };
      const checkpoint = async () => {
        await current();
        active();
        if (required && !auth.synchronous) {
          await observeInvitationEligibility(required, policy, auth, live, requiredOptions);
          active();
        }
      };
      const authorizeResult = (input: unknown) => {
        const ceiling = recipient
          ? (() => {
              const raw = captureTenantData(input);
              tenantRecord(raw);
              tenantRecord(raw.after);
              tenantRecord(raw.after.invitation);
              if (
                raw.after.invitation.accountId !== value.expectedAccount ||
                raw.after.invitation.policyId !== policy.id ||
                raw.after.invitation.policyVersion !== policy.version
              )
                return denyTenant();
              return raw.after.invitation.roles as readonly string[];
            })()
          : issuerRoles();
        return captureInvitationChange(input, intent, ceiling);
      };
      try {
        if (!recipient && !operator && !policy.delegates) return denyTenant();
        await checkpoint();
        const fingerprint = invitationFingerprint(policy, binding, intent);
        const scope = {
          actorId: value.expectedAccount,
          tenantId: intent.tenantId,
          operation: intent.operation,
          operationVersion: 1,
          idempotencyKey: value.idempotencyKey,
        };
        attempted = true;
        const returned = await owner.transact(
          {
            active: () => {
              entered = true;
              active();
            },
            observe: checkpoint,
          },
          async (bind, assertCurrent) => {
            await checkpoint();
            assertCurrent();
            const transaction = bind(active),
              { journal, invitations: store, administration } = transaction;
            if (!recipient && !operator) {
              // A delegate: its own member row, read — and on PostgreSQL locked — in this transaction.
              delegated = await delegatedCeiling(transaction, value.expectedAccount, intent.tenantId, issuing);
              active();
            }
            const stored = await journal.read(scope);
            if (stored?.fingerprint === fingerprint) completed = true;
            await checkpoint();
            if (stored) {
              if (stored.fingerprint !== fingerprint) return denyTenant();
              const change = authorizeResult(JSON.parse(stored.resultJson));
              return {
                result: { receiptId: stored.id, requestId: stored.requestId, completedAt: stored.completedAt, change, replayed: true },
              };
            }
            if (!execute) return null;
            const currentTenant = await transaction.tenant(intent.tenantId);
            active();
            if (currentTenant.version !== intent.expectedTenantVersion) return denyTenant();
            let before: InvitationPair | null = null,
              old: StoredTenantInvitation | null = null;
            if (intent.operation !== 'issueInvitation') {
              old = await store.read(intent.invitationId);
              if (
                !old ||
                old.tenantId !== intent.tenantId ||
                old.status !== 'pending' ||
                old.version !== intent.expectedInvitationVersion ||
                old.membershipId !== intent.membershipId
              )
                return denyTenant();
              if (live() < old.createdAt) return denyTenant();
              // An account invitation is its account's to accept; an email one is claimed by the account holding its address.
              if (
                recipient &&
                (!(await recipientOwns(old, value.expectedAccount)) ||
                  (intent.operation === 'claimInvitation') !== (invitationPrincipalEmail(old.accountId) !== null))
              )
                return denyTenant();
              before = await transaction.pair(old);
              active();
              if (before.membership.version !== intent.expectedMembershipVersion) return denyTenant();
              if (!recipient && old.roles.some((role) => !issuerRoles().includes(role))) return denyTenant();
            }
            let after: InvitationPair, revoked: InvitationPair | undefined, token: string | undefined;
            if (intent.operation === 'acceptInvitation' || intent.operation === 'claimInvitation') {
              if (
                !old ||
                !before ||
                !matchesInvitationToken(binding, old.invitationId, old.accountId, value.token, old.digest) ||
                currentTenant.status !== 'active' ||
                currentTenant.version !== old.expectedTenantVersion
              )
                return denyTenant();
              // The recorded inviter's authority now: an operator grant, or its own delegate membership.
              requiredOptions = { ...(await inviterAuthority(transaction, old)), recipient: value.expectedAccount };
              required = old;
              active();
              if (!auth.synchronous) {
                await observeInvitationEligibility(old, policy, auth, live, requiredOptions);
                active();
              }
              if (intent.operation === 'claimInvitation') {
                ({ revoked, after } = await applyInvitationClaim(
                  transaction,
                  binding,
                  old,
                  before,
                  currentTenant,
                  value.expectedAccount,
                  live(),
                  active,
                ));
              } else {
                const membership = { ...before.membership, status: 'active' as const, version: next(before.membership.version) };
                const { version: _version, ...change } = membership;
                await administration.putMembership({ ...change, expectedVersion: before.membership.version });
                await store.transition({ invitationId: old.invitationId, expectedVersion: old.version, status: 'accepted' });
                after = { invitation: { ...before.invitation, status: 'accepted', version: next(old.version) }, membership };
              }
            } else {
              if (old && before) {
                const membership = { ...before.membership, status: 'revoked' as const, version: next(before.membership.version) };
                const { version: _version, ...change } = membership;
                await administration.putMembership({ ...change, expectedVersion: before.membership.version });
                await store.transition({ invitationId: old.invitationId, expectedVersion: old.version, status: 'revoked' });
                revoked = { invitation: { ...before.invitation, status: 'revoked', version: next(old.version) }, membership };
              }
              if (intent.operation === 'revokeInvitation') after = revoked!;
              else {
                if (currentTenant.status !== 'active') return denyTenant();
                const instant = live(),
                  accountId = intent.operation === 'issueInvitation' ? invitationIssuePrincipal(intent) : old!.accountId;
                // An email invitation needs email sign-in, or its account could never sign in; a delegate never invites itself.
                if (
                  (invitationPrincipalEmail(accountId) !== null && !accounts?.emailSignIn) ||
                  (delegated && accountId === value.expectedAccount)
                )
                  return denyTenant();
                assertInvitationTermsWithin(policy, issuerRoles(), intent.roles, intent.redeemUntil, intent.validUntil, instant);
                // Count expired reservations too; only explicit termination releases one.
                const count = await transaction.pendingCount(intent.tenantId);
                active();
                if (typeof count !== 'number' || count >= policy.maxPendingPerTenant) return denyTenant();
                const invitationId = randomUUID(),
                  membershipId = randomUUID();
                const minted = mintInvitationToken(binding, invitationId, accountId);
                token = minted.token;
                const row: StoredTenantInvitation = {
                  invitationId,
                  membershipId,
                  tenantId: intent.tenantId,
                  accountId,
                  inviterId: value.expectedAccount,
                  roles: intent.roles,
                  expectedTenantVersion: currentTenant.version,
                  policyId: policy.id,
                  policyVersion: policy.version,
                  issuanceOperation: intent.operation,
                  createdAt: instant,
                  redeemUntil: intent.redeemUntil,
                  validUntil: intent.validUntil,
                  status: 'pending',
                  version: '1',
                  digest: minted.digest,
                };
                requiredOptions = delegated ? { ceiling: delegated.roles } : {};
                required = row;
                active();
                if (!auth.synchronous) {
                  await observeInvitationEligibility(row, policy, auth, live, requiredOptions);
                  active();
                }
                const membership: AdministrationMembershipImage = {
                  membershipId,
                  tenantId: intent.tenantId,
                  accountId,
                  status: 'invited',
                  version: '1',
                  roles: intent.roles,
                  validUntil: intent.validUntil,
                };
                const { version: _version, ...change } = membership;
                await administration.putMembership({ ...change, expectedVersion: null });
                await store.insert(row);
                after = { invitation: image(row), membership };
              }
            }
            const change = authorizeResult({
              operation: intent.operation,
              tenant: currentTenant,
              before,
              after,
              ...(intent.operation === 'reissueInvitation' || intent.operation === 'claimInvitation' ? { revoked } : {}),
            });
            const receipt: StoredAdministrationReceipt = {
              ...scope,
              id: randomUUID(),
              fingerprint,
              requestId: randomUUID(),
              completedAt: new Date(live()).toISOString(),
              resultJson: JSON.stringify(change),
            };
            await journal.commit(receipt, {
              policyId: policy.id,
              policyVersion: policy.version,
              deployment: owner.deployment,
              sessionId: session.proof.sessionId,
              changeJson: receipt.resultJson,
            });
            await checkpoint();
            assertCurrent();
            return {
              result: { receiptId: receipt.id, requestId: receipt.requestId, completedAt: receipt.completedAt, change, replayed: false },
              ...(token ? { token } : {}),
            };
          },
        );
        completed = returned !== null;
        await checkpoint();
        if (returned) authorizeResult(returned.result.change);
        return captureTenantData(returned);
      } catch (error) {
        if (error instanceof TransactionOutcomeUnknown || (attempted && !entered)) owner.uncertain();
        throw new TenantInvitationFailure(completed || error instanceof TransactionOutcomeUnknown ? 'unknown' : 'not_applied');
      }
    });
  };
  const disclose = (result: InvitationResult): InvitationResult | InvitationAcceptanceResult => {
    if (result.change.operation !== 'acceptInvitation' && result.change.operation !== 'claimInvitation') return result;
    // The invitation the person accepted or claimed; a claim's membership is its account's new one.
    const { membership } = result.change.after,
      invitation = result.change.before!.invitation;
    return captureTenantData({
      receiptId: result.receiptId,
      requestId: result.requestId,
      completedAt: result.completedAt,
      replayed: result.replayed,
      invitationId: invitation.invitationId,
      tenantId: membership.tenantId,
      membershipId: membership.membershipId,
      membershipVersion: membership.version,
      roles: membership.roles,
      validUntil: membership.validUntil,
      status: 'accepted' as const,
    });
  };
  /* The signed-out claim. Two stores, not one transaction: the invitation is
     checked, the account created in the native auth store, then the claim is
     committed on the business database with every fence read again. If that
     last step fails, the account stands and the invitation stays pending: the
     person signs in and accepts it with the same token. No native session
     exists here, so nothing is observed but the accounts themselves. */
  const claim = (request: IncomingMessage, input: { token: string; name: string; password: string }): Promise<InvitationClaimReply> => {
    let token: string, name: string, password: string, invitationId: string, started: number;
    try {
      const value = captureTenantData(input);
      exact(value, ['token', 'name', 'password']);
      // The account's own fields first: this answer never depends on the token.
      const named = profileName(value.name);
      try {
        if (named === undefined) throw new NativeAccountRefusal('invalid');
        name = named;
        password = nativeAccountPassword(value.password);
      } catch {
        return Promise.reject(new TenantInvitationClaimRefusal('invalid_account'));
      }
      if (typeof value.token !== 'string' || !accounts?.emailSignIn) return denyTenant();
      token = value.token;
      invitationId = invitationTokenId(token);
      started = owner.clock();
      if (started > Number.MAX_SAFE_INTEGER - owner.lifetime) return denyTenant();
    } catch {
      return Promise.reject(new TenantInvitationClaimRefusal('unavailable'));
    }
    return owner.tracked(async () => {
      let last = started;
      const live = () => {
        const now = owner.clock();
        if (request.aborted || now < last || now >= started + owner.lifetime) return denyTenant();
        last = now;
        return now;
      };
      /** One claim transaction: the pending email invitation behind the token,
       * its tenant at the issued version, the inviter's authority now, and —
       * once there is one — the account whose address is the invited one. */
      const phase = <T>(
        accountId: string | undefined,
        work: (
          transaction: InvitationTransaction,
          row: StoredTenantInvitation,
          before: InvitationPair,
          tenant: AdministrationTenantImage,
          email: string,
          active: () => void,
        ) => Promise<T>,
      ) => {
        let required: StoredTenantInvitation | undefined,
          options: InvitationEligibilityOptions = {};
        const active = () => {
          const now = live();
          if (required) eligible(required, now, options);
        };
        const observe = async () => {
          active();
          if (required && !auth.synchronous) {
            await observeInvitationEligibility(required, policy, auth, live, options);
            active();
          }
        };
        return owner.transact({ active, observe }, async (bind, assertCurrent) => {
          assertCurrent();
          const transaction = bind(active),
            row = await transaction.invitations.read(invitationId);
          active();
          const email = row && invitationPrincipalEmail(row.accountId);
          if (
            !row ||
            !email ||
            row.status !== 'pending' ||
            !matchesInvitationToken(binding, row.invitationId, row.accountId, token, row.digest)
          )
            return denyTenant();
          const before = await transaction.pair(row);
          active();
          const tenant = await transaction.tenant(row.tenantId);
          active();
          if (tenant.status !== 'active' || tenant.version !== row.expectedTenantVersion) return denyTenant();
          options = { ...(await inviterAuthority(transaction, row)), ...(accountId === undefined ? {} : { recipient: accountId }) };
          if (accountId !== undefined && (await accounts!.emailOf(accountId)) !== email) return denyTenant();
          required = row;
          await observe();
          return work(transaction, row, before, tenant, email, active);
        });
      };
      let email: string;
      try {
        email = await phase(undefined, async (_transaction, _row, _before, _tenant, address) => address);
      } catch (error) {
        if (error instanceof TransactionOutcomeUnknown) owner.uncertain();
        throw new TenantInvitationClaimRefusal('unavailable');
      }
      // Only a valid token reaches this: whether the address has an account is its holder's to know.
      let accountId: string;
      try {
        if ((await accounts!.findByEmail(email)) !== null) throw new NativeAccountRefusal('exists');
        accountId = await accounts!.create({ email, name, password }, invitationId);
      } catch (error) {
        if (error instanceof NativeAccountRefusal && error.reason === 'exists') throw new TenantInvitationClaimRefusal('account_exists');
        if (error instanceof NativeAccountRefusal && error.reason === 'invalid') throw new TenantInvitationClaimRefusal('invalid_account');
        throw new TenantInvitationClaimRefusal('unavailable', 'unknown');
      }
      let attempted = false;
      try {
        const result = await phase(accountId, async (transaction, row, before, tenant, _email, active) => {
          const intent = captureInvitationIntent({
            operation: 'claimInvitation',
            tenantId: row.tenantId,
            expectedTenantVersion: tenant.version,
            invitationId: row.invitationId,
            expectedInvitationVersion: row.version,
            membershipId: before.membership.membershipId,
            expectedMembershipVersion: before.membership.version,
          });
          // One claim per invitation: its id is the attempt's key.
          const scope = {
            actorId: accountId,
            tenantId: row.tenantId,
            operation: 'claimInvitation',
            operationVersion: 1,
            idempotencyKey: row.invitationId,
          };
          if (await transaction.journal.read(scope)) return denyTenant();
          const { revoked, after } = await applyInvitationClaim(transaction, binding, row, before, tenant, accountId, live(), active);
          const change = captureInvitationChange(
            { operation: 'claimInvitation', tenant, before, after, revoked },
            intent,
            after.invitation.roles,
          );
          const receipt: StoredAdministrationReceipt = {
            ...scope,
            id: randomUUID(),
            fingerprint: invitationFingerprint(policy, binding, intent),
            requestId: randomUUID(),
            completedAt: new Date(live()).toISOString(),
            resultJson: JSON.stringify(change),
          };
          attempted = true;
          await transaction.journal.commit(receipt, {
            policyId: policy.id,
            policyVersion: policy.version,
            deployment: owner.deployment,
            sessionId: `claim:${randomUUID()}`,
            changeJson: receipt.resultJson,
          });
          return { receiptId: receipt.id, requestId: receipt.requestId, completedAt: receipt.completedAt, change, replayed: false };
        });
        return captureTenantData({
          outcome: 'applied' as const,
          account: 'created' as const,
          email,
          result: disclose(result) as InvitationAcceptanceResult,
        });
      } catch (error) {
        if (error instanceof TransactionOutcomeUnknown) owner.uncertain();
        throw new TenantInvitationClaimRefusal(
          'incomplete',
          attempted || error instanceof TransactionOutcomeUnknown ? 'unknown' : 'not_applied',
        );
      }
    });
  };
  return Object.freeze<TenantInvitations>({
    claim,
    openIssuer: async (request, input) => (await open('issuer', request, input)) as InvitationIssuerSession | null,
    openRecipient: async (request, input) => (await open('recipient', request, input))!,
    preview,
    targets,
    list,
    execute: async (request, input) => {
      const reply = (await run(true, request, input))!;
      return captureTenantData({ result: disclose(reply.result), ...(reply.token ? { token: reply.token } : {}) });
    },
    status: async (request, input) => {
      const reply = await run(false, request, input);
      return reply ? disclose(reply.result) : null;
    },
  });
}
