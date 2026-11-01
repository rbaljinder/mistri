/* The field's behaviour is @mistriwork/ui's (packages/ui/src/DateField.test.tsx); here, what the kit lends it. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { DateField } from './DateField.js';

vi.mock('@mistriwork/ui/internal/anchor.js', () => ({
  zoomAnchor: () => null,
  layoutViewport: () => ({ x: 0, y: 0, width: 1200, height: 900 }),
}));
afterEach(cleanup);

test("the field says the catalog's words and draws the kit's calendar icon", async () => {
  render(<DateField id="due" aria-label="Due" value="2026-09-13" onChange={() => {}} locale="en-US" />);
  const trigger = screen.getByRole('button', { name: 'Choose date for Due' });
  expect(trigger.querySelector('svg.tw-icon path')).not.toBeNull();
  expect(screen.getByRole('textbox', { name: 'Due' })).toHaveAccessibleDescription(
    'Date format: MM/DD/YYYY. Alt and Down arrow opens the calendar.',
  );
  await userEvent.setup().click(trigger);
  expect(await screen.findByRole('dialog', { name: 'Calendar for Due' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Previous month' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Today' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
});
