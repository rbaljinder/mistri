/* A member input's picker: the team's names from the members' own read, the reader marked, and the pick is the account id. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

const core = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@mistriwork/kit/client/core.js', () => core);
const { MemberPicker, forgetTeamNames } = await import('./MemberPicker.js');

beforeEach(() => {
  forgetTeamNames();
  core.api.mockReset();
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
