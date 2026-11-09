/* A stepped form's reference answers, read back. A field report: a payment intake's pickers named "Everyday checking"
   and "Rainy day reserve", and its review said 1 and 2. The review now names each record by its key, read again the
   way its picker reads (the same resource, door and filter), with the second line the App's display gives it; the key
   is still what is sent. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FormPresentation, FormReceipt } from './FormSurface.js';

const { api, state, bank } = vi.hoisted(() => ({
  api: vi.fn(),
  state: { activeConnection: 'bank', schema: null as unknown },
  bank: {
    rows: [
      { id: 1, name: 'Everyday checking', last4: '4417' },
      { id: 2, name: 'Rainy day reserve', last4: '0932' },
      { id: 3, name: 'Everyday checking', last4: '2208' },
    ],
    readable: new Set([1, 2, 3]),
    /** Held until released: a name read by its key that has not answered yet. */
    hold: null as Promise<void> | null,
    fail: false,
    reads: [] as string[],
    /** Whether the App's display gives the account's name a second line. */
    subtitle: true,
  },
}));
vi.mock('../../../../kit/src/client/core.js', async (original) => ({
  ...(await original<object>()),
  api,
  // A picker's reads say so (core.js pickerApi); here they are the same reads.
  pickerApi: api,
  state,
  columnDisplay: (table: string, column: string) =>
    bank.subtitle && table === 'account' && column === 'name' ? { subtitle: 'last4' } : null,
  toast: vi.fn(),
}));
vi.mock('../../../../kit/src/client/components/Value.js', () => ({ Value: () => null }));

const { FormSurface, formArrives } = await import('./FormSurface.js');

/* The bank's /api/run: a read by key (`id = 3`) answers that row if this reader may read it; a search answers the
   readable rows its words match, by name. */
api.mockImplementation(async (path: string, body: { q: string }) => {
  if (path !== '/api/run') throw new Error(`unexpected ${path}`);
  bank.reads.push(body.q);
  const key = /\bid = (\d+)/.exec(body.q);
  const shows = /show ([\w, ]+?)(?: sort |$)/.exec(body.q)![1].split(', ');
  const project = (row: Record<string, unknown>) => Object.fromEntries(shows.map((column) => [column, row[column]]));
  if (key) {
    if (bank.hold) await bank.hold;
    if (bank.fail) throw new Error('The connection dropped.');
    const row = bank.rows.find((each) => each.id === Number(key[1]) && bank.readable.has(each.id));
    return { rows: row ? [project(row)] : [] };
  }
  const words = (/name contains "([^"]*)"/.exec(body.q)?.[1] ?? '').toLowerCase();
  return { rows: bank.rows.filter((row) => bank.readable.has(row.id) && row.name.toLowerCase().includes(words)).map(project) };
});

const account = (name: string, label: string) =>
  ({ name, label, type: 'reference', from: 'account', by: 'id', labelColumn: 'name', required: true }) as const;
const pay: FormPresentation = {
  id: 'sendMoney',
  label: 'Send money',
  style: 'intake',
  submitLabel: 'Send',
  input: [
    account('from_account', 'From'),
    account('to_account', 'To'),
    { name: 'memo', label: 'Memo', type: 'text', required: true, maxLength: 60 },
  ],
  steps: [
    { id: 'accounts', label: 'Accounts', fields: ['from_account', 'to_account'] },
    { id: 'details', label: 'Details', fields: ['memo'], next: 'Review payment' },
  ],
};
const receipt: FormReceipt = { reference: 'PAY-1', receipt: { id: 'r1', status: 'applied' } };

beforeEach(() => {
  state.schema = {
    tables: Object.freeze([
      {
        id: 'account',
        name: 'account',
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
          { name: 'last4', type: 'TEXT', nullable: false, primaryKey: false },
        ],
      },
    ]),
  };
  bank.readable = new Set([1, 2, 3]);
  bank.hold = null;
  bank.fail = false;
  bank.reads = [];
  bank.subtitle = true;
});
afterEach(cleanup);

/* A fresh reader per test: what one test's pickers read is not another's (referenceNames.ts keys by it). */
let epoch = 100;
async function draw(form: FormPresentation = pay, props: { review?: boolean } = {}) {
  await formArrives(form);
  const submit = vi.fn(async (_submission: string, _input: unknown) => receipt);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FormSurface form={form} appName="Teller" submit={submit} connection="bank" identityEpoch={++epoch} {...props} />
    </QueryClientProvider>,
  );
  return { submit, user: userEvent.setup() };
}

type User = ReturnType<typeof userEvent.setup>;
async function pick(user: User, field: string, detail: string) {
  await user.click(await screen.findByRole('combobox', { name: `${field} (required)` }));
  const options = await screen.findAllByRole('option');
  await user.click(options.find((option) => option.textContent?.includes(detail))!);
}
const step = async (user: User, button: string, then: RegExp) => {
  await user.click(screen.getByRole('button', { name: button }));
  await waitFor(() => expect(screen.getByRole('progressbar', { name: then })).toBeInTheDocument());
};
/** The review's answer for a label, as its `<dd>` says it. */
const answer = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement;

async function toReview(user: User, from = '2208', to = '0932') {
  await pick(user, 'From', from);
  await pick(user, 'To', to);
  await step(user, 'Continue', /Step 2 of 3/);
  await user.type(screen.getByLabelText('Memo (required)'), 'Rent');
  await step(user, 'Review payment', /Step 3 of 3: Review/);
}

test('the review says the accounts its pickers named, never their keys', async () => {
  bank.subtitle = false;
  const { submit, user } = await draw();
  await toReview(user, 'Everyday checking', 'Rainy day reserve');
  await waitFor(() => expect(answer('From')).toHaveTextContent(/^Everyday checking$/), { timeout: 2_000 });
  expect(answer('To')).toHaveTextContent(/^Rainy day reserve$/);
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(submit).toHaveBeenCalled());
  expect(submit.mock.calls[0][1]).toEqual({ from_account: 1, to_account: 2, memo: 'Rent' });
});

test('the review names each account by its record, told apart by its second line, and sends the keys', async () => {
  const { submit, user } = await draw();
  // Two accounts share a name: the picker tells them apart by the line the display gives them.
  await user.click(await screen.findByRole('combobox', { name: 'From (required)' }));
  const options = await screen.findAllByRole('option');
  expect(options.map((option) => option.textContent)).toEqual(['Everyday checking4417', 'Rainy day reserve0932', 'Everyday checking2208']);
  await user.keyboard('{Escape}');
  await toReview(user);
  await waitFor(() => expect(answer('From')).toHaveTextContent(/^Everyday checking · 2208$/));
  expect(answer('To')).toHaveTextContent(/^Rainy day reserve · 0932$/);
  // The name was read again by its key, under the picker's own door and filter.
  expect(bank.reads).toContain('account id = 3 show id, name, last4');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(submit).toHaveBeenCalled());
  expect(submit.mock.calls[0][1]).toEqual({ from_account: 3, to_account: 2, memo: 'Rent' });
});

test('until its name is read, the review says so and never shows the key', async () => {
  const { user } = await draw();
  let release!: () => void;
  bank.hold = new Promise<void>((resolve) => (release = resolve));
  await toReview(user);
  expect(answer('From')).toHaveTextContent('Loading…');
  expect(answer('From')).not.toHaveTextContent(/\b3\b/);
  release();
  await waitFor(() => expect(answer('From')).toHaveTextContent('Everyday checking · 2208'));
});

test('a name that cannot be read is said as that, with a way to read it again', async () => {
  const { user } = await draw();
  await toReview(user);
  await waitFor(() => expect(answer('To')).toHaveTextContent('Rainy day reserve · 0932'));
  // Back and on again: the review reads its names afresh, and this time the read fails.
  bank.fail = true;
  await step(user, 'Back', /Step 2 of 3/);
  await step(user, 'Review payment', /Step 3 of 3: Review/);
  await waitFor(() => expect(answer('To')).toHaveTextContent('Its name could not be loaded.'));
  expect(answer('To')).not.toHaveTextContent(/Rainy|\b2\b/);
  bank.fail = false;
  await user.click(within(answer('To')).getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(answer('To')).toHaveTextContent('Rainy day reserve · 0932'));
});

test('a record the reader can no longer read is not named on the review', async () => {
  const { submit, user } = await draw();
  await pick(user, 'From', '2208');
  await pick(user, 'To', '0932');
  // Between the pick and the review, this reader lost the account.
  bank.readable.delete(3);
  await step(user, 'Continue', /Step 2 of 3/);
  await user.type(screen.getByLabelText('Memo (required)'), 'Rent');
  await step(user, 'Review payment', /Step 3 of 3: Review/);
  await waitFor(() => expect(answer('From')).toHaveTextContent('No longer available. Change this answer.'));
  expect(answer('From')).not.toHaveTextContent('Everyday checking');
  expect(answer('To')).toHaveTextContent('Rainy day reserve · 0932');
  // The server judges the key it is sent; the page never stands in for it.
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(submit).toHaveBeenCalled());
  expect(submit.mock.calls[0][1]).toMatchObject({ from_account: 3 });
});

test('going back and choosing again names the new choice, never the old one', async () => {
  const { user } = await draw();
  await toReview(user, '4417');
  await waitFor(() => expect(answer('From')).toHaveTextContent('Everyday checking · 4417'));
  await step(user, 'Back', /Step 2 of 3/);
  await step(user, 'Back', /Step 1 of 3/);
  // The picker's box says the name it read, not the key it holds.
  expect(screen.getByRole('combobox', { name: 'From (required)' })).toHaveValue('Everyday checking');
  await user.clear(screen.getByRole('combobox', { name: 'From (required)' }));
  await pick(user, 'From', '0932');
  await step(user, 'Continue', /Step 2 of 3/);
  await step(user, 'Review payment', /Step 3 of 3: Review/);
  await waitFor(() => expect(answer('From')).toHaveTextContent(/^Rainy day reserve · 0932$/));
  expect(screen.queryByText(/4417/)).toBeNull();
  // Change on the review opens the step in place; a new choice there is named when it is read back.
  await user.click(screen.getByRole('button', { name: 'Change Accounts' }));
  await user.clear(screen.getByRole('combobox', { name: 'To (required)' }));
  await pick(user, 'To', '2208');
  expect(screen.getByRole('combobox', { name: 'To (required)' })).toHaveValue('Everyday checking');
});

test("a stepper's read-only review and its steps so far say the names too", async () => {
  const stepper = { ...pay, style: undefined };
  const { user } = await draw(stepper, { review: true });
  await pick(user, 'From', '2208');
  await pick(user, 'To', '0932');
  await step(user, 'Continue', /Step 2 of 3/);
  // The step done says what it said, by name; a key names nothing.
  const steps = screen.getByRole('navigation', { name: /steps/i });
  expect(within(steps).getByText('Everyday checking, Rainy day reserve')).toBeInTheDocument();
  await user.type(screen.getByLabelText('Memo (required)'), 'Rent');
  await step(user, 'Review payment', /Step 3 of 3: Review/);
  await waitFor(() => expect(answer('From')).toHaveTextContent(/^Everyday checking · 2208$/));
  expect(answer('To')).toHaveTextContent(/^Rainy day reserve · 0932$/);
});

test('a public form reads names as its visitor, by key and label alone', async () => {
  const fetched = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const q = JSON.parse(String((init as RequestInit).body)).q as string;
    const row = /\bid = 2\b/.test(q) || !/\bid = /.test(q) ? [{ id: 2, name: 'Rainy day reserve' }] : [];
    return new Response(JSON.stringify({ rows: row }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const { readReferenceName } = await import('./CommandReference.js');
    expect(await readReferenceName(account('to_account', 'To'), 2, { visitor: { app: 'teller' } })).toEqual({ label: 'Rainy day reserve' });
    const body = JSON.parse(String((fetched.mock.calls[0][1] as RequestInit).body));
    // No display line for a visitor: the public read is checked for the key and the label alone.
    expect(body.q).toBe('account id = 2 show id, name');
    expect(await readReferenceName(account('to_account', 'To'), 9, { visitor: { app: 'teller' } })).toBeNull();
  } finally {
    fetched.mockRestore();
  }
});
