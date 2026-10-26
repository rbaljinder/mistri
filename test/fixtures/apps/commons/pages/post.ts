import { breakdown, card, fields, headline, history, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* One post: its words, who wrote it and where, its photos and reactions, and
   the words its author replaced. Every section reads what the public reads:
   a page with one section over a table its reader cannot read is not served
   to that reader at all, so a post's reports and removed words are the
   moderators' own rooms (Moderation), not sections here. */
export const postPage = page(
  'post',
  [
    fields(['author_id.display_name', 'thread_id.title', 'created_at'], { title: 'About this post', presentation: 'facts' }),
    fields(['body'], { title: 'Post' }),
    related('Photos', 'post_image', 'post_id', { presentation: 'gallery', show: ['caption'], sort: 'position', limit: 12, empty: 'hide' }),
    breakdown('Reactions', 'reaction', 'kind', { whose: 'post_id', width: 'half' }),
    // Half the page beside the offer card holds two columns; newest first, the order says when.
    related('Who reacted', 'reaction', 'post_id', {
      show: ['member_id.display_name', 'kind'],
      sort: 'created_at desc',
      limit: 12,
      width: 'half',
      empty: 'hide',
    }),
    related('Earlier versions', 'post_revision', 'post_id', { show: ['body', 'replaced_at'], sort: 'replaced_at desc', empty: 'hide' }),
    headline(['reactions', 'edited_at'], {
      title: 'Reactions',
      region: 'aside',
      // Anyone may report a post: the form opens over it, already naming it.
      links: [{ label: 'Report this post', to: 'report-post', intent: 'secondary', open: 'modal', prefill: { post: 'id' } }],
    }),
    card('Written by', 'author_id', ['handle', 'reputation', 'joined_on']),
    history(undefined, { limit: 10 }),
  ],
  { listTabs: false },
) satisfies Page;
