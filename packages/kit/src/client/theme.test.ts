import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { effectiveTheme, initTheme, setTheme, setThemeScheme, themeChoice, toggleTheme } from './theme.js';

let systemDark = false;
beforeEach(() => {
  localStorage.clear();
  systemDark = false;
  vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: systemDark }) as MediaQueryList);
  initTheme();
});
afterEach(() => {
  setThemeScheme(undefined);
  vi.restoreAllMocks();
  localStorage.clear();
  initTheme();
});

test.each([false, true])('each quick toggle changes the visible mode when the system starts dark=%s', (dark) => {
  systemDark = dark;
  const first = dark ? 'light' : 'dark';
  expect(themeChoice()).toBe('system');
  expect(toggleTheme()).toBe(first);
  expect(effectiveTheme()).toBe(first);
  expect(document.documentElement).toHaveAttribute('data-theme', first);
  expect(toggleTheme()).toBe(dark ? 'dark' : 'light');
  expect(effectiveTheme()).toBe(dark ? 'dark' : 'light');
});

test('explicit light/dark choices persist and do not follow later system changes', () => {
  setTheme('dark');
  expect(localStorage.getItem('mistri.theme')).toBe('dark');
  expect(document.documentElement.style.colorScheme).toBe('dark');
  systemDark = false;
  initTheme();
  expect(effectiveTheme()).toBe('dark');
  setTheme('light');
  systemDark = true;
  expect(effectiveTheme()).toBe('light');
});

test('System clears the explicit palette and tracks the effective operating-system mode', () => {
  setTheme('dark');
  setTheme('system');
  expect(document.documentElement).not.toHaveAttribute('data-theme');
  expect(document.documentElement.style.colorScheme).toBe('');
  expect(effectiveTheme()).toBe('light');
  systemDark = true;
  expect(effectiveTheme()).toBe('dark');
});

test('unknown preferences fall back to System and a blocked store still permits toggling', () => {
  localStorage.setItem('mistri.theme', 'unknown');
  initTheme();
  expect(themeChoice()).toBe('system');
  expect(setTheme('unknown')).toBe('system');
  const write = vi.fn(() => {
    throw new Error('blocked');
  });
  vi.spyOn(window, 'localStorage', 'get').mockReturnValue({ setItem: write } as unknown as Storage);
  expect(toggleTheme()).toBe('dark');
  expect(toggleTheme()).toBe('light');
  expect(write).toHaveBeenCalledTimes(2);
});

test('color mode changes do not rewrite the selected visual theme or other preferences', () => {
  localStorage.setItem('mistri.visual-theme', 'sage');
  localStorage.setItem('mistri.typography', 'mono');
  localStorage.setItem('mistri.density', 'compact');
  setTheme('dark');
  toggleTheme();
  expect(localStorage.getItem('mistri.visual-theme')).toBe('sage');
  expect(localStorage.getItem('mistri.typography')).toBe('mono');
  expect(localStorage.getItem('mistri.density')).toBe('compact');
});

test('a dark theme is worn dark until the reader picks a mode, then the reader wins, "match the system" included', () => {
  systemDark = false;
  setThemeScheme('dark');
  expect(effectiveTheme()).toBe('dark');
  expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  expect(document.documentElement.style.colorScheme).toBe('dark');
  expect(themeChoice()).toBe('system');
  setTheme('light');
  expect(effectiveTheme()).toBe('light');
  setTheme('system');
  expect(document.documentElement).not.toHaveAttribute('data-theme');
  expect(effectiveTheme()).toBe('light');
  setThemeScheme(undefined);
  localStorage.clear();
  initTheme();
  expect(effectiveTheme()).toBe('light');
});

test('a dark-only theme is dark whatever the reader picked or the system says', () => {
  setTheme('light');
  setThemeScheme('dark-only');
  expect(effectiveTheme()).toBe('dark');
  expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  expect(themeChoice()).toBe('light');
  setThemeScheme(undefined);
  expect(document.documentElement).toHaveAttribute('data-theme', 'light');
});
