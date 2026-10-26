import { afterEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render as renderDom, screen, waitFor, within } from '@testing-library/react';
import { fixtureHost, fixtures, SectionFrame } from '../sdk/fixture.js';
import { ConsolePanel } from './ConsoleRoom.js';
import { needsCleanup } from './FlagTable.js';
import type { ConsoleRequest, FlagRow } from './model.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const host = fixtureHost(fixtures({}), {}, [], []);
const render = (children: ReactNode) =>
  renderDom(children, {
    wrapper: ({ children }) => (
      <SectionFrame host={host} id="console-controls" width={1100}>
        {children}
      </SectionFrame>
    ),
  });
const old = new Date(Date.now() - 40 * 86_400_000).toISOString(),
  recent = new Date(Date.now() - 2 * 3_600_000).toISOString();
const rows: FlagRow[] = [
  {
    id: 'h/finder',
    flagId: 'finder',
    revision: 3,
    actions: ['view', 'manage', 'kill'],
    owner: 'discovery',
    disabled: false,
    rollout: 25,
    kind: 'boolean',
    changedAt: recent,
  },
  { id: 'h/layout', flagId: 'layout', revision: 1, actions: ['view'], disabled: false, rollout: 100, kind: 'variant', changedAt: old },
  {
    id: 'h/pricing',
    flagId: 'pricing',
    revision: 5,
    actions: ['view', 'manage', 'kill'],
    disabled: true,
    rollout: 100,
    kind: 'experiment',
    changedAt: recent,
  },
];

function flags(kill = vi.fn((_body?: unknown) => ({ revision: 4 }))) {
  return vi.fn(async (path: string, body?: unknown) => {
    if (path.startsWith('/catalog'))
      return { targets: [{ id: 'app', name: 'Discovery', environment: 'production', scopes: [{ id: 'scope', label: 'Default' }] }] };
    if (path.startsWith('/scopes/')) return { environment: 'production', items: rows };
    if (path.endsWith('/kill')) return kill(body);
    throw new Error(`unexpected ${path}`);
  });
}

test('the views count the scope and filter the table to what they name, beside the kind chips', async () => {
  render(
    <ConsolePanel request={flags() as ConsoleRequest} scopeId="scope" selectTarget={vi.fn()} selectScope={vi.fn()} selectFlag={vi.fn()} />,
  );
  const views = await screen.findByRole('radiogroup', { name: 'Show flags' });
  expect(
    within(views)
      .getAllByRole('radio')
      .map((view) => view.textContent),
  ).toEqual(['All3', 'On2', 'Off1', 'Rolling out1', 'Needs cleanup1']);
  fireEvent.click(within(views).getByRole('radio', { name: /Needs cleanup/ }));
  expect(screen.getByText('1 of 3')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'layout' })).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('group', { name: 'Kind' })).getByRole('button', { name: 'Experiment' }));
  expect(screen.getByText('No flag matches these filters.')).toBeInTheDocument();
  fireEvent.click(within(views).getByRole('radio', { name: /All/ }));
  fireEvent.click(within(screen.getByRole('group', { name: 'Kind' })).getByRole('button', { name: 'Experiment' }));
  expect(screen.getByText('3 of 3')).toBeInTheDocument();
});

test('one scope is opened without asking, and the address is replaced rather than pushed', async () => {
  const selectScope = vi.fn();
  render(<ConsolePanel request={flags() as ConsoleRequest} selectTarget={vi.fn()} selectScope={selectScope} selectFlag={vi.fn()} />);
  await waitFor(() => expect(selectScope).toHaveBeenCalledWith('scope', true));
  expect(selectScope).toHaveBeenCalledTimes(1);
});

test('several scopes are offered as a choice, and the room waits for it', async () => {
  const selectScope = vi.fn();
  const request = vi.fn(async (path: string) =>
    path.startsWith('/catalog')
      ? {
          targets: [
            {
              id: 'app',
              name: 'Discovery',
              environment: 'production',
              scopes: [
                { id: 'global', label: 'Global' },
                { id: 'acme', label: 'Tenant acme' },
              ],
            },
          ],
        }
      : { environment: 'production', items: rows },
  );
  render(<ConsolePanel request={request as ConsoleRequest} selectTarget={vi.fn()} selectScope={selectScope} selectFlag={vi.fn()} />);
  const choice = await screen.findByRole('region', { name: 'Choose a scope' });
  expect(selectScope).not.toHaveBeenCalled();
  fireEvent.click(within(choice).getByRole('button', { name: /Tenant acme/ }));
  expect(selectScope).toHaveBeenCalledWith('acme');
});

test('with several scopes the list shows each flag’s state in every scope, the open one first', async () => {
  const request = vi.fn(async (path: string) =>
    path.startsWith('/catalog')
      ? {
          targets: [
            {
              id: 'app',
              name: 'Discovery',
              environment: 'production',
              scopes: [
                { id: 'global', label: 'Global' },
                { id: 'acme', label: 'Tenant acme' },
              ],
            },
          ],
        }
      : path.startsWith('/scopes/acme/')
        ? { environment: 'production', items: rows.map((row) => ({ ...row, id: `acme/${row.flagId}`, disabled: true })) }
        : { environment: 'production', items: rows },
  );
  render(
    <ConsolePanel request={request as ConsoleRequest} scopeId="global" selectTarget={vi.fn()} selectScope={vi.fn()} selectFlag={vi.fn()} />,
  );
  expect(await screen.findByRole('columnheader', { name: 'Global' })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: 'Tenant acme' })).toBeInTheDocument();
  await waitFor(() => expect(within(screen.getByRole('row', { name: /^finder/ })).getAllByText('Off').length).toBeGreaterThan(0));
});

test('⌘K opens the jump box over the room, and Enter opens the flag it found', async () => {
  const selectFlag = vi.fn();
  render(
    <ConsolePanel
      request={flags() as ConsoleRequest}
      scopeId="scope"
      selectTarget={vi.fn()}
      selectScope={vi.fn()}
      selectFlag={selectFlag}
    />,
  );
  await screen.findByRole('button', { name: 'finder' });
  fireEvent.keyDown(window, { key: 'k', metaKey: true });
  const box = await screen.findByRole('combobox', { name: 'Jump to anything in the Console' });
  fireEvent.change(box, { target: { value: 'pric' } });
  const options = within(screen.getByRole('listbox', { name: 'Results' })).getAllByRole('option');
  expect(options[0]).toHaveTextContent('pricing');
  expect(options[0]).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(selectFlag).toHaveBeenCalledWith('h/pricing');
  await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Jump to anything in the Console' })).toBeNull());
});

test('j and k walk the list, and typing in the search is never taken for a key', async () => {
  render(
    <ConsolePanel request={flags() as ConsoleRequest} scopeId="scope" selectTarget={vi.fn()} selectScope={vi.fn()} selectFlag={vi.fn()} />,
  );
  await screen.findByRole('button', { name: 'finder' });
  fireEvent.keyDown(document.body, { key: 'j' });
  expect(screen.getByRole('button', { name: 'finder' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'j' });
  expect(screen.getByRole('button', { name: 'layout' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'k' });
  expect(screen.getByRole('button', { name: 'finder' })).toHaveFocus();
  const search = screen.getByRole('searchbox', { name: 'Search flags' });
  search.focus();
  fireEvent.keyDown(search, { key: 'j' });
  expect(search).toHaveFocus();
});

test('the row switch asks for a reason and turns a flag off with the revision it read', async () => {
  const kill = vi.fn((_body?: unknown) => ({ revision: 4 }));
  const request = flags(kill);
  render(
    <ConsolePanel request={request as ConsoleRequest} scopeId="scope" selectTarget={vi.fn()} selectScope={vi.fn()} selectFlag={vi.fn()} />,
  );
  // Read-only grants see the status, not a switch.
  await screen.findByRole('button', { name: 'layout' });
  expect(screen.queryByRole('switch', { name: /layout/ })).toBeNull();
  fireEvent.click(screen.getByRole('switch', { name: 'Turn finder off' }));
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Give a reason');
  expect(kill).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), { target: { value: 'Checkout errors' } });
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
  await screen.findByText('finder is off, recorded at revision 4.');
  expect(kill).toHaveBeenCalledWith({ expectedRevision: 3, reason: 'Checkout errors' });
  await waitFor(() => expect(request.mock.calls.filter(([path]) => path.startsWith('/scopes/')).length).toBe(2));
});

test('a flag needs cleanup only when settled and dated', () => {
  expect(needsCleanup(rows[1])).toBe(true);
  expect(needsCleanup(rows[2])).toBe(false);
  expect(needsCleanup({ ...rows[1], changedAt: undefined })).toBe(false);
  expect(needsCleanup({ ...rows[0], changedAt: old })).toBe(false);
});
