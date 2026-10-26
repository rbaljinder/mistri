import { cards, customList, listView } from '@mistriwork/mistri/app';
import type { Views } from './mistri-schema.d.ts';
import { postStream } from './components.ts';
import { commonsLanding } from './landing.ts';

/* What anyone can read, signed in or not: the threads, the boards, the
   finished projects and the members. A thread the forum shows is open or
   locked (the segment `listed`); one held for review or removed is the
   moderators' (features/). */

/** A thread as a card: its title, then where it is and who started it. */
const threadCard = cards('title', { facts: ['board_id.name', 'author_id.display_name'], properties: ['replies'] });

/* A thread's posts as a forum reads them, drawn by Commons' own post stream
   (widgets/PostStream.tsx): oldest first, each whole with who wrote it and
   when, its photos inline and its reactions under it. The list is the
   platform's — its question, its paging — and the stream only lays the posts
   out; it is exported so the stream can type its rows from it. */
export const threadPosts = listView('Posts', 'post', {
  query: 'published',
  sort: 'created_at',
  presentation: customList(postStream, {
    show: [
      'body',
      'created_at',
      'edited_at',
      'opening',
      'thread_id',
      'author_id',
      'author_id.display_name',
      'author_id.handle',
      'author_id.team',
    ],
  }),
});

export const views = {
  welcome: commonsLanding,
  latest: listView('Latest', 'thread', {
    icon: 'chat-circle',
    query: 'listed',
    show: ['title', 'board_id.name', 'author_id.display_name', 'replies', 'last_activity'],
    tabs: [
      { label: 'Latest' },
      { segment: 'top', sort: 'replies desc' },
      { segment: 'unanswered', sort: 'created_at desc' },
      'pinned_threads',
      // The threads the signed-in member started; not offered to a signed-out reader, for whom it is nobody's.
      'my_threads',
    ],
    filters: ['title', 'board_id', 'created_at'],
    // The thread with the newest reply first, as every forum reads; the reader may pick another order.
    sort: [
      { label: 'Latest activity', sort: 'last_activity desc' },
      { label: 'Newest threads', sort: 'created_at desc' },
      { label: 'Most replies', sort: 'replies desc' },
    ],
    empty: { title: 'No threads yet', description: 'The first thread starts the conversation.' },
  }),
  // A board's own threads, on its page: Latest without the board column.
  'board-threads': listView('Threads', 'thread', {
    query: 'listed',
    sort: 'last_activity desc',
    show: ['title', 'author_id.display_name', 'replies', 'last_activity'],
  }),
  /* Posts as cards, each whole, with who wrote it and when, the whole card
     opening the post: the front page's latest replies (landing.ts). */
  conversation: listView('Conversation', 'post', {
    query: 'published',
    sort: 'created_at',
    presentation: cards('body', { facts: ['author_id.display_name', 'created_at'] }),
  }),
  // A thread's page draws its posts through this (pages/thread.ts).
  'thread-posts': threadPosts,
  // The same threads as cards, for the front page's "recently active".
  active: listView('Recently active', 'thread', { query: 'listed', sort: 'last_activity desc', presentation: threadCard }),
  // Finished projects with their photos: Show & Tell's threads, as a gallery of cards.
  showcase: listView('Show & Tell', 'thread', {
    icon: 'star',
    query: 'listed and board_id.slug = "show-and-tell"',
    sort: 'created_at desc',
    presentation: cards('title', {
      facts: ['author_id.display_name', 'created_at'],
      image: { from: 'post_image', whose: 'thread_id', sort: 'position' },
    }),
  }),
  // The boards in the admin's order, with how busy each one is.
  boards: listView('Boards', 'board', {
    icon: 'stack',
    order: 'position',
    show: ['name', 'description', 'threads', 'replies', 'last_thread'],
    filterBar: 'none',
  }),
  // The same boards as cards, for the front page: each with how many threads and replies it holds (rollups).
  shelves: listView('The boards', 'board', {
    order: 'position',
    presentation: cards('name', { description: 'description', properties: ['threads', 'replies'] }),
  }),
  members: listView('Members', 'member', {
    icon: 'users',
    query: 'standing != suspended',
    presentation: cards('display_name', {
      media: 'avatar',
      image: { from: 'member_avatar', whose: 'member_id' },
      facts: ['location'],
      properties: ['joined_on', 'posts'],
    }),
    filters: ['display_name', 'location'],
    sort: [
      { label: 'Most helpful', sort: 'reputation desc' },
      { label: 'Newest members', sort: 'joined_on desc' },
      { label: 'Name', sort: 'display_name' },
    ],
  }),
  // The admin's shelf: each board's words and whether members may start threads in it, edited in place.
  'board-settings': listView('Board settings', 'board', {
    icon: 'sliders',
    order: 'position',
    show: ['name', 'description', 'status', 'threads'],
    editable: ['name', 'description', 'status'],
  }),
  tags: listView('Tags', 'tag', {
    icon: 'tag',
    show: ['name', 'tone'],
    editable: ['name', 'tone'],
    quickAdd: true,
    sort: 'name',
  }),
} satisfies Views;
