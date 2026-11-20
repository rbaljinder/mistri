/**
 * A form given inputs by its link (`given`, a field report): read from the address, never drawn, sent with the rest
 * for the command to judge; a link that leaves a required one out is refused on the form's own line. And a done
 * screen that says `reference: false` and `home: false` leaves out the reference and the way back.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FormSurface, type FormPresentation } from './FormSurface.js';

const input = [
  { name: 'unit', label: 'Unit', type: 'text', required: true, maxLength: 16 },
  { name: 'name', label: 'Your name', type: 'text', required: true, maxLength: 120 },
] as FormPresentation['input'];
const form: FormPresentation = { id: 'request', label: 'Request a repair', input, given: ['unit'] };

afterEach(cleanup);

test('a given input is read from the address, never drawn, and sent for the command to judge', async () => {
  const submit = vi.fn(async () => ({ reference: 'R-7K2M', receipt: { id: 'r1', status: 'applied' as const } }));
  render(<FormSurface form={form} appName="Lintel" submit={submit} prefill="?unit=12B&name=Mallory" homeHref="/" />);
  expect(screen.queryByLabelText(/Unit/)).toBeNull();
  // Given is not prefillable: the address reaches only the inputs the form names.
  expect(screen.getByLabelText(/Your name/)).toHaveValue('');
  fireEvent.change(screen.getByLabelText(/Your name/), { target: { value: 'Ada' } });
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }));
  await screen.findByRole('heading', { name: /Received/ });
  expect(submit).toHaveBeenCalledWith(expect.any(String), { unit: '12B', name: 'Ada' }, expect.anything());
  // Never echoed back.
  expect(document.body.textContent).not.toContain('12B');
  // The defaults: the reference and the way back are both there.
  expect(screen.getByText('R-7K2M')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Back to Lintel' })).toHaveAttribute('href', '/');
});

test('a link without a required given input is refused on the form line, and nothing is sent', async () => {
  const submit = vi.fn(async () => ({ receipt: { id: 'r1', status: 'applied' as const } }));
  render(<FormSurface form={form} appName="Lintel" submit={submit} prefill="" />);
  fireEvent.change(screen.getByLabelText(/Your name/), { target: { value: 'Ada' } });
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Unit/);
  expect(submit).not.toHaveBeenCalled();
});

test('a done screen may leave out the reference and the way back to the App', async () => {
  const submit = vi.fn(async () => ({ reference: 'R-7K2M', receipt: { id: 'r1', status: 'applied' as const } }));
  render(
    <FormSurface
      form={{ ...form, done: { title: 'Thank you', reference: false, home: false } }}
      appName="Lintel"
      submit={submit}
      prefill="?unit=12B"
      homeHref="/"
    />,
  );
  fireEvent.change(screen.getByLabelText(/Your name/), { target: { value: 'Ada' } });
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }));
  await screen.findByRole('heading', { name: 'Thank you' });
  expect(screen.queryByText('R-7K2M')).toBeNull();
  expect(screen.queryByText(/Your reference|Keep this reference/)).toBeNull();
  expect(screen.queryByRole('link', { name: /Back to/ })).toBeNull();
});
