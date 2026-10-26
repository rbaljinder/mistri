import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { TenantChooser, TenantControl, type TenantChooserProps } from './TenantChooser.js';

const props: TenantChooserProps = { appName: 'Compass', tenantIds: ['north', 'south'], onSelect: () => {} };
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('the preselection panel names the App and offers only explicit tenant IDs', () => {
  render(<TenantChooser {...props} />);
  expect(screen.getByRole('region', { name: 'Choose a tenant' })).toBeVisible();
  expect(screen.getByRole('heading', { level: 1, name: 'Choose a tenant' })).toBeVisible();
  expect(screen.getByText('Compass')).toBeVisible();
  expect(screen.getByRole('list', { name: 'Available tenants' })).toBeVisible();
  expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['north', 'south']);
  expect(screen.queryByRole('link')).toBeNull();
});

test('the platform realm is one more explicit choice, named by its label and never by its reserved id', async () => {
  const onSelect = vi.fn(),
    user = userEvent.setup();
  const choices = { ...props, tenantIds: ['north', '@platform'], platformLabel: 'Lender', onSelect };
  const tree = render(<TenantChooser {...choices} />);
  expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['north', 'Lender']);
  await user.click(screen.getByRole('button', { name: 'Lender' }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('@platform');
  tree.rerender(<TenantChooser {...choices} currentTenant="@platform" />);
  expect(screen.getByText('Lender', { selector: '.tenant-chooser-current bdi' })).toBeVisible();
  expect(document.body.textContent).not.toMatch(/@platform|Tenant: Lender/);
  cleanup();
  render(<TenantControl {...choices} currentTenant="@platform" />);
  expect(screen.getByRole('button', { name: 'Lender' })).toBeVisible();
});

test('a sole tenant is never selected on mount or rerender', async () => {
  const onSelect = vi.fn(),
    user = userEvent.setup();
  const tree = render(<TenantChooser {...props} tenantIds={['north']} onSelect={onSelect} />);
  expect(onSelect).not.toHaveBeenCalled();
  tree.rerender(<TenantChooser {...props} tenantIds={['north']} onSelect={onSelect} />);
  expect(onSelect).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'north' }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('north');
});

test.each(['{Enter}', ' '])('tenant buttons make an explicit keyboard choice with %s', async (key) => {
  const onSelect = vi.fn(),
    user = userEvent.setup();
  render(<TenantChooser {...props} onSelect={onSelect} />);
  screen.getByRole('button', { name: 'south' }).focus();
  await user.keyboard(key);
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('south');
});

test('empty discovery explains access without offering signup or inventing a tenant', () => {
  render(<TenantChooser {...props} tenantIds={[]} />);
  expect(screen.getByText('No available tenants. Contact your administrator for access.')).toBeVisible();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('list')).toBeNull();
  expect(screen.queryByText(/sign up|create account/i)).toBeNull();
});

test('busy discovery is not presented as an empty membership result', () => {
  render(<TenantChooser {...props} tenantIds={[]} busy />);
  expect(screen.getByRole('status')).toHaveTextContent('Please wait…');
  expect(screen.queryByText(/No available tenants/)).toBeNull();
});

test('a discovery error is an alert, not a false empty or loading result', async () => {
  const onRetry = vi.fn(),
    user = userEvent.setup();
  render(<TenantChooser {...props} tenantIds={[]} error="Tenant access could not be confirmed." onRetry={onRetry} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Tenant access could not be confirmed.');
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByText(/No available tenants/)).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Check again' }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test('busy disables choices and retry, then follows the caller acknowledgement', async () => {
  const onSelect = vi.fn(),
    onRetry = vi.fn(),
    user = userEvent.setup();
  const tree = render(<TenantChooser {...props} busy onSelect={onSelect} onRetry={onRetry} />);
  expect(screen.getByRole('list')).toHaveAttribute('aria-busy', 'true');
  for (const button of screen.getAllByRole('button')) {
    expect(button).toBeDisabled();
    fireEvent.click(button);
  }
  expect(onSelect).not.toHaveBeenCalled();
  expect(onRetry).not.toHaveBeenCalled();
  tree.rerender(<TenantChooser {...props} onSelect={onSelect} onRetry={onRetry} />);
  expect(screen.queryByRole('status')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'north' }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('north');
});

test('retry is available for an empty result only when the caller supports it', async () => {
  const onRetry = vi.fn(),
    user = userEvent.setup();
  const tree = render(<TenantChooser {...props} tenantIds={[]} />);
  expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
  tree.rerender(<TenantChooser {...props} tenantIds={[]} onRetry={onRetry} />);
  await user.click(screen.getByRole('button', { name: 'Check again' }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test('current tenant is explicitly labelled without inventing current membership availability', () => {
  const tree = render(<TenantChooser {...props} currentTenant="north" />);
  expect(document.querySelector('.tenant-chooser-current')).toHaveTextContent('Tenant: north');
  expect(screen.getByRole('button', { name: 'north Current' })).toHaveAttribute('aria-current', 'true');
  expect(screen.getByRole('button', { name: 'south' })).not.toHaveAttribute('aria-current');
  tree.rerender(<TenantChooser {...props} tenantIds={['south']} currentTenant="north" />);
  expect(document.querySelector('.tenant-chooser-current')).toHaveTextContent('Tenant: north');
  expect(screen.queryByRole('button', { name: /north/ })).toBeNull();
});

test('App name, error and Unicode/markup tenant IDs stay literal text and IDs round-trip exactly', async () => {
  const tenant = '<img src=x onerror=alert(1)> / 北 & north ',
    onSelect = vi.fn(),
    user = userEvent.setup();
  const tree = render(
    <TenantChooser {...props} appName="<b>App</b>" tenantIds={[tenant]} error="<script>error</script>" onSelect={onSelect} />,
  );
  expect(screen.getByText('<b>App</b>')).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('<script>error</script>');
  expect(tree.container.querySelector('img, script')).toBeNull();
  await user.click(screen.getByRole('button'));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(tenant);
});

test('chooser does no network/storage work and does not steal focus', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  const read = vi.spyOn(Storage.prototype, 'getItem');
  const user = userEvent.setup(),
    onSelect = vi.fn();
  const tree = render(<button type="button">Existing focus</button>);
  const focus = screen.getByRole('button');
  focus.focus();
  tree.rerender(
    <>
      <button type="button">Existing focus</button>
      <TenantChooser {...props} onSelect={onSelect} />
    </>,
  );
  expect(focus).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'north' }));
  expect(fetcher).not.toHaveBeenCalled();
  expect(storage).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

test('choices and callbacks follow props without retaining removed tenants or mutating the input', async () => {
  const tenants = Object.freeze(['north']),
    first = vi.fn(),
    next = vi.fn(),
    user = userEvent.setup();
  const tree = render(<TenantChooser {...props} tenantIds={tenants} onSelect={first} />);
  tree.rerender(<TenantChooser {...props} tenantIds={['south']} onSelect={next} />);
  expect(screen.queryByRole('button', { name: 'north' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'south' }));
  expect(next).toHaveBeenCalledExactlyOnceWith('south');
  expect(first).not.toHaveBeenCalled();
  expect(tenants).toEqual(['north']);
});

test('compact trigger labels the current tenant and opening is not a selection', async () => {
  const onSelect = vi.fn(),
    user = userEvent.setup();
  render(<TenantControl {...props} currentTenant="north" onSelect={onSelect} />);
  const trigger = screen.getByRole('button', { name: 'Tenant: north' });
  expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await user.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('dialog', { name: 'Choose a tenant' })).toBeVisible();
  expect(onSelect).not.toHaveBeenCalled();
});

test('a requested tenant is explanatory text, not an available membership or a selection', () => {
  const onSelect = vi.fn();
  render(<TenantChooser {...props} requestedTenant="private-other" tenantIds={['north']} onSelect={onSelect} />);
  expect(screen.getByText(/This link belongs to/)).toHaveTextContent('private-other');
  expect(screen.queryByRole('button', { name: 'private-other' })).toBeNull();
  expect(onSelect).not.toHaveBeenCalled();
});

test.each(['{Enter}', ' '])('compact trigger opens by %s and Escape restores focus without selection', async (key) => {
  const onSelect = vi.fn(),
    user = userEvent.setup();
  render(<TenantControl {...props} currentTenant="north" onSelect={onSelect} />);
  const trigger = screen.getByRole('button', { name: 'Tenant: north' });
  trigger.focus();
  await user.keyboard(key);
  await vi.waitFor(() => expect(screen.getByRole('button', { name: 'north Current' })).toHaveFocus());
  await user.keyboard('{Escape}');
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await vi.waitFor(() => expect(trigger).toHaveFocus());
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(onSelect).not.toHaveBeenCalled();
});

test('dialog has an explicit Close and holds keyboard focus in its controls', async () => {
  const user = userEvent.setup();
  render(
    <>
      <TenantControl {...props} currentTenant="north" />
      <button type="button">Outside</button>
    </>,
  );
  const trigger = screen.getByRole('button', { name: 'Tenant: north' });
  await user.click(trigger);
  const close = within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' });
  close.focus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'north Current' })).toHaveFocus();
  await user.click(close);
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await vi.waitFor(() => expect(trigger).toHaveFocus());
});

test('compact switch does not optimistically change identity or close before acknowledgement', async () => {
  const onSelect = vi.fn(),
    user = userEvent.setup();
  const tree = render(<TenantControl {...props} currentTenant="north" onSelect={onSelect} />);
  const trigger = screen.getByRole('button', { name: 'Tenant: north' });
  await user.click(trigger);
  await user.click(screen.getByRole('button', { name: 'south' }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('south');
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(trigger).toHaveAccessibleName('Tenant: north');
  tree.rerender(<TenantControl {...props} currentTenant="north" busy onSelect={onSelect} />);
  for (const button of within(screen.getByRole('dialog')).getAllByRole('button')) expect(button).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('dialog')).toBeVisible();
  tree.rerender(<TenantControl {...props} currentTenant="north" error="The switch could not be confirmed." onSelect={onSelect} />);
  expect(screen.getByRole('alert')).toHaveTextContent('The switch could not be confirmed.');
  expect(trigger).toHaveAccessibleName('Tenant: north');
  await user.keyboard('{Escape}');
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('busy compact trigger cannot open and a missing current tenant is not guessed', async () => {
  const user = userEvent.setup();
  const tree = render(<TenantControl {...props} busy />);
  const trigger = screen.getByRole('button', { name: 'Choose a tenant' });
  expect(trigger).toBeDisabled();
  await user.click(trigger);
  expect(screen.queryByRole('dialog')).toBeNull();
  tree.rerender(<TenantControl {...props} />);
  await user.click(trigger);
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(screen.queryByText(/Tenant:/)).toBeNull();
});

test('confirmed current tenant comes only from updated props', async () => {
  const onSelect = vi.fn(),
    user = userEvent.setup();
  const tree = render(<TenantControl {...props} currentTenant="north" onSelect={onSelect} />);
  const trigger = screen.getByRole('button', { name: 'Tenant: north' });
  await user.click(trigger);
  tree.rerender(<TenantControl {...props} currentTenant="south" onSelect={onSelect} />);
  expect(trigger).toHaveAccessibleName('Tenant: south');
  expect(screen.getByRole('button', { name: 'south Current' })).toHaveAttribute('aria-current', 'true');
  expect(screen.getByRole('button', { name: 'north' })).not.toHaveAttribute('aria-current');
  expect(onSelect).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Close' }));
  await vi.waitFor(() => expect(trigger).toHaveFocus());
});

test("what the bar offers beside the control is the dialog's too, and closes it before it runs", async () => {
  const onEnter = vi.fn();
  render(<TenantControl {...props} currentTenant="north" actions={[{ label: 'Enter tenant', onClick: onEnter }]} />);
  await userEvent.click(screen.getByRole('button', { name: /north/ }));
  // The stylesheet shows it on a phone only; happy-dom draws it without the media rule.
  await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Enter tenant' }));
  expect(onEnter).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a tenant is said by its name where the server gave one, and chosen by its id', async () => {
  const onSelect = vi.fn(),
    user = userEvent.setup();
  const named = { ...props, names: { north: 'North Motors' }, onSelect };
  render(<TenantChooser {...named} currentTenant="north" requestedTenant="north" />);
  expect(screen.getAllByRole('button').map((button) => button.firstChild?.textContent)).toEqual(['North Motors', 'south']);
  expect(document.querySelector('.tenant-chooser-current')?.textContent).toBe('Tenant: North Motors');
  expect(document.querySelector('.tenant-chooser-note')?.textContent).toContain('North Motors');
  await user.click(screen.getByRole('button', { name: /North Motors/ }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('north');
  cleanup();
  render(<TenantControl {...named} currentTenant="north" />);
  expect(screen.getByRole('button', { name: /North Motors/ })).toBeVisible();
  expect(document.body.textContent).not.toContain('north');
});

/* An App that names its tenants (`auth.tenancy.label: 'Dealer'`) is spoken
   to in its own word, never "tenant" (KS-OBSERVE L6). */
test("the chooser and the bar say the App's own word for a tenant", async () => {
  render(
    <TenantChooser
      appName="Keystone Desk"
      tenantIds={['north', 'south']}
      names={{ north: 'North Motors', south: 'South Autos' }}
      tenantLabel="Dealer"
      requestedTenant="north"
      onSelect={() => {}}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Choose a dealer' })).toBeInTheDocument();
  expect(screen.getByRole('list', { name: 'Available dealers' })).toBeInTheDocument();
  expect(screen.getByText(/Choose that dealer to open it, or choose another dealer/)).toBeInTheDocument();
  cleanup();
  render(
    <TenantControl
      appName="Keystone Desk"
      tenantIds={['north']}
      names={{ north: 'North Motors' }}
      tenantLabel="Agency"
      currentTenant="north"
      onSelect={() => {}}
    />,
  );
  expect(screen.getByRole('button', { name: /^Agency: North Motors/ })).toBeInTheDocument();
});

test('a sandbox is marked as one wherever it is named: in the list, and in the bar while it is open', () => {
  const sandboxes = new Set(['north-sandbox']);
  const choices = { ...props, tenantIds: ['north', 'north-sandbox'], sandboxes };
  render(<TenantChooser {...choices} />);
  expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['north', 'north-sandboxSandbox']);
  cleanup();
  render(<TenantControl {...choices} currentTenant="north-sandbox" />);
  expect(screen.getByText('Sandbox', { selector: '.tenant-sandbox-mark' })).toBeVisible();
  cleanup();
  render(<TenantControl {...choices} currentTenant="north" />);
  expect(screen.queryByText('Sandbox')).toBeNull();
});
