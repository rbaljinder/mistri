/**
 * A fixed update applied to a selection, one record at a time.
 *
 * The contract, in one place so every list that offers it says the same
 * thing: a selection is the exact keys of loaded records, never "everything
 * matching"; each record is written through the ordinary update route, gate
 * and journal on its own, so a rejection or a lost acknowledgement on one
 * record neither undoes nor stops the others; and the answer is per record.
 * There is deliberately no whole-selection transaction for a fixed update.
 *
 * The other half, a command declared `targets: 'many'`, is the atomic one:
 * the same exact selection goes in one request, and every record commits or
 * none does. Prepare reads each record's revision and whether it matches the
 * action's `when`; because one ineligible record would refuse the whole
 * request, the form lists those and asks for them to be deselected first.
 * Its answer is one outcome for the group, not one per record.
 */
import { ownedBy } from './requestIdentity.js';
import { api, primaryKey, quote } from './core.js';
import { andQuery } from '@mistriwork/engine/shared/query.js';
import { BULK_LIMIT, commandKeyText } from '@mistriwork/engine/shared/commandWire.js';
import type { AppCommandAction } from '@mistriwork/engine/schema/model.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { recordKey } from './resourceRequests.js';
import { updateAttempts, type UpdateOwner } from './updateAttempts.js';
import { plural } from './locale.js';
import { say } from './copy/lists/bulkActions.js';

/** A selection larger than one loaded page is a filter, not a selection; the server caps a command's key list at the same number. */
export { BULK_LIMIT };

type BulkValues = Record<string, string | number | boolean | null>;
/** One record to write: its key, what the list calls it, and, where the list read them, the values it expects the written columns to still hold (expectedValues). */
export interface BulkTarget {
  key: Record<string, unknown>;
  label: string;
  expected?: BulkValues;
}
type BulkOutcomeKind = 'applied' | 'rejected' | 'uncertain' | 'blocked' | 'skipped';
export interface BulkRecordOutcome extends BulkTarget {
  kind: BulkOutcomeKind;
  message: string;
}
export interface BulkResult {
  outcomes: BulkRecordOutcome[];
  counts: Record<BulkOutcomeKind, number>;
  /** The list stopped being current part-way; the remaining records were skipped, not written. */
  stopped: boolean;
}

/** The opaque, order-stable text of a key: the selection's own word for a record. */
export const bulkKey = (table: TableMeta, key: Record<string, unknown>): string =>
  JSON.stringify((primaryKey(table) as string[]).map((column) => [column, String(key[column])]));

const keyText = (table: TableMeta, key: Record<string, unknown>) =>
  (primaryKey(table) as string[]).map((column) => `${column} = ${quote(String(key[column]))}`).join(' and ');

/**
 * Which of these records satisfy `when` right now, judged by the server in
 * one read. No `when` means all of them. A read that fails matches nothing:
 * an action the server could not vouch for is not offered.
 */
export async function matchingKeys(
  table: TableMeta,
  keys: Record<string, unknown>[],
  when: string | undefined,
  connection?: string | null,
): Promise<Set<string>> {
  if (!keys.length) return new Set();
  if (!when) return new Set(keys.map((key) => bulkKey(table, key)));
  const pk = primaryKey(table) as string[];
  /* The query language takes at most 64 OR branches (a board of four lanes of twenty cards is past it), so the keys
     are asked in runs that fit, at once; a run that fails vouches for none of its keys. */
  const runs: Record<string, unknown>[][] = [];
  for (let at = 0; at < keys.length; at += MATCH_RUN) runs.push(keys.slice(at, at + MATCH_RUN));
  const answers = await Promise.all(
    runs.map(async (run) => {
      const anyOf = run.map((key) => `(${keyText(table, key)})`).join(' or ');
      try {
        const data = await api('/api/run', {
          q: `${table.id} ${andQuery(anyOf, when)} show ${pk.join(', ')}`,
          limit: run.length,
          offset: 0,
          count: 'none',
          ...(connection ? ownedBy(connection) : {}),
        });
        if (!Array.isArray(data.rows) || data.errors?.length) return [];
        return (data.rows as Array<Record<string, unknown>>).map((row) => bulkKey(table, row));
      } catch {
        return [];
      }
    }),
  );
  return new Set(answers.flat());
}
/** Keys asked about in one question: under the query language's 64 OR branches, with room for the condition's own. */
const MATCH_RUN = 48;

/**
 * Apply `values` to each target in order. `isCurrent` is asked before every
 * write: once the list, connection or session has moved on, the rest are
 * skipped and said so — a write nobody is looking at is not a write to make.
 */
export async function applyBulk(
  owner: Pick<UpdateOwner, 'connection' | 'table'>,
  values: BulkValues,
  targets: BulkTarget[],
  isCurrent: () => boolean,
  onProgress?: (done: number, total: number) => void,
): Promise<BulkResult> {
  const outcomes: BulkRecordOutcome[] = [];
  let stopped = false;
  for (const target of targets) {
    if (stopped || !isCurrent()) {
      stopped = true;
      outcomes.push({ ...target, kind: 'skipped', message: say('notWrittenTheList') });
      continue;
    }
    const record: UpdateOwner = { connection: owner.connection, table: owner.table, key: { ...target.key } };
    let key;
    try {
      key = recordKey(record.key);
    } catch (error) {
      outcomes.push({ ...target, kind: 'rejected', message: (error as Error).message });
      continue;
    }
    const outcome = await updateAttempts.run(record, values, () =>
      api('/api/update', {
        ...ownedBy(record.connection),
        table: record.table,
        key,
        values,
        ...(target.expected ? { expected: target.expected } : {}),
      }),
    );
    outcomes.push({ ...target, kind: outcome.kind, message: outcome.kind === 'applied' ? '' : outcome.message });
    onProgress?.(outcomes.length, targets.length);
  }
  const counts: BulkResult['counts'] = { applied: 0, rejected: 0, uncertain: 0, blocked: 0, skipped: 0 };
  for (const outcome of outcomes) counts[outcome.kind]++;
  return { outcomes, counts, stopped };
}

/** One selected record as a bulk command's prepare saw it. */
export interface PreparedTarget {
  key: Record<string, string | number>;
  /** Null when the record is gone or out of this account's reach. */
  expectedVersion: number | null;
  /** Present and matching the action's `when` right now. */
  eligible: boolean;
}

/**
 * Prepare a `targets: 'many'` command for exactly these keys, in this order.
 * The answer is aligned with the request; anything else is refused rather
 * than guessed at, because the versions it carries go into the envelope.
 */
export async function prepareBulkCommand(
  connection: string,
  action: AppCommandAction,
  keys: Array<Record<string, string | number>>,
): Promise<PreparedTarget[]> {
  if (!keys.length || keys.length > BULK_LIMIT) throw new Error(say('selectBetween1And', { max: BULK_LIMIT }));
  const result = await api('/api/commands/prepare', {
    ...ownedBy(connection),
    command: action.command.id,
    commandVersion: action.command.version,
    keys,
  });
  const targets = (result as { targets?: unknown } | null)?.targets;
  if (!Array.isArray(targets) || targets.length !== keys.length) throw new Error(say('theSelectedRecordsCould'));
  return targets.map((raw, index) => {
    const target = raw as { key?: unknown; expectedVersion?: unknown; eligible?: unknown } | null;
    const version = target?.expectedVersion;
    if (
      commandKeyText(target?.key) !== commandKeyText(keys[index]) ||
      (version !== null && !(typeof version === 'number' && Number.isSafeInteger(version) && version >= 0))
    ) {
      throw new Error(say('theSelectedRecordsCould'));
    }
    return { key: keys[index], expectedVersion: version as number | null, eligible: target?.eligible === true && version !== null };
  });
}

/**
 * An action's label said for the records it will take: "Approve timesheet"
 * over two is "Approve 2 timesheets". Only a label that names the record —
 * the resource's noun, one or many, at its end — is counted; any other
 * ("Send reminder") stays as written, beside the count the bar already says.
 */
export function countedLabel(label: string, count: number, noun: { one: string; many: string }): string {
  if (count === 1) return label;
  for (const said of [noun.one, noun.many]) {
    const at = label.length - said.length;
    if (at > 0 && label[at - 1] === ' ' && label.slice(at).toLowerCase() === said.toLowerCase()) {
      return `${label.slice(0, at)}${plural(count, { one: noun.one, other: noun.many })}`;
    }
  }
  return label;
}

/** A bulk command's one outcome, for the whole group: it applied to all, or to none. */
export function bulkCommandSummary(label: string, count: number, kind: 'applied' | 'rejected', message = ''): string {
  const records = say('common.records2', { count });
  return kind === 'applied'
    ? say('labelApplied', { label, count })
    : `${say('labelRefused', { label, records })}${message ? ` ${message}` : ''}`;
}

/** One sentence for the result region: what happened, in the order a reader checks it. */
export function bulkSummary(label: string, result: BulkResult): string {
  const { counts } = result;
  const parts = [say('applied', { applied: counts.applied })];
  if (counts.rejected) parts.push(say('rejected', { rejected: counts.rejected }));
  if (counts.uncertain) parts.push(say('unconfirmed', { uncertain: counts.uncertain }));
  if (counts.blocked) parts.push(say('alreadyPending', { blocked: counts.blocked }));
  if (counts.skipped) parts.push(say('notWritten', { skipped: counts.skipped }));
  return `${label}: ${parts.join(', ')}.`;
}
