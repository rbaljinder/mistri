/**
 * A related list of files draws as attachments, each renamable where the reader may change the row. A table the
 * reader only adds rows to (`appendOnly`) is never renamed after its upload; the same table without the word is,
 * so the refusal is the word's alone.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const mocks = vi.hoisted(() => ({ appendOnly: false }));
const upload = (): TableMeta =>
  ({
    id: 'upload',
    name: 'upload',
    schema: '',
    isView: false,
    ...(mocks.appendOnly ? { appendOnly: true } : {}),
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
      { name: 'file_name', type: 'TEXT', nullable: false, primaryKey: false },
    ],
  }) as TableMeta;
vi.mock('../core.js', () => {
  const core = {
    api: async () => ({ view: {}, columns: ['id', 'file_name'], rows: [{ id: 1, file_name: 'plan.pdf' }], more: false, total: 1 }),
    findTable: () => upload(),
    columnDisplay: () => null,
    columnLabel: () => null,
    labelPath: () => undefined,
    recordLabel: () => undefined,
    openRecord: () => {},
    rowLabel: (_t: unknown, row: Record<string, unknown>) => `#${row.id}`,
    writeAllowed: () => true,
    state: {
      activeConnection: 'demo',
      connections: [{ id: 'demo', writable: true }],
      schema: { tables: [], foreignKeys: [] },
    },
  };
  return { ...core, relatedApi: core.api };
});
vi.mock('../../../../mistri/src/client/appState.js', () => ({
  inAppMode: () => true,
  activeApp: () => ({ resources: { upload: { file: { content: 'data', name: 'file_name' } } } }),
}));
beforeEach(bridgeShell);
vi.mock('../prefs.js', () => ({ relatedRows: () => 10 }));
vi.mock('../insert.js', () => ({ canInsert: () => false, openRelatedRecord: () => {} }));
vi.mock('../../../../engine/src/shared/referenceModel.js', () => ({
  recordView: (_schema: unknown, _table: unknown, view: unknown) => ({
    view,
    labelColumns: {},
    hidden: [],
    keyColumns: [{ column: 'id' }],
    labelColumn: undefined,
  }),
  recordViewKey: (_keys: unknown, _columns: unknown, row: Record<string, unknown>) => ({ id: row.id }),
  recordViewLabel: () => ({}),
  withoutParentName: (rows: unknown) => rows,
}));
vi.mock('./PageSectionBox.js', () => ({
  SectionBox: ({ body, broken }: { body: React.ReactNode; broken?: string }) => <section>{broken ?? body}</section>,
  Loading: () => <p>Loading</p>,
}));

const { ListSection } = await import('./PageRelated.js');

function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = {
    section: { kind: 'list', from: 'upload', title: 'Files' },
    plan: { view: { from: 'upload', columns: [{ path: 'id' }, { path: 'file_name' }], limit: 10 } },
    base: upload(),
    recordKey: { id: 1 },
  } as unknown as Parameters<typeof ListSection>[0];
  render(
    <QueryClientProvider client={client}>
      <ListSection {...props} />
    </QueryClientProvider>,
  );
}
afterEach(cleanup);

test('a file is renamed where the reader may change its row, and never in an append-only table', async () => {
  mocks.appendOnly = false;
  draw();
  await waitFor(() => expect(screen.getByRole('button', { name: /^More for/ })).toBeInTheDocument());
  screen.getByRole('button', { name: /^More for/ }).click();
  expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
  cleanup();

  mocks.appendOnly = true;
  draw();
  await waitFor(() => expect(screen.getByText('plan.pdf')).toBeInTheDocument());
  // The menu is still there (to open the file); what a reader may only add to is never renamed from it.
  screen.getByRole('button', { name: /^More for/ }).click();
  expect((await screen.findAllByRole('menuitem')).length).toBeGreaterThan(0);
  expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull();
});
