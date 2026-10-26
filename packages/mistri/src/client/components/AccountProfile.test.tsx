import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { AccountProfile } from './AccountProfile.js';
import { AccountControl } from './AccountControl.js';
import { establishSessionIdentity } from '../../../../kit/src/client/sessionIdentity.js';
import { configureSessionLifecycle } from '../../../../kit/src/client/sessionLifecycle.js';

const initial = { accountId: 'ada', appId: 'crm', name: 'Ada', email: 'ada@example.test', providers: ['email'] };
const reply = (name = 'Ada', saved = false) =>
  new Response(JSON.stringify({ profile: { ...initial, name }, ...(saved ? { outcome: 'applied' } : {}) }), {
    headers: { 'x-mistri-account': 'ada', 'content-type': 'application/json' },
  });
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  configureSessionLifecycle({ onLock: () => {} });
  establishSessionIdentity({ signedIn: true, accountId: 'ada', appId: 'crm' });
  fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply());
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  configureSessionLifecycle({ onLock: () => {} });
});
async function draw() {
  const onClose = vi.fn();
  const view = render(<AccountProfile onClose={onClose} />);
  await vi.waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Ada'));
  return { ...view, onClose };
}
const change = (name: string) => fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });

test('old bootstrap and unsupported runtimes expose no profile entry', async () => {
  render(<AccountControl who="Ada" />);
  await userEvent.click(screen.getByRole('button', { name: 'Account: Ada' }));
  expect(screen.queryByRole('menuitem', { name: 'Your profile' })).toBeNull();
  expect(screen.getAllByRole('menuitem')).toHaveLength(1);
  expect(fetcher).not.toHaveBeenCalled();
});

test('supported menu opens profile without sign-out, focuses name and returns keyboard focus on Escape', async () => {
  const user = userEvent.setup();
  render(<AccountControl who="Ada" accountProfile />);
  const trigger = screen.getByRole('button', { name: 'Account: Ada' });
  trigger.focus();
  await user.keyboard('{ArrowDown}');
  await vi.waitFor(() => expect(screen.getByRole('menuitem', { name: 'Your profile' })).toHaveFocus());
  await user.keyboard('{Enter}');
  await vi.waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
  expect(screen.getByLabelText('Email')).toHaveAttribute('readonly');
  expect(screen.getByText('Email and password')).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0][0])).toBe('/api/auth/profile?app=crm');
  await user.keyboard('{Escape}');
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await vi.waitFor(() => expect(trigger).toHaveFocus());
});

test('name save trims and submits only name with captured account; identity fields stay read-only', async () => {
  await draw();
  expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
  change('  Ada Lovelace  ');
  fetcher.mockResolvedValueOnce(reply('Ada Lovelace', true));
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  await screen.findByText('Name saved.');
  const [, init] = fetcher.mock.calls[1];
  expect(init).toMatchObject({
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    body: '{"name":"Ada Lovelace"}',
    headers: { 'x-mistri-account': 'ada', 'content-type': 'application/json' },
  });
  expect(screen.getByLabelText('Name')).toHaveValue('Ada Lovelace');
  expect(screen.getByLabelText('Email')).toHaveValue(initial.email);
});

test.each([' ', 'x'.repeat(121), 'bad\u0000name'])('invalid name %j never submits, and says why beside the field', async (name) => {
  await draw();
  change(name);
  fireEvent.submit(screen.getByLabelText('Name').closest('form')!);
  expect(fetcher).toHaveBeenCalledTimes(1);
  // The problem is the field's: it is marked, described by the sentence, and holds the focus.
  const field = screen.getByLabelText('Name');
  await vi.waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));
  expect(field).toHaveAccessibleDescription(/between 1 and 120 characters/);
  expect(field).toHaveFocus();
});

test('pending save refuses double submission and Escape/close until acknowledgment', async () => {
  const { onClose } = await draw();
  change('New name');
  let release!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const form = screen.getByLabelText('Name').closest('form')!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  await userEvent.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Close profile' })).toBeDisabled();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => release(reply('New name', true)));
  expect(screen.getByText('Name saved.')).toBeInTheDocument();
});

test('lost response stays uncertain; busy recovery cannot enable repeat save; settled read recovers current name', async () => {
  await draw();
  change('New name');
  fetcher.mockRejectedValueOnce(new TypeError('private network diagnostics'));
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be confirmed');
  expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
  expect(screen.getByLabelText('Name')).toBeDisabled();
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValueOnce(
    new Response(JSON.stringify({ code: 'profile_busy', outcome: 'not_applied' }), {
      status: 409,
      headers: { 'x-mistri-account': 'ada' },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Check current profile' }));
  await vi.waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('still in progress'));
  expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
  fetcher.mockResolvedValueOnce(reply('New name'));
  fireEvent.click(screen.getByRole('button', { name: 'Check current profile' }));
  await screen.findByText('Current profile loaded. Review it before making another change.');
  expect(screen.getByLabelText('Name')).toHaveValue('New name');
  expect(screen.getByLabelText('Name')).toBeEnabled();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

test.each([false, true])('late save completion cannot repopulate a new session (failure=%s)', async (failure) => {
  await draw();
  change('Old account name');
  let resolve!: (response: Response) => void, reject!: (error: Error) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  act(() => {
    establishSessionIdentity({ signedIn: true, accountId: 'bob', appId: 'crm' });
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => {
    if (failure) reject(new Error('private failure'));
    else resolve(reply('Old account name', true));
  });
  expect(screen.queryByText('Name saved.')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  act(() => {
    establishSessionIdentity({ signedIn: true, accountId: 'ada', appId: 'crm' });
  });
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('load failure offers an explicit read retry, without a save', async () => {
  fetcher.mockRejectedValueOnce(new Error('private provider failure'));
  render(<AccountProfile onClose={() => {}} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
  expect(screen.queryByLabelText('Name')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check current profile' }));
  await vi.waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Ada'));
  expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});

test('a malformed success acknowledgment does not claim the save succeeded', async () => {
  await draw();
  change('Changed');
  fetcher.mockResolvedValueOnce(reply('Changed')); // Missing explicit applied acknowledgment.
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be confirmed');
  expect(screen.queryByText('Name saved.')).toBeNull();
  expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
});

test('a confirmed pre-mutation refusal allows correction without inventing a save', async () => {
  await draw();
  change('Changed');
  fetcher.mockResolvedValueOnce(
    new Response(JSON.stringify({ outcome: 'not_applied', code: 'invalid_profile', error: 'private message' }), {
      status: 400,
      headers: { 'x-mistri-account': 'ada' },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  await screen.findByText('The profile request was not applied. Check your name and try again.');
  expect(screen.getByLabelText('Name')).toBeEnabled();
  expect(screen.queryByText('private message')).toBeNull();
  expect(screen.queryByText('Name saved.')).toBeNull();
});

/* An App whose settings record is called "Your profile" too (a borrower's own
   record): the menu says each thing once, the sign-in's details as "Your account". */
test("a settings record named Your profile leaves the sign-in's own item as Your account", async () => {
  const { setMenuGroup, setMenuMode } = await import('../../../../kit/src/client/menu.js');
  setMenuMode('app');
  setMenuGroup('ks-settings', [{ label: 'Your profile', category: 'Settings', scope: 'app', onSelect: () => {} }]);
  try {
    render(<AccountControl who="Ada" accountProfile />);
    await userEvent.click(screen.getByRole('button', { name: 'Account: Ada' }));
    await vi.waitFor(() => expect(screen.getAllByRole('menuitem', { name: 'Your profile' })).toHaveLength(1));
    expect(screen.getByRole('menuitem', { name: 'Your account' })).toBeInTheDocument();
  } finally {
    setMenuGroup('ks-settings', []);
    setMenuMode('workbench');
  }
});
