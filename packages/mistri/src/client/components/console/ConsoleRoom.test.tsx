import { afterEach, expect, test, vi } from 'vitest';
import { useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render as renderDom, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { fixtureHost, fixtures, SectionFrame } from '../sdk/fixture.js';
import { UiPageContext } from '../sdk/context.js';
import ConsoleRoom, { ConsolePanel, FlagRecord } from './ConsoleRoom.js';
import { ExperimentResults } from './ExperimentResults.js';
import { computeExperimentStatistics } from '../../../server/experiments/statistics.js';
import type { ExperimentResult } from '../../../server/experiments/contracts.js';
import { ConsoleFailure, consoleRequest, editedValue, type ConsoleRequest, type FlagDetail } from './model.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const host = fixtureHost(fixtures({}), {}, [], []);
const render = (children: ReactNode) =>
  renderDom(children, {
    wrapper: ({ children }) => (
      <SectionFrame host={host} id="console-controls" width={960}>
        {children}
      </SectionFrame>
    ),
  });
const detail: FlagDetail = {
  id: 'flag',
  flagId: 'finder',
  revision: 3,
  environment: 'production',
  type: 'string',
  actions: ['view', 'manage'],
  value: 'old',
  owner: 'discovery',
  resultsAvailable: false,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function flagListRequest() {
  return vi.fn(async (path: string) =>
    path.startsWith('/catalog')
      ? {
          targets: [
            {
              id: 'app',
              name: 'Discovery',
              environment: 'production',
              scopes: [
                { id: 'scope', label: 'Default' },
                { id: 'other', label: 'Other' },
              ],
            },
          ],
        }
      : path.startsWith('/scopes/')
        ? {
            environment: 'production',
            items: [
              { id: 'opaque/finder', flagId: 'finder', revision: 3, actions: ['view', 'manage'] },
              { id: 'opaque/checkout', flagId: 'checkout', revision: 7, actions: ['kill'] },
            ],
          }
        : { ...detail, actions: ['view'] },
  );
}

test('flag list searches names locally, reports counts and recovers from no results', async () => {
  const request = flagListRequest();
  render(
    <ConsolePanel request={request as ConsoleRequest} scopeId="scope" selectTarget={vi.fn()} selectScope={vi.fn()} selectFlag={vi.fn()} />,
  );
  const search = await screen.findByRole('searchbox', { name: 'Search flags' });
  expect(screen.getByText('2 of 2')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'checkout' })).toHaveAttribute('aria-pressed', 'false');
  // Access reads in the status cell: a kill-only grant that cannot read the flag may still turn it off; no revision in the list.
  expect(screen.getByRole('row', { name: /checkout/ })).toHaveTextContent('Can turn off only');
  expect(screen.queryByText(/Revision/)).toBeNull();
  // Searching is local: it asks for nothing new. A slow runner may still refetch what the list already read, so compare the paths, not the count.
  // The other scope's states are asked in an effect that can run after the search box paints; take what was read once that read is out too.
  await waitFor(() => expect(request).toHaveBeenCalledWith('/scopes/other/flags', undefined, expect.any(AbortSignal)));
  const read = new Set(request.mock.calls.map(([path]) => path));
  fireEvent.change(search, { target: { value: ' FIND ' } });
  expect(screen.getByText('1 of 2')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'finder' })).toBeInTheDocument();
  expect(screen.getByRole('row', { name: /finder/ })).not.toHaveTextContent('Can turn off only');
  expect(screen.queryByRole('button', { name: 'checkout' })).toBeNull();
  fireEvent.change(search, { target: { value: 'missing' } });
  expect(screen.getByText('No flags match your search.')).toBeInTheDocument();
  expect(screen.getByText('0 of 2')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  expect(search).toHaveValue('');
  expect(screen.getByText('2 of 2')).toBeInTheDocument();
  expect(request.mock.calls.map(([path]) => path).filter((path) => !read.has(path) || path.startsWith('/flags/'))).toEqual([]);
});

test('flag buttons support keyboard selection using opaque handles and preserve the list refresh model', async () => {
  const user = userEvent.setup(),
    request = flagListRequest(),
    selectFlag = vi.fn();
  const props = { request: request as ConsoleRequest, scopeId: 'scope', selectTarget: vi.fn(), selectScope: vi.fn(), selectFlag };
  const mounted = render(<ConsolePanel {...props} />);
  const search = await screen.findByRole('searchbox', { name: 'Search flags' });
  fireEvent.change(search, { target: { value: 'finder' } });
  search.focus();
  await user.tab(); // Clear search.
  await user.tab();
  expect(screen.getByRole('button', { name: 'finder' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(selectFlag).toHaveBeenCalledWith('opaque/finder');
  mounted.rerender(<ConsolePanel {...props} flagId="opaque/finder" />);
  expect(await screen.findByRole('button', { name: 'finder' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('searchbox', { name: 'Search flags' })).toHaveValue('finder');
  await screen.findByText('Read-only access.');
  expect(request).toHaveBeenCalledWith('/scopes/scope/flags?flag=opaque%2Ffinder', undefined, expect.any(AbortSignal));
  expect(request).toHaveBeenCalledWith('/flags/opaque%2Ffinder', undefined, expect.any(AbortSignal));
  fireEvent.click(screen.getByRole('button', { name: 'Close finder' }));
  expect(selectFlag).toHaveBeenLastCalledWith(undefined);
});

test('flag search resets when scope or account request changes', async () => {
  const request = flagListRequest(),
    props = { selectTarget: vi.fn(), selectScope: vi.fn(), selectFlag: vi.fn() };
  const mounted = render(<ConsolePanel {...props} request={request as ConsoleRequest} scopeId="scope" />);
  fireEvent.change(await screen.findByRole('searchbox', { name: 'Search flags' }), { target: { value: 'finder' } });
  mounted.rerender(<ConsolePanel {...props} request={request as ConsoleRequest} scopeId="other" />);
  expect(await screen.findByRole('searchbox', { name: 'Search flags' })).toHaveValue('');
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search flags' }), { target: { value: 'checkout' } });
  mounted.rerender(<ConsolePanel {...props} request={flagListRequest() as ConsoleRequest} scopeId="other" />);
  expect(await screen.findByRole('searchbox', { name: 'Search flags' })).toHaveValue('');
  expect(screen.getByText('2 of 2')).toBeInTheDocument();
});

test('read-only mode has record/history navigation and no mutation form', async () => {
  const request = vi.fn(async (path: string) =>
    path.endsWith('/history') ? { entries: [], nextBeforeRevision: null } : { ...detail, actions: ['view'] },
  );
  render(<FlagRecord request={request as ConsoleRequest} id="flag" />);
  expect(await screen.findByText('Read-only access.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Apply change' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'History' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/flags/flag/history', undefined, expect.any(AbortSignal)));
});

test('record tabs support arrow, Home and End navigation and show the scalar value directly', async () => {
  const user = userEvent.setup();
  const request = vi.fn(async (path: string) =>
    path.endsWith('/history') ? { entries: [], nextBeforeRevision: null } : { ...detail, actions: ['view'] },
  );
  render(<FlagRecord request={request as ConsoleRequest} id="flag" />);
  const record = await screen.findByRole('tab', { name: 'Targeting' });
  expect(screen.getByText('old')).toBeInTheDocument();
  expect(screen.queryByText('controlValue')).toBeNull();
  record.focus();
  await user.keyboard('{ArrowRight}');
  expect(screen.getByRole('tab', { name: 'History' })).toHaveFocus();
  expect(screen.getByRole('tabpanel', { name: 'History' })).toBeInTheDocument();
  await user.keyboard('{Home}');
  expect(record).toHaveFocus();
  expect(record).toHaveAttribute('aria-selected', 'true');
  await user.keyboard('{End}{ArrowRight}');
  expect(record).toHaveFocus();
  expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('tabindex', '-1');
});

test('the scope dropdown supports keyboard selection and clears the selected flag', async () => {
  const user = userEvent.setup(),
    selectScope = vi.fn(),
    selectFlag = vi.fn();
  render(
    <ConsolePanel
      request={flagListRequest() as ConsoleRequest}
      scopeId="scope"
      selectTarget={vi.fn()}
      selectScope={selectScope}
      selectFlag={selectFlag}
    />,
  );
  const scope = await screen.findByRole('button', { name: 'Scope' });
  await user.click(scope);
  expect(await screen.findByRole('listbox', { name: 'Scope' })).toBeInTheDocument();
  await user.keyboard('{End}{Enter}');
  expect(selectScope).toHaveBeenCalledWith('other');
  expect(selectFlag).toHaveBeenCalledWith(undefined);
});

test('boolean dropdown sends the exact selected value with the reviewed revision', async () => {
  const user = userEvent.setup();
  const request = vi.fn(async (_path: string, body?: unknown) =>
    body ? { revision: 4, outcome: 'applied' } : { ...detail, type: 'boolean', value: true },
  );
  render(<FlagRecord request={request as ConsoleRequest} id="flag" />);
  await user.click(await screen.findByRole('button', { name: 'Value' }));
  await user.keyboard('{End}{Enter}');
  expect(screen.getByRole('button', { name: 'Value' })).toHaveTextContent('false');
  // Nothing is sent from the editor: the edit is staged, then reviewed with a reason.
  expect(screen.getByRole('region', { name: 'Staged changes' })).toHaveTextContent('1 change staged');
  await user.click(screen.getByRole('button', { name: 'Review changes' }));
  await user.type(screen.getByLabelText('Reason'), 'pause rollout');
  await user.click(screen.getByRole('button', { name: 'Apply change' }));
  await screen.findByText(/Change applied at revision 4/);
  expect(request).toHaveBeenCalledWith('/flags/flag/set', { expectedRevision: 3, reason: 'pause rollout', override: { value: false } });
});

test('narrow detail uses the shared dialog, contains its dropdown and returns focus on close', async () => {
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    ...matchMedia(query),
    matches: query === '(max-width: 760px)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const user = userEvent.setup(),
    listRequest = flagListRequest();
  const request = vi.fn(async (path: string) =>
    path.startsWith('/flags/') ? { ...detail, type: 'boolean', value: true } : listRequest(path),
  );
  function Panel() {
    const [selected, select] = useState<string>();
    return (
      <ConsolePanel
        request={request as ConsoleRequest}
        scopeId="scope"
        flagId={selected}
        selectTarget={vi.fn()}
        selectFlag={select}
        selectScope={vi.fn()}
      />
    );
  }
  render(<Panel />);
  const flag = await screen.findByRole('button', { name: 'finder' });
  await user.click(flag);
  const dialog = await screen.findByRole('dialog', { name: 'Flag details' });
  await user.click(await screen.findByRole('button', { name: 'Value' }));
  expect(dialog).toContainElement(await screen.findByRole('listbox', { name: 'Value' }));
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  expect(screen.getAllByRole('tab', { name: 'Targeting' })).toHaveLength(1);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(screen.getByRole('button', { name: 'finder' })).toHaveFocus());
});

test('closing refines the current room address so the focus owner survives', async () => {
  const request = flagListRequest(),
    set = vi.fn(),
    address = new Map([
      ['scope', 'scope'],
      ['flag', 'opaque/finder'],
    ]);
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input) => new Response(JSON.stringify(await request(String(input).replace('/console', '')))),
  );
  const viewerHost = fixtureHost(fixtures({}), { viewer: { signedIn: true, account: 'alice' } }, [], []);
  renderDom(
    <SectionFrame host={viewerHost} id="console-controls" width={960}>
      <UiPageContext.Provider
        value={{
          view: 'targets',
          label: 'Feature flags',
          reads: [],
          commands: [],
          params: ['scope', 'flag', 'target'],
          get: (name) => address.get(name),
          set,
        }}
      >
        <ConsoleRoom props={{ endpoint: '/console' }} />
      </UiPageContext.Provider>
    </SectionFrame>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Close finder' }));
  expect(set).toHaveBeenCalledWith('flag', undefined, { push: false });
});

test('target switching survives navigation and rotating catalog handles and opens a lone scope', async () => {
  const user = userEvent.setup(),
    address = new Map([
      ['scope', 'dealer-scope'],
      ['flag', 'dealer-flag'],
    ]);
  let catalogReads = 0;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = String(input);
    if (path.includes('/catalog')) {
      const selected = new URL(path, 'http://console.test').searchParams.get('scope');
      const generation = ++catalogReads;
      return new Response(
        JSON.stringify({
          targets: [
            {
              id: `dealer-${generation}`,
              name: 'Dealer',
              environment: 'preview',
              scopes: [{ id: selected === 'dealer-scope' ? selected : `dealer-scope-${generation}`, label: 'Global' }],
            },
            {
              id: `market-${generation}`,
              name: 'Marketplace',
              environment: 'preview',
              scopes: [{ id: selected?.startsWith('market-scope-') ? selected : `market-scope-${generation}`, label: 'Global' }],
            },
          ],
        }),
      );
    }
    return new Response(JSON.stringify({ environment: 'preview', items: [] }));
  });
  const viewerHost = fixtureHost(fixtures({}), { viewer: { signedIn: true, account: 'alice' } }, [], []);
  function Room() {
    const [generation, update] = useState(0);
    return (
      <SectionFrame host={viewerHost} id="console-controls" width={960}>
        <UiPageContext.Provider
          value={{
            view: 'targets',
            label: 'Feature flags',
            reads: [],
            commands: [],
            params: ['target', 'scope', 'flag'],
            get: (name) => address.get(name),
            set: (name, value) => {
              if (value === undefined) address.delete(name);
              else address.set(name, value);
              update((previous) => previous + 1);
            },
          }}
        >
          <ConsoleRoom key={generation} props={{ endpoint: '/console' }} />
        </UiPageContext.Provider>
      </SectionFrame>
    );
  }
  const mounted = renderDom(<Room />);
  await user.click(await screen.findByRole('button', { name: 'App' }));
  await user.click(await screen.findByRole('option', { name: 'Marketplace' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'App' })).toHaveTextContent('Marketplace'));
  expect(address.has('flag')).toBe(false);
  expect(address.get('target')).toMatch(/^market-scope-/);
  // Marketplace has one scope, so the room opens it rather than asking.
  await waitFor(() => expect(address.get('scope')).toBe(address.get('target')));
  await screen.findByRole('searchbox', { name: 'Search flags' });
  mounted.unmount();
  renderDom(<Room />); // Reload starts with no local selection state.
  await waitFor(() => expect(screen.getByRole('button', { name: 'App' })).toHaveTextContent('Marketplace'));
  await screen.findByRole('searchbox', { name: 'Search flags' });
  expect(address.get('scope')).toBe(address.get('target'));
  expect(fetch.mock.calls.some(([input]) => String(input).includes('/scopes/'))).toBe(true);
});

test.each(['current', 'scope', 'account', 'unmount'] as const)(
  'close focus waits for teardown and respects the %s owner',
  async (change) => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const listRequest = flagListRequest();
    const request = vi.fn(async (path: string) => {
      const result = await listRequest(path);
      // The server preserves a selected handle only while it is explicitly
      // requested. The close refresh issues new handles for the same flags.
      return path === '/scopes/scope/flags' && 'items' in result && result.items
        ? { ...result, items: result.items.map((item) => ({ ...item, id: `fresh/${item.flagId}` })) }
        : result;
    });
    const props = {
      request: request as ConsoleRequest,
      scopeId: 'scope',
      selectTarget: vi.fn(),
      selectFlag: vi.fn(),
      selectScope: vi.fn(),
    };
    const mounted = render(<ConsolePanel {...props} flagId="opaque/finder" />);
    await screen.findByText('Read-only access.');
    fireEvent.click(screen.getByRole('button', { name: 'Close finder' }));
    mounted.rerender(<ConsolePanel {...props} />);
    const row = await screen.findByRole('button', { name: 'finder' });
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    // The new node is attached, but the modal's post-layout cleanup still owns
    // focus until the browser's next frame. Ref attachment must not focus it.
    expect(row).not.toHaveFocus();
    const focus = vi.spyOn(row, 'focus'),
      pending = frames.splice(0);
    if (change === 'scope') mounted.rerender(<ConsolePanel {...props} scopeId="other" />);
    if (change === 'account') mounted.rerender(<ConsolePanel {...props} request={flagListRequest() as ConsoleRequest} />);
    if (change === 'unmount') mounted.unmount();
    if (change !== 'current') expect(cancel).toHaveBeenCalled();
    // Also run cancelled callbacks to cover an already-dispatched stale frame.
    await act(async () => {
      for (const callback of pending) callback(0);
    });
    if (change === 'current') expect(row).toHaveFocus();
    else expect(focus).not.toHaveBeenCalled();
  },
);

test('kill-only mode sends a minimal command and displays no current value/history', async () => {
  const request = vi.fn(async (_path: string, body?: unknown) =>
    body
      ? { revision: 4, outcome: 'applied' }
      : { id: 'flag', flagId: 'finder', revision: 3, actions: ['kill'], environment: 'production', resultsAvailable: false },
  );
  render(<FlagRecord request={request as ConsoleRequest} id="flag" />);
  await screen.findByText('Current values and history are not available with your permissions.');
  expect(screen.queryByRole('tab', { name: 'History' })).toBeNull();
  expect(screen.queryByLabelText('Value')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Turn off…' }));
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'incident' } });
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
  await screen.findByText(/Change applied at revision 4/);
  expect(request).toHaveBeenCalledWith('/flags/flag/kill', { expectedRevision: 3, reason: 'incident' });
});

test('CAS conflict preserves draft/reason and only an explicit refetch enables a new attempt', async () => {
  let attempts = 0,
    reads = 0;
  const request = vi.fn(async (_path: string, body?: unknown) => {
    if (!body) return { ...detail, revision: ++reads === 1 ? 3 : 4 };
    if (++attempts === 1) throw new ConsoleFailure('revision_conflict', 'Revision changed. Refetch to review.');
    return { revision: 5, outcome: 'applied' };
  });
  render(<FlagRecord request={request as ConsoleRequest} id="flag" />);
  fireEvent.change(await screen.findByLabelText('Value'), { target: { value: 'keep this draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'planned rollout' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
  await screen.findByText('Revision changed. Refetch to review.');
  expect(screen.getByRole('list', { name: 'Changes' })).toHaveTextContent('keep this draft');
  expect(screen.getByLabelText('Reason')).toHaveValue('planned rollout');
  expect(screen.getByRole('button', { name: 'Apply change' })).toBeDisabled();
  expect(attempts).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'Refetch current record' }));
  await screen.findByText(/Current revision loaded/);
  expect(screen.getByRole('list', { name: 'Changes' })).toHaveTextContent('keep this draft');
  fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
  await screen.findByText(/Change applied at revision 5/);
  expect(request).toHaveBeenCalledWith('/flags/flag/set', {
    expectedRevision: 4,
    reason: 'planned rollout',
    override: { value: 'keep this draft' },
  });
});

test('unknown outcomes remain uncertain, block resubmission, and retain inputs', async () => {
  const request = vi.fn(async (_path: string, body?: unknown) => {
    if (body) throw new ConsoleFailure('outcome_unknown', 'The change could not be confirmed. Refetch and reconcile.');
    return detail;
  });
  render(<FlagRecord request={request as ConsoleRequest} id="flag" />);
  fireEvent.change(await screen.findByLabelText('Value'), { target: { value: 'draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'release' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
  await screen.findByText(/could not be confirmed/);
  expect(screen.getByRole('button', { name: 'Apply change' })).toBeDisabled();
  expect(screen.getByRole('list', { name: 'Changes' })).toHaveTextContent('draft');
  expect(request.mock.calls.filter(([, body]) => body).length).toBe(1);
  expect(document.body.textContent).not.toMatch(/rolled back|not applied/i);
});

test('late account and tenant responses never reappear after the selection changes', async () => {
  const held = deferred<unknown>();
  const alice = vi.fn((path: string) => (path.includes('/scopes/old/') ? held.promise : Promise.resolve({ targets: [] })));
  const bob = vi.fn(async (path: string) => (path.includes('/scopes/new/') ? { environment: 'production', items: [] } : { targets: [] }));
  const props = { flagId: undefined, selectTarget: vi.fn(), selectScope: vi.fn(), selectFlag: vi.fn() };
  const mounted = render(<ConsolePanel {...props} request={alice as ConsoleRequest} scopeId="old" />);
  await waitFor(() => expect(alice.mock.calls.some(([path]) => path.includes('/scopes/old/'))).toBe(true));
  mounted.rerender(<ConsolePanel {...props} request={bob as ConsoleRequest} scopeId="new" />);
  await screen.findByText('No authorized targets.');
  await act(async () => {
    held.resolve({ environment: 'secret-env', items: [{ id: 'hidden', flagId: 'Alice-private-flag', revision: 1, actions: ['view'] }] });
  });
  expect(document.body.textContent).not.toContain('Alice-private-flag');
  expect(document.body.textContent).not.toContain('secret-env');
});

test('late record responses and mutation acknowledgements are discarded on unmount', async () => {
  const held = deferred<unknown>();
  const request = vi.fn(async (_path: string, body?: unknown) => (body ? held.promise : detail));
  const mounted = render(<FlagRecord request={request as ConsoleRequest} id="old" />);
  fireEvent.change(await screen.findByLabelText('Value'), { target: { value: 'next' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'release' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
  await waitFor(() => expect(request.mock.calls.filter(([, body]) => body).length).toBe(1));
  mounted.unmount();
  await act(async () => {
    held.resolve({ revision: 99, outcome: 'applied' });
  });
  expect(document.body.textContent).not.toContain('99');
});

test('value editors parse exactly the declared scalar/object kind and variants', () => {
  expect(editedValue({ ...detail, type: 'boolean' }, 'false')).toBe(false);
  expect(editedValue({ ...detail, type: 'number' }, '12.5')).toBe(12.5);
  expect(editedValue({ ...detail, type: 'object' }, '{"nested":{"enabled":true}}')).toEqual({ nested: { enabled: true } });
  expect(editedValue({ ...detail, variants: ['a', 'b'] }, '"b"')).toBe('b');
  for (const value of ['[]', 'null', '{broken']) expect(() => editedValue({ ...detail, type: 'object' }, value)).toThrow();
  expect(() => editedValue({ ...detail, type: 'number' }, 'Infinity')).toThrow();
  expect(() => editedValue({ ...detail, variants: ['a', 'b'] }, '"c"')).toThrow();
});

test('network failure after command submission is unknown and never automatically retried', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection lost'));
  await expect(
    consoleRequest('/tools/_mistri/console/api/console', 'alice')('/flags/id/kill', { expectedRevision: 0, reason: 'incident' }),
  ).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe('/tools/_mistri/console/api/console/flags/id/kill');
  expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ 'x-mistri-account': 'alice' });
});

test('value edit retains rollout and all bounded targeting conditions until explicitly changed', async () => {
  const control = {
    value: 'old',
    rollout: 23.5,
    rules: [{ value: 'target', audiences: ['beta', 'staff'] }],
  };
  const request = vi.fn(async (_path: string, body?: unknown) =>
    body
      ? { revision: 4, outcome: 'applied' }
      : {
          ...detail,
          control,
          audiences: { beta: { rollout: 25 }, staff: { roles: ['manager'] }, pilot: { tenants: ['north'] } },
          scope: 'tenant',
        },
  );
  render(<FlagRecord request={request as ConsoleRequest} id="flag" />);
  fireEvent.change(await screen.findByLabelText('Value'), { target: { value: 'next' } });
  expect(screen.getByLabelText('Rollout percentage')).toHaveValue(23.5);
  fireEvent.click(screen.getByRole('button', { name: 'Edit rule 1' }));
  expect(screen.getByLabelText('beta')).toBeChecked();
  expect(screen.getByLabelText('staff')).toBeChecked();
  expect(screen.getByLabelText('pilot')).not.toBeChecked();
  // Each audience is shown as the App defines it; the Console names one in a rule and never edits it.
  expect(screen.getByText('25% of people')).toBeInTheDocument();
  expect(screen.getByText('tenant north')).toBeInTheDocument();
  expect(screen.getByText(/A global kill switch still takes precedence/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
  expect(within(screen.getByRole('list', { name: 'Changes' })).getAllByRole('listitem')).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'release' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
  await screen.findByText(/Change applied at revision 4/);
  expect(request).toHaveBeenCalledWith('/flags/flag/set', {
    expectedRevision: 3,
    reason: 'release',
    override: { ...control, value: 'next' },
  });
});

test('rule and rollout drafts survive conflict, including audience choices and the rule value', async () => {
  const request = vi.fn(async (_path: string, body?: unknown) => {
    if (body) throw new ConsoleFailure('revision_conflict', 'Review changed controls.');
    return {
      ...detail,
      control: { value: 'old', rollout: 40, rules: [{ value: 'a', audiences: ['readers'] }] },
      audiences: { readers: { roles: ['reader'] }, managers: { roles: ['manager'] } },
    };
  });
  render(<FlagRecord request={request as ConsoleRequest} id="flag" />);
  fireEvent.change(await screen.findByLabelText('Value'), { target: { value: 'next' } });
  fireEvent.click(screen.getByRole('button', { name: 'Edit rule 1' }));
  fireEvent.click(screen.getByLabelText('managers'));
  fireEvent.change(screen.getByLabelText('Rollout percentage'), { target: { value: '17' } });
  fireEvent.change(screen.getByLabelText('Rule value'), { target: { value: 'target' } });
  expect(screen.getByRole('region', { name: 'Staged changes' })).toHaveTextContent('3 changes staged');
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'bounded audience' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
  await screen.findByText('Review changed controls.');
  expect(request).toHaveBeenLastCalledWith('/flags/flag/set', {
    expectedRevision: 3,
    reason: 'bounded audience',
    override: { value: 'next', rollout: 17, rules: [{ value: 'target', audiences: ['readers', 'managers'] }] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByLabelText('Rollout percentage')).toHaveValue(17);
  fireEvent.click(screen.getByRole('button', { name: 'Edit rule 1' }));
  expect(screen.getByLabelText('Rule value')).toHaveValue('target');
  expect(screen.getByLabelText('managers')).toBeChecked();
});

test('staged edits are listed for review and can be discarded without a request', async () => {
  const request = vi.fn(async (_path: string, body?: unknown) =>
    body ? { revision: 4, outcome: 'applied' } : { ...detail, control: { value: 'old', rollout: 40 } },
  );
  render(<FlagRecord request={request as ConsoleRequest} id="flag" />);
  expect(await screen.findByText(/to 40% of everyone/)).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Staged changes' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Rollout percentage'), { target: { value: '60' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
  const changes = screen.getByRole('list', { name: 'Changes' });
  expect(within(changes).getByRole('listitem')).toHaveTextContent(/Rollout\s*40%\s*→\s*60%/);
  // The review says the result in the words it will be served in.
  expect(screen.getByRole('form', { name: 'Review' })).toHaveTextContent('to 60% of everyone');
  fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Give a reason');
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect(screen.getByLabelText('Rollout percentage')).toHaveValue(40);
  expect(screen.queryByRole('region', { name: 'Staged changes' })).toBeNull();
  expect(request.mock.calls.every(([, body]) => body === undefined)).toBe(true);
});

test('history offers a reviewed restore draft, never an immediate mutation', async () => {
  const request = vi.fn(async (path: string) =>
    path.endsWith('/history')
      ? {
          entries: [
            {
              revision: 2,
              operation: 'set',
              reason: 'early release',
              at: '2026-09-30T12:00:00.000Z',
              before: null,
              after: { value: 'old' },
            },
          ],
          nextBeforeRevision: null,
        }
      : detail,
  );
  render(<FlagRecord request={request as ConsoleRequest} id="flag" />);
  fireEvent.click(await screen.findByRole('tab', { name: 'History' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Restore revision 2' }));
  expect(screen.getByLabelText('Revision to restore')).toHaveValue(2);
  expect(screen.getByLabelText('Reason')).toHaveValue('');
  expect(request.mock.calls.every(([path]) => !path.endsWith('/revert'))).toBe(true);
});

function experimentResult(final: boolean): ExperimentResult {
  const statistics = computeExperimentStatistics({
    epochId: 'epoch-key',
    evidenceRevision: 7,
    control: 'a',
    startsAtMs: 0,
    endsAtMs: 100,
    conversionWindowMs: 100,
    deliveryGraceMs: 100,
    nowMs: final ? 400 : 50,
    completeness: { pending: final ? 0 : 2, failed: 0, incomplete: 0 },
    guardrails: [],
    arms: [
      { id: 'a', weight: 50, exposed: 100, mature: 100, immature: 0, primary: 10, guardrails: [] },
      { id: 'b', weight: 50, exposed: 100, mature: 100, immature: 0, primary: 30, guardrails: [] },
    ],
  });
  return {
    epoch: { key: 'epoch-key', fingerprint: 'epoch-fingerprint' },
    evidenceRevision: 7,
    statistics,
    declaration: {
      version: 'copy-v1',
      arms: [
        { id: 'a', value: 'old', weight: 50 },
        { id: 'b', value: 'new', weight: 50 },
      ],
    },
  } as unknown as ExperimentResult;
}

test('provisional experiment evidence shows maturity and delivery blockers without allowing a winner', () => {
  render(
    <ExperimentResults
      evidence={{ result: experimentResult(false), canDecide: true }}
      request={vi.fn() as ConsoleRequest}
      id="flag"
      revision={3}
    />,
  );
  expect(screen.getByRole('region', { name: 'Verdict' })).toHaveTextContent(/Provisional\s*Too early to call/);
  expect(screen.getAllByText('2 pending · 0 failed · 0 incomplete').length).toBeGreaterThan(0);
  const blockers = screen.getByRole('region', { name: 'Before a winner can be recorded' });
  expect(within(blockers).getByText('Finish delivering exposures')).toBeInTheDocument();
  // Each variant on one scale: its rate, its interval, and its lift against control.
  expect(screen.getByText('Baseline')).toBeInTheDocument();
  expect(screen.getByText('+20.00 pts')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Record and apply winner' })).toBeDisabled();
  expect(screen.getByText(/Exposures measure feature consumption/)).toBeInTheDocument();
});

test('explicit experiment decision binds the displayed evidence and flag revision and never retries unknown outcome', async () => {
  const request = vi.fn(async () => {
    throw new ConsoleFailure('outcome_unknown', 'Outcome unknown. Review history.');
  });
  const user = userEvent.setup();
  render(
    <ExperimentResults
      evidence={{ result: experimentResult(true), canDecide: true }}
      request={request as ConsoleRequest}
      id="flag"
      revision={3}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Winning variant' }));
  await user.click(screen.getByRole('option', { name: '"new"' }));
  fireEvent.change(screen.getByLabelText('Decision reason'), { target: { value: 'Final complete evidence reviewed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Record and apply winner' }));
  await screen.findByText('Outcome unknown. Review history.');
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith('/flags/flag/decide', {
    epochFingerprint: 'epoch-fingerprint',
    expectedRevision: 3,
    expectedResultRevision: 7,
    winnerVariant: 'new',
    reason: 'Final complete evidence reviewed',
  });
  expect(screen.getByRole('button', { name: 'Record and apply winner' })).toBeDisabled();
});

test('experiment activation does not depend on a published result and sends only the declared lifecycle intent', async () => {
  const request = vi.fn(async (_path: string, body?: unknown) =>
    body ? { acknowledgement: { revision: 4 }, outcome: 'applied' } : { ...detail, lifecycleAvailable: true, resultsAvailable: false },
  );
  const user = userEvent.setup();
  render(<FlagRecord request={request as ConsoleRequest} id="flag" />);
  await user.click(await screen.findByRole('button', { name: 'Activate declared experiment' }));
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Start immutable epoch' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
  await screen.findByText('Experiment control applied.');
  expect(request).toHaveBeenCalledWith('/flags/flag/lifecycle', {
    expectedRevision: 3,
    reason: 'Start immutable epoch',
    operation: 'activate',
  });
  expect(request.mock.calls.some(([path]) => path.endsWith('/results'))).toBe(false);
});
