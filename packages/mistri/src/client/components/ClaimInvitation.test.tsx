/**
 * The signed-out claim form, drawn and driven against a fetch that answers
 * as the tenant host's claim route does. What it must never do: send a
 * malformed token or unmatched passwords, keep a password after a submit, or
 * say more than the server's answer.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';
import { ClaimInvitation } from './ClaimInvitation.js';

const token = `twi1.11111111-1111-4111-8111-111111111111.${'A'.repeat(43)}`;
const calls: Array<{ path: string; init: RequestInit }> = [];
let answer: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit) => {
      calls.push({ path, init });
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function draw() {
  const onClaimed = vi.fn(),
    onCancel = vi.fn();
  render(createElement(ClaimInvitation, { appId: 'dealer-desk', onClaimed, onCancel }));
  return { onClaimed, onCancel };
}
async function fill(values: Partial<Record<'token' | 'name' | 'password' | 'confirm', string>> = {}) {
  const user = userEvent.setup();
  const all = { token, name: 'Ada Lovelace', password: 'correct-horse-9', confirm: 'correct-horse-9', ...values };
  if (all.token) await user.type(screen.getByLabelText('Invitation token'), all.token);
  if (all.name) await user.type(screen.getByLabelText('Name'), all.name);
  if (all.password) await user.type(screen.getByLabelText('Password'), all.password);
  if (all.confirm) await user.type(screen.getByLabelText('Confirm password'), all.confirm);
  await user.click(screen.getByRole('button', { name: 'Create account and join' }));
  return user;
}

/** What the form said: beside the field it is about, or in its own alert when it is about no one field. */
function told(): string {
  const beside = document.querySelector('.form-field-problem:not([hidden])');
  return (beside ?? screen.getByRole('alert')).textContent ?? '';
}

describe('claiming an account-creating invitation', () => {
  test('sends exactly the token, name and password, then hands the address to sign-in', async () => {
    answer = {
      status: 200,
      body: { outcome: 'applied', account: 'created', email: 'ada@example.test', result: { status: 'accepted', tenantId: 'north' } },
    };
    const { onClaimed } = draw();
    await fill();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/tenant/invitations/claim?app=dealer-desk');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ token, name: 'Ada Lovelace', password: 'correct-horse-9' });
    expect(Object.keys(calls[0].init.headers as Record<string, string>).some((name) => name.startsWith('x-mistri-'))).toBe(false);
    expect(onClaimed).toHaveBeenCalledWith('ada@example.test');
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Invitation token') as HTMLInputElement).value).toBe('');
  });

  test('refuses a malformed token and unmatched passwords without a request, naming the field', async () => {
    draw();
    await fill({ token: 'not-a-token' });
    expect(calls).toHaveLength(0);
    expect(told()).toMatch(/exactly as you were given it/);
    expect(screen.getByLabelText('Invitation token').getAttribute('aria-invalid')).toBe('true');
    // Said beside the field, and named in its description.
    expect(screen.getByLabelText('Invitation token')).toHaveAccessibleDescription(/exactly as you were given it/);
    expect(document.activeElement).toBe(screen.getByLabelText('Invitation token'));
    cleanup();
    draw();
    await fill({ confirm: 'correct-horse-0' });
    expect(calls).toHaveLength(0);
    expect(told()).toBe('The passwords do not match.');
    expect(screen.getByLabelText('Confirm password').getAttribute('aria-invalid')).toBe('true');
  });

  test.each([
    [403, { error: 'x', code: 'tenant_invitation_unavailable', outcome: 'not_applied' }, /cannot be used/, false],
    [409, { error: 'x', code: 'account_exists', outcome: 'not_applied' }, /already uses this invitation's email address\. Sign in/, true],
    [
      503,
      { error: 'x', code: 'claim_incomplete', account: 'created', outcome: 'not_applied' },
      /account was created, but the invitation is not accepted/,
      true,
    ],
    [400, { error: 'x', code: 'invalid_account', outcome: 'not_applied' }, /name of 1 to 120/, false],
    [429, { code: 'rate_limited', retryAfter: 42 }, /Try again in 42 seconds/, false],
    [500, { anything: true }, /could not be confirmed/, false],
  ])('answer %i says only what it means and keeps no password', async (status, body, said, spent) => {
    answer = { status, body };
    const { onClaimed } = draw();
    await fill();
    expect(told()).toMatch(said);
    expect(onClaimed).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Confirm password') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Invitation token') as HTMLInputElement).value).toBe(spent ? '' : token);
  });

  test('a 200 that is not a confirmed claim is not taken for one', async () => {
    answer = { status: 200, body: { outcome: 'applied', account: 'created', result: { status: 'accepted', tenantId: 'north' } } };
    const { onClaimed } = draw();
    await fill();
    expect(onClaimed).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/could not be confirmed/);
  });

  test('back to sign in is a plain button', async () => {
    const { onCancel } = draw();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
