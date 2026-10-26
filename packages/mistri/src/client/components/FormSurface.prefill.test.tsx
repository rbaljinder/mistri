/**
 * A public form that starts filled from its address: only the inputs it
 * names `prefillable`, only as text, shown and the reader's to change; a
 * form that names none starts blank whatever its address says.
 */
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FormSurface, startingValues, type FormPresentation } from './FormSurface.js';

const input = [
  { name: 'stock_ref', label: 'Stock number', type: 'text', required: true, maxLength: 16 },
  { name: 'name', label: 'Your name', type: 'text', required: true, maxLength: 120 },
  { name: 'message', label: 'Your question', type: 'textarea', required: true, maxLength: 2000 },
  { name: 'agree', label: 'Agree', type: 'boolean' },
] as FormPresentation['input'];

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

test('only the inputs the form names start filled, from the address, as text', () => {
  const values = startingValues(input, ['stock_ref', 'message'], '?stock_ref=FC-1049&message=A%20test%20drive&name=Mallory&agree=true');
  expect(values.stock_ref).toBe('FC-1049');
  expect(values.message).toBe('A test drive');
  // Not named: the address does not reach it.
  expect(values.name).toBeUndefined();
  expect(values.agree).toBe(false);
});

test('a form that names none starts blank whatever its address says', () => {
  expect(startingValues(input, [], '?stock_ref=FC-1049')).toEqual(startingValues(input, [], ''));
  expect(startingValues(input, undefined, '?stock_ref=FC-1049')).toEqual(startingValues(input, [], ''));
});

test('the form draws those values in its inputs, where the reader may change them', () => {
  window.history.replaceState(null, '', '/forecourt/form/inquire?stock_ref=FC-1049&name=Mallory');
  render(
    <FormSurface
      form={{ id: 'inquire', label: 'Inquire', input, prefillable: ['stock_ref'] }}
      appName="Forecourt"
      submit={async () => ({ receipt: { id: 'r1', status: 'applied' } })}
    />,
  );
  expect(screen.getByLabelText(/Stock number/)).toHaveValue('FC-1049');
  expect(screen.getByLabelText(/Your name/)).toHaveValue('');
});
