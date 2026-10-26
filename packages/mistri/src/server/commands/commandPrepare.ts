/**
 * One record's prepare: the revision (commandRevision.ts) a form will submit as `expectedVersion`
 * and, when the command declares `initial`, the form's starting values —
 * read in the same transaction as that revision, so what the form opens
 * with is that revision's, and a change after it is refused on submit as a
 * stale record, as always. `initial` reads through the transaction the
 * caller authorized for this command: its footprint, under the same grant
 * and row ceilings as execution, and only reads. Nothing is written and no
 * receipt is kept.
 */
import { bindRecord, boundText } from '../../shared/commandDraft.js';
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { readCommandInput } from '../../shared/commandInput.js';
import { BULK_LIMIT, boundRecordQuery, type AppCommandField } from '../../shared/command.js';
import { BusinessCommandExecutionError } from './businessCommandExecution.js';
import {
  callerRead,
  registeredInitial,
  registeredAvailability,
  type AnyBusinessCommand,
  type BusinessCommandActor,
} from './businessCommands.js';
import { evaluateCommandAvailability } from './commandAvailability.js';
import { visibleTargetRow } from './commandActorColumns.js';
import { canonicalKey, createCommandDb, keyFilter, normalizeRow, type CommandCatalog, type UntypedRow } from './commandDb.js';
import { compileWhen, inputsWithheld, whenHolds, whenPerson, type CommandPeople } from './commandWhen.js';
import { canonicalCommandJson, commandKeyText, type CommandKey } from './commandPayload.js';
import type { PreparedCommandTarget } from './commandTargets.js';
import { revisionColumns, rowRevision, versionColumn } from './commandRevision.js';
import { commandFlagEnabled, commandFlagsReader, type CommandFlags } from './commandFlags.js';
import { definedInputs, readCommandDefinitions } from './commandDefined.js';
import { askedWhen, preparedStarts, preparesInitial, recordPickers } from './commandPrepareNeeds.js';
import type { DefinedField } from '@mistriwork/engine/shared/definedFields.js';
import { withWriteAhead } from '@mistriwork/engine/adapters/writeAhead.js';

export interface PreparedCommand {
  expectedVersion: number;
  /** Input-shaped starting values, checked against the declaration. Present when the command declares `initial`. */
  initial?: Record<string, unknown>;
  /** A reference input's picker query with the record's values bound, by declared path (`lines.line`); null offers nothing. */
  choices?: Record<string, string | null>;
  /** The inputs this record is not asked (their `when` does not hold of it): the form leaves them out. */
  withheld?: string[];
  /** The inputs whose `when` reads both this record and the draft: the draft's part, the record's judged here
      (commandDraft.ts boundText), which the form judges as it is typed. */
  when?: Record<string, string>;
  /** Each `field.defined` input's questions, by input name, as the rows say them now: the form draws one field each. */
  defined?: Record<string, DefinedField[]>;
}

/** Add business eligibility to an already visibility/state-filtered bulk
 * prepare. One target read and one hook invocation, not one staff query per row. */
export async function readPreparedTargetAvailability(
  reader: Pick<WriteTransaction, 'query' | 'count'>,
  options: {
    command: AnyBusinessCommand;
    commandId: string;
    actor: BusinessCommandActor;
    targets: readonly PreparedCommandTarget[];
    catalog: CommandCatalog;
    /** Where the command reads the people table: `me` in a `when` is the actor's row there (whenPerson). */
    people?: CommandPeople;
    signal?: AbortSignal;
    requestId?: string;
    now?: () => Date;
    flags?: CommandFlags;
    assertTarget?: (key: CommandKey) => Promise<void>;
  },
): Promise<PreparedCommandTarget[]> {
  const { command, catalog } = options;
  const flags = commandFlagsReader(options.flags);
  if (options.targets.length > BULK_LIMIT) throw new BusinessCommandExecutionError('invalid_input');
  if (options.signal?.aborted) throw new BusinessCommandExecutionError('cancelled');
  if (!commandFlagEnabled(command, flags)) return options.targets.map((target) => ({ ...target, eligible: false }));
  if (!registeredAvailability(command)) return [...options.targets];
  const signal = options.signal ?? new AbortController().signal,
    now = options.now ?? (() => new Date());
  const checkCancelled = () => {
    if (signal.aborted) throw new BusinessCommandExecutionError('cancelled');
  };
  checkCancelled();
  const selected = options.targets.filter((target) => target.eligible);
  if (!selected.length) return options.targets.map((target) => ({ ...target, eligible: false }));
  const table = catalog[command.target];
  if (!table || command.targets === 'none') throw new BusinessCommandExecutionError('invalid_result');
  const versionField = versionColumn(table.meta.columns);
  const keys = selected.map((target) => canonicalKey(table, target.key));
  if (keys.some((key) => !key)) throw new BusinessCommandExecutionError('invalid_input');
  let groups = keys.map((key) => keyFilter(key!).groups[0]);
  // A `when` over a rollup or a computed column is judged of each row once read (commandWhen.ts).
  const me = await whenPerson(reader, options.actor, options.people, [command.when]);
  const when = command.when === undefined ? undefined : compileWhen(table, command.when, now(), me);
  if (when?.none) return options.targets.map((target) => ({ ...target, eligible: false }));
  if (when && !when.derived.size && when.filter.groups.length)
    groups = groups.flatMap((group) => when.filter.groups.map((condition) => [...group, ...condition]));
  for (const key of keys) {
    await options.assertTarget?.(key!);
    checkCancelled();
  }
  const found = await reader.query({
    table: command.target,
    ...(versionField === undefined ? { binary: true as const } : {}),
    filter: { groups },
    offset: 0,
    limit: selected.length + 1,
  });
  checkCancelled();
  const rows = new Map<string, UntypedRow>();
  const expected = new Map(selected.map((target) => [commandKeyText(target.key), target.expectedVersion]));
  for (const row of found.rows) {
    const key = canonicalKey(table, row);
    if (!key) throw new BusinessCommandExecutionError('invalid_result');
    const text = commandKeyText(key);
    if (!expected.has(text) || rows.has(text)) throw new BusinessCommandExecutionError('invalid_result');
    if (rowRevision(row, versionField) === expected.get(text)) rows.set(text, normalizeRow(table, row) as UntypedRow);
  }
  if (when?.derived.size) {
    const held = await whenHolds(reader, catalog, command.target, when, [...rows.values()], now());
    [...rows.keys()].forEach((text, at) => held[at] || rows.delete(text));
    checkCancelled();
  }
  const entries = [...rows];
  const available = await evaluateCommandAvailability({
    command,
    commandId: options.commandId,
    actor: options.actor,
    records: entries.map(([, row]) => row),
    catalog,
    reader,
    signal,
    now,
    requestId: options.requestId ?? 'prepare',
    flags,
  });
  const decisions = new Map(entries.map(([key], index) => [key, available[index]]));
  return options.targets.map((target) => ({ ...target, eligible: target.eligible && decisions.get(commandKeyText(target.key)) === true }));
}

/**
 * Run a preparation's transaction with the record it reads told ahead (writeAhead.ts): the row leaves behind the BEGIN
 * and answers the target check and the revision read from it, so preparing a command on PostgreSQL is the BEGIN's
 * flight and the COMMIT's. Read only: no lock is sent with it, as preparation never took one.
 */
export function withPreparedAhead<T>(command: AnyBusinessCommand, catalog: CommandCatalog | undefined, key: CommandKey, work: () => T): T {
  // The table as the transaction names it (the catalog's id), not the command's local name for it.
  const table = catalog?.[command.target]?.meta.id;
  if (command.targets === 'none' || !table) return work();
  return withWriteAhead({ targets: [{ table, key }], writes: false, readOnly: true }, work);
}

export async function readPreparedRecord(
  records: WriteTransaction,
  options: {
    command: AnyBusinessCommand;
    commandId: string;
    actor: BusinessCommandActor;
    key: CommandKey;
    catalog: CommandCatalog;
    /** Where the command reads the people table: `me` in a `when` is the actor's row there (whenPerson). */
    people?: CommandPeople;
    signal?: AbortSignal;
    requestId?: string;
    now?: () => Date;
    flags?: CommandFlags;
    /** After the revision is read and before `initial`: a caller's target check. The revision
     *  is read first, so a record outside the caller's rows is not found, as without `initial`. */
    beforeInitial?: () => Promise<void>;
  },
): Promise<PreparedCommand> {
  const { command, key, catalog } = options;
  const flags = commandFlagsReader(options.flags);
  const signal = options.signal ?? new AbortController().signal;
  const now = options.now ?? (() => new Date());
  const checkCancelled = () => {
    if (signal.aborted) throw new BusinessCommandExecutionError('cancelled');
  };
  if (command.targets === 'none') return readPreparedStart(records, { ...options, flags, signal, now });
  const versionField = versionColumn(catalog[command.target]?.meta.columns);
  const columns = revisionColumns(versionField);
  const found = await records.query({
    table: command.target,
    ...(columns ? { columns } : { binary: true as const }),
    limit: 2,
    offset: 0,
    filter: { groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
  });
  checkCancelled();
  if (!found.rows.length) throw new BusinessCommandExecutionError('not_found');
  const expectedVersion = found.rows.length === 1 ? rowRevision(found.rows[0], versionField) : undefined;
  if (expectedVersion === undefined) throw new BusinessCommandExecutionError('invalid_result');
  const initial = registeredInitial(command);
  if (!preparesInitial(command)) return { expectedVersion };
  await options.beforeInitial?.();
  checkCancelled();
  if (!commandFlagEnabled(command, flags)) throw new BusinessCommandExecutionError('forbidden');
  const pickers = recordPickers(command);
  const starts = preparedStarts(command);
  const conditional = askedWhen(command);
  const questions = definedInputs(command).length > 0;
  if (!initial && !registeredAvailability(command) && !pickers.length && !starts.length && !conditional.length && !questions)
    return { expectedVersion };
  // Reads only: the handler's writes are not the prefill's to make.
  const tx = Object.freeze<Pick<WriteTransaction, 'query' | 'count'>>({
    query: (request) => records.query(request),
    count: (table, filter) => records.count(table, filter),
  });
  const table = catalog[command.target];
  const exact = table && canonicalKey(table, key);
  if (!exact) throw new BusinessCommandExecutionError('not_found');
  const rows = await tx.query({
    table: command.target,
    ...(versionField === undefined ? { binary: true as const } : {}),
    filter: keyFilter(exact),
    limit: 2,
    offset: 0,
  });
  checkCancelled();
  if (rows.rows.length !== 1 || rowRevision(rows.rows[0], versionField) !== expectedVersion)
    throw new BusinessCommandExecutionError('invalid_result');
  const record = normalizeRow(table, rows.rows[0]) as UntypedRow;
  /* `me` in the command's `when` and its inputs' is this actor (commandWhen.ts whenPerson), read once. */
  const me = await whenPerson(tx, options.actor, options.people, [
    command.when,
    ...conditional.map((field) => (field.type === 'group' ? undefined : field.when)),
  ]);
  if (registeredAvailability(command) && command.when !== undefined) {
    const when = compileWhen(table, command.when, now(), me);
    const [named] = keyFilter(exact).groups;
    const groups = when.filter.groups.length ? when.filter.groups.map((group) => [...named, ...group]) : [named];
    const holds = when.derived.size
      ? (await whenHolds(tx, catalog, command.target, when, [record], now()))[0]
      : !when.none && (await tx.count(command.target, { groups })) > 0;
    if (!holds) throw new BusinessCommandExecutionError('ineligible_state');
    checkCancelled();
  }
  const available = await evaluateCommandAvailability({
    command,
    commandId: options.commandId,
    actor: options.actor,
    records: [record],
    catalog,
    reader: tx,
    signal,
    now,
    requestId: options.requestId ?? 'prepare',
    flags,
  });
  if (!available[0]) throw new BusinessCommandExecutionError('forbidden');
  const withheld: string[] = [];
  const said: Record<string, string> = {};
  for (const field of conditional) {
    const bound = await bindRecord(
      field.when,
      `input "${field.name}"`,
      async (comparison) => {
        const [out] = await inputsWithheld(tx, catalog, command.target, [{ name: field.name, when: comparison }], record, now(), me);
        return out === undefined;
      },
      now(),
      command.fields,
    );
    const text = boundText(bound);
    if (text === false) withheld.push(field.name);
    else if (text !== true) said[field.name] = text;
  }
  checkCancelled();
  const asked = {
    ...(withheld.length ? { withheld } : {}),
    ...(Object.keys(said).length ? { when: said } : {}),
    // The questions the record is asked, read as the reader reads them (only a table they read, never one elevated).
    ...(questions ? { defined: await readCommandDefinitions(tx, catalog, command, record) } : {}),
  };
  checkCancelled();
  // Bound to the record as the actor reads it: a column they cannot see narrows to nothing.
  const visible = visibleTargetRow(options.actor, record);
  const choices = pickers.length ? { choices: Object.fromEntries(pickers.map((p) => [p.path, boundRecordQuery(p.query, visible)])) } : {};
  const started = startingValues(
    starts.filter((field) => !withheld.includes(field.name)),
    options.actor,
    visible,
  );
  if (!initial) return { expectedVersion, ...choices, ...asked, ...(Object.keys(started).length ? { initial: started } : {}) };
  const value = await initial(
    Object.freeze({
      actor: options.actor,
      requestId: options.requestId ?? 'prepare',
      commandId: options.commandId,
      version: command.version,
      // The record as the actor reads it: a prefill is shown to them, so it reads
      // only what the caller reads, never a table the command elevates.
      source: command.source,
      signal,
      now,
      flags,
      tx,
      record: visible,
      db: createCommandDb({ tx, catalog, read: callerRead(command), write: [], now }),
    }),
  );
  checkCancelled();
  const given: Record<string, unknown> = { ...started, ...(value ?? {}) };
  // A field this record is not asked starts as nothing, whatever `initial` says of it.
  for (const name of withheld) delete given[name];
  return { expectedVersion, initial: servedInitial(command, given), ...choices, ...asked };
}

/* Each starting value on its own: one the field would refuse (a column grown past its max) is left for the
   reader to fill, rather than failing the whole form. */
function startingValues(
  starts: ReadonlyArray<Exclude<AppCommandField, { type: 'group' }>>,
  actor: BusinessCommandActor,
  record: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const started: Record<string, unknown> = {};
  for (const field of starts) {
    const start = field.default as { record?: string };
    let value = start.record === undefined ? actor.email : record[start.record];
    if (field.type === 'number' && typeof value === 'string' && value.trim() !== '') value = Number(value);
    if (value === null || value === undefined) continue;
    try {
      // Alone, so a bound beside a sibling (`below`) is not judged against a sibling that is not there.
      const { below: _below, above: _above, ...alone } = field as typeof field & { below?: string; above?: string };
      Object.assign(started, readCommandInput([alone as typeof field], { [field.name]: value }, { partial: true }));
    } catch {
      /* left empty */
    }
  }
  return started;
}

/* Served only as the declaration can hold it: the same checks a submission meets, nothing required. */
function servedInitial(command: AnyBusinessCommand, given: Record<string, unknown>): Record<string, unknown> {
  try {
    const detached = JSON.parse(canonicalCommandJson(given)) as unknown;
    return JSON.parse(canonicalCommandJson(readCommandInput(command.fields, detached, { partial: true })));
  } catch {
    throw new BusinessCommandExecutionError('invalid_result');
  }
}

/**
 * A signed-in form's prepare (`targets: 'none'`): no record and so
 * no revision (`expectedVersion` 0, what its submission sends), only its
 * starting values: `default: me`, and `initial` read through the same
 * authorized transaction, reads only, with no `record`.
 */
async function readPreparedStart(
  records: WriteTransaction,
  options: {
    command: AnyBusinessCommand;
    commandId: string;
    actor: BusinessCommandActor;
    key: CommandKey;
    catalog: CommandCatalog;
    signal: AbortSignal;
    now: () => Date;
    flags: ReturnType<typeof commandFlagsReader>;
    requestId?: string;
  },
): Promise<PreparedCommand> {
  const { command, catalog, signal, now, flags } = options;
  // Its envelope names no record, and a prepare is no way to name one.
  if (Object.keys(options.key).length) throw new BusinessCommandExecutionError('invalid_input', 'not_applied', 'key');
  if (!preparesInitial(command)) return { expectedVersion: 0 };
  if (!commandFlagEnabled(command, flags)) throw new BusinessCommandExecutionError('forbidden');
  const started = startingValues(preparedStarts(command), options.actor, {});
  const initial = registeredInitial(command);
  const tx = Object.freeze<Pick<WriteTransaction, 'query' | 'count'>>({
    query: (request) => records.query(request),
    count: (table, filter) => records.count(table, filter),
  });
  // Its questions, where it asks some: those that name no record, as no record is named.
  const asked = definedInputs(command).length ? { defined: await readCommandDefinitions(tx, catalog, command) } : {};
  if (signal.aborted) throw new BusinessCommandExecutionError('cancelled');
  if (!initial) return { expectedVersion: 0, ...(Object.keys(started).length ? { initial: started } : {}), ...asked };
  const value = await initial(
    Object.freeze({
      actor: options.actor,
      requestId: options.requestId ?? 'prepare',
      commandId: options.commandId,
      version: command.version,
      source: command.source,
      signal,
      now,
      flags,
      tx,
      db: createCommandDb({ tx, catalog, read: callerRead(command), write: [], now }),
    }),
  );
  if (signal.aborted) throw new BusinessCommandExecutionError('cancelled');
  return { expectedVersion: 0, initial: servedInitial(command, { ...started, ...(value ?? {}) }), ...asked };
}
