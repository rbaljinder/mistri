/**
 * A fixed action a page names (`useAction`): the record page's own button, found by its id on a resource the page reads and
 * run on one record by its key, through the update route every list's bulk bar uses. What the browser can know is asked
 * first, in words: the reader's grant (a writable table, or the role's `actions`), the action's `when` for this record,
 * and `confirm`. The server judges the write again; here a refusal of it is said as the command pipeline says one.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
const toasts: string[] = [];
let respond: (path: string, body: Record<string, unknown>) => unknown = () => ({});
const confirmed = vi.hoisted(() => ({ asked: [] as Array<{ title: string; body: string; confirmLabel: string }>, yes: true }));

const TABLE = {
  id: 'request',
  name: 'request',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
    { name: 'status', type: 'TEXT', primaryKey: false, nullable: false },
  ],
};
vi.mock('../../../../../kit/src/client/core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../kit/src/client/core.js')>()),
  api: async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    return respond(path, body);
  },
  findTable: (id: string) => (id === 'request' ? TABLE : undefined),
  toast: (message: string) => {
    toasts.push(message);
  },
}));
vi.mock('../../../../../kit/src/client/prompt.js', () => ({
  ask: vi.fn(),
  confirmFor: async (options: { title: string; body: string; confirmLabel: string }) => {
    confirmed.asked.push(options);
    return confirmed.yes;
  },
}));
const session = vi.hoisted(() => ({ mode: 'authenticated' as 'authenticated' | 'anonymous' }));
vi.mock('../../../../../kit/src/client/sessionIdentity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../kit/src/client/sessionIdentity.js')>()),
  sessionIdentity: () => session,
  subscribeSessionIdentity: () => () => {},
}));

const { pageBridge } = await import('../../../../../kit/src/client/uiBridge.js');
const { installShell } = await import('../../../../../kit/src/client/shellMode.js');
await import('./commands.js');

/* A repair request's machine: start from scheduled, finish from onsite, cancel from either (and asks first). */
const START = { id: 'startVisit', label: 'Start visit', set: { status: 'onsite' }, when: "status = 'scheduled'" };
const CANCEL = {
  id: 'cancelRequest',
  label: 'Cancel request',
  set: { status: 'cancelled' },
  when: "status in ('new', 'scheduled')",
  confirm: true,
};
const NOTE = { id: 'closeWith', label: 'Close with a note', set: { status: 'done' }, reason: 'note' };
const RESTOCK = { id: 'restock', label: 'Restock', command: { id: 'restock', version: 1, target: 'request', input: [] } };

let writable: string[] = [];
let grantedActions: Record<string, string[]> | undefined;
const install = () =>
  installShell({
    app: () =>
      ({
        id: 'repairs',
        name: 'Repairs',
        resources: { request: { actions: [START, CANCEL, NOTE, RESTOCK] }, technician: { actions: [{ ...START, id: 'elsewhere' }] } },
        ...(grantedActions ? { grantedActions } : {}),
      }) as never,
    inApp: () => true,
    writeScope: (table: string) => writable.includes(table),
  });
const action = (id: string, reads: string[] | undefined = ['request']) => pageBridge.commands!.action(id, reads);
/* The server answers a `when` read with the rows that match, and an update with what it applied. */
const serve = (matching: number[] = [7]) => {
  respond = (path, body) =>
    path === '/api/run'
      ? { rows: matching.map((id) => ({ id })) }
      : path === '/api/update'
        ? { affected: 1, outcome: 'applied', applied: body.values }
        : {};
};
const updates = () => calls.filter((call) => call.path === '/api/update');

beforeEach(() => {
  calls.length = 0;
  toasts.length = 0;
  confirmed.asked.length = 0;
  confirmed.yes = true;
  session.mode = 'authenticated';
  writable = ['request', 'technician'];
  grantedActions = undefined;
  install();
  serve();
});
afterEach(() => {
  document.body.innerHTML = '';
});

test('an action is found by its id on a resource the page reads, and a command is not one', () => {
  expect(action('startVisit').label).toBe('Start visit');
  // The same id on a resource the page does not read is not found; a command's action runs as a command.
  expect(action('elsewhere').granted).toBe(false);
  expect(action('restock').granted).toBe(false);
  expect(pageBridge.commands!.action('elsewhere').granted).toBe(true);
});

test("a granted run writes the action's set to the record by its key and resolves applied", async () => {
  const start = action('startVisit');
  expect(start.granted).toBe(true);
  expect(await start.run({ id: 7, status: 'scheduled', title: 'Oven' })).toEqual({ status: 'applied' });
  expect(updates()).toHaveLength(1);
  expect(updates()[0].body).toMatchObject({
    table: 'request',
    key: { id: 7 },
    values: { status: 'onsite' },
    expected: { status: 'scheduled' },
  });
  expect(toasts).toEqual(['Start visit done.']);
  // It never posts a command.
  expect(calls.some((call) => call.path.startsWith('/api/commands'))).toBe(false);
});

test('a record in a state the action does not leave is refused in words, not skipped, and nothing is written', async () => {
  serve([]);
  const start = action('startVisit');
  expect(await start.available({ id: 7 })).toBe(false);
  expect(await start.run({ id: 7 })).toEqual({ status: 'refused', message: 'Start visit is not available on this record now.' });
  expect(updates()).toHaveLength(0);
  expect(toasts).toEqual(['Start visit is not available on this record now.']);
});

test("available asks the server whether the action's when holds for this record", async () => {
  const start = action('startVisit');
  expect(await start.available({ id: 7 })).toBe(true);
  expect(calls[0].path).toBe('/api/run');
  expect(String(calls[0].body.q)).toContain("status = 'scheduled'");
  // An action with no `when` is available wherever it is granted, asking nothing.
  calls.length = 0;
  expect(await action('closeWith').available({ id: 7 })).toBe(true);
  expect(calls).toHaveLength(0);
});

test('a confirm asks first: declined sends nothing, accepted writes', async () => {
  const cancel = action('cancelRequest');
  confirmed.yes = false;
  expect(await cancel.run({ id: 7 })).toEqual({ status: 'closed' });
  expect(confirmed.asked).toEqual([
    { title: 'Cancel request?', body: 'Run Cancel request on this record?', confirmLabel: 'Cancel request' },
  ]);
  expect(updates()).toHaveLength(0);
  confirmed.yes = true;
  expect(await cancel.run({ id: 7 })).toEqual({ status: 'applied' });
  expect(updates()[0].body).toMatchObject({ values: { status: 'cancelled' } });
});

test("granted follows the writable table or the role's own actions, as the record page offers a verb", () => {
  writable = [];
  expect(action('startVisit').granted).toBe(false);
  grantedActions = { request: ['startVisit'] };
  expect(action('startVisit').granted).toBe(true);
  expect(action('cancelRequest').granted).toBe(false);
});

test("an ungranted run is refused before anything is sent, in the reader's words", async () => {
  writable = [];
  expect(await action('startVisit').run({ id: 7 })).toEqual({
    status: 'refused',
    message: 'Start visit is not something you can do here.',
  });
  session.mode = 'anonymous';
  expect(await action('startVisit').run({ id: 7 })).toEqual({ status: 'refused', message: 'Sign in to do that.' });
  expect(calls).toHaveLength(0);
});

test('an action that asks a reason takes it in the input and writes it with the set', async () => {
  const close = action('closeWith');
  expect(await close.run({ id: 7 })).toMatchObject({ status: 'refused' });
  expect(updates()).toHaveLength(0);
  expect(await close.run({ id: 7 }, { reason: '  Parts arrived  ' })).toEqual({ status: 'applied' });
  expect(updates()[0].body).toMatchObject({ values: { status: 'done', note: 'Parts arrived' } });
});

test("the server's refusal is said in its words", async () => {
  respond = (path) => {
    if (path === '/api/run') return { rows: [{ id: 7 }] };
    throw Object.assign(new Error('This change is not one of the actions this account may run on the record now.'), {
      status: 403,
      code: 'forbidden',
      outcome: 'rejected',
    });
  };
  expect(await action('startVisit').run({ id: 7 })).toEqual({
    status: 'refused',
    message: 'This change is not one of the actions this account may run on the record now.',
  });
});

test('a record without its key is a mistake the page is told, not a write', async () => {
  await expect(action('startVisit').run({ status: 'scheduled' })).rejects.toThrow(/has no id/);
  expect(updates()).toHaveLength(0);
});
