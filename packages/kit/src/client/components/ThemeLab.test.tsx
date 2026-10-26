/** Translated labels must still reach the real color-mode store as canonical values. */
import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ThemeLab } from './ThemeLab.js';
import { initTheme, themeChoice } from '../theme.js';
import { setMessageLanguage, setMessageScope } from '../messages.js';

beforeEach(async () => {
  localStorage.removeItem('mistri.theme');
  initTheme();
  await setMessageScope('theme-lab-language-test');
  await setMessageLanguage('es');
});

afterEach(async () => {
  cleanup();
  await setMessageLanguage('en');
  await setMessageScope();
  localStorage.removeItem('mistri.theme');
  initTheme();
});

test('Spanish color-mode choices apply and persist dark, light and system', async () => {
  const user = userEvent.setup();
  render(<ThemeLab onDone={() => {}} />);
  const control = screen.getByRole('button', { name: 'Modo de color' });
  expect(control).toHaveTextContent('Sistema');
  for (const [label, value] of [
    ['Oscuro', 'dark'],
    ['Claro', 'light'],
    ['Sistema', 'system'],
  ]) {
    await user.click(control);
    await user.click(screen.getByRole('option', { name: label }));
    expect(control).toHaveTextContent(label);
    expect(themeChoice()).toBe(value);
    expect(localStorage.getItem('mistri.theme')).toBe(value);
    if (value === 'system') expect(document.documentElement).not.toHaveAttribute('data-theme');
    else expect(document.documentElement).toHaveAttribute('data-theme', value);
    initTheme();
    expect(themeChoice()).toBe(value);
  }
});
