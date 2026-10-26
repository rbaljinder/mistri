/** Private genuine native-session receipt recovery, not support opening or
 * business admission. The administration owner supplies its existing writer,
 * serial queue and drain; historical receipts never become role grants. */
import type { IncomingMessage } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { TransactionOutcomeUnknown } from '@mistriwork/engine/adapters/adapter.js';
import type { AppDef } from '../../shared/appModel.js';
import { captureAppAuthRuntime, captureNativeSignInAge, type AppAuthRuntime } from '../auth/auth.js';
import { captureTenantData, denyTenant, tenantOptions, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { binding, identifier } from './tenantAdministrationJournalValidation.js';
import type { TenantStoreBinding } from './tenantStoreContract.js';
import type { TenantAdministrationJournal } from './tenantAdministrationJournalContract.js';
import { captureSupportChange, captureSupportPolicy, supportFingerprint } from './tenantSupportChange.js';
import { keyId, type SupportAuditKey, type SupportAuditOwner } from './tenantSupportAuditContract.js';

export interface SupportReceiptRecoveryOptions {
  readonly app: AppDef;
  readonly policy: unknown;
  readonly key: SupportAuditKey;
}
type Intent =
  | { operation: 'openSupport'; tenantId: string; dealerRole: string; reason: string }
  | { operation: 'exitSupport'; tenantId: string; supportId: string; expectedSupportVersion: string };
interface Attempt {
  readonly expectedAccount: string;
  readonly idempotencyKey: string;
  readonly intent: Intent;
}
interface Ports {
  clock(): number;
  tracked<T>(work: () => Promise<T>): Promise<T>;
  /** An outcome could not be confirmed: the store closes behind the work admitted and reopens (tenantWriterLifecycle.ts). */
  uncertain(): void;
  transact<T>(
    active: () => void,
    work: (journal: TenantAdministrationJournal, audit: SupportAuditOwner, assertCurrent: () => void) => Promise<T>,
  ): Promise<T>;
}
export class SupportReceiptRecoveryFailure extends Error {
  readonly code = 'support_history_unavailable';
  constructor() {
    super('The support history could not be verified.');
  }
}
const refuse = (): never => {
  throw new SupportReceiptRecoveryFailure();
};

/** Only the private administration constructor calls this with its exact native
 * runtime. Structural proof objects or an injected verifier cannot admit work. */
export function prepareSupportReceiptRecovery(
  input: SupportReceiptRecoveryOptions,
  rawBinding: TenantStoreBinding,
  runtime: AppAuthRuntime,
  deployment: string,
) {
  const raw = tenantOptions(input, ['app', 'policy', 'key']);
  if (Object.keys(raw).length !== 3) return denyTenant();
  const originalApp = raw.app,
    originalPolicy = raw.policy,
    key = raw.key as SupportAuditKey;
  const app = captureTenantData(originalApp) as AppDef,
    policy = captureSupportPolicy(originalPolicy);
  const owner = binding(rawBinding),
    auth = captureAppAuthRuntime(runtime),
    age = captureNativeSignInAge(runtime);
  identifier(deployment);
  if (
    !auth.synchronous ||
    !age.synchronous ||
    app.id !== owner.appId ||
    app.id !== auth.appId ||
    app.auth?.rows !== 'tenant' ||
    !app.auth.tenancy?.platform
  )
    return denyTenant();
  for (const grant of policy.grants) {
    if (
      app.auth.roles?.[grant.platformRole]?.realm !== 'platform' ||
      grant.dealerRoles.some((role) => app.auth!.roles?.[role]?.realm !== 'tenant')
    )
      return denyTenant();
  }
  keyId(key);
  const definition = JSON.stringify(app),
    policyText = JSON.stringify(policy);
  const assertCurrent = () => {
    auth.assertCurrent();
    const latest = tenantOptions(input, ['app', 'policy', 'key']);
    if (
      latest.app !== originalApp ||
      latest.policy !== originalPolicy ||
      latest.key !== key ||
      JSON.stringify(captureTenantData(originalApp)) !== definition ||
      JSON.stringify(captureSupportPolicy(originalPolicy)) !== policyText
    )
      return denyTenant();
    keyId(key);
  };
  assertCurrent();
  const create = (ports: Ports) =>
    Object.freeze({
      status(request: IncomingMessage, input: Attempt) {
        let attempt: Attempt;
        try {
          const value = captureTenantData(input);
          tenantRecord(value, ['expectedAccount', 'idempotencyKey', 'intent']);
          if (Object.keys(value).length !== 3) return refuse();
          identifier(value.expectedAccount, 1024);
          identifier(value.idempotencyKey);
          // Validate the complete intent before any authentication/queue await.
          supportFingerprint({
            binding: owner,
            deployment,
            actorId: value.expectedAccount,
            nativeSessionId: 'input-validation-only',
            policy,
            intent: value.intent,
          });
          attempt = value;
          assertCurrent();
        } catch {
          return Promise.reject(new SupportReceiptRecoveryFailure());
        }
        return ports.tracked(async () => {
          try {
            assertCurrent();
            const started = ports.clock(),
              proof = await auth.sessionInstance(request);
            if (!proof || proof.identity.id !== attempt.expectedAccount) return refuse();
            let last = started;
            const live = () => {
              assertCurrent();
              const now = ports.clock();
              auth.assertSessionCurrent(proof);
              if (request.aborted || now < last || now >= proof.expiresAt || now - started > 300000) return refuse();
              last = now;
            };
            // Historical status deliberately has no five-minute sign-in-age gate.
            // Its request deadline is bounded, but it never renews support expiry.
            live();
            const current = async () => {
              live();
              const fresh = await auth.sessionInstance(request);
              live();
              if (!fresh || fresh.sessionId !== proof.sessionId || fresh.identity.id !== proof.identity.id) return refuse();
              auth.assertSessionCurrent(fresh);
              live();
            };
            await current();
            const fingerprint = supportFingerprint({
              binding: owner,
              deployment,
              actorId: proof.identity.id,
              nativeSessionId: proof.sessionId,
              policy,
              intent: attempt.intent,
            });
            const result = await ports.transact(live, async (journal, audit, active) => {
              live();
              active();
              // Own receipt scope first. Never acquire another attempt's scope.
              const receipt = await journal.read({
                actorId: proof.identity.id,
                tenantId: attempt.intent.tenantId,
                operation: attempt.intent.operation,
                operationVersion: 1,
                idempotencyKey: attempt.idempotencyKey,
              });
              live();
              active();
              if (!receipt) return null;
              if (receipt.fingerprint !== fingerprint) return refuse();
              const change = captureSupportChange(JSON.parse(receipt.resultJson), attempt.intent);
              const session = change.after.session;
              if (
                session.accountId !== proof.identity.id ||
                session.nativeSessionId !== proof.sessionId ||
                session.deployment !== deployment ||
                session.policyId !== policy.id ||
                session.policyVersion !== policy.version
              )
                return refuse();
              const pairs = change.operation === 'openSupport' && change.replaced ? [change.after, change.replaced.after] : [change.after];
              pairs.sort((a, b) => Buffer.compare(Buffer.from(a.session.id), Buffer.from(b.session.id)));
              for (const pair of pairs) {
                const header = await audit.readHeader(pair.session.id);
                live();
                active();
                if (!header || header.session.accountId !== proof.identity.id) return refuse();
                const { endedAt: _ended, endReason: _reason, ...fixed } = header.session;
                const { endedAt, endReason, ...expected } = pair.session;
                if (
                  !isDeepStrictEqual(captureTenantData(fixed), captureTenantData(expected)) ||
                  (endedAt !== null && (header.session.endedAt !== endedAt || header.session.endReason !== endReason))
                )
                  return refuse();
              }
              await current();
              active();
              return captureTenantData({
                stage: 'support-receipt-recovery' as const,
                authorization: 'pending' as const,
                receiptId: receipt.id,
                requestId: receipt.requestId,
                completedAt: receipt.completedAt,
                change,
              });
            });
            await current();
            live();
            return result;
          } catch (error) {
            if (error instanceof TransactionOutcomeUnknown) ports.uncertain();
            return refuse();
          }
        });
      },
    });
  return Object.freeze({ key, assertCurrent, create });
}
export type SupportReceiptRecovery = ReturnType<ReturnType<typeof prepareSupportReceiptRecovery>['create']>;
