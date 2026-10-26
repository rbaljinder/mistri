/** Bridge existing, genuine target-App sessions to Console DTOs. Every call
 * enters the deployment's request lifetime; no FlagControlSession escapes it. */
import { TransactionOutcomeUnknown } from '@mistriwork/engine/adapters/adapter.js';
import type { IncomingMessage } from 'node:http';
import { captureAppAuthRuntime, type AppAuthRuntime } from '../auth/auth.js';
import { FlagAccountChanged, FlagSignInRequired, type FlagDeploymentTarget, type FlagControlSession } from '../flags/deployment.js';
import { FlagManagementDenied } from '../flags/store.js';
import {
  consoleRecord,
  consoleProof,
  type ConsoleProof,
  type ConsoleTargetService,
  type ConsoleRows,
  type ConsoleResource,
} from './controlSource.js';
import type { ExperimentResult } from '../experiments/contracts.js';
import type { ExperimentDecisionRequest } from '../experiments/decisions.js';
import type { FlagCatalog, FlagValue, FlagOverride } from '../../shared/appFlags.js';

export interface ConsoleTargetOwner {
  readonly target: FlagDeploymentTarget;
  readonly auth: AppAuthRuntime;
  readonly name: string;
  readonly tenantApp: boolean;
  /** Optional immutable declaration projection; defaults to target.readPort's
   * captured authored catalog. Only
   * authorized IDs/type/variants are projected; defaults/owners never ride
   * along merely because someone may manage or kill a flag. */
  readonly flags?: Readonly<
    Record<string, { readonly type: 'boolean' | 'string' | 'number' | 'object'; readonly variants?: readonly FlagValue[] }>
  >;
  readonly tenantScopes?: (request: IncomingMessage, accountId: string) => Promise<readonly { tenantId: string; label: string }[]>;
  /** Separate experiment owner; requires experiments.view and returns its
   * current proof together with aggregate evidence only. */
  readonly results?: (
    request: IncomingMessage,
    accountId: string,
    tenantId: string | null,
    flagId: string,
  ) => Promise<{ readonly proof: ConsoleProof; readonly value: ConsoleRows['results'] }>;
  /** Structured AN2 owner. Proof covers independent experiment view authority;
   * decisions are reauthorized by the target manager under its commit fence. */
  readonly experiment?: (
    request: IncomingMessage,
    accountId: string,
    tenantId: string | null,
    flagId: string,
  ) => Promise<{ readonly proof: ConsoleProof; readonly result: ExperimentResult; readonly canDecide: boolean }>;
  readonly experimentFlags?: readonly string[];
  readonly lifecycle?: (
    request: IncomingMessage,
    accountId: string,
    tenantId: string | null,
    flagId: string,
    input: { operation: 'activate' | 'pause' | 'resume'; expectedRevision: number; reason: string },
    beforeCommit: () => Promise<void>,
  ) => Promise<unknown>;
  readonly decide?: (
    request: IncomingMessage,
    accountId: string,
    tenantId: string | null,
    flagId: string,
    input: Omit<ExperimentDecisionRequest, 'tenantId' | 'flagId'>,
    beforeCommit: () => Promise<void>,
  ) => Promise<unknown>;
  /** Tenant/platform membership owner, not Console, supplies this scope lease.
   * Its synchronous fence must detect membership/version/realm changes while
   * another target or Console's native observation is awaiting. Null denies.
   * FlagControlSession currently has no equivalent exported scope proof. */
  readonly scopeProof?: (request: IncomingMessage, accountId: string, tenantId: string | null) => Promise<ConsoleProof | null>;
}
/** Optional composition bridge. The default session.change now accepts the
 * Console guard at management's locked pre-commit fence. A supplied bridge
 * must preserve that same contract, never just run the guard before change. */
export type ConsoleGuardedChange = (
  session: FlagControlSession,
  input: Parameters<FlagControlSession['change']>[0],
  beforeCommit: () => Promise<void>,
) => ReturnType<FlagControlSession['change']>;

export interface ConsoleControlService extends ConsoleTargetService {
  discover(): Promise<
    readonly {
      flagId: string;
      revision: number;
      actions: readonly ('view' | 'manage' | 'kill')[];
      owner?: string;
      disabled?: boolean;
      rollout?: number;
      type?: string;
      kind?: 'boolean' | 'variant' | 'experiment';
      changedAt?: string;
      expiry?: string;
    }[]
  >;
  detail(flagId: string): Promise<{
    flagId: string;
    revision: number;
    actions: readonly ('view' | 'manage' | 'kill')[];
    type?: 'boolean' | 'string' | 'number' | 'object';
    variants?: readonly FlagValue[];
    value?: FlagValue;
    disabled?: boolean;
    owner?: string;
    resultsAvailable: boolean;
    control?: Omit<FlagOverride, 'experiment'> | null;
    experimentAllocated?: boolean;
    audiences?: FlagCatalog['audiences'];
    scope: 'global' | 'tenant';
    lifecycleAvailable: boolean;
  }>;
  historyPage(flagId: string, beforeRevision?: number): ReturnType<FlagControlSession['history']>;
  result(flagId: string): Promise<unknown>;
  lifecycle(flagId: string, input: unknown): Promise<unknown>;
  decide(flagId: string, input: unknown): Promise<unknown>;
}

export async function bindConsoleTarget(options: {
  owner: ConsoleTargetOwner;
  request: IncomingMessage;
  accountId: string;
  /** Genuine Console projection's native session handle identity. */
  sessionId: string;
  tenantId: string | null;
  consoleProof: ConsoleProof;
  guardedChange?: ConsoleGuardedChange;
  /** Held by the HTTP response owner and reobserved before releasing bytes. */
  retain: (proof: ConsoleProof) => void;
}): Promise<ConsoleControlService | null> {
  const { owner, request, accountId, tenantId, consoleProof: shell, retain, guardedChange } = options;
  const target = owner.target,
    auth = captureAppAuthRuntime(owner.auth);
  // The deployment exposes immutable authored declarations for evaluation.
  // Use only that catalog here; never call its raw snapshot read operation.
  const declarations = owner.flags ?? target.readPort.catalog.flags;
  if (auth.appId !== target.appId) throw new FlagManagementDenied();
  shell.assertCurrent();
  const native = await auth.sessionInstance(request);
  shell.assertCurrent();
  if (!native) return null;
  if (native.identity.id !== accountId || native.sessionId !== options.sessionId) throw new FlagAccountChanged();
  if (owner.tenantApp && !owner.scopeProof) throw new FlagManagementDenied();
  const observed = owner.tenantApp ? await owner.scopeProof!(request, accountId, tenantId) : undefined;
  if (owner.tenantApp && !observed) return null;
  const membership = observed ? consoleProof(observed) : undefined;
  if (!owner.tenantApp && tenantId !== null) return null;
  const current = () => {
    shell.assertCurrent();
    auth.assertCurrent();
    auth.assertSessionCurrent(native);
    membership?.assertCurrent();
  };
  if (membership) retain(membership);
  const run = <T>(work: (session: FlagControlSession) => Promise<T>) => target.withRequest(request, accountId, current, work);
  const proof = (observe: () => Promise<void>): ConsoleProof => ({
    assertCurrent: current,
    async reobserve() {
      current();
      await shell.reobserve();
      await membership?.reobserve();
      await observe();
      current();
    },
  });
  const expect = async (flagId: string, action: 'view' | 'manage' | 'kill') =>
    run(async (session) => {
      const value = await session.capabilities({ tenantId, flagId });
      if (!value.actions.includes(action)) throw new FlagManagementDenied();
    });
  const unavailable = (error: unknown) => error instanceof FlagManagementDenied || error instanceof FlagSignInRequired;
  const capabilities = async (flagId: string, keep = true) => {
    const value = await run((session) => session.capabilities({ tenantId, flagId }));
    const observe = async () => {
      const fresh = await run((session) => session.capabilities({ tenantId, flagId }));
      if (value.actions.some((action) => !fresh.actions.includes(action))) throw new FlagManagementDenied();
    };
    if (keep) retain(proof(observe));
    return value;
  };
  const discover = async (keep = true) => {
    const ids = Object.keys(declarations).sort();
    if (ids.length > 1000) throw new FlagManagementDenied();
    const rows = [];
    for (const flagId of ids) {
      try {
        const value = await capabilities(flagId, keep);
        const row = keep && value.actions.includes('view') ? await run((session) => session.get({ tenantId, flagId })) : undefined;
        // The list's own facts: what kind of flag it is and when it last changed (never by whom: the history
        // carries an account id, not a name; nor an experiment's weights, which no Console read carries).
        const last = row ? (await run((session) => session.history({ tenantId, flagId, limit: 1 }))).entries[0] : undefined;
        rows.push({
          flagId,
          revision: row?.revision ?? value.revision,
          actions: value.actions,
          ...(row
            ? {
                owner: row.definition.owner,
                disabled: row.control?.disabled ?? false,
                rollout: row.control?.rollout ?? 100,
                type: row.definition.type,
                kind: row.control?.experimentAllocated
                  ? ('experiment' as const)
                  : row.definition.type === 'boolean'
                    ? ('boolean' as const)
                    : ('variant' as const),
                ...(last ? { changedAt: last.at } : {}),
                ...(row.definition.expiry ? { expiry: row.definition.expiry } : {}),
              }
            : {}),
        });
      } catch (error) {
        if (!unavailable(error)) throw error;
        current();
      }
    }
    return rows;
  };
  return Object.freeze<ConsoleControlService>({
    appId: target.appId,
    environment: target.environment,
    tenantId,
    name: owner.name,
    discover,
    async detail(flagId) {
      const capability = await capabilities(flagId),
        declaration = declarations?.[flagId];
      const row = capability.actions.includes('view') ? await run((session) => session.editor({ tenantId, flagId })) : undefined;
      const editable = capability.actions.includes('manage');
      const type = row || editable ? (declaration?.type ?? row?.definition.type) : undefined;
      const variants = row || editable ? (declaration?.variants ?? row?.definition.variants) : undefined;
      return {
        flagId,
        revision: row?.revision ?? capability.revision,
        actions: capability.actions,
        ...(type ? { type } : {}),
        ...(variants ? { variants } : {}),
        ...(row
          ? {
              value: row.control?.value ?? row.definition.default,
              // What everyone outside a rule and the rollout gets, and what a kill serves: the sheet's Serving sentence says both.
              defaultValue: row.definition.default,
              ...(row.definition.safeValue === undefined ? {} : { safeValue: row.definition.safeValue }),
              disabled: row.control?.disabled ?? false,
              owner: row.definition.owner,
              control: row.control,
              experimentAllocated: row.control?.experimentAllocated ?? false,
              audiences: row.audiences,
            }
          : {}),
        scope: tenantId === null ? 'global' : 'tenant',
        lifecycleAvailable: Boolean(owner.lifecycle && owner.experimentFlags?.includes(flagId)),
        resultsAvailable:
          Boolean(owner.results || owner.experiment) && (owner.experimentFlags === undefined || owner.experimentFlags.includes(flagId)),
      };
    },
    async historyPage(flagId, beforeRevision) {
      await expect(flagId, 'view');
      retain(proof(() => expect(flagId, 'view')));
      return run((session) =>
        session.history({ tenantId, flagId, limit: 25, ...(beforeRevision === undefined ? {} : { beforeRevision }) }),
      );
    },
    async lifecycle(flagId, input) {
      if (!owner.lifecycle || !owner.experimentFlags?.includes(flagId)) throw new FlagManagementDenied();
      const raw = consoleRecord(input, ['operation', 'expectedRevision', 'reason']);
      if (
        !['activate', 'pause', 'resume'].includes(raw.operation as string) ||
        !Number.isSafeInteger(raw.expectedRevision) ||
        (raw.expectedRevision as number) < 0 ||
        typeof raw.reason !== 'string' ||
        !raw.reason.trim() ||
        raw.reason.length > 1024
      )
        throw new FlagManagementDenied();
      const action = raw.operation === 'pause' ? 'kill' : 'manage';
      await expect(flagId, action);
      const fence = async () => {
        await expect(flagId, action);
        await shell.reobserve();
        current();
      };
      const result = await owner.lifecycle(
        request,
        accountId,
        tenantId,
        flagId,
        raw as { operation: 'activate' | 'pause' | 'resume'; expectedRevision: number; reason: string },
        fence,
      );
      try {
        await fence();
      } catch (error) {
        throw new TransactionOutcomeUnknown(error);
      }
      return result;
    },
    async decide(flagId, input) {
      if (!owner.experiment || !owner.decide) throw new FlagManagementDenied();
      const raw = consoleRecord(input, ['epochFingerprint', 'expectedRevision', 'expectedResultRevision', 'winnerVariant', 'reason']);
      const value = await owner.experiment(request, accountId, tenantId, flagId),
        authorized = consoleProof(value.proof);
      if (!value.canDecide) throw new FlagManagementDenied();
      const fence = async () => {
        await authorized.reobserve();
        await shell.reobserve();
        authorized.assertCurrent();
        current();
      };
      await fence();
      retain(authorized);
      const result = await owner.decide(
        request,
        accountId,
        tenantId,
        flagId,
        raw as unknown as Omit<ExperimentDecisionRequest, 'tenantId' | 'flagId'>,
        fence,
      );
      try {
        await fence();
      } catch (error) {
        throw new TransactionOutcomeUnknown(error);
      }
      return result;
    },
    async result(flagId) {
      if (owner.experiment) {
        current();
        await shell.reobserve();
        const value = await owner.experiment(request, accountId, tenantId, flagId),
          authorized = consoleProof(value.proof);
        await authorized.reobserve();
        authorized.assertCurrent();
        current();
        retain(authorized);
        if (
          value.result.declaration.flagId !== flagId ||
          value.result.declaration.scope.appId !== target.appId ||
          value.result.declaration.scope.environment !== target.environment ||
          value.result.declaration.scope.controlTenantId !== tenantId
        )
          throw new FlagManagementDenied();
        return { result: value.result, canDecide: value.canDecide && Boolean(owner.decide) };
      }
      if (!owner.results) throw new FlagManagementDenied();
      current();
      await shell.reobserve();
      const result = await owner.results(request, accountId, tenantId, flagId),
        authorized = consoleProof(result.proof);
      await authorized.reobserve();
      authorized.assertCurrent();
      current();
      retain(authorized);
      const row = result.value;
      if (row.flagId !== flagId) throw new FlagManagementDenied();
      return {
        flagId,
        revision: row.revision,
        epoch: row.epoch,
        method: row.method,
        mature: row.mature,
        immature: row.immature,
        completeness: row.completeness,
        evidence: row.evidence,
      };
    },
    async viewable() {
      // Legacy adapter method name: discovery now includes authorized control
      // actions. This proof never grants flags.view or exposes their values.
      const observe = async () => {
        if (!(await discover(false)).length) throw new FlagManagementDenied();
      };
      try {
        await observe();
      } catch (error) {
        if (unavailable(error)) return null;
        throw error;
      }
      const value = proof(observe);
      retain(value);
      return value;
    },
    async authorize(flagId, operation) {
      // Deployment has no experiment-view/results method yet. Never borrow
      // flags.view for results or expose experiment definitions as evidence.
      if (operation === 'experiment-view') return null;
      const action = operation === 'view' ? 'view' : operation === 'kill' ? 'kill' : 'manage';
      try {
        await expect(flagId, action);
      } catch (error) {
        if (unavailable(error)) return null;
        throw error;
      }
      const value = proof(() => expect(flagId, action));
      retain(value);
      return value;
    },
    async read<R extends ConsoleResource>(resource: R, input: { readonly flagId?: string; readonly limit: number }) {
      if (resource === 'results') throw new FlagManagementDenied();
      return run(async (session) => {
        const rows: (ConsoleRows['flags'] | ConsoleRows['history'])[] = [];
        if (resource === 'flags') {
          const append = (row: Awaited<ReturnType<FlagControlSession['get']>>) =>
            rows.push({
              flagId: row.flagId,
              owner: row.definition.owner,
              revision: row.revision,
              value: row.control?.value ?? row.definition.default,
              disabled: row.control?.disabled ?? false,
            });
          if (input.flagId) append(await session.get({ tenantId, flagId: input.flagId }));
          else {
            let after: string | undefined;
            do {
              const page = await session.list({ tenantId, limit: Math.min(100, input.limit - rows.length), ...(after ? { after } : {}) });
              page.items.forEach(append);
              if (!page.nextAfter) break;
              if (!page.items.length) throw new FlagManagementDenied();
              if (rows.length >= input.limit) return { rows: rows as ConsoleRows[R][], complete: false };
              if (after !== undefined && page.nextAfter <= after) throw new FlagManagementDenied();
              after = page.nextAfter;
            } while (rows.length < input.limit);
          }
        } else {
          if (!input.flagId) throw new FlagManagementDenied();
          let beforeRevision: number | undefined;
          do {
            const page = await session.history({
              tenantId,
              flagId: input.flagId,
              limit: Math.min(100, input.limit - rows.length),
              ...(beforeRevision === undefined ? {} : { beforeRevision }),
            });
            // Redacted per-flag controls only; no actor or scope snapshots.
            const control = (value: (typeof page.entries)[number]['before']) =>
              value === null
                ? null
                : {
                    ...(value.value === undefined ? {} : { value: value.value }),
                    ...(value.disabled === undefined ? {} : { disabled: value.disabled }),
                    ...(value.rollout === undefined ? {} : { rollout: value.rollout }),
                  };
            for (const row of page.entries)
              rows.push({
                flagId: row.flagId,
                revision: row.revision,
                operation: row.operation,
                reason: row.reason,
                at: row.at,
                before: control(row.before),
                after: control(row.after),
              });
            if (page.nextBeforeRevision === null) break;
            if (!page.entries.length) throw new FlagManagementDenied();
            if (rows.length >= input.limit) return { rows: rows as ConsoleRows[R][], complete: false };
            if (beforeRevision !== undefined && page.nextBeforeRevision >= beforeRevision) throw new FlagManagementDenied();
            beforeRevision = page.nextBeforeRevision;
          } while (rows.length < input.limit);
        }
        return { rows: rows as ConsoleRows[R][], complete: true };
      });
    },
    async change(input, beforeCommit) {
      if (input.tenantId !== tenantId) throw new FlagManagementDenied();
      return run((session) => (guardedChange ? guardedChange(session, input, beforeCommit) : session.change(input, beforeCommit)));
    },
  });
}
