/**
 * Prepare for several targets at once: every key's current revision and
 * whether it satisfies the bulk action's `when`, in two reads. A missing or
 * invisible key is reported as ineligible with no revision, never as an
 * error, so a client can list it and let the person deselect it. Preparation
 * reserves nothing: execution still judges visibility per key, and the
 * handler still checks each revision conditionally.
 */
import type { Condition, QueryRequest, QueryResult } from '@mistriwork/engine/adapters/adapter.js';
import { parseQuery, type QueryPerson } from '@mistriwork/engine/shared/query.js';
import { zonedNow } from '../../shared/appZone.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { BusinessCommandExecutionError } from './businessCommandExecution.js';
import { commandKeyText, type CommandKey } from './commandPayload.js';
import { rowRevision } from './commandRevision.js';

export interface PreparedCommandTarget {
  key: CommandKey;
  /** Null when the record is missing or not visible to this account. */
  expectedVersion: number | null;
  /** Found, and matching the bulk action's `when` right now. */
  eligible: boolean;
}

export async function prepareCommandTargets(options: {
  query: (request: QueryRequest) => Promise<QueryResult>;
  schema: DatabaseSchema;
  /** The logical target as the reader names it. */
  table: string;
  keyColumns: readonly string[];
  /** The declared version column, when there is one; without, a revision is the row's digest (commandRevision.ts). */
  versionField?: string;
  keys: readonly CommandKey[];
  /** The App's bulk action condition for this command, if it has one. */
  when?: string;
  /** Who `me` is in `when`: the actor preparing (commandWhen.ts whenPerson); undefined where `when` does not say it. */
  me?: () => Promise<QueryPerson | undefined>;
  now?: Date;
  /** The App's zone: `now` is an instant, and the `when`'s date phrase reads this zone's wall clock, as the list does. */
  zone?: string;
  checkCancelled?: () => void;
}): Promise<{ targets: PreparedCommandTarget[] }> {
  const { keys, keyColumns, versionField, table } = options;
  const exactly = (key: CommandKey): Condition[] => keyColumns.map((column) => ({ column, op: '=' as const, value: key[column] }));
  const identity = (row: Record<string, unknown>) => commandKeyText(Object.fromEntries(keyColumns.map((column) => [column, row[column]])));
  const read = await options.query({
    table,
    ...(versionField === undefined ? { binary: true as const } : { columns: [...new Set([...keyColumns, versionField])] }),
    limit: keys.length + 1,
    offset: 0,
    filter: { groups: keys.map(exactly) },
  });
  options.checkCancelled?.();
  if (read.rows.length > keys.length) throw new BusinessCommandExecutionError('invalid_result');
  const versions = new Map<string, number>();
  for (const row of read.rows) {
    const version = rowRevision(row, versionField),
      text = identity(row);
    if (version === undefined || versions.has(text)) throw new BusinessCommandExecutionError('invalid_result');
    versions.set(text, version);
  }
  const present = keys.filter((key) => versions.has(commandKeyText(key)));
  let eligible = new Set(versions.keys());
  if (options.when && present.length) {
    // The condition was checked when the App loaded. One that no longer
    // parses matches nothing: a verb the server cannot vouch for is not offered.
    // `me` is the person preparing, as it is when the command runs. Without one, a `when` that says `me` does not
    // parse, and nothing is offered.
    const me = await options.me?.();
    const parsed = parseQuery(`${table} ${options.when}`, {
      schema: options.schema,
      now: zonedNow(options.zone, options.now ?? new Date()),
      ...(me ? { me } : {}),
    });
    if (!parsed.query || parsed.errors.length) eligible = new Set();
    else {
      // (key₁ or key₂ …) and (when) as OR-of-ANDs: each key beside each of the condition's groups.
      const condition = parsed.query.filter.groups.length ? parsed.query.filter.groups : [[]];
      const matched = await options.query({
        table,
        columns: [...keyColumns],
        limit: present.length + 1,
        offset: 0,
        filter: { groups: present.flatMap((key) => condition.map((group) => [...exactly(key), ...group])) },
      });
      options.checkCancelled?.();
      eligible = new Set(matched.rows.map(identity));
    }
  }
  return {
    targets: keys.map((key) => {
      const text = commandKeyText(key),
        version = versions.get(text);
      return { key, expectedVersion: version ?? null, eligible: version !== undefined && eligible.has(text) };
    }),
  };
}
