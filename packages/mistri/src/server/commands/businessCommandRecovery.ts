/* Private ordinary receipt recovery. Current binding authorization and genuine
 * journal capabilities precede value validation; no business callback runs
 * except the current output validator. This is not bearer/session admission. */
import { isProxy } from 'node:util/types';
import {
  CommandTransactionFailure,
  isOrdinarySqliteCommandJournal,
  recoverSqliteCommandReceipt,
} from '../../adapters/commands/commandJournal.js';
import { isOrdinaryPostgresCommandJournal, recoverPostgresCommandReceipt } from '../../adapters/commands/postgresCommandJournal.js';
import { BULK_LIMIT } from '../../shared/command.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { hasAppScopeCommandEventOwner, type BusinessCommandBinding } from './businessCommandAccess.js';
import { getCommandEvents, type BusinessCommandActor } from './businessCommands.js';
import { canonicalKey } from './commandDb.js';
import { BusinessCommandExecutionError, isBusinessCommandExecutionError } from './commandErrors.js';
import { validateHistoricalCommandOutput } from './commandHistoricalOutput.js';
import {
  canonicalCommandJson,
  CommandInputError,
  commandKeyText,
  parseCommandKey,
  parseCommandRecoveryRequest,
  type CommandKey,
} from './commandPayload.js';

interface RecoveredCommandReceipt {
  readonly status: 'applied';
  readonly receiptId: string;
  readonly command: string;
  readonly commandVersion: number;
  readonly resource: string;
  readonly targets: readonly CommandKey[];
  readonly result: unknown;
  readonly recovered: true;
}

/** The trusted owner supplies a fresh ordinary account and the current binding,
 * including its owner-verified transaction where required. This helper cannot
 * prove that provenance. No row-existence check: deleted targets retain receipts.
 * All refusals/absence leave the original operation's outcome unknown. */
export async function recoverBusinessCommandReceipt(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  rawRequest: unknown,
  options: { readonly signal?: AbortSignal } = {},
): Promise<RecoveredCommandReceipt | Readonly<{ status: 'not_found'; outcome: 'unknown' }>> {
  try {
    const checkCancelled = () => {
      if (options.signal?.aborted) throw new BusinessCommandExecutionError('cancelled', 'unknown');
    };
    checkCancelled();
    const data = parseCommandRecoveryRequest(rawRequest);
    const account = captureTenantData(actor);
    if (
      !binding ||
      isProxy(binding) ||
      binding.scoped ||
      account.kind !== undefined ||
      account.form !== undefined ||
      binding.creates?.(data.command)
    )
      throw new AppAccessDenied();
    const authorized = binding.authorize(data.command, account);
    if (
      !authorized ||
      isProxy(authorized) ||
      ('receiptOwner' in authorized && authorized.receiptOwner !== undefined) ||
      authorized.actor.kind !== undefined ||
      authorized.actor.form !== undefined ||
      authorized.command.public ||
      !authorized.keyColumns.length
    )
      throw new AppAccessDenied();
    const { command } = authorized;
    if (command.version !== data.commandVersion) throw new BusinessCommandExecutionError('command_version_mismatch', 'unknown');
    const events = getCommandEvents(command);
    if (events && !hasAppScopeCommandEventOwner(binding)) throw new AppAccessDenied();
    const table = authorized.catalog[command.target];
    if (
      !table ||
      table.key.length !== authorized.keyColumns.length ||
      table.key.some((key) => !authorized.keyColumns.includes(key)) ||
      !authorized.commandTransaction
    )
      throw new AppAccessDenied();
    const scope = Object.freeze({
      appId: authorized.actor.appId,
      actorId: authorized.actor.id,
      commandId: data.command,
      commandVersion: data.commandVersion,
      idempotencyKey: data.idempotencyKey,
    });
    const answer = await authorized.commandTransaction(async (_records, journal) => {
      checkCancelled();
      // Family evidence only selects the native capability; no catch-and-fallback.
      const recover = isOrdinarySqliteCommandJournal(journal)
        ? recoverSqliteCommandReceipt
        : isOrdinaryPostgresCommandJournal(journal)
          ? recoverPostgresCommandReceipt
          : undefined;
      if (!recover) throw new AppAccessDenied();
      const saved = await recover(journal, scope, events?.expectation);
      checkCancelled();
      if (!saved) return Object.freeze({ status: 'not_found' as const, outcome: 'unknown' as const });
      if (!saved.targets.length || saved.targets.length > BULK_LIMIT || (command.targets !== 'many' && saved.targets.length !== 1))
        throw new BusinessCommandExecutionError('invalid_result', 'unknown');
      const seen = new Set<string>();
      const targets = saved.targets.map((target) => {
        if (target.target !== authorized.resource) throw new BusinessCommandExecutionError('invalid_result', 'unknown');
        let key: CommandKey;
        try {
          if (canonicalCommandJson(JSON.parse(target.keyJson), 8192) !== target.keyJson) throw new Error();
          key = parseCommandKey(JSON.parse(target.keyJson));
          if (
            Object.keys(key).length !== authorized.keyColumns.length ||
            authorized.keyColumns.some((column) => !Object.hasOwn(key, column))
          )
            throw new Error();
          const exact = canonicalKey(table, key);
          if (!exact) throw new Error();
          const identity = commandKeyText(exact);
          if (seen.has(identity)) throw new Error();
          seen.add(identity);
        } catch {
          throw new BusinessCommandExecutionError('invalid_result', 'unknown');
        }
        return key;
      });
      let result: unknown;
      checkCancelled();
      try {
        // New recovery requires stored canonical bytes; legacy replay remains
        // deliberately unchanged in the shared historical-output validator.
        if (canonicalCommandJson(JSON.parse(saved.receipt.resultJson), 16384) !== saved.receipt.resultJson) throw new Error();
        result = validateHistoricalCommandOutput(saved.receipt.resultJson, command.output);
      } catch {
        throw new BusinessCommandExecutionError('invalid_result', 'unknown');
      }
      checkCancelled();
      return Object.freeze({
        status: 'applied' as const,
        receiptId: saved.receipt.id,
        command: scope.commandId,
        commandVersion: scope.commandVersion,
        resource: authorized.resource,
        targets: Object.freeze(targets),
        result,
        recovered: true as const,
      });
    });
    checkCancelled();
    return answer;
  } catch (error) {
    const cause = error instanceof CommandTransactionFailure ? error.cause : error;
    const code = isBusinessCommandExecutionError(cause)
      ? cause.code
      : cause instanceof CommandInputError
        ? 'invalid_input'
        : cause instanceof AppAccessDenied
          ? 'forbidden'
          : 'temporarily_unavailable';
    throw new BusinessCommandExecutionError(
      code,
      'unknown',
      isBusinessCommandExecutionError(cause) ? cause.field : cause instanceof CommandInputError ? cause.field : undefined,
    );
  }
}
