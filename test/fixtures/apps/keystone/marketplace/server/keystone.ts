// The one source, typed: what every handler names as its `source`, so its
// `db` reads the generated rows. Server-only: the App graph never imports it.
import { randomInt } from 'node:crypto';
import type { ReadTable, WriteTable } from '@mistriwork/mistri/commands';
import { defineSource } from '@mistriwork/mistri/commands';
import type { Rows } from '../mistri-schema.d.ts';

export const keystone = defineSource<Rows>('keystone');

type Row<T extends keyof Rows> = Rows[T];

/** A moment as the schema stores it: `timestamp` in UTC, without a zone. */
export const stamp = (now: Date) => now.toISOString().slice(0, 19).replace('T', ' ');

/** A car the marketplace may put a buyer in touch about: listed or pending, at a dealer Keystone lends through today. */
export async function carForSale(
  db: { vehicle: ReadTable<Row<'vehicle'>>; dealer: ReadTable<Row<'dealer'>> },
  id: string | null | undefined,
) {
  if (!id) return undefined;
  const car = await db.vehicle.find({ id });
  if (!car || (car.status !== 'listed' && car.status !== 'pending')) return undefined;
  const dealer = await db.dealer.find({ id: car.dealer_id });
  return dealer?.status === 'active' ? car : undefined;
}

/**
 * A new lead in the car's own dealer, the way /leads reads one: an `LD-`
 * reference, an id scoped by dealer and source `marketplace`; from the public
 * form, a line on its timeline with the receipt the buyer was given. (A signed-in
 * command cannot write that line: under the row policy a table no account owns
 * admits no row, so the insert is refused. Its lead carries the account instead.) The dealer is read from the car, never
 * typed (SUITE.md, cross-App flows).
 *
 * The reference is six random digits, not the dealer's next number: under a
 * row policy a command reads only the rows its principal may, so a customer's
 * command cannot see the dealer's other leads to count past them, and a
 * counted guess collides with the unique (dealer_id, reference) index. The
 * index stays the backstop; at a dealer's volume a collision is a retry.
 */
export async function newMarketplaceLead(
  db: { lead: WriteTable<Row<'lead'>>; lead_activity?: WriteTable<Row<'lead_activity'>> },
  car: Row<'vehicle'>,
  now: Date,
  person: { first_name: string; last_name: string; email: string; phone?: string | null; message: string; account?: string | null },
  note?: string,
) {
  const number = String(randomInt(100000, 1000000));
  const at = stamp(now);
  const lead = await db.lead.insert({
    id: `${car.dealer_id}-lead-m${number}`,
    dealer_id: car.dealer_id,
    reference: `LD-${number}`,
    source: 'marketplace',
    status: 'new',
    vehicle_id: car.id,
    first_name: person.first_name,
    last_name: person.last_name,
    email: person.email,
    phone: person.phone ?? null,
    message: person.message,
    marketplace_account_id: person.account ?? null,
    created_at: at,
  });
  if (db.lead_activity && note)
    await db.lead_activity.insert({ dealer_id: car.dealer_id, lead_id: lead.id, kind: 'note', body: note, created_at: at });
  return lead;
}
