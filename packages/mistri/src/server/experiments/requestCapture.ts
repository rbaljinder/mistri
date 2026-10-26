/** Bridge one admitted flag snapshot to real experiment decisions and receipts.
 * Evaluation remains passive; server use and browser receipt ingestion are separate. */
import { flagValuesEqual, type FlagEvaluation } from '../../shared/appFlags.js';
import { ensure } from './contracts.js';
import type { AssignmentReceiptClaims } from './assignmentReceipt.js';
import type { ExperimentRequestObservation } from './runtime.js';
import type { ExperimentRequestPort } from './requestPort.js';

export async function captureRequestExperiments(input: {
  readonly port: ExperimentRequestPort;
  readonly observation: ExperimentRequestObservation;
  readonly flags: readonly string[];
  readonly proof: AssignmentReceiptClaims['proof'];
  readonly current: () => Promise<void>;
  readonly readSnapshots?: () => Promise<ExperimentRequestObservation['snapshots']>;
}) {
  const { port, observation, proof, current } = input;
  const captured = await port.runtime.captureRequest(() => observation);
  const decisions = new Map<string, Awaited<ReturnType<typeof captured.decision>>>();
  for (const id of input.flags) {
    // Only an active allocation can need a derived evaluation scope. The
    // runtime separately validates frozen eligibility and exact allocation.
    const local = observation.snapshots.tenant?.overrides[id],
      global = observation.snapshots.global.overrides[id];
    const controlTenantId = local?.experiment ? observation.evaluationTenantId : null;
    if (local?.experiment || global?.experiment)
      await port.runtime.ensureEvaluationEpoch(id, { controlTenantId, evaluationTenantId: observation.evaluationTenantId }, current);
    decisions.set(id, await captured.decision(id));
  }
  await current();
  const assignment = async (id: string) => {
    const decision = decisions.get(id);
    if (!decision?.epoch || decision.evaluation.reason !== 'experiment') return null;
    await current();
    return port.receipts.resolveAssignment({
      epoch: decision.epoch,
      context: observation.context,
      snapshots: observation.snapshots,
      proof,
    });
  };
  return Object.freeze({
    evaluations: new Map([...decisions].map(([id, value]) => [id, value.evaluation])),
    async issueAssignmentReceipt(id: string, evaluated: FlagEvaluation) {
      const handle = await assignment(id);
      if (!handle) return null;
      ensure(flagValuesEqual(decisions.get(id)!.evaluation.value, evaluated.value), 'Experiment decision changed.');
      await decisions.get(id)!.recordDelivery!();
      const receipt = port.receipts.issue(handle);
      // Enrollment commits only for delivered experimental values, not passive
      // command evaluation; a dropped response remains visibly unknown.
      await current();
      return Object.freeze({ receipt, value: evaluated.value });
    },
    async resolveAssignment(claims: AssignmentReceiptClaims) {
      await current();
      const fresh = input.readSnapshots ? { ...observation, snapshots: await input.readSnapshots() } : observation;
      await current();
      const request = await port.runtime.captureRequest(() => fresh),
        decision = await request.decision(claims.flagId);
      ensure(decision.epoch && decision.evaluation.reason === 'experiment', 'No active experiment assignment.');
      return port.receipts.resolveAssignment({ epoch: decision.epoch, context: fresh.context, snapshots: fresh.snapshots, proof });
    },
    async recordUse(id: string) {
      const decision = decisions.get(id);
      if (!decision?.recordUse) return;
      await current();
      await decision.recordUse();
      await current();
    },
  });
}
