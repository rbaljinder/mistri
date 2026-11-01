/** A signed-in form: drawn from the served view, submitted through the signed-in command route with no record named. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const calls: Array<[string, Record<string, unknown>]> = [];
let answered: unknown = { reference: 'CALL-7' };
vi.mock('../../../../kit/src/client/core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../kit/src/client/core.js')>()),
  api: vi.fn(async (path: string, body: Record<string, unknown>) => {
    calls.push([path, body]);
    if (path === '/api/commands/prepare') return { expectedVersion: 0, initial: { subject: 'Evening window', minutes: 30 } };
    return { status: 'applied', receiptId: 'r1', command: 'logCall', commandVersion: 2, result: answered };
  }),
}));
const { FormBody, formPresentation } = await import('./FormRoom.js');

const form = {
  id: 'log-call',
  label: 'Log a call',
  command: {
    id: 'logCall',
    version: 2,
    input: [
      { name: 'subject', label: 'Subject', type: 'text' as const, required: true },
      { name: 'minutes', label: 'Minutes', type: 'number' as const, min: 1 },
    ],
  },
  steps: [
    { id: 'the-call', label: 'The call', fields: ['subject'] },
    { id: 'time', label: 'Time', fields: ['minutes'] },
  ],
  done: { title: 'Call logged', description: 'It is on the account.' },
};
function draw(served: Omit<typeof form, 'command'> & { command: typeof form.command & { prepares?: true }; error?: string }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FormBody form={served} appName="Compass" />
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  calls.length = 0;
  answered = { reference: 'CALL-7' };
});

test('steps and a done screen, submitted as the signed-in command envelope that names no record', async () => {
  draw(form);
  expect(screen.getByRole('heading', { name: 'Log a call' })).toBeInTheDocument();
  // The stepper is a part loaded on demand: it arrives after the form's heading.
  fireEvent.change(await screen.findByLabelText('Subject (required)'), { target: { value: 'Renewal' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByLabelText('Minutes')).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Call logged' })).toBeInTheDocument());
  expect(screen.getByText('CALL-7')).toBeInTheDocument();
  expect(screen.getByText('It is on the account.')).toBeInTheDocument();
  // Each step is checked by the server before it is left (/api/commands/check), over the fields asked so far.
  const checks = calls.filter(([asked]) => asked === '/api/commands/check');
  expect(checks.map(([, sent]) => (sent as { fields: string[] }).fields)).toEqual([['subject'], ['subject', 'minutes']]);
  expect(checks[0][1]).toMatchObject({ command: 'logCall', input: { subject: 'Renewal' } });
  const sent = calls.filter(([asked]) => asked !== '/api/commands/check');
  expect(sent).toHaveLength(1);
  const [path, body] = sent[0];
  expect(path).toBe('/api/commands/execute');
  expect(body).toMatchObject({
    command: 'logCall',
    commandVersion: 2,
    key: {},
    expectedVersion: 0,
    input: { subject: 'Renewal', minutes: 5 },
  });
  expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  // A desk logs the next one.
  expect(screen.getByRole('button', { name: 'Fill in another' })).toBeInTheDocument();
});

test('a form whose inputs do not fit this catalog says why; the presentation carries no command id', () => {
  draw({ ...form, error: 'Command input "account" has an unresolved reference resource or label column.' });
  expect(screen.getByText(/unresolved reference resource/)).toBeInTheDocument();
  const shown = formPresentation(form);
  expect(shown).toMatchObject({ id: 'log-call', label: 'Log a call', input: form.command.input, steps: form.steps });
  expect(shown).not.toHaveProperty('command');
});

test('a command that starts its form is prepared over no record first, and its values start the form', async () => {
  draw({ ...form, command: { ...form.command, prepares: true } });
  await waitFor(() => expect(screen.getByLabelText('Subject (required)')).toHaveValue('Evening window'));
  expect(calls[0]).toEqual(['/api/commands/prepare', expect.objectContaining({ command: 'logCall', commandVersion: 2, key: {} })]);
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByLabelText('Minutes')).toHaveValue(30));
});

test('what the command said it did is the done message, and an action with nothing to fill in offers no second run', async () => {
  answered = { message: 'Posted 55 rent charges for October 2026.' };
  draw({ id: 'post-rent', label: 'Post rent', command: { id: 'postRent', version: 1, input: [] } } as unknown as Parameters<
    typeof draw
  >[0]);
  fireEvent.click(await screen.findByRole('button', { name: 'Submit' }));
  expect(await screen.findByText('Posted 55 rent charges for October 2026.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Fill in another' })).toBeNull();
});
