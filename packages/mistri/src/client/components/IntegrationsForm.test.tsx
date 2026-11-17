import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../../../kit/src/client/core.js', () => ({ api }));

import { IntegrationsForm, readableName } from './IntegrationsForm.js';

const state = (editor: boolean, set = false) => ({
  editor,
  integrations: [
    {
      name: 'fakepay',
      secrets: [
        { name: 'apiKey', set, savedAt: set ? Date.UTC(2026, 9, 1) : null },
        { name: 'webhookSecret', set, savedAt: set ? Date.UTC(2026, 9, 1) : null },
      ],
      webhook: '/api/inbound/fakepay/north',
      channel: 'sms',
    },
  ],
});

beforeEach(() => api.mockReset());
afterEach(() => cleanup());

test('a member who is not an editor reads which secrets are set, and gets no input to change them', async () => {
  api.mockResolvedValueOnce(state(false, true));
  render(<IntegrationsForm />);
  expect(await screen.findByText("Only this organization's admins can change its integrations.")).toBeInTheDocument();
  const card = screen.getByRole('form', { name: 'Fakepay' });
  expect(within(card).getAllByText(/^Set /)).toHaveLength(2);
  expect(card.querySelector('input[type="password"]')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  expect(api).toHaveBeenCalledWith('/api/integrations', {});
});

test('an editor saves only the secrets typed, and the field is empty again after', async () => {
  api.mockResolvedValueOnce(state(true));
  render(<IntegrationsForm />);
  const card = await screen.findByRole('form', { name: 'Fakepay' });
  expect(within(card).getByDisplayValue('/api/inbound/fakepay/north')).toBeInTheDocument();
  expect(within(card).getByRole('button', { name: 'Save' })).toBeDisabled();
  const [apiKey] = card.querySelectorAll<HTMLInputElement>('input[type="password"]');
  fireEvent.change(apiKey!, { target: { value: 'sk_north' } });
  api.mockResolvedValueOnce(state(true, true));
  fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(api.mock.calls[1]).toEqual(['/api/integrations/save', { integration: 'fakepay', secrets: { apiKey: 'sk_north' } }]);
  expect(await screen.findByText('Saved. The next call uses it.')).toBeInTheDocument();
  expect(screen.queryByDisplayValue('sk_north')).toBeNull();
});

test("the server's refusal is said on the card", async () => {
  api.mockResolvedValueOnce(state(true));
  render(<IntegrationsForm />);
  const card = await screen.findByRole('form', { name: 'Fakepay' });
  fireEvent.change(card.querySelector('input[type="password"]')!, { target: { value: 'x' } });
  api.mockResolvedValueOnce({ error: 'fakepay takes no secret "apiKy".' });
  fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
  expect(await within(card).findByText('fakepay takes no secret "apiKy".')).toBeInTheDocument();
});

test('a page given its integrations shows those alone, in that order, and a save keeps it so', async () => {
  const two = { ...state(true), integrations: [...state(true).integrations, { ...state(true).integrations[0]!, name: 'fakesms' }] };
  api.mockResolvedValueOnce(two);
  render(<IntegrationsForm only={['fakesms']} />);
  const card = await screen.findByRole('form', { name: 'Fakesms' });
  expect(screen.queryByRole('form', { name: 'Fakepay' })).toBeNull();
  fireEvent.change(card.querySelector('input[type="password"]')!, { target: { value: 'k' } });
  api.mockResolvedValueOnce(two);
  fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole('form', { name: 'Fakesms' })).toBeInTheDocument();
  expect(screen.queryByRole('form', { name: 'Fakepay' })).toBeNull();
});

test('names read as sentences: keys spelled any way, acronyms in capitals', () => {
  expect(readableName('apiKey')).toBe('API key');
  expect(readableName('webhookSecret')).toBe('Webhook secret');
  expect(readableName('STRIPE_SECRET_KEY')).toBe('Stripe secret key');
  expect(readableName('twilio-sms')).toBe('Twilio SMS');
  expect(readableName('stripe')).toBe('Stripe');
});

test('each card says its connection: not configured, partly, configured; and keeps the raw keys out of the labels', async () => {
  api.mockResolvedValueOnce(state(true, false));
  const { unmount } = render(<IntegrationsForm />);
  const card = await screen.findByRole('form', { name: 'Fakepay' });
  expect(within(card).getByRole('heading', { name: 'Fakepay' })).toBeInTheDocument();
  expect(within(card).getByText('Not configured: no secret is saved yet.')).toBeInTheDocument();
  expect(within(card).getByLabelText('API key')).toBeInTheDocument();
  expect(within(card).getByLabelText('Webhook secret')).toBeInTheDocument();
  expect(within(card).queryByText('apiKey')).toBeNull();
  // There is no provider check to call, so the card offers no "Test connection".
  expect(within(card).queryByRole('button', { name: /test/i })).toBeNull();
  unmount();
  const partly = state(false, true);
  partly.integrations[0]!.secrets[1]!.set = false;
  api.mockResolvedValueOnce(partly);
  render(<IntegrationsForm />);
  expect(await screen.findByText('Partly configured: 1 of 2 secrets saved.')).toBeInTheDocument();
  cleanup();
  api.mockResolvedValueOnce(state(false, true));
  render(<IntegrationsForm />);
  expect(await screen.findByText('Configured: every secret is saved.')).toBeInTheDocument();
});

test('a declared label and description stand in place of the humanized name', async () => {
  const given = state(false, true);
  given.integrations[0] = { ...given.integrations[0]!, label: 'FakePay', description: 'Takes card payments.' } as never;
  api.mockResolvedValueOnce(given);
  render(<IntegrationsForm />);
  const card = await screen.findByRole('form', { name: 'FakePay' });
  expect(within(card).getByRole('heading', { name: 'FakePay' })).toBeInTheDocument();
  expect(within(card).getByText('Takes card payments.')).toBeInTheDocument();
});

test('Test connection is offered to an editor when the integration declares a check, and says what came back', async () => {
  const given = state(true, true);
  given.integrations[0] = { ...given.integrations[0]!, canCheck: true } as never;
  api.mockResolvedValueOnce(given);
  render(<IntegrationsForm />);
  const card = await screen.findByRole('form', { name: 'Fakepay' });
  api.mockResolvedValueOnce({ ok: false, message: 'FakePay refused the API key.' });
  fireEvent.click(within(card).getByRole('button', { name: 'Test connection' }));
  expect(await within(card).findByText('FakePay refused the API key.')).toBeInTheDocument();
  expect(api).toHaveBeenLastCalledWith('/api/integrations/check', { integration: 'fakepay' });
  api.mockResolvedValueOnce({ ok: true });
  fireEvent.click(within(card).getByRole('button', { name: 'Test connection' }));
  expect(await within(card).findByText('Connected.')).toBeInTheDocument();
  api.mockRejectedValueOnce(new Error('boom sk_live_secret'));
  fireEvent.click(within(card).getByRole('button', { name: 'Test connection' }));
  expect(await within(card).findByText('The connection could not be tested.')).toBeInTheDocument();
});

test('no Test connection without a declared check, and none for a reader who cannot edit', async () => {
  const plain = state(true, true);
  api.mockResolvedValueOnce(plain);
  const first = render(<IntegrationsForm />);
  await screen.findByRole('form', { name: 'Fakepay' });
  expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull();
  first.unmount();
  const reader = state(false, true);
  reader.integrations[0] = { ...reader.integrations[0]!, canCheck: true } as never;
  api.mockResolvedValueOnce(reader);
  render(<IntegrationsForm />);
  await screen.findByRole('form', { name: 'Fakepay' });
  expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull();
});
