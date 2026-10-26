import { chart, fields, header, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* A member's profile: their portrait and name in the head with their standing
   beside it and their team and town under it, what the forum has thanked them
   for (the reactions two references away, through their posts), their own
   words, how much they post, and what they have started and
   written. The head is the built-in record header (mistri docs pages); the
   portrait is the name's avatar display rule (resources.ts). A warning is the
   moderators' (Moderation › Warnings): a section over it would keep the whole
   page from every reader who cannot read warnings. */
export const memberPage = page(
  'member',
  [
    header({ status: 'standing', facts: ['team', 'location'] }),
    fields(['reputation', 'posts', 'threads', 'reactions_received', 'joined_on']),
    fields(['bio', 'website'], { title: 'In their words', columns: 1 }),
    chart('Posts by month', 'post', 'month created_at', { whose: 'author_id', query: 'status = published', height: 180 }),
    related('Threads', 'thread', 'author_id', {
      show: ['title', 'board_id.name', 'replies', 'last_activity'],
      query: 'status = open or status = locked',
      sort: 'created_at desc',
      limit: 10,
      empty: 'hide',
    }),
    related('Recent posts', 'post', 'author_id', {
      show: ['thread_id.title', 'body', 'reactions', 'created_at'],
      query: 'status = published',
      sort: 'created_at desc',
      limit: 10,
      empty: 'hide',
    }),
  ],
  { listTabs: false },
) satisfies Page;
