import { activity, breakdown, chart, dashboard, embed, firstRun, metric, note, rows } from '@mistriwork/mistri/app';

/* The moderators' view of the forum: is it busy, is it kind, and what is
   waiting. Each figure counts what the forum shows (published posts, open
   threads); held and removed ones are the queues'. It reads reports and
   removals, which only moderators read, so no one else is offered it. A new,
   empty Commons opens on its first run instead of charts of nothing. */
export const health = dashboard(
  'Community health',
  [
    firstRun(
      'Open the doors',
      [
        {
          label: 'Set out the boards',
          to: 'board-settings',
          description: 'The shelves every thread sits on: a name, a line about what belongs there.',
        },
        {
          label: 'Start the first thread',
          to: 'latest',
          description: 'A welcome post in Announcements, pinned, with the few rules that matter.',
        },
        { label: 'Welcome the first members', to: 'members', description: 'Everyone who joins appears here with their profile.' },
      ],
      { description: 'Commons has no boards, threads or members yet. Three steps and this page fills in.' },
    ),
    metric('Posts', 'post', {
      query: 'status = published and created_at = last 30 days',
      over: 'created_at',
      compare: 'previous period',
      better: 'up',
      spark: true,
      to: 'posts',
    }),
    metric('New threads', 'thread', {
      query: '(status = open or status = locked) and created_at = last 30 days',
      over: 'created_at',
      // Opens every thread without the board column a board's page leaves out; its only menu is this.
      compare: 'previous period',
      better: 'up',
      spark: true,
      to: 'board-threads',
    }),
    metric('Open reports', 'report', { query: 'open', to: 'queue' }),
    // Its own period, apart from the page's window: the year by month, or the last quarter.
    chart('Posts by month', 'post', 'month created_at', {
      query: 'status = published and created_at = last 12 months',
      over: 'created_at',
      windows: ['last 12 months', 'last 6 months', 'last 90 days'],
      height: 220,
    }),
    breakdown('Busiest boards', 'post', 'thread_id.board_id.name', {
      query: 'published',
      width: 'half',
      over: 'created_at',
      limit: 9,
      to: false,
    }),
    chart('Reports by reason', 'report', 'reason', { shape: 'donut', width: 'half', over: 'created_at', to: 'reports' }),
    embed('queue', { title: 'Reported, oldest first', limit: 3, width: 'half' }),
    embed('held', { title: 'Held for review', limit: 3, width: 'half' }),
  ],
  {
    icon: 'gauge',
    description: 'How busy and how kind the forum has been, and what is waiting for a moderator.',
    windows: ['last 30 days', 'last 90 days', 'this year'],
    aside: [
      // What the forum did this week: threads started and replies posted, each by its author.
      activity(
        'Latest in the forum',
        { thread: { icon: 'chat-circle' }, post: { icon: 'note', label: 'reply' } },
        { limit: 5, icon: 'clock' },
      ),
      rows('Newest members', 'member', { show: ['display_name', 'location', 'joined_on'], sort: 'joined_on desc', limit: 6 }),
      note('Every member with their standing, posts and warnings, newest first. Warn a member from their row.', {
        title: 'Members',
        icon: 'users',
        action: { label: 'Member standing', to: 'standing' },
      }),
      rows('Most thanked', 'member', {
        query: 'reputation > 0',
        show: ['display_name', 'handle', 'reputation'],
        sort: 'reputation desc',
        limit: 6,
      }),
      note(
        'Remove a post rather than arguing with it, and warn a member before anything firmer. A warned member’s next posts wait in Held for review, so a quiet word usually does it.',
        { title: 'House style', icon: 'info' },
      ),
      note(
        'Rename a board, rewrite what belongs in it, or close it to members’ threads. Drag a row to change the order the forum lists them in.',
        { title: 'Boards', icon: 'stack', action: { label: 'Board settings', to: 'board-settings' } },
      ),
      note('Tags mark a thread solved, or a guide, or a safety note. Add one here, then put it on a thread from the thread’s page.', {
        title: 'Tags',
        icon: 'tag',
        action: { label: 'Edit tags', to: 'tags' },
      }),
    ],
  },
);
