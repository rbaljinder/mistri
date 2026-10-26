/**
 * The gallery and its lightbox: a lead photo chosen from the thumbnails,
 * the lightbox opened on it, stepped with the buttons, the arrow keys and a
 * swipe, its neighbours fetched ahead, and focus back on the lead with the
 * photo last seen.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Gallery, type GalleryItem } from './Gallery.js';

const items: GalleryItem[] = [
  { id: '1', src: '/api/file?key=1&inline=1', alt: 'Front three-quarter', caption: 'Front three-quarter' },
  { id: '2', src: '/api/file?key=2&inline=1', alt: 'Side profile', caption: 'Side profile' },
  { id: '3', src: '/api/file?key=3&inline=1', alt: 'Rear three-quarter', caption: 'Rear three-quarter' },
  { id: '4', src: '/api/file?key=4&inline=1', alt: 'Wheel and lamp detail' },
];

const fetched: string[] = [];
beforeEach(() => {
  fetched.length = 0;
  /* The neighbours are fetched through Image objects: record what is asked for. */
  vi.stubGlobal(
    'Image',
    class {
      decoding = '';
      set src(value: string) {
        fetched.push(value);
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const lead = () => screen.getByRole('button', { name: /^View photo/ });
const leadSrc = () => lead().parentElement!.querySelector('img')!.getAttribute('src');

test('the lead is the first photo, and a thumbnail chooses another', async () => {
  render(<Gallery items={items} label="Photos" emptyText="No photos yet." />);
  expect(leadSrc()).toBe(items[0].src);
  expect(lead()).toHaveAccessibleName('View photo 1 of 4 larger: Front three-quarter');
  expect(screen.getByText('Front three-quarter', { selector: '.gallery-caption' })).toBeInTheDocument();
  const strip = screen.getByRole('group', { name: 'Choose a photo' });
  const thumbs = within(strip).getAllByRole('button');
  expect(thumbs).toHaveLength(4);
  expect(thumbs[0]).toHaveAttribute('aria-current', 'true');
  await userEvent.setup().click(thumbs[2]);
  expect(leadSrc()).toBe(items[2].src);
  expect(thumbs[2]).toHaveAttribute('aria-current', 'true');
  expect(thumbs[0]).not.toHaveAttribute('aria-current');
  expect(screen.getByText('3 / 4')).toBeInTheDocument();
});

test('the strip is one tab stop, moved with the arrows, Home and End', async () => {
  render(<Gallery items={items} label="Photos" emptyText="No photos yet." />);
  const user = userEvent.setup();
  const thumbs = within(screen.getByRole('group', { name: 'Choose a photo' })).getAllByRole('button');
  expect(thumbs.map((thumb) => thumb.tabIndex)).toEqual([0, -1, -1, -1]);
  thumbs[0].focus();
  await user.keyboard('{ArrowRight}');
  expect(thumbs[1]).toHaveFocus();
  expect(leadSrc()).toBe(items[1].src);
  await user.keyboard('{End}');
  expect(thumbs[3]).toHaveFocus();
  await user.keyboard('{ArrowRight}');
  expect(thumbs[0]).toHaveFocus();
  await user.keyboard('{ArrowLeft}');
  expect(thumbs[3]).toHaveFocus();
  await user.keyboard('{Home}');
  expect(thumbs[0]).toHaveFocus();
});

test('the lead opens the lightbox on its photo; the steps, the arrow keys and the counter follow; Escape hands focus back', async () => {
  render(<Gallery items={items} label="Photos of the Corolla" emptyText="No photos yet." />);
  const user = userEvent.setup();
  await user.click(within(screen.getByRole('group', { name: 'Choose a photo' })).getAllByRole('button')[1]);
  await user.click(lead());
  const dialog = await screen.findByRole('dialog', { name: 'Photos of the Corolla' });
  const photo = () => within(dialog).getByRole('img');
  expect(photo()).toHaveAttribute('src', items[1].src);
  expect(photo()).toHaveAttribute('alt', 'Side profile');
  expect(within(dialog).getByText('2 of 4')).toBeInTheDocument();
  expect(within(dialog).getByText('Side profile', { selector: 'figcaption' })).toBeInTheDocument();
  // The neighbours either side were asked for before a step was taken.
  expect(fetched).toEqual(expect.arrayContaining([items[0].src, items[2].src]));

  await user.click(within(dialog).getByRole('button', { name: 'Next photo' }));
  expect(within(dialog).getByText('3 of 4')).toBeInTheDocument();
  await user.keyboard('{ArrowRight}');
  expect(within(dialog).getByText('4 of 4')).toBeInTheDocument();
  expect(within(dialog).queryByRole('figure')?.querySelector('figcaption')).toBeFalsy();
  // Past the last, the first: the counter says where the reader is.
  await user.keyboard('{ArrowRight}');
  expect(within(dialog).getByText('1 of 4')).toBeInTheDocument();
  await user.keyboard('{ArrowLeft}');
  expect(within(dialog).getByText('4 of 4')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Previous photo' }));
  expect(within(dialog).getByText('3 of 4')).toBeInTheDocument();

  await user.keyboard('{Escape}');
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  // The lead now shows the photo last seen, and has the focus back.
  expect(leadSrc()).toBe(items[2].src);
  await vi.waitFor(() => expect(lead()).toHaveFocus());
});

test('a sideways swipe steps on touch; a small or mostly vertical one does not, and the mouse never swipes', async () => {
  render(<Gallery items={items} label="Photos" emptyText="No photos yet." />);
  await userEvent.setup().click(lead());
  const dialog = await screen.findByRole('dialog');
  const stage = dialog.querySelector('.lightbox-stage')!;
  const swipe = (from: number, to: number, dy = 0, pointerType = 'touch') => {
    fireEvent.pointerDown(stage, { pointerId: 7, pointerType, clientX: from, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerId: 7, pointerType, clientX: to, clientY: 100 + dy });
  };
  swipe(300, 180);
  expect(within(dialog).getByText('2 of 4')).toBeInTheDocument();
  swipe(180, 300);
  expect(within(dialog).getByText('1 of 4')).toBeInTheDocument();
  swipe(300, 280);
  swipe(300, 240, 120);
  swipe(300, 100, 0, 'mouse');
  expect(within(dialog).getByText('1 of 4')).toBeInTheDocument();
});

test('the Close button closes it, and one photo draws no steps and no strip', async () => {
  render(<Gallery items={[items[0]]} label="Photos" emptyText="No photos yet." />);
  expect(screen.queryByRole('group', { name: 'Choose a photo' })).toBeNull();
  const user = userEvent.setup();
  await user.click(lead());
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).queryByRole('button', { name: 'Next photo' })).toBeNull();
  expect(within(dialog).getByText('1 of 1')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Close' }));
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('no photos says so', () => {
  render(<Gallery items={[]} label="Photos" emptyText="No photos yet." />);
  expect(screen.getByText('No photos yet.')).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
});

test('the lead steps where it is: Previous and Next beside it, wrapping, the counter and the strip following, the lightbox shut', async () => {
  render(<Gallery items={items} label="Photos" emptyText="No photos yet." />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Show the next photo' }));
  expect(leadSrc()).toBe(items[1].src);
  expect(screen.getByText('2 / 4')).toBeInTheDocument();
  expect(within(screen.getByRole('group', { name: 'Choose a photo' })).getAllByRole('button')[1]).toHaveAttribute('aria-current', 'true');
  await user.click(screen.getByRole('button', { name: 'Show the previous photo' }));
  await user.click(screen.getByRole('button', { name: 'Show the previous photo' }));
  expect(leadSrc()).toBe(items[3].src);
  // Stepping is not viewing: the lightbox opens only from the lead itself.
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('one photo has nothing to step to', () => {
  render(<Gallery items={[items[0]]} label="Photos" emptyText="No photos yet." />);
  expect(screen.queryByRole('button', { name: 'Show the next photo' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Show the previous photo' })).toBeNull();
});
