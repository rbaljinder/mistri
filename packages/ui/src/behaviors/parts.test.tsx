import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import type { Change } from './heard.js';
import { Days, DaysDay } from './DaysParts.js';
import { Editable, EditableInput, EditableValue } from './EditableParts.js';
import { Scrub, ScrubTrack } from './ScrubParts.js';
import { Sortable, SortableItem } from './SortableParts.js';
import { type Span, Spans, SpansSpan, SpansTrack } from './SpansParts.js';
import { Widths, WidthsColumn } from './WidthsParts.js';
import { all, clear, draw, focus, key, labelled, one } from './testing.js';

afterEach(clear);

function Month({ onPick, heard }: { onPick?: (day: string) => void; heard?: (day: string, details: Change) => void }) {
  return (
    <Days
      defaultValue="2026-11-14"
      defaultMonth="2026-11"
      today="2026-11-14"
      onPick={onPick}
      onValueChange={heard}
      role="grid"
      aria-label="A day"
    >
      {({ weeks, month }) => (
        <>
          <p data-month-shown>{month}</p>
          {weeks.map((week) => (
            <div role="row" key={week[0]}>
              {week.map((day) => (
                <DaysDay key={day} value={day} role="gridcell" aria-label={day}>
                  {Number(day.slice(8))}
                </DaysDay>
              ))}
            </div>
          ))}
        </>
      )}
    </Days>
  );
}

test('days: the grid is one Tab stop, the arrows walk by day and week, and a day past the edge brings its month', () => {
  const picked: string[] = [];
  const host = draw(<Month onPick={(day) => picked.push(day)} />);
  const stops = all('gridcell', host).filter((day) => day.tabIndex === 0);
  expect(stops.map((day) => day.getAttribute('aria-label'))).toEqual(['2026-11-14']);
  expect(labelled('2026-11-14').hasAttribute('data-today')).toBe(true);

  focus(labelled('2026-11-14'));
  key(labelled('2026-11-14'), 'ArrowRight');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('2026-11-15');
  key(document.activeElement!, 'ArrowDown');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('2026-11-22');
  key(document.activeElement!, 'ArrowDown');
  key(document.activeElement!, 'ArrowDown');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('2026-12-06');
  expect(host.querySelector('[data-month-shown]')?.textContent).toBe('2026-12');

  key(document.activeElement!, 'Enter');
  expect(picked).toEqual(['2026-12-06']);
});

test("a root's change says this package's details: the reason, the keyboard as the hand, and the event", () => {
  const said: Change[] = [];
  draw(<Month heard={(_day, details) => said.push(details)} />);
  focus(labelled('2026-11-14'));
  key(labelled('2026-11-14'), 'ArrowLeft');
  const last = said.at(-1)!;
  expect(last.reason).toBe('move-key');
  expect(last.source).toBe('keyboard');
  expect(last.event).toBeInstanceOf(KeyboardEvent);
  expect(last.canceled).toBe(false);
});

test('a change a caller cancels leaves the value as it was', () => {
  function Fixed() {
    const [order] = useState(['a', 'b', 'c']);
    return (
      <Sortable defaultValue={order} onValueChange={(_next, details) => details.cancel()} aria-label="Fixed">
        {(item) => (
          <SortableItem key={item} value={item}>
            {item}
          </SortableItem>
        )}
      </Sortable>
    );
  }
  const host = draw(<Fixed />);
  const first = one('option', 'a', host);
  focus(first);
  key(first, ' ');
  key(first, 'ArrowDown');
  key(first, ' ');
  expect(all('option', host).map((item) => item.textContent)).toEqual(['a', 'b', 'c']);
});

test('editable: Enter starts on a value, Enter keeps what was typed, Escape puts it back, and a refusal keeps the box', () => {
  const kept: string[] = [];
  function Rent() {
    const [rent, setRent] = useState('1395');
    return (
      <Editable
        text={() => rent}
        onCommit={(_id, text) => {
          if (text === '') return false;
          kept.push(text);
          setRent(text);
          return undefined;
        }}
      >
        {(editing) => (
          <EditableValue value="rent" tabIndex={0} aria-label="Rent value">
            {editing === 'rent' ? <EditableInput aria-label="Rent" /> : rent}
          </EditableValue>
        )}
      </Editable>
    );
  }
  const host = draw(<Rent />);
  const value = labelled('Rent value', host);
  focus(value);
  key(value, 'Enter');
  const box = host.querySelector<HTMLInputElement>('[data-slot="editable-input"]')!;
  expect(box.value).toBe('1395');

  box.value = '';
  key(box, 'Enter');
  expect(host.querySelector('[data-slot="editable-input"]')).not.toBeNull();

  host.querySelector<HTMLInputElement>('[data-slot="editable-input"]')!.value = '1450';
  key(host.querySelector('[data-slot="editable-input"]')!, 'Enter');
  expect(kept).toEqual(['1450']);
  expect(host.querySelector('[data-slot="editable-input"]')).toBeNull();
  expect(labelled('Rent value', host).textContent).toBe('1450');

  key(labelled('Rent value', host), 'Enter');
  host.querySelector<HTMLInputElement>('[data-slot="editable-input"]')!.value = '9';
  key(host.querySelector('[data-slot="editable-input"]')!, 'Escape');
  expect(labelled('Rent value', host).textContent).toBe('1450');
});

test('scrub: the track is a slider the arrows move along, saying what is at each position', () => {
  const months = ['Jan', 'Feb', 'Mar'];
  const picked: number[] = [];
  const host = draw(
    <Scrub count={months.length} text={(at) => `${months[at]}: ${at * 10}`} onPick={(at) => picked.push(at)}>
      {(at) => <ScrubTrack aria-label="Rent collected">{at === null ? 'none' : months[at]}</ScrubTrack>}
    </Scrub>,
  );
  const track = one('slider', 'Rent collected', host);
  focus(track);
  key(track, 'Home');
  expect(track.getAttribute('aria-valuetext')).toBe('Jan: 0');
  key(track, 'ArrowRight');
  expect(track.getAttribute('aria-valuetext')).toBe('Feb: 10');
  key(track, 'End');
  expect(track.getAttribute('aria-valuetext')).toBe('Mar: 20');
  key(track, 'Enter');
  expect(picked).toEqual([2]);
});

test('spans: Alt with an arrow moves a stretch along its track, and the change names the stretch and what was done to it', () => {
  const said: Array<{ id: string; action: string; reason: string }> = [];
  function Plan() {
    const [bars, setBars] = useState<Span[]>([{ id: 'paint', track: 'paint', start: 2, end: 5 }]);
    return (
      <Spans
        value={bars}
        onValueChange={(next, details) => {
          said.push({ id: details.id, action: details.action, reason: details.reason });
          setBars(next);
        }}
        min={0}
        max={20}
        stay
        label={(bar) => `${bar.id} ${bar.start} to ${bar.end}`}
      >
        <SpansTrack value="paint">
          {(onTrack) =>
            onTrack.map((bar) => (
              <SpansSpan key={bar.id} value={bar.id} aria-label={`${bar.id} ${bar.start} to ${bar.end}`}>
                {bar.id}
              </SpansSpan>
            ))
          }
        </SpansTrack>
      </Spans>
    );
  }
  const host = draw(<Plan />);
  const bar = host.querySelector<HTMLElement>('[data-slot="spans-span"]')!;
  focus(bar);
  key(bar, 'ArrowRight', { altKey: true });
  expect(host.querySelector('[data-slot="spans-span"]')?.getAttribute('aria-label')).toBe('paint 3 to 6');
  expect(said).toEqual([{ id: 'paint', action: 'move', reason: 'move-key' }]);
});

test('spans: the shortcuts a stretch announces are the keys that move it along its own axis', () => {
  const plan = (axis?: 'x' | 'y') => (
    <Spans value={[{ id: 'paint', track: 'paint', start: 2, end: 5 }]} min={0} max={20} stay axis={axis}>
      <SpansTrack value="paint">
        {(onTrack) => onTrack.map((bar) => <SpansSpan key={bar.id} value={bar.id} aria-label={bar.id} />)}
      </SpansTrack>
    </Spans>
  );
  const shortcuts = () => document.querySelector('[data-slot="spans-span"]')?.getAttribute('aria-keyshortcuts');
  draw(plan());
  expect(shortcuts()).toBe('Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowLeft Alt+Shift+ArrowRight');
  draw(plan('y'));
  expect(shortcuts()).toBe('Alt+ArrowUp Alt+ArrowDown Alt+Shift+ArrowUp Alt+Shift+ArrowDown');
});

test("widths: a key's width is said in the caller's words where it gives them", async () => {
  const heard: string[] = [];
  const host = draw(
    <Widths
      formatWidth={(label, width) => (width === undefined ? `${label}: propia` : `${label}: ${width} px`)}
      onValueChange={(next) => heard.push(JSON.stringify(next))}
    >
      {(widths) => (
        <table>
          <thead>
            <tr>
              <WidthsColumn value="name" label="Nombre" style={{ width: widths.name }}>
                <button type="button">Nombre</button>
              </WidthsColumn>
            </tr>
          </thead>
        </table>
      )}
    </Widths>,
  );
  const head = host.querySelector<HTMLElement>('[data-slot="widths-column"] button')!;
  focus(head);
  key(head, 'ArrowRight', { altKey: true });
  expect(heard).toHaveLength(1);
  // The live region is filled a moment after it is emptied, so the same words said twice are read twice.
  await vi.waitFor(() => {
    const live = [...document.querySelectorAll('[aria-live]')].map((region) => region.textContent).join(' ');
    expect(live).toMatch(/Nombre: \d+ px/);
  });
});
