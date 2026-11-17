import { useState } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Sortable, SortableItem } from './SortableParts.js';
import { type Span, Spans, SpansSpan, SpansTrack } from './SpansParts.js';
import { Transfer, TransferHandle, TransferItem, TransferList } from './TransferParts.js';
import { clear, draw, focus, key, one } from './testing.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  clear();
});

const bars: Span[] = [{ id: 'paint', track: 'paint', start: 2, end: 5 }];
const start = () => document.querySelector('[data-slot="spans-span"]')!.getAttribute('aria-label');

function Plan({
  onCommit,
  controlled = true,
}: {
  onCommit?: (change: { value: Span[]; from: Span[]; moved: string[] }) => Promise<boolean>;
  controlled?: boolean;
}) {
  const [state, setState] = useState<Span[]>(bars);
  const body = (
    <SpansTrack value="paint">
      {(onTrack) =>
        onTrack.map((bar) => (
          <SpansSpan key={bar.id} value={bar.id} aria-label={`${bar.start} to ${bar.end}`}>
            {bar.id}
          </SpansSpan>
        ))
      }
    </SpansTrack>
  );
  return controlled ? (
    <Spans value={state} onValueChange={setState} onCommit={onCommit} min={0} max={20} stay>
      {body}
    </Spans>
  ) : (
    <Spans defaultValue={bars} onCommit={onCommit} min={0} max={20} stay>
      {body}
    </Spans>
  );
}
const bar = () => document.querySelector<HTMLElement>('[data-slot="spans-span"]')!;
const alt = { altKey: true };
const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const live = () => document.querySelector('[data-ui-sdk-announcer]')?.textContent;

test('commit: a move is drawn at once, pending, and asked about once after the keyboard settles', async () => {
  const ask = vi.fn(async () => true);
  draw(<Plan onCommit={ask} />);
  focus(bar());
  key(bar(), 'ArrowRight', alt);
  expect(start()).toBe('3 to 6');
  expect(bar().hasAttribute('data-pending')).toBe(true);
  expect(ask).not.toHaveBeenCalled();
  await settle(700);
  expect(ask).toHaveBeenCalledTimes(1);
  expect(bar().hasAttribute('data-pending')).toBe(false);
  expect(start()).toBe('3 to 6');
});

test('commit: two Alt+Arrow steps inside the delay are one call carrying the net change', async () => {
  const ask = vi.fn(async () => true);
  draw(<Plan onCommit={ask} />);
  focus(bar());
  key(bar(), 'ArrowRight', alt);
  await settle(200);
  key(bar(), 'ArrowRight', alt);
  await settle(700);
  expect(ask).toHaveBeenCalledTimes(1);
  const change = (ask.mock.calls as unknown as Array<[{ value: Span[]; from: Span[]; moved: string[] }]>)[0]![0];
  expect(change.from[0]).toMatchObject({ start: 2, end: 5 });
  expect(change.value[0]).toMatchObject({ start: 4, end: 7 });
  expect(change.moved).toEqual(['paint']);
  expect(start()).toBe('4 to 7');
});

test('commit: a refusal puts the stretch back and says so', async () => {
  draw(<Plan onCommit={async () => false} />);
  focus(bar());
  key(bar(), 'ArrowRight', alt);
  await settle(700);
  expect(start()).toBe('2 to 5');
  expect(bar().hasAttribute('data-pending')).toBe(false);
  await settle(200);
  expect(live()).toContain('Put back where it was');
});

test('commit: a rejection puts it back too, with the rejection said', async () => {
  draw(
    <Plan
      onCommit={async () => {
        throw new Error('The server is down');
      }}
    />,
  );
  focus(bar());
  key(bar(), 'ArrowRight', alt);
  await settle(700);
  expect(start()).toBe('2 to 5');
  await settle(200);
  expect(live()).toContain('The server is down');
});

test('commit: a stretch moved again while it is pending is not stuck', async () => {
  let release: (kept: boolean) => void = () => {};
  const ask = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)));
  draw(<Plan onCommit={ask} />);
  focus(bar());
  key(bar(), 'ArrowRight', alt);
  await settle(700);
  expect(bar().hasAttribute('data-pending')).toBe(true);
  key(bar(), 'ArrowRight', alt);
  expect(start()).toBe('4 to 7');
  release(true);
  await settle(0);
  await settle(700);
  expect(ask).toHaveBeenCalledTimes(2);
  expect(ask.mock.calls[1]).toBeDefined();
  release(true);
  await settle(0);
  expect(start()).toBe('4 to 7');
  expect(bar().hasAttribute('data-pending')).toBe(false);
});

test('commit: uncontrolled, the move is kept once committed', async () => {
  draw(<Plan onCommit={async () => true} controlled={false} />);
  focus(bar());
  key(bar(), 'ArrowRight', alt);
  await settle(700);
  expect(start()).toBe('3 to 6');
});

test('without onCommit a change is heard at once and nothing is pending', () => {
  draw(<Plan />);
  focus(bar());
  key(bar(), 'ArrowRight', alt);
  expect(start()).toBe('3 to 6');
  expect(bar().hasAttribute('data-pending')).toBe(false);
});

test('commit: a sortable list reverts a dropped item that the server refused', async () => {
  function List() {
    const [order, setOrder] = useState(['a', 'b', 'c']);
    return (
      <Sortable aria-label="Letters" value={order} onValueChange={setOrder} onCommit={async () => false}>
        {(k) => (
          <SortableItem key={k} value={k}>
            {k}
          </SortableItem>
        )}
      </Sortable>
    );
  }
  draw(<List />);
  focus(one('option', 'a'));
  key(one('option', 'a'), ' ');
  key(one('option', 'a'), 'ArrowDown');
  key(one('option', 'a'), ' ');
  expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['b', 'a', 'c']);
  expect(one('option', 'a').hasAttribute('data-pending')).toBe(true);
  await settle(700);
  expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['a', 'b', 'c']);
});

test('commit: a transfer keeps the move the server accepted', async () => {
  const ask = vi.fn(async () => true);
  function Lanes() {
    const [lists, setLists] = useState<Record<string, string[]>>({ todo: ['x'], done: [] });
    return (
      <Transfer value={lists} onValueChange={setLists} onCommit={ask} order={['todo', 'done']}>
        {['todo', 'done'].map((name) => (
          <TransferList key={name} value={name} aria-label={name}>
            {(k) => (
              <TransferItem key={k} value={k}>
                <TransferHandle aria-label={`Carry ${k}`} />
                {k}
              </TransferItem>
            )}
          </TransferList>
        ))}
      </Transfer>
    );
  }
  draw(<Lanes />);
  const grip = document.querySelector<HTMLElement>('[aria-label="Carry x"]')!;
  focus(grip);
  key(grip, ' ');
  key(grip, 'ArrowRight');
  // The handle is drawn again in its new list, and still has the keyboard.
  key(document.querySelector<HTMLElement>('[aria-label="Carry x"]')!, ' ');
  expect(document.querySelector('[data-list="done"] [data-slot="transfer-item"]')?.hasAttribute('data-pending')).toBe(true);
  await settle(700);
  expect(ask).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-list="done"] [data-slot="transfer-item"]')).not.toBeNull();
});
