import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PublicPlacementOperation, preparePublicPlacement, retainedPublicForm } from './publicPlacement.js';
import { PlacedFormSurface } from './components/PlacedFormSurface.js';
import { loadPublicForm } from './publicForm.js';
import type { PublicFormPlacement } from '../shared/publicPlacement.js';

let sequence = 0;
const prepared = (app = `placement-${++sequence}`, form = 'inquire') => ({
  app: { id: app, name: 'Forecourt' },
  form: {
    id: form,
    label: 'Inquire',
    input: [{ name: 'message', label: 'Your question', type: 'text' as const, required: true }],
    prefillable: ['message'],
    done: { title: 'Received' },
  },
  placement: {
    version: 1 as const,
    binding: `pp1.opaque-${++sequence}`,
    submission: `issuer-submission-${sequence}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    recoverUntil: new Date(Date.now() + 120_000).toISOString(),
    recoveryUrl: `https://canonical.example/api/forms/${form}/receipt`,
  },
});
const response = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const received = { reference: 'INQ-123', receipt: { id: 'receipt-1', status: 'applied' } };
const fetchMock = vi.fn();
const recordKey = (app: string) => `mistri:public-placement:${encodeURIComponent(app)}`;
const bodies = () => fetchMock.mock.calls.filter((call) => call[1]?.body).map((call) => JSON.parse(call[1].body));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('the issuer key and opaque binding travel only in the placed POST; metadata never includes answers', async () => {
  const envelope = prepared();
  const operation = new PublicPlacementOperation(envelope);
  let finish!: (value: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  operation.capture({ message: 'Private answer' });
  const sending = operation.send('a-client-key-that-must-not-be-used', { message: 'Private answer' });
  expect(operation.snapshot().phase).toBe('pending');
  expect(bodies()[0]).toEqual({
    input: { message: 'Private answer' },
    submission: envelope.placement.submission,
    placement: { version: 1, binding: envelope.placement.binding },
  });
  expect(fetchMock.mock.calls[0][1].credentials).toBe('omit');
  const stored = sessionStorage.getItem(recordKey(envelope.app.id))!;
  expect(stored).toContain(envelope.placement.binding);
  expect(stored).not.toMatch(/Private answer|message|input|values/);
  finish(response(200, received));
  await expect(sending).resolves.toEqual(received);
  expect(operation.snapshot().phase).toBe('applied');
  expect(sessionStorage.getItem(recordKey(envelope.app.id))).toBeNull();
  expect(retainedPublicForm(envelope.form.id, envelope.app.id)).toBeUndefined();
});

test('unknown answers stay frozen; not_found and a later not-applied refusal cannot unlock or rotate the attempt', async () => {
  const envelope = prepared();
  const operation = new PublicPlacementOperation(envelope);
  const input = { message: 'Original' };
  operation.capture(input);
  fetchMock
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(response(200, { status: 'not_found' }))
    .mockResolvedValueOnce(response(409, { code: 'placement_changed', outcome: 'not_applied' }))
    .mockResolvedValueOnce(response(200, received));
  await expect(operation.send('ignored', input)).rejects.toThrow(/haven’t confirmed/);
  input.message = 'Mutated';
  operation.capture(input);
  expect(operation.values).toEqual({ message: 'Original' });
  await operation.check();
  expect(operation.snapshot()).toMatchObject({ phase: 'unknown', message: expect.stringContaining('may still be finishing') });
  expect(fetchMock.mock.calls[1][0]).toBe(envelope.placement.recoveryUrl);
  expect(fetchMock.mock.calls[1][1].credentials).toBe('omit');
  expect(bodies()[1]).toEqual({
    submission: envelope.placement.submission,
    placement: { version: 1, binding: envelope.placement.binding },
  });
  await expect(operation.send('new-key', { message: 'New' })).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await operation.retry();
  expect(bodies()[2]).toEqual(bodies()[0]);
  expect(operation.snapshot().phase).toBe('unknown');
  await operation.check();
  expect(operation.snapshot()).toMatchObject({ phase: 'applied', receipt: received });
});

test('a first explicit not-applied validation refusal allows a field fix with the same issuer key', async () => {
  const operation = new PublicPlacementOperation(prepared());
  fetchMock
    .mockResolvedValueOnce(
      response(400, { code: 'invalid_input', outcome: 'not_applied', field: 'message', message: 'Please add more detail.' }),
    )
    .mockResolvedValueOnce(response(200, received));
  await expect(operation.send('ignored', { message: 'Short' })).rejects.toMatchObject({ code: 'invalid_input', field: 'message' });
  expect(operation.snapshot().phase).toBe('ready');
  await operation.send('another-ignored-key', { message: 'More detail' });
  expect(bodies()[1].submission).toBe(bodies()[0].submission);
  expect(bodies()[1].input).toEqual({ message: 'More detail' });
});

test('placed UI preserves field refusal focus before an unknown outcome, then disables answers and explicitly checks the receipt', async () => {
  const envelope = prepared();
  fetchMock
    .mockResolvedValueOnce(
      response(400, { code: 'invalid_input', outcome: 'not_applied', field: 'message', message: 'Please add more detail.' }),
    )
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(response(200, { status: 'not_found' }))
    .mockResolvedValueOnce(response(200, received));
  const first = render(<PlacedFormSurface prepared={envelope} prefill="message=Private+answer" />);
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(screen.getByLabelText('Your question (required)')).toHaveFocus());
  expect(screen.getByText('Please add more detail.')).toBeVisible();
  fireEvent.change(screen.getByLabelText('Your question (required)'), { target: { value: 'More private detail' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await screen.findByRole('button', { name: 'Check result' });
  expect(screen.getByLabelText('Your question (required)')).toBeDisabled();
  expect(document.body.innerHTML).not.toContain(envelope.placement.binding);
  expect(document.body.innerHTML).not.toContain(envelope.placement.submission);
  first.unmount();
  // The next open keeps both the original presentation and the in-memory answers.
  const newer = { ...prepared(envelope.app.id), form: { ...envelope.form, label: 'A changed form' } };
  expect(preparePublicPlacement(newer).placement).toEqual(envelope.placement);
  render(<PlacedFormSurface prepared={newer} prefill="message=Replacement" />);
  expect(screen.getByRole('heading', { name: 'Inquire' })).toBeVisible();
  expect(screen.getByLabelText('Your question (required)')).toHaveValue('More private detail');
  expect(screen.getByLabelText('Your question (required)')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Check result' }));
  await screen.findByText(/may still be finishing/);
  expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole('button', { name: 'Check result' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Received' })).toHaveFocus());
  expect(screen.getByText('INQ-123')).toBeVisible();
});

test('a restored attempt uses a fresh GET to trust the canonical URL, retains the old key, and has no answers to retry', async () => {
  const fresh = prepared();
  const old: PublicFormPlacement = { ...fresh.placement, binding: 'pp1.old-binding', submission: 'old-issued-submission' };
  sessionStorage.setItem(recordKey(fresh.app.id), JSON.stringify([{ form: fresh.form.id, placement: old }]));
  fetchMock.mockResolvedValueOnce(response(200, fresh)).mockResolvedValueOnce(response(200, received));
  const loaded = (await loadPublicForm(fresh.form.id, { appId: fresh.app.id, fresh: true }))!;
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(loaded.placement).toEqual(old);
  render(<PlacedFormSurface prepared={loaded} prefill="message=An+unrelated+new+prefill" />);
  expect(screen.getByText(/answers were not saved/)).toBeVisible();
  expect(screen.getByLabelText('Your question (required)')).toBeDisabled();
  expect(screen.getByLabelText('Your question (required)')).toHaveValue('');
  expect(screen.queryByRole('button', { name: 'Retry the same submission' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check result' }));
  await screen.findByRole('heading', { name: 'Received' });
  expect(fetchMock.mock.calls[1][0]).toBe(fresh.placement.recoveryUrl);
  expect(bodies()[0]).toEqual({ submission: old.submission, placement: { version: 1, binding: old.binding } });
});

test.each([
  'https://attacker.example/api/forms/inquire/receipt',
  'https://canonical.example/wrong/api/forms/inquire/receipt',
  'https://canonical.example/api/forms/other/receipt',
  'https://canonical.example/api/forms/inquire/receipt?send=elsewhere',
])('stored recovery URL %s cannot receive the binding', async (recoveryUrl) => {
  const fresh = prepared();
  sessionStorage.setItem(
    recordKey(fresh.app.id),
    JSON.stringify([{ form: fresh.form.id, placement: { ...fresh.placement, recoveryUrl } }]),
  );
  fetchMock.mockResolvedValueOnce(response(200, fresh));
  await expect(loadPublicForm(fresh.form.id, { appId: fresh.app.id, fresh: true })).rejects.toThrow(/could not be checked/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
});

test('malformed stored records and expired metadata are removed, while storage stays bounded to eight metadata-only attempts per App', async () => {
  const fresh = prepared();
  sessionStorage.setItem(
    recordKey(fresh.app.id),
    JSON.stringify([
      { form: fresh.form.id, placement: { ...fresh.placement, version: 2 } },
      { form: fresh.form.id, placement: fresh.placement, answers: { message: 'Never restore' } },
      {
        form: fresh.form.id,
        placement: { ...fresh.placement, expiresAt: '2020-01-01T00:00:00.000Z', recoverUntil: '2020-01-02T00:00:00.000Z' },
      },
    ]),
  );
  preparePublicPlacement(fresh);
  expect(sessionStorage.getItem(recordKey(fresh.app.id))).toBeNull();
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  for (let i = 0; i < 10; i++) {
    const operation = new PublicPlacementOperation(prepared(fresh.app.id, `form-${i}`));
    await expect(operation.send('ignored', { message: 'Private answer' })).rejects.toThrow();
  }
  const records = sessionStorage.getItem(recordKey(fresh.app.id))!;
  expect(JSON.parse(records)).toHaveLength(8);
  expect(records).not.toMatch(/Private answer|message|input|values/);
});

test('execution expiry stops retries but still allows receipt-only checks; recovery expiry never unlocks an unanswered attempt', async () => {
  vi.useFakeTimers();
  const envelope = prepared();
  const operation = new PublicPlacementOperation(envelope);
  fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(response(200, { status: 'not_found' }));
  await expect(operation.send('ignored', {})).rejects.toThrow();
  vi.setSystemTime(Date.parse(envelope.placement.expiresAt) + 1);
  expect(operation.canRetry()).toBe(false);
  await operation.retry();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await operation.check();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  vi.setSystemTime(Date.parse(envelope.placement.recoverUntil) + 1);
  await operation.check();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(operation.snapshot()).toMatchObject({ phase: 'unknown', message: expect.stringContaining('may have been received') });
});

test('close during send and reopen keeps one attempt without preparing; a resolved attempt gets a fresh issuer envelope next time', async () => {
  const envelope = prepared();
  const fresh = prepared(envelope.app.id);
  let finish!: (value: Response) => void;
  fetchMock
    .mockResolvedValueOnce(response(200, envelope))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(response(200, fresh));
  const loaded = (await loadPublicForm(envelope.form.id, { appId: envelope.app.id, fresh: true }))!;
  const first = render(<PlacedFormSurface prepared={loaded} prefill="message=Held" />);
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  first.unmount();
  const reopened = await loadPublicForm(envelope.form.id, { appId: envelope.app.id, fresh: true });
  expect(reopened).toBe(loaded);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  render(<PlacedFormSurface prepared={reopened!} />);
  expect(screen.getByLabelText('Your question (required)')).toHaveValue('Held');
  expect(screen.getByLabelText('Your question (required)')).toBeDisabled();
  await act(async () => {
    finish(response(200, received));
  });
  await screen.findByRole('heading', { name: 'Received' });
  const next = await loadPublicForm(envelope.form.id, { appId: envelope.app.id, fresh: true });
  expect(next?.placement?.submission).toBe(fresh.placement.submission);
  expect(next?.placement?.submission).not.toBe(loaded.placement?.submission);
});
