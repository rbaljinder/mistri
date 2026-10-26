import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { themePreset } from '../../../../engine/src/shared/themePresets.js';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../../../kit/src/client/core.js', () => ({ api }));

import { BrandingForm } from './BrandingForm.js';

const state = (editor: boolean, branding: Record<string, unknown> = {}) => ({
  branding,
  revision: 0,
  editor,
  allow: ['name', 'logo', 'accent', 'density'],
  themes: [themePreset('mono')],
});

beforeEach(() => api.mockReset());
afterEach(() => cleanup());

test('a member who is not an editor reads the branding and cannot change it', async () => {
  api.mockResolvedValueOnce(state(false, { name: 'North Co' }));
  render(<BrandingForm />);
  expect(await screen.findByText("Only this organization's admins can change its branding.")).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: /Name/ })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  expect(api).toHaveBeenCalledWith('/api/branding', {});
});

test('an editor sees the draft in the preview, an unreadable accent holds the save, and a save sends only what the App allows', async () => {
  api.mockResolvedValueOnce(state(true));
  render(<BrandingForm />);
  const name = await screen.findByRole('textbox', { name: /Name/ });
  fireEvent.change(name, { target: { value: 'North Co' } });
  const preview = screen.getByRole('region', { name: 'Preview' });
  expect(within(preview).getAllByText('North Co').length).toBeGreaterThan(0);

  const [, typed] = screen.getAllByLabelText('Accent color');
  fireEvent.change(typed!, { target: { value: '#f5f5f5' } });
  expect(await screen.findByText(/This accent is too light/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

  fireEvent.change(typed!, { target: { value: '#1d4ed8' } });
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  expect(preview.style.getPropertyValue('--bp-accent')).toBe('#1d4ed8');

  api.mockResolvedValueOnce({ ...state(true, { name: 'North Co', accent: { light: '#1d4ed8', dark: '#9db8f2' } }), revision: 1 });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  const [address, body] = api.mock.calls[1]!;
  expect(address).toBe('/api/branding/save');
  expect(body).toEqual({ branding: { name: 'North Co', accent: expect.objectContaining({ light: '#1d4ed8' }) } });
  expect(await screen.findByText('Saved. Your people see it on their next page.')).toBeInTheDocument();
});

test("the server's refusal is said beside the field it names", async () => {
  api.mockResolvedValueOnce(state(true));
  render(<BrandingForm />);
  fireEvent.change(await screen.findByRole('textbox', { name: /Name/ }), { target: { value: 'North Co' } });
  api.mockResolvedValueOnce({
    error: 'The name must be one line of at most 80 characters, without < or >.',
    errors: [{ field: 'name', message: 'The name must be one line of at most 80 characters, without < or >.' }],
    code: 'branding_refused',
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect((await screen.findAllByText('The name must be one line of at most 80 characters, without < or >.')).length).toBeGreaterThan(0);
});

test('the dark logo is offered only beside a logo, and removing it sends null for it alone', async () => {
  const light = { hash: 'a'.repeat(64), type: 'image/png' };
  api.mockResolvedValueOnce(state(true));
  const bare = render(<BrandingForm />);
  await screen.findByRole('textbox', { name: /Name/ });
  expect(screen.queryByText('For a dark bar')).toBeNull();
  bare.unmount();

  api.mockResolvedValueOnce(state(true, { logo: light, logoDark: { hash: 'b'.repeat(64), type: 'image/png' } }));
  render(<BrandingForm />);
  expect(await screen.findByText('For a dark bar')).toBeInTheDocument();
  // The logo's Remove comes first, the dark logo's after it.
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!);
  api.mockResolvedValueOnce({ ...state(true, { logo: light }), revision: 1 });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(3));
  const [, body] = api.mock.calls[2]!;
  expect(body).toEqual({ branding: {}, darkLogo: null });
});
