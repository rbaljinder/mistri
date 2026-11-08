/**
 * The record a related list of files hangs off, as an upload says it: `parent: { table, key, link? }` beside the
 * file. The list knows its record, so the upload names it once, by key, and the server does the rest — reads the
 * record as this actor (the same grants, and under a row policy the same rows), and writes the link column itself
 * from what it read. A link the body also carries must agree, so a list can never attach a file to a record other
 * than the one it is drawn on, and one it leaves out is no mistake. The rest of an upload's columns are the body's;
 * the ones the file rule `stamps` are the server's (appRecordWrites.ts).
 *
 * An upload that names no parent (a signature, a pasted picture) is what it always was: its values are the body's,
 * and the grant and the row policy judge the insert.
 */
import { primaryKey, type DatabaseSchema, type ForeignKey } from '@mistriwork/engine/shared/schema.js';
import type { QueryRequest, QueryResult } from '@mistriwork/engine/adapters/adapter.js';

/** What an upload's `parent` says: the table of the record, its whole key, and which reference when the file has several. */
export interface UploadParent {
  readonly table: string;
  readonly key: Readonly<Record<string, string | number>>;
  readonly link?: string;
}

type Refused = { status: number; error: string };

const scalar = (value: unknown): value is string | number =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

/** The body's `parent`, or none; a parent that is not that shape is refused, as a stray field is. */
export function readUploadParent(body: Record<string, unknown>): { parent?: UploadParent } | Refused {
  const said = body.parent;
  if (said === undefined) return {};
  const bad = { status: 400, error: "An upload's parent is { table, key, link? }: the record the list is drawn on." };
  if (!said || typeof said !== 'object' || Array.isArray(said)) return bad;
  const { table, key, link, ...stray } = said as Record<string, unknown>;
  if (Object.keys(stray).length || typeof table !== 'string' || !table) return bad;
  if (link !== undefined && (typeof link !== 'string' || !link)) return bad;
  if (!key || typeof key !== 'object' || Array.isArray(key) || !Object.keys(key).length || !Object.values(key).every(scalar)) return bad;
  return { parent: { table, key: key as Record<string, string | number>, ...(link === undefined ? {} : { link }) } };
}

/** The reference from the file's table to the parent's, named by `link` where the file has more than one. */
function referenceTo(schema: DatabaseSchema, file: string, parent: UploadParent): { fk: ForeignKey } | Refused {
  const here = schema.foreignKeys.filter((fk) => fk.from.table === file && fk.to.table === parent.table);
  const named = parent.link === undefined ? here : here.filter((fk) => fk.from.columns.includes(parent.link!));
  if (named.length === 1) return { fk: named[0] };
  return {
    status: 400,
    error: here.length
      ? 'This list could not tell which reference of the file points at its record.'
      : 'This list is not drawn on a record this file points at.',
  };
}

/**
 * The upload's values with the link written from the parent: `read` is the actor's own reader (their grants, their
 * rows), so a record they cannot read is a record they cannot attach a file to, said as an absent one.
 */
export async function bindUploadParent(
  schema: DatabaseSchema,
  file: string,
  parent: UploadParent,
  values: Record<string, unknown>,
  read: (request: QueryRequest) => Promise<QueryResult>,
): Promise<{ values: Record<string, unknown> } | Refused> {
  const table = schema.tables.find((candidate) => candidate.id === parent.table);
  const absent = { status: 404, error: 'No such record to attach a file to.' };
  if (!table) return absent;
  const whole = primaryKey(table);
  if (Object.keys(parent.key).length !== whole.length || whole.some((column) => !Object.hasOwn(parent.key, column))) return absent;
  const found = referenceTo(schema, file, parent);
  if ('error' in found) return found;
  const { fk } = found;
  const row = await read({
    table: table.id,
    filter: { groups: [whole.map((column) => ({ column, op: '=' as const, value: parent.key[column] }))] },
    columns: [...new Set([...whole, ...fk.to.columns])],
    limit: 2,
    offset: 0,
  });
  if (row.rows.length !== 1) return absent;
  const bound: Record<string, unknown> = {};
  for (const [at, column] of fk.from.columns.entries()) {
    const value = row.rows[0][fk.to.columns[at]];
    if (!scalar(value)) return absent;
    const given = values[column];
    if (given !== undefined && given !== null && String(given) !== String(value))
      return { status: 400, error: 'This file belongs to the record the list is drawn on; its values name another.' };
    bound[column] = value;
  }
  return { values: { ...values, ...bound } };
}
