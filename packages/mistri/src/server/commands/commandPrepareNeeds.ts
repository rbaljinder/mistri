/**
 * What a command's prepare has to read, decided from its declaration alone: a picker bound to the record, a field
 * that starts from the record or the reader, an input asked only of some records, `initial`, availability or a
 * `field.defined` input. A leaf, so execution (businessCommandExecution.ts) can ask whether a command prepares
 * without importing prepare, which imports execution's error.
 */
import { readsRecord } from '../../shared/commandDraft.js';
import { commandFieldsDeep, recordColumnsIn, type AppCommandField } from '../../shared/command.js';
import { registeredInitial, registeredAvailability, type AnyBusinessCommand } from './businessCommands.js';
import { definedInputs } from './commandDefined.js';

/* The reference inputs whose picker reads the record (`sales_order_id = record.id`): prepare binds them. */
export const recordPickers = (command: AnyBusinessCommand) =>
  [...commandFieldsDeep(command.fields)].flatMap(({ field, path }) =>
    field.type === 'reference' && field.query && recordColumnsIn(field.query).length ? [{ path, query: field.query }] : [],
  );

/* The fields that start from the record or the reader (`default: { record: 'on_hand' }`, `default: me`): prepare reads them. */
export const preparedStarts = (command: AnyBusinessCommand) =>
  command.fields.filter(
    (field) => field.type !== 'group' && typeof field.default === 'object' && ('record' in field.default || field.default.auto === 'me'),
  ) as Array<Exclude<AppCommandField, { type: 'group' }>>;

/* The inputs asked only of some records (`when: 'record.open_children > 0'`): prepare judges the record's part of
   each, so the form is told which this one is not asked and what is left of the rest to judge over the draft. */
export const askedWhen = (command: AnyBusinessCommand) =>
  command.fields.filter(
    (field) => field.type !== 'group' && field.type !== 'lines' && field.when !== undefined && readsRecord(field.when),
  ) as Array<AppCommandField & { when: string }>;

/** Whether preparing reads a target context (prefill or business eligibility).
 * Keep this internal name compatible with existing host integrations. */
export const preparesInitial = (command: AnyBusinessCommand): boolean =>
  askedWhen(command).length > 0 ||
  command.enabledBy !== undefined ||
  registeredInitial(command) !== undefined ||
  registeredAvailability(command) !== undefined ||
  recordPickers(command).length > 0 ||
  preparedStarts(command).length > 0 ||
  definedInputs(command).length > 0;
