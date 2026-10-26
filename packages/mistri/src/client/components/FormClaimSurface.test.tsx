import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FormClaimSurface } from './FormClaimSurface.js';

const fetchMock = vi.fn();
const answer = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  json: async () => body,
});
const GONE = 'There is no application waiting to be added here. It may have been added already, declined, or timed out.';
/** The claim route as the server answers it: signed out, a claim naming a receipt, or none. */
function server(state: 'signed-out' | 'claim' | 'none') {
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { answer?: string };
    if (body.answer === 'no') return answer(200, { claim: null });
    if (state === 'signed-out') return answer(401, { code: 'unauthenticated', message: 'Sign in to add an application to your account.' });
    if (body.answer === 'yes')
      return state === 'claim'
        ? answer(200, { linked: { reference: 'APP-7K2M-QX4T-9BRD' } })
        : answer(404, { code: 'not_found', message: GONE });
    return answer(200, { claim: state === 'claim' ? { reference: 'APP-7K2M-QX4T-9BRD' } : null });
  });
}
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const form = { id: 'apply', label: 'Apply for financing' };
const answers = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));

test('signed out, the page is the sign-in: nothing is asked or spent', async () => {
  server('signed-out');
  const onSignIn = vi.fn();
  render(<FormClaimSurface form={form} appName="Ignition" onSignIn={onSignIn} />);
  await waitFor(() => expect(onSignIn).toHaveBeenCalledOnce());
  expect(answers()).toEqual([{}]);
});

test('signed in, the question names the application; Yes adds it and says where to follow it', async () => {
  server('claim');
  render(<FormClaimSurface form={form} appName="Ignition" statusHref="/ignition/form/apply/status" onSignIn={vi.fn()} />);
  expect(await screen.findByRole('heading', { name: 'Add it to your account?' })).toBeInTheDocument();
  expect(screen.getByText('APP-7K2M-QX4T-9BRD')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Yes, add it' }));
  expect(await screen.findByRole('heading', { name: 'Added to your account' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'See its status' })).toHaveAttribute('href', '/ignition/form/apply/status');
  expect(answers()).toEqual([{}, { answer: 'yes' }]);
});

test('No burns the claim; a claim that names nothing is said so, and offers no Yes', async () => {
  server('claim');
  render(<FormClaimSurface form={form} appName="Ignition" onSignIn={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'No' }));
  expect(await screen.findByRole('heading', { name: 'Not added' })).toBeInTheDocument();
  expect(answers()).toEqual([{}, { answer: 'no' }]);
  cleanup();
  server('none');
  render(<FormClaimSurface form={form} appName="Ignition" onSignIn={vi.fn()} />);
  expect(await screen.findByRole('heading', { name: 'Nothing to add' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Yes, add it' })).toBeNull();
});
