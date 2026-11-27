/** A dashboard's command button: it runs the command with no record and no input, and says an applied run. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

const toast = vi.fn();
const run = vi.fn(async () => ({ status: 'applied' as const, message: undefined }));
vi.mock('@mistriwork/kit/client/core.js', () => ({ toast: (...args: unknown[]) => toast(...args) }));
vi.mock('./sdk/host.js', () => ({}));
vi.mock('./sdk/hooks.js', () => ({ useCommand: () => ({ label: 'Enable texting', granted: true, run }) }));

const { DashboardCommand } = await import('./DashboardCommand.js');

afterEach(() => {
  cleanup();
  toast.mockReset();
  run.mockClear();
});

test('the button sends the command as it is, and says the applied run in its own words', async () => {
  render(
    <DashboardCommand
      section={{ command: 'enableTexting', title: 'Texting', text: 'Send reminders by text.', label: 'Turn on texting' }}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Texting' })).toBeTruthy();
  expect(screen.getByText('Send reminders by text.')).toBeTruthy();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Turn on texting' }));
  expect(run).toHaveBeenCalledWith({}, {}, { label: 'Turn on texting' });
  await waitFor(() => expect(toast).toHaveBeenCalledWith('Turn on texting done.', 'ok'));
});

test("without its own words the button says the command's", () => {
  render(<DashboardCommand section={{ command: 'enableTexting' }} />);
  expect(screen.getByRole('button', { name: 'Enable texting' })).toBeTruthy();
});
