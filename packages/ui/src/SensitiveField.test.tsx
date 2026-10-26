/** The sensitive box: dots while hidden, Show beside the box, and the value goes nowhere but the caller's state. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { SensitiveField } from './SensitiveField.js';
import { masks } from './masks.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Ssn({ start = '' }: { start?: string }) {
  const [raw, set] = useState(start);
  return (
    <>
      <SensitiveField
        label="SSN"
        mask={masks.ssn}
        value={raw}
        onChange={set}
        showLabel="Show"
        hideLabel="Hide"
        note="Stored securely"
        valid={raw.length === 9}
      />
      <output data-testid="raw">{raw}</output>
    </>
  );
}

test('hidden, the box holds dots and the digits are never in the page', async () => {
  const user = userEvent.setup();
  render(<Ssn />);
  const box = screen.getByRole('textbox', { name: 'SSN' });
  await user.type(box, '123456789');
  expect(screen.getByTestId('raw')).toHaveTextContent('123456789');
  expect(box).toHaveValue('•'.repeat(11));
  expect(document.body.innerHTML).not.toMatch(/123-45-6789/);
  expect(box).toHaveAttribute('autocomplete', 'off');
  expect(box).toHaveAttribute('spellcheck', 'false');
});

test('Show draws the number with its mask; Hide puts the dots back', async () => {
  const user = userEvent.setup();
  render(<Ssn start="123456789" />);
  const box = screen.getByRole('textbox', { name: 'SSN' });
  await user.click(screen.getByRole('button', { name: 'Show' }));
  expect(box).toHaveValue('123-45-6789');
  await user.click(screen.getByRole('button', { name: 'Hide' }));
  expect(box).toHaveValue('•'.repeat(11));
});

test('the button stands beside the box, not inside it', () => {
  render(<Ssn />);
  const button = screen.getByRole('button', { name: 'Show' });
  expect(button.closest('.field-box')).toBeNull();
  expect(button.parentElement).toHaveClass('field-with-action');
  expect(button.parentElement).toContainElement(screen.getByRole('textbox'));
});

test('backspace takes the last digit off, and typed text past the mask is dropped', async () => {
  const user = userEvent.setup();
  render(<Ssn start="123456789" />);
  const box = screen.getByRole('textbox', { name: 'SSN' });
  await user.type(box, '12');
  expect(screen.getByTestId('raw')).toHaveTextContent('123456789');
  await user.type(box, '{Backspace}{Backspace}');
  expect(screen.getByTestId('raw')).toHaveTextContent('1234567');
});

test('it logs and stores nothing', async () => {
  const user = userEvent.setup();
  const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'debug'), vi.spyOn(Storage.prototype, 'setItem')];
  render(<Ssn />);
  await user.type(screen.getByRole('textbox', { name: 'SSN' }), '123456789');
  await user.click(screen.getByRole('button', { name: 'Show' }));
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

test('the note and the mark are drawn, and the mark is decorative', async () => {
  render(<Ssn start="123456789" />);
  expect(screen.getByText('Stored securely')).toBeInTheDocument();
  expect(document.querySelector('.field-mark')).toHaveAttribute('aria-hidden', 'true');
});
