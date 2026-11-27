/* What a command's writes may carry, checked as they are made: a reference inside the command's footprint, bytes
   only in a file resource's column, an audit that fits the journal, and a handler's error with revealed values cut.
   Split out of businessCommandExecution.ts, which runs the command. */
import { COMMAND_TARGET_BOUNDS } from '../../adapters/commands/commandJournalSchema.js';
import { authorFault, refusalCause } from '@mistriwork/engine/shared/refusal.js';
import { BusinessCommandExecutionError } from './commandErrors.js';

type Authorized = import('./businessCommandAccess.js').AuthorizedBusinessCommand;
export const developerError = (cause: string) => authorFault(new BusinessCommandExecutionError('invalid_result'), cause);

/* Why a change could not go into the command's audit, in the author's terms:
   the entry is JSON, so a binary value (a Buffer handed to db.insert) cannot
   be one, and each target's entries are bounded at 64 KiB. Said to the
   operator (refusalReport.ts); the caller hears invalid_result. */
/* What one target's audit may hold is what the journal's column holds. It was 64 KiB, below a single text a
   command may take (65,536 characters, up to 4 bytes each, before and after), so a valid write was refused. */
export const AUDIT_TARGET_BYTES = COMMAND_TARGET_BOUNDS.changes;

export function auditRefusal(command: string, change: Record<string, unknown>): string {
  const where = typeof change.resource === 'string' ? change.resource : 'a resource';
  for (const side of ['values', 'before', 'after']) {
    const image = change[side];
    if (!image || typeof image !== 'object') continue;
    for (const [column, value] of Object.entries(image)) {
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        return (
          `Command "${command}" wrote a binary value to ${where}.${column}; a command's audit keeps JSON values only ` +
          '(text, numbers, booleans, null), so store bytes through a file resource or as text.'
        );
      }
    }
  }
  return (
    `Command "${command}"'s changes to ${where} are over the 4 MiB its audit keeps for one target; ` +
    'write smaller values, or fewer rows per command.'
  );
}

/**
 * A reference a command's write sets must land in the command's footprint
 * (G67): a table it does not read is one whose row nothing proves, which a
 * scoped write refused as a row it could not see — an unexplained retry. The
 * handler's mistake, said as one: invalid_result, never a retry, the table
 * named for the operator, when the scoped write refuses the row — a row its
 * place forbids (a tenant's ownership column set to another tenant) stays
 * forbidden. Only what the write sets is judged: a row's other references
 * were proved when they were written. Said here and not at startup, since a
 * command that names no record may create rows in its target or only update
 * them, and startup cannot tell which (field report R10: an update-only
 * command was refused for not reading every table a new row would point at).
 */
export function footprintFailure(
  commandId: string,
  authorized: Authorized,
  request: { table: string; values: Readonly<Record<string, unknown>> },
): unknown {
  const meta = authorized.catalog?.[request.table]?.meta;
  if (!meta) return;
  const footprint = new Set([...(authorized.command.read ?? []), ...(authorized.command.write ?? [])]);
  for (const column of meta.columns) {
    const to = column.references?.table;
    const value = request.values[column.name];
    if (!to || value === undefined || value === null || footprint.has(to)) continue;
    return developerError(
      `Command "${commandId}" writes ${request.table}.${column.name}, which references "${to}", and does not read "${to}": ` +
        `add "${to}" to the command's read, so the reference is proved against the rows it reads.`,
    );
  }
}

/**
 * Bytes go only into a file resource's content (or thumbnail) column, within
 * its cap — the upload's rule (http/fileRows.ts) — and the audit keeps the
 * file's name, type and size where the bytes were, never the bytes. Returns
 * that stand-in for the audit's after-image; undefined for a row with none.
 */
export function fileInsert(
  commandId: string,
  authorized: Authorized,
  request: { table: string; values: Record<string, unknown> },
): Record<string, unknown> | undefined {
  const binary = Object.entries(request.values).filter(([, value]) => ArrayBuffer.isView(value) || value instanceof ArrayBuffer);
  if (!binary.length) return undefined;
  const rule = authorized.files?.get(request.table);
  if (!rule)
    throw developerError(
      `Command "${commandId}" wrote bytes to ${request.table}.${binary[0][0]}, which is not a file resource it writes: ` +
        "a command stores bytes only through a resource's `file`, with db.<table>.insertFile(file, values).",
    );
  const said: Record<string, unknown> = {};
  for (const [column, value] of binary) {
    if (column !== rule.content && column !== rule.thumbnail)
      throw developerError(
        `Command "${commandId}" wrote bytes to ${request.table}.${column}; a file resource keeps bytes in "${rule.content}"` +
          (rule.thumbnail ? ` and "${rule.thumbnail}"` : '') +
          '.',
      );
    const size = (value as ArrayBufferView | ArrayBuffer).byteLength;
    if (size > rule.maxBytes)
      throw developerError(
        `Command "${commandId}" wrote ${size} bytes to ${request.table}.${column}; the resource takes files up to ${rule.maxBytes} bytes.`,
      );
    said[column] = {
      file: typeof request.values[rule.name] === 'string' ? request.values[rule.name] : null,
      ...(rule.type && typeof request.values[rule.type] === 'string' ? { type: request.values[rule.type] } : {}),
      bytes: size,
    };
  }
  return said;
}

/* A handler that throws with a revealed value in its words would put it on the operator's stderr and in an author's
   answer (refusalReport): the error leaves this call with the value cut from its message, its stack and its reasons. */
export async function withoutRevealed<T>(revealed: Record<string, string>, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const values = Object.values(revealed).filter((value) => value.length >= 4);
    if (values.length && error instanceof Error) {
      const cut = (text: string) => values.reduce((said, value) => said.split(value).join('[sensitive]'), text);
      error.message = cut(error.message);
      if (error.stack) error.stack = cut(error.stack);
      scrubReasons(error, cut);
    }
    throw error;
  }
}

function scrubReasons(error: Error, cut: (text: string) => string): void {
  const seen = new Set<unknown>([error]);
  for (let because = refusalCause(error) ?? error.cause, depth = 0; because instanceof Error && !seen.has(because) && depth < 8; depth++) {
    seen.add(because);
    because.message = cut(because.message);
    if (because.stack) because.stack = cut(because.stack);
    because = refusalCause(because) ?? because.cause;
  }
}

/* A batch update's before images, read in one statement: every row it names, by its key. */
export async function readBatchBeforeImages(
  store: Pick<import('@mistriwork/engine/adapters/adapter.js').WriteTransaction, 'query'>,
  requests: readonly import('@mistriwork/engine/adapters/adapter.js').UpdateRequest[],
): Promise<
  (request: import('@mistriwork/engine/adapters/adapter.js').UpdateRequest) => import('@mistriwork/engine/adapters/adapter.js').QueryResult
> {
  const keyColumns = Object.keys(requests[0]!.key);
  const columns = [...new Set([...keyColumns, ...requests.flatMap((request) => Object.keys(request.values))])];
  const found = await store.query({
    table: requests[0]!.table,
    columns,
    limit: requests.length * 2,
    offset: 0,
    filter: {
      groups: requests.map((request) => Object.entries(request.key).map(([column, value]) => ({ column, op: '=' as const, value }))),
    },
  });
  return (request) => ({
    ...found,
    rows: found.rows.filter((row) => Object.entries(request.key).every(([column, value]) => String(row[column]) === String(value))),
  });
}

export const projectBeforeRow = (row: Record<string, unknown>, columns: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(columns.map((column) => [column, row[column]]));

export function resolveBeforeImage(
  store: Pick<import('@mistriwork/engine/adapters/adapter.js').WriteTransaction, 'query'>,
  request: import('@mistriwork/engine/adapters/adapter.js').UpdateRequest,
  audited: readonly string[],
  seen: import('@mistriwork/engine/adapters/adapter.js').QueryResult | undefined,
  cached: Record<string, unknown> | undefined,
  defer: boolean,
): Promise<{ readonly rows: readonly Record<string, unknown>[] } | undefined> {
  if (seen && seen.rows.every((row) => audited.every((column) => Object.hasOwn(row, column))))
    return Promise.resolve({ rows: seen.rows.map((row) => projectBeforeRow(row, audited)) });
  if (cached && audited.every((column) => Object.hasOwn(cached, column)))
    return Promise.resolve({ rows: [projectBeforeRow(cached, audited)] });
  if (defer) return Promise.resolve(undefined);
  return store.query({
    table: request.table,
    columns: [...audited],
    limit: 2,
    offset: 0,
    filter: { groups: [Object.entries(request.key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
  });
}
