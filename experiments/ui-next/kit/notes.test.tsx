import { act } from 'react';
import { afterEach, expect, test } from 'vitest';
import { Composer, RecordTimeline, type TimelineEntry } from '../src/notes';
import { applyMark, continueList, Prose } from '../src/prose';
import { clear, draw, key, labelled } from './testing';

afterEach(() => {
  clear();
  window.sessionStorage.clear();
});

const settle = () => act(() => new Promise<void>((done) => setTimeout(done, 0)));
const press = (part: Element) => act(() => part.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
/* Types into a controlled textarea the way a browser does: the element's own setter, then the event React hears. */
const type = (box: HTMLTextAreaElement, text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
const box = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add a note"]')!;
const button = (name: string) =>
  [...document.querySelectorAll('button')].find((one) => (one.getAttribute('aria-label') ?? one.textContent)?.startsWith(name))!;

/* ---------- words with a little shape ---------- */

test('prose is drawn as elements: strong, emphasis, code, links, lists and paragraphs', () => {
  draw(<Prose>{'Called **Andre**, _twice_. See `AC-101`.\nSame paragraph.\n\n- rent\n- the fee\n\n1. first\n2. second'}</Prose>);
  const prose = document.querySelector('[data-slot="prose"]')!;
  expect([...prose.children].map((block) => block.tagName)).toEqual(['P', 'UL', 'OL']);
  expect(prose.querySelector('strong')?.textContent).toBe('Andre');
  expect(prose.querySelector('em')?.textContent).toBe('twice');
  expect(prose.querySelector('code')?.textContent).toBe('AC-101');
  expect(prose.querySelectorAll('p br').length).toBe(1);
  expect([...prose.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['rent', 'the fee', 'first', 'second']);
});

test('nothing a note says becomes a tag, and a link goes only where a reader would expect', () => {
  draw(
    <Prose>
      {'<img src=x onerror=alert(1)> [pay](javascript:alert(1)) [the charge](https://lintel.example/118) and https://lintel.example/a.'}
    </Prose>,
  );
  const prose = document.querySelector('[data-slot="prose"]')!;
  expect(prose.querySelector('img')).toBeNull();
  expect(prose.textContent).toContain('<img src=x onerror=alert(1)>');
  expect([...prose.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
    'https://lintel.example/118',
    'https://lintel.example/a',
  ]);
  expect(prose.textContent).toContain('[pay](javascript:alert(1))');
});

test('a mark wraps what is selected, a second press takes it off, and nothing selected leaves the caret between', () => {
  const once = applyMark('Waived once', 0, 6, 'strong');
  expect(once).toEqual({ text: '**Waived** once', start: 2, end: 8 });
  expect(applyMark(once.text, once.start, once.end, 'strong')).toEqual({ text: 'Waived once', start: 0, end: 6 });
  expect(applyMark('ab', 1, 1, 'emphasis')).toEqual({ text: 'a__b', start: 2, end: 2 });
  // A link with words chosen selects the address to be typed over.
  const link = applyMark('see the charge', 4, 14, 'link');
  expect([link.text, link.text.slice(link.start, link.end)]).toEqual(['see [the charge](https://)', 'https://']);
  // A list marks every line the selection touches, and takes the marks off again.
  const list = applyMark('rent\nthe fee', 2, 8, 'list');
  expect(list.text).toBe('- rent\n- the fee');
  expect(applyMark(list.text, list.start, list.end, 'list').text).toBe('rent\nthe fee');
});

test('Enter goes on with a list, counts a numbered one, and ends it on an empty item', () => {
  expect(continueList('- rent', 6)?.text).toBe('- rent\n- ');
  expect(continueList('1. first', 8)?.text).toBe('1. first\n2. ');
  expect(continueList('- rent\n- ', 9)).toEqual({ text: '- rent\n', start: 7, end: 7 });
  expect(continueList('plain words', 11)).toBeUndefined();
});

/* ---------- the box a note is sent from ---------- */

test('what is typed and not sent is kept, and cleared once it has gone', async () => {
  const sent: string[] = [];
  draw(<Composer label="Add a note" draftKey="lease-1" onSend={(said) => void sent.push(said)} />);
  expect(button('Send').disabled).toBe(true);
  type(box(), 'Half a note');
  clear();
  // Another visit to the same record finds it.
  draw(<Composer label="Add a note" draftKey="lease-1" onSend={(said) => void sent.push(said)} />);
  expect(box().value).toBe('Half a note');
  key(box(), 'Enter', { ctrlKey: true });
  await settle();
  expect([sent, box().value, window.sessionStorage.getItem('m-draft:lease-1')]).toEqual([['Half a note'], '', null]);
});

test('a send that fails leaves the words in the box and says why', async () => {
  draw(
    <Composer
      label="Add a note"
      onSend={() => {
        throw new Error('The connection dropped.');
      }}
    />,
  );
  type(box(), 'Waived once');
  press(button('Send'));
  await settle();
  expect(box().value).toBe('Waived once');
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('The connection dropped.');
});

/* ---------- a record's timeline ---------- */

const NOW = new Date(2026, 10, 14, 15, 0);
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();
const ENTRIES: TimelineEntry[] = [
  { id: 'c', author: 'Maya Lin', at: at(14, 14, 18), body: 'He asked about the fee.' },
  { id: 'a', kind: 'event', at: at(5, 9, 34), title: 'Late fee charged' },
  { id: 'b', author: 'Jonas Weber', at: at(13, 8, 34), body: 'Receipt sent.', reactions: [{ key: '👍', count: 2, mine: true }] },
];

test('a timeline is oldest first under the day it happened, with recent times said as how long ago', () => {
  draw(<RecordTimeline label="Lease timeline" entries={ENTRIES} now={NOW} />);
  expect([...document.querySelectorAll('[data-slot="timeline-day"] > h2')].map((day) => day.textContent)).toEqual([
    'Thursday, November 5',
    'Yesterday',
    'Today',
  ]);
  expect([...document.querySelectorAll('time')].map((time) => time.textContent)).toEqual(['9:34 AM', '8:34 AM', '42 min. ago']);
  // Read only: no box, and a reaction is not a button.
  expect(document.querySelector('[data-slot="composer"]')).toBeNull();
  expect(document.querySelector('[data-slot="timeline-reactions"]')).toBeNull();
});

test('a note is shown the moment it is sent, and one that does not arrive can be taken back into the box', async () => {
  let fail = true;
  let arrive: (() => void) | undefined;
  const sent: string[] = [];
  draw(
    <RecordTimeline
      label="Lease timeline"
      entries={ENTRIES}
      me="Maya Lin"
      now={NOW}
      onSend={(said) =>
        new Promise<void>((done, refuse) => {
          arrive = () => {
            if (fail) refuse(new Error('Not sent.'));
            else {
              sent.push(said);
              done();
            }
          };
        })
      }
    />,
  );
  type(box(), 'Waived once');
  press(button('Send'));
  await settle();
  expect([box().value, document.querySelector('[data-pending] [data-slot="timeline-state"]')?.textContent]).toEqual(['', 'Sending']);
  await act(async () => arrive?.());
  expect(document.querySelector('[data-failed] [data-slot="timeline-state"]')?.textContent).toBe('Not sent.');
  press(button('Edit'));
  expect([box().value, document.querySelector('[data-failed]')]).toEqual(['Waived once', null]);
  // Sent again, it goes.
  fail = false;
  press(button('Send'));
  await settle();
  await act(async () => arrive?.());
  expect([sent, document.querySelector('[data-slot="timeline-pending"]')]).toEqual([['Waived once'], null]);
});

test("a reaction is a button that says its mark, its count and whether it is the reader's", () => {
  const heard: string[] = [];
  draw(<RecordTimeline label="Lease timeline" entries={ENTRIES} now={NOW} onReact={(entry, mark) => heard.push(`${entry.id} ${mark}`)} />);
  const chip = labelled('👍, 2');
  expect(chip.getAttribute('aria-pressed')).toBe('true');
  press(chip);
  expect(heard).toEqual(['b 👍']);
});
