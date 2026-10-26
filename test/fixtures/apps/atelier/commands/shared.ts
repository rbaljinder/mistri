/* What every Atelier command shares: the source, how a moment is written,
   who did it, the order's two summary words, the stock move that writes the
   ledger. */
import { defineSource, refuse, shape, text, type WriteTable } from '@mistriwork/mistri/commands';
import type { Rows } from '../mistri-schema.d.ts';

export const source = defineSource<Rows>('atelier');

/* A moment as the seed writes it: New York's wall clock to the second. A timestamp column keeps no zone, and a moment
   without one is read as written, in the App's zone (app.ts `timezone`): written as UTC's clock, an order placed in
   a New York evening read as placed tomorrow. */
const wall = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
export const stamp = (now: () => Date) => {
  const part = Object.fromEntries(wall.formatToParts(now()).map(({ type, value }) => [type, value]));
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}:${part.second}`;
};
/** The shop's day, `YYYY-MM-DD`, in New York. */
export const day = (now: () => Date) => stamp(now).slice(0, 10);
/** Who did it: the account's email, from its verified session, never a form. */
export const by = (actor: { email?: string; name?: string }) => actor.email ?? actor.name ?? null;
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const said = shape({ message: text({ max: 300 }) });
export const made = shape({ reference: text({ max: 40 }), message: text({ max: 300 }) });

type StockDb = { inventory_level: WriteTable<Rows['inventory_level']>; inventory_movement: WriteTable<Rows['inventory_movement']> };

/**
 * One line of the ledger and the shelf it moves: `quantity` in (positive) or
 * out (negative) of a variant's stock at a location, never below zero.
 *
 * The level's update is compare-and-set on its version, so two commands that
 * read the same last unit cannot both take it: the second is refused as stale
 * (PostgreSQL) or reads the first one's result (SQLite serializes writers) and
 * is refused here. The table's CHECK (on_hand >= 0) is the last word.
 */
export async function moveStock(
  db: StockDb,
  when: string,
  m: {
    kind: 'received' | 'fulfilled' | 'returned' | 'adjusted';
    variant: Pick<Rows['variant'], 'id' | 'sku'>;
    location: Pick<Rows['location'], 'id' | 'code'>;
    quantity: number;
    reference: string;
    by: string | null;
    reason?: string | null;
    fulfillment_id?: number | null;
    order_return_id?: number | null;
  },
): Promise<number> {
  const level = await db.inventory_level.find({ variant_id: m.variant.id, location_id: m.location.id });
  const before = level ? Number(level.on_hand) : 0;
  const after = before + m.quantity;
  if (after < 0) refuse(`${m.location.code} holds ${before} of ${m.variant.sku}, not ${-m.quantity}.`);
  if (level) await db.inventory_level.update(level, { on_hand: after });
  else await db.inventory_level.insert({ variant_id: m.variant.id, location_id: m.location.id, on_hand: after });
  await db.inventory_movement.insert({
    moved_at: when,
    kind: m.kind,
    variant_id: m.variant.id,
    location_id: m.location.id,
    quantity: m.quantity,
    on_hand_after: after,
    reference: m.reference,
    reason: m.reason ?? null,
    moved_by: m.by,
    fulfillment_id: m.fulfillment_id ?? null,
    order_return_id: m.order_return_id ?? null,
  });
  return after;
}
