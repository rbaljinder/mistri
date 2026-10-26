import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AppCommandField } from '../../shared/command.js';
import { FormSurface, formArrives, type FormPresentation } from './FormSurface.js';
import { ReviewValue } from './ReviewValue.js';
import { reviewLines, sayInput } from './reviewValues.js';

afterEach(cleanup);

const flags: Extract<AppCommandField, { type: 'group' }> = {
  name: 'flags',
  label: 'About the visit',
  type: 'group',
  fields: [
    { name: 'urgent', label: 'Urgent', type: 'boolean' },
    { name: 'pets', label: 'Pets at home', type: 'boolean' },
    { name: 'note', label: 'Note', type: 'text' },
  ],
};

test('an amount and a masked text are read back as their fields draw them, not as the raw value handed on', () => {
  const bill: AppCommandField = { name: 'bill', label: 'Monthly bill', type: 'money', step: 10 };
  const fee: AppCommandField = { name: 'fee', label: 'Fee', type: 'money', step: 0.01 };
  const phone: AppCommandField = { name: 'phone', label: 'Phone', type: 'text', mask: '(000) 000-0000' };
  expect(sayInput(bill, 450)).toBe('$450');
  expect(sayInput(bill, '1500')).toBe('$1,500');
  expect(sayInput(fee, 12.5)).toBe('$12.50');
  expect(sayInput(fee, 450)).toBe('$450');
  expect(sayInput(phone, '3035550142')).toBe('(303) 555-0142');
  expect(sayInput(phone, '')).toBe('—');
});

test("a group's answers are each said by its label, an empty one left out; a repeating group is a line a row", () => {
  expect(reviewLines(flags, { urgent: true, pets: false, note: '' })).toEqual(['Urgent: Yes', 'Pets at home: No']);
  expect(sayInput(flags, { urgent: true, pets: false })).toBe('Urgent: Yes; Pets at home: No');
  expect(sayInput(flags, {})).toBe('—');
  const rows = { ...flags, repeat: { min: 0, max: 3 } };
  expect(reviewLines(rows, [{ urgent: true, note: 'Gate code 41' }, { pets: true }])).toEqual([
    'Urgent: Yes, Note: Gate code 41',
    'Pets at home: Yes',
  ]);
  const banks: AppCommandField = {
    name: 'banks',
    label: 'Accounts',
    type: 'choices',
    options: [
      { value: 'checking', label: 'Checking' },
      { value: 'savings', label: 'Savings' },
    ],
  };
  expect(sayInput(banks, ['checking', 'savings'])).toBe('Checking, Savings');
});

test('a group of several answers is a short list on the review; one answer stays words', () => {
  const { container, unmount } = render(<ReviewValue field={flags} value={{ urgent: true, pets: false }} />);
  expect([...container.querySelectorAll('ul.review-lines > li')].map((li) => li.textContent)).toEqual(['Urgent: Yes', 'Pets at home: No']);
  unmount();
  const one = render(<ReviewValue field={flags} value={{ urgent: true }} />);
  expect(one.container.querySelector('ul')).toBeNull();
  expect(one.container.textContent).toBe('Urgent: Yes');
});

beforeAll(() => formArrives({ input: [], steps: [{ id: 'a', label: 'A', fields: [] }] }), 30_000);

test("a stepper's review lists a group's yes-or-no answers by label, never as a run of yeses and noes", async () => {
  const form: FormPresentation = {
    id: 'visit',
    label: 'Book a visit',
    input: [{ name: 'title', label: 'What needs fixing?', type: 'text', required: true }, flags],
    steps: [
      { id: 'what', label: 'What', fields: ['title'] },
      { id: 'about', label: 'About', fields: ['flags'] },
    ],
  };
  await formArrives(form);
  render(<FormSurface form={form} appName="Lintel" submit={vi.fn()} review />);
  fireEvent.change(await screen.findByLabelText(/What needs fixing\?/), { target: { value: 'Tap drips' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByLabelText('Urgent')).toBeInTheDocument());
  fireEvent.click(screen.getByLabelText('Urgent'));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  const term = await screen.findByText('About the visit', { selector: 'dt' });
  const items = within(term.parentElement!)
    .getAllByRole('listitem')
    .map((li) => li.textContent);
  expect(items).toEqual(['Urgent: Yes', 'Pets at home: No']);
  expect(screen.queryByText('Yes, No')).toBeNull();
});
