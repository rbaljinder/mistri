import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppCommandField } from '../../shared/command.js';
import { FormSurface, formArrives, type FormPresentation } from './FormSurface.js';
import { blankCommandValues } from './CommandFields.js';

/* Lintel's report, in small: a yes or a no as two buttons, and a day asked only on its no. An unanswered field is
   null, so `entry_ok = false` does not hold until someone answers (commandDraft.ts, three-valued as SQL is). */
const input: AppCommandField[] = [
  { name: 'title', label: 'What needs fixing?', type: 'text', required: true },
  { name: 'entry_ok', label: 'May we let ourselves in?', type: 'boolean', as: 'buttons', required: true },
  // A text box, not a date: the date's picker is a part of its own, and the condition is what is under test.
  { name: 'visit_on', label: 'Day that suits you', type: 'text', required: true, when: 'entry_ok = false' },
  { name: 'note', label: 'Anything else', type: 'text', when: 'entry_ok != true' },
  { name: 'agree', label: 'Text me updates', type: 'boolean' },
];
const form: FormPresentation = { id: 'report', label: 'Report an issue', input };

afterEach(cleanup);
/* The draft's logic and the intake controls are parts loaded on demand; the first fetch of them is slow under a cold
   transform, so it is had once, before any test's clock starts. */
beforeAll(() => formArrives(form), 30_000);

test('a yes or a no as buttons starts unanswered; a box starts at its no', () => {
  const blank = blankCommandValues(input);
  expect(Object.hasOwn(blank, 'entry_ok')).toBe(false);
  expect(blank.agree).toBe(false);
});

test('a question that waits on a no stays hidden until the no is pressed, and hides again on a yes', async () => {
  render(<FormSurface form={form} appName="Lintel" submit={vi.fn()} />);
  const group = await screen.findByRole('radiogroup', { name: /May we let ourselves in\?/ });
  expect(screen.queryByLabelText(/Day that suits you/)).toBeNull();
  expect(screen.queryByLabelText(/Anything else/)).toBeNull();
  // Neither button is pressed yet.
  for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
  fireEvent.click(screen.getByRole('radio', { name: 'No' }));
  await waitFor(() => expect(screen.getByLabelText(/Day that suits you/)).toBeInTheDocument());
  expect(screen.getByLabelText(/Anything else/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
  await waitFor(() => expect(screen.queryByLabelText(/Day that suits you/)).toBeNull());
  expect(group).toBeInTheDocument();
});

test('an unanswered required yes or no is asked by name on submit, never "check this box"', async () => {
  const submit = vi.fn();
  render(<FormSurface form={form} appName="Lintel" submit={submit} />);
  await screen.findByRole('radiogroup', { name: /May we let ourselves in\?/ });
  fireEvent.change(screen.getByLabelText(/What needs fixing\?/), { target: { value: 'Tap drips' } });
  fireEvent.click(screen.getByRole('button', { name: /Report an issue|Submit|Send/ }));
  await waitFor(() => expect(screen.getByText(/May we let ourselves in\? is required/)).toBeInTheDocument());
  expect(screen.queryByText(/Check this box/i)).toBeNull();
  expect(submit).not.toHaveBeenCalled();
});
