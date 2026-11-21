/**
 * A resource's `frozen` condition (appModel.ts) as a command meets it: judged of the row as it is stored now, in the
 * command's own transaction, so a row the condition matches takes no change, no removal and no command, whoever
 * runs it. The row a write names is judged by its key; the incoming values are never read, so a write that sets a
 * row into the condition is allowed and the next is refused.
 */
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { QueryPerson } from '@mistriwork/engine/shared/query.js';
import { BusinessCommandExecutionError } from './commandErrors.js';
import { canonicalKey, keyFilter, normalizeRow, type CommandCatalog } from './commandDb.js';
import { compileWhen, whenHolds } from './commandWhen.js';
import { recordRefusalCause } from '@mistriwork/engine/shared/refusal.js';

/** The rule of one table: its condition and the sentence a refusal says (businessCommandAuthorization.ts). */
type CommandFrozenRule = Readonly<{ text: string; said: string }>;

/** Whether the stored row at `key` of `table` (a local name) is frozen; a row that is not there is not. */
export async function rowFrozen(
  reader: Pick<WriteTransaction, 'query' | 'count'>,
  catalog: CommandCatalog,
  table: string,
  key: Readonly<Record<string, unknown>>,
  rule: CommandFrozenRule,
  now: Date,
  me?: QueryPerson,
  /** The row, where the caller holds it already (a target read in this transaction). */
  held?: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  const entry = catalog[table];
  if (!entry) return false;
  let when: ReturnType<typeof compileWhen>;
  try {
    when = compileWhen(entry, rule.text, now, me);
  } catch (error) {
    /* A condition this catalog cannot judge is refused, never passed: a write the rule might freeze is not made. The
       check names it before the App starts, so this is a catalog that lost a column since. */
    throw recordRefusalCause(
      new BusinessCommandExecutionError('invalid_result'),
      `The frozen condition "${rule.text}" of "${table}" could not be judged: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (when.none) return false;
  const exact = canonicalKey(entry, key as never);
  if (!exact) return false;
  let row = held ?? (key as Readonly<Record<string, unknown>>);
  if (when.derived.size && !held) {
    const found = await reader.query({ table, filter: keyFilter(exact), limit: 2, offset: 0 });
    if (found.rows.length !== 1) return false;
    row = normalizeRow(entry, found.rows[0]) as Readonly<Record<string, unknown>>;
  }
  const [holds] = await whenHolds(reader, catalog, table, when, [row], now);
  return holds === true;
}

/** Refuses a change to, or a removal of, a frozen row: 409 `frozen`, in the sentence that names the resource and the condition. */
export async function assertWriteNotFrozen(
  rules: ReadonlyMap<string, CommandFrozenRule> | undefined,
  reader: Pick<WriteTransaction, 'query' | 'count'>,
  catalog: CommandCatalog,
  table: string,
  key: Readonly<Record<string, unknown>>,
  now: Date,
  me?: () => Promise<QueryPerson | undefined>,
): Promise<void> {
  const rule = rules?.get(table);
  if (!rule) return;
  if (await rowFrozen(reader, catalog, table, key, rule, now, await me?.()))
    throw new BusinessCommandExecutionError('frozen', 'not_applied', undefined, undefined, rule.said);
}
