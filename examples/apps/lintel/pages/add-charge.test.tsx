/**
 * Add a charge, asked a step at a time: a lease chosen from the current ones, then the lease's own Add charge command
 * over two steps. Continue only checks the step it is on; the command runs once, from the last, on the chosen lease.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, test } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { fixtures, renderPage } from '@mistriwork/mistri/ui/testing';
import page from './add-charge.page.tsx';

afterEach(cleanup);

const data = fixtures({
  lease: [
    { id: 4, unit_id: 2, 'unit_id.code': '2B', status: 'active' },
    { id: 7, unit_id: 5, 'unit_id.code': '3A', status: 'notice' },
  ],
});

/* The command as ledger.ts declares it, its choice of kind stood in for by text: the steps are what is under test. */
const addCharge = (check?: (names: readonly string[]) => Record<string, string>) =>
  ({
    label: 'Add charge',
    input: {
      kind: { type: 'text', label: 'What for', required: true },
      description: { type: 'text', maxLength: 120, required: true },
      amount: { type: 'money', minor: true, min: 1, max: 10_000, required: true },
      due_on: { type: 'date', label: 'Due', required: true },
    },
    ...(check ? { check: (_input: unknown, names: readonly string[]) => check(names) } : {}),
  }) as const;

/* What was typed is kept while the page is open, by reader: each drawing reads as someone new. */
let readers = 0;
const viewer = () => ({ signedIn: true, account: `accountant-${++readers}` });

test('asks for a lease first, and the steps follow once one is chosen', async () => {
  renderPage(page, { viewer: viewer(), data, commands: { addCharge: addCharge() } });
  expect(await screen.findByText(/^Choose a lease/)).toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).toBeNull();
  await userEvent.click(await screen.findByRole('radio', { name: '2B' }));
  expect(await screen.findByRole('heading', { name: 'What is the charge for?' })).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: 'Step 1 of 2: What' })).toBeInTheDocument();
});

test('Continue checks only the first step, and the last runs Add charge once on the chosen lease', async () => {
  const checked: (readonly string[])[] = [];
  const view = renderPage(page, {
    viewer: viewer(),
    data,
    address: { lease: '4' },
    commands: { addCharge: addCharge((names) => (checked.push(names), {})) },
  });
  await screen.findByRole('heading', { name: 'What is the charge for?' });
  await userEvent.type(screen.getByLabelText(/^What for/), 'repair');
  await userEvent.type(screen.getByLabelText(/^Description/), 'Replaced a cracked window');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

  const amount = await screen.findByRole('heading', { name: 'How much, and when is it due?' });
  await waitFor(() => expect(amount).toHaveFocus());
  expect(checked).toEqual([['kind', 'description']]);
  expect(view.commands).toEqual([]);

  await userEvent.type(await screen.findByLabelText(/^Amount/), '85');
  await userEvent.type(screen.getByLabelText(/^Due/), '2026-12-01');
  await userEvent.click(screen.getByRole('button', { name: 'Add charge' }));
  await waitFor(() => expect(view.commands).toHaveLength(1));
  expect(view.commands[0]).toMatchObject({
    command: 'addCharge',
    mode: 'run',
    input: { kind: 'repair', description: 'Replaced a cracked window', due_on: '2026-12-01' },
  });
  expect(String(view.commands[0].key.id)).toBe('4');
});

test('a description the server will not take holds the first step', async () => {
  renderPage(page, {
    viewer: viewer(),
    data,
    address: { lease: '4' },
    commands: { addCharge: addCharge((names) => (names.includes('description') ? { description: 'Say what was repaired.' } : {})) },
  });
  await screen.findByRole('heading', { name: 'What is the charge for?' });
  await userEvent.type(screen.getByLabelText(/^What for/), 'repair');
  await userEvent.type(screen.getByLabelText(/^Description/), 'Repair');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByText('Say what was repaired.')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'How much, and when is it due?' })).toBeNull();
});

test('a link to the second step with nothing answered opens the first', async () => {
  renderPage(page, { viewer: viewer(), data, address: { lease: '4', step: 'amount' }, commands: { addCharge: addCharge() } });
  expect(await screen.findByRole('heading', { name: 'What is the charge for?' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'How much, and when is it due?' })).toBeNull();
});
