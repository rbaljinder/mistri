/**
 * The post stream's examples: a thread as a signed-in member reads it (her
 * own reaction pressed, her own post editable), as an account that has
 * signed in and not joined yet does, and as a signed-out visitor does, at a
 * desk and on a phone. Storybook draws each as a story, and
 * PostStream.test.tsx checks the same ones.
 */
import { example, examples, fixtures } from '@mistriwork/mistri/ui/testing';
import type { Rows } from '../mistri-schema.d.ts';
import { threadPosts } from '../views.ts';
import PostStream from './PostStream.tsx';

/* A picture as a story can carry one: a flat drawing, no file behind it. */
const drawing = (ground: string, mark: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90"><rect width="120" height="90" fill="${ground}"/><rect x="24" y="18" width="72" height="54" rx="4" fill="${mark}"/></svg>`)}`;
const face = (skin: string, shirt: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#e9e4da"/><circle cx="20" cy="16" r="8" fill="${skin}"/><path d="M6 40c2-10 8-14 14-14s12 4 14 14z" fill="${shirt}"/></svg>`)}`;

const post = (
  id: number,
  author: number,
  name: string,
  handle: string,
  team: string,
  created: string,
  body: string,
  extra: Partial<Rows['post']> = {},
) => ({
  id,
  thread_id: 42,
  author_id: author,
  body,
  created_at: created,
  edited_at: null,
  opening: id === 1,
  status: 'published',
  version: 1,
  'author_id.display_name': name,
  'author_id.handle': handle,
  'author_id.team': team,
  ...extra,
});

const rows = {
  post: [
    post(
      1,
      1,
      'Priya Raman',
      'priya',
      'member',
      '2026-09-20T14:02:00Z',
      'Version three of the weather station runs off a single 18650 and a small solar panel, and has survived two months on the roof.\n\n' +
        'It reports temperature, humidity, pressure and wind speed every five minutes over LoRa to a gateway in the garage.',
      { edited_at: '2026-09-21T09:00:00Z' },
    ),
    post(
      2,
      2,
      'Inés Ortega',
      'ines',
      'moderator',
      '2026-09-20T16:40:00Z',
      'This is almost exactly what I want for the garden. Which LoRa module?',
    ),
    post(3, 1, 'Priya Raman', 'priya', 'member', '2026-09-20T18:05:00Z', 'An SX1262 on a breakout. I can share the schematic.'),
  ],
  reaction: [
    { id: 1, post_id: 1, kind: 'like', member_id: 2 },
    { id: 2, post_id: 1, kind: 'like', member_id: 3 },
    { id: 3, post_id: 1, kind: 'helpful', member_id: 2 },
    { id: 4, post_id: 3, kind: 'thanks', member_id: 2 },
  ],
  post_image: [
    { id: 7, post_id: 1, caption: 'Revision two of the board' },
    { id: 8, post_id: 1, caption: 'On the breadboard' },
  ],
  member_avatar: [
    { id: 11, member_id: 1 },
    { id: 12, member_id: 2 },
  ],
  // Who the signed-in reader joined as: Inés.
  member: [{ id: 2 }],
} as { [T in keyof Rows]?: Array<Record<string, unknown>> };
export const data = fixtures(rows);
/* An account that has signed in and not joined: no member row is theirs. */
const newcomer = fixtures({ ...rows, member: [] });

export const files = {
  'member_avatar/11': face('#8a5a3c', '#5b4a8b'),
  'member_avatar/12': face('#c68e6a', '#2f6b5e'),
  'post_image/7': drawing('#23405c', '#2e7d4f'),
  'post_image/8': drawing('#23405c', '#e6e2d6'),
};
const commands = { reactToPost: { label: 'React' }, editPost: { label: 'Edit post' }, replyToThread: { label: 'Reply' } };

export default examples(PostStream, threadPosts, { data, files });

/** Inés, a member, reading at a desk: her like and her thanks pressed, her own post the one she may edit. */
export const Member = example({ width: 900, viewer: { signedIn: true, account: 'acct-ines' }, commands });
/** The same thread on a phone, in the dark. */
export const MemberPhone = example({ width: 360, mode: 'dark', viewer: { signedIn: true, account: 'acct-ines' }, commands });
/** Signed in, not joined: the counts to read, and Join to react and Join to reply in place of the controls. */
export const Newcomer = example({ width: 900, viewer: { signedIn: true, account: 'acct-new' }, commands, data: newcomer });
/** The same newcomer on a phone, in the dark. */
export const NewcomerPhone = example({
  width: 360,
  mode: 'dark',
  viewer: { signedIn: true, account: 'acct-new' },
  commands,
  data: newcomer,
});
/** Signed out: the counts to read, Report the one thing to do. */
export const Visitor = example({ width: 900 });
