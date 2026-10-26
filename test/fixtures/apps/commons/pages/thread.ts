import { card, embed, fields, history, note, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* A thread: where it is and who started it in one line under the title, its
   photos, then the posts in the order they were written, each whole with who
   wrote it — Commons' post stream (views.ts, widgets/PostStream.tsx) narrowed
   to this thread, where a member reacts, replies, edits their own and reports. Beside it, only what is worth saying: that
   it is pinned or locked, when it is; who started it; how lively it is; and
   its history, for the signed in. */
export const threadPage = page(
  'thread',
  [
    fields(['board_id.name', 'author_id.display_name', 'created_at'], { title: 'About this thread', presentation: 'facts' }),
    note('Pinned by the moderators: it stays at the top of its board.', { icon: 'star', region: 'aside', when: 'pinned = true' }),
    note('Locked: the thread is kept as it is and takes no more replies.', { icon: 'lock', region: 'aside', when: 'status = locked' }),
    card('Started by', 'author_id', ['location', 'reputation']),
    fields(['replies', 'last_activity'], { title: 'Activity', region: 'aside' }),
    history(undefined, { limit: 10 }),
    related('Photos', 'post_image', 'thread_id', {
      presentation: 'gallery',
      show: ['caption'],
      sort: 'position',
      limit: 12,
      empty: 'hide',
    }),
    embed('thread-posts', { whose: 'thread_id', limit: 50 }),
  ],
  { listTabs: false },
) satisfies Page;
