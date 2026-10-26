/**
 * Questions defined in rows, as a command asks them (`field.defined`): the rows of `from` with the columns a row-defined field's have
 * (shared/definedFields.ts), those `whose` names the command's record by and
 * those that name none. Prepare reads them for the form to draw, and the
 * command's own transaction reads them again where it runs, so the answers
 * are judged against the questions as they stand when they are written —
 * not as the form saw them — and in the reader's tenant, through the same
 * scoped reads as the handler's.
 */
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { AppCommandField } from '../../shared/command.js';
import { DEFINITIONS_MOST, type DefinedField } from '@mistriwork/engine/shared/definedFields.js';
import {
  DEFINED_REASONS,
  definedBreaks,
  definitionColumns,
  definitionFilter,
  readDefinitions,
} from '@mistriwork/engine/shared/definedValues.js';
import type { AnyBusinessCommand } from './businessCommands.js';
import type { CommandCatalog, UntypedRow } from './commandDb.js';

type DefinedInput = Extract<AppCommandField, { type: 'defined' }>;

/** The command's inputs whose questions are rows. */
export const definedInputs = (command: AnyBusinessCommand): DefinedInput[] =>
  command.fields.filter((field): field is DefinedInput => field.type === 'defined');

/** Each defined input's questions, by input name, for this record (none for a command that names no record). */
export async function readCommandDefinitions(
  reader: Pick<WriteTransaction, 'query'>,
  catalog: CommandCatalog,
  command: AnyBusinessCommand,
  record?: Readonly<UntypedRow>,
): Promise<Record<string, DefinedField[]>> {
  const read: Record<string, DefinedField[]> = {};
  for (const field of definedInputs(command)) {
    const from = catalog[field.from];
    // The footprint holds every table the command reads, by the definition check (businessCommands.ts).
    if (!from) throw new Error(`Command input "${field.name}" asks the questions in "${field.from}", which its footprint does not hold.`);
    // The record's own key is what `whose` holds: one column, by the catalog check (shared/command.ts).
    const key = field.whose === undefined ? undefined : catalog[command.target]?.key;
    const value = key?.length === 1 && record ? record[key[0]] : undefined;
    const filter = definitionFilter(field.whose, value);
    const rows = await reader.query({
      table: field.from,
      columns: definitionColumns(from.meta, field.whose),
      ...(filter ? { filter } : {}),
      limit: DEFINITIONS_MOST,
      offset: 0,
    });
    read[field.name] = readDefinitions(rows.rows, field.whose);
  }
  return read;
}

/**
 * The answers judged against the questions read in the command's own
 * transaction: a required one left empty, a value of the wrong kind, a choice
 * outside the list, or a key no question asks. The first break, by its path
 * (`answers.os`) and the fixed sentence the record page says it with, which
 * the executor refuses as invalid input; undefined when every answer holds.
 */
export async function definedAnswerBreak(
  reader: Pick<WriteTransaction, 'query'>,
  catalog: CommandCatalog,
  command: AnyBusinessCommand,
  input: unknown,
  record?: Readonly<UntypedRow>,
): Promise<{ path: string; reason: string } | undefined> {
  if (!definedInputs(command).length) return undefined;
  const given = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const questions = await readCommandDefinitions(reader, catalog, command, record);
  for (const [name, fields] of Object.entries(questions)) {
    const answers = given[name] && typeof given[name] === 'object' ? (given[name] as Record<string, unknown>) : {};
    const [broken] = definedBreaks(fields, answers, { extras: true });
    if (broken) return { path: `${name}.${broken.key}`, reason: DEFINED_REASONS[broken.reason] };
  }
  return undefined;
}

type SourcedInput = Extract<AppCommandField, { type: 'choice' | 'choices' }> & {
  source: NonNullable<Extract<AppCommandField, { type: 'choice' }>['source']>;
};

/** The command's choices offered from a table's rows (`field.choice({ from, label })`), at the input's top level. */
const sourcedInputs = (command: AnyBusinessCommand): SourcedInput[] =>
  command.fields.filter(
    (field): field is SourcedInput => (field.type === 'choice' || field.type === 'choices') && field.source !== undefined,
  );

/**
 * A choice from a table judged in the command's own transaction: each key given must name a row of `from` the
 * reader may read there (the same scoped read the handler's are), so a key the form never offered — another
 * tenant's, a row the policy hides, one deleted since — is refused at its field, as a choice outside a list is.
 * Always read here, by the key column, never answered from the form's cache (forms/choiceCache.ts): that cache draws
 * the form; it does not admit a submission.
 */
export async function sourcedChoiceBreak(
  reader: Pick<WriteTransaction, 'query'>,
  command: AnyBusinessCommand,
  input: unknown,
): Promise<{ path: string; reason: string } | undefined> {
  const given = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  for (const field of sourcedInputs(command)) {
    const value = given[field.name];
    const keys = (Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value]).filter(
      (key): key is string | number => typeof key === 'string' || typeof key === 'number',
    );
    if (!keys.length) continue;
    const unique = [...new Set(keys)];
    const rows = await reader.query({
      table: field.source.from,
      columns: [field.source.by],
      filter: { groups: [[{ column: field.source.by, op: 'in', value: unique }]] },
      limit: unique.length + 1,
      offset: 0,
    });
    const found = new Set(rows.rows.map((row) => String(row[field.source.by])));
    if (unique.some((key) => !found.has(String(key)))) return { path: field.name, reason: 'This is not one of the choices.' };
  }
  return undefined;
}
