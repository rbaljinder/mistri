/**
 * A page's history section: each write as one entry — who, what, when —
 * its fields from what to what in the App's words, a reference by its
 * record's name, a field the reader may not read or the App redacts said
 * only as changed, the shared empty note, and earlier changes on request.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import type { PageSection } from './pageModel.js';
import { setMessageLanguage } from '../messages.js';

const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
let pages: Array<{ entries: unknown[]; more?: number }> = [];
/* How a person is named: a column, or a template the catalog computes as `$label`. */
let personName = 'name';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const person: TableMeta = {
  id: 'person',
  name: 'person',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('name', 'TEXT')] as TableMeta['columns'],
};
const task: TableMeta = {
  id: 'task',
  name: 'task',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('title', 'TEXT'),
    col('due_on', 'DATE'),
    col('owner_id', 'INTEGER', { references: { table: 'person', column: 'id' } }),
    col('salary', 'INTEGER'),
  ] as TableMeta['columns'],
};
const tables: Record<string, TableMeta> = { person, task };

vi.mock('../core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core.js')>()),
  findTable: (id: string) => tables[id],
  columnLabel: (_table: string, column: string) => (column === 'due_on' ? 'Due' : null),
  labelPath: (table: TableMeta) => (table.id === 'person' ? personName : undefined),
  recordLabel: () => undefined,
  api: async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    if (path === '/api/record-history') return pages[body.before === undefined ? 0 : 1];
    if (path === '/api/query')
      return {
        rows: [
          { id: 1, name: 'Ann Lee' },
          { id: 2, name: 'Bo Chen' },
        ],
      };
    if (path === '/api/view/run')
      return {
        rows: [
          { id: 1, $label: 'Ann Lee' },
          { id: 2, $label: 'Bo Chen' },
        ],
      };
    throw new Error(`unexpected ${path}`);
  },
}));

const { RecordHistory, whoWrote, whatWrote } = await import('./PageHistory.js');
const { api } = await import('../core.js');
const { SectionBox } = await import('./PageSectionBox.js');

function draw(extra: Partial<PageSection> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const section: PageSection = { kind: 'history', ...extra };
  // Framed as PageSections.tsx frames it.
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(RecordHistory, {
        section,
        base: task,
        recordKey: { id: 1 },
        api: api as never,
        loading: null,
        frame: (body, broken) => createElement(SectionBox, { section, body, foldable: false, broken }),
      }),
    ),
  );
}

beforeEach(() => {
  calls.length = 0;
  personName = 'name';
});
afterEach(() => {
  cleanup();
  void setMessageLanguage('en');
});

test('each write is one entry: who, the action it came from, and each field from what to what', async () => {
  pages = [
    {
      entries: [
        {
          at: '2026-09-20T14:05:00.000Z',
          kind: 'update',
          via: 'app',
          by: 'Maya Chen',
          action: 'Reassign',
          fields: [
            { column: 'owner_id', before: 1, after: 2 },
            { column: 'due_on', before: '2026-09-01', after: '2026-09-30' },
          ],
        },
        {
          at: '2026-09-19T09:00:00.000Z',
          kind: 'update',
          via: 'agent',
          fields: [
            { column: 'salary', redacted: true },
            { column: 'secret', hidden: true, label: 'Secret note' },
          ],
        },
        { at: '2026-09-18T09:00:00.000Z', kind: 'insert', via: 'app', by: 'Sam Ortiz', fields: [{ column: 'title', after: 'Call back' }] },
      ],
    },
  ];
  draw();
  expect(await screen.findByRole('heading', { name: 'History' })).toBeTruthy();
  const [reassign, agent, created] = document.querySelectorAll('.history-entry');
  expect(within(reassign as HTMLElement).getByText('Maya Chen')).toHaveClass('history-by');
  expect(within(reassign as HTMLElement).getByText('Reassign')).toBeTruthy();
  // The caption is the App's, and a reference is its record's name.
  expect(within(reassign as HTMLElement).getByText('Due')).toBeTruthy();
  expect(await within(reassign as HTMLElement).findByText('Bo Chen')).toBeTruthy();
  expect(
    within(reassign as HTMLElement)
      .getByText('Ann Lee')
      .closest('.history-before'),
  ).toBeTruthy();
  expect(calls.find((call) => call.path === '/api/query')?.body).toMatchObject({
    table: 'person',
    filter: { groups: [[{ column: 'id', op: 'in', value: ['1', '2'] }]] },
  });
  // Redacted and unreadable fields say only that they changed.
  expect(within(agent as HTMLElement).getByText('An agent')).toBeTruthy();
  expect(within(agent as HTMLElement).getByText('Secret note')).toBeTruthy();
  expect(within(agent as HTMLElement).getAllByText('changed')).toHaveLength(2);
  expect(agent.querySelector('.history-before, .history-after')).toBeNull();
  expect(within(created as HTMLElement).getByText('Created')).toBeTruthy();
  expect(created.querySelector('.history-before')).toBeNull();
  expect(calls[0]).toMatchObject({ path: '/api/record-history', body: { table: 'task', key: { id: 1 }, limit: 8 } });
});

test('a history shows eight writes unless it says more, and an untitled one is headed with the shell word', async () => {
  pages = [{ entries: [] }];
  draw();
  expect(await screen.findByText('No changes recorded yet.')).toBeTruthy();
  expect(calls[0].body.limit).toBe(8);
  expect(screen.getByRole('heading', { name: 'History' })).toBeTruthy();
  cleanup();
  calls.length = 0;
  draw({ limit: 50 });
  await screen.findByText('No changes recorded yet.');
  expect(calls[0].body.limit).toBe(50);
});

test("an untitled history is headed in the reader's language; a title the author wrote is kept", async () => {
  pages = [{ entries: [] }];
  await setMessageLanguage('es');
  draw();
  expect(await screen.findByRole('heading', { name: 'Historial' })).toBeTruthy();
  cleanup();
  draw({ title: 'Changes' });
  expect(await screen.findByRole('heading', { name: 'Changes' })).toBeTruthy();
});

test('a reference named by a template is read where the name is computed, a view, never a plain query', async () => {
  // A plain read has no `$label` column: in a tenant App, asking for one ended the session.
  personName = '$label';
  pages = [
    {
      entries: [
        {
          at: '2026-09-20T14:05:00.000Z',
          kind: 'update',
          via: 'app',
          by: 'Maya Chen',
          fields: [{ column: 'owner_id', before: 1, after: 2 }],
        },
      ],
    },
  ];
  draw();
  expect(await screen.findByText('Bo Chen')).toBeTruthy();
  expect(calls.some((call) => call.path === '/api/query')).toBe(false);
  expect(calls.find((call) => call.path === '/api/view/run')?.body).toMatchObject({
    view: {
      base: 'person',
      columns: expect.arrayContaining([{ path: '$label' }]),
      filter: { groups: [[{ path: 'id', op: 'in', value: ['1', '2'] }]] },
    },
  });
});

test('a record nothing has changed says so in the shared empty note', async () => {
  pages = [{ entries: [] }];
  draw({ title: 'Changes' });
  expect(await screen.findByText('No changes recorded yet.')).toBeTruthy();
  expect(document.querySelector('.empty-note')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Changes' })).toBeTruthy();
});

test('earlier changes are read on request, from where the last page ended', async () => {
  pages = [
    {
      entries: [
        {
          at: '2026-09-20T14:05:00.000Z',
          kind: 'update',
          via: 'app',
          by: 'Priya Das',
          fields: [{ column: 'title', before: 'B', after: 'C' }],
        },
      ],
      more: 41,
    },
    {
      entries: [
        {
          at: '2026-09-10T14:05:00.000Z',
          kind: 'update',
          via: 'app',
          by: 'Omar Reyes',
          fields: [{ column: 'title', before: 'A', after: 'B' }],
        },
      ],
    },
  ];
  draw({ limit: 1 });
  await userEvent.click(await screen.findByRole('button', { name: 'Show earlier changes' }));
  expect(await screen.findByText('Omar Reyes')).toBeTruthy();
  expect(calls.filter((call) => call.path === '/api/record-history').map((call) => call.body.before)).toEqual([undefined, 41]);
  expect(screen.queryByRole('button', { name: 'Show earlier changes' })).toBeNull();
});

test('who and what are said in words when no person or action is named', () => {
  expect(whoWrote({ via: 'form' })).toBe('A public form');
  // A person the history keeps no name for is someone; an address is never said, even as a name.
  expect(whoWrote({ via: 'app' })).toBe('Someone');
  expect(whoWrote({ via: 'app', by: 'nora@commons.example.test' })).toBe('Someone');
  expect(whoWrote({ via: 'app', by: 'Nora Whitaker' })).toBe('Nora Whitaker');
  expect(whoWrote({ via: 'system' })).toBe('The system');
  expect(whatWrote({ kind: 'update' })).toBe('Edited');
  expect(whatWrote({ kind: 'update', action: 'Approve' })).toBe('Approve');
});
