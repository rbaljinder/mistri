// Lintel's source, typed, and what every command shares: how a moment is
// written, who did it, how dollars are said. Server-only: the App graph never
// imports it.
import { defineSource, shape, text } from '@mistriwork/mistri/commands';
import type { Rows } from './mistri-schema.d.ts';

export const lintel = defineSource<Rows>('lintel');

/* Denver's wall clock, the App's `ui.timezone`. A timestamp without a zone is read as written, in that zone: written
   as UTC's clock, a request filed on a Denver evening would read as filed tomorrow. */
const wall = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Denver',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
/** A moment as the seed writes them: Denver's wall clock, to the second. */
export const stamp = (now: () => Date) => wall.format(now());
/** The day in Denver, `YYYY-MM-DD`. */
export const day = (now: () => Date) => stamp(now).slice(0, 10);
/** The month a day falls in, `YYYY-MM`: a charge's period. */
export const period = (date: string) => date.slice(0, 7);
/** Who did it: the account's name, else its email, from the verified session, never a form. */
export const author = (actor: { name?: string; email?: string }) => actor.name ?? actor.email ?? 'Lintel';
/** Cents said as dollars: 182500 → "$1,825.00". */
export const dollars = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
/** A dollar amount a form asked for, in the ledger's whole cents. */
export const cents = (amount: number) => Math.round(amount * 100);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const said = shape({ message: text({ max: 300 }) });
