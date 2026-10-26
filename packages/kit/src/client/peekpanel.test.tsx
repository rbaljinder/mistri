import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { RecordModalProps } from '../../../mistri/src/client/components/RecordModal.js';

const model = vi.hoisted(() => ({
  route: {} as object,
  generation: 0,
  scope: 0,
  walk: new Set<() => void>(),
  identity: new Set<() => void>(),
  probe: (): boolean => false,
  props: undefined as RecordModalProps | undefined,
  unmount: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock('./core.js', () => ({
  currentEntry: () => model.route,
  allowMutationExit: () => !model.probe(),
  registerSurfaceMutationPendingProbe: (probe: () => boolean) => {
    model.probe = probe;
  },
  subscribeWalk: (fn: () => void) => {
    model.walk.add(fn);
    return () => model.walk.delete(fn);
  },
}));
vi.mock('./sessionIdentity.js', () => ({
  subscribeSessionIdentity: (fn: () => void) => {
    model.identity.add(fn);
    return () => model.identity.delete(fn);
  },
}));
vi.mock('./write.js', () => ({ cancelRecordAutosave: model.cancel }));
vi.mock('./components/editInteraction.js', () => ({ cancelEditInteractions: model.cancel }));
vi.mock('./components/mount.js', () => ({
  unmount: model.unmount,
  mount: (_node: HTMLElement, element: ReactElement<RecordModalProps>) => {
    model.props = element.props;
  },
}));
vi.mock('./components/PeekPanel.js', () => ({ PeekPanel: () => null }));
vi.mock('./components/recordSurface.js', () => ({
  captureRecordSurfaceOwner: (current: () => boolean) => {
    const generation = model.generation;
    return { connection: 'tick', queryScope: ++model.scope, isCurrent: () => generation === model.generation && current() };
  },
}));

let panel: typeof import('./peekpanel.js');
beforeEach(async () => {
  vi.resetModules();
  model.route = {};
  model.generation++;
  model.walk.clear();
  model.identity.clear();
  model.probe = () => false;
  model.props = undefined;
  model.unmount.mockClear();
  model.cancel.mockClear();
  panel = await import('./peekpanel.js');
  /* The App's chrome names its dialog (appnav.js); the kit's glance has none of its own. */
  panel.setRecordDialog(() => null);
});
afterEach(() => {
  model.generation++;
  for (const fn of [...model.identity]) fn();
  document.body.replaceChildren();
});
const open = (id = '9007199254740993') => {
  panel.openPeek('task', { id }, 'Task', 'modal');
  return model.props!;
};

test('pending or uncertain modal operations block close and replacement, then confirmed settlement permits exit', () => {
  const first = open(),
    node = document.querySelector('.peekpanel-host');
  let unresolved = true;
  first.setPendingProbe(() => unresolved);
  expect(panel.closePeek()).toBe(false);
  open('2');
  expect(model.props).toBe(first);
  expect(node?.isConnected).toBe(true);
  unresolved = false;
  expect(panel.closePeek()).toBe(true);
  expect(node?.isConnected).toBe(false);
  expect(first.owner.isCurrent()).toBe(false);
  expect(model.cancel).toHaveBeenCalled();
  expect(model.unmount).toHaveBeenCalledOnce();
});

test('stale close and probe callbacks cannot affect a replacement, including reopening the same key', () => {
  const first = open();
  const second = open();
  first.onClose();
  first.setPendingProbe(() => true);
  expect(second.owner.isCurrent()).toBe(true);
  expect(first.owner.isCurrent()).toBe(false);
  expect(model.probe()).toBe(false);
  expect(document.querySelectorAll('.peekpanel-host')).toHaveLength(1);
});

test('forced identity retirement removes private modal state even with an unresolved operation', () => {
  const first = open();
  first.setPendingProbe(() => true);
  model.generation++;
  for (const fn of [...model.identity]) fn();
  expect(first.owner.isCurrent()).toBe(false);
  expect(model.probe()).toBe(false);
  expect(document.querySelectorAll('.peekpanel-host')).toHaveLength(0);
  expect(model.walk.size).toBe(0);
  expect(model.identity.size).toBe(0);
});

test('breadcrumb paints preserve the surface while an actual routed reference retires it', () => {
  const first = open();
  for (const fn of [...model.walk]) fn();
  expect(first.owner.isCurrent()).toBe(true);
  model.route = {};
  for (const fn of [...model.walk]) fn();
  expect(first.owner.isCurrent()).toBe(false);
  expect(document.querySelectorAll('.peekpanel-host')).toHaveLength(0);
});

test("Space's glance opens over the list with its neighbors and hands the focus back to the row, even after stepping inside", () => {
  const row = document.body.appendChild(document.createElement('button'));
  row.focus();
  const records = [
    { key: { id: '1' }, label: 'Task' },
    { key: { id: '2' }, label: 'Next' },
  ];
  /* Space's glance is the drawer whatever the view's `open` says (appnav.js, the shell's `peekRecord`). */
  panel.openPeek('task', { id: '1' }, 'Task', 'drawer', records);
  expect(document.querySelectorAll('.peekpanel-host')).toHaveLength(1);
  expect(model.props?.records).toEqual(records);
  /* A glance opened again from inside the first one keeps the row it began on. */
  document.querySelector('.peekpanel-host')!.appendChild(document.createElement('button')).focus();
  panel.openPeek('task', { id: '2' }, 'Next', 'drawer', records);
  document.querySelector('.peekpanel-host')!.appendChild(document.createElement('button')).focus();
  expect(panel.closePeek()).toBe(true);
  expect(document.querySelectorAll('.peekpanel-host')).toHaveLength(0);
  expect(document.activeElement).toBe(row);
});

test('modal keys and loaded records are captured without rounding or borrowing mutable collection objects', () => {
  const key = { id: '9007199254740993' },
    records = [
      { key, label: 'First' },
      { key: { id: '2' }, label: 'Second' },
    ];
  panel.openPeek('task', key, 'First', 'modal', records);
  key.id = 'changed';
  records[1].key.id = 'changed';
  records[0].label = 'changed';
  expect(model.props?.recordKey).toEqual({ id: '9007199254740993' });
  expect(model.props?.records).toEqual([
    { key: { id: '9007199254740993' }, label: 'First' },
    { key: { id: '2' }, label: 'Second' },
  ]);
});
