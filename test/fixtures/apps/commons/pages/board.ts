import { chart, embed, fields, metric, page } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* A board: what belongs here, how busy it is, and its threads, newest reply
   first, as Latest reads them. */
export const boardPage = page(
  'board',
  [
    fields(['description'], { title: 'About this board' }),
    metric('Threads', 'thread', { whose: 'board_id', query: 'status = open or status = locked', width: 'third' }),
    metric('Posts', 'post', { whose: 'thread_id.board_id', query: 'status = published', width: 'third' }),
    metric('Posts this month', 'post', {
      whose: 'thread_id.board_id',
      query: 'status = published and created_at = last 30 days',
      width: 'third',
    }),
    embed('board-threads', { whose: 'board_id', limit: 25 }),
    chart('Posts by month', 'post', 'month created_at', { whose: 'thread_id.board_id', query: 'status = published', height: 180 }),
  ],
  { listTabs: false },
) satisfies Page;
