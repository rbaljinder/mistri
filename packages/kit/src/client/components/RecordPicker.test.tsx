import { afterEach, expect, test, vi, beforeEach } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRef, useState } from 'react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import type { RecordPickerEditing, RecordPickerProps } from './RecordPicker.js';
import { establishSessionIdentity } from '../sessionIdentity.js';

const connection = vi.hoisted(() => ({ activeConnection: 'demo' }));
const defaultApi = async (path: string, _body?: unknown) => ({
  rows: path === '/api/query' ? [{ sku: 'A-1', name: 'Current product' }] : [{ sku: 'B-2', name: 'Next product' }],
});
const api = vi.fn(defaultApi);
vi.mock('../core.js', () => ({
  api: (...args: [string, unknown]) => api(...args),
  state: connection,
  labelPath: () => 'name',
  recordLabel: () => undefined,
  rowLabel: (_table: TableMeta, row: Record<string, unknown>) => String(row.name ?? row.id),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
const app = vi.hoisted(() => ({ current: null as null | { resources: Record<string, { noun: { one: string; many: string } }> } }));
vi.mock('../../../../mistri/src/client/appState.js', () => ({ activeApp: () => app.current, inAppMode: () => Boolean(app.current) }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
const { RecordPicker } = await import('./RecordPicker.js');
const table: TableMeta = {
  id: 'product',
  name: 'product',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'sku', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
  ],
};
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  api.mockReset().mockImplementation(defaultApi);
  connection.activeConnection = 'demo';
});

test("in an App the search placeholder speaks the resource's noun, not the table's name", () => {
  app.current = { resources: { product: { noun: { one: 'Item', many: 'Items' } } } };
  try {
    const { input } = picker({ app: true });
    expect(input).toHaveAttribute('placeholder', 'Search item…');
  } finally {
    app.current = null;
  }
});

test('an invalid field says so on its box, as every other input does, and a valid one does not', () => {
  const wrong = picker({ invalid: true, describedBy: 'why' });
  expect(wrong.input).toHaveAttribute('aria-invalid', 'true');
  expect(wrong.input).toHaveAttribute('aria-describedby', 'why');
  cleanup();
  const fine = picker();
  expect(fine.input).not.toHaveAttribute('aria-invalid');
  expect(fine.input).not.toHaveAttribute('aria-describedby');
});

function picker(props: Partial<Extract<RecordPickerProps, { multiple?: false }>> = {}) {
  const { value: initialValue = 'A-1', ...overrides } = props;
  const changes = vi.fn();
  const states = vi.fn<RecordPickerEditing['onStateChange']>();
  const cancel = vi.fn();
  const parentEscape = vi.fn();
  const submit = vi.fn();
  const popupRef = createRef<HTMLDivElement>();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  function Form() {
    const [value, setValue] = useState(initialValue);
    // A real parent stores these callbacks in state; reporting must not loop
    // merely because its inline callback is replaced on the resulting render.
    const [status, setStatus] = useState({ unresolvedReference: false, open: false });
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') parentEscape(e.defaultPrevented);
        }}
      >
        <RecordPicker
          table={table}
          valueColumn="sku"
          value={value}
          onChange={(next) => {
            changes(next);
            setValue(next);
          }}
          ariaLabel="Product"
          editing={{
            onStateChange: (next) => {
              states(next);
              setStatus(next);
            },
            onCancel: cancel,
            popupRef,
          }}
          {...overrides}
        />
        <output>
          {status.unresolvedReference ? 'Unresolved' : 'Resolved'} / {status.open ? 'Open' : 'Closed'}
        </output>
        <button type="button">Outside</button>
      </form>
    );
  }
  const view = render(
    <QueryClientProvider client={client}>
      <Form />
    </QueryClientProvider>,
  );
  return {
    ...view,
    changes,
    states,
    cancel,
    parentEscape,
    submit,
    popupRef,
    client,
    input: screen.getByRole('combobox', { name: 'Product' }),
    user: userEvent.setup(),
  };
}

test('hydrates a natural-key preset, preserves typing, and restores the name after discard', async () => {
  const user = userEvent.setup();
  const changes = vi.fn();
  function Form() {
    const [value, setValue] = useState('A-1');
    return (
      <>
        <RecordPicker
          table={table}
          valueColumn="sku"
          value={value}
          onChange={(next) => {
            changes(next);
            setValue(next);
          }}
          ariaLabel="Product"
          app
        />
        <button onClick={() => setValue('A-1')}>Discard</button>
      </>
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Form />
    </QueryClientProvider>,
  );
  const input = screen.getByRole('combobox', { name: 'Product' });
  await waitFor(() => expect(input).toHaveValue('Current product'));
  expect(api).toHaveBeenCalledWith(
    '/api/query',
    expect.objectContaining({
      conn: 'demo',
      columns: ['sku', 'name', 'id'],
      filter: { groups: [[{ column: 'sku', op: 'in', value: ['A-1'] }]] },
    }),
  );
  await user.clear(input);
  await user.type(input, 'Next');
  expect(input).toHaveValue('Next');
  await user.click(await screen.findByRole('option', { name: /Next product/ }));
  expect(input).toHaveValue('Next product');
  expect(changes.mock.calls).toEqual([[''], ['B-2']]);
  await user.click(screen.getByRole('button', { name: 'Discard' }));
  await waitFor(() => expect(input).toHaveValue('Current product'));
  client.clear();
});

test("a name the caller already draws is the box's from the first paint, never the bare key", () => {
  // The label request never answers: whatever the box says, it says without it.
  api.mockImplementation(() => new Promise(() => {}));
  const { input } = picker({ known: { value: 'A-1', label: 'Current product' } });
  expect(input).toHaveValue('Current product');
  cleanup();
  const bare = picker();
  expect(bare.input).toHaveValue('A-1');
});

test('an empty picker does not request preset labels', () => {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <RecordPicker table={table} value="" onChange={() => {}} />
    </QueryClientProvider>,
  );
  expect(api).not.toHaveBeenCalled();
  client.clear();
});

test.each(['pointer', 'keyboard'] as const)('editing search only changes the selected ID on a %s pick', async (method) => {
  const { input, user, changes, states, submit, popupRef } = picker();
  await waitFor(() => expect(input).toHaveValue('Current product'));
  expect(states).toHaveBeenLastCalledWith({ unresolvedReference: false, open: false });
  await user.clear(input);
  await user.type(input, 'Next');
  const option = await screen.findByRole('option', { name: /Next product/ });
  expect(changes).not.toHaveBeenCalled();
  expect(states).toHaveBeenLastCalledWith({ unresolvedReference: true, open: true });
  expect(popupRef.current).toHaveClass('picker-popup');
  expect(popupRef.current).toContainElement(option);
  expect(input.closest('.picker')).not.toContainElement(popupRef.current);
  if (method === 'pointer') await user.click(option);
  else await user.keyboard('{ArrowDown}{Enter}');
  expect(changes.mock.calls).toEqual([['B-2']]);
  expect(input).toHaveValue('Next product');
  expect(states).toHaveBeenLastCalledWith({ unresolvedReference: false, open: false });
  expect(submit).not.toHaveBeenCalled();
  await user.click(screen.getByText('Outside'));
  expect(input).toHaveValue('Next product');
});

test('editing keeps unresolved search visible on blur although the selected ID is unchanged', async () => {
  const { input, user, changes, states } = picker();
  await waitFor(() => expect(input).toHaveValue('Current product'));
  await user.clear(input);
  await user.type(input, 'Unchosen replacement');
  await user.click(screen.getByText('Outside'));
  expect(input).toHaveValue('Unchosen replacement');
  expect(states).toHaveBeenLastCalledWith({ unresolvedReference: true, open: false });
  expect(changes).not.toHaveBeenCalled();
  await user.click(input);
  await user.keyboard('{Escape}');
  expect(input).toHaveValue('Current product');
  expect(states).toHaveBeenLastCalledWith({ unresolvedReference: false, open: false });
  expect(changes).not.toHaveBeenCalled();
});

test.each(['A-1', ''])('editing requires intentional Clear to resolve empty search for preset %j', async (value) => {
  const { input, user, changes, states } = picker({ value });
  if (value) await waitFor(() => expect(input).toHaveValue('Current product'));
  await user.type(input, 'Replacement');
  await user.clear(input);
  await user.tab();
  expect(input).toHaveValue('');
  expect(states).toHaveBeenLastCalledWith({ unresolvedReference: true, open: false });
  expect(changes).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Clear' }));
  expect(changes.mock.calls).toEqual([['']]);
  expect(input).toHaveValue('');
  expect(states.mock.calls.at(-1)?.[0].unresolvedReference).toBe(false);
});

test('open-popup Escape cancels only the picker; closed-popup Escape bubbles without changing selection', async () => {
  const { input, user, changes, states, cancel, parentEscape } = picker();
  await waitFor(() => expect(input).toHaveValue('Current product'));
  await user.clear(input);
  await user.type(input, 'Next');
  await screen.findByRole('option');
  await user.keyboard('{Escape}');
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(parentEscape).not.toHaveBeenCalled();
  expect(changes).not.toHaveBeenCalled();
  expect(input).toHaveValue('Current product');
  expect(states).toHaveBeenLastCalledWith({ unresolvedReference: false, open: false });
  await waitFor(() => expect(screen.queryByRole('option')).not.toBeInTheDocument());
  await user.keyboard('{Escape}');
  expect(parentEscape).toHaveBeenCalledExactlyOnceWith(false);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(changes).not.toHaveBeenCalled();
  expect(input).toHaveValue('Current product');
  expect(states).toHaveBeenLastCalledWith({ unresolvedReference: false, open: false });
});

test('Escape from the portalled popup cancels only the picker interaction', async () => {
  const { input, user, changes, cancel, parentEscape, popupRef, states } = picker();
  await waitFor(() => expect(input).toHaveValue('Current product'));
  await user.type(input, 'replacement');
  await screen.findByRole('option');
  await act(async () => {
    popupRef.current?.focus();
  });
  expect(states).toHaveBeenLastCalledWith({ unresolvedReference: true, open: true });
  await user.keyboard('{Escape}');
  expect(changes).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(parentEscape).not.toHaveBeenCalled();
  expect(input).toHaveValue('Current product');
  expect(states).toHaveBeenLastCalledWith({ unresolvedReference: false, open: false });
});

test('late preset hydration preserves unresolved text and supplies the label when Escape cancels it', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof defaultApi>>) => void;
  api.mockImplementation((path) =>
    path === '/api/query'
      ? new Promise((done) => {
          resolve = done;
        })
      : defaultApi(path),
  );
  const { input, user, changes, states } = picker();
  expect(input).toHaveValue('A-1');
  await user.clear(input);
  await user.type(input, 'Unchosen');
  await user.click(screen.getByText('Outside'));
  await act(async () => {
    resolve({ rows: [{ sku: 'A-1', name: 'Hydrated product' }] });
  });
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/query', expect.anything()));
  expect(input).toHaveValue('Unchosen');
  expect(states).toHaveBeenLastCalledWith({ unresolvedReference: true, open: false });
  await user.click(input);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(input).toHaveValue('Hydrated product'));
  expect(changes).not.toHaveBeenCalled();
});

test('label hydration updates an untouched editing picker while its popup is open', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof defaultApi>>) => void;
  api.mockImplementation((path) =>
    path === '/api/query'
      ? new Promise((done) => {
          resolve = done;
        })
      : defaultApi(path),
  );
  const { input, user, changes, states } = picker();
  await user.click(input);
  await act(async () => {
    resolve({ rows: [{ sku: 'A-1', name: 'Hydrated product' }] });
  });
  await waitFor(() => expect(input).toHaveValue('Hydrated product'));
  expect(states).toHaveBeenLastCalledWith({ unresolvedReference: false, open: true });
  expect(changes).not.toHaveBeenCalled();
});

test.each(['account', 'connection', 'table', 'column', 'value'] as const)(
  '%s replacement retires unresolved search and late labels/results',
  async (replacement) => {
    const pending: Array<(value: Awaited<ReturnType<typeof defaultApi>>) => void> = [];
    api.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    const changes = vi.fn();
    const states = vi.fn();
    let props: RecordPickerProps = {
      table,
      valueColumn: 'sku',
      value: 'A-1',
      onChange: changes,
      ariaLabel: 'Product',
      editing: { onStateChange: states },
    };
    const draw = () => (
      <QueryClientProvider client={client}>
        <RecordPicker {...props} />
      </QueryClientProvider>
    );
    const view = render(draw());
    const user = userEvent.setup();
    const input = screen.getByRole('combobox');
    await user.clear(input);
    await user.type(input, 'Private search');
    const oldRequests = pending.splice(0);
    api.mockImplementation(async () => ({ rows: [] }));
    if (replacement === 'account')
      act(() => {
        establishSessionIdentity({ signedIn: true, accountId: 'replacement', appId: 'app' });
      });
    if (replacement === 'connection') connection.activeConnection = 'replacement';
    if (replacement === 'table') props = { ...props, table: { ...table, id: 'replacement' } };
    if (replacement === 'column') props = { ...props, valueColumn: 'id' };
    if (replacement === 'value') props = { ...props, value: 'B-2' };
    view.rerender(draw());
    const current = screen.getByRole('combobox');
    expect(current).toHaveValue(replacement === 'value' ? 'B-2' : 'A-1');
    expect(states).toHaveBeenLastCalledWith({ unresolvedReference: false, open: false });
    states.mockClear();
    api.mockClear();
    await act(async () => {
      for (const resolve of oldRequests) resolve({ rows: [{ sku: 'A-1', name: 'Private label' }] });
    });
    await user.click(current);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/api/run',
        expect.objectContaining({
          q: expect.stringContaining(`contains "${replacement === 'value' ? 'B-2' : 'A-1'}"`),
        }),
      ),
    );
    expect(api.mock.calls.some(([path, body]) => path === '/api/run' && JSON.stringify(body).includes('Private search'))).toBe(false);
    expect(current).toHaveValue(replacement === 'value' ? 'B-2' : 'A-1');
    expect(screen.queryByText('Private label')).not.toBeInTheDocument();
    expect(states.mock.calls.every(([state]) => !state.unresolvedReference)).toBe(true);
    expect(changes).not.toHaveBeenCalled();
    if (replacement === 'value') expect(current).toBe(input);
  },
);

test('multiple picker keeps search, toggle, chip Backspace and Clear semantics', async () => {
  const changes = vi.fn();
  function Form() {
    const [value, setValue] = useState(['A-1']);
    return (
      <RecordPicker
        multiple
        table={table}
        valueColumn="sku"
        value={value}
        onChange={(next) => {
          changes(next);
          setValue(next);
        }}
        ariaLabel="Products"
      />
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <Form />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  const input = screen.getByRole('combobox');
  await screen.findByRole('button', { name: 'Remove Current product' });
  await user.type(input, 'Next');
  expect(changes).not.toHaveBeenCalled();
  await user.click(await screen.findByRole('option', { name: /Next product/ }));
  expect(input).toHaveValue('');
  expect(changes).toHaveBeenLastCalledWith(['A-1', 'B-2']);
  await user.click(input);
  await user.click(await screen.findByRole('option', { name: /Next product/ }));
  expect(changes).toHaveBeenLastCalledWith(['A-1']);
  await user.click(input);
  await user.keyboard('{Backspace}');
  expect(changes).toHaveBeenLastCalledWith([]);
  await user.click(screen.getByRole('option', { name: /Next product/ }));
  await user.click(screen.getByLabelText('Clear'));
  expect(changes.mock.calls).toEqual([[['A-1', 'B-2']], [['A-1']], [[]], [['B-2']], [[]]]);
});

test('until the answer for the typed name lands, the list offers only rows that name describes', async () => {
  /* The search waits for a pause in typing and then a request; the list on
     screen until then answers earlier text. Its first row is lit, so a quick
     Enter or click chose a record the box never named — on CI, the empty
     search's first issue took the new comment. */
  const answers = new Map<string, (value: Awaited<ReturnType<typeof defaultApi>>) => void>();
  api.mockImplementation(async (_path, body) => {
    const q = String((body as { q?: string }).q ?? '');
    const asked = /contains "([^"]*)"/.exec(q)?.[1];
    if (asked !== undefined)
      return new Promise((resolve) => {
        answers.set(asked, resolve);
      });
    return {
      rows: [
        { sku: 'A-3', name: 'Ari Patel' },
        { sku: 'M-1', name: 'Maya Chen' },
        { sku: 'N-5', name: 'Noor Ali' },
      ],
    };
  });
  const changes = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <RecordPicker table={table} valueColumn="sku" value="" onChange={changes} ariaLabel="Member" app />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  const input = screen.getByRole('combobox', { name: 'Member' });
  await user.type(input, 'maya');
  await waitFor(() => expect(answers.has('maya')).toBe(true));
  // Case-insensitive, as the server's `contains` is.
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([expect.stringContaining('Maya Chen')]);
  await user.keyboard('{Enter}');
  expect(changes.mock.calls).toEqual([['M-1']]);
  await user.clear(input);
  await user.type(input, 'zed');
  await waitFor(() => expect(answers.has('zed')).toBe(true));
  expect(screen.queryAllByRole('option')).toEqual([]);
  // No row matches yet, but the answer is still coming: not "Nothing matches.".
  expect(screen.queryByText('Nothing matches.')).not.toBeInTheDocument();
  await act(async () => {
    answers.get('zed')!({ rows: [] });
  });
  expect(await screen.findByText('Nothing matches.')).toBeInTheDocument();
});

test('hideKey leaves the key off each choice, where the name is the whole of the record', async () => {
  const user = userEvent.setup();
  for (const hideKey of [false, true]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    render(
      <QueryClientProvider client={client}>
        <RecordPicker table={table} valueColumn="sku" value="" onChange={vi.fn()} ariaLabel="Product" hideKey={hideKey} />
      </QueryClientProvider>,
    );
    await user.type(screen.getByRole('combobox'), 'Next');
    const option = await screen.findByRole('option', { name: /Next product/ });
    expect(option.querySelector('.picker-option-detail')?.textContent ?? null).toBe(hideKey ? null : 'B-2');
    cleanup();
  }
});
