/**
 * Domain data-integrity checkers for Mistri Jepsen workloads:
 *  - Bank conservation + command idempotency + receipt recovery + event outbox
 *  - Multi-host durable workflow epoch fencing + at-most-once step side effects
 */
import type { HistoryOp } from './history.js';

export interface BankTransferValue {
  readonly idempotencyKey: string;
  readonly from: number;
  readonly to: number;
  readonly amount: number;
  readonly node?: string;
  readonly receiptId?: string;
  readonly replayed?: boolean;
  readonly recovered?: boolean;
  readonly fromBalance?: number;
  readonly toBalance?: number;
  readonly outcome?: 'applied' | 'not_applied' | 'unknown';
}

export interface BankReadValue {
  readonly balances: Readonly<Record<string, number>>;
  readonly total: number;
  readonly node?: string;
}

export interface BankFinalState {
  readonly initialBalances: Readonly<Record<string, number>>;
  readonly finalBalances: Readonly<Record<string, number>>;
  readonly ledgerEntries: readonly {
    readonly idempotencyKey: string;
    readonly from: number;
    readonly to: number;
    readonly amount: number;
  }[];
  readonly receiptKeys: readonly string[];
  readonly eventKeys: readonly string[];
}

export interface InvariantViolation {
  readonly code: string;
  readonly detail: string;
}

export interface BankCheckResult {
  readonly valid: boolean;
  readonly summary: {
    readonly expectedTotal: number;
    readonly finalTotal: number;
    readonly readsChecked: number;
    readonly uniqueKeysAttempted: number;
    readonly appliedKeys: number;
    readonly okOps: number;
    readonly failOps: number;
    readonly infoOps: number;
    readonly replayedOps: number;
    readonly recoveredOps: number;
  };
  readonly violations: readonly InvariantViolation[];
}

/** Verify conservation, non-negativity, exact idempotency, receipt agreement, and 1:1 outbox delivery. */
export function checkBankConservation(history: readonly HistoryOp[], finalState: BankFinalState): BankCheckResult {
  const violations: InvariantViolation[] = [];
  const expectedTotal = Object.values(finalState.initialBalances).reduce((a, b) => a + b, 0);
  const finalTotal = Object.values(finalState.finalBalances).reduce((a, b) => a + b, 0);

  if (finalTotal !== expectedTotal) {
    violations.push({
      code: 'conservation_mismatch',
      detail: `final total ${finalTotal} !== expected total ${expectedTotal}`,
    });
  }
  for (const [id, bal] of Object.entries(finalState.finalBalances)) {
    if (bal < 0) {
      violations.push({ code: 'negative_balance', detail: `account ${id} ended with negative balance ${bal}` });
    }
  }

  // 1. Every intermediate read snapshot must conserve total balance and have no negative accounts.
  let readsChecked = 0;
  for (const op of history) {
    if (op.f !== 'read' || op.type !== 'ok') continue;
    readsChecked++;
    const val = op.value as BankReadValue;
    const sum = Object.values(val.balances).reduce((a, b) => a + b, 0);
    if (sum !== expectedTotal) {
      violations.push({
        code: 'read_conservation_mismatch',
        detail: `op #${op.index} read total ${sum} !== expected ${expectedTotal} (${JSON.stringify(val.balances)})`,
      });
    }
    for (const [id, bal] of Object.entries(val.balances)) {
      if (bal < 0) {
        violations.push({ code: 'read_negative_balance', detail: `op #${op.index} read negative balance ${bal} on account ${id}` });
      }
    }
  }

  // 2. Check ledger uniqueness, balance recomputation, receipt set, and event outbox 1:1 correspondence.
  const ledgerByKey = new Map<string, (typeof finalState.ledgerEntries)[number]>();
  for (const row of finalState.ledgerEntries) {
    if (ledgerByKey.has(row.idempotencyKey)) {
      violations.push({
        code: 'duplicate_ledger_effect',
        detail: `idempotencyKey "${row.idempotencyKey}" applied more than once in ledger`,
      });
    }
    ledgerByKey.set(row.idempotencyKey, row);
  }

  // Recompute expected final balances by replaying the ledger from initialBalances.
  const recomputed: Record<string, number> = { ...finalState.initialBalances };
  for (const row of finalState.ledgerEntries) {
    recomputed[String(row.from)] = (recomputed[String(row.from)] ?? 0) - row.amount;
    recomputed[String(row.to)] = (recomputed[String(row.to)] ?? 0) + row.amount;
  }
  for (const [id, expectedBal] of Object.entries(recomputed)) {
    const actualBal = finalState.finalBalances[id];
    if (actualBal !== expectedBal) {
      violations.push({
        code: 'ledger_balance_divergence',
        detail: `account ${id} balance is ${actualBal}, but initial + ledger recomputes ${expectedBal}`,
      });
    }
  }

  const receiptSet = new Set(finalState.receiptKeys);
  const eventSet = new Set(finalState.eventKeys);
  if (receiptSet.size !== finalState.receiptKeys.length) {
    violations.push({ code: 'duplicate_receipt', detail: 'command journal contains duplicate idempotency keys' });
  }
  if (eventSet.size !== finalState.eventKeys.length) {
    violations.push({ code: 'duplicate_event', detail: 'command event store contains duplicate events for one idempotency key' });
  }
  for (const key of ledgerByKey.keys()) {
    if (!receiptSet.has(key)) {
      violations.push({ code: 'missing_receipt', detail: `ledger applied "${key}" without a persisted command receipt` });
    }
    if (!eventSet.has(key)) {
      violations.push({ code: 'missing_event', detail: `ledger applied "${key}" without a persisted command event` });
    }
  }
  for (const key of receiptSet) {
    if (!ledgerByKey.has(key)) {
      violations.push({ code: 'orphan_receipt', detail: `command receipt "${key}" exists without a matching ledger entry` });
    }
  }
  for (const key of eventSet) {
    if (!ledgerByKey.has(key)) {
      violations.push({ code: 'phantom_event', detail: `command event "${key}" exists without a matching ledger entry` });
    }
  }

  // 3. Reconcile history outcomes (`:ok`, `:fail`, `:info`, retries & recovery) against committed ledger state.
  const keysAttempted = new Set<string>();
  const receiptByKey = new Map<string, string>();
  const outputByKey = new Map<string, { fromBalance?: number; toBalance?: number }>();
  let okOps = 0;
  let failOps = 0;
  let infoOps = 0;
  let replayedOps = 0;
  let recoveredOps = 0;

  for (const op of history) {
    if (op.f !== 'transfer' && op.f !== 'recover') continue;
    const val = op.value as BankTransferValue;
    if (!val?.idempotencyKey) continue;
    keysAttempted.add(val.idempotencyKey);

    if (op.type === 'ok') {
      okOps++;
      if (val.replayed) replayedOps++;
      if (val.recovered) recoveredOps++;
      if (!ledgerByKey.has(val.idempotencyKey)) {
        violations.push({
          code: 'acknowledged_write_lost',
          detail: `op #${op.index} (${op.f}) returned :ok for "${val.idempotencyKey}" but it is absent from final ledger`,
        });
      }
      if (val.receiptId) {
        const prev = receiptByKey.get(val.idempotencyKey);
        if (prev && prev !== val.receiptId) {
          violations.push({
            code: 'receipt_id_mismatch',
            detail: `idempotencyKey "${val.idempotencyKey}" returned conflicting receiptIds "${prev}" vs "${val.receiptId}"`,
          });
        }
        receiptByKey.set(val.idempotencyKey, val.receiptId);
      }
      if (val.fromBalance !== undefined || val.toBalance !== undefined) {
        const prevOut = outputByKey.get(val.idempotencyKey);
        if (prevOut && (prevOut.fromBalance !== val.fromBalance || prevOut.toBalance !== val.toBalance)) {
          violations.push({
            code: 'replay_output_mismatch',
            detail: `idempotencyKey "${val.idempotencyKey}" replayed different balances: ${JSON.stringify(prevOut)} vs ${JSON.stringify({ fromBalance: val.fromBalance, toBalance: val.toBalance })}`,
          });
        }
        outputByKey.set(val.idempotencyKey, { fromBalance: val.fromBalance, toBalance: val.toBalance });
      }
    } else if (op.type === 'fail') {
      failOps++;
      // A transfer whose every attempt claimed definitive `not_applied` (never `:ok` and never `:info`)
      // must NEVER appear in the committed ledger.
      if (op.f === 'transfer' && val.outcome === 'not_applied') {
        const hadOkOrInfo = history.some(
          (other) =>
            (other.type === 'ok' || other.type === 'info') &&
            (other.f === 'transfer' || other.f === 'recover') &&
            (other.value as BankTransferValue)?.idempotencyKey === val.idempotencyKey,
        );
        if (!hadOkOrInfo && ledgerByKey.has(val.idempotencyKey)) {
          violations.push({
            code: 'false_negative_not_applied',
            detail: `op #${op.index} claimed outcome='not_applied' for "${val.idempotencyKey}", yet the transfer committed with no :ok or :info attempt`,
          });
        }
      }
    } else if (op.type === 'info') {
      infoOps++;
    }
  }

  return {
    valid: violations.length === 0,
    summary: {
      expectedTotal,
      finalTotal,
      readsChecked,
      uniqueKeysAttempted: keysAttempted.size,
      appliedKeys: ledgerByKey.size,
      okOps,
      failOps,
      infoOps,
      replayedOps,
      recoveredOps,
    },
    violations,
  };
}

export interface WorkflowFencingInput {
  readonly expectedWorkflows: readonly string[];
  readonly expectedStepsPerWorkflow: readonly string[];
  readonly finalStatuses: Readonly<Record<string, string>>;
  /** Number of actual (non-deduplicated) side-effect executions recorded per `${workflowId}:${step}` key. */
  readonly sideEffectExecutions: Readonly<Record<string, number>>;
  readonly history: readonly HistoryOp[];
}

export interface WorkflowFencingResult {
  readonly valid: boolean;
  readonly summary: {
    readonly totalWorkflows: number;
    readonly completedWorkflows: number;
    readonly overtakenAdvances: number;
    readonly abortedAdvances: number;
    readonly totalSideEffects: number;
  };
  readonly violations: readonly InvariantViolation[];
}

/** Verify multi-host workflow fencing: convergence to completed, zero divergence, at-most-once side effects per step. */
export function checkWorkflowFencing(input: WorkflowFencingInput): WorkflowFencingResult {
  const violations: InvariantViolation[] = [];
  let completedWorkflows = 0;

  for (const wfId of input.expectedWorkflows) {
    const status = input.finalStatuses[wfId];
    if (status === 'completed') {
      completedWorkflows++;
    } else {
      violations.push({
        code: 'workflow_not_completed',
        detail: `workflow "${wfId}" ended in status "${status ?? 'missing'}" instead of "completed"`,
      });
    }
    for (const step of input.expectedStepsPerWorkflow) {
      const key = `${wfId}:${step}`;
      const count = input.sideEffectExecutions[key] ?? 0;
      if (count === 0) {
        violations.push({
          code: 'missing_step_effect',
          detail: `completed workflow "${wfId}" never executed side effect for step "${step}"`,
        });
      } else if (count > 1) {
        violations.push({
          code: 'duplicate_step_effect',
          detail: `step "${step}" of workflow "${wfId}" executed its side effect ${count} times (expected 1)`,
        });
      }
    }
  }

  // Any unexpected extra step keys with >1 execution also fail.
  for (const [key, count] of Object.entries(input.sideEffectExecutions)) {
    if (count > 1 && !violations.some((v) => v.detail.includes(key))) {
      violations.push({
        code: 'duplicate_step_effect',
        detail: `side-effect key "${key}" executed ${count} times`,
      });
    }
  }

  let overtakenAdvances = 0;
  let abortedAdvances = 0;
  for (const op of input.history) {
    if (op.f !== 'advance') continue;
    const status = (op.value as { status?: string } | undefined)?.status;
    if (status === 'overtaken') overtakenAdvances++;
    if (status === 'aborted') abortedAdvances++;
    if (status === 'diverged') {
      violations.push({
        code: 'workflow_diverged',
        detail: `op #${op.index} reported unexpected workflow divergence: ${JSON.stringify(op.value)}`,
      });
    }
  }

  return {
    valid: violations.length === 0,
    summary: {
      totalWorkflows: input.expectedWorkflows.length,
      completedWorkflows,
      overtakenAdvances,
      abortedAdvances,
      totalSideEffects: Object.values(input.sideEffectExecutions).reduce((a, b) => a + b, 0),
    },
    violations,
  };
}

export interface EventDeliveryCheckInput {
  /** Committed event keys (e.g. command idempotency keys) expected to be delivered. */
  readonly committedKeys: readonly string[];
  /** Every delivery attempt observed by the downstream consumer, including duplicates/retries. */
  readonly deliveries: readonly {
    readonly eventKey: string;
    readonly idempotencyKey: string;
    readonly publisher: string;
  }[];
  readonly history: readonly HistoryOp[];
}

export interface EventDeliveryCheckResult {
  readonly valid: boolean;
  readonly summary: {
    readonly committedCount: number;
    readonly uniqueDeliveredCount: number;
    readonly totalDeliveryAttempts: number;
    readonly deduplicatedRetries: number;
    readonly clockRegressionsInjected: number;
  };
  readonly violations: readonly InvariantViolation[];
}

/** Verify transactional outbox delivery: zero lost events, zero phantom events, stable idempotencyKey across retries/hosts. */
export function checkEventDelivery(input: EventDeliveryCheckInput): EventDeliveryCheckResult {
  const violations: InvariantViolation[] = [];
  const committedSet = new Set(input.committedKeys);
  const idempotencyKeyByEvent = new Map<string, string>();
  const deliveredByIdempotencyKey = new Map<string, string>();

  for (const delivery of input.deliveries) {
    if (!committedSet.has(delivery.eventKey)) {
      violations.push({
        code: 'phantom_event_delivered',
        detail: `downstream received event "${delivery.eventKey}" that was never committed`,
      });
    }
    const prevKey = idempotencyKeyByEvent.get(delivery.eventKey);
    if (prevKey && prevKey !== delivery.idempotencyKey) {
      violations.push({
        code: 'unstable_idempotency_key',
        detail: `event "${delivery.eventKey}" was delivered with conflicting idempotency keys "${prevKey}" vs "${delivery.idempotencyKey}"`,
      });
    }
    idempotencyKeyByEvent.set(delivery.eventKey, delivery.idempotencyKey);

    const prevEvent = deliveredByIdempotencyKey.get(delivery.idempotencyKey);
    if (prevEvent && prevEvent !== delivery.eventKey) {
      violations.push({
        code: 'idempotency_key_collision',
        detail: `idempotency key "${delivery.idempotencyKey}" collided across distinct events "${prevEvent}" and "${delivery.eventKey}"`,
      });
    }
    deliveredByIdempotencyKey.set(delivery.idempotencyKey, delivery.eventKey);
  }

  for (const expected of committedSet) {
    if (!idempotencyKeyByEvent.has(expected)) {
      violations.push({
        code: 'lost_event',
        detail: `committed event "${expected}" was never delivered to downstream consumer`,
      });
    }
  }

  let clockRegressionsInjected = 0;
  for (const op of input.history) {
    if (op.process === 'nemesis' && op.f === 'clock-regress') clockRegressionsInjected++;
  }

  const uniqueDeliveredCount = idempotencyKeyByEvent.size;
  return {
    valid: violations.length === 0,
    summary: {
      committedCount: committedSet.size,
      uniqueDeliveredCount,
      totalDeliveryAttempts: input.deliveries.length,
      deduplicatedRetries: Math.max(0, input.deliveries.length - uniqueDeliveredCount),
      clockRegressionsInjected,
    },
    violations,
  };
}

export interface ReplicaRywCheckInput {
  readonly history: readonly HistoryOp[];
  readonly replicaCheckouts: number;
  readonly fallbackReadsSucceeded: number;
}

export interface ReplicaRywCheckResult {
  readonly valid: boolean;
  readonly summary: {
    readonly writesCompleted: number;
    readonly rywReadsChecked: number;
    readonly lagTolerantReadsChecked: number;
    readonly replicaCheckouts: number;
    readonly fallbackReadsSucceeded: number;
  };
  readonly violations: readonly InvariantViolation[];
}

/** Verify Read-Your-Writes monotonicity across writes + lag-tolerant reads and graceful fallback during replica partitions. */
export function checkReplicaRyw(input: ReplicaRywCheckInput): ReplicaRywCheckResult {
  const violations: InvariantViolation[] = [];
  let writesCompleted = 0;
  let rywReadsChecked = 0;
  let lagTolerantReadsChecked = 0;

  for (const op of input.history) {
    if (op.f === 'write' && op.type === 'ok') {
      writesCompleted++;
    } else if (op.f === 'ryw-read' && op.type === 'ok') {
      rywReadsChecked++;
      const val = op.value as { expectedMin: number; observed: number; caller: string };
      if (val.observed < val.expectedMin) {
        violations.push({
          code: 'ryw_stale_read',
          detail: `op #${op.index} caller "${val.caller}" wrote >= ${val.expectedMin} but read stale value ${val.observed}`,
        });
      }
    } else if (op.f === 'lag-read' && op.type === 'ok') {
      lagTolerantReadsChecked++;
    } else if (op.f === 'replica-write-probe' && op.type === 'ok') {
      violations.push({
        code: 'replica_accepted_write',
        detail: `op #${op.index} write unexpectedly succeeded on a read-only replica session`,
      });
    }
  }

  if (writesCompleted === 0) {
    violations.push({ code: 'no_writes_completed', detail: 'no writes completed during replica workload' });
  }
  if (rywReadsChecked === 0) {
    violations.push({ code: 'no_ryw_reads', detail: 'no read-your-writes probes completed during replica workload' });
  }
  if (input.replicaCheckouts === 0) {
    violations.push({ code: 'replica_never_used', detail: 'replica pool had 0 checkouts; lag-tolerant reads never routed to replica' });
  }

  return {
    valid: violations.length === 0,
    summary: {
      writesCompleted,
      rywReadsChecked,
      lagTolerantReadsChecked,
      replicaCheckouts: input.replicaCheckouts,
      fallbackReadsSucceeded: input.fallbackReadsSucceeded,
    },
    violations,
  };
}

export interface TenantIsolationCheckInput {
  readonly tenants: readonly string[];
  readonly history: readonly HistoryOp[];
  /** Ground-truth rows in DB at end of run: every row's tenant column vs the tenant encoded in its payload. */
  readonly finalRows: readonly { readonly id: number; readonly tenant: string; readonly writerTenant: string; readonly seq: number }[];
}

export interface TenantIsolationCheckResult {
  readonly valid: boolean;
  readonly summary: {
    readonly tenantsTested: number;
    readonly scopedReadsChecked: number;
    readonly scopedWritesOk: number;
    readonly scopedWritesFail: number;
    readonly scopedWritesInfo: number;
    readonly finalRowCount: number;
  };
  readonly violations: readonly InvariantViolation[];
}

/** Verify zero cross-tenant reads/writes under tight pool contention, WriteAhead reuse, and post-COMMIT cuts. */
export function checkTenantIsolation(input: TenantIsolationCheckInput): TenantIsolationCheckResult {
  const violations: InvariantViolation[] = [];
  let scopedReadsChecked = 0;
  let scopedWritesOk = 0;
  let scopedWritesFail = 0;
  let scopedWritesInfo = 0;
  const rowsByKey = new Map<string, (typeof input.finalRows)[number]>();
  for (const row of input.finalRows) {
    if (row.tenant !== row.writerTenant) {
      violations.push({
        code: 'cross_tenant_write',
        detail: `row id=${row.id} belongs to tenant "${row.tenant}" but carries payload written by "${row.writerTenant}"`,
      });
    }
    rowsByKey.set(`${row.writerTenant}:${row.seq}`, row);
  }

  for (const op of input.history) {
    if (op.f === 'scoped-read' && op.type === 'ok') {
      scopedReadsChecked++;
      const val = op.value as { tenant: string; observedTenants: readonly string[]; rowCount: number };
      for (const seen of val.observedTenants) {
        if (seen !== val.tenant) {
          violations.push({
            code: 'cross_tenant_read',
            detail: `op #${op.index} tenant "${val.tenant}" observed row belonging to tenant "${seen}"`,
          });
        }
      }
    } else if (op.f === 'scoped-write') {
      const val = op.value as { tenant: string; seq: number; outcome?: 'applied' | 'not_applied' | 'unknown' };
      if (op.type === 'ok') {
        scopedWritesOk++;
        if (!rowsByKey.has(`${val.tenant}:${val.seq}`)) {
          violations.push({
            code: 'acknowledged_scoped_write_lost',
            detail: `op #${op.index} tenant "${val.tenant}" write seq=${val.seq} returned :ok but is missing from final DB`,
          });
        }
      } else if (op.type === 'fail') {
        scopedWritesFail++;
        if (val.outcome === 'not_applied' && rowsByKey.has(`${val.tenant}:${val.seq}`)) {
          violations.push({
            code: 'false_negative_scoped_write',
            detail: `op #${op.index} tenant "${val.tenant}" write seq=${val.seq} claimed not_applied but persisted in DB`,
          });
        }
      } else if (op.type === 'info') {
        scopedWritesInfo++;
      }
    }
  }

  return {
    valid: violations.length === 0,
    summary: {
      tenantsTested: input.tenants.length,
      scopedReadsChecked,
      scopedWritesOk,
      scopedWritesFail,
      scopedWritesInfo,
      finalRowCount: input.finalRows.length,
    },
    violations,
  };
}

export interface DdlEpochCheckInput {
  readonly history: readonly HistoryOp[];
  readonly finalRows: readonly { readonly id: number; readonly tenant: string; readonly amount: number }[];
  readonly ddlStepsExecuted: number;
}

export interface DdlEpochCheckResult {
  readonly valid: boolean;
  readonly summary: {
    readonly ddlStepsExecuted: number;
    readonly writesOk: number;
    readonly writesFail: number;
    readonly writesInfo: number;
    readonly finalRowCount: number;
  };
  readonly violations: readonly InvariantViolation[];
}

/** Verify online DDL mutations never allow invalid rows, cross-tenant leaks, or lost acknowledged writes. */
export function checkDdlEpoch(input: DdlEpochCheckInput): DdlEpochCheckResult {
  const violations: InvariantViolation[] = [];
  const rowById = new Map(input.finalRows.map((r) => [r.id, r]));

  for (const row of input.finalRows) {
    if (row.amount < 0) {
      violations.push({
        code: 'constraint_violated_during_ddl',
        detail: `row id=${row.id} has negative amount ${row.amount} despite CHECK constraint`,
      });
    }
  }

  let writesOk = 0;
  let writesFail = 0;
  let writesInfo = 0;

  for (const op of input.history) {
    if (op.f === 'ddl-write') {
      const val = op.value as { id: number; tenant: string; amount: number; outcome?: string };
      if (op.type === 'ok') {
        writesOk++;
        const stored = rowById.get(val.id);
        if (!stored) {
          violations.push({
            code: 'acknowledged_ddl_write_lost',
            detail: `op #${op.index} write id=${val.id} returned :ok during DDL churn but is missing from final table`,
          });
        } else if (stored.tenant !== val.tenant) {
          violations.push({
            code: 'cross_tenant_ddl_write',
            detail: `op #${op.index} write id=${val.id} belonged to "${val.tenant}" but stored tenant="${stored.tenant}"`,
          });
        }
      } else if (op.type === 'fail') {
        writesFail++;
        if (val.outcome === 'not_applied' && rowById.has(val.id)) {
          violations.push({
            code: 'false_negative_ddl_write',
            detail: `op #${op.index} write id=${val.id} returned not_applied but persisted in DB`,
          });
        }
      } else if (op.type === 'info') {
        writesInfo++;
      }
    }
  }

  if (input.ddlStepsExecuted === 0) {
    violations.push({ code: 'no_ddl_executed', detail: 'DDL nemesis executed 0 schema mutations' });
  }

  return {
    valid: violations.length === 0,
    summary: {
      ddlStepsExecuted: input.ddlStepsExecuted,
      writesOk,
      writesFail,
      writesInfo,
      finalRowCount: input.finalRows.length,
    },
    violations,
  };
}

export interface ValkeyCacheCheckInput {
  readonly history: readonly HistoryOp[];
  readonly partitionDegradedReads: number;
  readonly incrUnavailableErrors: number;
  readonly postHealFreshChecks: number;
}

export interface ValkeyCacheCheckResult {
  readonly valid: boolean;
  readonly summary: {
    readonly readsChecked: number;
    readonly writesCompleted: number;
    readonly partitionDegradedReads: number;
    readonly incrUnavailableErrors: number;
    readonly postHealFreshChecks: number;
  };
  readonly violations: readonly InvariantViolation[];
}

/** Verify zero cross-tenant Valkey cache bleed, fail-open reads / fail-closed incr during partitions, and post-heal freshness. */
export function checkValkeyCache(input: ValkeyCacheCheckInput): ValkeyCacheCheckResult {
  const violations: InvariantViolation[] = [];
  let readsChecked = 0;
  let writesCompleted = 0;

  for (const op of input.history) {
    if (op.f === 'cache-write' && op.type === 'ok') {
      writesCompleted++;
    } else if (op.f === 'cache-read' && op.type === 'ok') {
      readsChecked++;
      const val = op.value as {
        tenant: string;
        observedTenant: string;
        expectedMinVersion?: number;
        observedVersion?: number;
        postHeal?: boolean;
      };
      if (val.observedTenant !== val.tenant) {
        violations.push({
          code: 'cross_tenant_cache_bleed',
          detail: `op #${op.index} tenant "${val.tenant}" read cached payload belonging to "${val.observedTenant}"`,
        });
      }
      if (
        val.postHeal &&
        val.expectedMinVersion !== undefined &&
        val.observedVersion !== undefined &&
        val.observedVersion < val.expectedMinVersion
      ) {
        violations.push({
          code: 'stale_cache_after_heal',
          detail: `op #${op.index} tenant "${val.tenant}" read stale version ${val.observedVersion} < ${val.expectedMinVersion} after invalidation & heal`,
        });
      }
    }
  }

  if (readsChecked === 0) violations.push({ code: 'no_cache_reads', detail: 'no cache reads completed' });
  if (writesCompleted === 0) violations.push({ code: 'no_cache_writes', detail: 'no cache writes completed' });

  return {
    valid: violations.length === 0,
    summary: {
      readsChecked,
      writesCompleted,
      partitionDegradedReads: input.partitionDegradedReads,
      incrUnavailableErrors: input.incrUnavailableErrors,
      postHealFreshChecks: input.postHealFreshChecks,
    },
    violations,
  };
}

export interface ProposalsLiveCheckInput {
  readonly proposalIds: readonly string[];
  /** Number of times each proposal's underlying command effect actually committed to DB. */
  readonly appliedCountByProposal: Readonly<Record<string, number>>;
  /** Final proposal state in command journal (`approved`, `dismissed`, `pending`, etc.). */
  readonly finalStateByProposal: Readonly<Record<string, string>>;
  readonly committedWakeCount: number;
  readonly observedWakeCount: number;
  readonly rollbackWakeCount: number;
}

export interface ProposalsLiveCheckResult {
  readonly valid: boolean;
  readonly summary: {
    readonly totalProposals: number;
    readonly approvedCount: number;
    readonly dismissedCount: number;
    readonly committedWakeCount: number;
    readonly observedWakeCount: number;
    readonly rollbackWakeCount: number;
  };
  readonly violations: readonly InvariantViolation[];
}

/** Verify at-most-once proposal execution (never after dismissal) and reliable LISTEN/NOTIFY wakeups without rollback leaks. */
export function checkProposalsAndLiveSync(input: ProposalsLiveCheckInput): ProposalsLiveCheckResult {
  const violations: InvariantViolation[] = [];
  let approvedCount = 0;
  let dismissedCount = 0;

  for (const id of input.proposalIds) {
    const applied = input.appliedCountByProposal[id] ?? 0;
    const state = input.finalStateByProposal[id] ?? 'missing';
    if (state === 'approved') approvedCount++;
    if (state === 'dismissed') dismissedCount++;

    if (applied > 1) {
      violations.push({
        code: 'proposal_double_applied',
        detail: `proposal "${id}" applied ${applied} times (expected at most 1)`,
      });
    }
    if (state === 'dismissed' && applied > 0) {
      violations.push({
        code: 'dismissed_proposal_executed',
        detail: `proposal "${id}" ended dismissed yet applied ${applied} time(s)`,
      });
    }
    if (state === 'approved' && applied !== 1) {
      violations.push({
        code: 'approved_proposal_missing_effect',
        detail: `proposal "${id}" ended approved yet applied ${applied} time(s)`,
      });
    }
  }

  if (input.rollbackWakeCount > 0) {
    violations.push({
      code: 'rollback_triggered_notify',
      detail: `rolled-back transactions triggered ${input.rollbackWakeCount} LISTEN notifications`,
    });
  }
  if (input.committedWakeCount > 0 && input.observedWakeCount === 0) {
    violations.push({
      code: 'lost_all_wakeups',
      detail: `${input.committedWakeCount} commits occurred but listener observed 0 wakeups`,
    });
  }

  return {
    valid: violations.length === 0,
    summary: {
      totalProposals: input.proposalIds.length,
      approvedCount,
      dismissedCount,
      committedWakeCount: input.committedWakeCount,
      observedWakeCount: input.observedWakeCount,
      rollbackWakeCount: input.rollbackWakeCount,
    },
    violations,
  };
}

export interface SqliteCrashCheckInput {
  readonly integrityCheck: string;
  readonly initialTotal: number;
  readonly finalTotal: number;
  readonly minBalance: number;
  readonly appliedTransfers: number;
  readonly killsInjected: number;
  readonly undoEntriesPersisted: number;
}

export interface SqliteCrashCheckResult {
  readonly valid: boolean;
  readonly summary: SqliteCrashCheckInput;
  readonly violations: readonly InvariantViolation[];
}

/** Verify SQLite WAL integrity, balance conservation, and Undo journal survival across real SIGKILL worker crashes. */
export function checkSqliteCrash(input: SqliteCrashCheckInput): SqliteCrashCheckResult {
  const violations: InvariantViolation[] = [];
  if (input.integrityCheck !== 'ok') {
    violations.push({ code: 'sqlite_corrupt', detail: `PRAGMA integrity_check returned "${input.integrityCheck}"` });
  }
  if (input.finalTotal !== input.initialTotal) {
    violations.push({
      code: 'sqlite_conservation_mismatch',
      detail: `final total ${input.finalTotal} !== initial total ${input.initialTotal} after ${input.killsInjected} SIGKILLs`,
    });
  }
  if (input.minBalance < 0) {
    violations.push({ code: 'sqlite_negative_balance', detail: `negative balance ${input.minBalance} found after crashes` });
  }
  if (input.appliedTransfers === 0) {
    violations.push({ code: 'sqlite_no_progress', detail: 'no transfers committed during SQLite crash workload' });
  }
  return {
    valid: violations.length === 0,
    summary: input,
    violations,
  };
}

export interface FailoverCheckInput {
  readonly readOnlyRejections: number;
  readonly postFailoverWritesOk: number;
  readonly initialTotal: number;
  readonly finalTotal: number;
  readonly falseAppliedOnReadOnly: number;
}

export interface FailoverCheckResult {
  readonly valid: boolean;
  readonly summary: FailoverCheckInput;
  readonly violations: readonly InvariantViolation[];
}

/** Verify PostgreSQL read-only (25006) failover refusal safety and clean recovery on writable primary. */
export function checkFailover(input: FailoverCheckInput): FailoverCheckResult {
  const violations: InvariantViolation[] = [];
  if (input.falseAppliedOnReadOnly > 0) {
    violations.push({
      code: 'write_succeeded_on_readonly',
      detail: `${input.falseAppliedOnReadOnly} writes unexpectedly reported applied against read-only standby`,
    });
  }
  if (input.readOnlyRejections === 0) {
    violations.push({ code: 'no_readonly_fault_exercised', detail: 'no 25006 read-only rejections were observed' });
  }
  if (input.postFailoverWritesOk === 0) {
    violations.push({ code: 'failover_recovery_failed', detail: '0 writes succeeded after failing over to writable primary' });
  }
  if (input.finalTotal !== input.initialTotal) {
    violations.push({
      code: 'failover_conservation_mismatch',
      detail: `final total ${input.finalTotal} !== initial total ${input.initialTotal}`,
    });
  }
  return {
    valid: violations.length === 0,
    summary: input,
    violations,
  };
}

export interface SupportLeaseCheckInput {
  readonly openSucceeded: number;
  readonly exitSucceeded: number;
  readonly maxActiveObserved: number;
  readonly finalActiveAfterRevoke: number;
  readonly postRevokeOpenSucceeded: number;
  readonly auditChainFailedCount: number;
  readonly auditSessionsCount: number;
}

export interface SupportLeaseCheckResult {
  readonly valid: boolean;
  readonly summary: SupportLeaseCheckInput;
  readonly violations: readonly InvariantViolation[];
}

/** Verify at-most-one active support lease per account, zero active leases after parent revocation, and intact cryptographic audit chain. */
export function checkSupportLeases(input: SupportLeaseCheckInput): SupportLeaseCheckResult {
  const violations: InvariantViolation[] = [];
  if (input.maxActiveObserved > 1) {
    violations.push({
      code: 'concurrent_dual_support_lease',
      detail: `observed ${input.maxActiveObserved} simultaneously active support leases for one account (expected <= 1)`,
    });
  }
  if (input.finalActiveAfterRevoke > 0) {
    violations.push({
      code: 'support_lease_survived_revocation',
      detail: `${input.finalActiveAfterRevoke} support lease(s) remained active after parent platform membership revocation`,
    });
  }
  if (input.postRevokeOpenSucceeded > 0) {
    violations.push({
      code: 'post_revoke_support_open_succeeded',
      detail: `${input.postRevokeOpenSucceeded} support open(s) succeeded after parent platform membership was revoked`,
    });
  }
  if (input.auditChainFailedCount > 0) {
    violations.push({
      code: 'support_audit_chain_corrupt',
      detail: `support audit hash-chain verification reported ${input.auditChainFailedCount} failed session(s)`,
    });
  }
  if (input.openSucceeded === 0) {
    violations.push({ code: 'no_support_opens', detail: '0 support leases opened during support-lease workload' });
  }
  return {
    valid: violations.length === 0,
    summary: input,
    violations,
  };
}
