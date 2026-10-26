// The forum's source, typed: what the server-side handlers name as their
// `source`, so each `db` reads the generated rows (mistri-schema.d.ts).
// Server-only: the App graph never imports it.
import { defineSource, refuse } from '@mistriwork/mistri/commands';
import type { Rows } from './mistri-schema.d.ts';

export const forum = defineSource<Rows>('forum');

/* The server clock as the forum stores a moment: `YYYY-MM-DD HH:MM:SS`, New York's wall clock (app.ts `timezone`). A
   timestamp column keeps no zone and a moment without one is read as written, so UTC's clock put an evening post in tomorrow. */
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
export const stamp = (now: Date) => {
  const part = Object.fromEntries(wall.formatToParts(now).map(({ type, value }) => [type, value]));
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}:${part.second}`;
};

/** The member the verified account is, or a sentence saying how to become one.
 *  The account comes from the session, never from anything the form sent. */
export async function memberOf(
  db: { member: { find(where: { account_id: string }): Promise<Rows['member'] | undefined> } },
  actor: { id: string },
) {
  const member = await db.member.find({ account_id: actor.id });
  if (!member) return refuse('Join Commons first: choose Join under Post, then try again.');
  if (member.standing === 'suspended') return refuse('Your account is suspended, so it cannot post.');
  return member;
}

/** Why a post is reported, or hidden: the words a report form and a moderator's decision offer. */
export const REPORT_REASONS = [
  { value: 'spam', label: 'Spam or advertising' },
  { value: 'harassment', label: 'Unkind or harassing' },
  { value: 'off_topic', label: 'Off topic' },
  { value: 'misinformation', label: 'Wrong or unsafe advice' },
  { value: 'other', label: 'Something else' },
] as const;
