import { count, max, sum } from '@mistriwork/mistri/app';
import type { Resources } from './mistri-schema.d.ts';

/* What Commons says about each resource, once, wherever its records appear:
   how values dress, what each caption reads, the numbers counted from the
   rows that point at a record, and at most what may be done. The verbs —
   posting, reacting, reporting, and every moderator's decision — are
   commands, composed in features/posting.ts and features/moderation.ts. */

export const resources = {
  board: {
    // The boards are the forum's shelves; an admin arranges and describes them.
    access: 'write',
    noun: 'board',
    rollups: {
      threads: count('thread', { query: 'listed' }),
      // Two hops, as a rollup of a rollup: each listed thread's replies, summed.
      replies: sum('thread', 'replies', { query: 'listed' }),
      last_thread: max('thread', 'created_at', { query: 'listed' }),
    },
    display: {
      threads: { format: 'number' },
      replies: { format: 'number' },
      last_thread: { format: 'relative' },
      status: { tone: { read_only: 'info', open: 'neutral' } },
    },
    labels: { name: 'Board', last_thread: 'Newest thread', status: 'Posting', position: 'Place' },
  },
  member: {
    // Changed only by commands: joining, reputation from reactions, a moderator's warning.
    access: 'write',
    noun: 'member',
    rollups: {
      threads: count('thread', { query: 'listed' }),
      posts: count('post', { query: 'published' }),
      warnings: count('warning'),
      // Through their posts, two references away: what the forum has given back.
      reactions_received: count('reaction', { whose: 'post_id.author_id' }),
    },
    display: {
      // A member reads as a person wherever they are named: their picture (initials where there is none), their handle under the name.
      display_name: { avatar: { from: 'member_avatar', whose: 'member_id' }, subtitle: 'handle' },
      team: { tone: { admin: 'info', moderator: 'info', '*': 'neutral' } },
      standing: { tone: { warned: 'warn', suspended: 'bad', '*': 'neutral' } },
      reputation: { format: 'number' },
      posts: { format: 'number' },
      threads: { format: 'number' },
      reactions_received: { format: 'number' },
      joined_on: { format: 'relative' },
    },
    labels: {
      display_name: 'Name',
      bio: 'About',
    },
    // An opaque sign-in id: kept for the moderators' own records, never shown.
    audit: { redact: ['account_id'] },
  },
  // A member's picture: drawn on their profile card and the members' cards.
  member_avatar: {
    file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size' },
  },
  thread: {
    access: 'write',
    noun: 'thread',
    favorite: true,
    // A moderator tags a thread from its page: one link row per chip.
    tags: { through: 'thread_tag', to: 'tag', toneOf: 'tone' },
    rollups: {
      replies: count('post', { query: 'published and opening = false' }),
      last_activity: max('post', 'created_at', { query: 'published' }),
      photos: count('post_image'),
    },
    display: {
      // A locked thread wears its lock, a held one its hourglass: the mark before the word.
      status: {
        tone: { locked: 'info', held: 'warn', removed: 'bad', '*': 'neutral' },
        icons: { locked: 'lock', held: 'hourglass', removed: 'x-circle' },
      },
      replies: { format: 'number' },
      photos: { format: 'number' },
      created_at: { format: 'relative' },
      last_activity: { format: 'relative' },
    },
    labels: {
      title: 'Thread',
      created_at: 'Started',
    },
  },
  post: {
    access: 'write',
    noun: 'post',
    // A post has no title of its own: who wrote it, and where.
    recordLabel: '{author_id.display_name} in {thread_id.title}',
    rollups: {
      reactions: count('reaction'),
      open_reports: count('report', { query: 'open' }),
    },
    display: {
      status: { tone: { held: 'warn', hidden: 'bad', '*': 'neutral' } },
      created_at: { format: 'relative' },
      edited_at: { format: 'relative' },
      reactions: { format: 'number' },
      open_reports: { format: 'number' },
    },
    labels: {
      body: 'Post',
      'thread_id.board_id.name': 'Board',
      opening: 'Opens the thread',
      created_at: 'Posted',
    },
    /* A removed post's words move to the moderators' own record (removal)
       when it is hidden, so its history keeps that the words changed and no
       what they were: anyone who reads the post reads its history. An
       author's earlier words are kept whole in post_revision. */
    audit: { redact: ['body'] },
    /* A reply tells the member who started the thread — found through the
       thread's author and the email that member joined with (auth.me) — and
       opens the thread. Only a reply the forum shows: one held for review
       tells them when a moderator lets it through. The member who wrote it is
       never told of their own reply. */
    notify: [
      {
        on: 'insert',
        when: 'status = published and opening = false',
        to: 'thread_id.author_id',
        title: '{author_id.display_name} replied in {thread_id.title}',
        opens: 'thread_id',
      },
      {
        on: { changes: 'status' },
        when: 'status = published and opening = false',
        to: 'thread_id.author_id',
        title: '{author_id.display_name} replied in {thread_id.title}',
        opens: 'thread_id',
      },
      /* An @handle in a post the forum shows tells that member: when it is
         posted, when a moderator lets it through, and when an edit adds a
         name — each member once, never for words they were named in already. */
      {
        on: 'insert',
        when: 'status = published',
        mentions: { in: 'body', by: 'handle' },
        title: '{author_id.display_name} mentioned you in {thread_id.title}',
        opens: 'thread_id',
      },
      {
        on: 'update',
        when: 'status = published',
        mentions: { in: 'body', by: 'handle' },
        title: '{author_id.display_name} mentioned you in {thread_id.title}',
        opens: 'thread_id',
      },
    ],
  },
  // Photos on a post, and on the thread it opens: a gallery on each, a card's picture.
  post_image: {
    file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', thumbnail: 'thumbnail' },
    labels: { position: 'Place' },
  },
  // The words an author replaced by editing: open to anyone who reads the post, so an edit cannot quietly change a conversation.
  post_revision: {
    access: 'write',
    noun: { one: 'earlier version', many: 'earlier versions' },
    display: { replaced_at: { format: 'relative' } },
    labels: { body: 'Words' },
  },
  // What a moderator removed, and why: the moderators' alone.
  removal: {
    access: 'write',
    display: { removed_at: { format: 'relative' } },
    labels: { body: 'Removed words' },
    audit: { redact: ['removed_by'] },
  },
  reaction: {
    access: 'write',
    recordLabel: 'member_id.display_name',
    display: { kind: { tone: { '*': 'neutral' } }, created_at: { format: 'relative' } },
    labels: { kind: 'Reaction', created_at: 'When' },
  },
  tag: {
    access: 'write',
    display: { tone: { tone: { good: 'good', warn: 'warn', bad: 'bad', info: 'info', '*': 'neutral' } } },
    labels: { name: 'Tag', tone: 'Color' },
  },
  thread_tag: { access: 'write', delete: true },
  report: {
    access: 'write',
    noun: 'report',
    display: {
      status: { tone: { open: 'warn', actioned: 'good', '*': 'neutral' } },
      // What a moderator triages first: spam and unkindness, then advice that could hurt someone.
      reason: { tone: { spam: 'bad', harassment: 'bad', misinformation: 'warn', '*': 'neutral' } },
      created_at: { format: 'relative' },
      resolved_at: { format: 'relative' },
    },
    labels: {
      created_at: 'Reported',
      resolved_at: 'Decided',
      resolution: 'Decision',
      'post_id.author_id.display_name': 'Author',
      'post_id.thread_id.title': 'Thread',
    },
  },
  warning: {
    access: 'write',
    noun: 'warning',
    display: { issued_at: { format: 'relative' } },
  },
  // The front page's photo: one row, a workbench seen from above.
  site_image: {
    file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size' },
  },
} satisfies Resources;
