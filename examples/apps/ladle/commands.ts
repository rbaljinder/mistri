// Ladle's one business write, beside its manifest: the App and its check-in page name it by its key and never import
// this module. Server-only.
import { defineCommand, defineCommands, defineSource, refuse, shape, text } from '@mistriwork/mistri/commands';
import type { Rows } from './mistri-schema.d.ts';

const ladle = defineSource<Rows>('ladle');

/* The school's wall clock, the App's `ui.timezone`, to the second: the moment a guest walked in, as the seed writes one. */
const wall = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/* A guest at the door. The booking's machine (app.ts) offers it only while the booking is `booked`; the class must not
   have been called off, which a machine on the booking cannot see, so the handler says so. */
export const checkIn = defineCommand({
  source: ladle,
  target: 'booking',
  read: ['class_session'],
  output: shape({ message: text({ max: 200 }) }),
  async handle({ db, record, now }) {
    const lesson = await db.class_session.get({ id: record.class_session_id });
    if (lesson.status === 'cancelled') refuse(`${lesson.title} was cancelled; there is no class to check in to.`);
    await db.booking.update(record, { status: 'checked_in', checked_in_at: wall.format(now()) });
    const party = record.party_size > 1 ? ` and ${record.party_size - 1} more` : '';
    return { message: `${record.guest_name}${party} checked in to ${lesson.title}.` };
  },
});

export default defineCommands({ checkIn });
