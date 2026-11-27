import { isPromise } from 'node:util/types';
import { inZone } from '../commands/currentZone.js';
import { appZone, readerZone, zoneColumn } from '../../shared/appZone.js';
import { TransactionOperations, TransactionOutcomeUnknown, type WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { CommandTransactionFailure, TrialRolledBack, type CommandJournal } from '../../adapters/commands/commandJournal.js';
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
import { composeTenantReadScope, footprintRows } from './tenantReadScope.js';
import { tenantAppAccess } from './tenantAccess.js';
import {
  advisoryRecords,
  captureTenantReadSource,
  readSharedProfile,
  tenantRealmFencingOf,
  type TenantReadSource,
} from './tenantReadSource.js';
import type { TenantValue } from '@mistriwork/engine/shared/queryOperands.js';
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
import { admitScopedInserts, apiScopeParents, narrowAuthoredRows, requestApiScope } from '../api/apiRowScope.js';
import { bindTenantFlagOwner } from './tenantFlagRuntime.js';
import type { ReadAuditRow } from '../../adapters/readAudit/readAudit.js';

/** Private host scope, never passed to a command handler. Its single transaction
 * owns actual completion; an executor must not nest a pretend transaction inside
 * a source callback and infer commit from callback success. */
export interface TenantRequestScope {
  readonly principal: TenantMembershipEvidence;
  readonly rows: RowScope;
  readonly grants: ResourceAccess;
  session(): Promise<void>;
  /** The account's email as the session check proved it (admission runs one before any callback): who
   * a `me` stamp writes and whose row of the people table it looks up (appStamps.ts). Never a request's word. */
  who(): string;
  /** `operation` names which of the host's operations ran, for a writer kind
   * that records one: Undo passes 'undo' because `undo()` is what called. It is
   * never taken from a request, so it states what happened rather than what a
   * caller claims. Absent, an ordinary write. */
  transaction<T>(run: (records: WriteTransaction) => T | Promise<T>, operation?: TenantWriteOperation): Promise<T>;
  /** `write` is the command's written resources: an API-scoped insert under a path is proven against its parent's rows,
   * which the command need not read itself (apiRowScope.ts) — the same footprint a single App's policy path uses. */
  commandTransaction<T>(
    run: (records: WriteTransaction, journal: CommandJournal) => T | Promise<T>,
    read: readonly string[],
    write?: readonly string[],
  ): Promise<T>;
  /** A command's questions without its transaction: one read snapshot under
   * the same footprint and row scope, whose records refuse every write. Advice
   * only — which commands a record offers — that the command asks again in its
   * own transaction when it runs; it takes no writer, so it queues behind none.
   * Like a transaction, it is this request's one. */
  advisoryReads<T>(
    run: (records: WriteTransaction) => T | Promise<T>,
    read: readonly string[],
    options?: { readonly lastWave?: boolean },
  ): Promise<T>;
  /** The tenant's own scoped reads, outside any transaction: what a command's lookup reads through. */
  reads(): ReturnType<TenantReadSource['bindReads']>;
  /** Run concurrent pre-transaction reads on one shared read snapshot (`TenantReadSource.together`). */
  together<R>(work: () => Promise<R>): Promise<R>;
  /** A command's read of an audited resource, written through the writer outside any transaction (tenantReadAudit.ts). */
  appendReadAudit(row: ReadAuditRow): Promise<void>;
  /** The tenant's shared profile columns (`auth.tenancy.shared`), read once for this request before its row scope:
   * what a handler's `tenant`, `tenant.<column>` and the person's zone read. Empty where the App shares none. */
  readonly tenant: Readonly<Record<string, TenantValue>>;
  /** Which of these accounts is an active member of this request's tenant, in a role the deployment knows: what a
   * command's `field.member()` input is judged by (commandMembers.ts). Read from the tenant store, outside any
   * transaction, one membership at a time; nothing about any of them is told but whether it is one. */
  members(accountIds: readonly string[]): Promise<ReadonlySet<string>>;
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
      let verifiedWho: string | undefined;
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
          verifiedWho = identity.who;
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
        // A row-scoped token (api.scopes) narrows the authored rows to its key and admits only inserts inside it.
        const apiScope = requestApiScope(app.api, request, denyTenant);
        let rows!: RowScope,
          grants!: ResourceAccess,
          profile!: Readonly<Record<string, TenantValue>>,
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
              profile = await readSharedProfile(reader, app, principal.tenantId);
              active();
              /* The policy is the App's own code, and counts its day in this tenant's zone (`currentZone()`): the profile's
                 `tenant.<column>` where `ui.timezone` names one, else the App's. A zone in a row its scope reads comes later. */
              const named = zoneColumn(app.ui);
              const zone = (named?.resource === 'tenant' ? readerZone(profile[named.column]) : undefined) ?? appZone(app.ui);
              const authored = delivered(inZone(zone, () => authoredRows(acting, Object.freeze({ tenant: profile })))),
                policy = isPromise(authored) ? await authored : authored;
              active();
              rows = composeTenantReadScope(
                ownership,
                principal,
                member,
                apiScope ? narrowAuthoredRows(ownership.schema, policy, apiScope) : policy,
              );
              const resolvedGrants = tenantAppAccess(app, ownership.schema, acting.roles);
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
           of it. Pre-transaction reads that completed before a committing write
           transaction began are strictly ordered before that transaction's
           FOR SHARE fence and COMMIT, so the committed transaction proves the
           membership continuously across both. */
          let outside = false,
            outsideRunning = 0,
            advisoryFenced = false;
          const trackOutside = <R>(work: () => Promise<R>): Promise<R> => {
            outside = true;
            advisoryFenced = false;
            outsideRunning++;
            return Promise.resolve()
              .then(work)
              .finally(() => {
                outsideRunning--;
              });
          };
          const wrapReads = (
            reads: Awaited<ReturnType<TenantReadSource['bindReads']>>,
          ): Awaited<ReturnType<TenantReadSource['bindReads']>> =>
            Object.freeze<Awaited<ReturnType<TenantReadSource['bindReads']>>>({
              query: (input) => trackOutside(() => reads.query(input)),
              count: (table, filter, limit) => trackOutside(() => reads.count(table, filter, limit)),
              runView: (view, offset) => trackOutside(() => reads.runView(view, offset)),
              countView: (view, limit) => trackOutside(() => reads.countView(view, limit)),
              runBreakdown: (def, offset) => trackOutside(() => reads.runBreakdown(def, offset)),
              countBreakdown: (def, limit) => trackOutside(() => reads.countBreakdown(def, limit)),
              ...(reads.aggregate ? { aggregate: (req) => trackOutside(() => reads.aggregate!(req)) } : {}),
              ...(reads.cte ? { cte: (req) => trackOutside(() => reads.cte!(req)) } : {}),
            });
          releaseFlags = bindTenantFlagOwner(
            request,
            admitted,
            async () => {
              await trackOutside(async () => {
                await session();
                await reader.assertCurrent(admitted);
                active();
              });
            },
            active,
          );
          let callbackFailure: { error: unknown } | undefined;
          const transaction = <R>(
            command: boolean,
            run: (records: WriteTransaction, journal?: CommandJournal) => R | Promise<R>,
            ceiling?: readonly string[],
            operation?: TenantWriteOperation,
            written?: readonly string[],
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
                // A scoped insert under a path is proven against its parent's rows (apiRowScope.ts), still inside this scope.
                const parents = apiScope ? apiScopeParents(apiScope.scope, ownership.schema, captureTenantData(written ?? [])) : undefined;
                // A table the footprint's row policies read through (`via`) keeps its rule (tenantReadScope.ts footprintRows).
                sourceRows = footprintRows(rows, (table) => read.includes(table) || !!parents?.has(table));
              } catch {
                invalid = true;
              }
            }
            /* A trial's rollback is its answer, not a failed write: it settles the queued operation instead of
               rejecting it, so the request's operations are not poisoned and finish() does not rethrow it, and is
               rethrown here, outside the queue, for the executor to catch. */
            let trialEnded: CommandTransactionFailure | undefined;
            return operations
              .run(async () => {
                if (invalid || callbackFailure) return denyTenant();
                let workFailure: { error: unknown } | undefined;
                const work = async (records: WriteTransaction, journal?: CommandJournal) => {
                  // The writer's fence passed: the membership is held from here to COMMIT or ROLLBACK.
                  fenced = true;
                  await session();
                  try {
                    const result = await run(
                      apiScope ? admitScopedInserts(records, apiScope.scope, apiScope.key, ownership.schema) : records,
                      journal,
                    );
                    await session();
                    return result;
                  } catch (error) {
                    workFailure = { error };
                    throw error;
                  }
                };
                try {
                  // Any outside observation that already settled before this transaction begins is strictly
                  // ordered before its FOR SHARE membership fence and COMMIT; observations started during or
                  // after (or still in flight now) keep `outside = true` and require the post-commit fence.
                  if (outsideRunning === 0) outside = false;
                  const result = command
                    ? await writer.commandTransaction(admitted, sourceRows, work, active, operation, ceiling)
                    : await writer.transaction(admitted, rows, (records) => work(records), active, operation);
                  committed = true;
                  return result;
                } catch (error) {
                  // Actual outer source completion, not callback return, classifies
                  // this wrapper. Preserve the private domain cause for the existing
                  // executor while keeping the source's confirmed/unknown outcome.
                  if (command) {
                    const outcome = error instanceof TenantWriteFailure ? error.outcome : 'unknown';
                    const failure = new CommandTransactionFailure(workFailure?.error ?? error, outcome);
                    if (outcome === 'not_applied' && workFailure?.error instanceof TrialRolledBack) {
                      trialEnded = failure;
                      return undefined as R;
                    }
                    throw failure;
                  }
                  throw error;
                }
              })
              .then((result) => {
                if (trialEnded) throw trialEnded;
                return result;
              });
          };
          const advisoryReads = <R>(
            run: (records: WriteTransaction) => R | Promise<R>,
            ceiling: readonly string[],
            advisoryOptions?: { readonly lastWave?: boolean },
          ): Promise<R> => {
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
                footprint = footprintRows(rows, (table) => read.includes(table));
              }
            } catch {
              footprint = undefined;
            }
            const fencing = tenantRealmFencingOf(reader);
            return operations.run(async () => {
              if (invalid || !footprint || callbackFailure) return denyTenant();
              await session();
              const hadOutside = outside || outsideRunning > 0;
              outside = true;
              let result: R;
              if (fencing) {
                const ran = await fencing.withReadsFenced(admitted, footprint, (reads) => run(advisoryRecords(reads)), advisoryOptions);
                result = ran.value;
                if (ran.fenced && !hadOutside && outsideRunning === 0) advisoryFenced = true;
              } else {
                result = await reader.withReads(admitted, footprint, (reads) => run(advisoryRecords(reads)));
              }
              active();
              await session();
              return result;
            });
          };
          let scoped: ReturnType<TenantReadSource['bindReads']> | undefined;
          const scope = Object.freeze<TenantRequestScope>({
            principal: admitted,
            rows,
            grants,
            session,
            who: () => verifiedWho ?? denyTenant(),
            advisoryReads,
            transaction: (run, operation) => transaction(false, run, undefined, operation),
            commandTransaction: (run, read, write) =>
              transaction(true, (records, journal) => run(records, journal!), read, undefined, write),
            reads: () => {
              active();
              return (scoped ??= reader.bindReads(admitted, rows).then(wrapReads));
            },
            together: <R>(work: () => Promise<R>): Promise<R> => {
              active();
              return reader.together(admitted, work);
            },
            appendReadAudit: (row) => {
              active();
              return writer.appendReadAudit(row);
            },
            tenant: profile,
            members: async (accountIds) => {
              active();
              return trackOutside(async () => {
                const known = new Set(raw.roles as readonly string[]);
                const found = new Set<string>();
                for (const accountId of new Set(accountIds)) {
                  if (typeof accountId !== 'string' || !accountId || accountId.length > 1024 || accountId !== accountId.trim()) continue;
                  const row = await reader.readMembership({
                    appId: admitted.appId,
                    accountId,
                    tenantId: admitted.tenantId,
                    source: admitted.source,
                    deployment: admitted.deployment,
                  });
                  active();
                  /* Active, in an active tenant, not past its term, holding a role this deployment still grants: the
                     membership admission would admit, never an invitation, a revoked one or another tenant's. */
                  if (
                    row?.accountId === accountId &&
                    row.tenantId === admitted.tenantId &&
                    row.status === 'active' &&
                    row.tenantStatus === 'active' &&
                    row.validUntil > now() &&
                    row.roles.some((role) => known.has(role))
                  )
                    found.add(accountId);
                }
                return found;
              });
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
          let fencedAfter: boolean = !failure && advisoryFenced && !committed;
          if (failure ? !fenced && !committed : !(committed && !outside) && !advisoryFenced) {
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
