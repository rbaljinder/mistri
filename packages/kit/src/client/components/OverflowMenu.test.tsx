import { afterEach, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OverflowMenu } from './OverflowMenu.js';
import { addMenuItem, setAccountMenu, setMenuMode } from '../menu.js';

addMenuItem({ label: 'Preferences…', category: 'Preferences', onSelect: () => {} });

afterEach(() => {
  cleanup();
  act(() => setMenuMode('workbench'));
});

test('the Workbench\'s menu is its tools, "More"; an App\'s is its reader\'s settings, "Settings"', () => {
  render(<OverflowMenu />);
  expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
  act(() => setMenuMode('app'));
  const gear = screen.getByRole('button', { name: 'Settings' });
  fireEvent.click(gear);
  expect(screen.getByRole('menuitem', { name: /^Preferences/ })).toBeInTheDocument();
});

test("signed in to an App the settings are the account menu's, and the gear stands down", () => {
  act(() => setMenuMode('app'));
  render(<OverflowMenu />);
  expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
  act(() => setAccountMenu(true));
  expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  // The Workbench keeps its own menu whoever is signed in.
  act(() => setMenuMode('workbench'));
  expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
  act(() => setAccountMenu(false));
});

test('an App\'s mode set while the menu mounts, before it subscribes, still turns "More" into "Settings"', () => {
  /* The shell sets the mode as it mounts. Rendered after the menu, this lands
     between the menu's render and its subscribing, as it did on a slow CI runner. */
  let set = false;
  function Shell() {
    if (!set) {
      set = true;
      setMenuMode('app');
    }
    return null;
  }
  render(
    <>
      <OverflowMenu />
      <Shell />
    </>,
  );
  expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
});

test('a visitor whose language arrives after the shell registered its items reads the gear and its items in that language', async () => {
  const { say } = await import('../copy/shell/app.js');
  const { setMessageScope } = await import('../messages.js');
  /* Registered as the shell does at boot, in English, before the App's payload names the reader's language. */
  addMenuItem({ label: () => say('darkMode'), category: () => say('preferences.title'), onSelect: () => {} });
  act(() => setMenuMode('app'));
  render(<OverflowMenu />);
  expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
  try {
    await act(() => setMessageScope('visitor-language-test', { locale: 'es-ES', offered: ['en', 'es'] }));
    const gear = screen.getByRole('button', { name: 'Ajustes' });
    fireEvent.click(gear);
    expect(screen.getByRole('menuitem', { name: /^Modo oscuro/ }).closest('[role="group"]')).toHaveTextContent('Preferencias');
  } finally {
    await act(() => setMessageScope());
  }
});
