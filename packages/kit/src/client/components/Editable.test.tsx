/**
 * A field as an editor, against the real staging store: typing stages,
 * typing the original back un-stages, Escape restores, the bar counts.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ColumnMeta, TableMeta } from '../../../../engine/src/shared/schema.js';
import { columnKind, labelColumn } from '../../../../engine/src/shared/schema.js';

const applied: unknown[] = [];
const model = vi.hoisted(() => ({
  app: false,
  mode: 'explicit' as 'explicit' | 'blur',
  nav: 0,
  reply: undefined as undefined | ((body: unknown) => Promise<unknown>),
  target: undefined as TableMeta | undefined,
  rules: {} as Record<string, unknown>,
}));
vi.mock('../../../../mistri/src/client/appState.js', () => ({
  appSaveMode: () => model.mode,
  inAppMode: () => false,
  activeApp: () => null,
}));
vi.mock('../core.js', () => ({
  $: () => ({ addEventListener() {}, setAttribute() {}, textContent: '', title: '' }),
  columnDisplay: (_table: string, column: string) => model.rules[column] ?? null,
  state: { activeConnection: 'demo', canWrite: true, connections: [{ id: 'demo', writable: true }] },
  api: async (path: string, body: { values?: object }) => {
    if (path === '/api/query') return { rows: [{ id: 1, name: 'Acme' }] };
    if (path === '/api/run')
      return {
        rows: [
          { id: 1, name: 'Acme' },
          { id: 2, name: 'Beta' },
        ],
      };
    applied.push([path, body]);
    return model.reply ? model.reply(body) : { affected: 1, applied: body.values ?? {} };
  },
  el: (tag: string) => document.createElement(tag),
  loadJson: () => ({}),
  saveJson: () => {},
  prefersPages: () => model.app,
  captureNavigation: () => {
    const nav = model.nav;
    return () => nav === model.nav;
  },
  setRecordMutationPendingProbe: () => {},
  render: () => {},
  toast: () => {},
  writeAllowed: () => true,
  columnKind,
  columnLabel: () => null,
  labelPath: (table: TableMeta) => labelColumn(table),
  recordLabel: () => undefined,
  refsFrom: () => [],
  findTable: () => model.target,
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
vi.mock('../../../../tablewalk/src/client/undo.js', () => ({ refreshUndo: () => {}, undoLast: async () => {} }));

const { Editable, PendingBar } = await import('./Editable.js');
const { activateDraft, discardStaged, stagedValue, stage } = await import('../write.js');
const { updateAttempts } = await import('../updateAttempts.js');

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra }) as ColumnMeta;
const customer: TableMeta = {
  id: 'customer',
  name: 'customer',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('name', 'TEXT'),
    col('active', 'INTEGER'),
  ] as TableMeta['columns'],
};
const row = { id: 4, name: 'Acme', active: 1 };
const key = { id: 4 };

function draw() {
  render(
    <>
      <PendingBar table={customer} recordKey={key} />
      <Editable table={customer} row={row} column={customer.columns[1]} recordKey={key} />
      <Editable table={customer} row={row} column={customer.columns[2]} recordKey={key} />
    </>,
  );
}

beforeEach(bridgeShell);

beforeEach(() => {
  model.app = false;
  model.mode = 'explicit';
  model.reply = undefined;
  model.target = undefined;
  model.rules = {};
  model.nav++;
  act(() => {
    updateAttempts.reset();
    activateDraft(customer, key);
    discardStaged();
  });
  applied.length = 0;
});
afterEach(() => cleanup());

describe('the editor', () => {
  test.each([false, true])('a forbidden field has no inline or input affordance in app mode %s', (app) => {
    render(
      <Editable
        app={app}
        table={customer}
        row={row}
        column={{ ...customer.columns[1], writable: false }}
        recordKey={key}
        display={app ? (value) => <span>{String(value)}</span> : undefined}
      />,
    );
    expect(screen.getByText('Acme')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(stagedValue('name')).toBeUndefined();
  });

  test.each([false, true])('a column that moves only through actions has no inline or input affordance in app mode %s', (app) => {
    render(
      <Editable
        app={app}
        table={customer}
        row={row}
        column={{ ...customer.columns[1], changesBy: 'actions' }}
        recordKey={key}
        display={app ? (value) => <span>{String(value)}</span> : undefined}
      />,
    );
    expect(screen.getByText('Acme')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(stagedValue('name')).toBeUndefined();
  });

  test('an opened inline field loses its editor when writability is revoked', async () => {
    const user = userEvent.setup();
    const display = (value: unknown) => <span>{String(value)}</span>;
    const view = render(
      <Editable app table={customer} row={row} column={{ ...customer.columns[1], writable: true }} recordKey={key} display={display} />,
    );
    await user.click(screen.getByRole('button', { name: 'Edit Name' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), ' changed');
    view.rerender(
      <Editable app table={customer} row={row} column={{ ...customer.columns[1], writable: false }} recordKey={key} display={display} />,
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Acme')).toBeVisible();
    expect(applied).toEqual([]);
  });

  test('formatted app values open individually, focus the editor, and Escape restores the value', async () => {
    const user = userEvent.setup();
    render(
      <Editable
        app
        table={customer}
        row={row}
        column={customer.columns[1]}
        recordKey={key}
        display={(value) => <span>{String(value)}</span>}
      />,
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    const launch = screen.getByRole('button', { name: 'Edit Name' });
    expect(launch).toHaveTextContent('Acme');
    await user.click(launch);
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input).toHaveFocus();
    await user.type(input, ' changed');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit Name' })).toHaveTextContent('Acme');
    expect(screen.getByRole('button', { name: 'Edit Name' })).toHaveFocus();
    expect(applied).toEqual([]);
  });

  test('app vocabulary uses human labels and preserves the stored value on discard', async () => {
    const user = userEvent.setup();
    const column = col('status', 'TEXT', { allowed: ['in_progress', 'done'], nullable: false });
    render(
      <>
        <Editable app table={customer} row={{ id: 4, status: 'in_progress' }} column={column} recordKey={key} />
        <PendingBar table={customer} recordKey={key} />
      </>,
    );
    const control = screen.getByRole('button', { name: 'Status' });
    expect(control).toHaveTextContent('In progress');
    await user.click(control);
    await user.click(screen.getByRole('option', { name: 'Done' }));
    expect(control).toHaveTextContent('Done');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(control).toHaveTextContent('In progress');
  });

  test("a true/false field is edited in its display rule's words, not Yes and No", async () => {
    const user = userEvent.setup();
    model.rules = { active: { values: { true: 'On', false: 'Off' } } };
    const column = col('active', 'boolean', { nullable: false });
    render(<Editable app table={customer} row={{ id: 4, active: true }} column={column} recordKey={key} />);
    const control = screen.getByRole('button', { name: 'Active' });
    expect(control).toHaveTextContent('On');
    await user.click(control);
    expect(screen.getByRole('option', { name: 'On' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Yes' })).toBeNull();
    await user.click(screen.getByRole('option', { name: 'Off' }));
    expect(stagedValue('active')).toBe('false');
  });

  test('a SQLite 1/0 field takes the words a rule keys as true and false; a side it does not name says Yes or No', async () => {
    const user = userEvent.setup();
    model.rules = { active: { values: { true: 'Billable' } } };
    render(
      <Editable app table={customer} row={{ id: 4, active: 1 }} column={col('active', 'BOOLEAN', { nullable: false })} recordKey={key} />,
    );
    await user.click(screen.getByRole('button', { name: 'Active' }));
    expect(screen.getByRole('option', { name: 'Billable' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'No' })).toBeVisible();
  });

  test('app dates use the themed calendar without converting timestamps', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <Editable app table={customer} row={{ id: 4, due: '2026-09-05' }} column={col('due', 'DATE')} recordKey={key} />,
    );
    const due = screen.getByRole('textbox', { name: 'Due' });
    expect(due).toHaveValue('09/05/2026');
    await user.click(screen.getByRole('button', { name: 'Choose date for Due' }));
    await user.click(await screen.findByRole('button', { name: /September 7, 2026/ }));
    expect(stagedValue('due')).toBe('2026-09-07');
    expect(due).toHaveValue('09/07/2026');
    act(() => {
      discardStaged();
    });
    rerender(
      <Editable app table={customer} row={{ id: 4, due: '2026-09-05T12:30:00Z' }} column={col('due', 'TIMESTAMP')} recordKey={key} />,
    );
    expect(screen.queryByRole('button', { name: 'Choose date for Due' })).toBeNull();
    expect(screen.getByLabelText('Due')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('Due')).toHaveValue('2026-09-05T12:30:00Z');
  });

  test('a typed date that is no date is held back as invalid, not staged as a value to save', async () => {
    const user = userEvent.setup();
    render(<Editable app table={customer} row={{ id: 4, due: '2026-09-05' }} column={col('due', 'DATE')} recordKey={key} />);
    const due = screen.getByRole('textbox', { name: 'Due' });
    await user.clear(due);
    await user.type(due, '2026-02-30');
    expect(due).toBeInvalid();
    expect(due).toHaveAttribute('aria-invalid', 'true');
  });

  test('typing stages a change and the bar counts it; typing the original back un-stages it', async () => {
    const user = userEvent.setup();
    draw();
    const name = screen.getByLabelText('name (TEXT)');
    expect(screen.queryByText(/unsaved change/)).toBeNull();
    await user.type(name, ' Ltd');
    expect(name).toHaveValue('Acme Ltd');
    expect(name).toHaveClass('dirty');
    expect(screen.getByText('1 unsaved change')).toBeInTheDocument();
    expect(screen.getByText('name')).toHaveClass('pending-cols');
    await user.clear(name);
    await user.type(name, 'Acme');
    expect(name).not.toHaveClass('dirty');
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  test('a flag edits as yes/no in the values the database stores, and empty is null', async () => {
    const user = userEvent.setup();
    draw();
    const active = screen.getByLabelText('active (INTEGER)') as HTMLSelectElement;
    expect(active.tagName).toBe('SELECT');
    expect([...active.options].map((o) => o.value)).toEqual(['', '1', '0']);
    await user.selectOptions(active, '0');
    expect(active).toHaveClass('dirty');
    expect(screen.getByText('1 unsaved change')).toBeInTheDocument();
  });

  test('Escape restores the original, Discard drops everything', async () => {
    const user = userEvent.setup();
    draw();
    const name = screen.getByLabelText('name (TEXT)');
    await user.type(name, 'x');
    await user.keyboard('{Escape}');
    expect(name).toHaveValue('Acme');
    expect(screen.queryByText(/unsaved change/)).toBeNull();
    await user.type(name, 'y');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByText(/unsaved change/)).toBeNull();
    expect(name).toHaveValue('Acme');
  });

  test.each([
    { original: null, next: 'null', staged: 'null' },
    { original: 'null', next: '', staged: null },
  ])('database null and literal null text remain distinct: $original to $next', async ({ original, next, staged }) => {
    const user = userEvent.setup();
    render(
      <>
        <PendingBar table={customer} recordKey={key} />
        <Editable table={customer} row={{ ...row, name: original }} column={customer.columns[1]} recordKey={key} />
      </>,
    );
    const input = screen.getByRole('textbox', { name: 'name (TEXT)' });
    await user.clear(input);
    if (next) await user.type(input, next);
    expect(input).toHaveValue(next);
    expect(stagedValue('name')).toBe(staged);
    expect(screen.getByText('1 unsaved change')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(input).toHaveValue(original ?? '');
    expect(stagedValue('name')).toBeUndefined();
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });
});

const REFUSED = 'The record does not satisfy the application rules.';
const FIELD_RULE = 'This value does not meet the application rules.';
/** The update route's answer to a root `validation` refusal, naming fields. */
const refusal =
  (...fields: string[]) =>
  async () => ({
    outcome: 'rejected',
    errors: [{ code: 'validation_failed', message: REFUSED, fields: fields.map((field) => ({ field, message: FIELD_RULE })) }],
  });

describe('a refused record Save', () => {
  test('marks the field it names, opens and focuses it, keeps the draft, and an edit clears only that mark', async () => {
    model.reply = refusal('notes');
    const user = userEvent.setup();
    drawApp(textTable, textRow, true);
    await user.click(screen.getByRole('button', { name: 'Edit Name' }));
    await user.type(screen.getByLabelText('Name'), ' Ltd');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await flush();
    expect(applied).toHaveLength(1);
    // Notes was never opened: marked, it opens to be answered, and takes the focus.
    const notes = screen.getByLabelText('Notes');
    expect(notes).toHaveAccessibleDescription(FIELD_RULE);
    expect(notes).toHaveAttribute('aria-invalid', 'true');
    expect(notes).toHaveFocus();
    expect(stagedValue('name')).toBe('Acme Ltd');
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid');
    // Every named field is marked, so the summary says nothing more.
    expect(screen.queryByText(REFUSED)).toBeNull();
    expect(screen.getByText('1 unsaved change')).toBeVisible();
    await user.type(notes, ' fixed');
    expect(notes).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText(FIELD_RULE)).toBeNull();
    model.reply = undefined;
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await flush();
    expect(applied[1]).toEqual([
      '/api/update',
      {
        conn: 'demo',
        table: 'customer',
        key,
        values: { name: 'Acme Ltd', notes: 'Memo fixed' },
        expected: { name: 'Acme', notes: 'Memo' },
      },
    ]);
  });

  test('leaves a field the record does not show, and a name it does not have, to the summary', async () => {
    const table = { ...textTable, columns: [...textTable.columns, col('secret', 'TEXT', { writable: false })] };
    model.reply = refusal('notes', 'secret', 'nowhere');
    const user = userEvent.setup();
    drawApp(table, { ...textRow, secret: 'x' });
    await user.type(screen.getByLabelText('Name'), ' Ltd');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await flush();
    expect(screen.getByLabelText('Notes')).toHaveAccessibleDescription(FIELD_RULE);
    expect(screen.getByLabelText('Notes')).toHaveFocus();
    const summary = screen.getByText(new RegExp(`^${REFUSED}`));
    expect(summary).toHaveTextContent(`${REFUSED} secret: ${FIELD_RULE}`);
    expect(summary).not.toHaveTextContent('nowhere');
  });

  test('with no field named, it is the summary it always was', async () => {
    model.reply = refusal();
    const user = userEvent.setup();
    drawApp(textTable, textRow);
    await user.type(screen.getByLabelText('Name'), ' Ltd');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await flush();
    expect(screen.getByText(REFUSED)).toBeVisible();
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveFocus();
  });
});

function drawApp(table = customer, data: Record<string, unknown> = row, inline = false) {
  model.app = true;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <PendingBar table={table} recordKey={key} />
      {table.columns
        .filter((column) => !column.primaryKey)
        .map((column) => (
          <Editable
            key={column.name}
            app
            table={table}
            row={data}
            column={column}
            recordKey={key}
            display={inline ? (value) => <span>{String(value ?? '—')}</span> : undefined}
          />
        ))}
      <button type="button">Business action</button>
      <a href="#elsewhere">Elsewhere</a>
    </QueryClientProvider>,
  );
  return { ...view, client };
}
const textTable: TableMeta = {
  ...customer,
  columns: [customer.columns[0], col('name', 'TEXT', { nullable: false }), col('notes', 'TEXT')],
};
const textRow = { id: 4, name: 'Acme', notes: 'Memo' };
const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
};

describe('opt-in App blur save', () => {
  test('Discard resets unresolved picker search even when the stored reference ID never changed', async () => {
    model.mode = 'blur';
    model.target = customer;
    const user = userEvent.setup();
    const table = {
      ...textTable,
      columns: [...textTable.columns, col('parent', 'INTEGER', { references: { table: 'customer', column: 'id' } })],
    };
    drawApp(table, { ...textRow, parent: 1 });
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByRole('combobox', { name: 'Parent' }), 'Missing');
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Parent' })).toHaveValue('Acme'));
    expect(screen.getByRole('combobox', { name: 'Parent' })).not.toHaveFocus();
    expect(screen.queryByRole('alert')).toBeNull();
    await user.type(screen.getByLabelText('Name'), ' after discard');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await flush();
    expect(applied).toEqual([
      ['/api/update', { conn: 'demo', table: 'customer', key, values: { name: 'Acme after discard' }, expected: { name: 'Acme' } }],
    ]);
  });

  test.each([false, true])('leaving a changed field saves once with in-place confirmation (inline %s)', async (inline) => {
    model.mode = 'blur';
    const user = userEvent.setup();
    drawApp(textTable, textRow, inline);
    if (inline) await user.click(screen.getByRole('button', { name: 'Edit Name' }));
    await user.type(screen.getByLabelText('Name'), ' Ltd');
    expect(applied).toEqual([]);
    await user.click(inline ? screen.getByRole('button', { name: 'Edit Notes' }) : screen.getByLabelText('Notes'));
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0]).toEqual([
      '/api/update',
      { conn: 'demo', table: 'customer', key, values: { name: 'Acme Ltd' }, expected: { name: 'Acme' } },
    ]);
    expect(screen.getByLabelText('Name')).toHaveValue('Acme Ltd');
    expect(screen.getByText('Changes saved')).toBeVisible();
    expect(screen.getByLabelText('Notes')).toHaveFocus();
    await flush();
    expect(applied).toHaveLength(1);
  });

  test('explicit policy and unchanged focus moves never save', async () => {
    const user = userEvent.setup();
    drawApp(textTable, textRow);
    await user.type(screen.getByLabelText('Name'), ' Ltd');
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toEqual([]);
    model.mode = 'blur';
    await user.click(screen.getByLabelText('Name'));
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toEqual([]);
  });

  test('blur submits the full current draft with every expected original', async () => {
    model.mode = 'blur';
    const user = userEvent.setup();
    drawApp(textTable, textRow);
    act(() => stage(textTable, key, textTable.columns[2], 'Staged memo', 'Memo'));
    await user.type(screen.getByLabelText('Name'), ' Ltd');
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toEqual([
      [
        '/api/update',
        {
          conn: 'demo',
          table: 'customer',
          key,
          values: { notes: 'Staged memo', name: 'Acme Ltd' },
          expected: { notes: 'Memo', name: 'Acme' },
        },
      ],
    ]);
  });

  test('navigation winning deferred settlement retains the draft without dispatch', async () => {
    model.mode = 'blur';
    const user = userEvent.setup();
    drawApp(textTable, textRow);
    await user.type(screen.getByLabelText('Name'), ' Ltd');
    act(() => {
      screen.getByLabelText('Notes').focus();
      model.nav++;
    });
    await flush();
    expect(applied).toEqual([]);
    expect(stagedValue('name')).toBe('Acme Ltd');
  });

  test('keyboard intent on Save cancels pending blur and submits exactly once', async () => {
    model.mode = 'blur';
    const user = userEvent.setup();
    drawApp(textTable, textRow);
    await user.type(screen.getByLabelText('Name'), ' Ltd');
    act(() => screen.getByRole('button', { name: 'Save changes' }).focus());
    await flush();
    expect(applied).toEqual([]);
    await user.keyboard('{Enter}');
    await flush();
    expect(applied).toHaveLength(1);
  });

  test.each(['Save changes', 'Discard'])('%s cancels blur before a held pointer is released', async (name) => {
    model.mode = 'blur';
    const user = userEvent.setup();
    drawApp(textTable, textRow);
    await user.type(screen.getByLabelText('Name'), ' Ltd');
    const button = screen.getByRole('button', { name });
    await user.pointer({ target: button, keys: '[MouseLeft>]' });
    await flush();
    expect(applied).toEqual([]);
    await user.pointer({ target: button, keys: '[/MouseLeft]' });
    await flush();
    expect(applied).toHaveLength(name === 'Save changes' ? 1 : 0);
    if (name === 'Discard') expect(screen.getByLabelText('Name')).toHaveValue('Acme');
  });

  test('Enter is one explicit save even when the field blurs immediately afterward', async () => {
    model.mode = 'blur';
    const user = userEvent.setup();
    drawApp(textTable, textRow);
    await user.type(screen.getByLabelText('Name'), ' Ltd');
    await user.keyboard('{Enter}');
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toHaveLength(1);
  });

  test('Escape restores only its field and cannot submit another staged field', async () => {
    model.mode = 'blur';
    const user = userEvent.setup();
    drawApp(textTable, textRow);
    act(() => stage(textTable, key, textTable.columns[2], 'Other draft', 'Memo'));
    await user.type(screen.getByLabelText('Name'), ' Ltd');
    await user.keyboard('{Escape}');
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(screen.getByLabelText('Name')).toHaveValue('Acme');
    expect(stagedValue('notes')).toBe('Other draft');
    expect(applied).toEqual([]);
  });

  test('native badInput blocks the whole snapshot, shows one associated error, and clears on correction', async () => {
    model.mode = 'blur';
    const user = userEvent.setup();
    drawApp(textTable, textRow);
    const input = screen.getByLabelText('Name') as HTMLInputElement;
    expect(screen.queryByRole('alert')).toBeNull();
    await user.type(input, ' Ltd');
    Object.defineProperty(input, 'validity', { configurable: true, value: { badInput: true } });
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toEqual([]);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(input).toHaveAccessibleDescription('Enter a valid value.');
    Object.defineProperty(input, 'validity', { configurable: true, value: { badInput: false } });
    await user.type(input, '!');
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toHaveLength(1);
  });

  test('required preflight is passive on blur and explicit Save focuses the same single error', async () => {
    model.mode = 'blur';
    const user = userEvent.setup();
    drawApp(textTable, textRow);
    await user.clear(screen.getByLabelText('Name'));
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toEqual([]);
    expect(screen.getByLabelText('Notes')).toHaveFocus();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription('Required');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByLabelText('Name')).toHaveFocus();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    await user.type(screen.getByLabelText('Name'), 'Fixed');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('pending freezes the record and queues no follow-up save', async () => {
    model.mode = 'blur';
    let resolve!: (value: unknown) => void;
    model.reply = () =>
      new Promise((done) => {
        resolve = done;
      });
    const user = userEvent.setup();
    drawApp(textTable, textRow);
    await user.type(screen.getByLabelText('Name'), ' Ltd');
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toHaveLength(1);
    expect(screen.getByLabelText('Name')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Notes')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Notes')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Queued?' } });
    await act(async () => resolve({ affected: 1, applied: { name: 'Acme Ltd' } }));
    await flush();
    expect(applied).toHaveLength(1);
    expect(stagedValue('name')).toBeUndefined();
  });

  test('rejected work stays manual through fresh corrections and blur', async () => {
    model.mode = 'blur';
    model.reply = async () => ({ outcome: 'rejected', errors: [{ message: 'Conflict' }] });
    const user = userEvent.setup();
    drawApp(textTable, textRow);
    await user.type(screen.getByLabelText('Name'), ' Ltd');
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toHaveLength(1);
    expect(screen.getByText('Conflict')).toBeVisible();
    await user.type(screen.getByLabelText('Name'), '!');
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toHaveLength(1);
    model.reply = undefined;
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await flush();
    expect(applied).toHaveLength(2);
  });

  test('a refused blur save marks the named field, leaves focus where the reader went, and does not retry', async () => {
    model.mode = 'blur';
    model.reply = refusal('name');
    const user = userEvent.setup();
    drawApp(textTable, textRow);
    const name = screen.getByLabelText('Name');
    await user.type(name, ' Ltd');
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toHaveLength(1);
    expect(name).toHaveAccessibleDescription(FIELD_RULE);
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Notes')).toHaveFocus();
    expect(stagedValue('name')).toBe('Acme Ltd');
    await user.click(name);
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toHaveLength(1);
    // Editing the field is its answer: the mark goes, and the save stays manual.
    await user.type(name, '!');
    expect(name).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText(FIELD_RULE)).toBeNull();
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toHaveLength(1);
  });

  test('unconfirmed acknowledgement locks controls and never retries', async () => {
    model.mode = 'blur';
    model.reply = async () => {
      throw new Error('Lost acknowledgement');
    };
    const user = userEvent.setup();
    drawApp(textTable, textRow);
    await user.type(screen.getByLabelText('Name'), ' Ltd');
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toHaveLength(1);
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/confirm|unknown|lost/i);
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    await flush();
    expect(applied).toHaveLength(1);
  });

  test('outside action intent retains the draft; remount and Resume require manual Save', async () => {
    model.mode = 'blur';
    const user = userEvent.setup();
    const view = drawApp(textTable, textRow);
    await user.type(screen.getByLabelText('Name'), ' Ltd');
    await user.click(screen.getByRole('button', { name: 'Business action' }));
    await flush();
    expect(applied).toEqual([]);
    view.unmount();
    drawApp(textTable, textRow);
    expect(screen.getByRole('region', { name: 'Retained draft' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Resume draft' }));
    await user.type(screen.getByLabelText('Name'), '!');
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await flush();
    expect(applied).toHaveLength(1);
  });

  test('real Dropdown selection across its portal waits for leaving the field; first Escape only closes the popup', async () => {
    model.mode = 'blur';
    const user = userEvent.setup();
    const table = { ...textTable, columns: [...textTable.columns, col('status', 'TEXT', { allowed: ['open', 'done'], nullable: false })] };
    drawApp(table, { ...textRow, status: 'open' });
    const trigger = screen.getByRole('button', { name: 'Status' });
    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: 'Done' }));
    await flush();
    expect(applied).toEqual([]);
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.keyboard('{Escape}');
    await flush();
    expect(stagedValue('status')).toBe('done');
    expect(applied).toEqual([]);
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toEqual([]);
    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: 'Open' }));
    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: 'Done' }));
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toHaveLength(1);
  });

  test('unresolved real RecordPicker search blocks every staged field and Escape never submits them', async () => {
    model.mode = 'blur';
    model.target = customer;
    const user = userEvent.setup();
    const table = {
      ...textTable,
      columns: [...textTable.columns, col('parent', 'INTEGER', { references: { table: 'customer', column: 'id' } })],
    };
    drawApp(table, { ...textRow, parent: 1 });
    const picker = screen.getByRole('combobox', { name: 'Parent' });
    await waitFor(() => expect(picker).toHaveValue('Acme'));
    act(() => stage(table, key, table.columns[1], 'Other staged field', 'Acme'));
    await user.clear(picker);
    await user.type(picker, 'Missing');
    expect(stagedValue('parent')).toBeUndefined();
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toEqual([]);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(picker).toHaveAccessibleDescription('Choose a record or clear the field.');
    await user.click(picker);
    await user.keyboard('{Escape}');
    await flush();
    expect(picker).toHaveValue('Acme');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(stagedValue('name')).toBe('Other staged field');
    expect(applied).toEqual([]);
  });

  test('real RecordPicker selection and intentional Clear stage IDs and use one full-snapshot save', async () => {
    model.mode = 'blur';
    model.target = customer;
    const user = userEvent.setup();
    const table = {
      ...textTable,
      columns: [...textTable.columns, col('parent', 'INTEGER', { references: { table: 'customer', column: 'id' } })],
    };
    drawApp(table, { ...textRow, parent: 1 });
    const picker = screen.getByRole('combobox', { name: 'Parent' });
    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: /Beta/ }));
    await flush();
    expect(applied).toEqual([]);
    expect(stagedValue('parent')).toBe('2');
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(stagedValue('parent')).toBeNull();
    await flush();
    expect(applied).toHaveLength(1);
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toHaveLength(2);
  });

  test('Escape after an unresolved picker closes restores its original label without submitting another field', async () => {
    model.mode = 'blur';
    model.target = customer;
    const user = userEvent.setup();
    const table = {
      ...textTable,
      columns: [...textTable.columns, col('parent', 'INTEGER', { references: { table: 'customer', column: 'id' } })],
    };
    drawApp(table, { ...textRow, parent: 1 });
    const picker = screen.getByRole('combobox', { name: 'Parent' });
    await waitFor(() => expect(picker).toHaveValue('Acme'));
    act(() => stage(table, key, table.columns[1], 'Other staged field', 'Acme'));
    await user.clear(picker);
    await user.type(picker, 'Unresolved');
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(picker).toHaveAttribute('aria-expanded', 'false');
    // Focus restoration itself does not open the popup or count as a new edit.
    act(() => picker.focus());
    fireEvent.keyDown(picker, { key: 'Escape' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Parent' })).toHaveValue('Acme'));
    expect(screen.getByRole('combobox', { name: 'Parent' })).toHaveFocus();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(applied).toEqual([]);
    expect(stagedValue('name')).toBe('Other staged field');
  });

  test('a second field picker is frozen through pending acknowledgement without losing its focus', async () => {
    model.mode = 'blur';
    model.target = customer;
    const user = userEvent.setup();
    let resolve!: (value: unknown) => void;
    model.reply = () =>
      new Promise((done) => {
        resolve = done;
      });
    const table = {
      ...textTable,
      columns: [...textTable.columns, col('parent', 'INTEGER', { references: { table: 'customer', column: 'id' } })],
    };
    drawApp(table, { ...textRow, parent: 1 });
    await user.type(screen.getByLabelText('Name'), ' Ltd');
    const picker = screen.getByRole('combobox', { name: 'Parent' });
    await user.click(picker);
    await flush();
    expect(applied).toHaveLength(1);
    expect(picker).toHaveFocus();
    expect(picker).toHaveAttribute('readonly');
    const popup = document.querySelector<HTMLElement>('.picker-popup');
    if (popup) expect(popup.inert).toBe(true);
    await user.type(picker, 'Accidental');
    expect(stagedValue('parent')).toBeUndefined();
    await act(async () => resolve({ affected: 1, applied: { name: 'Acme Ltd' } }));
    expect(picker).toHaveFocus();
    expect(picker).not.toHaveAttribute('readonly');
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toHaveLength(1);
  });

  test.each(['dropdown', 'picker'])('keyboard %s selection waits for Tab to leave its complete field', async (kind) => {
    model.mode = 'blur';
    model.target = customer;
    const user = userEvent.setup();
    const column =
      kind === 'picker'
        ? col('choice', 'INTEGER', { references: { table: 'customer', column: 'id' } })
        : col('choice', 'TEXT', { allowed: ['open', 'done'], nullable: false });
    const table = { ...textTable, columns: [textTable.columns[0], column, textTable.columns[2]] };
    drawApp(table, { id: 4, choice: kind === 'picker' ? 1 : 'open', notes: 'Memo' });
    const control = screen.getByRole(kind === 'picker' ? 'combobox' : 'button', { name: 'Choice' });
    if (kind === 'picker') await waitFor(() => expect(control).toHaveValue('Acme'));
    await user.click(control);
    await screen.findAllByRole('option');
    await user.keyboard(kind === 'picker' ? '{ArrowDown}{ArrowDown}{Enter}' : '{End}{Enter}');
    await flush();
    expect(applied).toEqual([]);
    expect(stagedValue('choice')).toBe(kind === 'picker' ? '2' : 'done');
    // Clear remains part of the picker; Tab may visit it before the next field.
    await user.tab();
    if (document.activeElement !== screen.getByLabelText('Notes')) await user.tab();
    await flush();
    expect(applied).toHaveLength(1);
  });

  test('clearing a required reference blocks every staged field with one associated error', async () => {
    model.mode = 'blur';
    model.target = customer;
    const user = userEvent.setup();
    const table = {
      ...textTable,
      columns: [...textTable.columns, col('parent', 'INTEGER', { nullable: false, references: { table: 'customer', column: 'id' } })],
    };
    drawApp(table, { ...textRow, parent: 1 });
    act(() => stage(table, key, table.columns[1], 'Other staged field', 'Acme'));
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await user.click(screen.getByLabelText('Notes'));
    await flush();
    expect(applied).toEqual([]);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('combobox', { name: 'Parent' })).toHaveAccessibleDescription('Required');
  });
});

describe('a change from elsewhere under a draft', () => {
  test("a room's docked draft says it at the record, not in the dock at the window's foot", async () => {
    const { raiseEditNotice, liveKeyText, resetLiveState } = await import('../liveState.js');
    drawApp();
    act(() => stage(customer, key, customer.columns[1], 'Typed', 'Acme'));
    act(() => raiseEditNotice({ table: 'customer', key: liveKeyText(key), kind: 'update', self: false }));
    const sentence = await screen.findByText(/changed this customer/);
    const notice = sentence.closest('.live-notice')!;
    expect(notice).toHaveClass('is-anchored');
    expect(notice.closest('.pending-dock')).toBeNull();
    expect(document.querySelector('.pending-dock')).toHaveTextContent('1 unsaved change');
    act(() => resetLiveState());
  });
});
