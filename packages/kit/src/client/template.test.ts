import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { LayoutBuilderProps } from './components/LayoutBuilder.js';

const { mount, confirm } = vi.hoisted(() => ({ mount: vi.fn(), confirm: vi.fn() }));
vi.mock('./components/mount.js', () => ({ mount, unmount: vi.fn() }));
vi.mock('./components/LayoutBuilder.js', () => ({ LayoutBuilder: () => null }));
vi.mock('./prompt.js', () => ({ confirmFor: confirm }));
let core: typeof import('./core.js');
let templates: typeof import('./template.js');
const table = {
  id: 'customer',
  name: 'customer',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
    { name: 'name', type: 'TEXT', primaryKey: false, nullable: false },
  ],
};
const props = (): LayoutBuilderProps => mount.mock.calls.at(-1)![1].props;
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}

beforeEach(async () => {
  vi.resetModules();
  const { establishSessionIdentity } = await import('./sessionIdentity.js');
  establishSessionIdentity({ signedIn: false });
  vi.clearAllMocks();
  localStorage.clear();
  document.body.innerHTML = '<div id="toast" hidden></div>';
  core = await import('./core.js');
  templates = await import('./template.js');
  core.state.activeConnection = 'a';
  core.state.schema = { tables: [table], foreignKeys: [] };
  core.state.stack = [core.rowView('customer', { id: 1 }, 'Ada')];
  templates.openTemplateBuilder('customer');
});
afterEach(() => {
  core.go(core.tableView('customer'), 'reset');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('changed names are recoverable and navigation cannot preview them on another record', () => {
  props().draft.name = 'Draft';
  props().onPreview();
  expect(templates.activeDraft('customer')?.name).toBe('Draft');
  core.go(core.rowView('customer', { id: 2 }, 'Bob'));
  expect(templates.activeDraft('customer')).toBeNull();
  expect(document.querySelector('.tpl')).toBeNull();
  templates.openTemplateBuilder('customer');
  expect(props().hasRecovery).toBe(true);
  expect(props().draft.name).not.toBe('Draft');
  props().onRecover!(true);
  expect(props().draft.name).toBe('Draft');
});

test('only acknowledgement updates the saved mirror and duplicate clicks submit once', async () => {
  const reply = deferred();
  const fetch = vi.fn((_url: string, _options: RequestInit) => reply.promise);
  vi.stubGlobal('fetch', fetch);
  props().draft.name = 'Confirmed';
  const save = props().onSave;
  save();
  save();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toMatchObject({ conn: 'a', table: 'customer', layout: { name: 'Confirmed' } });
  expect(props().saving).toBe(true);
  expect(templates.savedTemplate('customer')).toBeNull();
  reply.resolve(response({ ok: true }));
  await vi.waitFor(() => expect(templates.savedTemplate('customer')?.name).toBe('Confirmed'));
  expect(document.querySelector('.tpl')).toBeNull();
});

test.each([response({ error: 'Read-only disk' }, 500), response({})])('a refused or unacknowledged save keeps its draft', async (reply) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply));
  props().draft.name = 'Keep me';
  props().onSave();
  await vi.waitFor(() => expect(props().saving).toBe(false));
  expect(props().error).toContain('not confirmed');
  expect(props().draft.name).toBe('Keep me');
  expect(templates.savedTemplate('customer')).toBeNull();
  expect(document.querySelector('.tpl')).not.toBeNull();
});

test('a late save updates its own connection without closing another editor', async () => {
  const reply = deferred();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => reply.promise),
  );
  props().draft.name = 'A saved';
  props().onSave();
  core.state.activeConnection = 'b';
  core.go(core.rowView('customer', { id: 1 }, 'B'), 'reset');
  templates.openTemplateBuilder('customer');
  const newer = props().draft;
  reply.resolve(response({ ok: true }));
  await vi.waitFor(() => expect(localStorage.getItem('mistri.templates.v1')).toContain('A saved'));
  expect(templates.savedTemplate('customer')).toBeNull();
  expect(props().draft).toBe(newer);
  expect(templates.activeDraft('customer')).toBe(newer);
});

test('acknowledged saves work even when the browser cache refuses writes', async () => {
  const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('Denied');
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ok: true })));
  props().draft.name = 'Server copy';
  props().onSave();
  await vi.waitFor(() => expect(templates.savedTemplate('customer')?.name).toBe('Server copy'));
  expect(write).toHaveBeenCalled();
  expect(document.querySelector('.tpl')).toBeNull();
});

test('a late discard answer cannot discard another editing session', async () => {
  let answer!: (value: boolean) => void;
  confirm.mockReturnValue(
    new Promise<boolean>((yes) => {
      answer = yes;
    }),
  );
  props().draft.name = 'A draft';
  props().onApplied();
  props().onCancel();
  core.go(core.rowView('customer', { id: 2 }, 'Bob'));
  templates.openTemplateBuilder('customer');
  const newer = props().draft;
  answer(true);
  await Promise.resolve();
  expect(props().draft).toBe(newer);
  expect(props().hasRecovery).toBe(true);
});

test('blocked storage retains a navigated-away draft in this tab', () => {
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('Denied');
  });
  props().draft.name = 'Memory only';
  props().onApplied();
  expect(props().recoveryStatus).toBe('unavailable');
  core.go(core.rowView('customer', { id: 2 }, 'Bob'));
  templates.openTemplateBuilder('customer');
  props().onRecover!(true);
  expect(props().draft.name).toBe('Memory only');
});

test('a layout read started during saving cannot overwrite its acknowledgement', async () => {
  const write = deferred();
  const read = deferred();
  vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(write.promise).mockReturnValueOnce(read.promise));
  props().draft.name = 'New layout';
  props().onSave();
  const loading = templates.loadTemplates();
  write.resolve(response({ ok: true }));
  await vi.waitFor(() => expect(templates.savedTemplate('customer')?.name).toBe('New layout'));
  read.resolve(response({ layouts: { customer: { name: 'Old layout' } } }));
  await loading;
  expect(templates.savedTemplate('customer')?.name).toBe('New layout');
});
