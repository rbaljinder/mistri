/**
 * Record tags: chips from the link rows, toned by the tag's own column; ×
 * deletes the link row and a pick inserts one, both ordinary writes.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { installShell, shell } from '../shellMode.js';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { primaryKey, type TableMeta } from '../../../../engine/src/shared/schema.js';
import type { AppTagRule } from '../../../../mistri/src/shared/app.js';

const mocks = vi.hoisted(() => ({ api: vi.fn(), toast: vi.fn(), editable: true, granted: true, ran: vi.fn() }));
const col = (name: string, primary = false) => ({ name, type: primary ? 'INTEGER' : 'TEXT', nullable: !primary, primaryKey: primary });
const tables: Record<string, TableMeta> = {
  issue_label: {
    id: 'issue_label',
    name: 'issue_label',
    schema: '',
    isView: false,
    columns: [col('id', true), col('issue_id'), col('label_id')],
  },
  label: { id: 'label', name: 'label', schema: '', isView: false, columns: [col('id', true), col('name'), col('tone')] },
};
vi.mock('../core.js', () => ({
  api: mocks.api,
  toast: mocks.toast,
  state: { activeConnection: 'thread' },
  primaryKey,
  findTable: (id: string) => tables[id],
  quote: (text: string) => JSON.stringify(text),
}));
vi.mock('../requestIdentity.js', () => ({ ownedBy: () => ({}) }));
vi.mock('../insert.js', () => ({ canInsert: () => mocks.editable }));
vi.mock('../delete.js', () => ({ canDelete: () => mocks.editable }));
vi.mock('../../../../tablewalk/src/client/undo.js', () => ({ refreshUndo: vi.fn() }));
vi.mock('./RecordPicker.js', () => ({
  RecordPicker: ({ onChange, ariaLabel }: { onChange: (value: string) => void; ariaLabel: string }) => (
    <button type="button" onClick={() => onChange('3')}>{`${ariaLabel}: pick`}</button>
  ),
}));
vi.mock('../../../../mistri/src/client/components/sdk/commands.js', () => ({
  recordCommand: (command: { id: string }) =>
    mocks.granted ? async (key: unknown, input: unknown) => (mocks.ran(command.id, key, input), { status: 'done' }) : undefined,
}));
const { RecordTags } = await import('./RecordTags.js');

const rule: AppTagRule = {
  through: 'issue_label',
  to: 'label',
  from: 'issue_id',
  key: 'id',
  via: 'label_id',
  tagKey: 'id',
  label: 'name',
  tone: 'tone',
};
const rows = [
  { id: 11, label_id: 2, 'label_id.name': 'design', 'label_id.tone': 'info' },
  { id: 10, label_id: 1, 'label_id.name': 'bug', 'label_id.tone': 'bad' },
];
function draw(drawn: AppTagRule = rule) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RecordTags rule={drawn} recordKey={{ id: 1 }} />
    </QueryClientProvider>,
  );
}
/* A tag's own commands run through the App shell's command pipeline (appnav.js names it). */
beforeEach(async () => {
  const { recordCommand } = await import('../../../../mistri/src/client/components/sdk/commands.js');
  installShell({ slots: { ...shell().slots, recordCommand } });
});
beforeEach(() => {
  mocks.api.mockReset();
  mocks.toast.mockReset();
  mocks.editable = true;
  mocks.granted = true;
  mocks.ran.mockReset();
  mocks.api.mockImplementation(async (path: string) => (path === '/api/run' ? { rows } : {}));
});
afterEach(cleanup);

test('the link rows draw as chips, by name, in the tone the tag carries', async () => {
  draw();
  const bug = await screen.findByText('bug');
  expect(bug.closest('li')).toHaveClass('tone', 'tone-bad');
  expect(screen.getByText('design').closest('li')).toHaveClass('tone-info');
  expect([...document.querySelectorAll('.record-tag')].map((chip) => chip.textContent)).toEqual(['bug×', 'design×']);
  expect(mocks.api.mock.calls[0][1].q).toBe('issue_label issue_id = 1 show id, label_id, label_id.name, label_id.tone');
});

test('× deletes the link row, and a pick inserts one', async () => {
  const user = userEvent.setup();
  draw();
  await user.click(await screen.findByRole('button', { name: 'Remove bug' }));
  expect(mocks.api).toHaveBeenCalledWith('/api/delete', { table: 'issue_label', key: { id: 10 }, confirm: true });
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Removed “bug”', 'ok'));
  await user.click(screen.getByRole('button', { name: '+ Add label' }));
  await user.click(screen.getByRole('button', { name: 'Add label: pick' }));
  expect(mocks.api).toHaveBeenCalledWith('/api/insert', { table: 'issue_label', values: { issue_id: 1, label_id: '3' } });
});

test('where the link table cannot be written, the chips stand alone; with none, nothing is drawn', async () => {
  mocks.editable = false;
  draw();
  await screen.findByText('bug');
  expect(screen.queryByRole('button', { name: /Remove|Add/ })).toBeNull();
  cleanup();
  mocks.api.mockImplementation(async () => ({ rows: [] }));
  const { container } = draw();
  await vi.waitFor(() => expect(mocks.api).toHaveBeenCalled());
  expect(container.querySelector('.record-tags')).toBeNull();
});

test("with the resource's own commands, a pick and × run them with the tag's key, and write no link row", async () => {
  const user = userEvent.setup();
  const command = (id: string) => ({ id, version: 1, target: 'issue', input: [{ name: 'tag', label: 'Tag', type: 'text' }] }) as never;
  mocks.editable = false;
  draw({ ...rule, add: command('tagIssue'), remove: command('untagIssue') });
  await user.click(await screen.findByRole('button', { name: 'Remove bug' }));
  expect(mocks.ran).toHaveBeenCalledWith('untagIssue', { id: 1 }, { tag: '1' });
  await user.click(screen.getByRole('button', { name: '+ Add label' }));
  await user.click(screen.getByRole('button', { name: 'Add label: pick' }));
  expect(mocks.ran).toHaveBeenCalledWith('tagIssue', { id: 1 }, { tag: '3' });
  expect(mocks.api.mock.calls.some(([path]) => path === '/api/insert' || path === '/api/delete')).toBe(false);
  // Not granted the commands: the chips stand alone, whatever the link table allows.
  cleanup();
  mocks.granted = false;
  mocks.editable = true;
  draw({ ...rule, add: command('tagIssue'), remove: command('untagIssue') });
  await screen.findByText('bug');
  expect(screen.queryByRole('button', { name: /Remove|Add/ })).toBeNull();
});
