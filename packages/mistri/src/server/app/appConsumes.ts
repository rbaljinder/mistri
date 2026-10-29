/**
 * `consumes` and `restocks`, held where every write of the line passes: the App's write layer
 * (appAccess.ts authorizeTransaction), so Save, a list cell, an import, the
 * App API, MCP, a command's `db`, a flow and a job all move the balance the
 * same way. The rules themselves are the catalog's (shared/appConsumes.ts).
 *
 * The balance moves through the transaction beneath the reader's grants, as a
 * stamp is written: writing the line is the whole authority, and a role still
 * cannot edit the balance itself unless it is granted that field. Each move
 * locks the parent where the engine can, reads the balance and writes the new
 * one with the old as `expected`, so two lines racing for the last unit
 * cannot both take it: one write sees the other's balance or a conflict.
 * Amounts are added as decimals, never as JavaScript numbers, so a NUMERIC
 * balance read as text is moved without rounding.
 */
import type { QueryRequest, WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { ConsumesRule } from '../../shared/appConsumes.js';
import { ConsumesRefused } from './appValidationDenied.js';

/** A line's `consumes` among the App's write rules (appValidation.ts). */
export interface ConsumesWriteRule {
  kind: 'consumes';
  rule: ConsumesRule;
}

/** The `consumes` rules a table's writes hold, out of the App's write rules. */
export function consumesOf(validation: ReadonlyMap<string, readonly unknown[]> | undefined, table: string): ConsumesRule[] {
  return (validation?.get(table) ?? []).flatMap((item) =>
    item && typeof item === 'object' && (item as { kind?: unknown }).kind === 'consumes' ? [(item as ConsumesWriteRule).rule] : [],
  );
}

/** What the refusal may say of the parent: the fields of it the reader may read. */
type ParentReadable = (table: string, column: string) => boolean;

/** The columns of the line a set of rules reads: each reference and amount. */
function consumesColumns(rules: readonly ConsumesRule[]): string[] {
  return [...new Set(rules.flatMap((rule) => [rule.reference, ...(rule.by ? [rule.by] : [])]))];
}

/** The line as the rules read it, through the transaction: undefined when there is no such row. */
export async function consumesImage(
  writer: Pick<WriteTransaction, 'query'>,
  table: string,
  key: Record<string, string | number>,
  rules: readonly ConsumesRule[],
): Promise<Record<string, unknown> | undefined> {
  const found = await writer.query(keyRead(table, key, consumesColumns(rules)));
  return found.rows.length === 1 ? found.rows[0] : undefined;
}

/**
 * Move every balance the line's change asks for: `before` is the line as it
 * was (none for a new one), `after` as it is now (none once removed). A line
 * that keeps its reference moves only the difference; one that changes it
 * gives back to the old record and takes from the new, in key order, so two
 * lines moving between the same pair of records lock them in the same order.
 */
export async function moveConsumed(
  writer: WriteTransaction,
  rules: readonly ConsumesRule[],
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  readable: ParentReadable,
): Promise<void> {
  for (const rule of rules) {
    const moves = new Map<string, { key: string | number; take: Decimal }>();
    const add = (row: Record<string, unknown> | undefined, sign: 1n | -1n) => {
      const key = row?.[rule.reference];
      if (key === null || key === undefined || (typeof key !== 'string' && typeof key !== 'number')) return;
      const amount = rule.by === undefined ? { digits: 1n, scale: 0 } : decimal(row![rule.by]);
      const slot = `${typeof key}:${key}`;
      const held = moves.get(slot)?.take ?? { digits: 0n, scale: 0 };
      moves.set(slot, { key, take: sum(held, { digits: amount.digits * sign, scale: amount.scale }) });
    };
    // A `restocks` line brings in what a `consumes` line takes: the same moves, the other way.
    add(before, rule.gives ? 1n : -1n);
    add(after, rule.gives ? -1n : 1n);
    const ordered = [...moves.values()]
      .filter((move) => move.take.digits !== 0n)
      .sort((a, b) =>
        typeof a.key === 'number' && typeof b.key === 'number' ? a.key - b.key : String(a.key).localeCompare(String(b.key)),
      );
    for (const move of ordered) await take(writer, rule, move.key, move.take, readable);
  }
}

/* Take `amount` from one parent (a negative amount gives it back). Only a take is held to the floor. */
async function take(writer: WriteTransaction, rule: ConsumesRule, key: string | number, amount: Decimal, readable: ParentReadable) {
  const parentKey = { [rule.parentKey]: key };
  if (writer.lockRecord) await writer.lockRecord({ table: rule.parent, key: parentKey });
  const found = await writer.query(keyRead(rule.parent, parentKey, rule.mentions));
  // A reference to no row is the database's to refuse (or an unenforced one's to keep); there is nothing to move.
  if (found.rows.length !== 1) return;
  const parent = found.rows[0];
  const current = parent[rule.balance];
  const next = sum(decimal(current), { digits: -amount.digits, scale: amount.scale });
  if (amount.digits > 0n && rule.floor && next.digits < 0n) throw refusal(rule, parent, readable);
  await writer.update({
    table: rule.parent,
    key: parentKey,
    values: { [rule.balance]: said(next, current) },
    expected: { [rule.balance]: current as string | number | null },
  });
}

function keyRead(table: string, key: Record<string, string | number>, columns: string[]): QueryRequest {
  return {
    table,
    columns,
    filter: { groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
    limit: 2,
    offset: 0,
  };
}

/* The rule's sentence, filled from the parent as it stands: `{part_id.on_hand}`
   is that field of the record the line names, when the reader may read it.
   Any other placeholder is dropped, as a notice's is. */
function refusal(rule: ConsumesRule, parent: Record<string, unknown>, readable: ParentReadable): ConsumesRefused {
  const field = rule.by ?? rule.reference;
  const shown = (column: string) => readable(rule.parent, column) && parent[column] !== undefined && parent[column] !== null;
  if (!rule.message)
    return new ConsumesRefused(
      field,
      shown(rule.balance) ? `Only ${String(parent[rule.balance])} left.` : 'There is not enough left for this.',
    );
  const filled = rule.message
    .replace(/\{\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\}/g, (_, via: string, column: string) =>
      via === rule.reference && shown(column) ? String(parent[column]) : '',
    )
    .replace(/\{[^{}]*\}/g, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return new ConsumesRefused(field, filled || 'There is not enough left for this.');
}

/* ---------- decimals ----------

   An amount as digits and a scale (12.50 is 1250 at scale 2): a NUMERIC
   balance arrives as text on PostgreSQL, and adding it as a float
   would round what the database keeps exactly. */

interface Decimal {
  digits: bigint;
  scale: number;
}

function decimal(value: unknown): Decimal {
  if (value === null || value === undefined || value === '') return { digits: 0n, scale: 0 };
  if (typeof value === 'bigint') return { digits: value, scale: 0 };
  if (typeof value === 'boolean') return { digits: value ? 1n : 0n, scale: 0 };
  const text = typeof value === 'number' ? numberText(value) : String(value).trim();
  const match = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (!match[2] && !match[3])) throw new Error(`consumes: "${text.slice(0, 40)}" is not a number.`);
  const fraction = match[3] ?? '';
  const digits = BigInt(`${match[2] || '0'}${fraction}`);
  return { digits: match[1] === '-' ? -digits : digits, scale: fraction.length };
}

function numberText(value: number): string {
  if (!Number.isFinite(value)) throw new Error('consumes: an amount is not a finite number.');
  const text = String(value);
  return /e/i.test(text) ? value.toFixed(20).replace(/0+$/, '').replace(/\.$/, '') : text;
}

function sum(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return { digits: a.digits * 10n ** BigInt(scale - a.scale) + b.digits * 10n ** BigInt(scale - b.scale), scale };
}

/* The new balance in the shape the old one came in: a number stays a number, text stays text. */
function said(value: Decimal, like: unknown): string | number {
  const negative = value.digits < 0n;
  const digits = (negative ? -value.digits : value.digits).toString().padStart(value.scale + 1, '0');
  const whole = digits.slice(0, digits.length - value.scale);
  const fraction = value.scale ? digits.slice(digits.length - value.scale).replace(/0+$/, '') : '';
  const text = `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
  return typeof like === 'string' ? text : Number(text);
}
