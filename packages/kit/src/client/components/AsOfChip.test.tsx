import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { AsOfChip } from './AsOfChip.js';

afterEach(() => cleanup());

test('the as-of chip says the moment App logic reads, and is absent on the real clock', () => {
  const { container } = render(<AsOfChip offset={0} />);
  expect(container.innerHTML).toBe('');
  render(<AsOfChip offset={Date.UTC(2026, 0, 5, 12) - Date.now()} />);
  const chip = screen.getByText(/^As of /);
  expect(chip.textContent).toMatch(/Jan 5, 2026/);
  expect(chip.getAttribute('title')).toMatch(/--as-of/);
});
