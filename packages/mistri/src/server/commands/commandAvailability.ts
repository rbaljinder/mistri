/** Shared eligibility evaluation. The host must supply already-authorized
 * target rows and a read transaction under the command's footprint/row scope.
 * This helper neither authorizes a principal nor executes a handler. */
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { snapshotScopedData } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import { BULK_LIMIT } from '../../shared/command.js';
import { registeredAvailability, type AnyBusinessCommand, type BusinessCommandActor } from './businessCommands.js';
import { canonicalKey, createCommandDb, keyFilter, normalizeRow, type CommandCatalog, type UntypedRow } from './commandDb.js';
import { compileWhen, whenHolds, whenPerson, type CommandPeople } from './commandWhen.js';
import { BusinessCommandExecutionError, isBusinessCommandExecutionError } from './commandErrors.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { visibleTargetRow } from './commandActorColumns.js';
import { commandKeyText, type CommandAvailabilityCheck, type CommandAvailabilityResult, type CommandKey } from './commandPayload.js';
import type { CommandMachine } from './businessCommandAuthorization.js';
import { commandFlagEnabled, commandFlagsReader, type CommandFlags } from './commandFlags.js';

/** Authorize in the host callback before opening its owned reader. Only known
 * authorization refusals become false, never arbitrary operational failures. */
export async function collectCommandAvailability(
  checks: readonly CommandAvailabilityCheck[],
  run: (check: CommandAvailabilityCheck) => Promise<readonly boolean[]>,
  signal?: AbortSignal,
  /** Ask every check at once, each still judged in order below: for a host whose checks each read on their own. */
  options: { concurrent?: boolean } = {},
): Promise<CommandAvailabilityResult> {
  const results: CommandAvailabilityResult['checks'][number][] = [];
  const asked = options.concurrent
    ? checks.map((check) => {
        const answer = Promise.resolve().then(() => run(check));
        answer.catch(() => {});
        return answer;
      })
    : undefined;
  for (const [index, check] of checks.entries()) {
    if (signal?.aborted) throw new BusinessCommandExecutionError('cancelled');
    let available: readonly boolean[];
    try {
      available = await (asked ? asked[index] : run(check));
    } catch (error) {
      if (
        !(error instanceof AppAccessDenied) &&
        !(
          isBusinessCommandExecutionError(error) &&
          ['forbidden', 'not_found', 'command_version_mismatch', 'ineligible_state'].includes(error.code)
        )
      ) {
        // Never relay a business hook's private key/field/reason through this
        // visibility-only protocol. Cancellation retains its lifecycle meaning.
        throw new BusinessCommandExecutionError(
          signal?.aborted || (isBusinessCommandExecutionError(error) && error.code === 'cancelled')
            ? 'cancelled'
            : 'temporarily_unavailable',
        );
      }
      available = check.keys.map(() => false);
    }
    if (signal?.aborted) throw new BusinessCommandExecutionError('cancelled');
    if (available.length !== check.keys.length || available.some((value) => typeof value !== 'boolean'))
      throw new BusinessCommandExecutionError('invalid_result');
    results.push(Object.freeze({ command: check.command, commandVersion: check.commandVersion, available: Object.freeze([...available]) }));
  }
  return Object.freeze({ checks: Object.freeze(results) });
}

/** Read matched targets once, then invoke one business predicate. Missing rows
 * have no public distinction from ineligible rows. No initial or handler runs. */
export async function readCommandAvailability(options: {
  check: CommandAvailabilityCheck;
  command: AnyBusinessCommand;
  actor: BusinessCommandActor;
  catalog: CommandCatalog;
  reader: Pick<WriteTransaction, 'query' | 'count'>;
  signal: AbortSignal;
  requestId?: string;
  now?: () => Date;
  flags?: CommandFlags;
  assertTarget?: (key: CommandKey) => Promise<void>;
  /** The command's machine: a verb of its target's is offered only from a state that lists it, as the executor runs it. */
  machine?: CommandMachine;
  /** Where the command reads the people table: `me` in its `when` is the actor's row there (whenPerson). */
  people?: CommandPeople;
}): Promise<readonly boolean[]> {
  const { command, check, catalog, reader, signal } = options;
  const flags = commandFlagsReader(options.flags);
  const none = () => Object.freeze(check.keys.map(() => false));
  if (signal.aborted) throw new BusinessCommandExecutionError('cancelled');
  if (command.version !== check.commandVersion || command.public || command.targets === 'none') return none();
  if (!commandFlagEnabled(command, flags)) return none();
  const table = catalog[command.target];
  if (!table) return none();
  if (check.keys.some((key) => Object.keys(key).length !== table.key.length || table.key.some((column) => !Object.hasOwn(key, column))))
    return none();
  const keys = check.keys.map((key) => canonicalKey(table, key));
  if (keys.some((key) => !key)) return none();
  const now = options.now ?? (() => new Date());
  let groups = keys.map((key) => keyFilter(key!).groups[0]);
  // A `when` over a rollup or a computed column is judged of each row once read (commandWhen.ts).
  const me = await whenPerson(reader, options.actor, options.people, [command.when]);
  const when = command.when === undefined ? undefined : compileWhen(table, command.when, now(), me);
  if (when?.none) return none();
  if (when && !when.derived.size && when.filter.groups.length)
    groups = groups.flatMap((group) => when.filter.groups.map((condition) => [...group, ...condition]));
  const found = await reader.query({ table: command.target, filter: { groups }, offset: 0, limit: check.keys.length + 1 });
  if (signal.aborted) throw new BusinessCommandExecutionError('cancelled');
  const requested = new Set(keys.map((key) => commandKeyText(key)));
  const rows = new Map<string, UntypedRow>();
  for (const row of found.rows) {
    const key = canonicalKey(table, row);
    const text = key && commandKeyText(key);
    if (!key || !text || !requested.has(text) || rows.has(text)) throw new BusinessCommandExecutionError('invalid_result');
    await options.assertTarget?.(key);
    if (signal.aborted) throw new BusinessCommandExecutionError('cancelled');
    rows.set(text, normalizeRow(table, row) as UntypedRow);
  }
  const graph = options.machine?.verb && options.machine.tables.get(command.target);
  if (graph) for (const [text, row] of rows) if (!options.machine!.verb!.from.has(String(row[graph.column]))) rows.delete(text);
  if (when?.derived.size) {
    const held = await whenHolds(reader, catalog, command.target, when, [...rows.values()], now());
    [...rows.keys()].forEach((text, at) => held[at] || rows.delete(text));
    if (signal.aborted) throw new BusinessCommandExecutionError('cancelled');
  }
  const entries = [...rows];
  const values = await evaluateCommandAvailability({
    command,
    commandId: check.command,
    actor: options.actor,
    records: entries.map(([, row]) => row),
    catalog,
    reader,
    signal,
    now,
    requestId: options.requestId ?? 'availability',
    flags,
  });
  const decisions = new Map(entries.map(([key], index) => [key, values[index]]));
  return Object.freeze(keys.map((key) => decisions.get(commandKeyText(key)) === true));
}

export async function evaluateCommandAvailability(options: {
  command: AnyBusinessCommand;
  commandId: string;
  actor: BusinessCommandActor;
  records: readonly Readonly<Record<string, unknown>>[];
  catalog: CommandCatalog;
  reader: Pick<WriteTransaction, 'query' | 'count'>;
  signal: AbortSignal;
  requestId: string;
  now: () => Date;
  flags?: CommandFlags;
}): Promise<readonly boolean[]> {
  const { command, signal } = options;
  const flags = commandFlagsReader(options.flags);
  const checkCancelled = () => {
    if (signal.aborted) throw new BusinessCommandExecutionError('cancelled');
  };
  checkCancelled();
  if (!Array.isArray(options.records) || options.records.length > BULK_LIMIT) throw new BusinessCommandExecutionError('invalid_input');
  if (!commandFlagEnabled(command, flags)) return Object.freeze(options.records.map(() => false));
  const hook = registeredAvailability(command);
  // No new row-value restrictions on commands that have not opted in.
  if (!hook) return Object.freeze(options.records.map(() => true));
  if (!options.records.length) return Object.freeze([]);
  let records: readonly UntypedRow[], actor: BusinessCommandActor;
  try {
    // The records as the actor reads them: whether a button is offered is shown to them.
    const captured = snapshotScopedData(options.records.map((row) => visibleTargetRow(options.actor, row)));
    for (const row of captured) {
      if (!row || Array.isArray(row) || typeof row !== 'object' || row instanceof Uint8Array) throw new Error();
    }
    const freeze = (value: unknown): void => {
      // Bytes are detached by snapshotScopedData; nonempty typed arrays cannot
      // be frozen. Their mutation cannot change the host's original rows.
      if (!value || typeof value !== 'object' || value instanceof Uint8Array) return;
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    };
    freeze(captured);
    records = captured as readonly UntypedRow[];
    actor = snapshot(options.actor, 65_536).value as unknown as BusinessCommandActor;
  } catch {
    throw new BusinessCommandExecutionError('invalid_input');
  }
  const reader: Pick<WriteTransaction, 'query' | 'count'> = Object.freeze({
    query: async (request) => {
      checkCancelled();
      const result = await options.reader.query(request);
      checkCancelled();
      return result;
    },
    count: async (table, filter) => {
      checkCancelled();
      const result = await options.reader.count(table, filter);
      checkCancelled();
      return result;
    },
  });
  const db = createCommandDb({ tx: reader, catalog: options.catalog, read: command.read, write: [], now: options.now });
  const result = await hook(
    Object.freeze({
      actor,
      records,
      db,
      signal,
      now: options.now,
      flags,
      requestId: options.requestId,
      commandId: options.commandId,
      version: command.version,
      source: command.source,
    }),
  );
  checkCancelled();
  try {
    const captured = snapshot(result, 4096).value;
    if (!Array.isArray(captured) || captured.length !== records.length || captured.some((value) => typeof value !== 'boolean'))
      throw new Error();
    return captured as readonly boolean[];
  } catch {
    throw new BusinessCommandExecutionError('invalid_result');
  }
}
