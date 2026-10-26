/** Groups as sections, repeating rows, choices and dates — drawn from the one declaration, and a record's form opening prefilled. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AppCommandAction, AppCommandField } from '../../shared/app.js';
import { establishSessionIdentity } from '../../../../kit/src/client/sessionIdentity.js';

const { api, state, tables } = vi.hoisted(() => ({
  api: vi.fn(),
  state: { activeConnection: 'loans' },
  /* A lines field's rows, read cell by cell as their columns' kinds. */
  tables: {
    loan_item: {
      id: 'loan_item',
      name: 'loan_item',
      columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
        { name: 'vehicle_id', type: 'INTEGER', nullable: false, references: { table: 'vehicle', column: 'id' } },
        { name: 'quantity', type: 'INTEGER', nullable: false },
      ],
    },
  } as Record<string, object>,
}));
vi.mock('../../../../kit/src/client/core.js', () => ({
  api,
  state,
  findTable: (id: string) => tables[id] ?? { id: 'loan_application' },
  columnLabel: () => null,
  humanName: (name: string) => name,
  prefersPages: () => true,
  toast: vi.fn(),
  viewportSize: () => ({ width: 1024, height: 768 }),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
}));
vi.mock('../../../../kit/src/client/components/Value.js', () => ({ Value: () => null }));
/* An App's own input, standing in a field: says which component, for which field, with which value. */
vi.mock('../../../../kit/src/client/components/inputRenderers.js', () => ({
  InputSlot: ({ component, id, value, onChange }: { component: string; id: string; value: unknown; onChange: (next: unknown) => void }) => (
    <button type="button" id={id} data-component={component} onClick={() => onChange(`${String(value ?? '')}!`)}>
      {component}: {String(value ?? '')}
    </button>
  ),
}));

const { FormSurface } = await import('./FormSurface.js');
const { ActionBar } = await import('./Actions.js');
const { CommandFields, blankCommandValues, commandInput, commandPathLabel, commandProblems, loadLines, prefilledCommandValues } =
  await import('./CommandFields.js');

const input: AppCommandField[] = [
  {
    name: 'applicant',
    label: 'Applicant',
    type: 'group',
    help: 'As on the licence.',
    fields: [
      { name: 'name', label: 'Full name', type: 'text', required: true },
      { name: 'born', label: 'Born', type: 'date', min: '1920-01-01', max: '2008-12-31' },
    ],
  },
  {
    name: 'term',
    label: 'Term',
    type: 'choice',
    required: true,
    options: [
      { value: 36, label: '36 months' },
      { value: 48, label: '48 months' },
      { value: 60, label: '60 months' },
    ],
  },
  {
    name: 'trade_ins',
    label: 'Trade-ins',
    type: 'group',
    repeat: { min: 1, max: 2 },
    fields: [
      { name: 'stock', label: 'Stock', type: 'text', required: true },
      { name: 'miles', label: 'Miles', type: 'number', integer: true, min: 0 },
    ],
  },
];

beforeEach(() => {
  api.mockReset();
  state.activeConnection = 'loans';
});
afterEach(() => {
  cleanup();
});

test('groups, radios, bounded date fields and repeating rows honor their declared limits', async () => {
  const submit = vi.fn().mockResolvedValue({ reference: 'REF-1', receipt: { id: 'r1', status: 'applied' } });
  render(<FormSurface form={{ id: 'apply', label: 'Apply', input }} appName="Ignition" submit={submit} />);
  const applicant = screen.getByRole('group', { name: 'Applicant' });
  expect(within(applicant).getByText('As on the licence.')).toBeInTheDocument();
  const born = within(applicant).getByLabelText('Born');
  expect(born).toHaveAttribute('type', 'text');
  expect(within(applicant).getByRole('button', { name: 'Choose date for Born' })).toBeEnabled();
  fireEvent.change(born, { target: { value: '1919-12-31' } });
  expect(born).toBeInvalid();
  fireEvent.change(born, { target: { value: '2009-01-01' } });
  expect(born).toBeInvalid();
  fireEvent.change(born, { target: { value: '2008-12-31' } });
  expect(born).toBeValid();
  fireEvent.change(born, { target: { value: '' } });
  const term = screen.getByRole('radiogroup', { name: 'Term (required)' });
  expect(within(term).getAllByRole('radio')).toHaveLength(3);
  // One row to start, the minimum: it cannot be removed, and a second may be added, and no third.
  const trade = screen.getByRole('group', { name: 'Trade-ins' });
  expect(within(trade).getAllByRole('group')).toHaveLength(1);
  expect(within(trade).getByRole('button', { name: 'Remove row 1 of Trade-ins' })).toBeDisabled();
  fireEvent.click(within(trade).getByRole('button', { name: 'Add row to Trade-ins' }));
  expect(within(trade).getAllByRole('group')).toHaveLength(2);
  expect(within(trade).getByRole('button', { name: 'Add row to Trade-ins' })).toBeDisabled();
  // Nothing filled in: each problem is said beside its own field, in its own row.
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(screen.getByText('Full name is required.')).toBeVisible());
  expect(screen.getByText('Term is required.')).toBeVisible();
  const rows = within(trade).getAllByRole('group');
  expect(within(rows[1]).getByText('Stock is required.')).toBeVisible();
  expect(submit).not.toHaveBeenCalled();
  fireEvent.change(within(applicant).getByLabelText('Full name (required)'), { target: { value: '  Mara Alder ' } });
  fireEvent.change(born, { target: { value: '1990-04-02' } });
  fireEvent.click(within(term).getByRole('radio', { name: '48 months' }));
  fireEvent.change(within(rows[0]).getByLabelText('Stock (required)'), { target: { value: 'S-1' } });
  fireEvent.change(within(rows[0]).getByLabelText('Miles'), { target: { value: '12000' } });
  fireEvent.click(within(trade).getByRole('button', { name: 'Remove row 2 of Trade-ins' }));
  expect(within(trade).getAllByRole('group')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  // Parsed as the server parses it: trimmed, a number typed as text a number, a choice its option's value.
  expect(submit.mock.calls[0][1]).toEqual({
    applicant: { name: 'Mara Alder', born: '1990-04-02' },
    term: 48,
    trade_ins: [{ stock: 'S-1', miles: 12000 }],
  });
});

test("questions defined in rows are drawn as the form's own controls, checked against their rows, and sent as one object", async () => {
  const submit = vi.fn().mockResolvedValue({ reference: 'REF-2', receipt: { id: 'r2', status: 'applied' } });
  const questions = {
    answers: [
      { key: 'os', label: 'Operating system', type: 'choice' as const, options: ['macOS', 'Windows'], required: true },
      { key: 'memory', label: 'Memory (GB)', type: 'number' as const, options: [], required: false },
      { key: 'extras', label: 'Extras', type: 'choices' as const, options: ['Dock', 'Bag'], required: false },
    ],
  };
  render(
    <FormSurface
      form={{
        id: 'order',
        label: 'Order',
        input: [{ name: 'answers', label: 'Answers', type: 'defined', from: 'item_variable', required: true }],
      }}
      appName="Desk"
      questions={questions}
      submit={submit}
    />,
  );
  // The questions are a part loaded on demand (CommandAnswers.tsx), drawn once it arrives.
  const answers = await screen.findByRole('group', { name: 'Answers' });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(within(answers).getByText('Operating system is required.')).toBeVisible());
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(within(answers).getByRole('radio', { name: 'Windows' }));
  fireEvent.change(within(answers).getByLabelText('Memory (GB)'), { target: { value: '16' } });
  fireEvent.click(within(answers).getByRole('checkbox', { name: 'Bag' }));
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  // Each answer read as its question's kind, kept by its key.
  expect(submit.mock.calls[0][1]).toEqual({ answers: { os: 'Windows', memory: 16, extras: ['Bag'] } });
});

test("a server refusal naming a nested path is said beside that field, once, in a person's words", async () => {
  const submit = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error('The command input is invalid.'), { status: 400, code: 'invalid_input', field: 'trade_ins[0].stock' }),
    );
  render(<FormSurface form={{ id: 'apply', label: 'Apply', input }} appName="Ignition" submit={submit} />);
  fireEvent.change(screen.getByLabelText('Full name (required)'), { target: { value: 'Mara' } });
  fireEvent.click(screen.getByRole('radio', { name: '36 months' }));
  fireEvent.change(screen.getByLabelText('Stock (required)'), { target: { value: 'S-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  const row = within(screen.getByRole('group', { name: 'Trade-ins' })).getAllByRole('group')[0];
  await waitFor(() => expect(within(row).getByText('This answer was not accepted. Check it and try again.')).toBeVisible());
  // Beside its field and nowhere else: the field is on screen, so the form's own line stays empty.
  expect(screen.getAllByText(/answer was not accepted/)).toHaveLength(1);
  expect(screen.queryByText(/command input/)).toBeNull();
  // The field holding the problem says so, and names it; the others do not.
  const stock = within(row).getByLabelText('Stock (required)');
  expect(stock).toHaveAttribute('aria-invalid', 'true');
  expect(stock).toHaveAccessibleDescription('This answer was not accepted. Check it and try again.');
  expect(screen.getByLabelText('Full name (required)')).not.toHaveAttribute('aria-invalid');
});

test('`as` decides radios or a listbox whatever the count: select for a few, radios for many', () => {
  const options = (words: string[]) => words.map((value) => ({ value, label: value }));
  const few: AppCommandField = {
    name: 'window',
    label: 'Time of day',
    type: 'choice',
    as: 'select',
    options: options(['am', 'pm', 'eve']),
  };
  const many: AppCommandField = {
    name: 'colour',
    label: 'Colour',
    type: 'choice',
    as: 'radios',
    options: options(['red', 'green', 'blue', 'black', 'white', 'grey']),
  };
  const { unmount } = render(<FormSurface form={{ id: 'a', label: 'A', input: [few] }} appName="Ignition" submit={vi.fn()} />);
  expect(screen.queryByRole('radiogroup')).toBeNull();
  expect(screen.getByRole('button', { name: 'Time of day' })).toBeInTheDocument();
  unmount();
  render(<FormSurface form={{ id: 'b', label: 'B', input: [many] }} appName="Ignition" submit={vi.fn()} />);
  expect(screen.getByRole('radiogroup', { name: 'Colour' })).toBeInTheDocument();
  expect(screen.getAllByRole('radio')).toHaveLength(6);
});

test('more options than a few are the listbox; the reading helpers name paths and lay starting values over the blank form', () => {
  const colours: AppCommandField = {
    name: 'colour',
    label: 'Colour',
    type: 'choice',
    options: ['red', 'green', 'blue', 'black', 'white'].map((value) => ({ value, label: value })),
  };
  render(<FormSurface form={{ id: 'paint', label: 'Paint', input: [colours] }} appName="Ignition" submit={vi.fn()} />);
  expect(screen.queryByRole('radiogroup')).toBeNull();
  // The tool's listbox: its trigger is a button named for the field.
  expect(screen.getByRole('button', { name: 'Colour' })).toBeInTheDocument();
  expect(commandPathLabel(input, 'trade_ins[1].miles')).toBe('Trade-ins, row 2, Miles');
  expect(commandPathLabel(input, 'applicant.born')).toBe('Applicant, Born');
  expect(commandPathLabel(input, 'nothing')).toBeUndefined();
  expect(commandProblems(input, { trade_ins: [{ miles: '1.5' }] })).toMatchObject({
    'applicant.name': 'Full name is required.',
    term: 'Term is required.',
    'trade_ins[0].stock': 'Stock is required.',
    'trade_ins[0].miles': 'Miles must be a safe whole number.',
  });
  expect(() => commandInput(input, { applicant: { name: 'A', born: '2010-01-01' }, term: 36, trade_ins: [{ stock: 'S' }] })).toThrow(
    'Applicant: Born must be on or before 2008-12-31.',
  );
  expect(prefilledCommandValues(input, { applicant: { name: 'Ada' }, trade_ins: [{ stock: 'S-9' }, { stock: 'S-10', miles: 3 }] })).toEqual(
    { applicant: { name: 'Ada' }, trade_ins: [{ stock: 'S-9' }, { stock: 'S-10', miles: 3 }] },
  );
});

test("a rule the declaration states is said in words: a format, a pattern's own message, a length, and the sibling it must be below", () => {
  const rules: AppCommandField[] = [
    { name: 'email', label: 'Email', type: 'text', required: true, format: 'email', maxLength: 254 },
    {
      name: 'code',
      label: 'Dealer code',
      type: 'text',
      required: true,
      case: 'upper',
      pattern: '[A-Z0-9-]+',
      message: 'Letters, digits and hyphens.',
    },
    { name: 'nick', label: 'Nickname', type: 'text', minLength: 3 },
    {
      name: 'terms',
      label: 'Terms',
      type: 'group',
      fields: [
        { name: 'amount', label: 'Amount', type: 'number', required: true, step: 0.01 },
        { name: 'down', label: 'Down payment', type: 'number', required: true, below: 'amount' },
      ],
    },
  ];
  // The case is applied before the pattern: "ab-1" is "AB-1", which fits; "ab_1" does not, and says the pattern's own words.
  expect(commandProblems(rules, { email: 'nope', code: 'ab_1', nick: 'ab', terms: { amount: 100, down: 100 } })).toEqual({
    email: 'Email must be an email address.',
    code: 'Letters, digits and hyphens.',
    nick: 'Nickname must be at least 3 characters.',
    'terms.down': 'Down payment must be less than Amount.',
  });
  expect(commandInput(rules, { email: 'a@example.test', code: 'ab-1', terms: { amount: 100.004, down: 20 } })).toEqual({
    email: 'a@example.test',
    code: 'AB-1',
    terms: { amount: 100, down: 20 },
  });
});

test("a record action's form opens with the starting values prepare served, and submits them with its revision", async () => {
  establishSessionIdentity({ signedIn: true, accountId: 'manager', appId: 'loans' });
  const action: AppCommandAction = {
    id: 'reviseApplication',
    label: 'Revise application',
    command: {
      id: 'revise',
      version: 1,
      target: 'loan_application',
      input: [
        {
          name: 'terms',
          label: 'Financing terms',
          type: 'group',
          fields: [
            { name: 'amount', label: 'Amount', type: 'number', required: true, min: 1 },
            {
              name: 'term',
              label: 'Term',
              type: 'choice',
              required: true,
              options: [
                { value: 36, label: '36 months' },
                { value: 48, label: '48 months' },
              ],
            },
          ],
        },
        { name: 'due', label: 'Review due', type: 'date', required: true },
      ],
    },
  };
  api.mockImplementation(async (path: string, body: { checks: Array<{ command: string; commandVersion: number; keys: unknown[] }> }) =>
    path === '/api/commands/availability'
      ? {
          checks: body.checks.map((check) => ({
            command: check.command,
            commandVersion: check.commandVersion,
            available: check.keys.map(() => true),
          })),
        }
      : path.endsWith('/prepare')
        ? { expectedVersion: 7, initial: { terms: { amount: 21000, term: 48 }, due: '2026-10-01' } }
        : {
            status: 'applied',
            command: 'revise',
            commandVersion: 1,
            resource: 'loan_application',
            key: { id: 1 },
            receiptId: 'r1',
            replayed: false,
            result: {},
          },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ActionBar
        tableId="loan_application"
        actions={[action]}
        recordKey={{ id: 1 }}
        label="Application 1"
        matches={async () => true}
        onDone={vi.fn()}
        canUpdate={false}
        grantedCommands={['revise']}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Revise application' }));
  const dialog = await screen.findByRole('dialog', { name: 'Revise application' });
  await waitFor(() => expect(within(dialog).getByLabelText('Amount (required)')).toHaveValue(21000));
  expect(within(dialog).getByRole('radio', { name: '48 months' })).toBeChecked();
  expect(within(dialog).getByLabelText('Review due (required)')).toHaveValue('10/01/2026');
  await user.clear(within(dialog).getByLabelText('Amount (required)'));
  await user.type(within(dialog).getByLabelText('Amount (required)'), '22000');
  await user.click(within(dialog).getByRole('button', { name: 'Revise application' }));
  await waitFor(() => expect(api.mock.calls.find((call) => call[0].endsWith('/execute'))).toBeDefined());
  const sent = api.mock.calls.find((call) => call[0].endsWith('/execute'))![1];
  expect(sent).toMatchObject({ expectedVersion: 7, key: { id: 1 }, input: { terms: { amount: 22000, term: 48 }, due: '2026-10-01' } });
  client.clear();
});

test('required dropdown and reference controls receive validation focus and describe their errors', async () => {
  const choice: AppCommandField = {
    name: 'term',
    label: 'Term',
    type: 'choice',
    required: true,
    options: [12, 24, 36, 48, 60, 72].map((value) => ({ value, label: `${value} months` })),
  };
  const submit = vi.fn();
  render(<FormSurface form={{ id: 'term', label: 'Choose term', input: [choice] }} appName="Desk" submit={submit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  // Named by the field's caption, which says it is required, as a textbox's <label> does.
  const dropdown = screen.getByRole('button', { name: 'Term (required)' });
  expect(dropdown).toHaveFocus();
  expect(dropdown).toHaveAttribute('aria-invalid', 'true');
  expect(dropdown).toHaveAccessibleDescription('Term is required.');
  cleanup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FormSurface
        form={{
          id: 'assign',
          label: 'Assign reviewer',
          input: [
            {
              name: 'reviewer',
              label: 'Reviewer',
              type: 'reference',
              from: 'reviewer',
              by: 'id',
              labelColumn: 'name',
              required: true,
            },
          ],
        }}
        appName="Desk"
        connection="loans"
        submit={submit}
      />
    </QueryClientProvider>,
  );
  // A reference's picker is a part loaded on demand (CommandReference.tsx), drawn once it arrives.
  const reference = await screen.findByRole('combobox', { name: 'Reviewer (required)' });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(reference).toHaveFocus());
  expect(reference).toHaveAttribute('aria-invalid', 'true');
  expect(reference).toHaveAccessibleDescription('Reviewer is required.');
  expect(submit).not.toHaveBeenCalled();
  cleanup();
  client.clear();
});

test("a reference the form opened with says the record's name, not its key", async () => {
  api.mockImplementation(async (_path: string, body: { q?: string }) => ({
    rows: body.q?.includes('"0b6f"') ? [{ id: '0b6f', name: 'Harbour Freight' }] : [],
  }));
  window.history.replaceState(null, '', '/desk/form/assign?reviewer=0b6f');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FormSurface
        form={{
          id: 'assign',
          label: 'Assign reviewer',
          prefillable: ['reviewer'],
          input: [{ name: 'reviewer', label: 'Reviewer', type: 'reference', from: 'reviewer', by: 'id', labelColumn: 'name' }],
        }}
        appName="Desk"
        connection="loans"
        submit={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Reviewer' })).toHaveValue('Harbour Freight'));
  window.history.replaceState(null, '', '/');
  client.clear();
});

test('a reference whose value arrives after the picker is drawn says that record by name', async () => {
  api.mockImplementation(async (_path: string, body: { q?: string }) => ({
    rows: body.q?.includes('"0b6f"') ? [{ id: '0b6f', name: 'Harbour Freight' }] : [],
  }));
  const { CommandReferenceField } = await import('./CommandReference.js');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const field = { name: 'to', label: 'Chair', type: 'reference', from: 'reviewer', by: 'id', labelColumn: 'name' } as const;
  // The form draws its blank values first, and the command's starting ones once prepare answers.
  const draw = (value?: string) => (
    <QueryClientProvider client={client}>
      {/* The field's caption names the box, as Field.tsx draws it. */}
      <label htmlFor="to">Chair</label>
      <CommandReferenceField
        field={field as never}
        id="to"
        connection="loans"
        identityEpoch={1}
        value={value}
        disabled={false}
        onChange={() => {}}
        isCurrent={() => true}
      />
    </QueryClientProvider>
  );
  const { rerender } = render(draw());
  expect(screen.getByRole('combobox', { name: 'Chair' })).toHaveValue('');
  rerender(draw('0b6f'));
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Chair' })).toHaveValue('Harbour Freight'));
  client.clear();
});

test("an App's own input stands in a group's field by its path, and in every row of a repeating group", () => {
  const changes: unknown[] = [];
  let values = blankCommandValues(input);
  const draw = () => (
    <CommandFields
      fields={input}
      values={values}
      idPrefix="t"
      identityEpoch={1}
      isCurrent={() => true}
      inputs={{ 'applicant.name': { id: 'name-input' }, 'trade_ins.stock': { id: 'stock-input' } }}
      onChange={(next) => {
        values = next;
        changes.push(next);
      }}
    />
  );
  const view = render(draw());
  const applicant = screen.getByRole('group', { name: 'Applicant' });
  expect(within(applicant).getByText('name-input:', { exact: false })).toHaveAttribute('data-component', 'name-input');
  // The group's other field is the platform's own control.
  expect(within(applicant).getByLabelText('Born')).toBeInTheDocument();
  fireEvent.click(screen.getByText('stock-input:', { exact: false }));
  expect((values.trade_ins as Array<Record<string, unknown>>)[0].stock).toBe('!');
  fireEvent.click(screen.getByRole('button', { name: 'Add row to Trade-ins' }));
  view.rerender(draw());
  expect(screen.getAllByText('stock-input:', { exact: false })).toHaveLength(2);
  expect(changes.length).toBeGreaterThan(0);
});

test("a field's own input component draws it wherever it is asked, a public form's page too", () => {
  const fields: AppCommandField[] = [{ name: 'colour', label: 'Colour', type: 'text', input: 'swatch' } as AppCommandField];
  const draw = (visitor?: { app: string }) => (
    <CommandFields
      fields={fields}
      values={blankCommandValues(fields)}
      idPrefix="c"
      identityEpoch={1}
      isCurrent={() => true}
      {...(visitor ? { visitor } : {})}
      onChange={() => {}}
    />
  );
  const view = render(draw());
  expect(screen.getByText('swatch:', { exact: false })).toHaveAttribute('data-component', 'swatch');
  view.unmount();
  render(draw({ app: 'loans' }));
  expect(screen.getByText('swatch:', { exact: false })).toHaveAttribute('data-component', 'swatch');
});

test('a lines field starts with one blank line, sends only what a line asks, typed, and names a bad cell by its row and column', async () => {
  // A cell's kind and its words arrive with the grid (CommandLines.tsx), which a form asking lines has drawn.
  await loadLines();
  const items: AppCommandField = {
    name: 'items',
    label: 'Items',
    type: 'lines',
    from: 'loan_item',
    show: ['vehicle_id', 'quantity'],
    min: 1,
    max: 5,
  };
  const blank = blankCommandValues([items]).items as Array<{ id: number; values: Record<string, string> }>;
  expect(blank).toHaveLength(1);
  const line = (values: Record<string, string>, id = -1) => ({ id, values });
  // A copied price the grid shows is not sent: the handler reads the record itself.
  const values = { items: [line({ vehicle_id: '7', quantity: '2', price: '19.99' }), line({ vehicle_id: '8', quantity: '' }, -2)] };
  expect(commandProblems([items], values)).toEqual({ 'items[1].quantity': 'Quantity is required.' });
  expect(commandPathLabel([items], 'items[1].quantity')).toBe('Items, row 2, Quantity');
  expect(commandInput([items], { items: [line({ vehicle_id: '7', quantity: '2', price: '19.99' })] })).toEqual({
    items: [{ vehicle_id: 7, quantity: 2 }],
  });
  expect(() => commandInput([items], { items: [line({ vehicle_id: '7', quantity: 'two' })] })).toThrow(/quantity/i);
});
