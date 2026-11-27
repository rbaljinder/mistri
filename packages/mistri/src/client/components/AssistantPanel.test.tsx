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
/* A command's revision is the command pipeline's own read (sdk/proposalCommands.ts); here it is the record's version as it is now. */
vi.mock('./sdk/proposalCommands.js', () => ({ commandRevision: async () => 3 }));
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
  expect(screen.getByText('Dismissed')).toBeInTheDocument();
  expect(bodies()[1]).toEqual(['/api/assistant/resolve', { app: 'compass', conversation: 'c1', proposal: 'p1', outcome: 'declined' }]);
  // No write path was asked: declining writes nothing.
  expect(fetcher.mock.calls.some(([url]) => String(url).startsWith('/api/update'))).toBe(false);
});

test('a command kept for review holds nothing up; Review approves the stored proposal and Decline dismisses it', async () => {
  const user = userEvent.setup();
  const assign = { id: 'assign', label: 'Assign', command: { id: 'assign', version: 1, target: 'lead', targets: 'one', input: {} } };
  mocks.app = { name: 'compass', resources: { lead: { actions: [assign] } }, grantedActions: { lead: [] }, grantedCommands: ['assign'] };
  const kept = (id: string, review: string, record: string, key: number) => ({
    id,
    proposal: { ...proposal, id, kind: 'command', action: 'assign', label: 'Assign', record, key: { id: key }, review },
  });
  fetcher.mockImplementation(async (url) => {
    const path = String(url);
    if (path.startsWith('/api/assistant?')) return json({ conversations: [], ready: true });
    if (path === '/api/assistant/turn')
      return events(
        ['conversation', { id: 'c1', title: 'Assign', person: 1 }],
        ['proposal', kept('p1', 'r1', 'Margot Fontaine', 127)],
        ['proposal', kept('p2', 'r2', 'Felix Duval', 4)],
        ['text', { delta: 'Kept both for review.' }],
        ['done', { state: 'idle', tokens: 10 }],
      );
    if (path === '/api/assistant/acted') return json({ item: { type: 'note', text: 'Assign on Margot Fontaine: applied.' } });
    if (path.startsWith('/api/commands/proposals/')) return json({ ok: true });
    return json({ error: 'unexpected' }, 404);
  });
  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  const box = await screen.findByRole('textbox', { name: 'Message the assistant' });
  await user.type(box, 'Assign both{Enter}');
  expect(await screen.findByText('Kept both for review.')).toBeInTheDocument();
  // The turn went on: nothing waits in the conversation.
  expect(box).toBeEnabled();
  const [first, second] = screen.getAllByRole('region', { name: 'Proposed change' });

  await user.click(within(first).getByRole('button', { name: 'Review and confirm' }));
  expect(await within(first).findByText('Assigned')).toBeInTheDocument();
  await user.click(within(second).getByRole('button', { name: 'Decline' }));
  expect(await within(second).findByText('Dismissed')).toBeInTheDocument();
  // The query names the App; the path is the verb.
  const sent = bodies()
    .map(([path, body]) => [path.split('?')[0], body])
    .filter(([path]) => path.startsWith('/api/commands/'));
  expect(sent).toEqual([
    ['/api/commands/proposals/approve', expect.objectContaining({ id: 'r1', command: 'assign', expectedVersion: 3 })],
    ['/api/commands/proposals/dismiss', expect.objectContaining({ id: 'r2', command: 'assign' })],
  ]);
  // The queue's verbs decided them: the in-chat resolve is for a proposal the turn waited on, and none did.
  expect(bodies().some(([path]) => path === '/api/assistant/resolve')).toBe(false);
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
  expect(send).not.toHaveAttribute('data-variant', 'solid');
  await user.type(screen.getByRole('textbox', { name: 'Message the assistant' }), 'x');
  expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('data-variant', 'solid');
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

/* A turn's events, sent when the test says: what the panel draws between them is what a slow server shows. */
function held() {
  let send!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => void (send = controller),
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, {
      headers: {
        'x-mistri-account': 'ada',
        'content-type': 'text/event-stream',
      },
    }),
    say: (event: string, data: unknown) => send.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
    end: () => send.close(),
  };
}
const turnsAnswer = (...answers: Array<() => Response>) => {
  const fallback = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => {
    if (String(url) === '/api/assistant/turn') return answers.shift()?.() ?? fallback(url, init);
    // No conversation carried over from another test is reopened here.
    if (String(url).startsWith('/api/assistant/conversation')) return json({ error: 'No such conversation.' }, 404);
    return fallback(url, init);
  });
};

test('a turn says it is working at once, then what each tool is doing, and nothing moves', async () => {
  const stream = held();
  turnsAnswer(() => stream.response);
  const user = userEvent.setup();
  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  await user.type(await screen.findByRole('textbox', { name: 'Message the assistant' }), 'Which leads are mine?{Enter}');
  // Before the server has said anything: a field report waited seventy seconds under the bare question.
  expect(await screen.findByText('Working…')).toBeInTheDocument();
  stream.say('conversation', { id: 'c1', title: 'Mine', person: 1 });
  stream.say('running', { id: 't1', tool: 'query', label: 'Reading lead…' });
  expect(await screen.findByText('Reading lead…')).toBeInTheDocument();
  expect(screen.getByText('Reading lead…').getAnimations?.() ?? []).toEqual([]);
  stream.say('step', { id: 't1', tool: 'query', label: 'Read 3 leads' });
  expect(await screen.findByText('Working…')).toBeInTheDocument();
  stream.say('text', { delta: 'Three are yours.' });
  stream.say('done', { state: 'idle', tokens: 10 });
  stream.end();
  expect(await screen.findByText('Three are yours.')).toBeInTheDocument();
  expect(screen.queryByText('Working…')).toBeNull();
  expect(screen.getByText('1 step')).toBeInTheDocument();
});

test('a turn cut off on the way says the connection dropped, and Try again sends it again', async () => {
  // A proxy's bare 500 before the stream opened: nothing was kept, so the same words go again.
  turnsAnswer(
    () => new Response('Container suddenly disconnected', { status: 500 }),
    () => {
      const stream = held();
      stream.say('conversation', { id: 'c1', title: 'Mine', person: 1 });
      stream.say('text', { delta: 'Half an ans' });
      stream.end();
      return stream.response;
    },
  );
  const user = userEvent.setup();
  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  await user.type(await screen.findByRole('textbox', { name: 'Message the assistant' }), 'Which leads are mine?{Enter}');
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('The connection to the server dropped before the answer finished.');
  expect(alert).not.toHaveTextContent('500');
  await user.click(within(alert).getByRole('button', { name: 'Try again' }));
  // The stream closed without its end: the server had kept the words, so the turn is retried from them.
  expect(await screen.findByText('Half an ans')).toBeInTheDocument();
  await user.click(
    within(await screen.findByRole('alert')).getByRole('button', {
      name: 'Try again',
    }),
  );
  expect(bodies()).toEqual([
    ['/api/assistant/turn', { app: 'compass', text: 'Which leads are mine?' }],
    ['/api/assistant/turn', { app: 'compass', text: 'Which leads are mine?' }],
    [
      '/api/assistant/turn',
      {
        app: 'compass',
        conversation: 'c1',
        text: 'Which leads are mine?',
        retry: true,
      },
    ],
  ]);
});

test('a conversation the server refuses is said with a way out, and is never reopened for the next person', async () => {
  const user = userEvent.setup();
  turnsAnswer(() =>
    events(['conversation', { id: 'c7', title: 'Mine', person: 1 }], ['text', { delta: 'Yours.' }], ['done', { state: 'idle', tokens: 4 }]),
  );
  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  await user.type(await screen.findByRole('textbox', { name: 'Message the assistant' }), 'Hello{Enter}');
  expect(await screen.findByText('Yours.')).toBeInTheDocument();
  cleanup();

  // Reopened, the conversation is refused (the customer's lease is no longer the server's): said, not a blank panel.
  const fallback = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) =>
    String(url).startsWith('/api/assistant/conversation') ? json({ error: 'Choose a customer first.' }, 403) : fallback(url, init),
  );
  const opened = () => fetcher.mock.calls.filter(([url]) => String(url).startsWith('/api/assistant/conversation')).length;
  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('This conversation could not be opened: Choose a customer first.');
  expect(within(alert).getByRole('button', { name: 'New conversation' })).toBeInTheDocument();
  cleanup();

  // Another person signed in to the same tab is not handed the last one's conversation to be refused.
  const before = opened();
  establishSessionIdentity({
    signedIn: true,
    accountId: 'bob',
    appId: 'compass',
  });
  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  expect(await screen.findByText(/Ask about your records/)).toBeInTheDocument();
  expect(opened()).toBe(before);
  cleanup();

  // The way out is a new conversation.
  establishSessionIdentity({
    signedIn: true,
    accountId: 'ada',
    appId: 'compass',
  });
  turnsAnswer(() =>
    events(['conversation', { id: 'c8', title: 'Mine', person: 1 }], ['text', { delta: 'Again.' }], ['done', { state: 'idle', tokens: 4 }]),
  );
  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  await user.type(await screen.findByRole('textbox', { name: 'Message the assistant' }), 'Hello{Enter}');
  expect(await screen.findByText('Again.')).toBeInTheDocument();
  cleanup();
  fetcher.mockImplementation(async (url, init) =>
    String(url).startsWith('/api/assistant/conversation') ? json({ error: 'Choose a customer first.' }, 403) : fallback(url, init),
  );
  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  await user.click(
    within(await screen.findByRole('alert')).getByRole('button', {
      name: 'New conversation',
    }),
  );
  expect(screen.queryByRole('alert')).toBeNull();
  expect(await screen.findByText(/Ask about your records/)).toBeInTheDocument();
});

test('an Ask is a mode of the panel: its turn asks to read only, and the answer shows the query it ran and the records it read', async () => {
  const user = userEvent.setup();
  fetcher.mockImplementation(async (url) => {
    const path = String(url);
    if (path.startsWith('/api/assistant?')) return json({ conversations: [], ready: true });
    if (path === '/api/assistant/turn')
      return events(
        ['conversation', { id: 'c2', title: 'Which leads are new?', person: 1 }],
        ['step', { id: 's1', tool: 'query', label: 'Read lead' }],
        [
          'query',
          {
            id: 's1',
            q: 'lead show id, name where status = new',
            resource: 'lead',
            total: 2,
            evidence: [
              { ref: 'lead/{"id":1}', label: 'Acme Corp' },
              { ref: 'lead/{"id":2}', label: 'Globex' },
            ],
          },
        ],
        ['text', { delta: 'Two leads are new.' }],
        ['done', { state: 'idle', tokens: 8 }],
      );
    return json({ error: 'unexpected' }, 404);
  });
  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} ask={1} />);
  expect(await screen.findByRole('heading', { name: 'Ask' })).toBeInTheDocument();
  expect(screen.getByText(/The answer shows the query it ran/)).toBeInTheDocument();
  const box = screen.getByRole('textbox', { name: 'Ask about your records' });
  await user.type(box, 'Which leads are new?{Enter}');
  expect(await screen.findByText('Two leads are new.')).toBeInTheDocument();
  expect(bodies()).toEqual([['/api/assistant/turn', { app: 'compass', text: 'Which leads are new?', mode: 'ask' }]]);
  // The read, in the query language, with how many rows it found; each row read opens as its record.
  const read = screen.getByRole('region', { name: 'Ran' });
  expect(within(read).getByText('lead show id, name where status = new').tagName).toBe('CODE');
  expect(within(read).getByText('2 rows')).toBeInTheDocument();
  const rows = within(read).getByRole('list', { name: 'Records read' });
  expect(
    within(rows)
      .getAllByRole('button')
      .map((each) => each.textContent),
  ).toEqual(['Acme Corp', 'Globex']);
  // Nothing to confirm: an Ask reads.
  expect(screen.queryByRole('region', { name: 'Proposed change' })).toBeNull();
  expect(box).toBeEnabled();
});

test('a panel opened without Ask is the chat: its turn names no mode', async () => {
  const user = userEvent.setup();
  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  await user.type(await screen.findByRole('textbox', { name: 'Message the assistant' }), 'hello{Enter}');
  await screen.findByRole('region', { name: 'Proposed change' });
  expect(bodies()[0][1]).not.toHaveProperty('mode');
  expect(screen.queryByRole('region', { name: 'Ran' })).toBeNull();
});

test('a page hands the panel a record: it is named as the server reads it, its words wait in the box, and the turn is about it', async () => {
  const user = userEvent.setup();
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => {
    if (String(url) === '/api/assistant/about') return json({ resource: 'lead', key: { id: 127 }, label: 'Margot Fontaine' });
    return base(url, init);
  });
  draw(
    <AssistantPanel app="compass" record onClose={() => {}} handoff={{ about: { table: 'lead', id: 127 }, text: 'Check out', at: 1 }} />,
  );
  expect(await screen.findByText('About Margot Fontaine')).toBeInTheDocument();
  const box = screen.getByRole('textbox', { name: 'Message the assistant' });
  // Filled, never sent: the only request so far is the record's.
  expect(box).toHaveValue('Check out');
  expect(bodies()).toEqual([['/api/assistant/about', { app: 'compass', resource: 'lead', id: 127 }]]);
  await user.type(box, ' this lead{Enter}');
  expect(await screen.findByRole('region', { name: 'Proposed change' })).toBeInTheDocument();
  expect(bodies()[1]).toEqual([
    '/api/assistant/turn',
    { app: 'compass', text: 'Check out this lead', context: { resource: 'lead', key: { id: 127 } } },
  ]);
});

test('a record the reader cannot open is said, and the panel is about nothing', async () => {
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => {
    if (String(url) === '/api/assistant/about')
      return json({ error: 'That record is not one you can open, so the assistant cannot be told about it.' }, 404);
    return base(url, init);
  });
  draw(<AssistantPanel app="compass" record onClose={() => {}} handoff={{ about: { table: 'lead', id: 9 }, at: 1 }} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The assistant was not told about that record: That record is not one you can open, so the assistant cannot be told about it.',
  );
  expect(screen.queryByText(/^About /)).not.toBeInTheDocument();
});

test('a table the model writes in words is drawn as a table', async () => {
  const user = userEvent.setup();
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => {
    if (String(url) === '/api/assistant/turn')
      return events(
        ['conversation', { id: 'c1', title: 'Production', person: 1 }],
        ['text', { delta: 'By provider:\n| Provider | Production |\n| --- | ---: |\n| Dr. Ode | $1,200 |\n| Dr. Park | $900 |' }],
        ['done', { state: 'idle', tokens: 4 }],
      );
    return base(url, init);
  });
  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  await user.type(screen.getByRole('textbox', { name: 'Message the assistant' }), 'production?{Enter}');
  const table = await screen.findByRole('table');
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent),
  ).toEqual(['Provider', 'Production']);
  expect(
    within(table)
      .getAllByRole('cell')
      .map((cell) => cell.textContent),
  ).toEqual(['Dr. Ode', '$1,200', 'Dr. Park', '$900']);
  expect(screen.getByText('By provider:')).toBeInTheDocument();
  expect(screen.queryByText(/\| Provider/)).not.toBeInTheDocument();
});

test('the side panel drags, steps with the keyboard, remembers its width per person and App, and resets on double-click', async () => {
  window.localStorage.removeItem('mistri.assistant.width.compass.ada');
  window.localStorage.removeItem('mistri.assistant.expanded.compass.ada');
  const user = userEvent.setup();
  const { fireEvent } = await import('@testing-library/react');
  const first = draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  const panel = screen.getByRole('complementary', { name: 'Assistant' });
  const handle = screen.getByRole('separator', { name: 'Resize the assistant' });
  expect(handle).toHaveAttribute('aria-valuenow', '512');
  expect(panel.style.getPropertyValue('--assistant-width')).toBe('');

  // Dragging the left edge 120px leftward widens the panel from 512px to 632px and persists it.
  fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 500 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 380 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(panel.style.getPropertyValue('--assistant-width')).toBe('632px');
  expect(window.localStorage.getItem('mistri.assistant.width.compass.ada')).toBe('632');

  // Reopening restores the remembered width; ArrowRight narrows by 24px; Home clamps to the 384px floor; double-click resets.
  first.unmount();
  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  const reopened = screen.getByRole('complementary', { name: 'Assistant' });
  const reopenedHandle = screen.getByRole('separator', { name: 'Resize the assistant' });
  expect(reopened.style.getPropertyValue('--assistant-width')).toBe('632px');

  fireEvent.keyDown(reopenedHandle, { key: 'ArrowRight' });
  expect(reopened.style.getPropertyValue('--assistant-width')).toBe('608px');
  fireEvent.keyDown(reopenedHandle, { key: 'ArrowLeft', shiftKey: true });
  expect(reopened.style.getPropertyValue('--assistant-width')).toBe('672px');
  fireEvent.keyDown(reopenedHandle, { key: 'Home' });
  expect(reopened.style.getPropertyValue('--assistant-width')).toBe('384px');

  fireEvent.doubleClick(reopenedHandle);
  expect(reopened.style.getPropertyValue('--assistant-width')).toBe('');
  expect(window.localStorage.getItem('mistri.assistant.width.compass.ada')).toBeNull();

  // Full screen removes the side-panel resize handle until stepped back.
  await user.click(screen.getByRole('button', { name: 'Full screen' }));
  expect(screen.queryByRole('separator', { name: 'Resize the assistant' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Full screen' }));
  expect(screen.getByRole('separator', { name: 'Resize the assistant' })).toBeInTheDocument();
});

test('mode switcher transitions cleanly between sidebar, floating, fullscreen, and remembers floating across reopen and Escape', async () => {
  const onClose = vi.fn();
  const user = userEvent.setup();
  const first = draw(<AssistantPanel app="compass" record={false} onClose={onClose} />);
  const floatingBtn = await screen.findByRole('button', { name: 'Floating window' });
  await user.click(floatingBtn);
  expect(floatingBtn).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('complementary', { name: 'Assistant' })).toHaveClass('assistant-panel-floating');
  expect(window.localStorage.getItem('mistri.assistant.mode.compass.ada')).toBe('floating');

  // Entering fullscreen from floating and pressing Escape steps back to floating while keeping focus in the composer.
  await user.click(screen.getByRole('button', { name: 'Full screen' }));
  expect(screen.getByRole('complementary', { name: 'Assistant' })).toHaveClass('assistant-panel-expanded');
  const box = screen.getByRole('textbox', { name: 'Message the assistant' });
  box.focus();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('complementary', { name: 'Assistant' })).toHaveClass('assistant-panel-floating');
  expect(box).toHaveFocus();
  expect(onClose).not.toHaveBeenCalled();

  // Reopening restores floating mode.
  first.unmount();
  draw(<AssistantPanel app="compass" record={false} onClose={onClose} />);
  expect(await screen.findByRole('button', { name: 'Floating window' })).toHaveAttribute('aria-pressed', 'true');
});

test('reasoning streams into a collapsible surface, respects hidden/expanded settings, and effortPicker sends per-turn effort', async () => {
  mocks.app = {
    name: 'compass',
    resources: {},
    assistant: { icon: 'chat-circle', reasoning: 'collapsed', effort: 'medium', effortPicker: true },
  };
  const stream = held();
  turnsAnswer(() => stream.response);
  const user = userEvent.setup();
  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  // Effort selector is rendered when effortPicker is enabled.
  expect(await screen.findByRole('button', { name: /Reasoning effort/ })).toBeInTheDocument();
  await user.type(screen.getByRole('textbox', { name: 'Message the assistant' }), 'Think carefully{Enter}');
  expect(bodies()[0]).toEqual(['/api/assistant/turn', { app: 'compass', text: 'Think carefully', effort: 'medium' }]);

  stream.say('conversation', { id: 'c1', title: 'Think', person: 1 });
  stream.say('reasoning', { id: 'r0', delta: 'Evaluating lead conversion rates.' });
  expect(await screen.findByText('Thinking…')).toBeInTheDocument();
  stream.say('reasoning', { id: 'r0', done: true, durationMs: 2400 });
  stream.say('text', { delta: 'Conversion is 32%.' });
  stream.say('done', { state: 'idle', tokens: 12 });
  stream.end();

  expect(await screen.findByText('Conversion is 32%.')).toBeInTheDocument();
  const trigger = screen.getByRole('button', { name: /Thought for 2\.4s/ });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await user.click(trigger);
  expect(screen.getByText('Evaluating lead conversion rates.')).toBeVisible();
});

test('renders callout, timeline, tabs, and custom generative UI blocks safely without raw markup', async () => {
  const user = userEvent.setup();
  fetcher.mockImplementation(async (url) => {
    const path = String(url);
    if (path.startsWith('/api/assistant?')) return json({ conversations: [], ready: true });
    if (path === '/api/assistant/turn')
      return events(
        ['conversation', { id: 'c1', title: 'Overview', person: 1 }],
        [
          'block',
          {
            id: 'b1',
            block: {
              kind: 'callout',
              tone: 'warning',
              title: 'Renewal risk',
              body: 'Check [Acme Corp](/compass/leads/1) soon.',
            },
          },
        ],
        [
          'block',
          {
            id: 'b2',
            block: {
              kind: 'tabs',
              title: 'Activity breakdown',
              tabs: [
                {
                  id: 'tab-1',
                  label: 'Timeline',
                  block: {
                    kind: 'timeline',
                    table: 'lead',
                    items: [{ label: 'Acme Corp', when: '2026-09-01', badge: 'new', detail: 'Inbound lead', address: '/compass/leads/1' }],
                  },
                },
                {
                  id: 'tab-2',
                  label: 'Summary',
                  block: {
                    kind: 'custom',
                    name: 'lease_summary',
                    title: 'Lease risk',
                    props: { riskScore: 84, tier: 'high' },
                  },
                },
              ],
            },
          },
        ],
        ['done', { state: 'idle', tokens: 15 }],
      );
    return json({ error: 'unexpected' }, 404);
  });
  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  await user.type(await screen.findByRole('textbox', { name: 'Message the assistant' }), 'Show overview{Enter}');
  expect(await screen.findByText('Renewal risk')).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: 'Acme Corp' })[0]).toHaveAttribute('href', '/compass/leads/1');
  expect(screen.getByText('Inbound lead')).toBeInTheDocument();
  // Switch tabs to reveal the custom structured block.
  await user.click(screen.getByRole('tab', { name: 'Summary' }));
  expect(await screen.findByText('Lease risk')).toBeInTheDocument();
  expect(screen.getByText('84')).toBeInTheDocument();
});

test('multi-agent switcher changes starters and sends agent id; delegation card and Canvas split pane render and dismiss cleanly', async () => {
  const user = userEvent.setup();
  let sentBody: Record<string, unknown> | undefined;
  mocks.app = {
    name: 'compass',
    resources: {},
    assistant: {
      icon: 'chat-circle',
      defaultAgent: 'deal_desk',
      agents: [
        {
          id: 'deal_desk',
          name: 'Deal Desk',
          description: 'Triages open opportunities.',
          starters: ['Review stale deals'],
        },
        {
          id: 'rev_ops',
          name: 'RevOps Analyst',
          description: 'Audits pipeline risk.',
          starters: ['Audit Q4 risk'],
        },
      ],
    },
  };
  fetcher.mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/assistant?')) return json({ conversations: [], ready: true });
    if (path === '/api/assistant/turn') {
      sentBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return events(
        ['conversation', { id: 'c_wave1', title: 'Audit Q4 risk', agent: 'rev_ops', person: 1 }],
        [
          'delegation',
          {
            id: 'd_1',
            fromAgent: 'rev_ops',
            fromAgentName: 'RevOps Analyst',
            agent: 'deal_desk',
            agentName: 'Deal Desk',
            task: 'Check Acme Corp renewal',
            status: 'done',
            summary: 'Acme Corp is healthy.',
            durationMs: 650,
          },
        ],
        [
          'block',
          {
            id: 'b_custom',
            block: {
              kind: 'custom',
              name: 'deal_scorecard',
              title: 'Acme Deal Scorecard',
              props: { account: 'Acme Corp', score: 92 },
            },
          },
        ],
        ['done', { state: 'idle', tokens: 20 }],
      );
    }
    return json({ error: 'unexpected' }, 404);
  });

  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  // Default agent starter is shown.
  expect(await screen.findByRole('button', { name: 'Review stale deals' })).toBeInTheDocument();
  // Switch agent via the Agent Switcher select.
  const switcher = screen.getByRole('button', { name: /Agent/ });
  await user.click(switcher);
  await user.click(await screen.findByRole('option', { name: 'RevOps Analyst' }));
  // Starters update to the newly selected agent's starters.
  const starterBtn = await screen.findByRole('button', { name: 'Audit Q4 risk' });
  await user.click(starterBtn);

  expect(await screen.findByText('Acme Corp is healthy.')).toBeInTheDocument();
  expect(sentBody?.agent).toBe('rev_ops');
  // Delegation route & custom block appear.
  expect(screen.getByText('Check Acme Corp renewal')).toBeInTheDocument();
  expect(screen.getByText('Acme Deal Scorecard')).toBeInTheDocument();

  // Open the custom block in the Canvas pane and close it cleanly.
  await user.click(screen.getByRole('button', { name: 'Open in Canvas' }));
  expect(screen.getByRole('region', { name: 'Canvas' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Close Canvas' }));
  expect(screen.queryByRole('region', { name: 'Canvas' })).not.toBeInTheDocument();
});

test('Wave 2A: renders inline clickable citations, Sources strip, memory chip, and interactive Memory Drawer', async () => {
  const user = userEvent.setup();
  let storedMemories: Array<{
    id: string;
    scope: 'person' | 'app';
    agent: string;
    content: string;
    source: 'assistant' | 'person';
    createdAt: string;
    updatedAt: string;
  }> = [
    {
      id: 'm_personal_1',
      scope: 'person',
      agent: '',
      content: 'Prefer concise executive bullet points.',
      source: 'assistant',
      createdAt: '2026-11-27T10:00:00Z',
      updatedAt: '2026-11-27T10:00:00Z',
    },
    {
      id: 'm_shared_1',
      scope: 'app',
      agent: '',
      content: 'Enterprise renewals require 60-day advance legal review.',
      source: 'person',
      createdAt: '2026-11-27T09:00:00Z',
      updatedAt: '2026-11-27T09:00:00Z',
    },
  ];
  mocks.app = {
    id: 'compass',
    name: 'Compass',
    resources: {},
    views: {},
    assistant: {
      memory: { scopes: ['person', 'app'], maxItems: 50, canWriteShared: true },
      knowledge: [{ id: 'playbooks', resource: 'playbook', description: 'Sales playbooks' }],
    },
  };
  fetcher.mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/assistant?')) return json({ conversations: [], ready: true });
    if (path.startsWith('/api/assistant/memories?') && (!init?.method || init.method === 'GET')) {
      return json({ memories: storedMemories, scopes: ['person', 'app'], maxItems: 50, canWriteShared: true });
    }
    if (path === '/api/assistant/memories' && init?.method === 'POST') {
      const payload = JSON.parse(String(init.body)) as { content: string; scope: 'person' | 'app'; id?: string };
      const added = {
        id: payload.id ?? 'm_new_1',
        scope: payload.scope,
        agent: '',
        content: payload.content,
        source: 'person' as const,
        createdAt: '2026-11-27T11:00:00Z',
        updatedAt: '2026-11-27T11:00:00Z',
      };
      storedMemories = [...storedMemories, added];
      return json({ memory: added, updated: false });
    }
    if (path === '/api/assistant/memories/delete' && init?.method === 'POST') {
      const payload = JSON.parse(String(init.body)) as { id: string };
      storedMemories = storedMemories.filter((m) => m.id !== payload.id);
      return json({ deleted: true });
    }
    if (path === '/api/assistant/turn') {
      return events(
        ['conversation', { id: 'c_w2', title: 'Renewal policy', person: 1 }],
        [
          'citations',
          {
            id: 'cit_1',
            query: 'enterprise renewal',
            items: [
              {
                ref: 1,
                source: 'playbooks',
                sourceLabel: 'Playbooks',
                resource: 'playbook',
                title: 'Enterprise Renewal Playbook',
                snippet: 'Start executive alignment 60 days prior to renewal date.',
                address: '/compass/playbooks/1',
              },
            ],
          },
        ],
        [
          'memory',
          {
            id: 'mem_ev_1',
            action: 'remembered',
            memoryId: 'm_personal_1',
            scope: 'person',
            content: 'Prefer concise executive bullet points.',
          },
        ],
        ['text', { delta: 'Per the renewal playbook [1], start alignment 60 days ahead.' }],
        ['done', { state: 'idle', tokens: 18 }],
      );
    }
    return json({ error: 'unexpected' }, 404);
  });

  draw(<AssistantPanel app="compass" record={false} onClose={() => {}} />);
  const box = await screen.findByRole('textbox', { name: 'Message the assistant' });
  await user.type(box, 'What is our enterprise renewal process?{Enter}');

  // Inline citation pill [1], Sources strip, and Remembered chip all render.
  expect(await screen.findByRole('button', { name: 'Open Enterprise Renewal Playbook' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Cited sources' })).toBeInTheDocument();
  expect(screen.getByText('Enterprise Renewal Playbook')).toBeInTheDocument();
  expect(screen.getByText('Remembered')).toBeInTheDocument();

  // Open Memory Drawer from the Remembered chip's Manage button.
  await user.click(screen.getByRole('button', { name: 'Manage' }));
  expect(await screen.findByRole('region', { name: 'Assistant memory' })).toBeInTheDocument();
  expect(await screen.findByText('Prefer concise executive bullet points.')).toBeInTheDocument();
  expect(screen.getByText('Enterprise renewals require 60-day advance legal review.')).toBeInTheDocument();

  // Add a new memory inside the drawer.
  await user.type(screen.getByRole('textbox', { name: 'Add memory' }), 'Highlight churn risk first.');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Highlight churn risk first.')).toBeInTheDocument();

  // Close drawer cleanly.
  await user.click(screen.getByRole('button', { name: 'Close memory' }));
  expect(screen.queryByRole('region', { name: 'Assistant memory' })).not.toBeInTheDocument();
});
