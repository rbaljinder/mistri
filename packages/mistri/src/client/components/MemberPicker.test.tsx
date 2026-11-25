/* A member input's picker: the team's names from the members' own read, the reader marked, and the pick is the account id. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

const core = vi.hoisted(() => ({ api: vi.fn() }));
const identity = vi.hoisted(() => ({
  current: { mode: 'authenticated' as const, epoch: 1, accountId: 'eve', tenant: { tenantId: 'north' } },
}));
vi.mock('@mistriwork/kit/client/core.js', () => core);
vi.mock('@mistriwork/kit/client/sessionIdentity.js', () => ({ captureAccountIdentity: () => identity.current }));
const { MemberPicker, forgetTeamNames } = await import('./MemberPicker.js');

beforeEach(() => {
  forgetTeamNames();
  core.api.mockReset();
  identity.current = { mode: 'authenticated', epoch: 1, accountId: 'eve', tenant: { tenantId: 'north' } };
});
afterEach(cleanup);

test('it lists the team by name, marks the reader, and picks by account id', async () => {
  core.api.mockResolvedValue({
    members: [
      { id: 'mem-1', account: 'eve', name: 'Eve Adams', you: true },
      { id: 'mem-2', account: 'bo', name: 'Bo Brown', you: false },
      { id: 'mem-3', account: 'nameless', name: '', you: false },
    ],
  });
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <>
      <span id="owner-label">Owner</span>
      <MemberPicker id="owner" label="Owner" value={undefined} onChange={onChange} />
    </>,
  );
  expect(core.api).toHaveBeenCalledWith('/api/team', {});
  const trigger = screen.getByRole('button', { name: /^Owner\b/ });
  await waitFor(() => expect(trigger).not.toBeDisabled());
  await user.click(trigger);
  const options = await screen.findAllByRole('option');
  expect(options.map((option) => option.textContent)).toEqual(['Choose owner', 'Eve Adams (you)', 'Bo Brown', 'Someone on the team']);
  await user.click(options[2]);
  expect(onChange).toHaveBeenCalledWith('bo');
});

test('switching tenants reads the new team rather than showing the last tenant, and an optional pick can be cleared', async () => {
  core.api
    .mockResolvedValueOnce({ members: [{ id: 'mem-1', account: 'eve', name: 'Eve North', you: true }] })
    .mockResolvedValueOnce({ members: [{ id: 'mem-9', account: 'sam', name: 'Sam South', you: false }] });
  const user = userEvent.setup();
  const onChange = vi.fn();
  const view = render(
    <>
      <span id="owner-label">Owner</span>
      <MemberPicker id="owner" label="Owner" value="sam" optional onChange={onChange} />
    </>,
  );
  const trigger = screen.getByRole('button', { name: /^Owner\b/ });
  await waitFor(() => expect(core.api).toHaveBeenCalledTimes(1));
  identity.current = { mode: 'authenticated', epoch: 1, accountId: 'eve', tenant: { tenantId: 'south' } };
  view.rerender(
    <>
      <span id="owner-label">Owner</span>
      <MemberPicker id="owner" label="Owner" value="sam" optional onChange={onChange} />
    </>,
  );
  await waitFor(() => expect(core.api).toHaveBeenCalledTimes(2));
  await user.click(trigger);
  const options = await screen.findAllByRole('option');
  expect(options.map((option) => option.textContent)).toEqual(['None', 'Sam South']);
  await user.click(options[0]);
  expect(onChange).toHaveBeenCalledWith('');
});

test('where the team cannot be listed the picker says so and takes nothing', async () => {
  core.api.mockRejectedValue(new Error('not found'));
  render(
    <>
      <span id="owner-label">Owner</span>
      <MemberPicker id="owner" label="Owner" value={undefined} onChange={() => {}} />
    </>,
  );
  const trigger = screen.getByRole('button', { name: /^Owner\b/ });
  await waitFor(() => expect(trigger).toBeDisabled());
  expect(trigger.textContent).toContain('The team cannot be listed here');
});
