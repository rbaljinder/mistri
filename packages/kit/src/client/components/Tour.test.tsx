/** The tour card: counted stops, the arrows and buttons that move it, and the ways out. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

vi.mock('../core.js', () => ({
  trapFocus: () => () => {},
  viewportBox: (n: Element) => n.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
const { Tour } = await import('./Tour.js');

const stops = [
  { anchor: '#querybar', title: 'Ask in words', body: 'Table first.', code: 'customer active = true' },
  { anchor: null, title: 'A row is a place', body: 'Click any row.' },
  { anchor: '#search-button', title: 'And the rest', body: '⌘K jumps.' },
];

afterEach(cleanup);

test('counts the stops, shows the code as code, and Next walks to Done', async () => {
  const user = userEvent.setup();
  const onEnd = vi.fn();
  render(<Tour stops={stops} onEnd={onEnd} />);
  expect(screen.getByRole('dialog')).toHaveTextContent('1 of 3');
  expect(document.querySelector('.tour-code')).toHaveTextContent('customer active = true');
  expect(screen.getByText('Back')).not.toBeVisible();
  expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('2 of 3');
  /* An anchorless stop centres the card and dims the scrim itself. */
  expect(document.querySelector('.tour-scrim')).toHaveClass('dim');
  fireEvent.keyDown(document, { key: 'ArrowRight' });
  expect(screen.getByRole('dialog')).toHaveTextContent('3 of 3');
  expect(screen.getByText('Skip')).not.toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Done' }));
  expect(onEnd).toHaveBeenCalledTimes(1);
});

test('Escape, Skip and a click on the scrim all end it', async () => {
  const user = userEvent.setup();
  const onEnd = vi.fn();
  render(<Tour stops={stops} onEnd={onEnd} />);
  fireEvent.keyDown(document, { key: 'Escape' });
  await user.click(screen.getByRole('button', { name: 'Skip' }));
  fireEvent.click(document.querySelector('.tour-scrim')!);
  expect(onEnd).toHaveBeenCalledTimes(3);
  fireEvent.keyDown(document, { key: 'ArrowLeft' });
  expect(screen.getByRole('dialog')).toHaveTextContent('1 of 3');
});
