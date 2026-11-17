import { useState } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SpansAxis, SpansNow, SpansRegion } from './SpansGridParts.js';
import { type Span, Spans, SpansSpan, SpansTrack } from './SpansParts.js';
import { clear, draw, focus, key } from './testing.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  clear();
});

function Day({ axis = 'y', now }: { axis?: 'x' | 'y'; now?: () => number }) {
  const [visits, setVisits] = useState<Span[]>([{ id: 'v', track: 'a', start: 9, end: 10 }]);
  return (
    <Spans value={visits} onValueChange={setVisits} axis={axis} min={8} max={18} step={1} stay>
      <SpansAxis step={2} format={(hour) => `${hour}:00`} />
      {now && <SpansNow value={now} />}
      <SpansTrack value="a">
        {(on) => (
          <>
            <SpansRegion from={11} to={12}>
              Lunch
            </SpansRegion>
            {on.map((visit) => (
              <SpansSpan key={visit.id} value={visit.id} aria-label={`${visit.start} to ${visit.end}`} />
            ))}
          </>
        )}
      </SpansTrack>
    </Spans>
  );
}
const span = () => document.querySelector<HTMLElement>('[data-slot="spans-span"]')!;
const down = { altKey: true };

test('an axis draws a label and a line at every step, placed along the range', () => {
  draw(<Day />);
  const labels = [...document.querySelectorAll<HTMLElement>('[data-slot="spans-axis-label"]')];
  expect(labels.map((label) => label.textContent)).toEqual(['8:00', '10:00', '12:00', '14:00', '16:00', '18:00']);
  expect(labels[1]!.style.top).toBe('20%');
  expect(document.querySelectorAll('[data-slot="spans-axis-line"]')).toHaveLength(6);
});

test('an axis on x places by left', () => {
  draw(<Day axis="x" />);
  expect(document.querySelectorAll<HTMLElement>('[data-slot="spans-axis-label"]')[1]!.style.left).toBe('20%');
});

test('a now line is drawn in range and not outside it, and moves with the clock', () => {
  let at = 9;
  draw(<Day now={() => at} />);
  expect(document.querySelector<HTMLElement>('[data-slot="spans-now"]')?.style.top).toBe('10%');
  at = 12;
  act(() => void vi.advanceTimersByTime(60_000));
  expect(document.querySelector<HTMLElement>('[data-slot="spans-now"]')?.style.top).toBe('40%');
  at = 20;
  act(() => void vi.advanceTimersByTime(60_000));
  expect(document.querySelector('[data-slot="spans-now"]')).toBeNull();
});

test('a region shows its label and refuses a move into it, and says so', async () => {
  draw(<Day />);
  expect(document.querySelector('[data-slot="spans-region"]')?.textContent).toBe('Lunch');
  focus(span());
  key(span(), 'ArrowDown', down);
  expect(span().getAttribute('aria-label')).toBe('10 to 11');
  // 11 to 12 is Lunch: the step is refused and the stretch stays where it was.
  key(span(), 'ArrowDown', down);
  expect(span().getAttribute('aria-label')).toBe('10 to 11');
  await act(async () => void (await vi.advanceTimersByTimeAsync(200)));
  expect(document.querySelector('[data-ui-sdk-announcer="assertive"]')?.textContent).toBe('Lunch is not open to that');
});
