/** Real row dispatch and navigation, including failure/cancellation. The
 * Workbench leaf counts renders so a transient inspector cannot pass. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RowEntry } from '../../../../kit/src/client/components/Record.js';

const mocks = vi.hoisted(() => ({ app: true, split: false, inspector: vi.fn() }));
vi.mock('../appState.js', () => ({ inAppMode: () => mocks.app, activeApp: () => null }));
vi.mock('../../../../kit/src/client/dashboard.js', () => ({ dashboardFor: () => null }));
vi.mock('../../../../kit/src/client/insert.js', () => ({ openNewRecord: vi.fn() }));
vi.mock('../../../../kit/src/client/filterbar.js', () => ({ squeeze: (s: string) => s }));
vi.mock('../../../../kit/src/client/url.js', () => ({ syncHash: vi.fn() }));
vi.mock('../../../../kit/src/client/template.js', () => ({ activeDraft: () => null, templateFor: () => ({ sections: [] }) }));
vi.mock('../../../../kit/src/client/components/FavoriteStar.js', () => ({ FavoriteStar: () => null }));
vi.mock('../../../../kit/src/client/components/AppList.js', () => ({ AppList: () => <div>App list</div> }));
vi.mock('../../../../kit/src/client/components/appListModel.js', () => ({
  appListFor: () => ({ table: 'customer', label: 'Customers', presentation: mocks.split ? { kind: 'split' } : undefined }),
  appListQuery: () => 'customer',
  splitListSpec: (spec: unknown) => spec,
  splitOf: () => (mocks.split ? {} : undefined),
  newRecordNoun: () => 'customer',
}));
vi.mock('../../../../kit/src/client/components/NewRecordButton.js', () => ({ NewRecordButton: () => null }));
vi.mock('./ImportButton.js', () => ({ ImportButton: () => null }));
vi.mock('./SplitDetailPane.js', () => ({ SplitDetailPane: () => <div>App split detail</div>, SplitDetailActions: () => null }));
vi.mock('../../../../kit/src/client/components/Record.js', () => ({
  RecordView: () => {
    mocks.inspector();
    return <div>Workbench inspector</div>;
  },
}));

const core = await import('../../../../kit/src/client/core.js');
const { installShell } = await import('../../../../kit/src/client/shellMode.js');
const { RowRoom } = await import('../../../../kit/src/client/components/Rooms.js');

function deferred() {
  let resolve!: (value: string | null) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string | null>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function row(id = 1): RowEntry {
  return { kind: 'row', table: 'customer', key: { id }, label: `Customer ${id}` };
}
function show(entry = row()) {
  core.state.stack = [entry];
  return { entry, ...render(<RowRoom entry={entry} />) };
}
beforeEach(bridgeShell);

beforeEach(() => {
  mocks.app = true;
  mocks.split = false;
  mocks.inspector.mockClear();
  core.state.activeConnection = 'fixture';
  core.state.schema = {
    tables: [{ id: 'customer', name: 'customer', columns: [{ name: 'id', type: 'integer', primaryKey: true, nullable: false }] }],
    foreignKeys: [],
  };
  installShell({ pageAffinity: () => mocks.app });
  installShell({ resolvePage: async () => 'authored' });
});
afterEach(() => cleanup());

test.each(['authored', 'suggested:customer'])('App row opens %s and preserves its address, tab, view and trail', async (pageId) => {
  installShell({ resolvePage: async () => pageId });
  const entry = {
    ...row(),
    address: 'ada',
    tab: 'Notes',
    view: 'customers',
    trail: { table: 'customer', index: 0, records: [{ key: { id: 1 } }] },
  };
  show(entry);
  await waitFor(() => expect(core.currentEntry()).toMatchObject({ ...entry, kind: 'page', pageId }));
  expect(mocks.inspector).not.toHaveBeenCalled();
});

test.each(['rejection', 'null'] as const)('App %s shows a usable retry state without ever drawing the inspector', async (failure) => {
  installShell({
    resolvePage: async () => {
      if (failure === 'rejection') throw new Error('Offline');
      return null;
    },
  });
  show();
  expect(screen.getByRole('status')).toHaveTextContent('Reading');
  await screen.findByRole('alert');
  expect(core.currentEntry().kind).toBe('row');
  expect(mocks.inspector).not.toHaveBeenCalled();
  installShell({ resolvePage: async () => 'recovered' });
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(core.currentEntry()).toMatchObject({ kind: 'page', pageId: 'recovered' }));
  expect(mocks.inspector).not.toHaveBeenCalled();
});

test.each(['resolved', 'rejected'] as const)('a delayed %s result cannot replace a newer record', async (outcome) => {
  const old = deferred();
  const newer = deferred();
  installShell({ resolvePage: () => old.promise });
  const view = show();
  const next = row(2);
  installShell({ resolvePage: () => newer.promise });
  act(() => {
    core.go(next, 'reset');
    view.rerender(<RowRoom entry={next} />);
  });
  await act(async () => {
    if (outcome === 'resolved') old.resolve('old-page');
    else old.reject(new Error('Old failure'));
  });
  expect(core.currentEntry()).toBe(next);
  expect(screen.getByRole('status')).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => {
    newer.resolve('new-page');
  });
  expect(core.currentEntry()).toMatchObject({ kind: 'page', pageId: 'new-page', key: { id: 2 } });
  expect(mocks.inspector).not.toHaveBeenCalled();
});

test('a failed ordinary record navigation lands on the App retry surface', async () => {
  core.state.stack = [core.tableView('customer')];
  installShell({
    resolvePage: async () => {
      throw new Error('Offline');
    },
  });
  await core.openRecord('customer', { id: 1 }, 'Customer 1');
  const entry = core.currentEntry() as RowEntry;
  expect(entry.kind).toBe('row');
  show(entry);
  await screen.findByRole('alert');
  expect(mocks.inspector).not.toHaveBeenCalled();
});

test('cancellation while the same entry remains visible offers retry and cannot navigate', async () => {
  const reply = deferred();
  installShell({ resolvePage: () => reply.promise });
  const { entry } = show();
  core.beginNavigation();
  await act(async () => {
    reply.resolve('cancelled');
  });
  expect(core.currentEntry()).toBe(entry);
  expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  expect(mocks.inspector).not.toHaveBeenCalled();
});

test('an explicit retry owns navigation before its reply arrives', async () => {
  installShell({ resolvePage: async () => null });
  const { entry } = show();
  await screen.findByRole('alert');
  const other = deferred(),
    retry = deferred();
  installShell({ resolvePage: () => other.promise });
  const navigating = core.openRecord('customer', { id: 2 }, 'Other');
  installShell({ resolvePage: () => retry.promise });
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await act(async () => {
    other.resolve('other-page');
    await navigating;
  });
  expect(core.currentEntry()).toBe(entry);
  await act(async () => {
    retry.resolve('retry-page');
  });
  expect(core.currentEntry()).toMatchObject({ kind: 'page', pageId: 'retry-page', key: { id: 1 } });
  expect(mocks.inspector).not.toHaveBeenCalled();
});

test('Workbench to App removes the inspector synchronously, including while lookup fails', async () => {
  mocks.app = false;
  const view = show();
  await screen.findByText('Workbench inspector');
  mocks.inspector.mockClear();
  const reply = deferred();
  installShell({ resolvePage: () => reply.promise });
  mocks.app = true;
  view.rerender(<RowRoom entry={view.entry} />);
  expect(screen.queryByText('Workbench inspector')).toBeNull();
  expect(screen.getByRole('status')).toBeVisible();
  await act(async () => {
    reply.reject(new Error('Offline'));
  });
  expect(screen.getByRole('alert')).toBeVisible();
  expect(mocks.inspector).not.toHaveBeenCalled();
});

test('App to Workbench retires its pending lookup and preserves native record rendering', async () => {
  const reply = deferred();
  installShell({ resolvePage: () => reply.promise });
  const view = show();
  mocks.app = false;
  view.rerender(<RowRoom entry={view.entry} />);
  await screen.findByText('Workbench inspector');
  await act(async () => {
    reply.resolve('late-app-page');
  });
  expect(core.currentEntry()).toBe(view.entry);
  expect(screen.getByText('Workbench inspector')).toBeVisible();
});

test('App split rows retain their list and App detail without loading the inspector', () => {
  mocks.split = true;
  show();
  expect(screen.getByText('App split detail')).toBeVisible();
  expect(screen.getByText('App list')).toBeVisible();
  expect(mocks.inspector).not.toHaveBeenCalled();
});
