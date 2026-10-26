/** Persistence acknowledges the server, then publishes a connection-scoped mirror. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { PageBuilderProps, PageDraft } from './components/PageBuilder.js';
import { pageConfig, parsePagesConfig } from '../../../engine/src/shared/page.js';
import { asConfig } from './components/pageDraft.js';

const state = { activeConnection: 'a' };
const api = vi.fn<(path: string, body?: unknown) => Promise<unknown>>();
const saveJson = vi.fn(() => true);
const loadJson = vi.fn(() => ({}));
const changed = vi.fn();
const toast = vi.fn();
const mounted: PageBuilderProps[] = [];
vi.mock('../../../kit/src/client/core.js', () => ({
  api,
  state,
  saveJson,
  loadJson,
  toast,
  findTable: vi.fn(),
  go: vi.fn(),
  pageView: vi.fn(),
}));
vi.mock('../../../kit/src/client/prompt.js', () => ({ promptFor: vi.fn() }));
vi.mock('../../../kit/src/client/components/mount.js', () => ({
  mount: (_host: Element, tree: ReactElement<PageBuilderProps>) => {
    mounted.push(tree.props);
  },
  unmount: vi.fn(),
}));

let builder: typeof import('./pagebuilder.js') & typeof import('../../../kit/src/client/savedPages.js');
const page = (name = 'Customer'): PageDraft => ({
  id: 'saved:customer:1',
  name,
  base: 'customer',
  source: 'saved',
  sections: [{ kind: 'fields' }],
});
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  vi.resetModules();
  const { establishSessionIdentity } = await import('../../../kit/src/client/sessionIdentity.js');
  establishSessionIdentity({ signedIn: false });
  vi.resetAllMocks();
  state.activeConnection = 'a';
  localStorage.clear();
  mounted.length = 0;
  api.mockResolvedValue({});
  saveJson.mockReturnValue(true);
  loadJson.mockReturnValue({});
  (await import('../../../kit/src/client/surfaces.js')).registerSurface('pageBuilder', () => null);
  builder = { ...(await import('./pagebuilder.js')), ...(await import('../../../kit/src/client/savedPages.js')) };
  builder.whenSavedPagesChange(changed);
});
afterEach(() => {
  builder.closeBuilder();
});

test('browser export uses the shared emitter and keeps timeline and layout semantics', () => {
  const [compiled] = parsePagesConfig(
    {
      pages: [
        {
          label: 'Activity',
          base: 'customer',
          connection: 'a',
          listTabs: false,
          sections: [
            {
              kind: 'timeline',
              title: 'Timeline',
              offsetLeft: 'half',
              width: 'half',
              hidden: true,
              when: 'id > 0',
              limit: 12,
              streams: [{ from: 'invoice', whose: 'customer_id', at: 'issued_on', show: 'id', detail: 'status', query: 'total > 0' }],
            },
            { kind: 'fields', show: ['name'], offsetRight: 'half', width: 'half', names: false },
          ],
        },
      ],
    },
    'original',
  );
  const exported = JSON.parse(asConfig(compiled));
  expect(exported).toEqual(JSON.parse(JSON.stringify({ pages: [pageConfig(compiled)] })));
  expect(parsePagesConfig(exported, 'exported')[0]).toEqual(compiled);
});

test('save publishes an immutable snapshot only after server acknowledgement', async () => {
  const reply = deferred();
  api.mockReturnValueOnce(reply.promise);
  const draft = page();
  const saving = builder.savePage(draft);
  draft.name = 'Later edit';
  expect(api).toHaveBeenCalledWith('/api/pages/save', { id: draft.id, page: page(), conn: 'a' });
  expect(builder.savedPages()).toEqual([]);
  expect(saveJson).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  reply.resolve({ ok: true });
  await saving;
  expect(builder.savedPages()).toEqual([page()]);
  expect(saveJson).toHaveBeenCalledWith('mistri.pages.saved.a', { [draft.id]: page() });
  expect(changed).toHaveBeenCalledOnce();
});

test('failed saves and deletes leave the last acknowledged page intact', async () => {
  await builder.savePage(page());
  changed.mockClear();
  saveJson.mockClear();
  api.mockRejectedValueOnce(new Error('Disk full'));
  await expect(builder.savePage(page('Changed'))).rejects.toThrow('Disk full');
  api.mockRejectedValueOnce(new Error('Permission denied'));
  await expect(builder.deletePage(page().id)).rejects.toThrow('Permission denied');
  expect(builder.savedPages()).toEqual([page()]);
  expect(changed).not.toHaveBeenCalled();
  expect(saveJson).not.toHaveBeenCalled();
  await builder.deletePage(page().id);
  expect(builder.savedPages()).toEqual([]);
});

test('unavailable browser storage does not turn a durable save into a failure', async () => {
  saveJson.mockReturnValue(false);
  await builder.savePage(page());
  expect(builder.savedPages('customer')).toEqual([page()]);
  expect(builder.savedPages('invoice')).toEqual([]);
  await builder.deletePage(page().id);
  expect(builder.savedPages()).toEqual([]);
});

test('writes refuse to fall back to an unspecified server connection', async () => {
  await expect(builder.savePage(page(), null)).rejects.toThrow('No database connection');
  await expect(builder.deletePage(page().id, null)).rejects.toThrow('No database connection');
  expect(api).not.toHaveBeenCalled();
});

test('an unresponsive write releases the editor without claiming the server cancelled it', async () => {
  vi.useFakeTimers();
  try {
    const reply = deferred();
    api.mockReturnValueOnce(reply.promise);
    const saving = builder.savePage(page());
    const failure = expect(saving).rejects.toThrow('It may still complete');
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(builder.savedPages()).toEqual([]);
    reply.resolve({ ok: true });
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    await builder.savePage(page());
    expect(builder.savedPages()).toEqual([page()]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('late reads cannot overwrite an acknowledged save or delete', async () => {
  const read = deferred();
  api.mockReturnValueOnce(read.promise);
  const loading = builder.loadSavedPages();
  await builder.savePage(page());
  read.resolve({ pages: {} });
  await loading;
  expect(builder.savedPages()).toEqual([page()]);

  const stale = deferred();
  api.mockReturnValueOnce(stale.promise);
  const reloading = builder.loadSavedPages();
  await builder.deletePage(page().id);
  stale.resolve({ pages: { [page().id]: page() } });
  await reloading;
  expect(builder.savedPages()).toEqual([]);
});

test('the latest read wins, and each read updates its original connection', async () => {
  const first = deferred();
  const second = deferred();
  api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const old = builder.loadSavedPages();
  const latest = builder.loadSavedPages();
  state.activeConnection = 'b';
  second.resolve({ pages: { [page().id]: page('Newer') } });
  await latest;
  first.resolve({ pages: { [page().id]: page('Older') } });
  await old;
  expect(builder.savedPages()).toEqual([]);
  state.activeConnection = 'a';
  expect(builder.savedPages()).toEqual([page('Newer')]);
});

test('a write finishing after connection switch does not publish into the active app', async () => {
  const reply = deferred();
  api.mockReturnValueOnce(reply.promise);
  const saving = builder.savePage(page());
  state.activeConnection = 'b';
  reply.resolve({ ok: true });
  await saving;
  expect(builder.savedPages()).toEqual([]);
  expect(changed).not.toHaveBeenCalled();
  expect(saveJson).toHaveBeenCalledWith('mistri.pages.saved.a', { [page().id]: page() });
  state.activeConnection = 'a';
  expect(builder.savedPages()).toEqual([page()]);
});

test('a rejected read retains the local fallback', async () => {
  loadJson.mockReturnValue({ [page().id]: page() });
  api.mockRejectedValueOnce(new Error('Unavailable'));
  await builder.loadSavedPages();
  expect(builder.savedPages()).toEqual([page()]);
  expect(saveJson).not.toHaveBeenCalled();
});

test('host success waits for persistence, and failure retains the same editor', async () => {
  const onSaved = vi.fn();
  await builder.openBuilder(page(), { onSaved });
  const editor = mounted[0];
  api.mockRejectedValueOnce(new Error('Disk full'));
  await expect(editor.onSave(page('Edited'))).rejects.toThrow('Disk full');
  expect(document.querySelector('.host-contents')).not.toBeNull();
  expect(onSaved).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
  const reply = deferred();
  api.mockReturnValueOnce(reply.promise);
  const retry = editor.onSave(page('Edited'));
  expect(onSaved).not.toHaveBeenCalled();
  reply.resolve({ ok: true });
  await retry;
  expect(document.querySelector('.host-contents')).toBeNull();
  expect(onSaved).toHaveBeenCalledWith(page('Edited'));
  expect(toast).toHaveBeenCalledWith('Saved "Edited".', 'ok');
});

test('a stale editor completion cannot close or navigate a newer editor', async () => {
  const onSaved = vi.fn();
  await builder.openBuilder(page(), { onSaved });
  const reply = deferred();
  api.mockReturnValueOnce(reply.promise);
  const saving = mounted[0].onSave(page());
  await builder.openBuilder(page('Another editor'));
  reply.resolve({ ok: true });
  await saving;
  expect(document.querySelector('.host-contents')).not.toBeNull();
  expect(onSaved).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
  state.activeConnection = 'b';
  await expect(mounted[1].onSave(page())).rejects.toThrow('connection or editor changed');
});

test('an obsolete relation request cannot mount an editor in a different connection', async () => {
  const reply = deferred();
  api.mockReturnValueOnce(reply.promise);
  const opening = builder.openBuilder(page());
  state.activeConnection = 'b';
  await builder.openBuilder(page('Connection B'));
  reply.resolve({ relations: [] });
  await opening;
  expect(mounted).toHaveLength(1);
  expect(mounted[0].draft.name).toBe('Connection B');
});

test('forced close retains recovery; failed saves retain it and acknowledged saves clear it', async () => {
  await builder.openBuilder(page());
  mounted[0].onDraftChange?.(page('Recovered'));
  builder.closeBuilder();
  await builder.openBuilder(page());
  expect(mounted[1].recovery?.draft.name).toBe('Recovered');
  api.mockRejectedValueOnce(new Error('Offline'));
  await expect(mounted[1].onSave(page('Recovered'))).rejects.toThrow('Offline');
  builder.closeBuilder();
  await builder.openBuilder(page());
  expect(mounted[2].recovery?.draft.name).toBe('Recovered');
  await mounted[2].onSave(page('Recovered'));
  await builder.openBuilder(page());
  expect(mounted[3].recovery).toBeUndefined();
});

test('late acknowledgement cannot clear a newer editor draft', async () => {
  await builder.openBuilder(page());
  mounted[0].onDraftChange?.(page('First'));
  const reply = deferred();
  api.mockReturnValueOnce(reply.promise);
  const saving = mounted[0].onSave(page('First'));
  await builder.openBuilder(page());
  mounted[1].onDraftChange?.(page('Second'));
  reply.resolve({ ok: true });
  await saving;
  await builder.openBuilder(page());
  expect(mounted[2].recovery?.draft.name).toBe('Second');
});

/* A bike-shop field report: the work order's bike card captioned its serial number "Bike". */
test("a card's facts are captioned without the record its title names, and keep the hop beside a title of their own", async () => {
  const { cardStem } = await import('../../../engine/src/shared/pagePaths.js');
  expect(cardStem(['bike_id', 'bike_id.make', 'bike_id.serial_number'])).toBe('bike_id');
  expect(cardStem(['bike_id.name', 'bike_id.make'])).toBe('bike_id');
  expect(cardStem(['dealer_id', 'dealer_id.owner_id.name'])).toBe('');
  // Beside a title of the record's own, a reference's name still says whose: "Dealer".
  expect(cardStem(['name', 'dealer_id.name', 'dealer_id.city'])).toBe('');
  expect(cardStem(['bike_id'])).toBe('');
});
