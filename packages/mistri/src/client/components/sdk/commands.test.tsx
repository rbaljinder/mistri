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
  prefillable: ['title'],
  command: { id: 'raise', version: 1, input: [{ name: 'title', type: 'text', label: 'Title', required: true }] },
};
vi.mock('../../../../../kit/src/client/components/appRooms.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../kit/src/client/components/appRooms.js')>()),
  formAt: (_app: unknown, pageId: string) => (pageId === 'form-raise' ? raise : undefined),
}));

/* Timing, then a frequency and a day asked only for later: the frequency defaults to once, and the day is required
   (`dated`) or not. */
const timing = (dated: boolean) => [
  { name: 'timing', type: 'text', label: 'Timing', required: true },
  { name: 'frequency', type: 'text', label: 'Frequency', default: 'once', when: "timing = 'later'" },
  { name: 'on', type: 'date', label: 'Date', required: dated, when: "timing = 'later'" },
];
const settles = <T,>(run: Promise<T>) =>
  Promise.race([run, new Promise((resolve) => setTimeout(() => resolve('still waiting: the form opened'), 1_500))]);

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
                id: 'closeDeal',
                label: 'Close',
                header: false,
                command: {
                  id: 'closeDeal',
                  version: 1,
                  target: 'deal',
                  input: [
                    { name: 'outcome', type: 'text', label: 'Outcome', required: true },
                    { name: 'reason', type: 'text', label: 'Reason', default: 'Price', when: "outcome = 'lost'" },
                  ],
                },
              },
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
        formCommands: {
          markAllRead: { id: 'markAllRead', version: 3, input: [] },
          // A transfer now or later: when later, how often (once, unless said) and on which day (a field report's shape).
          schedule: { id: 'schedule', version: 2, input: timing(true) },
          remind: { id: 'remind', version: 1, input: timing(false) },
          // Every kind a component may hand a form that opens: text, a number, yes/no, a group.
          transfer: {
            id: 'transfer',
            version: 1,
            input: [
              { name: 'note', type: 'text', label: 'Note', required: true },
              { name: 'amount', type: 'number', label: 'Amount' },
              { name: 'urgent', type: 'boolean', label: 'Urgent' },
              { name: 'payee', type: 'group', label: 'Payee', fields: [{ name: 'name', type: 'text', label: 'Payee name' }] },
            ],
          },
        },
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
type UiCommandOutcome = import('./context.js').UiCommandOutcome;
const handle = (ref: string) => pageBridge.commands!.command(ref);
/* The bridge says the handle without its React half's review; the host hands out the whole of it (context.ts). */
const reviewing = (ref: string) => handle(ref) as unknown as import('./context.js').UiCommandHandle;

beforeEach(() => {
  installDesk();
  calls.length = 0;
  toasts.length = 0;
  granted = ['raise', 'markAllRead', 'checkStep', 'closeDeal', 'schedule', 'remind', 'transfer'];
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
    throw Object.assign(new Error('The desk is closed.'), { status: 409, code: 'ineligible_state', outcome: 'not_applied' });
  };
  expect(await handle('raise').run({}, { title: 'Late' })).toEqual({ status: 'refused', message: 'The desk is closed.' });
  expect(toasts).toEqual(['The desk is closed.']);
});

/* A page that explains a refusal in place asks for no notice: the outcome is the same, the shell says nothing. */
test('a quiet run returns the refusal and shows no notice, whether the server or the grant refused it', async () => {
  answer = async () => {
    throw Object.assign(new Error('The desk is closed.'), { status: 409, code: 'ineligible_state', outcome: 'not_applied' });
  };
  expect(await handle('raise').run({}, { title: 'Late' }, { quiet: true })).toEqual({ status: 'refused', message: 'The desk is closed.' });
  expect(toasts).toEqual([]);
  granted = [];
  const outcome = await handle('raise').run({}, { title: 'Late' }, { quiet: true });
  expect(outcome.status).toBe('refused');
  expect(toasts).toEqual([]);
});

/* A component that draws its own fields places the server's words beside one; only a field the command declares and
   the values sent leave shown is named, so a refusal about a hidden or made-up input stays in the message. */
test('a refusal about an input names that field, when the command declares it and it is shown', async () => {
  const refuse = (field: string) => async () => {
    throw Object.assign(new Error('That is not a date.'), { status: 422, code: 'invalid_input', outcome: 'not_applied', field });
  };
  answer = refuse('title');
  expect(await handle('raise').run({}, { title: 'Late' })).toEqual({
    status: 'refused',
    message: 'That is not a date.',
    fields: { title: 'That is not a date.' },
  });
  answer = refuse('on');
  expect(await settles(handle('remind').run({}, { timing: 'later', on: '2026-12-01' }))).toMatchObject({
    fields: { on: 'That is not a date.' },
  });
  expect(await settles(handle('remind').run({}, { timing: 'now' }))).toEqual({ status: 'refused', message: 'That is not a date.' });
  answer = refuse('nowhere');
  expect(await handle('raise').run({}, { title: 'Late' })).toEqual({ status: 'refused', message: 'That is not a date.' });
});

test("a record's command names the field a refusal is about, and not one its condition hides", async () => {
  await onDesk();
  const refuse = (field: string) => async () => {
    if (calls.at(-1)!.path === '/api/commands/prepare') return { expectedVersion: 4 };
    throw Object.assign(new Error('Say why it was lost.'), { status: 422, code: 'invalid_input', outcome: 'not_applied', field });
  };
  answer = refuse('reason');
  expect(await settles(handle('closeDeal').run({ id: 7 }, { outcome: 'lost', reason: 'Price' }))).toEqual({
    status: 'refused',
    message: 'Say why it was lost.',
    fields: { reason: 'Say why it was lost.' },
  });
  expect(await settles(handle('closeDeal').run({ id: 7 }, { outcome: 'won' }))).toEqual({
    status: 'refused',
    message: 'Say why it was lost.',
  });
});

/* A field report: on a page whose draft logic had not loaded yet, a component's run validated with nothing hidden.
   These come first: the logic is fetched once per page, and a form drawn by an earlier test would have fetched it. */
test("a record's command judges its conditions before it sends, so a hidden field's default stays home", async () => {
  await onDesk();
  answer = async () =>
    calls.at(-1)!.path === '/api/commands/prepare'
      ? { expectedVersion: 4 }
      : { status: 'applied', receiptId: 'r-9', command: 'closeDeal', commandVersion: 1, resource: 'deal', key: { id: 7 } };
  expect(await settles(handle('closeDeal').run({ id: 7 }, { outcome: 'won' }))).toEqual({ status: 'applied' });
  expect(calls.find((call) => call.path === '/api/commands/execute')?.body.input).toEqual({ outcome: 'won' });
});

test("a hidden field's default is not sent, and a shown one is", async () => {
  expect(await settles(handle('remind').run({}, { timing: 'now' }))).toEqual({ status: 'applied' });
  expect(calls[0].body.input).toEqual({ timing: 'now' });
  expect(await settles(handle('remind').run({}, { timing: 'later', on: '2026-12-01' }))).toEqual({ status: 'applied' });
  expect(calls[1].body.input).toEqual({ timing: 'later', frequency: 'once', on: '2026-12-01' });
});

test("a run on a cold page judges the form's conditions first: a hidden required field neither blocks nor is asked", async () => {
  expect(await settles(handle('schedule').run({}, { timing: 'now' }))).toEqual({ status: 'applied' });
  expect(calls).toHaveLength(1);
  expect(calls[0].body).toMatchObject({ command: 'schedule', commandVersion: 2, input: { timing: 'now' } });
});

/* A form a component opens ends in how it was sent, not only in that it closed: the docs promise the outcomes. */
const submitOpened = async () => {
  const button = await vi.waitFor(() => {
    const found = document.querySelector<HTMLButtonElement>('.form-dialog button[type="submit"]');
    expect(found).not.toBeNull();
    return found!;
  });
  button.click();
};
const cancelOpened = () => document.querySelector<HTMLButtonElement>('.form-dialog .form-actions button:not([type="submit"])')?.click();

test('a form a component opens settles applied, with the output, once its submit is received', async () => {
  answer = async () => ({ status: 'applied', receiptId: 'r-5', result: { ticketId: 41 } });
  const opened = handle('raise').open({}, { title: 'Mouse missing' });
  await submitOpened();
  await vi.waitFor(() => expect(document.querySelector('.form-page-done')).not.toBeNull());
  document.querySelector<HTMLButtonElement>('.form-page-done .form-actions button')?.click();
  expect(await settles(opened)).toEqual({ status: 'applied', output: { ticketId: 41 } });
  expect(document.querySelector('.form-dialog')).toBeNull();
});

test("a form closed after a refusal settles refused, in the server's words; one closed with nothing sent settles closed", async () => {
  answer = async () => {
    throw Object.assign(new Error('The desk is closed.'), { status: 409, code: 'ineligible_state', outcome: 'not_applied' });
  };
  const refused = handle('raise').open({}, { title: 'Late' });
  await submitOpened();
  await vi.waitFor(() => expect(document.body.textContent).toMatch(/The desk is closed\./));
  cancelOpened();
  expect(await settles(refused)).toEqual({ status: 'refused', message: 'The desk is closed.' });

  const closed = handle('raise').open({}, { title: 'Never sent' });
  await vi.waitFor(() => expect(document.querySelector('.form-dialog')).not.toBeNull());
  cancelOpened();
  expect(await settles(closed)).toEqual({ status: 'closed' });
});

test('a form whose answer never came settles unknown, and check asks again under the same key', async () => {
  answer = async () => {
    throw new Error('The server is not answering.');
  };
  const opened = handle('raise').open({}, { title: 'Mouse missing' });
  await submitOpened();
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  await vi.waitFor(() => expect(document.querySelector('.form-dialog .form-page-failure:not([hidden])')).not.toBeNull());
  cancelOpened();
  const outcome = (await settles(opened)) as Extract<UiCommandOutcome, { status: 'unknown' }>;
  expect(outcome.status).toBe('unknown');
  answer = async () => ({ status: 'applied', receiptId: 'r-1', result: { ticketId: 41 } });
  expect(await outcome.check()).toEqual({ status: 'applied', output: { ticketId: 41 } });
  expect(calls[1].body.idempotencyKey).toBe(calls[0].body.idempotencyKey);
});

test('openForm carries the values given into the signed-in form it opens, for the inputs it names prefillable', async () => {
  pageBridge.commands!.openForm('raise', { title: 'Mouse missing', other: 'x' });
  const title = await vi.waitFor(() => {
    const found = document.querySelector<HTMLInputElement>('.form-dialog input[type="text"]');
    expect(found).not.toBeNull();
    return found!;
  });
  expect(title.value).toBe('Mouse missing');
});

test('a form the session leaves behind lets go instead of waiting on a dialog that cannot close', async () => {
  const opened = handle('raise').open({}, { title: 'Mouse missing' });
  await vi.waitFor(() => expect(document.querySelector('.form-dialog')).not.toBeNull());
  session.now = { ...eve, epoch: 2 };
  for (const listener of [...session.listeners]) listener();
  expect(await settles(opened)).toEqual({ status: 'closed' });
  expect(document.querySelector('.form-dialog')).toBeNull();
});

test('the form a component opens keeps every value it was given, not only the prefillable ones', async () => {
  const opened = handle('transfer').open({}, { note: 'Rent', amount: 1250, urgent: true, payee: { name: 'Mara' } });
  const note = await vi.waitFor(() => {
    const found = document.querySelector<HTMLInputElement>('.form-dialog input[type="text"]');
    expect(found).not.toBeNull();
    return found!;
  });
  expect(note.value).toBe('Rent');
  expect(
    document.querySelector<HTMLInputElement>('.form-dialog input[inputmode="decimal"], .form-dialog input[type="number"]')?.value,
  ).toBe('1250');
  expect(document.querySelector<HTMLInputElement>('.form-dialog input[type="checkbox"]')?.checked).toBe(true);
  expect([...document.querySelectorAll<HTMLInputElement>('.form-dialog input')].some((input) => input.value === 'Mara')).toBe(true);
  // An incomplete run opens the same form, as filled.
  document.querySelector<HTMLButtonElement>('.form-dialog .form-actions button:not(.primary)')?.click();
  void opened;
  calls.length = 0;
  void handle('transfer').run({}, { amount: 40, urgent: true });
  await vi.waitFor(() => expect(document.querySelectorAll('.form-dialog input[type="checkbox"]:checked')).not.toHaveLength(0));
  expect(calls).toEqual([]);
});

test('a run whose answer never came is not known, never refused; check asks again under the same key', async () => {
  answer = async () => {
    throw new Error('The server is not answering.');
  };
  const outcome = await handle('raise').run({}, { title: 'Mouse missing' });
  expect(outcome.status).toBe('unknown');
  expect(toasts.join(' ')).toMatch(/not known/i);
  answer = async () => ({ status: 'applied', receiptId: 'r-1', result: { ticketId: 41 } });
  const checked = await (outcome as Extract<typeof outcome, { status: 'unknown' }>).check();
  expect(checked).toEqual({ status: 'applied', output: { ticketId: 41 } });
  expect(calls.map((call) => call.path)).toEqual(['/api/commands/execute', '/api/commands/execute']);
  expect(calls[1].body.idempotencyKey).toBe(calls[0].body.idempotencyKey);
  expect(calls[1].body.input).toEqual(calls[0].body.input);
});

test('a server that could not say whether it ran is not known either', async () => {
  answer = async () => {
    throw Object.assign(new Error('The request was cancelled.'), { status: 503, code: 'cancelled', outcome: 'unknown' });
  };
  expect((await handle('markAllRead').run({}, {})).status).toBe('unknown');
});

test("each run is its own key, and a component's attempt is the key it is sent under", async () => {
  await handle('raise').run({}, { title: 'One' });
  await handle('raise').run({}, { title: 'Two' });
  expect(calls[0].body.idempotencyKey).not.toBe(calls[1].body.idempotencyKey);
  const attempt = '6f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
  await handle('raise').run({}, { title: 'Three' }, { attempt });
  expect(calls[2].body.idempotencyKey).toBe(attempt);
  await expect(handle('raise').run({}, { title: 'Four' }, { attempt: 'not-a-uuid' })).rejects.toThrow(/UUID/);
  expect(calls).toHaveLength(3);
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

/* A review pins the run to what the person saw (D6): the record moved since is a refusal the page shows the review
   again for, never a quiet prepare and a run over a revision nobody judged. */
test('a run confirmed from a review is sent for the revision shown, once, and refused stale when the record moved', async () => {
  await onDesk();
  let version = 4;
  answer = async () => {
    const call = calls.at(-1)!;
    if (call.path === '/api/commands/prepare') return { expectedVersion: version, initial: { step: 'Draft the proposal' } };
    if (call.body.expectedVersion !== version)
      throw Object.assign(new Error('The record has changed. Reload it before trying again.'), {
        status: 409,
        code: 'stale_record',
        outcome: 'not_applied',
      });
    return applied(version);
  };
  const steps = reviewing('checkStep');
  const review = await steps.prepare!({ id: 7 });
  if (!('token' in review)) throw new Error(review.message);
  expect(review).toMatchObject({ values: { step: 'Draft the proposal' }, fresh: true });
  version = 5;
  const stale = await steps.run({ id: 7 }, review.values, { review });
  expect(stale).toMatchObject({ status: 'refused', code: 'stale' });
  expect(calls.map((call) => call.path)).toEqual(['/api/commands/prepare', '/api/commands/execute']);
  expect(calls[1].body.expectedVersion).toBe(4);
  expect(review.fresh).toBe(false);
  // Spent, it is not sent again; shown again, the new review runs at the revision it read.
  calls.length = 0;
  expect(await steps.run({ id: 7 }, review.values, { review })).toMatchObject({ status: 'refused', code: 'stale' });
  expect(calls).toEqual([]);
  const again = await steps.prepare!({ id: 7 }, { step: 'Send the proposal' });
  if (!('token' in again)) throw new Error(again.message);
  expect(again.values).toEqual({ step: 'Send the proposal' });
  expect(await steps.run({ id: 7 }, again.values, { review: again })).toMatchObject({ status: 'applied' });
  expect(calls.map((call) => call.path)).toEqual(['/api/commands/prepare', '/api/commands/execute']);
  expect(calls[1].body.expectedVersion).toBe(5);
});

test('a review for another record is not a pin for this one', async () => {
  await onDesk();
  answer = async () => (calls.at(-1)!.path === '/api/commands/prepare' ? { expectedVersion: 4 } : applied(4));
  const steps = reviewing('checkStep');
  const review = await steps.prepare!({ id: 8 });
  if (!('token' in review)) throw new Error(review.message);
  calls.length = 0;
  expect(await steps.run({ id: 7 }, { step: 'x' }, { review })).toMatchObject({ status: 'refused', code: 'stale' });
  expect(calls).toEqual([]);
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
