/** Dedicated mutation transport. The host selects a target and flag through
 * its authorized record route. Form bodies carry edits, never authority or
 * scope. No retry/receipt inference: conflicts and unknown outcomes propagate. */
import type { FlagOverride } from '../../shared/appFlags.js';
import { TransactionOutcomeUnknown } from '@mistriwork/engine/adapters/adapter.js';
import type { FlagManagementAcknowledgement, FlagManagementChange } from '../flags/management.js';
import { consoleDenied, consoleProof, consoleRecord, type ConsoleAdmission, type ConsoleTargetService } from './controlSource.js';

export function createConsoleCommands(options: {
  readonly admission: ConsoleAdmission;
  readonly target: ConsoleTargetService;
  readonly flagId: string;
}) {
  const { admission, target, flagId } = options;
  const tenantId = target.tenantId,
    change = target.change,
    authorize = target.authorize,
    admit = admission.admit;
  if (typeof flagId !== 'string' || !flagId.length) return consoleDenied();
  const execute = async (operation: 'set' | 'kill' | 'revert', input: unknown): Promise<FlagManagementAcknowledgement> => {
    const raw = consoleRecord(input, [
      'expectedRevision',
      'reason',
      ...(operation === 'set' ? ['override'] : operation === 'revert' ? ['revertRevision'] : []),
    ]);
    if (
      !Number.isSafeInteger(raw.expectedRevision) ||
      (raw.expectedRevision as number) < 0 ||
      typeof raw.reason !== 'string' ||
      !raw.reason.trim() ||
      raw.reason.length > 1024
    )
      return consoleDenied();
    if (operation === 'set' && (!raw.override || typeof raw.override !== 'object' || Array.isArray(raw.override))) return consoleDenied();
    if (operation === 'revert' && (!Number.isSafeInteger(raw.revertRevision) || (raw.revertRevision as number) < 0)) return consoleDenied();
    const shell = consoleProof(await admit.call(admission));
    await shell.reobserve();
    const proof = consoleProof(await authorize.call(target, flagId, operation));
    const fence = async () => {
      await proof.reobserve();
      await shell.reobserve();
      proof.assertCurrent();
      shell.assertCurrent();
    };
    const base = { tenantId, flagId, expectedRevision: raw.expectedRevision as number, reason: raw.reason };
    const request: FlagManagementChange =
      operation === 'set'
        ? { ...base, operation, override: raw.override as FlagOverride }
        : operation === 'revert'
          ? { ...base, operation, revertRevision: raw.revertRevision as number }
          : { ...base, operation };
    await fence();
    const result = await change.call(target, request, fence);
    try {
      await fence();
      if (result.flagId !== flagId || result.operation !== operation) return consoleDenied();
      proof.assertCurrent();
      shell.assertCurrent();
    } catch (error) {
      throw new TransactionOutcomeUnknown(error);
    }
    return Object.freeze({ flagId, revision: result.revision, operation: result.operation });
  };
  return Object.freeze({
    set: (input: unknown) => execute('set', input),
    kill: (input: unknown) => execute('kill', input),
    revert: (input: unknown) => execute('revert', input),
  });
}
