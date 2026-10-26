/**
 * The New form, drawn and driven.
 *
 * Against an API that answers like the server would: rows for a picker's
 * search, a key for an insert. The schema is the fixture — a lead with a
 * required name, a defaulted status, a vocabulary for its source, an owner
 * one reference away — because the form is the schema's, and what it asks
 * for is the whole test.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { ColumnMeta, TableMeta } from '../../../../engine/src/shared/schema.js';
import { writeValues } from '../resourceRequests.js';

const calls: Array<{ path: string; body: unknown }> = [];
const answers: Record<string, unknown> = {};

vi.mock('../core.js', () => ({
  state: { activeConnection: 'demo' },
  api: async (path: string, body: unknown) => {
    calls.push({ path, body });
    const answer = answers[path];
    if (answer instanceof Error) throw answer;
    return answer ?? {};
  },
  viewportBox: () => ({ top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 }),
  viewportSize: () => ({ width: 1000, height: 800 }),
  labelPath: (table: TableMeta) => table.columns.find((column) => column.name !== 'id' && column.type === 'TEXT')?.name,
  recordLabel: () => undefined,
}));

const { NewRecordForm, NewRecordDrawer, NewRecordDialog, autoKey, isRequired } = await import('./NewRecord.js');
const { api } = await import('../core.js');

const col = (name: string, type: string, extra: Partial<ColumnMeta> & { allowed?: string[] } = {}): ColumnMeta =>
  ({ name, type, nullable: true, primaryKey: false, ...extra }) as ColumnMeta;

const owner: TableMeta = {
  id: 'owner',
  name: 'owner',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('name', 'TEXT')],
};

const lead: TableMeta = {
  id: 'lead',
  name: 'lead',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false, identity: 'by-default' }),
    col('name', 'TEXT', { nullable: false }),
    col('company', 'TEXT', { nullable: false }),
    col('status', 'TEXT', { nullable: false, default: "'new'" }),
    col('source', 'TEXT', { allowed: ['web', 'event', 'referral'] }),
    col('owner_id', 'INTEGER', { references: { table: 'owner', column: 'id' } }),
    col('due_on', 'DATE'),
  ],
};

/** The values the last insert carried. */
function sent(): Record<string, string> {
  const last = calls[calls.length - 1];
  return (last.body as { values: Record<string, string> }).values;
}

function draw(tree: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, tree));
}

const props = () => ({
  table: lead,
  app: true,
  label: (c: ColumnMeta) => (c.references ? 'Owner' : c.name.charAt(0).toUpperCase() + c.name.slice(1)),
  target: (id: string) => (id === 'owner' ? owner : undefined),
  insert: (values: Record<string, unknown>) => api('/api/insert', { table: lead.id, values: writeValues(values) }),
  onAdded: vi.fn(),
  onCancel: vi.fn(),
});

test('an ordinary integer key stays visible and is validated before submission', async () => {
  const user = userEvent.setup();
  const insert = vi.fn().mockResolvedValue({ key: { id: 41 } });
  const table: TableMeta = { ...lead, columns: [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('name', 'TEXT')] };
  draw(<NewRecordForm {...props()} table={table} insert={insert} />);
  await user.click(screen.getByRole('button', { name: /^Add$/ }));
  expect(insert).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Id')).toHaveAccessibleDescription('Fill in Id.');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Id' })).toHaveFocus();
  await user.type(screen.getByRole('textbox', { name: 'Id' }), '41');
  await user.click(screen.getByRole('button', { name: /^Add$/ }));
  expect(insert).toHaveBeenCalledWith({ id: '41' });
});

test('a default-only form submits an explicit empty values object', async () => {
  const user = userEvent.setup();
  const insert = vi.fn().mockResolvedValue({ key: { id: 1 } });
  const table: TableMeta = { ...lead, columns: [col('id', 'BIGINT', { primaryKey: true, nullable: false, identity: 'always' })] };
  draw(<NewRecordForm {...props()} table={table} insert={insert} />);
  expect(screen.queryByRole('textbox')).toBeNull();
  await user.click(screen.getByRole('button', { name: /^Add$/ }));
  expect(insert).toHaveBeenCalledWith({});
});

test.each([true, false])('New form omits forbidden controls and defaults in app mode %s', async (app) => {
  const user = userEvent.setup();
  const insert = vi.fn().mockResolvedValue({ key: { id: 1 } });
  const table: TableMeta = {
    ...lead,
    columns: [
      col('name', 'TEXT', { nullable: false, writable: true }),
      col('company', 'TEXT', { nullable: false, writable: false }),
      col('status', 'TEXT', { nullable: false, default: "'new'", writable: false }),
      col('source', 'TEXT', { writable: true }),
      col('owner_id', 'INTEGER', { writable: false, references: { table: 'owner', column: 'id' } }),
    ],
  };
  draw(
    <NewRecordForm
      {...props()}
      app={app}
      table={table}
      insert={insert}
      form={{
        show: ['name', 'company', 'status', 'owner_id', 'unreadable'],
        defaults: { name: 'Ada', company: 'Forbidden', status: 'approved', owner_id: 7, unreadable: 'secret', source: 'event' },
      }}
    />,
  );
  expect(screen.getAllByRole('textbox')).toHaveLength(1);
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByText('Company')).toBeNull();
  expect(screen.queryByText('Status')).toBeNull();
  await user.click(screen.getByRole('button', { name: app ? 'Add' : 'Add row' }));
  expect(insert).toHaveBeenCalledWith({ name: 'Ada', source: 'event' });
  expect(calls.some((call) => call.path === '/api/run')).toBe(false);
});

test.each(['read-only', 'unreadable'])('an open New form drops stale entries after a field becomes %s', async (policy) => {
  const user = userEvent.setup();
  const insert = vi.fn().mockResolvedValue({ key: { id: 1 } });
  const p = { ...props(), insert, form: { defaults: { name: 'Ada', company: 'Preset' } } };
  const view = render(<NewRecordForm {...p} table={{ ...lead, columns: lead.columns.slice(0, 3) }} />);
  await user.type(screen.getByRole('textbox', { name: 'Company' }), ' edited');
  const columns =
    policy === 'unreadable'
      ? lead.columns.slice(0, 2)
      : lead.columns.slice(0, 3).map((c) => (c.name === 'company' ? { ...c, writable: false } : c));
  view.rerender(<NewRecordForm {...p} table={{ ...lead, columns }} />);
  expect(screen.queryByRole('textbox', { name: 'Company' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Add' }));
  expect(insert).toHaveBeenCalledWith({ name: 'Ada' });
});

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
  answers['/api/run'] = {
    rows: [
      { id: 7, name: 'Arjun Mehta' },
      { id: 9, name: 'Arjun Rao' },
    ],
  };
  answers['/api/insert'] = { key: { id: 42 }, row: { id: 42, name: 'Acme lead' } };
});

afterEach(() => cleanup());

describe('what the form asks for', () => {
  test('the catalog decides: required marked, the assigned key not asked, one control per shape', () => {
    draw(<NewRecordForm {...props()} />);
    // No id: an app's reader is not asked for a key the database assigns.
    expect(screen.queryByLabelText(/^id/i)).toBeNull();
    const fields = document.querySelectorAll('.insert-field');
    expect(fields).toHaveLength(6);
    // Name and Company are required and simply asked; status has a default, and says in a word it may be left empty.
    expect(within(fields[0] as HTMLElement).queryByText('(optional)')).toBeNull();
    expect(within(fields[0] as HTMLElement).queryByText('*')).toBeNull();
    expect(within(fields[2] as HTMLElement).getByText('(optional)')).toBeInTheDocument();
    // The word stands a space apart from the label in the markup itself: no stylesheet of the forms room is loaded here.
    expect(fields[2].querySelector('.form-field-label-row')?.textContent).toBe('Status (optional)');
    // A vocabulary is a listbox, a reference a picker, a date a date box.
    expect(screen.getByRole('button', { name: 'Source' })).toHaveAttribute('aria-haspopup', 'listbox');
    // With nothing chosen the listbox asks, in the placeholder's quiet ink, rather than showing a dash.
    const unchosen = screen.getByRole('button', { name: 'Source' }).querySelector('.dd-value');
    expect(unchosen).toHaveTextContent('Choose source');
    expect(unchosen).toHaveClass('is-empty');
    expect(screen.getByRole('combobox', { name: 'Owner' })).toBeInTheDocument();
    expect(screen.getByLabelText('Due_on')).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Choose date for Due_on' })).toBeInTheDocument();
    // The first required box has focus.
    expect(screen.getByLabelText('Name')).toHaveFocus();
  });

  test('autoKey and isRequired read the catalog', () => {
    expect(autoKey(lead)).toBe('id');
    expect(isRequired(lead.columns[1], 'id')).toBe(true);
    expect(isRequired(lead.columns[3], 'id')).toBe(false);
    expect(isRequired(lead.columns[0], 'id')).toBe(false);
  });

  test('a curated form asks only what the app shows, and defaults ride along unseen', async () => {
    const user = userEvent.setup();
    const p = props();
    draw(<NewRecordForm {...p} form={{ show: ['name', 'company'], defaults: { source: 'event' } }} />);
    expect(document.querySelectorAll('.insert-field')).toHaveLength(2);
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.type(screen.getByLabelText('Company'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(p.onAdded).toHaveBeenCalled());
    expect(calls.at(-1)).toEqual({
      path: '/api/insert',
      body: { table: 'lead', values: { name: 'Ada', company: 'Acme', source: 'event' } },
    });
  });

  test('richer forms render authored groups and preserve ungrouped fields after them', () => {
    draw(
      <NewRecordForm
        {...props()}
        form={{ show: ['name', 'company', 'status', 'source'], groups: [{ label: 'Lead details', fields: ['company', 'name'] }] }}
      />,
    );
    expect(screen.getByRole('group', { name: 'Lead details' })).toBeInTheDocument();
    expect([...document.querySelectorAll('.insert-field label')].map((node) => node.textContent?.replace(/\*/g, '').trim())).toEqual([
      'Company',
      'Name',
      'Status',
      'Source',
    ]);
  });

  test('conditional fields toggle on a safe scalar condition without changing the form contract', async () => {
    const user = userEvent.setup();
    draw(
      <NewRecordForm
        {...props()}
        form={{
          show: ['name', 'status', 'source'],
          defaults: { status: 'approved' },
          when: {
            source: 'status = approved',
          },
        }}
      />,
    );
    expect(screen.getByLabelText('Source')).toBeInTheDocument();
    const status = screen.getByLabelText('Status');
    await user.clear(status);
    expect(screen.queryByLabelText('Source')).toBeNull();
    await user.type(status, 'approved');
    expect(screen.getByLabelText('Source')).toBeInTheDocument();
  });

  test("steps carve the New form into pages: Continue waits for the step's required fields, and Add sends every step once", async () => {
    const user = userEvent.setup();
    const p = props();
    draw(
      <NewRecordForm
        {...p}
        form={{
          steps: [
            { id: 'who', label: 'Who', fields: ['name'] },
            { id: 'where', label: 'Where from', fields: ['company', 'source'] },
          ],
        }}
      />,
    );
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument();
    expect(screen.queryByLabelText('Company')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Fill in Name.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Step 2 of 2')).toBeInTheDocument();
    expect(screen.queryByText(/Fill in/)).toBeNull();
    await user.type(screen.getByLabelText('Company'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Ada');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByLabelText('Company')).toHaveValue('Acme');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(p.onAdded).toHaveBeenCalled());
    expect(sent()).toEqual({ name: 'Ada', company: 'Acme' });
  });

  test('date steps keep invalid drafts on their step and focus the real required input', async () => {
    const user = userEvent.setup(),
      p = props();
    draw(
      <NewRecordForm
        {...p}
        table={{ ...lead, columns: [col('due_on', 'DATE', { nullable: false }), col('name', 'TEXT')] }}
        form={{
          steps: [
            { id: 'when', label: 'When', fields: ['due_on'] },
            { id: 'who', label: 'Who', fields: ['name'] },
          ],
        }}
      />,
    );
    const date = screen.getByLabelText('Due_on');
    expect(date).toHaveFocus();
    expect(date).toHaveAttribute('aria-required', 'true');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Fill in Due_on.')).toBeVisible();
    expect(date).toHaveFocus();
    await user.type(date, '2026-02-30');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Enter a valid date in YYYY-MM-DD format.')).toBeVisible();
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument();
    await user.clear(date);
    await user.type(date, '2026-02-28');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Step 2 of 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Due_on')).toHaveValue('02/28/2026');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(p.onAdded).toHaveBeenCalled());
    expect(sent()).toEqual({ due_on: '2026-02-28' });
  });

  test.each([undefined, null])('untouched date default %s retains omission versus explicit null', async (defaultValue) => {
    const p = props();
    draw(
      <NewRecordForm
        {...p}
        table={{ ...lead, columns: [col('due_on', 'DATE', { hasDefault: true })] }}
        form={defaultValue === undefined ? undefined : { defaults: { due_on: null } }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(p.onAdded).toHaveBeenCalled());
    expect(sent()).toEqual(defaultValue === undefined ? {} : { due_on: null });
  });

  test('Quick Add keeps one row whatever the steps', () => {
    draw(
      <NewRecordForm
        {...props()}
        compact
        form={{
          steps: [
            { id: 'a', label: 'A', fields: ['name'] },
            { id: 'b', label: 'B', fields: ['company'] },
          ],
        }}
      />,
    );
    expect(screen.queryByText(/Step 1 of/)).toBeNull();
    expect(document.querySelectorAll('.insert-field')).toHaveLength(2);
  });
});

describe('required means required', () => {
  test.each([
    { shape: 'text', column: col('choice', 'TEXT', { nullable: false }), role: 'textbox' },
    // Five words: past four, a vocabulary is the listbox (four or fewer that must be answered are radios).
    {
      shape: 'dropdown',
      column: col('choice', 'TEXT', { nullable: false, allowed: ['web', 'event', 'referral', 'partner', 'outbound'] }),
      role: 'button',
    },
    {
      shape: 'reference',
      column: col('choice', 'INTEGER', { nullable: false, references: { table: 'owner', column: 'id' } }),
      role: 'combobox',
    },
  ])('$shape validation preserves descriptions owned by the control', async ({ column, role }) => {
    const user = userEvent.setup();
    draw(
      <>
        <span id="field-help">Choose carefully.</span>
        <span id="extra-help">More help.</span>
        <NewRecordForm {...props()} table={{ ...lead, columns: [column] }} label={() => 'Choice'} />
      </>,
    );
    const control = screen.getByRole(role, { name: 'Choice' });
    control.setAttribute('aria-describedby', 'field-help');
    control.setAttribute('aria-invalid', 'false');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(control).toHaveAccessibleDescription('Choose carefully. Fill in Choice.');
    expect(control).toHaveAttribute('aria-invalid', 'true');
    // Another owner can change its help while the validation message is present.
    control.setAttribute('aria-describedby', control.getAttribute('aria-describedby')!.replace('field-help', 'extra-help'));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(control).toHaveAccessibleDescription('More help. Fill in Choice.');
    expect(control.getAttribute('aria-describedby')!.split(/\s+/)).toHaveLength(2);
    if (role === 'button') {
      await user.click(control);
      expect(control).toHaveAccessibleDescription('More help. Fill in Choice.');
      await user.click(screen.getByRole('option', { name: /^Web$/ }));
    } else if (role === 'combobox') {
      await user.type(control, 'Arjun');
      expect(control).toHaveAccessibleDescription('More help. Fill in Choice.');
      await user.click(await screen.findByText('Arjun Mehta'));
    } else {
      await user.type(control, 'A');
    }
    expect(control).toHaveAccessibleDescription('More help.');
    expect(control).toHaveAttribute('aria-describedby', 'extra-help');
    expect(control).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByText('Fill in Choice.')).toBeNull();
  });

  test.each([
    { host: 'drawer', Frame: NewRecordDrawer, app: true, compact: false },
    { host: 'dialog', Frame: NewRecordDialog, app: false, compact: false },
    { host: 'quick-add', Frame: NewRecordForm, app: true, compact: true },
  ])('$host gives one authored field message after keyboard submission and clears it on correction', async ({ Frame, app, compact }) => {
    const user = userEvent.setup();
    const insert = vi.fn().mockResolvedValue({ key: { id: 1 } });
    draw(
      <Frame
        {...props()}
        app={app}
        compact={compact}
        insert={insert}
        table={{ ...lead, columns: [col('name', 'TEXT', { nullable: false })] }}
        label={() => 'Customer name'}
      />,
    );
    const input = screen.getByRole('textbox');
    expect(screen.queryByText('Fill in Customer name.')).toBeNull();
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
    expect(input).not.toHaveAttribute('aria-describedby');
    await user.type(input, 'Draft');
    await user.clear(input);
    expect(screen.queryByText('Fill in Customer name.')).toBeNull();
    const focusedDescriptions: Array<string | null> = [];
    input.addEventListener('focus', () => {
      focusedDescriptions.push(document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent ?? null);
    });
    screen.getByRole('button', { name: app ? 'Add' : 'Add row' }).focus();
    await user.keyboard('{Enter}');
    expect(input).toHaveFocus();
    expect(focusedDescriptions).toEqual(['Fill in Customer name.']);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Fill in Customer name.');
    expect(screen.getAllByText('Fill in Customer name.')).toHaveLength(1);
    expect(screen.getByText('Fill in Customer name.')).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByText(/^Required$/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(insert).not.toHaveBeenCalled();
    await user.type(input, 'A');
    expect(screen.queryByText('Fill in Customer name.')).toBeNull();
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByRole('alert')).toBeNull();
    await user.clear(input);
    expect(input).toHaveAccessibleDescription('Fill in Customer name.');
    await user.keyboard('{Enter}');
    expect(insert).not.toHaveBeenCalled();
    await user.type(input, 'Ada{Enter}');
    expect(insert).toHaveBeenCalledExactlyOnceWith({ name: 'Ada' });
  });

  test.each([
    {
      name: 'vocabulary',
      column: col('choice', 'TEXT', { nullable: false, allowed: ['web', 'event', 'referral', 'partner', 'outbound'] }),
      choice: 'web',
      keys: '{ArrowDown}{Enter}',
    },
  ])('$name associates its message with the select trigger through popup renders and correction', async ({ column, choice, keys }) => {
    const user = userEvent.setup();
    const insert = vi.fn().mockResolvedValue({ key: { id: 1 } });
    draw(<NewRecordForm {...props()} table={{ ...lead, columns: [column] }} label={() => 'Contact preference'} insert={insert} />);
    const trigger = screen.getByRole('button', { name: 'Contact preference' });
    expect(trigger).not.toHaveAttribute('aria-invalid', 'true');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-invalid', 'true');
    expect(trigger).toHaveAccessibleDescription('Fill in Contact preference.');
    expect(screen.queryByRole('alert')).toBeNull();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('listbox')).toBeVisible();
    expect(trigger).toHaveAccessibleDescription('Fill in Contact preference.');
    await user.keyboard(keys);
    expect(trigger).not.toHaveAttribute('aria-invalid', 'true');
    expect(trigger).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText('Fill in Contact preference.')).toBeNull();
    expect(insert).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(insert).toHaveBeenCalledExactlyOnceWith({ choice });
  });

  test('reference search keeps its error until a record is selected and clearing restores it', async () => {
    const user = userEvent.setup();
    const insert = vi.fn().mockResolvedValue({ key: { id: 1 } });
    draw(
      <NewRecordForm
        {...props()}
        table={{ ...lead, columns: [col('owner_id', 'INTEGER', { nullable: false, references: { table: 'owner', column: 'id' } })] }}
        label={() => 'Account manager'}
        insert={insert}
      />,
    );
    const picker = screen.getByRole('combobox', { name: 'Account manager' });
    expect(picker).not.toHaveAttribute('aria-invalid', 'true');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(picker).toHaveFocus();
    expect(picker).toHaveAttribute('aria-invalid', 'true');
    expect(picker).toHaveAccessibleDescription('Fill in Account manager.');
    await user.type(picker, 'Arjun');
    await screen.findByRole('option', { name: 'Arjun Mehta 7' });
    expect(picker).toHaveAccessibleDescription('Fill in Account manager.');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(insert).not.toHaveBeenCalled();
    await user.click(picker);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(picker).toHaveValue('Arjun Mehta');
    expect(picker).not.toHaveAttribute('aria-invalid', 'true');
    expect(picker).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText('Fill in Account manager.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(picker).toHaveAccessibleDescription('Fill in Account manager.');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(insert).not.toHaveBeenCalled();
    await user.type(picker, 'Arjun');
    await user.click(await screen.findByText('Arjun Rao'));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(insert).toHaveBeenCalledExactlyOnceWith({ owner_id: '9' });
  });

  test.each([undefined, null])('hidden required fields explain the configuration problem with default %s', async (hiddenDefault) => {
    const user = userEvent.setup();
    const insert = vi.fn();
    const view = draw(<NewRecordForm {...props()} insert={insert} form={{ show: ['name'], defaults: { company: hiddenDefault } }} />);
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByLabelText('Name')).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Required fields hidden by this form need valid defaults or visible controls: Company.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('Name');
    await user.type(screen.getByLabelText('Name'), 'Ada');
    expect(screen.queryByText('Fill in Name.')).toBeNull();
    expect(screen.getByRole('alert')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveFocus();
    expect(insert).not.toHaveBeenCalled();
    // Updated curation removes the configuration alert and exposes its field error.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    view.rerender(
      <QueryClientProvider client={client}>
        <NewRecordForm {...props()} insert={insert} form={{ show: ['name', 'company'], defaults: { company: hiddenDefault } }} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Company')).toHaveAccessibleDescription('Fill in Company.');
  });

  test('an explicit null on a non-null defaulted field is invalid until clearing restores database omission', async () => {
    const user = userEvent.setup();
    const insert = vi.fn().mockResolvedValue({ key: { id: 1 } });
    draw(
      <NewRecordForm
        {...props()}
        insert={insert}
        table={{ ...lead, columns: [col('status', 'TEXT', { nullable: false, hasDefault: true })] }}
        form={{ defaults: { status: null } }}
      />,
    );
    const input = screen.getByLabelText('Status');
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(input).toHaveAccessibleDescription('Fill in Status.');
    expect(insert).not.toHaveBeenCalled();
    await user.type(input, 'new');
    await user.clear(input);
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('Fill in Status.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(insert).toHaveBeenCalledExactlyOnceWith({});
  });

  test('simultaneous forms keep field descriptions and correction isolated', async () => {
    const user = userEvent.setup();
    const table = { ...lead, columns: [col('name', 'TEXT', { nullable: false })] };
    draw(
      <>
        <NewRecordForm {...props()} table={table} />
        <NewRecordForm {...props()} table={table} compact />
      </>,
    );
    const forms = screen.getAllByRole('textbox', { name: 'Name' }).map((input) => within(input.closest('form')!));
    for (const form of forms) await user.click(form.getByRole('button', { name: 'Add' }));
    const inputs = forms.map((form) => form.getByRole('textbox', { name: 'Name' }));
    expect(inputs[0].getAttribute('aria-describedby')).not.toBe(inputs[1].getAttribute('aria-describedby'));
    for (const input of inputs) expect(input).toHaveAccessibleDescription('Fill in Name.');
    await user.type(inputs[0], 'Ada');
    expect(inputs[0]).not.toHaveAttribute('aria-describedby');
    expect(inputs[1]).toHaveAccessibleDescription('Fill in Name.');
    expect(calls.some((call) => call.path === '/api/insert')).toBe(false);
  });

  test('clearing a DSL preset restores the required check and focuses the first field in authored order', async () => {
    const user = userEvent.setup();
    const p = props();
    draw(<NewRecordForm {...p} form={{ show: ['company', 'name'], defaults: { company: 'Acme', name: 'Ada' } }} />);
    expect([...document.querySelectorAll('.insert-field label')].map((node) => node.textContent)).toEqual(['Company', 'Name']);
    await user.clear(screen.getByLabelText('Company'));
    await user.clear(screen.getByLabelText('Name'));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByLabelText('Company')).toHaveAccessibleDescription('Fill in Company.');
    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription('Fill in Name.');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Company')).toHaveFocus();
    expect(calls.filter((c) => c.path === '/api/insert')).toHaveLength(0);
    await user.type(screen.getByLabelText('Company'), 'Revised company');
    expect(screen.queryByText('Fill in Company.')).toBeNull();
    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription('Fill in Name.');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByLabelText('Name')).toHaveFocus();
    expect(calls.filter((c) => c.path === '/api/insert')).toHaveLength(0);
    await user.type(screen.getByLabelText('Name'), 'Revised name');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(p.onAdded).toHaveBeenCalled());
    expect(sent()).toEqual({ company: 'Revised company', name: 'Revised name' });
  });

  test('submitting empty names every missing field, marks each, and nothing goes to the wire', async () => {
    const user = userEvent.setup();
    const p = props();
    draw(<NewRecordForm {...p} />);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Fill in Name.')).toBeVisible();
    expect(screen.getByText('Fill in Company.')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelectorAll('.insert-field.missing')).toHaveLength(2);
    expect(screen.getByLabelText('Name')).toHaveFocus();
    expect(calls.filter((c) => c.path === '/api/insert')).toHaveLength(0);
    expect(p.onAdded).not.toHaveBeenCalled();
  });
});

describe('the save', () => {
  test('quick-add retains pending and uncertain locks after correcting local validation', async () => {
    const user = userEvent.setup();
    let reject!: (error: Error) => void;
    const insert = vi.fn(
      () =>
        new Promise<never>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const p = props();
    draw(<NewRecordForm {...p} compact insert={insert} table={{ ...lead, columns: [col('name', 'TEXT', { nullable: false })] }} />);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(insert).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Name'), 'Ada{Enter}');
    expect(await screen.findByRole('status')).toHaveFocus();
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.submit(document.querySelector('.insert-form')!);
    expect(insert).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error('Response lost')));
    expect(screen.getByRole('alert')).toHaveTextContent('The row may already exist');
    expect(screen.getByRole('alert')).toHaveFocus();
    expect(screen.getByLabelText('Name')).toHaveValue('Ada');
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.queryByText('Fill in Name.')).toBeNull();
    fireEvent.submit(document.querySelector('.insert-form')!);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(insert).toHaveBeenCalledTimes(1);
    expect(p.onCancel).not.toHaveBeenCalled();
    expect(p.onAdded).not.toHaveBeenCalled();
  });

  test('a required field says so to assistive technology, not only with its star', () => {
    draw(<NewRecordDrawer {...props()} />);
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveAttribute('aria-required', 'true');
    expect(screen.getByRole('textbox', { name: 'Company' })).toHaveAttribute('aria-required', 'true');
    // A default fills Status, so it is not asked for.
    expect(screen.getByRole('textbox', { name: 'Status' })).not.toHaveAttribute('aria-required');
  });

  test('the drawer holds Tab: from its last control to its first, and back with Shift', () => {
    draw(<NewRecordDrawer {...props()} />);
    expect(screen.getByRole('dialog', { name: 'New lead' })).toHaveAttribute('aria-modal', 'true');
    const close = screen.getByRole('button', { name: 'Close' });
    const add = screen.getByRole('button', { name: 'Add' });
    add.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(add).toHaveFocus();
    // Focus that fell out of the drawer is brought back into it.
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
  });

  test('the drawer hands focus back to what opened it when it goes', async () => {
    const opener = document.createElement('button');
    opener.textContent = '+ New lead';
    document.body.append(opener);
    opener.focus();
    const view = draw(<NewRecordDrawer {...props()} />);
    expect(screen.getByRole('dialog', { name: 'New lead' })).toBeVisible();
    expect(opener).not.toHaveFocus();
    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(opener).toHaveFocus();
    opener.remove();
  });

  test.each([NewRecordDrawer, NewRecordDialog])('the frame honors an unresolved-operation veto before hiding itself', async (Frame) => {
    const user = userEvent.setup();
    const p = props();
    const canClose = vi.fn(() => false);
    draw(<Frame {...p} canClose={canClose} />);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(canClose).toHaveBeenCalled();
    expect(p.onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'New lead' })).toBeVisible();
    canClose.mockReturnValue(true);
    await user.keyboard('{Escape}');
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  test.each([NewRecordDrawer, NewRecordDialog])('discard confirmation rechecks the operation owner before closing', async (Frame) => {
    const user = userEvent.setup();
    const p = props();
    const canClose = vi.fn(() => true);
    draw(<Frame {...p} canClose={canClose} />);
    await user.type(screen.getByLabelText('Name'), 'Draft');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const confirmation = screen.getByRole('dialog', { name: 'Discard new record?' });
    canClose.mockReturnValue(false);
    await user.click(within(confirmation).getByRole('button', { name: 'Discard record' }));
    expect(p.onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'New lead' })).toBeVisible();
  });

  test.each([NewRecordDrawer, NewRecordDialog])('the frame blocks dismissal and duplicate submission until a response', async (Frame) => {
    const user = userEvent.setup();
    let release!: (result: { errors: Array<{ message: string }> }) => void;
    const insert = vi.fn(
      () =>
        new Promise<{ key: Record<string, unknown>; errors: Array<{ message: string }>; outcome: 'rejected' }>((resolve) => {
          release = (result) => resolve({ key: {}, ...result, outcome: 'rejected' });
        }),
    );
    const p = props();
    draw(<Frame {...p} insert={insert} form={{ show: ['name', 'company'], defaults: { name: 'Ada', company: 'Acme' } }} />);
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(await screen.findByRole('status')).toHaveTextContent('Adding...');
    expect(screen.getByRole('status')).toHaveFocus();
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Add$/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.submit(document.querySelector('.insert-form')!);
    await user.keyboard('{Escape}');
    fireEvent.pointerDown(document.querySelector('.peekpanel-backdrop, .confirm-backdrop')!);
    expect(p.onCancel).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledTimes(1);
    await act(async () => release({ errors: [{ message: 'Duplicate name' }] }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Duplicate name');
    expect(screen.getByRole('alert')).toHaveFocus();
    expect(screen.getByLabelText('Name')).toHaveValue('Ada');
    expect(screen.getByLabelText('Name')).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  test('a lost response preserves the draft, blocks another Add, and permits closing', async () => {
    const user = userEvent.setup();
    const p = props();
    const insert = vi.fn().mockRejectedValue(new Error('Response lost'));
    draw(<NewRecordDrawer {...p} insert={insert} form={{ show: ['name', 'company'], defaults: { name: 'Ada', company: 'Acme' } }} />);
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The row may already exist');
    expect(screen.getByRole('alert')).toHaveFocus();
    expect(screen.getByLabelText('Name')).toHaveValue('Ada');
    expect(screen.getByRole('button', { name: /^Add$/ })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    expect(p.onAdded).not.toHaveBeenCalled();
  });

  test('hidden null defaults and untouched shown defaults retain their values after a rejected save and retry', async () => {
    const user = userEvent.setup();
    const p = props();
    answers['/api/insert'] = { errors: [{ message: 'Try another name' }], outcome: 'rejected' };
    draw(
      <NewRecordForm
        {...p}
        form={{ show: ['name', 'company', 'due_on'], defaults: { name: 'Ada', company: 'Acme', due_on: null, owner_id: null } }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('Try another name');
    expect(sent()).toEqual({ name: 'Ada', company: 'Acme', due_on: null, owner_id: null });
    answers['/api/insert'] = { key: { id: 42 } };
    await user.type(screen.getByLabelText('Name'), ' Lovelace');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(p.onAdded).toHaveBeenCalled());
    expect(sent()).toEqual({ name: 'Ada Lovelace', company: 'Acme', due_on: null, owner_id: null });
  });

  test('an integer a CHECK pins to 0 and 1 is a switch, and multi-word choices read as words', async () => {
    const user = userEvent.setup();
    const p = props();
    const table = {
      ...lead,
      columns: [
        ...lead.columns,
        col('auto_renew', 'INTEGER', { nullable: false, default: '0', flag: true }),
        col('stage', 'TEXT', { nullable: false, allowed: ['todo', 'in progress', 'no-show'] }),
      ],
    };
    draw(
      <NewRecordForm
        {...p}
        table={table}
        form={{ show: ['auto_renew', 'stage'], defaults: { name: 'Ada', company: 'Acme', stage: 'todo' } }}
      />,
    );
    const renew = screen.getByRole('switch', { name: /auto.renew/i });
    expect(renew).not.toBeChecked();
    expect(screen.getAllByRole('radio').map((radio) => radio.closest('label')!.textContent)).toEqual(['Todo', 'In progress', 'No-show']);
    await user.click(renew);
    await user.click(screen.getByRole('radio', { name: 'In progress' }));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(p.onAdded).toHaveBeenCalled());
    expect(sent()).toMatchObject({ auto_renew: '1', stage: 'in progress' });
  });

  test('boolean presets are visible and editing them submits the selected choice', async () => {
    const user = userEvent.setup();
    const p = props();
    const table = { ...lead, columns: [...lead.columns, col('active', 'BOOLEAN')] };
    draw(<NewRecordForm {...p} table={table} form={{ show: ['active'], defaults: { name: 'Ada', company: 'Acme', active: false } }} />);
    // A flag that starts somewhere is a switch, never "leave it".
    const active = screen.getByRole('switch', { name: 'Active' });
    expect(active).not.toBeChecked();
    await user.click(active);
    expect(active).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(p.onAdded).toHaveBeenCalled());
    expect(sent()).toEqual({ name: 'Ada', company: 'Acme', active: '1' });
  });

  test('sends only what was typed, then hands the row on', async () => {
    const user = userEvent.setup();
    const p = props();
    draw(<NewRecordForm {...p} />);
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.type(screen.getByLabelText('Company'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(p.onAdded).toHaveBeenCalledWith({ key: { id: 42 }, row: { id: 42, name: 'Acme lead' } }));
    expect(calls.at(-1)).toEqual({ path: '/api/insert', body: { table: 'lead', values: { name: 'Ada', company: 'Acme' } } });
  });

  test("a refusal in the database's words stays on the form", async () => {
    answers['/api/insert'] = { errors: [{ message: 'UNIQUE constraint failed: lead.name' }], outcome: 'rejected' };
    const user = userEvent.setup();
    const p = props();
    draw(<NewRecordForm {...p} />);
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.type(screen.getByLabelText('Company'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('UNIQUE constraint failed: lead.name')).toBeVisible();
    await user.type(screen.getByLabelText('Name'), ' revised');
    expect(screen.getByRole('alert')).toHaveTextContent('UNIQUE constraint failed: lead.name');
    expect(p.onAdded).not.toHaveBeenCalled();
  });

  test('authoritative App validation maps safe field diagnostics into existing messages', async () => {
    answers['/api/insert'] = {
      errors: [
        {
          message: 'The record does not satisfy the application rules.',
          fields: [{ field: 'name', message: 'This value does not meet the application rules.' }],
        },
      ],
      outcome: 'rejected',
    };
    const user = userEvent.setup();
    draw(<NewRecordForm {...props()} form={{ show: ['name', 'company'] }} />);
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.type(screen.getByLabelText('Company'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    const name = await screen.findByLabelText('Name');
    expect(name).toHaveAccessibleDescription('This value does not meet the application rules.');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByRole('alert')).toBeNull();
    await user.type(name, ' revised');
    expect(name).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('This value does not meet the application rules.')).toBeNull();
  });

  test('unknown server fields stay at the form level and do not expose a hidden target', async () => {
    answers['/api/insert'] = {
      errors: [
        {
          message: 'The record does not satisfy the application rules.',
          fields: [{ field: 'private_column', message: 'Do not expose this field.' }],
        },
      ],
      outcome: 'rejected',
    };
    const user = userEvent.setup();
    draw(<NewRecordForm {...props()} form={{ show: ['name', 'company'] }} />);
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.type(screen.getByLabelText('Company'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The record does not satisfy the application rules.');
    expect(screen.queryByText('Do not expose this field.')).toBeNull();
  });
});

describe('the controls', () => {
  test('the listbox opens on the page, walks with the keyboard, and shows what was chosen', async () => {
    const user = userEvent.setup();
    draw(<NewRecordForm {...props()} />);
    const source = screen.getByRole('button', { name: 'Source' });
    await user.click(source);
    const list = screen.getByRole('listbox', { name: 'Source' });
    expect(within(list).getAllByRole('option')).toHaveLength(4);
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    // In the App's words: the stored `event` is said "Event".
    expect(source).toHaveTextContent('Event');
    expect(list).not.toBeVisible();
    // And a save carries the choice.
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.type(screen.getByLabelText('Company'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(calls.at(-1)?.path).toBe('/api/insert'));
    expect(sent().source).toBe('event');
  });

  test('the picker searches by name and keeps the id', async () => {
    const user = userEvent.setup();
    draw(<NewRecordForm {...props()} />);
    const picker = screen.getByRole('combobox', { name: 'Owner' });
    await user.type(picker, 'Arjun');
    await vi.waitFor(() =>
      expect(calls.some((c) => c.path === '/api/run' && String((c.body as { q: string }).q).includes('contains "Arjun"'))).toBe(true),
    );
    await user.click(await screen.findByText('Arjun Mehta'));
    expect(picker).toHaveValue('Arjun Mehta');
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.type(screen.getByLabelText('Company'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(calls.at(-1)?.path).toBe('/api/insert'));
    expect(sent().owner_id).toBe('7');
  });
});

describe('the drawer', () => {
  test('is a dialog over the list, titled for the app, and Escape closes it', async () => {
    const user = userEvent.setup();
    const p = props();
    draw(<NewRecordDrawer {...p} />);
    expect(screen.getByRole('dialog', { name: 'New lead' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('New lead');
    await user.keyboard('{Escape}');
    expect(p.onCancel).toHaveBeenCalled();
  });

  test('but a listbox open inside it takes the first Escape', async () => {
    const user = userEvent.setup();
    const p = props();
    draw(<NewRecordDrawer {...p} />);
    await user.click(screen.getByRole('button', { name: 'Source' }));
    await user.keyboard('{Escape}');
    expect(p.onCancel).not.toHaveBeenCalled();
    // The listbox took it: closed, and the drawer still up.
    expect(screen.getByRole('button', { name: 'Source' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('dialog', { name: 'New lead' })).toBeInTheDocument();
  });
});

describe('unsaved creation', () => {
  test.each([NewRecordDrawer, NewRecordDialog])('Cancel preserves edits until explicit discard in either frame', async (Frame) => {
    const user = userEvent.setup();
    const p = props();
    draw(<Frame {...p} />);
    await user.type(screen.getByLabelText('Name'), 'Unfinished lead');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const confirm = await screen.findByRole('dialog', { name: 'Discard new record?' });
    expect(p.onCancel).not.toHaveBeenCalled();
    expect(within(confirm).getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    await user.click(within(confirm).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Unfinished lead');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Discard record' }));
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.path === '/api/insert')).toBe(false);
  });

  test.each([NewRecordDrawer, NewRecordDialog])('Escape dismisses the confirmation before the unsaved form', async (Frame) => {
    const user = userEvent.setup();
    const p = props();
    draw(<Frame {...p} />);
    await user.type(screen.getByLabelText('Name'), 'Keep me');
    await user.keyboard('{Escape}');
    await screen.findByRole('dialog', { name: 'Discard new record?' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Discard new record?' })).toBeNull();
    expect(p.onCancel).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Name')).toHaveValue('Keep me');
    expect(screen.getByLabelText('Name')).toHaveFocus();
  });

  test('a dirty drawer gives an open listbox the first Escape', async () => {
    const user = userEvent.setup();
    const p = props();
    draw(<NewRecordDrawer {...p} />);
    await user.type(screen.getByLabelText('Name'), 'Keep me');
    await user.click(screen.getByRole('button', { name: 'Source' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Discard new record?' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Source' })).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Escape}');
    await screen.findByRole('dialog', { name: 'Discard new record?' });
    expect(p.onCancel).not.toHaveBeenCalled();
  });

  test('returning to a preset or an initially empty field removes discard and reload warnings', async () => {
    const user = userEvent.setup();
    const p = props();
    draw(<NewRecordDrawer {...p} form={{ defaults: { name: 'Preset', company: 'Acme' } }} />);
    const unloading = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(unloading()).toBe(false);
    await user.type(screen.getByLabelText('Name'), ' changed');
    expect(unloading()).toBe(true);
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Preset');
    expect(unloading()).toBe(false);
    await user.type(screen.getByLabelText('Status'), 'working');
    await user.clear(screen.getByLabelText('Status'));
    expect(unloading()).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Discard new record?' })).toBeNull();
  });

  test('rejected writes retain discard protection, but uncertain writes never claim entries are unsaved', async () => {
    const user = userEvent.setup();
    const p = props();
    const insert = vi
      .fn()
      .mockResolvedValueOnce({ errors: [{ message: 'Duplicate name' }], outcome: 'rejected' })
      .mockRejectedValueOnce(new Error('Response lost'));
    draw(<NewRecordDrawer {...p} insert={insert} />);
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.type(screen.getByLabelText('Company'), 'Acme');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await screen.findByText('Duplicate name');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('The row may already exist');
    await user.keyboard('{Escape}');
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Discard new record?' })).toBeNull();
  });
});

test("a column's text rule is said under the field as it is typed, and holds the form until it is met", async () => {
  const user = userEvent.setup();
  const insert = vi.fn().mockResolvedValue({ key: { id: 7 } });
  const table: TableMeta = {
    ...lead,
    columns: [
      col('id', 'INTEGER', { primaryKey: true, nullable: false, identity: 'by-default' }),
      col('code', 'TEXT', { nullable: false, text: { pattern: '[A-Z]{3}' } }),
      col('name', 'TEXT', { text: { min: 2, max: 5 } }),
    ],
  };
  draw(<NewRecordForm {...props()} table={table} insert={insert} />);
  const code = screen.getByRole('textbox', { name: 'Code' });
  await user.type(code, 'ab');
  expect(code).toHaveAccessibleDescription('Enter a value in the expected form.');
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'toolong');
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveAccessibleDescription('Use at most 5 characters.');
  await user.click(screen.getByRole('button', { name: /^Add$/ }));
  expect(insert).not.toHaveBeenCalled();
  await user.clear(code);
  await user.type(code, 'ABC');
  expect(code).not.toHaveAccessibleDescription('Enter a value in the expected form.');
  await user.clear(screen.getByRole('textbox', { name: 'Name' }));
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'a');
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveAccessibleDescription('Use at least 2 characters.');
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'b');
  await user.click(screen.getByRole('button', { name: /^Add$/ }));
  expect(insert).toHaveBeenCalledWith({ code: 'ABC', name: 'ab' });
});

describe("a form's lines are the shell's part", () => {
  const line: TableMeta = {
    id: 'lead_note',
    name: 'lead_note',
    schema: '',
    isView: false,
    indexed: ['id'],
    columns: [
      col('id', 'INTEGER', { primaryKey: true, nullable: false, identity: 'by-default' }),
      col('lead_id', 'INTEGER', { nullable: false, references: { table: 'lead', column: 'id' } }),
      col('text', 'TEXT'),
    ],
  };
  const withLines = () => ({
    ...props(),
    target: (id: string) => (id === 'lead_note' ? line : id === 'owner' ? owner : undefined),
    form: { lines: [{ label: 'Notes', from: 'lead_note', whose: 'lead_id', show: ['text'] }] },
  });
  afterEach(async () => (await import('../shellMode.js')).resetShell());

  test('where the shell has none (the Workbench), the form is drawn without them', async () => {
    draw(<NewRecordForm {...withLines()} />);
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Notes' })).toBeNull();
  });

  test("where it has them, the form waits for the part and draws the lines' grid", async () => {
    const { installShell, shell } = await import('../shellMode.js');
    /* The part as the form reads it; FormLines.test.tsx draws the real grid. */
    const part = {
      LinesEditor: ({ title }: { title: string }) => <fieldset aria-label={title} />,
      LiveValues: () => null,
      blankLine: () => ({ id: 1, values: {} }),
      lineProblems: () => ({}),
      lineValues: () => ({}),
      lineServerProblems: () => ({}),
    };
    let arrive!: () => void;
    let here = false;
    const arriving = new Promise<void>((resolve) => (arrive = resolve));
    installShell({
      slots: {
        ...shell().slots,
        formLines: { ready: () => arriving.then(() => void (here = true)), here: () => here, get: () => (here ? part : undefined) },
      },
    });
    draw(<NewRecordForm {...withLines()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
    await act(async () => arrive());
    expect(await screen.findByRole('group', { name: 'Notes' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeTruthy();
  });
});
