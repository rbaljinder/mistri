/**
 * A strip of tabs whose set changes under the reader (a related list's tab comes and goes with its `when` and its
 * rows): the tab they were on is held by what it is, and one that has left leaves the first tab standing selected,
 * never none and never another list by place (a field report).
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import type { PageEntry } from './pageModel.js';

vi.mock('../../../../mistri/src/client/appState.js', () => ({ activeApp: () => null, inAppMode: () => false }));
const { TabStrip } = await import('./PageSections.js');
bridgeShell();
afterEach(cleanup);

const tab = (name: string) => ({ key: name, token: name.toLowerCase(), label: name });
const strip = (names: string[]) => (
  <TabStrip
    tabs={names.map(tab)}
    name="Related lists"
    entry={{ kind: 'page' } as PageEntry}
    onTab={() => {}}
    scoped={false}
    draw={(i) => <p>{names[i]} panel</p>}
  />
);
const selected = () =>
  screen
    .getAllByRole('tab')
    .filter((t) => t.getAttribute('aria-selected') === 'true')
    .map((t) => t.textContent);

test('a tab that leaves while it is the active one hands over to the first tab standing', async () => {
  const user = userEvent.setup();
  const { rerender } = render(strip(['Notes', 'Quotes', 'Files']));
  await user.click(screen.getByRole('tab', { name: 'Quotes' }));
  expect(selected()).toEqual(['Quotes']);
  rerender(strip(['Notes', 'Files']));
  expect(selected()).toEqual(['Notes']);
  expect(screen.getByText('Notes panel')).toBeVisible();
});

test('the active tab stays active when one before it arrives or leaves', async () => {
  const user = userEvent.setup();
  const { rerender } = render(strip(['Notes', 'Quotes', 'Files']));
  await user.click(screen.getByRole('tab', { name: 'Files' }));
  rerender(strip(['Quotes', 'Files']));
  expect(selected()).toEqual(['Files']);
  rerender(strip(['Late', 'Quotes', 'Files']));
  expect(selected()).toEqual(['Files']);
});
