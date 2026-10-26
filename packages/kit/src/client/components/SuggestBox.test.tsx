/**
 * A search box that suggests: the values of the list's columns that contain
 * what was typed, asked once the typing pauses, under the list's standing
 * query, each value once and the ones that start with it first. Enter
 * searches for what was typed; a suggestion arrowed to or clicked fills the
 * box and searches for it.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

const mocks = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock('../core.js', () => ({
  state: { activeConnection: 'forecourt' },
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
vi.mock('../breakdownBatch.js', () => ({
  batchedBreakdown: async ({ text }: { text: string }) => {
    mocks.asked.push(text);
    const column = text.includes('count by make') ? 'make' : 'model';
    const values: Record<string, Array<[string, number]>> = {
      make: [
        ['Toyota', 9],
        ['TOYOTA', 2],
      ],
      model: [
        ['Land Cruiser Toyo', 3],
        ['Toyo Ace', 1],
      ],
    };
    return { columns: [column, 'count'], rows: values[column].map(([value, count]) => ({ [column]: value, count })) };
  },
}));
const { SuggestBox } = await import('./SuggestBox.js');
const { rankSuggestions, suggestText, suggestionsOf } = await import('./suggestModel.js');

beforeEach(() => {
  mocks.asked = [];
});
afterEach(cleanup);

function Harness({ onSearch, onPick }: { onSearch: (text: string) => void; onPick: (value: string) => void }) {
  const [text, setText] = useState('');
  return (
    <SuggestBox
      table="vehicle"
      columns={['make', 'model']}
      standing="status != sold"
      text={text}
      onText={setText}
      onPick={onPick}
      inputProps={{
        'aria-label': 'Search cars',
        onKeyDown: (e) => {
          if (e.key === 'Enter') onSearch(text);
        },
      }}
    />
  );
}
const draw = (onSearch = vi.fn(), onPick = vi.fn()) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Harness onSearch={onSearch} onPick={onPick} />
    </QueryClientProvider>,
  );
  return { onSearch, onPick, box: screen.getByRole('combobox', { name: 'Search cars' }) };
};

test('one breakdown a column, under the standing query, the typed text quoted as a value', () => {
  expect(suggestText('vehicle', 'make', 'toy', 'status != sold')).toBe(
    'vehicle status != sold and make contains toy count by make sort count desc',
  );
  expect(suggestText('vehicle', 'model', 'land "cruiser"')).toBe(
    'vehicle model contains "land \\"cruiser\\"" count by model sort count desc',
  );
  expect(
    suggestionsOf({
      columns: ['make', 'count'],
      rows: [
        { make: 'Kia', count: 2 },
        { make: null, count: 1 },
      ],
    }),
  ).toEqual([{ value: 'Kia', count: 2 }]);
  expect(suggestionsOf({ errors: [{}], columns: ['make', 'count'], rows: [{ make: 'Kia', count: 2 }] })).toEqual([]);
});

test('each value once, whatever its case; those that start with the text first, then the commoner; at most eight', () => {
  const ranked = rankSuggestions(
    [
      [
        { value: 'Toyota', count: 9 },
        { value: 'TOYOTA', count: 2 },
      ],
      [
        { value: 'Land Cruiser Toyo', count: 30 },
        { value: 'Toyo Ace', count: 1 },
      ],
    ],
    'toy',
  );
  expect(ranked.map((s) => s.value)).toEqual(['Toyota', 'Toyo Ace', 'Land Cruiser Toyo']);
  const many = Array.from({ length: 12 }, (_, i) => ({ value: `v${i}`, count: i }));
  expect(rankSuggestions([many], 'v')).toHaveLength(8);
});

test('typing asks once it pauses, and Enter searches for what was typed: nothing is lit until the reader arrows in', async () => {
  const { box, onSearch, onPick } = draw();
  await userEvent.type(box, 'toy');
  const options = await screen.findAllByRole('option');
  expect(options.map((o) => o.textContent)).toEqual(['Toyota', 'Toyo Ace', 'Land Cruiser Toyo']);
  // The pause is one question a column, not one a keystroke.
  expect(mocks.asked).toHaveLength(2);
  expect(mocks.asked.every((text) => text.includes('status != sold and'))).toBe(true);
  await userEvent.keyboard('{Enter}');
  expect(onSearch).toHaveBeenCalledWith('toy');
  expect(onPick).not.toHaveBeenCalled();
});

test('an arrowed suggestion is the one Enter takes, and the box says it', async () => {
  const { box, onSearch, onPick } = draw();
  await userEvent.type(box, 'toy');
  await screen.findAllByRole('option');
  await userEvent.keyboard('{ArrowDown}');
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(onPick).toHaveBeenCalledWith('Toyota'));
  expect(onSearch).not.toHaveBeenCalled();
  expect(box).toHaveValue('Toyota');
});

test('a click on a suggestion picks it', async () => {
  const { box, onPick } = draw();
  await userEvent.type(box, 'toy');
  await userEvent.click(await screen.findByRole('option', { name: 'Toyo Ace' }));
  expect(onPick).toHaveBeenCalledWith('Toyo Ace');
  expect(box).toHaveValue('Toyo Ace');
});
