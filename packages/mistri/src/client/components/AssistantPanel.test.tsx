import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AssistantPanel, AssistantRoom } from './AssistantPanel.js';
import { establishSessionIdentity } from '../../../../kit/src/client/sessionIdentity.js';
import { configureSessionLifecycle } from '../../../../kit/src/client/sessionLifecycle.js';
import { setAppRequestScope } from '../../../../kit/src/client/requestIdentity.js';
import { state } from '../../../../kit/src/client/core.js';
import { installShell } from '../../../../kit/src/client/shellMode.js';
import { registerPeek } from '../../../../kit/src/client/uiBridge.js';

/* The App the panel sits in, set per test; the rest of appState is the real one. */
const mocks = vi.hoisted(() => ({ app: null as unknown }));
vi.mock('../appState.js', async (original) => ({ ...(await original<typeof import('../appState.js')>()), activeApp: () => mocks.app }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
/* The record's verbs are ActionBar's own (Actions.test.tsx drives it, outcome
   report included); here a stand-in draws the verbs it is handed and reports
   each as done through the same context, so the card's plumbing is what is tested. */
vi.mock('./Actions.js', async (original) => {
  const real = await original<typeof import('./Actions.js')>();
  const { createElement, useContext } = await import('react');
  return {
    ...real,
    ActionBar: (props: {
      tableId: string;
      actions: Array<{ id: string; label: string }>;
      recordKey: Record<string, unknown>;
      label: string;
      grantedActions?: readonly string[];
      onDone?: () => void;
    }) => {
      const tell = useContext(real.ActionOutcomes);
      return createElement(
        'div',
        null,
        props.actions
          .filter((action) => props.grantedActions?.includes(action.id))
          .map((action) =>
            createElement(
              'button',
              {
                key: action.id,
                type: 'button',
                onClick: () => {
                  tell?.({
                    tableId: props.tableId,
                    key: props.recordKey,
                    label: props.label,
                    action,
                    outcome: { status: 'done' },
                  } as never);
                  props.onDone?.();
                },
              },
              action.label,
            ),
          ),
      );
    },
  };
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'x-mistri-account': 'ada', 'content-type': 'application/json' } });
const events = (...list: Array<[string, unknown]>) =>
  new Response(list.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {
    headers: { 'x-mistri-account': 'ada', 'content-type': 'text/event-stream' },
  });
const proposal = {
  id: 'p1',
  kind: 'set',
  resource: 'lead',
  action: 'startWorking',
  label: 'Start working',
  record: 'Margot Fontaine',
  address: '/compass/leads/127',
  values: {},
  why: 'You asked.',
};

const draw = (tree: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{tree}</QueryClientProvider>);
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const bodies = () =>
  fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url, init]) => [String(url), JSON.parse(String(init!.body))]);

beforeEach(() => {
  configureSessionLifecycle({ onLock: () => {} });
  establishSessionIdentity({ signedIn: true, accountId: 'ada', appId: 'compass' });
  setAppRequestScope(true);
  state.activeConnection = 'compass';
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const path = String(url);
    if (path.startsWith('/api/assistant?')) return json({ conversations: [], ready: true });
    if (path === '/api/assistant/turn')
      return events(
        ['conversation', { id: 'c1', title: 'Start working', person: 1 }],
        ['text', { delta: 'Proposing it for ' }],
        ['text', { delta: '[Margot](/compass/leads/127).' }],
        ['step', { id: 'p1', tool: 'run', label: 'Proposed Start working: Margot Fontaine' }],
        ['proposal', { id: 'p1', proposal }],
        ['done', { state: 'awaiting', tokens: 10 }],
      );
    if (path === '/api/assistant/resolve') return events(['text', { delta: 'Left as it is.' }], ['done', { state: 'idle', tokens: 4 }]);
    return json({ error: 'unexpected' }, 404);
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  state.activeConnection = null;
  mocks.app = null;
  installShell({ writeScope: () => true });
  try {
    localStorage.clear();
  } catch {
    /* nothing kept */
  }
});

test('a turn streams in as words, a folded step and a proposal card; nothing is sent until the person answers it', async () => {
  const user = userEvent.setup();
  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  expect(await screen.findByText(/Ask about your records/)).toBeInTheDocument();
  const box = screen.getByRole('textbox', { name: 'Message the assistant' });
  await user.type(box, 'Start working this lead{Enter}');
  expect(await screen.findByRole('region', { name: 'Proposed change' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Margot' })).toHaveAttribute('href', '/compass/leads/127');
  expect(screen.getByText('1 step')).toBeInTheDocument();
  // Waiting for the person: the box is closed until they confirm or decline, and says so in words beside it, not
  // only by Send going grey.
  expect(box).toBeDisabled();
  expect(box).toHaveAccessibleDescription('Waiting for you to confirm or decline.');
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(bodies()).toEqual([['/api/assistant/turn', { app: 'compass', text: 'Start working this lead' }]]);

  await user.click(screen.getByRole('button', { name: 'Decline' }));
  expect(await screen.findByText('Left as it is.')).toBeInTheDocument();
  expect(box).toBeEnabled();
  expect(box).not.toHaveAccessibleDescription();
  expect(screen.queryByText('Waiting for you to confirm or decline.')).toBeNull();
  expect(screen.getByText('Declined.')).toBeInTheDocument();
  expect(bodies()[1]).toEqual(['/api/assistant/resolve', { app: 'compass', conversation: 'c1', proposal: 'p1', outcome: 'declined' }]);
  // No write path was asked: declining writes nothing.
  expect(fetcher.mock.calls.some(([url]) => String(url).startsWith('/api/update'))).toBe(false);
});

test('Escape closes the panel when nothing is running; a server without a model says so and takes no words', async () => {
  fetcher.mockImplementation(async (url) =>
    String(url).startsWith('/api/assistant/conversation')
      ? json({ error: 'No such conversation.' }, 404)
      : json({ conversations: [], ready: false }),
  );
  const onClose = vi.fn();
  const user = userEvent.setup();
  draw(<AssistantPanel app="compass" record={false} onClose={onClose} />);
  expect(await screen.findByText('The assistant is not set up on this server yet.')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message the assistant' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Conversations' }));
  // The list is the nearer layer: Escape folds it first, then closes the panel.
  await user.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Conversations' })).toHaveAttribute('aria-pressed', 'false');
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalled();
});

test('Full screen fills the content area and is remembered; Escape gives the side panel back and keeps the focus', async () => {
  const onClose = vi.fn();
  const user = userEvent.setup();
  const first = draw(<AssistantPanel app="compass" record={false} onClose={onClose} />);
  const expand = await screen.findByRole('button', { name: 'Full screen' });
  expect(expand).toHaveAttribute('aria-pressed', 'false');
  await user.click(expand);
  expect(expand).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('complementary', { name: 'Assistant' })).toHaveClass('assistant-panel-expanded');
  first.unmount();

  // Opened again, it opens as it was left.
  draw(<AssistantPanel app="compass" record={false} onClose={onClose} />);
  expect(await screen.findByRole('button', { name: 'Full screen' })).toHaveAttribute('aria-pressed', 'true');
  const box = screen.getByRole('textbox', { name: 'Message the assistant' });
  box.focus();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'Full screen' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('complementary', { name: 'Assistant' })).not.toHaveClass('assistant-panel-expanded');
  expect(onClose).not.toHaveBeenCalled();
  expect(box).toHaveFocus();
  // A second Escape is the old one: the panel closes.
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalled();
});

test('a starter scoped to a view or a record’s table is offered only there', async () => {
  mocks.app = {
    name: 'desk',
    resources: {},
    assistant: {
      icon: 'chat-circle',
      record: true,
      starters: [
        'Which tickets are mine?',
        { text: 'Summarize this ticket', records: ['incident'] },
        { text: 'Find stale deals', views: ['pipeline'] },
      ],
    },
  };
  const offered = async () =>
    within(await screen.findByRole('group', { name: 'Try asking' }))
      .getAllByRole('button')
      .map((button) => button.textContent);
  const before = state.stack;
  try {
    state.stack = [{ kind: 'table', table: 'deal', query: '', view: 'pipeline' }] as typeof state.stack;
    draw(<AssistantPanel app="desk" record onClose={() => {}} />);
    expect(await offered()).toEqual(['Which tickets are mine?', 'Find stale deals']);
    cleanup();
    state.stack = [
      { kind: 'table', table: 'incident', query: '', view: 'tickets' },
      { kind: 'row', table: 'incident', key: { id: 7 }, label: 'VPN drops', view: 'tickets' },
    ] as typeof state.stack;
    draw(<AssistantPanel app="desk" record onClose={() => {}} />);
    expect(await offered()).toEqual(['Which tickets are mine?', 'Summarize this ticket']);
  } finally {
    state.stack = before;
  }
});

test('an empty conversation offers the App’s starters, and one sends as the person’s words', async () => {
  mocks.app = { name: 'compass', resources: {}, assistant: { icon: 'chat-circle', starters: ['Show stale deals', 'Pipeline by stage'] } };
  const user = userEvent.setup();
  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  const starters = await screen.findByRole('group', { name: 'Try asking' });
  // The intro, the starters and the composer are one group, centred in the pane until the first words.
  const panel = screen.getByRole('complementary', { name: 'Assistant' });
  expect(panel).toHaveClass('assistant-starting');
  expect(starters.closest('.assistant-start')).toContainElement(screen.getByText(/Ask about your records/));
  // Send is quiet until there is something to send, then the one filled action.
  const send = screen.getByRole('button', { name: 'Send' });
  expect(send).toBeDisabled();
  expect(send).not.toHaveClass('btn-primary');
  await user.type(screen.getByRole('textbox', { name: 'Message the assistant' }), 'x');
  expect(screen.getByRole('button', { name: 'Send' })).toHaveClass('btn-primary');
  await user.clear(screen.getByRole('textbox', { name: 'Message the assistant' }));
  await user.click(within(starters).getByRole('button', { name: 'Pipeline by stage' }));
  expect(await screen.findByRole('region', { name: 'Proposed change' })).toBeInTheDocument();
  expect(bodies()[0]).toEqual(['/api/assistant/turn', { app: 'compass', text: 'Pipeline by stage' }]);
  expect(screen.queryByRole('group', { name: 'Try asking' })).toBeNull();
  expect(panel).not.toHaveClass('assistant-starting');
});

test('the assistant’s page: a rail of conversations beside it, a heading, and no panel chrome', async () => {
  mocks.app = { name: 'compass', resources: {}, assistant: { icon: 'chat-circle', page: true } };
  fetcher.mockImplementation(async (url) =>
    String(url).startsWith('/api/assistant?')
      ? json({ conversations: [{ id: 'c9', title: 'Pipeline by stage', updated: '2026-09-04T10:00:00Z' }], ready: true })
      : json({ error: 'unexpected' }, 404),
  );
  draw(<AssistantRoom />);
  expect(await screen.findByRole('heading', { level: 1, name: /Assistant/ })).toBeInTheDocument();
  const rail = screen.getByRole('navigation', { name: 'Conversations' });
  expect(await within(rail).findByRole('button', { name: /^Pipeline by stage/ })).toBeInTheDocument();
  expect(within(rail).getByRole('button', { name: 'New conversation' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Full screen' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Close the assistant' })).toBeNull();
});

test('the page is headed by the open conversation’s title, with its Rename and Delete', async () => {
  mocks.app = { name: 'compass', resources: {}, assistant: { icon: 'chat-circle', page: true } };
  let title = 'Pipeline by stage';
  fetcher.mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/assistant?'))
      return json({ conversations: [{ id: 'c9', title, updatedAt: '2026-09-04T10:00:00Z' }], ready: true });
    if (path.startsWith('/api/assistant/conversation'))
      return json({ items: [{ type: 'text', text: 'Most deals are in qualification.' }] });
    if (path === '/api/assistant/rename') {
      title = (JSON.parse(String(init!.body)) as { title: string }).title;
      return json({ ok: true });
    }
    return json({ error: 'unexpected' }, 404);
  });
  const user = userEvent.setup();
  draw(<AssistantRoom conversation="c9" />);
  const heading = await screen.findByRole('heading', { level: 1, name: /Pipeline by stage/ });
  // The assistant is stable since 1.0: its head carries no Preview chip.
  expect(within(heading).queryByText('Preview')).toBeNull();
  // The head's own menu, beside the title (the rail's row has one of its own).
  const head = heading.closest('.assistant-head') as HTMLElement;
  await user.click(within(head).getByRole('button', { name: 'Actions for “Pipeline by stage”' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
  const field = screen.getByRole('textbox', { name: 'Rename “Pipeline by stage”' });
  await user.clear(field);
  await user.type(field, 'Stages{Enter}');
  expect(bodies()).toContainEqual(['/api/assistant/rename', { app: 'compass', conversation: 'c9', title: 'Stages' }]);
  expect(await screen.findByRole('heading', { level: 1, name: /Stages/ })).toBeInTheDocument();
});

test('a new conversation on the page is headed Assistant', async () => {
  mocks.app = { name: 'compass', resources: {}, assistant: { icon: 'chat-circle', page: true } };
  draw(<AssistantRoom />);
  expect(await screen.findByRole('heading', { level: 1, name: 'Assistant' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Actions for / })).toBeNull();
});

test('a page an App did not place draws nothing', () => {
  mocks.app = { name: 'compass', resources: {}, assistant: { icon: 'chat-circle' } };
  const { container } = draw(<AssistantRoom />);
  expect(container).toBeEmptyDOMElement();
});

const lead = {
  id: 'lead',
  name: 'lead',
  columns: [
    { name: 'id', type: 'integer', primaryKey: true, nullable: false },
    { name: 'name', type: 'text', nullable: false },
    { name: 'email', type: 'text', nullable: true },
    { name: 'status', type: 'text', nullable: false },
    { name: 'owner_id', type: 'integer', nullable: true, references: { table: 'rep', column: 'id' } },
  ],
};
const rep = {
  id: 'rep',
  name: 'rep',
  columns: [
    { name: 'id', type: 'integer', primaryKey: true, nullable: false },
    { name: 'name', type: 'text', nullable: false },
  ],
};
const felix = {
  kind: 'record',
  table: 'lead',
  key: { id: 4 },
  title: 'Felix Duval',
  values: { id: 4, name: 'Felix Duval', email: 'felix.duval@example.org', status: 'new', owner_id: 20 },
};
const startWorking = { id: 'startWorking', label: 'Start working', set: { status: 'working' }, when: 'status = new' };
function withCard(granted: string[]) {
  state.schema = {
    tables: [lead, rep],
    foreignKeys: [{ from: { table: 'lead', columns: ['owner_id'] }, to: { table: 'rep', columns: ['id'] } }],
  } as never;
  mocks.app = { name: 'compass', resources: { lead: { actions: [startWorking] } }, grantedActions: { lead: granted }, grantedCommands: [] };
  fetcher.mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/assistant?')) return json({ conversations: [], ready: true });
    if (path === '/api/assistant/turn')
      return events(
        ['conversation', { id: 'c1', title: 'Felix', person: 1 }],
        ['block', { id: 'b1', block: felix }],
        ['done', { state: 'idle', tokens: 10 }],
      );
    if (path === '/api/view/run') {
      const asked = JSON.parse(String(init!.body)) as { view: { columns: Array<{ path: string }> } };
      return json({
        rows: [{ ...felix.values, status: 'working', 'owner_id.name': 'Arjun Hansen', asked: asked.view.columns.map((c) => c.path) }],
      });
    }
    if (path === '/api/assistant/acted') return json({ item: { type: 'note', text: 'Start working on Felix Duval: applied.' } });
    return json({ error: 'unexpected' }, 404);
  });
}

test('a record card carries the record’s verbs and Edit; what one did is told to the conversation and the card reads again', async () => {
  withCard(['startWorking']);
  const openPeek = vi.fn();
  registerPeek(openPeek as never);
  const user = userEvent.setup();
  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  await user.type(screen.getByRole('textbox', { name: 'Message the assistant' }), 'Show me Felix{Enter}');
  const verbs = await screen.findByRole('group', { name: 'What you can do with Felix Duval' });
  // A reference reads as its record's name, as a glance draws it.
  expect(await screen.findByText('Arjun Hansen')).toBeInTheDocument();
  // A long value keeps one line, its whole in the title.
  expect(screen.getByText('felix.duval@example.org').closest('dd')).toHaveAttribute('title', 'felix.duval@example.org');

  await user.click(within(verbs).getByRole('button', { name: 'Edit Felix Duval' }));
  expect(openPeek).toHaveBeenCalledWith('lead', { id: 4 }, 'Felix Duval', 'modal');

  const reads = () => fetcher.mock.calls.filter(([url]) => String(url) === '/api/view/run').length;
  const before = reads();
  await user.click(within(verbs).getByRole('button', { name: 'Start working' }));
  expect(await screen.findByText('Start working on Felix Duval: applied.')).toBeInTheDocument();
  expect(bodies().find(([url]) => url === '/api/assistant/acted')).toEqual([
    '/api/assistant/acted',
    {
      app: 'compass',
      conversation: 'c1',
      resource: 'lead',
      action: 'startWorking',
      key: { id: 4 },
      record: 'Felix Duval',
      outcome: 'done',
    },
  ]);
  await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
});

test('a person who may neither run the verb nor write sees the record and no buttons', async () => {
  withCard([]);
  installShell({ writeScope: () => false });
  const user = userEvent.setup();
  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  await user.type(screen.getByRole('textbox', { name: 'Message the assistant' }), 'Show me Felix{Enter}');
  expect(await screen.findByText('Arjun Hansen')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Start working' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit Felix Duval' })).toBeNull();
});
