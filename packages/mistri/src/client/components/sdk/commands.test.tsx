/**
 * A command a component names (`useCommand`) that no action offers, only a
 * signed-in form, or none: it names no record, so it is found through its
 * form or by name and sent as the form sends it, with an empty key, and only
 * where the reader is granted it.
 */
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest';

const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
const toasts: string[] = [];
let answer: () => Promise<unknown> = async () => ({ status: 'applied', receiptId: 'r-1' });

vi.mock('../../../../../kit/src/client/core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../kit/src/client/core.js')>()),
  api: async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    return answer();
  },
  toast: (message: string) => {
    toasts.push(message);
  },
}));
/* One snapshot, as the page holds one: a sent command is still current while the session is the one it was sent under. */
const eve = vi.hoisted(() => ({ mode: 'authenticated', epoch: 1, accountId: 'eve', appId: 'desk', tenantRequired: false }));
/* The snapshot a tenant tab takes again when its context is chosen again (sessionIdentity.ts establishTenantSelection). */
const session = vi.hoisted(() => ({ now: undefined as unknown, listeners: new Set<() => void>() }));
vi.mock('../../../../../kit/src/client/sessionIdentity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../kit/src/client/sessionIdentity.js')>()),
  sessionIdentity: () => session.now ?? eve,
  captureSessionIdentity: () => session.now ?? eve,
  subscribeSessionIdentity: (listener: () => void) => {
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  },
}));
const raise = {
  id: 'raise',
  kind: 'form',
  label: 'Raise a ticket',
  command: { id: 'raise', version: 1, input: [{ name: 'title', type: 'text', label: 'Title', required: true }] },
};
vi.mock('../../../../../kit/src/client/components/appRooms.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../kit/src/client/components/appRooms.js')>()),
  formAt: (_app: unknown, pageId: string) => (pageId === 'form-raise' ? raise : undefined),
}));

const { pageBridge } = await import('../../../../../kit/src/client/uiBridge.js');
const { installShell } = await import('../../../../../kit/src/client/shellMode.js');
await import('./commands.js');
let granted: string[] = ['raise'];
/* Installed before each test: the setup's own shell answers are laid down first (test/components.setup.ts). */
const installDesk = () =>
  installShell({
    app: () =>
      ({
        id: 'desk',
        name: 'Desk',
        resources: {
          // Run only by a component: kept out of every menu, still the resource's action and still granted.
          deal: {
            actions: [
              {
                id: 'checkStep',
                label: 'Mark a step done',
                header: false,
                command: {
                  id: 'checkStep',
                  version: 2,
                  target: 'deal',
                  input: [{ name: 'step', type: 'text', label: 'Step', required: true }],
                },
              },
            ],
          },
        },
        grantedCommands: granted,
        views: { raise: { kind: 'form', command: { id: 'raise', version: 1 } } },
        // A granted command that names no record and that no form runs, served by name.
        formCommands: { markAllRead: { id: 'markAllRead', version: 3, input: [] } },
        // A public page's public command, its choices from a table served with it (forms/formChoices.ts).
        publicCommands: {
          enrol: {
            id: 'enrol',
            version: 1,
            input: [
              {
                name: 'make',
                type: 'choice',
                label: 'Make',
                options: [
                  { value: 1, label: 'Audi' },
                  { value: 2, label: 'BMW' },
                ],
                source: { from: 'make', by: 'id', labelColumn: 'name' },
              },
              { name: 'shade', type: 'choice', label: 'Shade', options: [], source: { from: 'shade', by: 'id', labelColumn: 'name' } },
              { name: 'name', type: 'text', label: 'Name' },
            ],
          },
        },
      }) as never,
    inApp: () => true,
  });
const handle = (ref: string) => pageBridge.commands!.command(ref);

beforeEach(() => {
  installDesk();
  calls.length = 0;
  toasts.length = 0;
  granted = ['raise', 'markAllRead', 'checkStep'];
  answer = async () => ({ status: 'applied', receiptId: 'r-1' });
});
afterEach(() => {
  document.body.innerHTML = '';
  session.now = undefined;
});

/** A record's command on the App's connection, which the session must be signed in to. */
async function onDesk() {
  const { state } = await import('../../../../../kit/src/client/core.js');
  const before = state.activeConnection;
  state.activeConnection = 'desk';
  onTestFinished(() => {
    state.activeConnection = before;
  });
}
const applied = (version: number) => ({
  status: 'applied',
  receiptId: `r-${version}`,
  command: 'checkStep',
  commandVersion: 2,
  resource: 'deal',
  key: { id: 7 },
});

test("a form's command is found through its form, granted, and runs with no record", async () => {
  const command = handle('raise');
  expect(command.label).toBe('Raise a ticket');
  expect(command.granted).toBe(true);
  expect(await command.available({})).toBe(true);
  expect(await command.run({}, { title: 'Mouse missing' })).toEqual({ status: 'applied' });
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe('/api/commands/execute');
  expect(calls[0].body).toMatchObject({
    command: 'raise',
    commandVersion: 1,
    key: {},
    expectedVersion: 0,
    input: { title: 'Mouse missing' },
  });
  expect(typeof calls[0].body.idempotencyKey).toBe('string');
});

test("a refusal is said in the server's words", async () => {
  answer = async () => {
    throw new Error('The desk is closed.');
  };
  expect(await handle('raise').run({}, { title: 'Late' })).toEqual({ status: 'refused', message: 'The desk is closed.' });
  expect(toasts).toEqual(['The desk is closed.']);
});

test('a reader not granted it is refused before anything is sent', async () => {
  granted = [];
  const command = handle('raise');
  expect(command.granted).toBe(false);
  expect(await command.available({})).toBe(false);
  expect((await command.run({}, { title: 'x' })).status).toBe('refused');
  expect(calls).toEqual([]);
});

test('a granted command no form runs is reached by name, and sent with no record under the word the component gives it', async () => {
  const command = handle('markAllRead');
  expect(command.label).toBe('Mark all read');
  expect(command.granted).toBe(true);
  expect(await command.run({}, {}, { label: 'Mark all read' })).toEqual({ status: 'applied' });
  expect(calls[0].body).toMatchObject({ command: 'markAllRead', commandVersion: 3, key: {}, expectedVersion: 0, input: {} });
});

test('a command neither an action nor a form offers is not granted', () => {
  expect(handle('nothing').granted).toBe(false);
});

test("an action kept out of the record's menus (header: false) is still the command a component runs", async () => {
  answer = async () => ({ expectedVersion: 4 });
  const command = handle('checkStep');
  expect(command.label).toBe('Mark a step done');
  expect(command.granted).toBe(true);
  await command.run({ id: 7 }, { step: 'Send the proposal' });
  // Prepared for the record as the action's button would be; the rest is the one command pipeline (CommandForm.test.tsx).
  expect(calls[0]).toMatchObject({ path: '/api/commands/prepare', body: { command: 'checkStep', commandVersion: 2, key: { id: 7 } } });
  granted = ['raise'];
  expect(handle('checkStep').granted).toBe(false);
});

test('a run resolves with what the command returned, so a component acts on what it made', async () => {
  answer = async () => ({ status: 'applied', receiptId: 'r-2', result: { ticketId: 41 } });
  expect(await handle('raise').run({}, { title: 'Mouse missing' })).toEqual({ status: 'applied', output: { ticketId: 41 } });
  // A record's command, through the one pipeline: prepared, sent, and its receipt's result handed back with its words.
  answer = async () =>
    calls.at(-1)!.path === '/api/commands/prepare'
      ? { expectedVersion: 4 }
      : {
          status: 'applied',
          receiptId: 'r-3',
          command: 'checkStep',
          commandVersion: 2,
          resource: 'deal',
          key: { id: 7 },
          result: { message: 'Step done', step: 3 },
        };
  calls.length = 0;
  // A record's command is sent on the App's connection, which the session must be signed in to.
  const { state } = await import('../../../../../kit/src/client/core.js');
  const before = state.activeConnection;
  state.activeConnection = 'desk';
  onTestFinished(() => {
    state.activeConnection = before;
  });
  expect(await handle('checkStep').run({ id: 7 }, { step: 'Send the proposal' })).toEqual({
    status: 'applied',
    message: 'Step done',
    output: { message: 'Step done', step: 3 },
  });
  expect(calls.map((call) => call.path)).toEqual(['/api/commands/prepare', '/api/commands/execute']);
});

/* A composer's reply prepares the record and sends at once; another person's change landing between the two is no
   reason to refuse it, since the person saw neither revision (live sync's churn). */
test('a run whose record changed between its own prepare and its send is prepared again and sent', async () => {
  await onDesk();
  let version = 4;
  answer = async () => {
    const call = calls.at(-1)!;
    if (call.path === '/api/commands/prepare') return { expectedVersion: version };
    if (call.body.expectedVersion !== 5)
      throw Object.assign(new Error('The record has changed. Reload it before trying again.'), {
        status: 409,
        code: 'stale_record',
        outcome: 'not_applied',
      });
    return applied(5);
  };
  const run = handle('checkStep').run({ id: 7 }, { step: 'Send the proposal' });
  version = 5;
  expect(await run).toEqual({ status: 'applied' });
  expect(calls.map((call) => call.path)).toEqual([
    '/api/commands/prepare',
    '/api/commands/execute',
    '/api/commands/prepare',
    '/api/commands/execute',
  ]);
  expect(calls[1].body.idempotencyKey).not.toBe(calls[3].body.idempotencyKey);
  expect(toasts).toEqual([]);
});

test("a record that keeps changing is refused in the server's words after a few tries, not sent for ever", async () => {
  await onDesk();
  answer = async () => {
    if (calls.at(-1)!.path === '/api/commands/prepare') return { expectedVersion: calls.length };
    throw Object.assign(new Error('The record has changed. Reload it before trying again.'), {
      status: 409,
      code: 'stale_record',
      outcome: 'not_applied',
    });
  };
  expect(await handle('checkStep').run({ id: 7 }, { step: 'x' })).toEqual({
    status: 'refused',
    message: 'The record has changed. Reload it before trying again.',
  });
  expect(calls.filter((call) => call.path === '/api/commands/execute')).toHaveLength(3);
});

/* An answer that never came opens the form to check it; when the tab's session is taken again under it (a tenant
   context chosen again after a cut request), that form can never be drawn, and the run waited on it for good: the
   composer said Sending… with no word. */
test('a run whose form the session left behind lets go, and says the result is not confirmed', async () => {
  await onDesk();
  answer = async () => {
    if (calls.at(-1)!.path === '/api/commands/prepare') return { expectedVersion: 4 };
    throw Object.assign(new Error('The request was cancelled.'), { status: 503, code: 'cancelled', outcome: 'unknown' });
  };
  const run = handle('checkStep').run({ id: 7 }, { step: 'Send the proposal' });
  await vi.waitFor(() => expect(document.querySelector('.custom-command-host')).not.toBeNull());
  session.now = { ...eve, epoch: 2 };
  for (const listener of [...session.listeners]) listener();
  const outcome = await Promise.race([run, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 1_000))]);
  expect(outcome).toMatchObject({ status: 'closed' });
  expect(document.querySelector('.custom-command-host')).toBeNull();
  expect(toasts.join(' ')).toMatch(/not confirmed/i);
});

test("a public page's command says the choices served with it: a table's rows, and nothing for an input that offers none", () => {
  // The ticket is asked as the handle is made; nothing here sends, so its answer is not awaited.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  const enrol = pageBridge.commands!.command('enrol', 'lobby');
  expect(enrol.granted).toBe(true);
  expect(enrol.choices?.('make')).toEqual([
    { value: 1, label: 'Audi' },
    { value: 2, label: 'BMW' },
  ]);
  expect(enrol.choices?.('shade')).toBeUndefined();
  expect(enrol.choices?.('name')).toBeUndefined();
  expect(enrol.choices?.('nothing')).toBeUndefined();
  // Off the page, the same command is not the page's door, and a signed-in form's choices come from its own input.
  expect(handle('raise').choices?.('title')).toBeUndefined();
});
