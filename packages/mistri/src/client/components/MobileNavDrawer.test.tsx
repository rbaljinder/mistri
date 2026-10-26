/**
 * The phone's App menu: a modal drawer that takes the focus onto its close
 * button, holds it, and gives it back to the button that opened it however
 * it closes — the ×, Escape, a room picked, a group toggled — and whose
 * Search hands over to the palette.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { setPublicVisitor } from '../publicVisitor.js';

const mocks = vi.hoisted(() => ({ palette: vi.fn() }));
vi.mock('../../../../kit/src/client/palette.js', () => ({ openPalette: mocks.palette }));
/* The sidebar's tree is its own suite's; here it is two rooms. */
vi.mock('../../../../kit/src/client/components/Sidebar.js', () => ({
  Sidebar: ({ onSelect }: { onSelect: () => void }) => (
    <>
      <li>
        <button type="button" onClick={onSelect}>
          Leads
        </button>
      </li>
      <li>
        <button type="button" onClick={onSelect}>
          Tasks
        </button>
      </li>
    </>
  ),
}));

const { MobileNavDrawer } = await import('./MobileNavDrawer.js');

function draw(app: Parameters<typeof MobileNavDrawer>[0]['app'] = { name: 'Compass' }) {
  render(<MobileNavDrawer app={app} />);
  return screen.getByRole('button', { expanded: false });
}
const drawer = () => screen.queryByRole('dialog', { name: 'Compass navigation' });

beforeEach(() => {
  mocks.palette.mockReset();
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

test('opens a named drawer with the focus on its close button, and the × gives the focus back', async () => {
  const trigger = draw();
  expect(trigger).toHaveAttribute('aria-controls', 'mobile-app-navigation');
  await userEvent.click(trigger);
  expect(drawer()).toBeInTheDocument();
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('navigation', { name: 'Compass menu' })).toBeInTheDocument();
  const close = document.querySelector<HTMLButtonElement>('.mobile-nav-close')!;
  await waitFor(() => expect(close).toHaveFocus());
  await userEvent.click(close);
  await waitFor(() => expect(drawer()).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('Tab stays inside the drawer', async () => {
  const trigger = draw();
  await userEvent.click(trigger);
  const inside = drawer()!;
  await waitFor(() => expect(inside.contains(document.activeElement)).toBe(true));
  for (let i = 0; i < 8; i++) {
    await userEvent.tab();
    expect(inside.contains(document.activeElement)).toBe(true);
  }
  await userEvent.tab({ shift: true });
  expect(inside.contains(document.activeElement)).toBe(true);
});

test('Escape and a picked room close it and give the focus back', async () => {
  const trigger = draw();
  await userEvent.click(trigger);
  await waitFor(() => expect(drawer()).toBeInTheDocument());
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(drawer()).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());

  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole('button', { name: 'Tasks' }));
  await waitFor(() => expect(drawer()).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());
});

test('Search closes the drawer and opens the palette; an App without search draws none', async () => {
  const trigger = draw();
  await userEvent.click(trigger);
  const search = document.querySelector<HTMLButtonElement>('.mobile-nav-search')!;
  await userEvent.click(search);
  await waitFor(() => expect(drawer()).toBeNull());
  await waitFor(() => expect(mocks.palette).toHaveBeenCalledOnce());
  cleanup();

  const plain = draw({ name: 'Compass', ui: { shell: { search: false } } as never });
  await userEvent.click(plain);
  await waitFor(() => expect(drawer()).toBeInTheDocument());
  expect(document.querySelector('.mobile-nav-search')).toBeNull();
});

test('a signed-out visitor has no header search unless the App offers it to one', async () => {
  setPublicVisitor(true);
  try {
    await userEvent.click(draw());
    await waitFor(() => expect(drawer()).toBeInTheDocument());
    expect(document.querySelector('.mobile-nav-search')).toBeNull();
    cleanup();
    await userEvent.click(draw({ name: 'Compass', ui: { shell: { search: 'everyone' } } as never }));
    await waitFor(() => expect(drawer()).toBeInTheDocument());
    expect(document.querySelector('.mobile-nav-search')).toBeInTheDocument();
  } finally {
    setPublicVisitor(false);
  }
});
