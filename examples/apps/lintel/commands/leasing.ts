/* A lease's road (resources.ts holds it): signed, given notice on, ended.
   Each step moves the home with it in the same transaction, so the rent roll
   never says a home is let while its lease is over. Ending also happens by
   itself: the lease clock (jobs.ts) runs endLease once a notice lease's last
   day has passed (`at: { end_on }`). */
import { defineCommand, field, refuse } from '@mistriwork/mistri/commands';
import { day, lintel, said } from '../source.ts';

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export const signLease = defineCommand({
  source: lintel,
  target: 'lease',
  write: ['unit'],
  output: said,
  async handle({ db, record, now }) {
    const home = await db.unit.get(record.unit_id);
    const other = await db.lease.find(`unit_id = ${home.id} and id != ${record.id} and (status = active or status = notice)`);
    // A home's current lease ends before the next one starts.
    if (other && other.end_on >= record.start_on)
      refuse(`The lease before this one runs to ${other.end_on}; this one starts ${record.start_on}.`);
    await db.lease.update(record, { status: 'active', signed_on: day(now) });
    await db.unit.update(home, { status: other ? home.status : 'occupied', listed: false });
    return { message: `Signed. #${home.number} is let from ${record.start_on}.` };
  },
});

export const giveNotice = defineCommand({
  source: lintel,
  target: 'lease',
  write: ['unit'],
  input: { end_on: field.date({ label: 'Moving out on', help: 'The last day of the lease. Thirty days from today at the earliest.' }) },
  output: said,
  async initial({ record }) {
    return { end_on: record.end_on };
  },
  async handle({ db, record, now }, input) {
    const today = day(now);
    if (input.end_on < addDays(today, 30)) refuse('A lease ends at least thirty days after notice is given.', { field: 'end_on' });
    if (input.end_on > record.end_on) refuse(`The lease runs to ${record.end_on}; notice cannot extend it.`, { field: 'end_on' });
    await db.lease.update(record, { status: 'notice', end_on: input.end_on });
    const home = await db.unit.get(record.unit_id);
    await db.unit.update(home, { status: 'notice', available_on: addDays(input.end_on, 14) });
    return { message: `Notice recorded. The lease ends ${input.end_on}.` };
  },
});

/* The last day has passed, or the desk ends it early: the home goes to turnover, ready in two weeks. */
export const endLease = defineCommand({
  source: lintel,
  target: 'lease',
  write: ['unit'],
  output: said,
  async handle({ db, record, now }) {
    const today = day(now);
    const home = await db.unit.get(record.unit_id);
    await db.lease.update(record, { status: 'ended', end_on: record.end_on < today ? record.end_on : today });
    await db.unit.update(home, { status: 'turnover', listed: false, available_on: addDays(today, 14) });
    return { message: `The lease on #${home.number} has ended; the home is in turnover.` };
  },
});
