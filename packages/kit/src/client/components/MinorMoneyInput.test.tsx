/**
 * A money column kept in minor units: a person types and reads the figure,
 * "19.99", and the form and the database hold the cents, "1999" — in each
 * currency's own decimals, and never rounded on the way in.
 */
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

vi.mock('../core.js', () => ({
  state: { schema: { tables: [], foreignKeys: [] } },
  columnDisplay: () => null,
  emptyWord: () => 'Empty',
  findTable: (id: string) => ({ id, name: id, columns: [] }),
  refsFrom: () => [],
  openRecord: () => {},
}));

const { MinorMoneyInput, majorText, minorProblem } = await import('./MinorMoneyInput.js');
const { dressFor } = await import('./valueModel.js');

afterEach(cleanup);

function Box({ currency = 'USD', initial = '' }: { currency?: string; initial?: string }) {
  const [held, setHeld] = useState(initial);
  return (
    <>
      <MinorMoneyInput value={held} currency={currency} onChange={setHeld}>
        {(text, change) => <input aria-label="Price" value={text} onChange={(e) => change(e.target.value)} />}
      </MinorMoneyInput>
      <output data-testid="held">{held}</output>
    </>
  );
}

test('the box reads the figure and the form holds the cents', async () => {
  const user = userEvent.setup();
  render(<Box initial="1999" />);
  const box = screen.getByRole('textbox', { name: 'Price' }) as HTMLInputElement;
  expect(box.value).toBe('19.99');
  await user.clear(box);
  await user.type(box, '7.5');
  expect(screen.getByTestId('held').textContent).toBe('750');
  /* Mid-typing text stays as typed; what it hands on is not an amount until it is one. */
  await user.type(box, '55');
  expect(box.value).toBe('7.555');
  expect(screen.getByTestId('held').textContent).toBe('7.555');
  expect(minorProblem('7.555', 'USD')).toMatch(/2/);
  await user.clear(box);
  expect(screen.getByTestId('held').textContent).toBe('');
});

test('a currency without decimals is typed whole, and one with three keeps all three', async () => {
  const user = userEvent.setup();
  render(<Box currency="JPY" />);
  await user.type(screen.getByRole('textbox', { name: 'Price' }), '1500');
  expect(screen.getByTestId('held').textContent).toBe('1500');
  expect(minorProblem('1.5', 'JPY')).not.toBe('');
  expect(majorText('1999', 'KWD')).toBe('1.999');
  expect(majorText('', 'USD')).toBe('');
  expect(minorProblem('1999', 'USD')).toBe('');
});

test('a minor-unit money value is dressed as its figure; a decimal one is left as it was', () => {
  const minor = dressFor({ format: 'money', minor: true, currency: 'USD' }, 1999) as { text: string };
  expect(minor.text).toBe('$19.99');
  const yen = dressFor({ format: 'money', minor: true, currency: 'JPY' }, 1999) as { text: string };
  expect(yen.text).toMatch(/1,999/);
  // A whole figure alone says no cents; one with cents says them.
  const decimal = dressFor({ format: 'money', currency: 'USD' }, 1999) as { text: string };
  expect(decimal.text).toBe('$1,999');
  expect((dressFor({ format: 'money', currency: 'USD' }, '1999.50') as { text: string }).text).toBe('$1,999.50');
});
