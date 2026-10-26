import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../../../kit/src/client/core.js', () => ({ api }));

import { IntegrationsForm } from './IntegrationsForm.js';

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
  const card = screen.getByRole('form', { name: 'fakepay' });
  expect(within(card).getAllByText(/^Set /)).toHaveLength(2);
  expect(card.querySelector('input[type="password"]')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  expect(api).toHaveBeenCalledWith('/api/integrations', {});
});

test('an editor saves only the secrets typed, and the field is empty again after', async () => {
  api.mockResolvedValueOnce(state(true));
  render(<IntegrationsForm />);
  const card = await screen.findByRole('form', { name: 'fakepay' });
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
  const card = await screen.findByRole('form', { name: 'fakepay' });
  fireEvent.change(card.querySelector('input[type="password"]')!, { target: { value: 'x' } });
  api.mockResolvedValueOnce({ error: 'fakepay takes no secret "apiKy".' });
  fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
  expect(await within(card).findByText('fakepay takes no secret "apiKy".')).toBeInTheDocument();
});
