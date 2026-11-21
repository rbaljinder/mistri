import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render as mount, screen, waitFor, within as inside } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import type { AppCommandField } from '../../shared/command.js';
import { FormSurface, formArrives, type FormPresentation } from './FormSurface.js';

/* A choice that fills other inputs (`default: { answer: 'treatment.usual_fee' }`), drawn as a form draws it: a pick puts
   the pick's values into the inputs beside it that nobody has edited, and an edit is never written over. */
const rows = [
  { value: 1, label: 'Cleaning', row: { usual_minutes: 30, usual_note: 'Scale and polish' } },
  { value: 2, label: 'Filling', row: { usual_minutes: 60, usual_note: 'Local anesthetic' } },
  { value: 3, label: 'Checkup', row: { usual_minutes: null, usual_note: null } },
];
const treatment = (extra: Partial<AppCommandField> = {}): AppCommandField =>
  ({
    name: 'treatment',
    label: 'Treatment',
    type: 'choice',
    as: 'radios',
    options: rows,
    source: { from: 'treatment_type', by: 'id', labelColumn: 'name', served: true },
    ...extra,
  }) as AppCommandField;
const minutes = { name: 'minutes', label: 'Minutes', type: 'number', default: { answer: 'treatment.usual_minutes' } } as AppCommandField;
const note = { name: 'note', label: 'Note', type: 'text', default: { answer: 'treatment.usual_note' } } as AppCommandField;

const render = (ui: ReactElement) =>
  mount(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
const form = (input: AppCommandField[]): FormPresentation => ({ id: 'visit', label: 'Book a visit', input });
const draw = (input: AppCommandField[]) => render(<FormSurface form={form(input)} appName="Dental" submit={vi.fn()} />);
const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const pick = async (label: string, within?: HTMLElement) =>
  fireEvent.click(await (within ? inside(within) : screen).findByRole('radio', { name: label }));

afterEach(cleanup);
beforeAll(async () => {
  render(<FormSurface form={form([treatment(), minutes, note])} appName="Dental" submit={vi.fn()} />);
  await formArrives(form([treatment(), minutes, note]));
  await screen.findByRole('radio', { name: 'Cleaning' });
  cleanup();
}, 60_000);

test('a pick fills the empty inputs beside it, and a row with nothing in a column fills nothing', async () => {
  draw([treatment(), minutes, note]);
  await pick('Cleaning');
  await waitFor(() => expect(field(/Minutes/).value).toBe('30'));
  expect(field(/Note/).value).toBe('Scale and polish');
  await pick('Checkup');
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(field(/Minutes/).value).toBe('30');
});

test('a pick again overwrites an input that was only filled', async () => {
  draw([treatment(), minutes, note]);
  await pick('Cleaning');
  await waitFor(() => expect(field(/Minutes/).value).toBe('30'));
  await pick('Filling');
  await waitFor(() => expect(field(/Minutes/).value).toBe('60'));
  expect(field(/Note/).value).toBe('Local anesthetic');
});

test('a pick again never overwrites an input the person edited, and fills the rest', async () => {
  draw([treatment(), minutes, note]);
  await pick('Cleaning');
  await waitFor(() => expect(field(/Minutes/).value).toBe('30'));
  fireEvent.change(field(/Minutes/), { target: { value: '45' } });
  await pick('Filling');
  await waitFor(() => expect(field(/Note/).value).toBe('Local anesthetic'));
  expect(field(/Minutes/).value).toBe('45');
});

test('a written choice fills from its options’ values, drawn as radios or as cards', async () => {
  const written = (as: string) =>
    ({
      name: 'plan',
      label: 'Plan',
      type: 'choice',
      as,
      options: [
        { value: 'basic', label: 'Basic', values: { seats: 5, tier: 'Starter' } },
        { value: 'team', label: 'Team', values: { seats: 25, tier: 'Growth' } },
      ],
    }) as AppCommandField;
  const seats = { name: 'seats', label: 'Seats', type: 'number', default: { answer: 'plan.seats' } } as AppCommandField;
  const tier = { name: 'tier', label: 'Tier', type: 'text', default: { answer: 'plan.tier' } } as AppCommandField;
  for (const as of ['radios', 'cards']) {
    draw([written(as), seats, tier]);
    await pick('Team');
    await waitFor(() => expect(field(/Seats/).value).toBe('25'));
    expect(field(/Tier/).value).toBe('Growth');
    cleanup();
  }
});

test('a form opened with a pick fills only the inputs still empty', async () => {
  const opened = form([treatment(), minutes, note]);
  render(<FormSurface form={opened} appName="Dental" submit={vi.fn()} initial={{ treatment: 1, note: 'Already written' }} />);
  await waitFor(() => expect(field(/Minutes/).value).toBe('30'));
  expect(field(/Note/).value).toBe('Already written');
});

test('a line’s pick fills that line only', async () => {
  const line = {
    name: 'visits',
    label: 'Visits',
    type: 'group',
    repeat: { min: 2, max: 4 },
    fields: [treatment(), minutes],
  } as unknown as AppCommandField;
  draw([line]);
  const rowsDrawn = await screen.findAllByRole('group', { name: /Visits/ });
  const second = rowsDrawn.find((each) => /2/.test(each.getAttribute('aria-label') ?? ''))!;
  await pick('Filling', second);
  await waitFor(() => expect((screen.getAllByLabelText(/Minutes/) as HTMLInputElement[])[1].value).toBe('60'));
  expect((screen.getAllByLabelText(/Minutes/) as HTMLInputElement[])[0].value).toBe('');
});
