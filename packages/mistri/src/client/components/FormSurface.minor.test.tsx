import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { commandInput } from './CommandFields.js';
import { FormSurface, formArrives, type FormPresentation } from './FormSurface.js';

/* A money field with `minor: true` is typed in the major unit at the currency's own precision and sent as the exact
   text typed; the server reads it into the minor units a handler receives (test/command-money-minor.test.ts). */
const form = (input: object[]): FormPresentation => ({
  id: 'charge',
  label: 'Charge',
  style: 'intake',
  submitLabel: 'Submit',
  prefillable: [],
  review: false,
  input: input as FormPresentation['input'],
  steps: [{ id: 'only', label: 'Amount', fields: (input as { name: string }[]).map((each) => each.name) }],
});

afterEach(cleanup);

test('a minor-unit amount takes only the currency places while typed, shows them once typed, and is sent as typed text', async () => {
  const presented = form([{ name: 'amount', label: 'Amount', type: 'money', required: true, minor: true, min: 0 }]);
  await formArrives(presented);
  const submit = vi.fn(async () => ({ reference: 'C-1', receipt: { id: 'r1', status: 'applied' } }));
  render(<FormSurface form={presented} appName="Lintel" submit={submit} />);
  const box = await screen.findByRole('textbox', { name: /^Amount/ });
  // Dollars: two places at most, however many are typed.
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: '19.999' } });
  expect(box).toHaveValue('19.99');
  fireEvent.blur(box);
  expect(box).toHaveValue('19.99');
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: '1234.5' } });
  fireEvent.blur(box);
  // Said to the currency's places once typed, grouped as the locale groups.
  expect(box).toHaveValue('1,234.50');
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  // Exact decimal text, not a float, and not the minor units: the server reads those.
  expect((submit.mock.calls[0] as unknown[])[1]).toEqual({ amount: '1234.50' });
});

test('a field in a currency with no minor digits takes no decimal point, and a number input is untouched', async () => {
  const presented = form([
    { name: 'fee', label: 'Fee', type: 'money', required: true, minor: true, currency: 'JPY', min: 0 },
    { name: 'plain', label: 'Plain', type: 'money', required: true, step: 0.01, min: 0 },
  ]);
  await formArrives(presented);
  render(<FormSurface form={presented} appName="Lintel" submit={vi.fn()} />);
  const fee = await screen.findByRole('textbox', { name: /^Fee/ });
  const plain = await screen.findByRole('textbox', { name: /^Plain/ });
  fireEvent.focus(fee);
  fireEvent.change(fee, { target: { value: '1500.75' } });
  expect(fee).toHaveValue('1500');
  fireEvent.focus(plain);
  fireEvent.change(plain, { target: { value: '1500.755' } });
  expect(plain).toHaveValue('1500.755');
  // The yen sign stands in the JPY box, not the App's dollar sign.
  expect(fee.parentElement?.querySelector('.intake-money-symbol')?.textContent).toBe('¥');
  expect(plain.parentElement?.querySelector('.intake-money-symbol')?.textContent).toBe('$');
});

test('a finer fraction than the currency has is refused in words, and the typed text is what is sent', () => {
  const fields = [{ name: 'amount', label: 'Amount', type: 'money', required: true, minor: true, min: 0 }] as never;
  expect(() => commandInput(fields, { amount: '19.999' })).toThrow('Amount has more decimal places than the currency takes.');
  expect(() => commandInput([{ ...(fields as object[])[0], currency: 'JPY' }] as never, { amount: '15.5' })).toThrow(
    'Amount has more decimal places than the currency takes.',
  );
  expect(commandInput(fields, { amount: '19.99' })).toEqual({ amount: '19.99' });
  expect(commandInput(fields, { amount: '5' })).toEqual({ amount: '5.00' });
});
