/**
 * The timeline section as a conversation: oldest first and scrolled to its end, rows dressed by the section's rules,
 * a composer that runs the commands the author named and shows only the modes this reader is granted.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, createElement, type ReactNode } from 'react';

const runs: Array<{ ref: string; key: unknown; input: unknown }> = [];
let granted = new Set(['reply', 'note']);
/* What the stream answers; a test may give its own rows. */
let streamRows: Array<Record<string, unknown>> = [];
/* A second stream's rows, by the name its view carries. */
let otherRows: Array<Record<string, unknown>> = [];
/* The keys of the rows the section's `side` picks out. */
let sideRows: Array<Record<string, unknown>> = [];
const threeRows = [
  { at: '2026-10-03T10:00:00Z', body: 'Newest', kind: 'reply' },
  { at: '2026-10-02T10:00:00Z', body: 'Escalated', kind: 'system' },
  { at: '2026-10-01T10:00:00Z', body: 'Oldest', kind: 'internal' },
];

const asked: unknown[] = [];
vi.mock('@mistriwork/ui/anchor.js', () => ({ zoomAnchor: () => null, layoutViewport: () => ({ x: 0, y: 0, width: 1200, height: 900 }) }));
vi.mock('../core.js', () => ({
  findTable: () => undefined,
  state: { schema: null },
  toast: vi.fn(),
  api: async (_path: string, body: unknown) => {
    asked.push(body);
    return {
      rows: [
        { title: 'Restart', body: 'Please restart the router and tell us if it helps.' },
        { title: 'Apology', body: 'Sorry for the wait — we are on it.' },
      ],
    };
  },
}));
vi.mock('../../../../mistri/src/client/appState.js', () => ({ activeApp: () => null, inAppMode: () => true }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('./appRooms.js', () => ({ resourceOf: () => undefined }));
vi.mock('../insert.js', () => ({ canInsert: () => false, openRelatedRecord: vi.fn() }));
vi.mock('./listColumn.js', () => ({ listColumn: () => undefined }));
vi.mock('./Value.js', () => ({ Value: ({ value }: { value: unknown }) => createElement('span', null, String(value)) }));
vi.mock('./PageSectionBox.js', () => ({
  Loading: () => createElement('p', null, 'loading'),
  SectionBox: ({ body }: { body: ReactNode }) => createElement('section', null, body),
}));
vi.mock('./pageContext.js', () => ({
  PageRenderContext: createContext({}),
  usePageApi: () => async (_path: string, body: { view: { name?: string } }) =>
    body.view.name === 'side'
      ? { view: true, columns: ['id'], rows: sideRows }
      : { view: true, columns: ['at', 'body', 'kind', 'by', 'id'], rows: body.view.name === 'other' ? otherRows : streamRows },
}));
vi.mock('../../../../mistri/src/client/components/sdk/commands.js', () => ({
  actionOf: () => ({ command: { input: [{ name: 'body', type: 'textarea' }] } }),
  commandHandle: (ref: string) => ({
    granted: granted.has(ref),
    run: async (key: unknown, input: unknown) => {
      runs.push({ ref, key, input });
      return { status: 'applied' };
    },
  }),
}));

const { TimelineSection } = await import('./PageTimeline.js');
const { fillComposer } = await import('./composerDraft.js');

const plan = {
  streams: [
    {
      from: 'message',
      path: 'ticket_id',
      at: 'at',
      show: 'body',
      detail: 'kind',
      by: 'by',
      view: { columns: [{ path: 'at' }, { path: 'body' }, { path: 'kind' }, { path: 'by' }] },
    },
  ],
};
const section = {
  kind: 'timeline',
  newest: 'last',
  limit: 20,
  streams: [{ from: 'message', path: 'ticket_id' }],
  tone: { kind: { internal: 'warn' } },
  compact: { kind: ['system'] },
  composer: { reply: 'reply', note: 'note' },
};

const twoStreams = {
  streams: [plan.streams[0], { ...plan.streams[0], from: 'work_time', view: { ...plan.streams[0].view, name: 'other' } }],
};

function draw(over: object = {}, drawn: object = plan) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(TimelineSection as never, {
        section: { ...section, ...over },
        plan: drawn,
        base: { id: 'ticket', columns: [] },
        recordKey: { id: 7 },
      }),
    ),
  );
}

beforeEach(() => {
  /* Only Date is faked: "Today" and "Yesterday" are said from the clock, and the queries' timers stay real. */
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
  streamRows = threeRows.map((row) => ({ ...row, by: row.kind === 'system' ? null : 'Robin Bell' }));
  otherRows = [];
  sideRows = [];
  runs.length = 0;
  granted = new Set(['reply', 'note']);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('a conversation timeline', () => {
  test('reads oldest first, tints an internal note and draws a system line as one quiet row', async () => {
    draw();
    await screen.findByText('Oldest');
    const rows = [...document.querySelectorAll('.timeline-row')];
    expect(rows.map((row) => row.querySelector('.timeline-text')?.textContent)).toEqual(['Oldest', 'Escalated', 'Newest']);
    expect(rows[0].getAttribute('data-tone')).toBe('warn');
    expect(rows[1].classList.contains('is-compact')).toBe(true);
    expect(rows[2].hasAttribute('data-tone')).toBe(false);
    // An internal note is a card in its column, not a band.
    expect(rows[0].classList.contains('is-tinted')).toBe(true);
    expect(rows[2].classList.contains('is-tinted')).toBe(false);
  });

  test('a message says who, what kind and when before its words', async () => {
    draw();
    await screen.findByText('Oldest');
    const message = document.querySelector('.timeline-row:not(.is-compact)')!;
    expect([...message.children].map((child) => child.className.split(' ')[0])).toEqual([
      'timeline-avatar',
      'timeline-head',
      'timeline-text',
    ]);
    expect(message.querySelector('.timeline-avatar')!.textContent).toBe('RB');
    const head = message.querySelector('.timeline-head')!;
    expect([...head.children].map((child) => child.className)).toEqual(['timeline-by', 'timeline-kind', 'timeline-when']);
    expect(head.querySelector('.timeline-by')!.textContent).toBe('Robin Bell');
    expect(head.querySelector('.timeline-kind')!.textContent).toBe('internal');
    expect(head.querySelector('time')!.getAttribute('dateTime')).toBe('2026-10-01T10:00:00Z');
    expect(head.querySelector('time')!.getAttribute('title')).toBeTruthy();
  });

  test('the days head their rows, once each, in the order the rows are read', async () => {
    streamRows = [
      { at: '2026-10-03T11:00:00Z', body: 'Later today', kind: 'reply', by: 'Robin Bell' },
      ...streamRows,
      { at: '2025-12-24T10:00:00Z', body: 'Last year', kind: 'reply', by: 'Robin Bell' },
    ];
    draw();
    await screen.findByText('Oldest');
    expect([...document.querySelectorAll('.timeline-day-label')].map((day) => [day.getAttribute('dateTime'), day.textContent])).toEqual([
      ['2025-12-24', 'Dec 24, 2025'],
      ['2026-10-01', 'Oct 1'],
      ['2026-10-02', 'Yesterday'],
      ['2026-10-03', 'Today'],
    ]);
    expect(document.querySelectorAll('.timeline-day')[3]!.querySelectorAll('.timeline-row')).toHaveLength(2);
  });

  test('two or more lines no person wrote fold to their count, opened by a click or the keyboard', async () => {
    const user = userEvent.setup();
    streamRows = [
      { at: '2026-10-03T10:05:00Z', body: 'Thanks', kind: 'reply', by: 'Robin Bell' },
      { at: '2026-10-03T10:03:00Z', body: 'State: In progress', kind: 'system', by: null },
      { at: '2026-10-03T10:02:00Z', body: 'Assigned to Jordan', kind: 'system', by: null },
      { at: '2026-10-03T10:01:00Z', body: 'Opened by phone', kind: 'system', by: null },
      { at: '2026-10-03T10:00:00Z', body: 'Printer offline', kind: 'reply', by: 'Jamie Holt' },
    ];
    draw();
    await screen.findByText('Printer offline');
    const toggle = screen.getByRole('button', { name: '3 updates' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const events = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(events.hidden).toBe(true);
    expect(events.querySelectorAll('.timeline-row.is-compact')).toHaveLength(3);
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(events.hidden).toBe(false);
    expect([...events.querySelectorAll('.timeline-text')].map((row) => row.textContent)).toEqual([
      'Opened by phone',
      'Assigned to Jordan',
      'State: In progress',
    ]);
    await user.click(toggle);
    expect(events.hidden).toBe(true);
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard(' ');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  test('one line no person wrote stands alone, unfolded', async () => {
    draw();
    await screen.findByText('Escalated');
    expect(screen.queryByRole('button', { name: /update/ })).toBeNull();
  });

  test('without newest it stays newest first', async () => {
    draw({ newest: undefined, composer: undefined });
    await screen.findByText('Oldest');
    expect([...document.querySelectorAll('.timeline-text')].map((row) => row.textContent)).toEqual(['Newest', 'Escalated', 'Oldest']);
  });

  test('the composer sends the text through the mode that is chosen', async () => {
    const user = userEvent.setup();
    draw();
    await screen.findByText('Oldest');
    await user.type(screen.getByRole('textbox', { name: 'Reply' }), 'On it');
    await user.click(document.querySelector<HTMLButtonElement>('.timeline-composer button[type="submit"]')!);
    await waitFor(() => expect(runs).toEqual([{ ref: 'reply', key: { id: 7 }, input: { body: 'On it' } }]));
    await user.click(screen.getByRole('button', { name: 'Internal note' }));
    await user.type(screen.getByPlaceholderText(/internal note/i), 'Ask billing');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(runs.at(-1)).toEqual({ ref: 'note', key: { id: 7 }, input: { body: 'Ask billing' } }));
  });

  test("a custom section's fill puts words in the box and chooses the mode, sending nothing; with no composer it says so", async () => {
    draw();
    await screen.findByText('Oldest');
    act(() => void expect(fillComposer('Thanks for waiting', 'note')).toBe(true));
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Internal note' }).value).toBe('Thanks for waiting');
    expect(screen.getByRole('button', { name: 'Internal note', pressed: true })).toBeTruthy();
    expect(runs).toEqual([]);
    cleanup();
    expect(fillComposer('Nobody hears this')).toBe(false);
  });

  test('a template fills the box with its text, asked for only when the menu opens, and sends nothing', async () => {
    const user = userEvent.setup();
    asked.length = 0;
    draw({ composer: { reply: 'reply', templates: { from: 'canned_reply', labelColumn: 'title', text: 'body' } } });
    await screen.findByText('Oldest');
    expect(asked).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Templates' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Apology', 'Restart']);
    expect(asked).toEqual([{ q: 'canned_reply', limit: 200, count: 'none' }]);
    await user.click(items[1]);
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Reply' }).value).toBe(
      'Please restart the router and tell us if it helps.',
    );
    expect(runs).toEqual([]);
  });

  test("a template's query says which rows are offered: a retired response is not", async () => {
    const user = userEvent.setup();
    asked.length = 0;
    draw({
      composer: { reply: 'reply', templates: { from: 'canned_reply', labelColumn: 'title', text: 'body', query: 'active = true' } },
    });
    await screen.findByText('Oldest');
    await user.click(screen.getByRole('button', { name: 'Templates' }));
    await screen.findAllByRole('menuitem');
    expect(asked).toEqual([{ q: 'canned_reply active = true', limit: 200, count: 'none' }]);
  });

  test('a mode the reader is not granted is not offered, and with none there is no composer', async () => {
    granted = new Set(['reply']);
    draw();
    await screen.findByText('Oldest');
    expect(screen.queryByRole('button', { name: 'Internal note' })).toBeNull();
    cleanup();
    granted = new Set();
    draw();
    await screen.findByText('Oldest');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  test('a message names its stream only where the messages come from more than one', async () => {
    // One stream: no source.
    draw();
    await screen.findByText('Oldest');
    expect(document.querySelector('.timeline-source')).toBeNull();
    cleanup();
    // A second stream of quiet lines only (time logged): the messages are all one stream's, so still none.
    otherRows = [{ at: '2026-10-02T11:00:00Z', body: 'Logged 30m', kind: 'system', by: 'Robin Bell' }];
    draw({}, twoStreams);
    await screen.findByText('Logged 30m');
    expect(document.querySelector('.timeline-source')).toBeNull();
    cleanup();
    // A second stream with a message of its own: every message says where it came from.
    otherRows = [{ at: '2026-10-02T11:00:00Z', body: 'Called back', kind: 'call', by: 'Robin Bell' }];
    draw({}, twoStreams);
    await screen.findByText('Called back');
    expect(document.querySelectorAll('.timeline-source').length).toBe(3);
  });

  test("a stream's own tone and compact dress all its rows, in place of the section's rules", async () => {
    // Time logged carries no kind: its stream says it is one quiet line each, and the messages keep their rules.
    otherRows = [{ at: '2026-10-02T11:00:00Z', body: 'Logged 30m', kind: null, by: 'Robin Bell' }];
    draw(
      {
        streams: [
          { from: 'message', path: 'ticket_id' },
          { from: 'work_time', path: 'ticket_id', compact: true, tone: 'info' },
        ],
      },
      twoStreams,
    );
    await screen.findByText('Logged 30m');
    const logged = screen.getByText('Logged 30m').closest('li')!;
    expect(logged.classList.contains('is-compact')).toBe(true);
    expect(logged.getAttribute('data-tone')).toBe('info');
    expect(screen.getByText('Oldest').closest('li')!.getAttribute('data-tone')).toBe('warn');
    expect(screen.getByText('Newest').closest('li')!.classList.contains('is-compact')).toBe(false);
  });

  describe("a conversation's other side", () => {
    const sided = {
      streams: [
        {
          ...plan.streams[0],
          key: ['id'],
          view: { columns: [...plan.streams[0].view.columns, { path: 'id' }] },
          side: { view: { name: 'side', columns: [{ path: 'id' }] } },
        },
      ],
    };
    const conversation = [
      { id: 1, at: '2026-10-03T09:00:00Z', body: 'My printer is jammed', kind: 'reply', by: 'Ada Caller' },
      { id: 2, at: '2026-10-03T09:01:00Z', body: 'It says paper out', kind: 'reply', by: 'Ada Caller' },
      { id: 3, at: '2026-10-03T09:05:00Z', body: 'Opening the tray now', kind: 'reply', by: 'Robin Bell' },
      { id: 4, at: '2026-10-03T09:06:00Z', body: 'Assigned to Robin', kind: 'system', by: 'Ada Caller' },
      { id: 5, at: '2026-10-03T09:07:00Z', body: 'Checking the spool', kind: 'internal', by: 'Robin Bell' },
      { id: 6, at: '2026-10-03T09:08:00Z', body: 'Still jammed', kind: 'reply', by: 'Ada Caller' },
    ];
    const row = (text: string) => screen.getByText(text).closest('li')!;

    test('the rows the condition picks are drawn on the other side, the rest where they were', async () => {
      streamRows = conversation;
      sideRows = [{ id: 1 }, { id: 2 }, { id: 4 }, { id: 6 }];
      draw({ side: 'author_id = record.caller_id' }, sided);
      await screen.findByText('My printer is jammed');
      expect(row('My printer is jammed').classList.contains('is-other')).toBe(true);
      expect(row('Still jammed').classList.contains('is-other')).toBe(true);
      expect(row('Opening the tray now').classList.contains('is-other')).toBe(false);
      // A one-line row stays a line across the whole width, whoever wrote it.
      expect(row('Assigned to Robin').classList.contains('is-other')).toBe(false);
      // The section's tone still reads the row's own columns.
      expect(row('Checking the spool').dataset.tone ?? row('Checking the spool').className).toMatch(/warn/);
    });

    test("an author's name shows once per run of their rows, and the time stays with every row", async () => {
      streamRows = conversation;
      sideRows = [{ id: 1 }, { id: 2 }, { id: 4 }, { id: 6 }];
      draw({ side: 'author_id = record.caller_id' }, sided);
      await screen.findByText('My printer is jammed');
      expect(row('My printer is jammed').classList.contains('is-continued')).toBe(false);
      expect(row('It says paper out').classList.contains('is-continued')).toBe(true);
      expect(row('It says paper out').querySelector('time')).toBeTruthy();
      expect(row('It says paper out').querySelector('.timeline-by')).toBeNull();
      // A different author, a different side or a different tone starts a new run.
      expect(row('Opening the tray now').classList.contains('is-continued')).toBe(false);
      expect(row('Checking the spool').classList.contains('is-continued')).toBe(false);
      expect(row('Still jammed').classList.contains('is-continued')).toBe(false);
    });

    test("a stream's own side sets its rows apart where the section names none", async () => {
      streamRows = conversation;
      sideRows = [{ id: 1 }, { id: 2 }, { id: 4 }, { id: 6 }];
      draw({ streams: [{ from: 'message', path: 'ticket_id', side: 'author_id = record.caller_id' }] }, sided);
      await screen.findByText('My printer is jammed');
      expect(row('My printer is jammed').classList.contains('is-other')).toBe(true);
      expect(row('It says paper out').classList.contains('is-continued')).toBe(true);
      expect(row('Opening the tray now').classList.contains('is-other')).toBe(false);
    });

    test('without a side nothing more is asked and no row is set apart', async () => {
      streamRows = conversation;
      draw();
      await screen.findByText('My printer is jammed');
      expect(document.querySelector('.is-other, .is-continued')).toBeNull();
    });
  });
});
