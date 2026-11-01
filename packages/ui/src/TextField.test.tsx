/** The form's text boxes: wired to the Field, masked on the way in and out, and a mark whose room is always kept. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { MaskedField, MoneyField, TextField, ValidMark } from './TextField.js';
import { masks } from './masks.js';

afterEach(cleanup);

function Typed({ valid }: { valid?: boolean }) {
  const [value, set] = useState('');
  return <TextField label="Email" value={value} onChange={set} valid={valid} type="email" />;
}

test('the label names the box, typing reports the text, and autofill is off unless asked', async () => {
  const user = userEvent.setup();
  render(<Typed />);
  const box = screen.getByRole('textbox', { name: 'Email' });
  expect(box).toHaveAttribute('type', 'email');
  expect(box).toHaveAttribute('autocomplete', 'off');
  await user.type(box, 'a@b.co');
  expect(box).toHaveValue('a@b.co');
});

test('a problem is said in the description and marks the box invalid; its line was already in the flow', () => {
  const { rerender } = render(<TextField label="Email" value="" onChange={() => {}} hint="Where we write." />);
  const line = () => document.querySelector('.form-field-problem') as HTMLElement;
  expect(line()).not.toHaveAttribute('hidden');
  expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-invalid');
  rerender(<TextField label="Email" value="" onChange={() => {}} hint="Where we write." problem="Enter an email." />);
  const box = screen.getByRole('textbox', { name: 'Email' });
  expect(box).toHaveAttribute('aria-invalid', 'true');
  expect(box).toHaveAccessibleDescription('Where we write. Enter an email.');
  expect(document.querySelector('.form-field-reserve')).toBeInTheDocument();
});

test('reserve off lets the empty problem line go, as a Field does', () => {
  render(<TextField label="Email" value="" onChange={() => {}} reserve={false} />);
  expect(document.querySelector('.form-field-problem')).toHaveAttribute('hidden');
});

test('the mark is decorative, and its room is kept from the first draw, shown or not', () => {
  const { rerender } = render(<Typed valid={false} />);
  expect(document.querySelector('.field-box')).toHaveClass('has-mark');
  expect(document.querySelector('.field-mark')).toBeNull();
  rerender(<Typed valid />);
  expect(document.querySelector('.field-mark')).toHaveAttribute('aria-hidden', 'true');
  rerender(<Typed />);
  expect(document.querySelector('.field-box')).not.toHaveClass('has-mark');
});

test('an optional word stands beside the label, outside its name, and a tip rides beside it', async () => {
  const user = userEvent.setup();
  render(
    <TextField
      label="Employer"
      optional="(optional)"
      tip={{ text: 'Who pays you.', label: 'More information' }}
      value=""
      onChange={() => {}}
    />,
  );
  expect(screen.getByRole('textbox', { name: 'Employer' })).toBeInTheDocument();
  expect(document.querySelector('.form-field-optional-word')).toHaveTextContent('(optional)');
  await user.click(screen.getByRole('button', { name: 'More information' }));
  expect(screen.getByRole('tooltip')).toHaveTextContent('Who pays you.');
});

test('the box reports leaving it, takes a ref, and honors read-only and disabled', async () => {
  const user = userEvent.setup();
  const blur = vi.fn();
  const ref = { current: null as HTMLInputElement | null };
  render(<TextField label="Name" value="x" onChange={() => {}} onBlur={blur} inputRef={ref} readOnly />);
  expect(ref.current).toBe(screen.getByRole('textbox'));
  await user.click(screen.getByRole('textbox'));
  await user.tab();
  expect(blur).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
});

test('a masked box draws the mask and keeps the digits', async () => {
  const user = userEvent.setup();
  const seen: string[] = [];
  function Phone() {
    const [raw, set] = useState('');
    return (
      <MaskedField
        label="Phone"
        mask={masks.phone}
        value={raw}
        onChange={(next) => {
          seen.push(next);
          set(next);
        }}
      />
    );
  }
  render(<Phone />);
  const box = screen.getByRole('textbox', { name: 'Phone' });
  expect(box).toHaveAttribute('inputmode', 'tel');
  await user.type(box, '(678) 678-6781 55');
  expect(box).toHaveValue('678-678-6781');
  expect(seen.at(-1)).toBe('6786786781');
  await user.keyboard('{Backspace}');
  expect(box).toHaveValue('678-678-678');
});

test('a typed date shows its pattern as the placeholder and stays slashes and digits', async () => {
  const user = userEvent.setup();
  function Day() {
    const [raw, set] = useState('');
    return <MaskedField label="Born" mask={masks.date} value={raw} onChange={set} />;
  }
  render(<Day />);
  const box = screen.getByRole('textbox', { name: 'Born' });
  expect(box).toHaveAttribute('placeholder', 'MM/DD/YYYY');
  await user.type(box, '02292024');
  expect(box).toHaveValue('02/29/2024');
});

test('money is drawn with its symbol and the groups, and the value is the digits', async () => {
  const user = userEvent.setup();
  const last = vi.fn();
  function Pay({ symbol }: { symbol?: string }) {
    const [raw, set] = useState('');
    return (
      <MoneyField
        label="Income"
        symbol={symbol}
        value={raw}
        onChange={(v) => {
          last(v);
          set(v);
        }}
      />
    );
  }
  render(<Pay />);
  const box = screen.getByRole('textbox', { name: 'Income' });
  await user.type(box, '25000');
  expect(box).toHaveValue('$25,000');
  expect(last).toHaveBeenLastCalledWith('25000');
  cleanup();
  render(<Pay symbol="" />);
  await user.type(screen.getByRole('textbox', { name: 'Income' }), '1200');
  expect(screen.getByRole('textbox', { name: 'Income' })).toHaveValue('1,200');
});

test('a lent picture replaces the drawn check', () => {
  render(<ValidMark icon={<svg data-testid="own" />} />);
  expect(screen.getByTestId('own')).toBeInTheDocument();
});
