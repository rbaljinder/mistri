/**
 * A record's command verbs in the action bar: one that asks nothing runs on one click, one that
 * confirms asks first, and one with inputs asks them in its form.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { AppAction } from '../../shared/app.js';
import { humanName } from '../../../../engine/src/shared/model.js';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; body: Record<string, unknown> }>,
  toasts: [] as Array<[string, string]>,
  said: undefined as string | undefined,
  version: 3,
  stale: 0,
  identity: { epoch: 1, mode: 'authenticated', appId: 'desk', accountId: 'agent', tenantRequired: false },
}));

const ticket: TableMeta = {
  id: 'ticket',
  name: 'ticket',
  columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }],
} as TableMeta;

vi.mock('../../../../kit/src/client/core.js', () => ({
  state: { activeConnection: 'desk' },
  humanName,
  columnLabel: () => null,
  findTable: () => ticket,
  toast: (message: string, tone: string) => mocks.toasts.push([message, tone]),
  api: async (path: string, body: Record<string, unknown>) => {
    mocks.calls.push({ path, body });
    if (path === '/api/commands/prepare') return { expectedVersion: mocks.version };
    if (mocks.stale > 0 && body.expectedVersion !== mocks.version) {
      mocks.stale--;
      throw Object.assign(new Error('The record has changed. Reload it before trying again.'), {
        code: 'stale_record',
        outcome: 'not_applied',
      });
    }
    return {
      status: 'applied',
      command: body.command,
      commandVersion: body.commandVersion,
      resource: 'ticket',
      key: body.key,
      receiptId: 'receipt-1',
      replayed: false,
      result: mocks.said === undefined ? {} : { message: mocks.said },
    };
  },
}));
vi.mock('../../../../kit/src/client/sessionIdentity.js', async (actual) => ({
  ...(await actual<typeof import('../../../../kit/src/client/sessionIdentity.js')>()),
  sessionIdentity: () => mocks.identity,
  captureSessionIdentity: () => mocks.identity,
}));
vi.mock('../commandAvailability.js', () => ({
  useCommandAnswers: (checks: unknown[]) => ({ available: checks.map(() => true), asking: false }),
}));

const { ActionBar } = await import('./Actions.js');

const command = (id: string, input: unknown[] = []) => ({ id, version: 1, target: 'ticket', input }) as never;
const watch: AppAction = { id: 'watch', label: 'Watch', command: command('watch') };

function draw(actions: AppAction[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onDone = vi.fn();
  render(
    createElement(
      QueryClientProvider,
      { client },
      <ActionBar
        tableId="ticket"
        actions={actions}
        recordKey={{ id: 7 }}
        label="INC0007"
        matches={async () => true}
        onDone={onDone}
        grantedCommands={actions.map((action) => (action.command ? action.command.id : action.id))}
      />,
    ),
  );
  return { onDone };
}

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.toasts.length = 0;
  mocks.said = undefined;
  mocks.version = 3;
  mocks.stale = 0;
});
afterEach(() => cleanup());

test('a command that asks nothing runs on one click, with no dialog, and a notice says it ran', async () => {
  const { onDone } = draw([watch]);
  await userEvent.click(await screen.findByRole('button', { name: 'Watch' }));
  await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
  expect(mocks.calls.map((call) => call.path)).toEqual(['/api/commands/prepare', '/api/commands/execute']);
  expect(mocks.calls[1].body).toMatchObject({ command: 'watch', key: { id: 7 }, expectedVersion: 3, input: {} });
  expect(mocks.toasts).toEqual([['Watch — done', 'ok']]);
});

test("its notice says the command's own words when it said any, as its form would have", async () => {
  mocks.said = 'INC0007 is watched; you hear of each update.';
  const { onDone } = draw([watch]);
  await userEvent.click(await screen.findByRole('button', { name: 'Watch' }));
  await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  expect(mocks.toasts).toEqual([['INC0007 is watched; you hear of each update.', 'ok']]);
});

test('one that confirms asks first, in its dialog, and sends nothing until asked', async () => {
  draw([{ ...watch, confirm: true }]);
  await userEvent.click(await screen.findByRole('button', { name: 'Watch' }));
  expect(await screen.findByRole('dialog', { name: 'Watch', hidden: true })).toBeTruthy();
  expect(mocks.calls.filter((call) => call.path === '/api/commands/execute')).toEqual([]);
});

test('one with inputs asks them in its form', async () => {
  draw([{ ...watch, command: command('watch', [{ name: 'note', type: 'text', label: 'Note' }]) }]);
  await userEvent.click(await screen.findByRole('button', { name: 'Watch' }));
  expect(await screen.findByRole('dialog', { name: 'Watch', hidden: true })).toBeTruthy();
  expect(mocks.calls.filter((call) => call.path === '/api/commands/execute')).toEqual([]);
});

test('its revision is asked as the pointer comes to its button, so the click sends only the execute', async () => {
  const { onDone } = draw([watch]);
  const button = await screen.findByRole('button', { name: 'Watch' });
  await userEvent.hover(button);
  await vi.waitFor(() => expect(mocks.calls.map((call) => call.path)).toEqual(['/api/commands/prepare']));
  await userEvent.hover(button);
  await userEvent.click(button);
  await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  expect(mocks.calls.map((call) => call.path)).toEqual(['/api/commands/prepare', '/api/commands/execute']);
  expect(mocks.calls[1].body).toMatchObject({ command: 'watch', key: { id: 7 }, expectedVersion: 3 });
});

test('a revision asked ahead that the record has moved past is asked again, and the command sent once more', async () => {
  const { onDone } = draw([watch]);
  const button = await screen.findByRole('button', { name: 'Watch' });
  await userEvent.hover(button);
  await vi.waitFor(() => expect(mocks.calls).toHaveLength(1));
  mocks.version = 4;
  mocks.stale = 1;
  await userEvent.click(button);
  await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  expect(mocks.calls.map((call) => [call.path, call.body.expectedVersion])).toEqual([
    ['/api/commands/prepare', undefined],
    ['/api/commands/execute', 3],
    ['/api/commands/prepare', undefined],
    ['/api/commands/execute', 4],
  ]);
  expect(mocks.toasts).toEqual([['Watch — done', 'ok']]);
});
