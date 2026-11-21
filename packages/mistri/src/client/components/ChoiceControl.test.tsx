import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const sites = [
  { id: 1, name: 'Northside' },
  { id: 2, name: 'Southside' },
];
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  sites: { id: 'sites', name: 'sites', columns: [{ name: 'id', primaryKey: true }, { name: 'name' }] },
  owner: {
    mode: 'authenticated',
    epoch: 1,
    accountId: 'acct-1',
    appId: 'clinic',
  } as import('@mistriwork/kit/client/sessionIdentity.js').SessionIdentitySnapshot,
}));
vi.mock('../../../../kit/src/client/core.js', () => ({
  api: mocks.api,
  findTable: (id: string) => (id === 'sites' ? mocks.sites : undefined),
  labelPath: () => 'name',
  quote: (value: string) => JSON.stringify(value),
  state: { activeConnection: 'clinic' },
  viewportBox: (element: Element) => element.getBoundingClientRect(),
}));
vi.mock('../../../../kit/src/client/requestIdentity.js', () => ({ ownedBy: () => ({}) }));
vi.mock('../../../../kit/src/client/sessionIdentity.js', () => ({
  sessionIdentity: () => mocks.owner,
  subscribeSessionIdentity: () => () => {},
}));

/* Under happy-dom import.meta.url is not a file address: the stylesheets are read from the repository root, where Vitest runs. */
const here = 'packages/mistri/src/client/components';

const choices = await import('../appChoices.js');
const { ChoiceControl } = await import('./ChoiceControl.js');

/* The server's answer to the chooser's two questions: the picked row's label, and the rows matching what is typed. */
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  mocks.api.mockImplementation(async (_path: string, body: { q: string }) => {
    const one = /id = "(\d+)"/.exec(body.q);
    return { rows: one ? sites.filter((site) => String(site.id) === one[1]) : sites };
  });
});
afterEach(() => {
  cleanup();
  mocks.api.mockReset();
  choices.writeChoice(mocks.owner, 'site', null);
});

const draw = (required?: true) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ChoiceControl app="clinic" name="site" choice={{ table: 'sites', ...(required ? { required } : {}) }} />
    </QueryClientProvider>,
  );

test("the trigger says the picked row's label, read again under the reader", async () => {
  choices.writeChoice(mocks.owner, 'site', '2');
  draw();
  expect(await screen.findByText('Southside')).toBeTruthy();
  expect(screen.getByRole('button', { name: /Site:\s*Southside/ })).toBeTruthy();
});

test('a pick the reader can no longer read is forgotten, and the trigger asks again', async () => {
  choices.writeChoice(mocks.owner, 'site', '99');
  draw();
  await waitFor(() => expect(choices.heldChoice(mocks.owner, 'site')).toBeNull());
  expect(screen.getByRole('button', { name: 'Choose site' })).toBeTruthy();
});

test('a required choice asks before anything else, with no way to close the question', async () => {
  draw(true);
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toMatch(/Choose site/);
  expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
});

test('picking a row keeps it, closes the dialog and says it on the trigger', async () => {
  draw();
  await userEvent.click(screen.getByRole('button', { name: 'Choose site' }));
  await userEvent.click(await screen.findByRole('option', { name: /Northside/ }));
  expect(choices.heldChoice(mocks.owner, 'site')).toBe('1');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(await screen.findByRole('button', { name: /Site:\s*Northside/ })).toBeTruthy();
});

test("on a phone the account menu's item is the chooser's door: it opens the same dialog", async () => {
  choices.writeChoice(mocks.owner, 'site', '1');
  draw();
  await waitFor(() => expect(choices.choiceEntries().at(-1)?.name).toBe('Northside'));
  const entry = choices.choiceEntries().at(-1)!;
  expect(entry.word).toBe('Site:');
  act(() => entry.open());
  expect(await screen.findByRole('dialog')).toBeTruthy();
  cleanup();
  expect(choices.choiceEntries()).toEqual([]);
});

test('a desk shows the chooser in the bar; below 1280 the bar gives it up to the account menu', () => {
  const css = readFileSync(`${here}/ChoiceControl.css`, 'utf8');
  expect(css).toMatch(/@media \(max-width: 1279px\) \{\s*\.topbar \.choice-host \{ display: none; \}/);
  const menu = readFileSync(`${here}/AccountMenu.css`, 'utf8');
  expect(menu).toMatch(/\.account-menu-choice[^{]*\{[^}]*display: none/);
  expect(menu).toMatch(/@media \(max-width: 1279px\)[\s\S]*\.account-menu-choice/);
});

test('nothing is drawn for a signed-out visitor, whose pick there is nowhere to keep', () => {
  const was = mocks.owner;
  mocks.owner = { ...was, mode: 'anonymous', accountId: null };
  try {
    const { container } = draw();
    expect(container.innerHTML).toBe('');
  } finally {
    mocks.owner = was;
  }
});
