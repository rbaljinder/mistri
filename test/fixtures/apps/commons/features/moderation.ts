import { action, defineFeature, listView, queue } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';
import { health } from '../dashboard.ts';

/* What a moderator does. Posts and threads are written only by commands —
   a member's words and a moderator's decisions go through the same doors —
   so every decision here is one too: offered on the record, and the ones
   that make sense for a selection offered in bulk on the queue, where the
   whole selection commits or none of it does. */

const decisions = [
  'approvePost',
  'hidePost',
  'restorePost',
  'lockThread',
  'unlockThread',
  'pinThread',
  'unpinThread',
  'moveThread',
  'removeReportedPost',
  'dismissReport',
  'warnMember',
] as const;

export const moderation = defineFeature({
  id: 'moderation',
  resources: {
    post: {
      segments: {
        // A post the forum shows: not held for review, not removed.
        published: 'status = published',
        held: 'status = held',
        hidden: 'status = hidden',
        edited: 'edited_at is not empty',
      },
      actions: {
        approve: action('Approve', { command: 'approvePost', bulk: true }),
        hide: action('Hide', { command: 'hidePost', bulk: true }),
        restore: action('Restore', { command: 'restorePost' }),
      },
    },
    thread: {
      segments: {
        // A thread the forum shows: open, or locked and still readable.
        listed: 'status = open or status = locked',
        top: 'replies > 0',
        unanswered: 'replies = 0',
        pinned_threads: { query: 'pinned = true', label: 'Pinned' },
        my_threads: 'author_id = me',
      },
      actions: {
        pinThread: action('Pin thread', { command: 'pinThread', bulk: true }),
        unpinThread: action('Unpin thread', { command: 'unpinThread', bulk: true }),
        lockThread: action('Lock thread', { command: 'lockThread', bulk: true }),
        unlockThread: action('Unlock thread', { command: 'unlockThread', bulk: true }),
        moveThread: action('Move thread', { command: 'moveThread' }),
      },
    },
    report: {
      segments: {
        open: 'status = open',
        actioned: 'status = actioned',
        dismissed: 'status = dismissed',
      },
      actions: {
        removePost: action('Remove post', { command: 'removeReportedPost', bulk: true }),
        dismissReport: action('Dismiss report', { command: 'dismissReport', bulk: true }),
      },
    },
    member: {
      segments: {
        warned: 'standing = warned',
        suspended: 'standing = suspended',
        joined_this_month: 'joined_on = last 30 days',
      },
      actions: { warnMember: action('Warn member', { command: 'warnMember' }) },
    },
  },
  auth: {
    roles: {
      moderator: { commands: decisions },
      admin: { commands: decisions },
    },
  },
  views: {
    health,
    /* What readers reported, oldest first: what a moderator works through. A
       report is the moderators' alone, so this is their room; the posts
       themselves are public, so the lists over them below are reached from
       the health dashboard rather than the menu. */
    queue: listView('Moderation queue', 'report', {
      icon: 'shield-check',
      open: 'modal',
      query: 'open',
      sort: 'created_at',
      presentation: queue('post_id.body', {
        // Through the post: how many open reports it has, from its rollup.
        badge: 'reason',
        lines: ['details'],
        properties: ['created_at', 'post_id.open_reports'],
        openLabel: 'Review',
      }),
      filters: ['reason', 'created_at'],
      actions: ['removePost', 'dismissReport'],
      empty: {
        title: 'Nothing is waiting',
        description: 'Reports from readers land here.',
        action: { label: 'Community health', to: 'health' },
      },
    }),
    reports: listView('Reports', 'report', {
      icon: 'flag',
      show: ['post_id', 'reason', 'details', 'created_at', 'status', 'resolution'],
      sort: 'created_at desc',
      rowActions: true,
      tabs: ['open', 'actioned', 'dismissed', { label: 'All' }],
      filters: ['reason', 'created_at'],
    }),
    // A warned member's posts, waiting to be let through or removed.
    held: listView('Held for review', 'post', {
      open: 'modal',
      query: 'held',
      sort: 'created_at',
      presentation: queue('body', {
        badge: 'status',
        lines: ['thread_id.title'],
        properties: ['author_id.display_name', 'author_id.warnings', 'created_at'],
        openLabel: 'Review',
      }),
      actions: ['approve', 'hide'],
      empty: { title: 'Nothing is held', description: 'A warned member’s posts wait here until a moderator reads them.' },
    }),
    removals: listView('Removed posts', 'removal', {
      icon: 'archive',
      show: ['post_id', 'reason', 'note', 'removed_at'],
      sort: 'removed_at desc',
      filters: ['reason', 'removed_at'],
    }),
    /* Every post, oldest first, as a queue: its words whole, who wrote it and
       when. A thread's page draws it too, narrowed to the thread (pages/thread.ts),
       where its first tab — what the forum shows — is the conversation. Here,
       a moderator selects posts to approve or hide in bulk. */
    posts: listView('Posts', 'post', {
      sort: 'created_at',
      presentation: queue('body', {
        badge: 'status',
        properties: ['author_id.display_name', 'created_at', 'edited_at'],
        openLabel: 'Open post',
      }),
      tabs: ['published', 'held', 'hidden', 'edited', { label: 'All' }],
      filters: ['author_id', 'created_at'],
      actions: ['approve', 'hide'],
    }),
    standing: listView('Member standing', 'member', {
      show: ['display_name', 'standing', 'team', 'posts', 'warnings', 'reputation', 'joined_on'],
      sort: 'joined_on desc',
      rowActions: true,
      tabs: [{ label: 'Everyone' }, 'warned', 'suspended', 'joined_this_month'],
      filters: ['display_name', 'standing', 'team', 'joined_on'],
    }),
    warnings: listView('Warnings', 'warning', {
      icon: 'warning',
      show: ['member_id.display_name', 'reason', 'note', 'issued_at'],
      sort: 'issued_at desc',
      filters: ['reason', 'issued_at'],
    }),
  },
  nav: ['health', 'queue', 'reports', 'removals', 'warnings'],
} satisfies Feature);
