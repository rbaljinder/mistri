// What a moderator's decisions do. Server-only, registered through
// commands.ts. The bulk ones take the whole selection in one transaction: a
// queue's Approve or Hide commits for every selected post or for none.
import { defineCommand, field, literal, refuse, shape } from '@mistriwork/mistri/commands';
import { forum, REPORT_REASONS, stamp } from './forum.ts';

/** What a removed post says in its place. Its words are kept in `removal`, which only moderators read. */
export const REMOVED = 'This post was removed by the moderators.';

export const approvePost = defineCommand({
  source: forum,
  target: 'post',
  targets: 'many',
  write: ['thread', 'report'],
  when: 'status = held',
  output: shape({ message: literal('Approved.') }),
  async handle({ db, records, now }) {
    for (const post of records) {
      await db.post.update(post, { status: 'published' });
      // A held thread opens with its first post.
      if (post.opening) {
        const thread = await db.thread.get({ id: post.thread_id });
        if (thread.status === 'held') await db.thread.update(thread, { status: 'open' });
      }
      for (const report of await db.report.where({ post_id: post.id, status: 'open' }).limit(100)) {
        await db.report.update(report, { status: 'dismissed', resolved_at: stamp(now()), resolution: 'Approved by a moderator.' });
      }
    }
    return { message: 'Approved.' as const };
  },
});

export const hidePost = defineCommand({
  source: forum,
  target: 'post',
  targets: 'many',
  write: ['removal', 'thread', 'report'],
  input: {
    reason: field.choice(REPORT_REASONS, { label: 'Why it is being removed' }),
    note: field.textarea({ label: 'Note for the moderators', max: 500, optional: true }),
  },
  when: 'status != hidden',
  output: shape({ message: literal('Hidden.') }),
  async handle({ db, records, actor, now }, input) {
    const at = stamp(now());
    for (const post of records) {
      // The words leave the post for the moderators' own record; the post keeps its place in the thread.
      await db.removal.insert({
        post_id: post.id,
        reason: input.reason,
        body: post.body,
        note: input.note ?? null,
        removed_by: actor.id,
        removed_at: at,
      });
      await db.post.update(post, { status: 'hidden', body: REMOVED });
      // Removing a thread's first post removes the thread from the lists.
      if (post.opening) {
        const thread = await db.thread.get({ id: post.thread_id });
        await db.thread.update(thread, { status: 'removed', pinned: false });
      }
      for (const report of await db.report.where({ post_id: post.id, status: 'open' }).limit(100)) {
        await db.report.update(report, { status: 'actioned', resolved_at: at, resolution: input.note ?? 'Removed by a moderator.' });
      }
    }
    return { message: 'Hidden.' as const };
  },
});

export const restorePost = defineCommand({
  source: forum,
  target: 'post',
  read: ['removal'],
  write: ['thread'],
  when: 'status = hidden',
  output: shape({ message: literal('Restored.') }),
  async handle({ db, record }) {
    const removal =
      (await db.removal.where({ post_id: record.id }).orderBy('removed_at', 'desc').first()) ??
      refuse('There is no record of this post’s words, so it cannot be restored.');
    await db.post.update(record, { status: 'published', body: removal.body });
    if (record.opening) {
      const thread = await db.thread.get({ id: record.thread_id });
      if (thread.status === 'removed') await db.thread.update(thread, { status: 'open' });
    }
    return { message: 'Restored.' as const };
  },
});

/* Remove from the reports queue: each selected report's post is hidden as
   Hide hides it, and every open report on it is closed as actioned. Two
   reports on one post remove it once. */
export const removeReportedPost = defineCommand({
  source: forum,
  target: 'report',
  targets: 'many',
  write: ['post', 'removal', 'thread'],
  input: { note: field.textarea({ label: 'Note for the moderators', max: 500, optional: true }) },
  when: 'status = open',
  output: shape({ message: literal('Removed.') }),
  async handle({ db, records, actor, now }, input) {
    const at = stamp(now());
    const done = new Set<number>();
    for (const report of records) {
      if (done.has(report.post_id)) continue;
      done.add(report.post_id);
      const post = await db.post.get({ id: report.post_id });
      if (post.status !== 'hidden') {
        await db.removal.insert({
          post_id: post.id,
          reason: report.reason,
          body: post.body,
          note: input.note ?? report.details,
          removed_by: actor.id,
          removed_at: at,
        });
        await db.post.update(post, { status: 'hidden', body: REMOVED });
        if (post.opening) {
          const thread = await db.thread.get({ id: post.thread_id });
          await db.thread.update(thread, { status: 'removed', pinned: false });
        }
      }
      for (const open of await db.report.where({ post_id: post.id, status: 'open' }).limit(100)) {
        await db.report.update(open, { status: 'actioned', resolved_at: at, resolution: input.note ?? 'Removed by a moderator.' });
      }
    }
    return { message: 'Removed.' as const };
  },
});

export const lockThread = defineCommand({
  source: forum,
  target: 'thread',
  targets: 'many',
  when: 'status = open',
  output: shape({ message: literal('Locked.') }),
  async handle({ db, records }) {
    for (const thread of records) await db.thread.update(thread, { status: 'locked' });
    return { message: 'Locked.' as const };
  },
});

export const unlockThread = defineCommand({
  source: forum,
  target: 'thread',
  targets: 'many',
  when: 'status = locked',
  output: shape({ message: literal('Unlocked.') }),
  async handle({ db, records }) {
    for (const thread of records) await db.thread.update(thread, { status: 'open' });
    return { message: 'Unlocked.' as const };
  },
});

export const pinThread = defineCommand({
  source: forum,
  target: 'thread',
  targets: 'many',
  when: 'pinned = false',
  output: shape({ message: literal('Pinned.') }),
  async handle({ db, records }) {
    for (const thread of records) await db.thread.update(thread, { pinned: true });
    return { message: 'Pinned.' as const };
  },
});

export const unpinThread = defineCommand({
  source: forum,
  target: 'thread',
  targets: 'many',
  when: 'pinned = true',
  output: shape({ message: literal('Unpinned.') }),
  async handle({ db, records }) {
    for (const thread of records) await db.thread.update(thread, { pinned: false });
    return { message: 'Unpinned.' as const };
  },
});

export const moveThread = defineCommand({
  source: forum,
  target: 'thread',
  read: ['board'],
  input: { board: field.reference('board', { by: 'id', labelColumn: 'name', label: 'Move to' }) },
  when: 'status != removed',
  output: shape({ message: literal('Moved.') }),
  async handle({ db, record }, input) {
    const board = (await db.board.find({ id: Number(input.board) })) ?? refuse('invalid_input', 'board');
    if (board.id === record.board_id) refuse(`This thread is already in ${board.name}.`);
    await db.thread.update(record, { board_id: board.id });
    return { message: 'Moved.' as const };
  },
});

export const dismissReport = defineCommand({
  source: forum,
  target: 'report',
  targets: 'many',
  input: { resolution: field.textarea({ label: 'Why no action is needed', max: 500 }) },
  when: 'status = open',
  output: shape({ message: literal('Dismissed.') }),
  async handle({ db, records, now }, input) {
    for (const report of records)
      await db.report.update(report, { status: 'dismissed', resolved_at: stamp(now()), resolution: input.resolution });
    return { message: 'Dismissed.' as const };
  },
});

export const warnMember = defineCommand({
  source: forum,
  target: 'member',
  write: ['warning'],
  input: {
    reason: field.choice(REPORT_REASONS, {}),
    note: field.textarea({
      label: 'What the member is told',
      max: 1000,
      help: 'Say what happened and what to do instead. A warned member’s next posts wait for review.',
    }),
  },
  when: 'standing != suspended',
  output: shape({ message: literal('Warning sent. Their next posts wait for review.') }),
  async handle({ db, record, actor, now }, input) {
    if (record.team !== 'member') refuse('Moderators and admins are not warned here: talk to them.');
    await db.warning.insert({ member_id: record.id, reason: input.reason, note: input.note, issued_by: actor.id, issued_at: stamp(now()) });
    await db.member.update(record, { standing: 'warned' });
    return { message: 'Warning sent. Their next posts wait for review.' as const };
  },
});
