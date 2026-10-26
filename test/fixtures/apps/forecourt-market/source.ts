// The marketplace source, typed: what every command names as its `source`, so
// its `db` reads the generated rows (mistri-schema.d.ts). Server-only: the
// App graph never imports it.
import { defineSource } from '@mistriwork/mistri/commands';
import type { Rows } from './mistri-schema.d.ts';

export const market = defineSource<Rows>('market');

/* The marketplace's wall clock, its `ui.timezone`: a timestamp without a zone is said as written, so an inquiry sent
   this evening is written this evening, as the seed's are, and is "today" beside its time. */
const wall = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
/** A timestamp as the seed writes them: New York's wall clock, to the second. */
export const stamp = (now: () => Date) => wall.format(now());
/** A day in New York. */
export const day = (now: () => Date) => stamp(now).slice(0, 10);
/** Who wrote a line of the conversation: the account's name, else its email, from the verified session. */
export const author = (actor: { name?: string; email?: string }) => actor.name ?? actor.email ?? 'Forecourt desk';
/** Dollars as a listing says them. */
export const dollars = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
