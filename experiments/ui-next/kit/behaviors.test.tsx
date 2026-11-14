import { useState } from 'react';
import { afterEach, expect, test } from 'vitest';
import { Sortable, SortableHandle, SortableItem } from '../src/behaviors/Sortable';
import { Transfer, TransferHandle, TransferItem, TransferList } from '../src/behaviors/Transfer';
import { Widths, WidthsColumn, WidthsHandle } from '../src/behaviors/Widths';
import { all, clear, draw, focus, key, one } from './testing';

afterEach(clear);

/* The behaviors, driven the way a keyboard drives them: what a pointer does is run in a real browser. */
function Seasons({ heard }: { heard?: (order: string[], reason: string) => void }) {
  const [order, setOrder] = useState(['Spring', 'Summer', 'Autumn', 'Winter']);
  return (
    <Sortable
      aria-label="Seasons"
      value={order}
      onValueChange={(next, details) => {
        heard?.(next, details.reason);
        setOrder(next);
      }}
    >
      {(season) => (
        <SortableItem key={season} value={season}>
          {season}
        </SortableItem>
      )}
    </Sortable>
  );
}
const said = () => all('option').map((item) => item.textContent);

test('a sortable list is a listbox of options, one of them the tab stop', () => {
  draw(<Seasons />);
  const list = one('listbox', 'Seasons');
  expect(list.getAttribute('data-slot')).toBe('sortable');
  expect(said()).toEqual(['Spring', 'Summer', 'Autumn', 'Winter']);
  expect(all('option').filter((item) => item.tabIndex === 0).length).toBe(1);
  expect(all('option')[0]?.getAttribute('data-slot')).toBe('sortable-item');
});

test('Space picks an item up, the arrows place it, Space drops it, and the change says how', () => {
  const heard: [string[], string][] = [];
  draw(<Seasons heard={(order, reason) => heard.push([order, reason])} />);
  focus(one('option', 'Summer'));
  key(one('option', 'Summer'), ' ');
  expect(one('option', 'Summer').hasAttribute('data-grabbed')).toBe(true);
  key(one('option', 'Summer'), 'ArrowDown');
  key(one('option', 'Summer'), 'ArrowDown');
  // The list shows where it would land before it is dropped, and nothing has been said yet.
  expect(said()).toEqual(['Spring', 'Autumn', 'Winter', 'Summer']);
  expect(heard).toEqual([]);
  key(one('option', 'Summer'), ' ');
  expect(said()).toEqual(['Spring', 'Autumn', 'Winter', 'Summer']);
  expect(heard).toEqual([[['Spring', 'Autumn', 'Winter', 'Summer'], 'move-key']]);
  expect(one('option', 'Summer').hasAttribute('data-grabbed')).toBe(false);
});

test('Escape puts a picked-up item back', () => {
  draw(<Seasons />);
  focus(one('option', 'Spring'));
  key(one('option', 'Spring'), ' ');
  key(one('option', 'Spring'), 'ArrowDown');
  expect(said()).toEqual(['Summer', 'Spring', 'Autumn', 'Winter']);
  key(one('option', 'Spring'), 'Escape');
  expect(said()).toEqual(['Spring', 'Summer', 'Autumn', 'Winter']);
});

test('an item with controls of its own is a list item picked up by its handle', () => {
  function Columns() {
    const [order, setOrder] = useState(['Home', 'Building', 'Rent']);
    return (
      <Sortable by="handle" aria-label="Columns" value={order} onValueChange={setOrder}>
        {(column) => (
          <SortableItem key={column} value={column}>
            <SortableHandle aria-label={`Move ${column}`} />
            <input type="checkbox" aria-label={`Show ${column}`} defaultChecked />
            {column}
          </SortableItem>
        )}
      </Sortable>
    );
  }
  draw(<Columns />);
  expect(one('list', 'Columns').getAttribute('data-slot')).toBe('sortable');
  expect(all('listitem').map((item) => item.textContent)).toEqual(['Home', 'Building', 'Rent']);
  const grip = (name: string) => document.querySelector<HTMLElement>(`[aria-label="Move ${name}"]`)!;
  expect(grip('Rent').getAttribute('data-slot')).toBe('sortable-handle');
  focus(grip('Rent'));
  key(grip('Rent'), ' ');
  expect(grip('Rent').getAttribute('aria-pressed')).toBe('true');
  key(grip('Rent'), 'ArrowUp');
  key(grip('Rent'), 'ArrowUp');
  key(grip('Rent'), ' ');
  expect(all('listitem').map((item) => item.textContent)).toEqual(['Rent', 'Home', 'Building']);
  // The handle that moved still has the keyboard, so the next key is not lost.
  expect(document.activeElement).toBe(grip('Rent'));
});

/* Three lists, and a rule: Done takes nothing that is not being worked on. */
function Lanes({ heard }: { heard?: (move: { key: string; from: string; to: string; reason: string }) => void }) {
  const [lists, setLists] = useState<Record<string, string[]>>({ todo: ['Boiler', 'Lock'], doing: ['Tap'], done: [] });
  return (
    <Transfer
      value={lists}
      order={['todo', 'doing', 'done']}
      accepts={(key, list) => list !== 'done' || lists.doing?.includes(key) === true}
      onValueChange={(next, details) => {
        heard?.({ key: details.key, from: details.from, to: details.to, reason: details.reason });
        setLists(next);
      }}
    >
      {['todo', 'doing', 'done'].map((list) => (
        <TransferList key={list} value={list} aria-label={list}>
          {(name) => (
            <TransferItem key={name} value={name}>
              <TransferHandle aria-label={`Carry ${name}`} />
              {name}
            </TransferItem>
          )}
        </TransferList>
      ))}
    </Transfer>
  );
}
const inList = (list: string) =>
  [...document.querySelectorAll(`[data-list="${list}"] [data-slot="transfer-item"]`)].map((item) => item.textContent);
const handle = (name: string) => document.querySelector<HTMLElement>(`[aria-label="Carry ${name}"]`)!;

test('a handle picks an item up, Right carries it to the next list, Space drops it there', () => {
  const heard: unknown[] = [];
  draw(<Lanes heard={(move) => heard.push(move)} />);
  expect(inList('todo')).toEqual(['Boiler', 'Lock']);
  focus(handle('Boiler'));
  key(handle('Boiler'), ' ');
  expect(handle('Boiler').getAttribute('aria-pressed')).toBe('true');
  // While it is carried, the lists say which of them would take it.
  expect(document.querySelector('[data-list="doing"]')?.hasAttribute('data-takes')).toBe(true);
  expect(document.querySelector('[data-list="done"]')?.hasAttribute('data-refuses')).toBe(true);
  key(handle('Boiler'), 'ArrowRight');
  expect(document.querySelector('[data-list="doing"]')?.hasAttribute('data-over')).toBe(true);
  expect(heard).toEqual([]);
  key(handle('Boiler'), ' ');
  expect(inList('todo')).toEqual(['Lock']);
  expect(inList('doing')).toContain('Boiler');
  expect(heard).toEqual([{ key: 'Boiler', from: 'todo', to: 'doing', reason: 'move-key' }]);
  expect(document.querySelector('[data-takes], [data-refuses], [data-over]')).toBeNull();
});

test('a list that refuses an item is passed over', () => {
  draw(<Lanes />);
  focus(handle('Lock'));
  key(handle('Lock'), ' ');
  key(handle('Lock'), 'ArrowRight');
  key(handle('Lock'), 'ArrowRight');
  key(handle('Lock'), ' ');
  expect(inList('done')).toEqual([]);
  expect(inList('doing')).toContain('Lock');
});

test('Escape puts a carried item back where it was', () => {
  draw(<Lanes />);
  focus(handle('Tap'));
  key(handle('Tap'), ' ');
  key(handle('Tap'), 'ArrowRight');
  expect(inList('done')).toEqual(['Tap']);
  key(handle('Tap'), 'Escape');
  expect(inList('doing')).toEqual(['Tap']);
  expect(inList('done')).toEqual([]);
});

test('a column is sized from its header with Alt and the arrows, and given back with Alt and Backspace', () => {
  const heard: [Record<string, number>, string, string][] = [];
  function Table() {
    const [set, setSet] = useState<Record<string, number>>({ rent: 120 });
    return (
      <Widths
        value={set}
        step={10}
        min={80}
        onValueChange={(next, details) => {
          heard.push([next, details.reason, details.key]);
          setSet(next);
        }}
      >
        {(widths) => (
          <table>
            <thead>
              <tr>
                <WidthsColumn value="rent" label="Asking rent">
                  <button type="button">Asking rent</button>
                  <WidthsHandle />
                </WidthsColumn>
                <WidthsColumn value="status" label="Status">
                  Status
                </WidthsColumn>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td data-width={widths.rent ?? 'own'}>$1,685</td>
                <td>Occupied</td>
              </tr>
            </tbody>
          </table>
        )}
      </Widths>
    );
  }
  draw(<Table />);
  const head = () => document.querySelector<HTMLElement>('[data-slot="widths-column"]')!;
  expect(head().style.width).toBe('120px');
  expect(head().hasAttribute('data-sized')).toBe(true);
  expect(document.querySelector('td')?.getAttribute('data-width')).toBe('120');
  const button = document.querySelector('button')!;
  focus(button);
  key(button, 'ArrowRight', { altKey: true });
  expect(head().style.width).toBe('130px');
  key(button, 'ArrowLeft', { altKey: true, shiftKey: true });
  // Five steps back from 130 would be 80, which is as narrow as the column may be made.
  expect(head().style.width).toBe('80px');
  key(button, 'ArrowLeft', { altKey: true });
  expect(head().style.width).toBe('80px');
  key(button, 'Backspace', { altKey: true });
  expect(head().hasAttribute('data-sized')).toBe(false);
  expect(document.querySelector('td')?.getAttribute('data-width')).toBe('own');
  expect(heard.map(([, reason, column]) => `${reason}:${column}`)).toEqual(['move-key:rent', 'move-key:rent', 'clear-press:rent']);
  // An arrow without Alt is not the column's: it is left for whatever else is listening.
  key(button, 'ArrowRight');
  expect(head().hasAttribute('data-sized')).toBe(false);
});
