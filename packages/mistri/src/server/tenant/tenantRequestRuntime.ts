import { isPromise } from 'node:util/types';
import { TransactionOperations, TransactionOutcomeUnknown, type WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { CommandTransactionFailure, type CommandJournal } from '../../adapters/commands/commandJournal.js';
import { declaredReferences, physicalBindings, resolveAppAccess, tenantAppShape, type AppDef } from '../../shared/app.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { assertScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import type { ResourceAccess } from '../app/appAccess.js';
import { compileAppDefinitionValidation } from '../app/appValidation.js';
import { appResourceCatalog } from '../app/appResources.js';
import {
  captureTenantData,
  denyTenant,
  tenantIdentifier,
  tenantOptions,
  tenantRecord,
  refusalCause,
} from '@mistriwork/engine/server/evidence.js';
import { createTenantMembershipIssuer, type TenantMembershipEvidence } from './tenantMembership.js';
import { composeTenantReadScope } from './tenantReadScope.js';
import { advisoryRecords, captureTenantReadSource, type TenantReadSource } from './tenantReadSource.js';
import { assertTenantSourcePair } from './tenantSourceIdentity.js';
import { tenantRuntimeClock } from './tenantRuntimeClock.js';
import { captureTenantWriteSource, TenantWriteFailure, type TenantWriteSource } from './tenantWriteSource.js';
import { tenantWriteFailed, type TenantWriteOperation } from './tenantWriteKindContract.js';
import type { TenantWriteRuntimeOptions } from './tenantWriteRuntime.js';
import { tenantRetirement } from './tenantRetirement.js';
import { checkTenantInvocation, revalidateTenantInvocation, type TenantInvocationGuard } from './tenantInvocation.js';
import { membershipLapsed } from './tenantStoreContract.js';
import { evidenceRefused, type AdmissionCache } from './tenantAdmissionCache.js';
import { actingPrincipal } from './tenantApiRequest.js';
import { bindTenantFlagOwner } from './tenantFlagRuntime.js';

/** Private host scope, never passed to a command handler. Its single transaction
 * owns actual completion; an executor must not nest a pretend transaction inside
 * a source callback and infer commit from callback success. */
export interface TenantRequestScope {
  readonly principal: TenantMembershipEvidence;
  readonly rows: RowScope;
  readonly grants: ResourceAccess;
  session(): Promise<void>;
  /** `operation` names which of the host's operations ran, for a writer kind
   * that records one: Undo passes 'undo' because `undo()` is what called. It is
   * never taken from a request, so it states what happened rather than what a
   * caller claims. Absent, an ordinary write. */
  transaction<T>(run: (records: WriteTransaction) => T | Promise<T>, operation?: TenantWriteOperation): Promise<T>;
  commandTransaction<T>(run: (records: WriteTransaction, journal: CommandJournal) => T | Promise<T>, read: readonly string[]): Promise<T>;
  /** A command's questions without its transaction: one read snapshot under
   * the same footprint and row scope, whose records refuse every write. Advice
   * only — which commands a record offers — that the command asks again in its
   * own transaction when it runs; it takes no writer, so it queues behind none.
   * Like a transaction, it is this request's one. */
  advisoryReads<T>(run: (records: WriteTransaction) => T | Promise<T>, read: readonly string[]): Promise<T>;
  /** The tenant's own scoped reads, outside any transaction: what a command's lookup reads through. */
  reads(): ReturnType<TenantReadSource['scopeReads']>;
}
function delivered<T>(value: T | Promise<T>): T | Promise<T> {
  return isPromise(value)
    ? (Promise.prototype.then.call(
        value,
        (result: T) => captureTenantData(result),
        () => denyTenant(),
      ) as Promise<T>)
    : captureTenantData(value);
}

const optionKeys = [
  'app',
  'reader',
  'writer',
  'deployment',
  'roles',
  'maxLifetimeMs',
  'verifySession',
  'resolveMembershipRows',
  'resolveRows',
  'authorizeDeletedRecord',
  'now',
  'admissions',
];
const runtimes = new WeakSet<object>();
/* The requests whose last run released an answer its committed transaction
   proved: the context owner need not observe the membership again for them
   (tenantContexts.ts). */
const provenByCommit = new WeakSet<object>();
/** The request's last run answered from a committed transaction, which held the membership from BEGIN to COMMIT. */
export const tenantAnswerProvenByCommit = (request: unknown): boolean =>
  request !== null && typeof request === 'object' && provenByCommit.has(request);
/* The requests whose last run released an answer only after its release
   fence passed: the session and the invocation guard, then the membership in
   a snapshot of its own, after the last thing the answer read. */
const provenByFence = new WeakSet<object>();
/** The request's last run was fenced after everything its answer read: what a read's own release fence proves. */
export const tenantAnswerProvenByFence = (request: unknown): boolean =>
  request !== null && typeof request === 'object' && provenByFence.has(request);
/* Refusals that are the membership's own: read afresh at admission, or met by
   the writer's fence before anything ran. Never an unknown outcome. */
const refusedMembership = new WeakSet<object>();
/** A request refused because its membership no longer holds (revoked, suspended, changed), before anything was written. */
export const tenantMembershipRefused = (error: unknown): boolean =>
  error !== null && typeof error === 'object' && refusedMembership.has(error);
export type TenantRequestRuntime<Request> = ReturnType<typeof bindTenantRequestRuntime<Request>>;
export function captureTenantRequestRuntime<Request>(runtime: TenantRequestRuntime<Request>): TenantRequestRuntime<Request> {
  if (!runtimes.has(runtime)) return denyTenant();
  return runtime;
}
/** Shared admission, one owned transaction, buffered release and draining
 * retirement. Record/command field grants and receipt disclosure remain callers'
 * responsibilities. Auth callbacks are pure; business effects run after issuance. */
export function createTenantRequestRuntime<Request>(options: TenantWriteRuntimeOptions<Request>) {
  const raw = tenantOptions(options, optionKeys);
  const binding = bindTenantRequestRuntime(raw as unknown as TenantWriteRuntimeOptions<Request>);
  const reader = captureTenantReadSource(raw.reader as TenantReadSource),
    writer = captureTenantWriteSource(raw.writer as TenantWriteSource);
  const runtime = Object.freeze({ ...binding, retire: tenantRetirement([binding.retire], [reader.close, writer.close]) });
  runtimes.add(runtime);
  return runtime;
}

/** Internal non-owning binding. Its retire stops admission and drains requests;
 * only the successfully constructed outer deployment may close the sources. */
export function bindTenantRequestRuntime<Request>(options: TenantWriteRuntimeOptions<Request>) {
  const raw = tenantOptions(options, optionKeys);
  const reader = captureTenantReadSource(raw.reader as TenantReadSource);
  const writer = captureTenantWriteSource(raw.writer as TenantWriteSource);
  const identity = assertTenantSourcePair(reader, writer),
    ownership = writer.ownership;
  const app = captureTenantData(raw.app as AppDef);
  if (!app || !tenantAppShape(app, ownership)) return denyTenant();
  const catalog = appResourceCatalog(
    ownership.physicalSchema,
    physicalBindings(app, ownership.source.id),
    declaredReferences(app, ownership.source.id),
  );
  assertScopeCatalog(ownership.schema, catalog.schema);
  for (const id of Object.keys(ownership.resources)) if (catalog.toPhysical(id) !== ownership.resources[id]) denyTenant();
  resolveAppAccess(app, ownership.schema, []);
  const validation = compileAppDefinitionValidation(ownership.schema, app);
  if (
    typeof raw.verifySession !== 'function' ||
    typeof raw.resolveMembershipRows !== 'function' ||
    typeof raw.resolveRows !== 'function' ||
    (raw.now !== undefined && typeof raw.now !== 'function') ||
    (raw.authorizeDeletedRecord !== undefined && typeof raw.authorizeDeletedRecord !== 'function')
  )
    return denyTenant();
  const verify = raw.verifySession as TenantWriteRuntimeOptions<Request>['verifySession'];
  const membershipRows = raw.resolveMembershipRows as TenantWriteRuntimeOptions<Request>['resolveMembershipRows'];
  const authoredRows = raw.resolveRows as TenantWriteRuntimeOptions<Request>['resolveRows'];
  const now = tenantRuntimeClock((raw.now ?? Date.now) as () => number);
  const issuer = createTenantMembershipIssuer({
    ownership,
    deployment: raw.deployment as string,
    roles: raw.roles as readonly string[],
    maxLifetimeMs: raw.maxLifetimeMs as number,
    verifySession: verify,
    membership: { source: ownership.source, read: reader.readMembership },
    now,
    ...(raw.admissions === undefined ? {} : { admissions: raw.admissions as AdmissionCache }),
  });
  let retired = false,
    retirement: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  const runtime = Object.freeze({
    app,
    ownership,
    identity,
    deployment: raw.deployment as string,
    retire(): Promise<void> {
      if (retirement) return retirement;
      retired = true;
      retirement = (async () => {
        await issuer.retire();
        await Promise.allSettled([...pending]);
      })();
      void retirement.catch(() => {});
      return retirement;
    },
    async run<T>(
      request: Request,
      selectors: readonly string[],
      callback: (scope: TenantRequestScope) => T | Promise<T>,
      guard?: TenantInvocationGuard,
    ): Promise<T> {
      if (retired || typeof callback !== 'function' || (guard !== undefined && typeof guard !== 'function'))
        throw new TenantWriteFailure('not_applied');
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      pending.add(held);
      provenByCommit.delete(request as object);
      provenByFence.delete(request as object);
      let committed = false,
        accepting = true,
        attempted = false,
        membershipRefused = false,
        fenced = false,
        proved = false;
      let operations = new TransactionOperations();
      let principal: TenantMembershipEvidence | undefined;
      let releaseFlags = () => {};
      try {
        let lastTime = 0;
        const guarded = () => checkTenantInvocation(guard, principal!);
        const active = () => {
          guarded();
          if (retired) return denyTenant();
          const instant = now();
          guarded();
          if (
            retired ||
            typeof instant !== 'number' ||
            !Number.isSafeInteger(instant) ||
            instant < lastTime ||
            instant >= principal!.validUntil
          )
            return denyTenant();
          lastTime = instant;
        };
        const session = async () => {
          active();
          const value = delivered(verify(request)),
            identity = isPromise(value) ? await value : value;
          active();
          tenantRecord(identity, ['id', 'who', 'role']);
          tenantIdentifier(identity.id, 1024);
          if (
            identity.id !== principal!.accountId ||
            typeof identity.who !== 'string' ||
            (identity.role !== undefined && typeof identity.role !== 'string')
          )
            return denyTenant();
          const verified = revalidateTenantInvocation(guard, principal!);
          if (isPromise(verified)) await verified;
          active();
        };
        /* Admission, and the scope and grants computed from its evidence on
           every request. The membership is not read again here: every way a
           request reaches the tenant's rows proves it there. A write's
           transaction locks the tenant and membership rows before its callback
           and holds them to COMMIT (the writer's fence), a read revalidates in
           its own snapshot before its SQL, and an answer that neither proved
           is held for the release fence below. Kept evidence
           (tenantAdmissionCache.ts) that this refuses is admitted afresh once:
           nothing has been written. */
        let rows!: RowScope,
          grants!: ResourceAccess,
          kept = false;
        const admit = async (first: boolean) => {
          for (let fresh = first; ; fresh = true) {
            let admitted: { evidence: TenantMembershipEvidence; kept: boolean };
            try {
              admitted = await issuer.withMembership(request, selectors, (evidence, kept) => ({ evidence, kept }), { fresh });
            } catch (error) {
              // The membership read afresh refused it: what a revoked member, or a suspended tenant's, is told.
              membershipRefused = membershipLapsed(error);
              throw error;
            }
            principal = admitted.evidence;
            lastTime = principal.verifiedAt;
            try {
              active();
              const membership = delivered(membershipRows(principal)),
                member = isPromise(membership) ? await membership : membership;
              active();
              // Granted to the roles this request acts under: a token's own (tenantApiRequest.ts).
              const acting = actingPrincipal(request, principal);
              const authored = delivered(authoredRows(acting)),
                policy = isPromise(authored) ? await authored : authored;
              active();
              rows = composeTenantReadScope(ownership, principal, member, policy);
              const resolvedGrants = resolveAppAccess(app, ownership.schema, [...acting.roles]);
              grants = validation ? { ...resolvedGrants, validation } : resolvedGrants;
              await session();
              active();
              kept = admitted.kept;
              return;
            } catch (error) {
              issuer.forget(request, principal);
              if (!admitted.kept || fresh || !evidenceRefused(error)) throw error;
            }
          }
        };
        await admit(false);
        for (let again = false; ; again = true) {
          const admitted = principal!;
          /* Anything this request observes outside its one transaction — a
           lookup's reads, advice, a flag — is proven by its own snapshot when
           it is read, and then once more by the release fence, after the last
           of it: as before. */
          let outside = false;
          releaseFlags = bindTenantFlagOwner(
            request,
            admitted,
            async () => {
              outside = true;
              await session();
              await reader.assertCurrent(admitted);
              active();
            },
            active,
          );
          let callbackFailure: { error: unknown } | undefined;
          const transaction = <R>(
            command: boolean,
            run: (records: WriteTransaction, journal?: CommandJournal) => R | Promise<R>,
            ceiling?: readonly string[],
            operation?: TenantWriteOperation,
          ): Promise<R> => {
            if (!accepting) return Promise.reject(new TenantWriteFailure('not_applied'));
            let invalid = attempted || typeof run !== 'function',
              sourceRows = rows;
            attempted = true;
            if (command) {
              try {
                const read = captureTenantData(ceiling);
                if (
                  !Array.isArray(read) ||
                  !read.length ||
                  read.length > 256 ||
                  new Set(read).size !== read.length ||
                  read.some((table) => typeof table !== 'string' || !Object.hasOwn(ownership.resources, table))
                )
                  return operations.run(async () => denyTenant());
                // Internal FK/current-row checks must see the command footprint,
                // not every App-visible row. This intersects, never replaces or
                // widens, the mandatory membership/authored tenant scope.
                sourceRows = Object.freeze(
                  Object.fromEntries(Object.entries(rows).map(([table, row]) => [table, read.includes(table) ? row : false])),
                );
              } catch {
                invalid = true;
              }
            }
            return operations.run(async () => {
              if (invalid || callbackFailure) return denyTenant();
              let workFailure: { error: unknown } | undefined;
              const work = async (records: WriteTransaction, journal?: CommandJournal) => {
                // The writer's fence passed: the membership is held from here to COMMIT or ROLLBACK.
                fenced = true;
                await session();
                try {
                  const result = await run(records, journal);
                  await session();
                  return result;
                } catch (error) {
                  workFailure = { error };
                  throw error;
                }
              };
              try {
                const result = command
                  ? await writer.commandTransaction(admitted, sourceRows, work, active, operation, ceiling)
                  : await writer.transaction(admitted, rows, (records) => work(records), active, operation);
                committed = true;
                return result;
              } catch (error) {
                // Actual outer source completion, not callback return, classifies
                // this wrapper. Preserve the private domain cause for the existing
                // executor while keeping the source's confirmed/unknown outcome.
                if (command)
                  throw new CommandTransactionFailure(
                    workFailure?.error ?? error,
                    error instanceof TenantWriteFailure ? error.outcome : 'unknown',
                  );
                throw error;
              }
            });
          };
          const advisoryReads = <R>(run: (records: WriteTransaction) => R | Promise<R>, ceiling: readonly string[]): Promise<R> => {
            if (!accepting) return Promise.reject(new TenantWriteFailure('not_applied'));
            const invalid = attempted || typeof run !== 'function';
            attempted = true;
            let footprint: RowScope | undefined;
            try {
              const read = captureTenantData(ceiling);
              if (
                Array.isArray(read) &&
                read.length &&
                read.length <= 256 &&
                new Set(read).size === read.length &&
                read.every((table) => typeof table === 'string' && Object.hasOwn(ownership.resources, table))
              ) {
                // The footprint intersects, never widens, the mandatory scope — as a command transaction's does.
                footprint = Object.freeze(
                  Object.fromEntries(Object.entries(rows).map(([table, row]) => [table, read.includes(table) ? row : false])),
                );
              }
            } catch {
              footprint = undefined;
            }
            outside = true;
            return operations.run(async () => {
              if (invalid || !footprint || callbackFailure) return denyTenant();
              await session();
              const result = await reader.withReads(admitted, footprint, (reads) => run(advisoryRecords(reads)));
              active();
              await session();
              return result;
            });
          };
          let scoped: ReturnType<TenantReadSource['scopeReads']> | undefined;
          const scope = Object.freeze<TenantRequestScope>({
            principal: admitted,
            rows,
            grants,
            session,
            advisoryReads,
            transaction: (run, operation) => transaction(false, run, undefined, operation),
            commandTransaction: (run, read) => transaction(true, (records, journal) => run(records, journal!), read),
            reads: () => {
              active();
              outside = true;
              return (scoped ??= reader.scopeReads(admitted, rows));
            },
          });
          let result!: T;
          const completed = (value: T): T => {
            accepting = false;
            return captureTenantData(value);
          };
          try {
            const returned = callback(scope);
            result = isPromise(returned)
              ? ((await Promise.prototype.then.call(returned, completed, (error: unknown) => {
                  accepting = false;
                  throw error;
                })) as T)
              : completed(returned);
          } catch (error) {
            callbackFailure = { error };
          }
          accepting = false;
          let drainFailure: { error: unknown } | undefined;
          try {
            await operations.finish();
          } catch (error) {
            drainFailure = { error };
          }
          if (
            callbackFailure?.error instanceof TransactionOutcomeUnknown ||
            (callbackFailure?.error instanceof CommandTransactionFailure && callbackFailure.error.outcome === 'unknown') ||
            (callbackFailure?.error instanceof TenantWriteFailure && callbackFailure.error.outcome === 'unknown')
          )
            throw callbackFailure.error;
          let failure = drainFailure ?? callbackFailure;
          if (!failure) await session();
          /* What proves the membership for this answer. A committed transaction
             proved it from its BEGIN to its COMMIT, with the tenant and
             membership rows locked against every change, and everything this
             answer carries was read inside it: a revocation after the COMMIT
             does not change what was committed, so its answer is released
             without reading the membership again. Any other answer is held for
             the release fence, and so is a refusal met before a transaction's
             fence passed — the fence's own, or the request's before it reached
             the writer — so that a member who no longer holds the membership
             is told so, as admission told them, and never something about the
             record or the request. */
          proved = true;
          let fencedAfter = false;
          if (failure ? !fenced && !committed : !(committed && !outside)) {
            try {
              await reader.assertCurrent(admitted);
              fencedAfter = !failure;
            } catch (error) {
              const membership = evidenceRefused(error);
              /* Kept evidence it refuses, with nothing run inside a
                 transaction: admitted afresh and run once more, as admission's
                 own refusal was before the fence became the proof (a role
                 changed or a grant renewed since the evidence was kept). */
              if (membership && kept && !again && !committed && !fenced) {
                issuer.forget(request, admitted);
                releaseFlags();
                releaseFlags = () => {};
                accepting = true;
                attempted = false;
                proved = false;
                operations = new TransactionOperations();
                await admit(true);
                continue;
              }
              if (membershipLapsed(error)) membershipRefused = true;
              if (membership || !failure) failure = { error };
            }
          }
          if (failure) throw failure.error;
          if (committed && !outside) provenByCommit.add(request as object);
          if (fencedAfter) provenByFence.add(request as object);
          active();
          return result;
        }
      } catch (error) {
        accepting = false;
        await operations.finish().catch(() => {});
        // Evidence that met a refusal anywhere, a writer's fence included, is not kept.
        if (principal) issuer.forget(request, principal);
        const unknown =
          committed ||
          error instanceof TransactionOutcomeUnknown ||
          (error instanceof CommandTransactionFailure && error.outcome === 'unknown') ||
          (error instanceof TenantWriteFailure && error.outcome === 'unknown');
        /* A refusal met before any transaction's fence passed — the fence's
           own, or one the request made before it reached the writer — is
           answered as the membership's when the membership, read now, no
           longer holds: a revoked member hears what admission would have told
           them, never a refusal about the record or the request. */
        let refused = error;
        if (!unknown && !membershipRefused && !proved && !fenced && principal) {
          try {
            await reader.assertCurrent(principal);
          } catch (proof) {
            if (membershipLapsed(proof)) {
              membershipRefused = true;
              refused = proof;
            }
          }
        }
        // The same value-free refusal, with the reason kept for the owner:
        // this is where a platform write's cause used to stop.
        const failure = tenantWriteFailed(unknown ? 'unknown' : 'not_applied', refusalCause(refused) ?? refused);
        if (membershipRefused && !unknown) refusedMembership.add(failure);
        throw failure;
      } finally {
        releaseFlags();
        pending.delete(held);
        finish();
      }
    },
  });
  runtimes.add(runtime);
  return runtime;
}
