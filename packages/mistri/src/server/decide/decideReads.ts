/**
 * What a decision reads, and how: through its answer command, authorized as
 * the decision's principal, in that command's catalog — its footprint's
 * tables, under the same grants, row scope and tenant lease as running it
 * would read them (design §4: "inputs and choices read through the dispatcher
 * as runAs"). A read for advice where the binding has one (no transaction, no
 * writer), else the command's own transaction, which writes nothing.
 *
 * One read a record: the target's row (its inputs, the column each decision
 * answers, and its key), each label path's hops, each rollup or computed
 * input, and each reference answer's choices — at most 200, as `runAs` may
 * read them.
 */
import { createHash } from 'node:crypto';
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { canonicalCommandJson } from '../commands/commandPayload.js';
import { compileWhere, keyFilter, normalizeRow, type CommandCatalog } from '../commands/commandDb.js';
import { derivedValue } from '../commands/commandWhen.js';
import type { AuthorizedBusinessCommand } from '../commands/businessCommandAccess.js';
import type { DecisionAnswerSpec, DecisionReads } from './decisionChecks.js';
import type { DecisionAnswerType } from './providers/decisionProvider.js';
import type { DecisionKey } from './decisionModule.js';

/** At most this many choices are offered for a reference answer. */
const MAX_CHOICES = 200;

type Reader = Pick<WriteTransaction, 'query' | 'count'>;

/** One decision of a record's read: what it reads, the column it answers, and its answer's type. */

/**
 * Reads as the decision's principal, writing nothing: through the source's own reads where the binding offers them,
 * else in a transaction. A row policy's binding opens no plain transaction, only its command's, scoped to the service's
 * rows; these reads write nothing in it and leave its journal alone.
 */
const readsAs =
  (authorized: AuthorizedBusinessCommand) =>
  <T>(work: (tx: Reader) => Promise<T>): Promise<T> =>
    authorized.advise
      ? authorized.advise(work)
      : authorized.readsInCommand && authorized.commandTransaction
        ? inCommand(authorized.commandTransaction, work)
        : authorized.transaction((tx) => work(tx));

/* What a read found leaves the command transaction beside it, not through it: a tenant's transaction hands back only
   plain data it can capture (tenantCommandTransaction.ts), and a record's read holds maps. Nothing is returned through
   the transaction, so it has nothing to check and nothing to commit. */
async function inCommand<T>(
  commandTransaction: NonNullable<AuthorizedBusinessCommand['commandTransaction']>,
  work: (tx: Reader) => Promise<T>,
): Promise<T> {
  let found: { value: T } | undefined;
  await commandTransaction(async (tx) => {
    found = { value: await work(tx) };
    return null;
  });
  return found!.value;
}

export interface PlannedDecision {
  readonly name: string;
  readonly field: string;
  readonly reads: DecisionReads;
  readonly spec: DecisionAnswerSpec;
}

/** What one record's read found. */
export interface RecordRead {
  /** The record's key, exact, and as the store keeps it (canonical JSON). */
  readonly key: Readonly<Record<string, string | number>>;
  readonly recordKey: string;
  /** Each decision's inputs, by name, as JSON values. */
  readonly inputs: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  /** Each decision's answer column as the record holds it now. */
  readonly current: ReadonlyMap<string, unknown>;
  /** Each decision's answer type, a reference's choices read. */
  readonly answers: ReadonlyMap<string, DecisionAnswerType>;
  /** A digest of the choices offered, '' when none. */
  readonly choicesDigest: ReadonlyMap<string, string>;
}

/** A value as it is sent: JSON, with a large integer as its digits and bytes as nothing. */
function sendable(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return null;
  if (typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return null;
    }
  }
  return value;
}

/** The store's spelling of a record's key: its columns, sorted, as canonical JSON. */
export const recordKeyText = (key: Readonly<Record<string, string | number>>): string => canonicalCommandJson(key, 4096);

/** A SHA-256 of canonical JSON: what a row keeps in place of the values sent. */
export const digestOf = (value: unknown): string =>
  createHash('sha256')
    .update(canonicalCommandJson(value, 4 * 1024 * 1024))
    .digest('hex');

/** The local name of a logical table in the command's catalog, or undefined when the command does not read it. */
export type LocalName = (logical: string) => string | undefined;

/**
 * Read one record for its decisions, as the authorized command reads. Undefined when the record is not there (or
 * not the principal's to read): no decision is made of a record its principal cannot see.
 */
export async function readRecord(
  authorized: AuthorizedBusinessCommand,
  local: LocalName,
  planned: readonly PlannedDecision[],
  key: DecisionKey,
  now: Date,
): Promise<RecordRead | undefined> {
  const run = readsAs(authorized);
  const catalog = authorized.catalog;
  const target = authorized.command.target;
  const table = catalog[target];
  if (!table) return undefined;
  return run(async (tx) => {
    const columns = new Set<string>(table.key);
    for (const decision of planned) {
      columns.add(decision.field);
      for (const input of decision.reads.inputs) if (input.kind === 'column') columns.add(input.input);
      for (const input of decision.reads.inputs) if (input.kind === 'path') columns.add(input.hops[0].column);
    }
    const found = await tx.query({
      table: target,
      columns: [...columns].filter((column) => Object.hasOwn(table.kinds, column)),
      filter: keyFilter(key),
      limit: 1,
      offset: 0,
    });
    if (!found.rows.length) return undefined;
    const row = normalizeRow(table, found.rows[0]);
    const exact = Object.fromEntries(table.key.map((column) => [column, row[column] as string | number]));
    const inputs = new Map<string, Record<string, unknown>>();
    const current = new Map<string, unknown>();
    const answers = new Map<string, DecisionAnswerType>();
    const digests = new Map<string, string>();
    const derived = new Map<string, unknown>();
    const paths = new Map<string, unknown>();
    for (const decision of planned) {
      const values: Record<string, unknown> = {};
      for (const input of decision.reads.inputs) {
        if (input.kind === 'column') values[input.input] = sendable(row[input.input]);
        else if (input.kind === 'derived') {
          if (!derived.has(input.input)) derived.set(input.input, sendable(await derivedValue(tx, catalog, target, row, input.input, now)));
          values[input.input] = derived.get(input.input);
        } else {
          if (!paths.has(input.input)) paths.set(input.input, await followPath(tx, catalog, local, row[input.hops[0].column], input));
          values[input.input] = paths.get(input.input);
        }
      }
      inputs.set(decision.name, values);
      current.set(decision.name, sendable(row[decision.field]));
      const { type, digest } = await answerType(tx, catalog, local, decision.spec, now);
      answers.set(decision.name, type);
      digests.set(decision.name, digest);
    }
    return { key: exact, recordKey: recordKeyText(exact), inputs, current, answers, choicesDigest: digests };
  });
}

/** A label path, hop by hop: each reference read by its key in the table it names, the last hop's column the value. */
async function followPath(
  tx: Reader,
  catalog: CommandCatalog,
  local: LocalName,
  first: unknown,
  input: Extract<DecisionReads['inputs'][number], { kind: 'path' }>,
): Promise<unknown> {
  let value = first;
  for (let index = 0; index < input.hops.length; index++) {
    if (value === null || value === undefined) return null;
    const hop = input.hops[index];
    const name = local(hop.table);
    if (!name || !catalog[name]) return null;
    const next = index + 1 < input.hops.length ? input.hops[index + 1].column : input.column;
    const found = await tx.query({
      table: name,
      columns: [next],
      filter: { groups: [[{ column: hop.by, op: '=', value: value as string | number }]] },
      limit: 1,
      offset: 0,
    });
    if (!found.rows.length) return null;
    value = normalizeRow(catalog[name], found.rows[0])[next];
  }
  return sendable(value);
}

/** The answer's type as the provider is told it: a reference's choices read now, as the principal reads them. */
async function answerType(
  tx: Reader,
  catalog: CommandCatalog,
  local: LocalName,
  spec: DecisionAnswerSpec,
  now: Date,
): Promise<{ type: DecisionAnswerType; digest: string }> {
  switch (spec.kind) {
    case 'choice':
      return { type: { kind: 'choice', options: spec.options }, digest: '' };
    case 'bool':
      return { type: { kind: 'bool' }, digest: '' };
    case 'number': {
      const { kind: _kind, ...range } = spec;
      return { type: { kind: 'number', ...range }, digest: '' };
    }
    case 'reference':
    case 'references': {
      const name = local(spec.from) ?? (catalog[spec.from] ? spec.from : undefined);
      const table = name ? catalog[name] : undefined;
      const choices: Array<{ key: string | number; label: string }> = [];
      if (table) {
        const where = spec.query ? compileWhere(table, spec.query, now) : undefined;
        if (!where?.none) {
          const found = await tx.query({
            table: name!,
            columns: [...new Set([spec.by, spec.labelColumn])],
            ...(where ? { filter: where.filter } : {}),
            orderBy: [{ column: spec.labelColumn, direction: 'asc' }],
            limit: MAX_CHOICES,
            offset: 0,
          });
          for (const row of found.rows) {
            const key = row[spec.by];
            if (typeof key === 'string' || typeof key === 'number') choices.push({ key, label: String(row[spec.labelColumn] ?? key) });
            else if (typeof key === 'bigint') choices.push({ key: key.toString(), label: String(row[spec.labelColumn] ?? key) });
          }
        }
      }
      const type: DecisionAnswerType =
        spec.kind === 'reference' ? { kind: 'reference', choices } : { kind: 'references', choices, max: spec.max };
      return { type, digest: choices.length ? digestOf(choices) : '' };
    }
  }
}

/** Whether the record still holds what the decision read in its answer column: the stale guard's reading. */
export async function readCurrent(
  authorized: AuthorizedBusinessCommand,
  key: Readonly<Record<string, string | number>>,
  fields: readonly string[],
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const run = readsAs(authorized);
  const table = authorized.catalog[authorized.command.target];
  if (!table) return undefined;
  return run(async (tx) => {
    const found = await tx.query({
      table: authorized.command.target,
      columns: [...new Set(fields)],
      filter: keyFilter(key),
      limit: 1,
      offset: 0,
    });
    if (!found.rows.length) return undefined;
    const row = normalizeRow(table, found.rows[0]);
    return Object.fromEntries(fields.map((field) => [field, sendable(row[field])]));
  });
}

/** The keys of the records a clock decision is due on: `where`, in key order, at most `limit`. */
export async function readDue(
  authorized: AuthorizedBusinessCommand,
  where: string | undefined,
  limit: number,
  now: Date,
): Promise<Array<Readonly<Record<string, string | number>>>> {
  const run = readsAs(authorized);
  const target = authorized.command.target;
  const table = authorized.catalog[target];
  if (!table) return [];
  const compiled = where ? compileWhere(table, where, now) : undefined;
  if (compiled?.none) return [];
  return run(async (tx) => {
    const found = await tx.query({
      table: target,
      columns: [...table.key],
      ...(compiled ? { filter: compiled.filter } : {}),
      orderBy: table.key.map((column) => ({ column, direction: 'asc' as const })),
      limit,
      offset: 0,
    });
    return found.rows.map((row) => Object.fromEntries(table.key.map((column) => [column, row[column] as string | number])));
  });
}

/** Whether two answers are the same value: a list by its keys in any order, a key by its text. */
export function sameAnswer(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const left = a.map(String).sort(),
      right = b.map(String).sort();
    return left.every((each, index) => each === right[index]);
  }
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b || String(a) === String(b);
  return String(a) === String(b);
}

/** Whether a column holds nothing: a decision fills an empty field, and only suggests beside a filled one. */
export const isEmpty = (value: unknown): boolean =>
  value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
