import { chart, embed, fields, header, page } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* A board: what belongs here, whether members may post, how busy it is, and
   its threads, newest reply first, as Latest reads them. */
export const boardPage = page(
  'board',
  [
    // What the board says leads: whether members may post in it and its newest thread in the head, then its words
    // and how busy it is as two of its lines, not a row of counts. The chart keeps the months.
    header({ status: 'status', facts: ['last_thread'] }),
    fields(['description', 'threads', 'replies'], { title: 'About this board' }),
    embed('board-threads', { whose: 'board_id', limit: 25 }),
    chart('Posts by month', 'post', 'month created_at', { whose: 'thread_id.board_id', query: 'status = published', height: 180 }),
  ],
  { listTabs: false },
) satisfies Page;
