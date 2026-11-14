import { act } from 'react';
import { afterEach, expect, test } from 'vitest';
import { Attachments } from '../src/attachments';
import { clear, draw, key } from './testing';

afterEach(clear);

const press = (part: Element) => act(() => part.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
const FILES = [
  { id: 'a', name: 'Signed lease.png', href: 'data:image/png;base64,AAAA', size: 184_320, when: 'Nov 1', by: 'Maya Lin' },
  { id: 'b', name: 'Certificate.docx', href: '#', size: 900 },
];
const button = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('button, a')].find(
    (one) => (one.getAttribute('aria-label') ?? one.textContent)?.trim() === name,
  )!;

test('a file is a row: what it is called, how big, when and by whom, a way to keep it and a way to take it off', () => {
  const removed: string[] = [];
  draw(<Attachments label="Files" files={FILES} onRemove={(file) => removed.push(file.id)} />);
  const rows = [...document.querySelectorAll('[data-slot="attachments"] li')];
  expect(rows.map((row) => row.querySelector('[data-slot="attachment-words"]')?.textContent)).toEqual([
    'Signed lease.png180 KB · Nov 1 · Maya Lin',
    'Certificate.docx900 B',
  ]);
  expect(button('Download Signed lease.png').getAttribute('download')).toBe('Signed lease.png');
  press(button('Remove Certificate.docx'));
  expect(removed).toEqual(['b']);
});

test('a file opens where it stands: a picture as one, and a kind that cannot be shown says so', () => {
  draw(<Attachments label="Files" files={FILES} />);
  press(button('Signed lease.png'));
  const box = document.querySelector<HTMLElement>('[data-kind="lightbox"]')!;
  expect([
    box.getAttribute('data-file'),
    box.querySelector('[data-slot="lightbox-count"]')?.textContent,
    box.querySelector('img')?.getAttribute('alt'),
  ]).toEqual(['image', '1 of 2', 'Signed lease.png']);
  key(box, 'ArrowRight');
  expect([box.getAttribute('data-file'), box.querySelector('[data-slot="file-preview-none"]')?.textContent]).toEqual([
    'other',
    'This kind of file is not shown here. Download it to open it.',
  ]);
});

test('a record with no files says so', () => {
  draw(<Attachments label="Files" files={[]} />);
  expect(document.querySelector('[data-slot="attachments-empty"]')?.textContent).toBe('No files yet.');
});
