/** The connection form: a pasted URL fills the parts, the parts rebuild the URL, a typed password never echoes, Test answers in place. */
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

const calls: Array<[string, Record<string, unknown>]> = [];
let answer: Record<string, unknown> | Promise<Record<string, unknown>> = { ok: true, dialect: 'postgres', tables: 12, secret: 'keychain' };
vi.mock('../../../../kit/src/client/core.js', () => ({
  api: async (path: string, body: Record<string, unknown>) => {
    calls.push([path, body]);
    return answer;
  },
  viewportBox: (n: Element) => n.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
const { ConnectionDialog } = await import('./ConnectionDialog.js');

afterEach(() => {
  cleanup();
  calls.length = 0;
  answer = { ok: true, dialect: 'postgres', tables: 12, secret: 'keychain' };
});

test('a pasted URL fills the parts; a typed password is kept out of the box and shown redacted', async () => {
  const user = userEvent.setup();
  const run = vi.fn(async () => null);
  render(<ConnectionDialog title="Add a connection" verb="Add and open" run={run} onClose={() => {}} />);
  const url = screen.getByLabelText('Connection URL or file path');
  await waitFor(() => expect(url).toHaveFocus());
  await user.type(url, 'postgres://app@db.example.org:5433/shop');
  expect(screen.getByLabelText('Host')).toHaveValue('db.example.org');
  expect(screen.getByLabelText('Port')).toHaveValue('5433');
  expect(screen.getByLabelText('Database')).toHaveValue('shop');
  expect(screen.getByLabelText('Connection name')).toHaveAttribute('placeholder', 'shop');
  await user.type(screen.getByLabelText('Password'), 'hunter2');
  expect(url).toHaveValue('postgres://app@db.example.org:5433/shop');
  expect(document.querySelector('.conn-preview')).toHaveTextContent('postgres://app:••••••@db.example.org:5433/shop');
  await user.click(screen.getByRole('button', { name: 'Add and open' }));
  expect(run).toHaveBeenCalledWith({ url: 'postgres://app:hunter2@db.example.org:5433/shop', name: 'shop', schemas: [] });
});

test('a schemeless paste is offered its scheme; Test reports in place; an error from run keeps the dialog', async () => {
  const user = userEvent.setup();
  const run = vi.fn(async () => ({ error: 'No such database.' }));
  const onClose = vi.fn();
  render(<ConnectionDialog title="Add a connection" verb="Add and open" run={run} onClose={onClose} />);
  await user.type(screen.getByLabelText('Connection URL or file path'), 'app@host/db');
  expect(document.querySelector('.conn-scheme-hint')).toBeVisible();
  await user.click(screen.getByText('postgres://'));
  expect(screen.getByLabelText('Connection URL or file path')).toHaveValue('postgres://app@host/db');
  expect(document.querySelector('.conn-scheme-hint')).not.toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Test' }));
  await screen.findByText('Connected. postgres, 12 tables. Password from keychain.');
  expect(calls[0]).toEqual(['/api/connections/test', { url: 'postgres://app@host/db', name: 'db', schemas: [] }]);
  expect(document.querySelector('.conn-result')).toHaveClass('ok');
  await user.click(screen.getByRole('button', { name: 'Add and open' }));
  await screen.findByText('No such database.');
  expect(document.querySelector('.conn-result')).toHaveClass('bad');
  expect(onClose).not.toHaveBeenCalled();
});

test('editing starts blank on purpose, and Test says so rather than doing nothing', async () => {
  const user = userEvent.setup();
  render(
    <ConnectionDialog
      title='Edit "prod"'
      name="prod"
      url=""
      schemas={['public', 'sales']}
      verb="Save changes"
      run={async () => null}
      onClose={() => {}}
    />,
  );
  expect(screen.getByLabelText('Postgres schemas to browse')).toHaveValue('public, sales');
  await user.click(screen.getByRole('button', { name: 'Test' }));
  expect(document.querySelector('.conn-result.bad')).toHaveTextContent('Nothing to test yet.');
  expect(calls).toEqual([]);
});

test('pending submission is single-flight, cannot be dismissed, and a rejection retains entries', async () => {
  const user = userEvent.setup();
  let finish!: (result: { error: string } | null) => void;
  const run = vi.fn(
    () =>
      new Promise<{ error: string } | null>((resolve) => {
        finish = resolve;
      }),
  );
  const onClose = vi.fn();
  render(<ConnectionDialog title="Add a connection" verb="Add and open" run={run} onClose={onClose} />);
  await user.type(screen.getByLabelText('Connection URL or file path'), '/tmp/new.db');
  const submit = screen.getByRole('button', { name: 'Add and open' });
  fireEvent.click(submit);
  fireEvent.click(submit);
  expect(run).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Connection URL or file path')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => finish({ error: 'Unavailable' }));
  expect(screen.getByText('Unavailable')).toBeVisible();
  expect(screen.getByLabelText('Connection URL or file path')).toHaveValue('/tmp/new.db');
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  await act(async () => finish(null));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('an older connection test cannot describe a newly edited target', async () => {
  const user = userEvent.setup();
  let finish!: (result: Record<string, unknown>) => void;
  answer = new Promise((resolve) => {
    finish = resolve;
  });
  render(<ConnectionDialog title="Add a connection" verb="Add and open" run={async () => null} onClose={() => {}} />);
  const url = screen.getByLabelText('Connection URL or file path');
  await user.type(url, '/tmp/old.db');
  await user.click(screen.getByRole('button', { name: 'Test' }));
  await user.clear(url);
  await user.type(url, '/tmp/new.db');
  answer = { ok: false, error: 'New target unavailable' };
  await user.click(screen.getByRole('button', { name: 'Test' }));
  await screen.findByText('New target unavailable');
  await act(async () => finish({ ok: true, dialect: 'sqlite', tables: 99 }));
  expect(screen.queryByText(/99 tables/)).not.toBeInTheDocument();
  expect(screen.getByText('New target unavailable')).toBeVisible();
});

test('changed forms require an explicit discard, without persisting credentials', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const stored = localStorage.length;
  render(<ConnectionDialog title="Add a connection" verb="Add and open" run={async () => null} onClose={onClose} />);
  await user.type(screen.getByLabelText('Connection URL or file path'), 'postgres://user:secret@host/db');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Password')).toHaveValue('secret');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(localStorage.length).toBe(stored);
});
