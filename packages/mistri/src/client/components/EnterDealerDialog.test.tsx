import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { SupportStatusReply } from '../../shared/tenantSupport.js';
import { EnterDealerDialog, type EnterDealerDialogProps } from './EnterDealerDialog.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const status = (patch: Partial<SupportStatusReply> = {}): SupportStatusReply => ({
  session: null,
  signInRequired: false,
  passwordSignIn: true,
  choices: [
    { tenantId: 'north', roles: ['branch_admin', 'branch_staff'] },
    { tenantId: 'south', roles: ['branch_staff'] },
  ],
  ...patch,
});
const props = (patch: Partial<EnterDealerDialogProps> = {}): EnterDealerDialogProps => ({
  status: status(),
  onSubmit: vi.fn(),
  onClose: vi.fn(),
  tenantLabel: 'Dealer',
  ...patch,
});

test('while the server is asked, the dialog says so and offers nothing to enter', () => {
  render(<EnterDealerDialog {...props({ status: null })} />);
  expect(screen.getByRole('dialog', { name: 'Enter a dealer' })).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Checking which dealers you may enter');
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.getByRole('button', { name: 'Enter dealer' })).toHaveAttribute('aria-disabled', 'true');
});

test('a dealer, then one of its roles, and a reason make the exact attempt; a sole role is preselected', async () => {
  const onSubmit = vi.fn(),
    user = userEvent.setup();
  render(<EnterDealerDialog {...props({ onSubmit })} />);
  expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('value'))).toEqual(['north', 'south']);
  await user.click(screen.getByRole('radio', { name: 'south' }));
  expect(screen.getByRole('radio', { name: 'Branch staff' })).toBeChecked();
  await user.click(screen.getByRole('radio', { name: 'north' }));
  expect(screen.getByRole('radio', { name: 'Branch admin' })).not.toBeChecked();
  await user.click(screen.getByRole('radio', { name: 'Branch admin' }));
  await user.type(screen.getByRole('textbox', { name: 'Reason' }), '  Checking a stuck application  ');
  await user.click(screen.getByRole('button', { name: 'Enter dealer' }));
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
    tenantId: 'north',
    dealerRole: 'branch_admin',
    reason: 'Checking a stuck application',
  });
});

test('a step that will not go on says why and sends the focus to the field to fix', async () => {
  const onSubmit = vi.fn(),
    user = userEvent.setup();
  render(<EnterDealerDialog {...props({ onSubmit })} />);
  await user.click(screen.getByRole('button', { name: 'Enter dealer' }));
  expect(screen.getByText('Choose the dealer to enter.')).toBeVisible();
  expect(screen.getByRole('radio', { name: 'north' })).toHaveFocus();
  await user.click(screen.getByRole('radio', { name: 'south' }));
  await user.click(screen.getByRole('button', { name: 'Enter dealer' }));
  const reason = screen.getByRole('textbox', { name: 'Reason' });
  expect(reason).toHaveFocus();
  expect(reason).toHaveAttribute('aria-invalid', 'true');
  // Pasted, not typed: 501 keystrokes through the dialog outlast a test's time on a busy
  // machine, and a timed-out test leaves its typing running into the next one.
  await user.click(reason);
  await user.paste('x'.repeat(501));
  await user.click(screen.getByRole('button', { name: 'Enter dealer' }));
  expect(screen.getByText(/one line, up to 500 characters/)).toBeVisible();
  expect(onSubmit).not.toHaveBeenCalled();
});

test('a login older than five minutes asks for a real sign-in; without a password provider it only explains', async () => {
  const onSubmit = vi.fn(),
    user = userEvent.setup();
  const tree = render(<EnterDealerDialog {...props({ status: status({ signInRequired: true }), onSubmit })} />);
  expect(screen.getByRole('region', { name: 'Confirm it is you' })).toHaveTextContent('a sign-in from the last five minutes');
  await user.click(screen.getByRole('radio', { name: 'south' }));
  await user.type(screen.getByRole('textbox', { name: 'Reason' }), 'Callback');
  await user.click(screen.getByRole('button', { name: 'Enter dealer' }));
  expect(screen.getByLabelText('Password')).toHaveFocus();
  expect(onSubmit).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText('Password'), 'secret-password');
  await user.click(screen.getByRole('button', { name: 'Enter dealer' }));
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
    tenantId: 'south',
    dealerRole: 'branch_staff',
    reason: 'Callback',
    password: 'secret-password',
  });
  tree.rerender(<EnterDealerDialog {...props({ status: status({ signInRequired: true, passwordSignIn: false }), onSubmit })} />);
  expect(screen.queryByLabelText('Password')).toBeNull();
  expect(screen.getByText(/Sign out and sign in again/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Enter dealer' })).toHaveAttribute('aria-disabled', 'true');
});

test('an attempt whose result is unknown is checked, never resent; busy keeps focus and refuses a second press', async () => {
  const onSubmit = vi.fn(),
    onCheck = vi.fn(),
    onClose = vi.fn(),
    user = userEvent.setup();
  const tree = render(
    <EnterDealerDialog {...props({ onSubmit, onCheck, onClose, unconfirmed: true, error: 'The session may have opened.' })} />,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('The session may have opened.');
  await user.click(screen.getByRole('button', { name: 'Enter dealer' }));
  expect(onSubmit).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Check the attempt' }));
  expect(onCheck).toHaveBeenCalledOnce();
  tree.rerender(<EnterDealerDialog {...props({ onSubmit, onCheck, onClose, unconfirmed: true, busy: true })} />);
  const check = screen.getByRole('button', { name: 'Check the attempt' });
  expect(check).toHaveAttribute('aria-disabled', 'true');
  await user.click(check);
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCheck).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
});

test('no grant, no dealer: the dialog says so plainly', () => {
  render(<EnterDealerDialog {...props({ status: status({ choices: [] }) })} />);
  expect(screen.getByText('No dealer is open to you for support.')).toBeVisible();
  expect(screen.queryByRole('radio')).toBeNull();
});

test('a dealer is offered by its name where it has one, and entered by its id', async () => {
  const onSubmit = vi.fn(),
    user = userEvent.setup();
  render(
    <EnterDealerDialog
      {...props({
        onSubmit,
        status: status({
          choices: [
            { tenantId: 'north', roles: ['branch_staff'], name: 'North Motors' },
            { tenantId: 'south', roles: ['branch_staff'] },
          ],
        }),
      })}
    />,
  );
  await user.click(screen.getByRole('radio', { name: 'North Motors' }));
  expect(screen.getByRole('group', { name: /North Motors/ })).toBeVisible();
  expect(screen.getByRole('radio', { name: 'south' })).toBeVisible();
  await user.type(screen.getByRole('textbox', { name: 'Reason' }), 'Checking a stuck application');
  await user.click(screen.getByRole('button', { name: 'Enter dealer' }));
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
    tenantId: 'north',
    dealerRole: 'branch_staff',
    reason: 'Checking a stuck application',
  });
});

test('a login an identity provider opened is confirmed there, never with a password', async () => {
  const onReauthenticate = vi.fn(),
    user = userEvent.setup();
  render(
    <EnterDealerDialog
      {...props({ status: status({ signInRequired: true, passwordSignIn: false, reauthenticate: 'workforce' }), onReauthenticate })}
    />,
  );
  expect(screen.queryByLabelText('Password')).toBeNull();
  expect(screen.queryByText(/Sign out and sign in again/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Enter dealer' })).toHaveAttribute('aria-disabled', 'true');
  await user.click(screen.getByRole('button', { name: 'Confirm at your sign-in provider' }));
  expect(onReauthenticate).toHaveBeenCalledExactlyOnceWith('workforce');
});

/* G37: the words are the App's own name for a tenant, wherever the dialog and its button say one; "tenant" where it
   names none. Never another App's word. */
test("the dialog and its button say what the App calls a tenant, and 'tenant' where it calls it nothing", () => {
  const { unmount } = render(<EnterDealerDialog {...props({ tenantLabel: 'Customer', status: status({ choices: [] }) })} />);
  expect(screen.getByRole('dialog', { name: 'Enter a customer' })).toBeVisible();
  expect(screen.getByText('No customer is open to you for support.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Enter customer' })).toBeVisible();
  expect(screen.queryByText(/dealer/i)).toBeNull();
  unmount();
  const agency = render(<EnterDealerDialog {...props({ tenantLabel: 'Agency', status: null })} />);
  expect(screen.getByRole('dialog', { name: 'Enter an agency' })).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Checking which agencies you may enter');
  agency.unmount();
  const { tenantLabel: _named, ...unnamed } = props();
  render(<EnterDealerDialog {...unnamed} />);
  expect(screen.getByRole('dialog', { name: 'Enter a tenant' })).toBeVisible();
  expect(screen.getByRole('group', { name: 'Tenant' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Enter tenant' })).toBeVisible();
});
