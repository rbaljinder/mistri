import { expect, test } from 'vitest';
import { applyEvent, grouped, inside, readEvents, waitingProposal, wordsOf, type PanelItem, type StreamEvent } from './assistantStream.js';

const body = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

test('reads events split anywhere across chunks, and drops what is not an event', async () => {
  const events: StreamEvent[] = [];
  await readEvents(
    body(['event: text\ndata: {"del', 'ta":"Hel"}\n\nevent: text\ndata: {"delta":"lo"}\n', '\nevent: x\ndata: not json\n\n']),
    (event) => events.push(event),
  );
  expect(events).toEqual([
    { event: 'text', data: { delta: 'Hel' } },
    { event: 'text', data: { delta: 'lo' } },
  ]);
});

test('a turn streamed reads as the stored one: text joined, steps and blocks in order, the text closed by a step', () => {
  let items: PanelItem[] = [{ type: 'person', text: 'Show stale deals' }];
  const events: StreamEvent[] = [
    { event: 'conversation', data: { id: 'c1', title: 'Show stale deals', person: 4 } },
    { event: 'text', data: { delta: 'Looking ' } },
    { event: 'text', data: { delta: 'now.' } },
    { event: 'running', data: { id: 't1', tool: 'show' } },
    { event: 'step', data: { id: 't1', tool: 'show', label: 'Showed Stale deals: 3 rows' } },
    { event: 'block', data: { id: 't1', block: { kind: 'section', section: { kind: 'rows', table: 'opportunity' } } } },
    { event: 'text', data: { delta: 'Three.' } },
    { event: 'step', data: { id: 7 } },
    { event: 'done', data: { state: 'idle' } },
  ];
  for (const event of events) items = applyEvent(items, event);
  expect(items).toEqual([
    { type: 'person', text: 'Show stale deals', seq: 4 },
    { type: 'text', text: 'Looking now.' },
    { type: 'step', id: 't1', tool: 'show', label: 'Showed Stale deals: 3 rows' },
    { type: 'block', id: 't1', block: { kind: 'section', section: { kind: 'rows', table: 'opportunity' } } },
    { type: 'text', text: 'Three.' },
  ]);
});

test('a proposal waits until its outcome, and a later message ends the wait', () => {
  const proposal = { id: 'p1', kind: 'set' as const, resource: 'lead', action: 'startWorking', label: 'Start working', values: {} };
  const items: PanelItem[] = [
    { type: 'person', text: 'start' },
    { type: 'proposal', id: 'p1', proposal },
  ];
  expect(waitingProposal(items)?.id).toBe('p1');
  expect(
    waitingProposal([...items.slice(0, 1), { type: 'proposal', id: 'p1', proposal, outcome: { status: 'declined' } }]),
  ).toBeUndefined();
  expect(waitingProposal([...items, { type: 'person', text: 'later' }])).toBeUndefined();
});

test('consecutive steps fold into one group', () => {
  const step = (id: string): PanelItem => ({ type: 'step', id, tool: 'find', label: id });
  const drawn = grouped([step('a'), step('b'), { type: 'text', text: 'x' }, step('c')]);
  expect(drawn.map((entry) => (entry.type === 'steps' ? entry.steps.length : entry.item.type))).toEqual([2, 'text', 1]);
});

test('words are runs of text with three marks; a link is followed only inside the App', () => {
  expect(wordsOf('See [Acme](/compass/accounts/3) and **now**, `stage`.\n\n- one\n- [two](https://evil.example)')).toEqual([
    {
      list: false,
      lines: [
        [
          { text: 'See ' },
          { text: 'Acme', link: '/compass/accounts/3' },
          { text: ' and ' },
          { text: 'now', mark: 'strong' },
          { text: ', ' },
          { text: 'stage', mark: 'code' },
          { text: '.' },
        ],
      ],
    },
    { list: true, lines: [[{ text: 'one' }], [{ text: 'two' }]] },
  ]);
  for (const href of ['javascript:alert(1)', '//evil.example/x', 'https://evil.example', '/\\evil.example'])
    expect(inside(href)).toBe(false);
  expect(inside('/compass/leads/127?tab=x')).toBe(true);
  // Markup in the model's words stays words.
  expect(wordsOf('<img src=x onerror=alert(1)>')).toEqual([{ list: false, lines: [[{ text: '<img src=x onerror=alert(1)>' }]] }]);
});
