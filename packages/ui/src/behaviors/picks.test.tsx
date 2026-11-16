import { act, useState } from 'react';
import { afterEach, expect, test } from 'vitest';
import { Pick, PickBack, PickList, PickOption, PickPane, Turns, TurnsName, TurnsSkip } from './index.js';
import { clear, draw, focus, key } from './testing.js';

afterEach(clear);

/* The two behaviors a list with its detail and a queue are built on, used bare: no look, the parts on their
   default elements. */

const NAMES: Record<string, string> = { a: 'Andre', b: 'Bea', c: 'Cy' };
const active = () => document.activeElement as HTMLElement;
const frame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const press = (part: Element) => act(() => part.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
const option = (id: string) => document.querySelector<HTMLElement>(`[data-slot="pick-option"][data-key="${id}"]`)!;

/* Where there is room for one of the two: the list until something is picked, then the pane with a way back. */
function OneAtATime({ heard }: { heard: (string | null)[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Pick
      keys={Object.keys(NAMES)}
      value={open}
      follow={false}
      onValueChange={(next) => {
        heard.push(next);
        setOpen(next);
      }}
    >
      {open === null ? (
        <PickList aria-label="People">
          {Object.keys(NAMES).map((id) => (
            <PickOption key={id} value={id}>
              {NAMES[id]}
            </PickOption>
          ))}
        </PickList>
      ) : (
        <PickPane aria-label={NAMES[open]}>
          <PickBack>Back</PickBack>
          {NAMES[open]}
        </PickPane>
      )}
    </Pick>
  );
}

test('pick: a listbox with one stop for the keyboard, the first row until one is walked to or picked', () => {
  draw(<OneAtATime heard={[]} />);
  const list = document.querySelector('[data-slot="pick-list"]')!;
  expect(list.getAttribute('role')).toBe('listbox');
  const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="pick-option"]')];
  expect(rows.map((row) => [row.getAttribute('role'), row.tabIndex, row.getAttribute('aria-selected')])).toEqual([
    ['option', 0, 'false'],
    ['option', -1, 'false'],
    ['option', -1, 'false'],
  ]);
});

test('pick, one in view: arrows only walk; Enter picks and lands in the pane; Escape unpicks and lands back on the row', async () => {
  const heard: (string | null)[] = [];
  draw(<OneAtATime heard={heard} />);
  focus(option('a'));
  key(active(), 'ArrowDown');
  expect([active().textContent, heard]).toEqual(['Bea', []]);
  key(active(), 'End');
  expect(active().textContent).toBe('Cy');
  key(active(), 'Enter');
  await frame();
  expect(heard).toEqual(['c']);
  expect(active().getAttribute('data-slot')).toBe('pick-pane');
  expect(active().getAttribute('aria-label')).toBe('Cy');
  key(active(), 'Escape');
  await frame();
  expect(heard).toEqual(['c', null]);
  expect(active()).toBe(option('c'));
  // The row the keyboard came back to is the list's stop now.
  expect(option('c').tabIndex).toBe(0);
});

test('pick, one in view: a press on a row goes to the pane, and the back part returns to the row', async () => {
  const heard: (string | null)[] = [];
  draw(<OneAtATime heard={heard} />);
  press(option('b'));
  await frame();
  expect(active().getAttribute('data-slot')).toBe('pick-pane');
  press(document.querySelector('[data-slot="pick-back"]')!);
  await frame();
  expect([heard, active()]).toEqual([['b', null], option('b')]);
});

function Round() {
  return (
    <Turns keys={Object.keys(NAMES)}>
      {({ current, handled, left, total }) =>
        current ? (
          <>
            <p data-test="where">{`${handled.length + 1} of ${total}, ${left.length} left`}</p>
            <TurnsName>{NAMES[current]}</TurnsName>
            <TurnsSkip>Skip</TurnsSkip>
          </>
        ) : (
          <TurnsName>All done</TurnsName>
        )
      }
    </Turns>
  );
}

test('turns: skipping brings the next round and puts the keyboard on its name; past the last it comes round again', async () => {
  draw(<Round />);
  const name = () => document.querySelector<HTMLElement>('[data-slot="turns-name"]')!;
  const skip = () => document.querySelector<HTMLButtonElement>('[data-slot="turns-skip"]')!;
  expect([name().textContent, name().tabIndex]).toEqual(['Andre', -1]);
  press(skip());
  await frame();
  expect(name().textContent).toBe('Bea');
  expect(active()).toBe(name());
  press(skip());
  await frame();
  press(skip());
  await frame();
  expect(name().textContent).toBe('Andre');
  expect(document.querySelector('[data-test="where"]')!.textContent).toBe('1 of 3, 3 left');
});
