import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { AppCommandField } from '../../shared/command.js';
import { FormSurface, formArrives, type FormPresentation } from './FormSurface.js';

/* Several choices as icon cards (`field.choices(…, { as: 'cards' })`): a card a choice, one group to the keyboard as
   one choice's radios are — one Tab stop, the arrows between them, Space to turn one on or off — each saying
   aria-checked, and "None of these" standing alone. */
const accounts: AppCommandField = {
  name: 'accounts',
  label: 'Which accounts do you have?',
  type: 'choices',
  as: 'cards',
  required: true,
  min: 1,
  exclusive: ['none'],
  options: [
    { value: 'checking', label: 'Checking account', icon: 'landmark' },
    { value: 'savings', label: 'Savings account', icon: 'piggy-bank', help: 'Any bank or credit union' },
    { value: 'prepaid', label: 'Prepaid debit card' },
    { value: 'none', label: 'None of these' },
  ],
};
const form: FormPresentation = { id: 'bank', label: 'Bank', input: [accounts] };

afterEach(cleanup);
beforeAll(() => formArrives(form), 30_000);

const cards = () => screen.getAllByRole('checkbox');
const checked = () => cards().map((card) => card.getAttribute('aria-checked'));

test('each choice is a full-width card saying aria-checked, in one group named by the question', async () => {
  render(<FormSurface form={form} appName="Harbor" submit={vi.fn()} />);
  const group = await screen.findByRole('group', { name: /Which accounts do you have\?/ });
  expect(group).toHaveClass('choice-cards');
  expect(cards().map((card) => card.textContent)).toEqual([
    'Checking account',
    'Savings accountAny bank or credit union',
    'Prepaid debit card',
    'None of these',
  ]);
  expect(checked()).toEqual(['false', 'false', 'false', 'false']);
  // The square at the end is drawn, not read; there is no second checkbox under the card.
  for (const card of cards()) expect(card.querySelector('.choice-box')).toHaveAttribute('aria-hidden', 'true');
  expect(group.querySelector('input')).toBeNull();
});

test('one Tab stop for the group; the arrows move between cards, Space turns one on or off, a click too', async () => {
  const user = userEvent.setup();
  render(<FormSurface form={form} appName="Harbor" submit={vi.fn()} />);
  await screen.findByRole('group', { name: /Which accounts do you have\?/ });
  expect(cards().map((card) => card.tabIndex)).toEqual([0, -1, -1, -1]);
  await user.tab();
  expect(cards()[0]).toHaveFocus();
  await user.keyboard(' ');
  expect(checked()).toEqual(['true', 'false', 'false', 'false']);
  await user.keyboard('{ArrowDown}');
  expect(cards()[1]).toHaveFocus();
  await user.keyboard(' ');
  expect(checked()).toEqual(['true', 'true', 'false', 'false']);
  expect(cards()[1]).toHaveClass('is-on');
  // The Tab stop follows the card in hand, so Tab leaves the group and Shift+Tab comes back to it.
  expect(cards().map((card) => card.tabIndex)).toEqual([-1, 0, -1, -1]);
  await user.keyboard('{ArrowUp}{ArrowUp}');
  expect(cards()[3]).toHaveFocus();
  await user.keyboard('{Home}');
  expect(cards()[0]).toHaveFocus();
  await user.keyboard('{End} ');
  // None of these stands alone: it clears the rest, and another clears it.
  expect(checked()).toEqual(['false', 'false', 'false', 'true']);
  await user.click(cards()[2]);
  expect(checked()).toEqual(['false', 'false', 'true', 'false']);
  await user.keyboard(' ');
  expect(checked()).toEqual(['false', 'false', 'false', 'false']);
});

test('the choices are sent as the values on, and none asked is said beside the group', async () => {
  const user = userEvent.setup();
  const submit = vi.fn(async (..._args: unknown[]) => ({ receipt: { id: 'r1', status: 'applied' as const } }));
  render(<FormSurface form={form} appName="Harbor" submit={submit} />);
  await screen.findByRole('group', { name: /Which accounts do you have\?/ });
  await user.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(screen.getByRole('group', { name: /Which accounts/ })).toHaveAttribute('aria-invalid', 'true'));
  expect(submit).not.toHaveBeenCalled();
  await user.click(screen.getByRole('checkbox', { name: /Savings account/ }));
  await user.click(screen.getByRole('checkbox', { name: 'Checking account' }));
  await user.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0][1]).toEqual({ accounts: ['checking', 'savings'] });
});

test('cards whose words are short say so, for a wide page to set side by side; long ones, or two, do not', async () => {
  const material = (options: Array<{ value: string; label: string; help?: string }>): FormPresentation => ({
    id: 'roof',
    label: 'Roof',
    input: [{ name: 'material', label: 'Roof material', type: 'choice', as: 'cards', options }],
  });
  const fit = async (options: Array<{ value: string; label: string; help?: string }>) => {
    const { unmount } = render(<FormSurface form={material(options)} appName="Harbor" submit={vi.fn()} />);
    const said = (await screen.findByRole('radiogroup', { name: /Roof material/ })).getAttribute('data-fit');
    unmount();
    return said;
  };
  const three = [
    { value: 'tile', label: 'Tile' },
    { value: 'metal', label: 'Metal' },
    { value: 'slate', label: 'Slate' },
  ];
  expect(await fit(three)).toBe('short');
  // A label too long for a third of the column is set two to a row.
  expect(await fit([...three, { value: 'shingle', label: 'Heating and cooling' }])).toBe('brief');
  expect(await fit(three.map((option) => ({ ...option, help: 'Clay or concrete' })))).toBe('brief');
  expect(await fit([...three, { value: 'other', label: 'Something else, described below' }])).toBeNull();
  expect(await fit(three.map((option) => ({ ...option, help: 'A line long enough that half a column would wrap it twice' })))).toBeNull();
  expect(await fit(three.slice(0, 2))).toBeNull();
  // Several choices say it as one does.
  render(<FormSurface form={form} appName="Harbor" submit={vi.fn()} />);
  expect(await screen.findByRole('group', { name: /Which accounts do you have\?/ })).toHaveAttribute('data-fit', 'brief');
});
