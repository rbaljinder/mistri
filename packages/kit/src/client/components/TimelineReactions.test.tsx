/**
 * A timeline entry's reactions: the page's counts and the reader's own asked as two breakdowns in the same moment,
 * kinds said through the column's display rule, the reader's own pressed, a press running the App's own command on
 * the entry with the kind as its input, and a reader not granted it reading only the kinds someone gave.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { TimelineReactions } from '@mistriwork/engine/shared/pageModel.js';

const asked: Array<{ text: string; limit?: number }> = [];
const runs: Array<{ ref: string; key: unknown; input: unknown }> = [];
let granted = true;
/* The reactions on the page, as [post, kind, member]: member 9 is the reader. */
let given: Array<[number, string, number]> = [];

vi.mock('../core.js', () => ({
  findTable: (name: string) => ({ id: name }),
  columnDisplay: () => ({ values: { like: 'Like', thanks: 'Thanks', helpful: 'Helpful' }, icons: { thanks: 'heart' } }),
}));
vi.mock('./Icon.js', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../breakdownBatch.js', () => ({
  batchedBreakdown: async (ask: { text: string; limit?: number }) => {
    asked.push(ask);
    const mine = ask.text.includes('member_id = me');
    const counts = new Map<string, number>();
    for (const [post, kind, member] of given) {
      if (mine && member !== 9) continue;
      const key = JSON.stringify([post, kind]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return {
      columns: ['post_id', 'kind', 'count'],
      rows: [...counts].map(([key, count]) => {
        const [post, kind] = JSON.parse(key) as [number, string];
        return { post_id: post, kind, count };
      }),
    };
  },
}));
vi.mock('../uiBridge.js', () => ({
  pageBridge: {
    commands: {
      command: (ref: string) => ({
        granted,
        run: async (key: unknown, input: unknown) => {
          runs.push({ ref, key, input });
          given.push([1, 'like', 9]);
          return { status: 'applied' };
        },
      }),
    },
  },
}));

const { ReactionRow } = await import('./TimelineReactions.js');
const { useReactionTally } = await import('./reactionTally.js');

const REACTIONS: TimelineReactions = {
  from: 'reaction',
  kinds: ['like', 'thanks', 'helpful'],
  command: 'reactToPost',
  whose: 'post_id',
  by: 'member_id',
  column: 'kind',
};

function Posts({ entries }: { entries: number[] }) {
  const { tally } = useReactionTally(REACTIONS, entries);
  if (!tally) return createElement('p', null, 'counting');
  return createElement(
    'ol',
    null,
    entries.map((value) =>
      createElement(
        'li',
        { key: value, 'data-post': value },
        createElement(ReactionRow, { reactions: REACTIONS, entry: { column: 'id', value }, tally }),
      ),
    ),
  );
}

function draw(entries = [1, 2]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(Posts, { entries })));
}
const post = (value: number) => document.querySelector(`[data-post="${value}"]`) as HTMLElement;

beforeEach(() => {
  asked.length = 0;
  runs.length = 0;
  granted = true;
  given = [
    [1, 'like', 3],
    [1, 'like', 9],
    [1, 'thanks', 4],
    [2, 'helpful', 5],
  ];
});
afterEach(cleanup);

describe('timeline reactions', () => {
  test("count every entry's kinds in one read and the reader's own in one more, asked together", async () => {
    draw();
    await waitFor(() => expect(post(1)).toBeTruthy());
    expect(asked.map((ask) => ask.text)).toEqual([
      'reaction post_id in (1, 2) and kind in (like, thanks, helpful) count by post_id, kind',
      'reaction post_id in (1, 2) and kind in (like, thanks, helpful) and member_id = me count by post_id, kind',
    ]);
    expect(asked[0]!.limit).toBe(6);
  });

  test("say each kind through the column's display rule, with its count and the reader's own pressed", async () => {
    draw();
    await waitFor(() => expect(post(1)).toBeTruthy());
    const like = screen.getAllByRole('button', { name: 'Like, 2 reactions' })[0]!;
    expect(like.getAttribute('aria-pressed')).toBe('true');
    expect(like.textContent).toBe('Like2');
    const thanks = screen.getByRole('button', { name: 'Thanks, 1 reaction' });
    expect(thanks.getAttribute('aria-pressed')).toBe('false');
    expect(thanks.querySelector('[data-icon="heart"]')).toBeTruthy();
    // A kind no one gave is still offered to a reader who may give it, without a count.
    expect(post(1).querySelectorAll('button')).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: 'Helpful, 0 reactions' })[0]!.textContent).toBe('Helpful');
  });

  test("run the App's command on the entry with the kind, then count again", async () => {
    draw();
    await waitFor(() => expect(post(1)).toBeTruthy());
    const before = asked.length;
    const helpful = post(1).querySelector('button:last-of-type') as HTMLButtonElement;
    await userEvent.click(helpful);
    expect(runs).toEqual([{ ref: 'reactToPost', key: { id: 1 }, input: { kind: 'helpful' } }]);
    await waitFor(() => expect(asked.length).toBe(before + 2));
  });

  test('a reader not granted the command reads the kinds someone gave, and presses nothing', async () => {
    granted = false;
    draw();
    await waitFor(() => expect(post(1)).toBeTruthy());
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(post(1).textContent).toBe('Like2Thanks1');
    expect(post(1).querySelector('[data-pressed="true"]')?.textContent).toBe('Like2');
    expect(post(2).textContent).toBe('Helpful1');
  });

  test('ask nothing for a page with no entries', async () => {
    draw([]);
    await new Promise((settle) => setTimeout(settle, 20));
    expect(asked).toHaveLength(0);
  });
});
