/** Preferences: each control writes only to the store that owns it. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import {
  configureVisualThemes,
  initVisualTheme,
  registerHostLooks,
  setVisualTheme,
  visualPaletteChoice,
  visualThemeOptions,
  VISUAL_PALETTE_KEY,
  VISUAL_THEME_KEY,
  WORKBENCH_VISUAL_THEME_KEY,
} from '../visualTheme.js';
import { relatedRows, setRelatedRows } from '../relatedRows.js';
import { compileAppTheme } from '../../../../mistri/src/shared/themeSpec.js';

const set = { density: vi.fn(), typography: vi.fn(), colorMode: vi.fn(), pageSize: vi.fn(), render: vi.fn() };
let colorMode = 'system';
vi.mock('../core.js', () => ({
  loadJson: (_key: string, fallback: unknown) => fallback,
  saveJson: vi.fn(),
  PAGE_SIZES: [20, 50, 100],
  pageSize: () => 20,
  setPageSize: (n: number) => set.pageSize(n),
  render: () => set.render(),
  trapFocus: () => () => {},
  viewportBox: (n: Element) => n.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
vi.mock('../density.js', () => ({ densityChoice: () => 'comfortable', setDensity: (v: string) => set.density(v) }));
vi.mock('../typography.js', () => ({ typographyPreference: () => 'default', setTypography: (v: string) => set.typography(v) }));
vi.mock('../theme.js', () => ({
  themeChoice: () => colorMode,
  setTheme: (v: string) => {
    colorMode = v;
    set.colorMode(v);
  },
}));
const { PrefsDialog } = await import('./Prefs.js');

afterEach(() => {
  cleanup();
  setRelatedRows(10);
  Object.values(set).forEach((f) => f.mockClear());
  colorMode = 'system';
  localStorage.removeItem(VISUAL_THEME_KEY);
  localStorage.removeItem(WORKBENCH_VISUAL_THEME_KEY);
  localStorage.removeItem(VISUAL_PALETTE_KEY);
  registerHostLooks([]);
  configureVisualThemes();
  initVisualTheme();
});
/** Inside an App, where the looks are offered. */
const inApp = () => configureVisualThemes([], undefined, true);

test('Workbench offers its native default and explicit built-ins without changing other preferences', async () => {
  const user = userEvent.setup();
  render(<PrefsDialog onClose={() => {}} />);
  const control = screen.getByRole('button', { name: /^Visual theme\b/ });
  expect(control).toHaveTextContent('Workbench default');
  expect(screen.getByRole('button', { name: /^Color mode\b/ })).toBeTruthy();
  await user.click(control);
  await user.click(screen.getByRole('option', { name: 'Sage' }));
  expect(control).toHaveTextContent('Sage');
  expect(document.documentElement).toHaveAttribute('data-visual-theme', 'sage');
  expect(localStorage.getItem(WORKBENCH_VISUAL_THEME_KEY)).toBe('sage');
  expect(localStorage.getItem(VISUAL_THEME_KEY)).toBeNull();
  await user.click(control);
  await user.click(screen.getByRole('option', { name: 'Workbench default' }));
  expect(localStorage.getItem(WORKBENCH_VISUAL_THEME_KEY)).toBeNull();
  expect(document.documentElement).not.toHaveAttribute('data-visual-theme');
  expect(set.colorMode).not.toHaveBeenCalled();
  expect(set.density).not.toHaveBeenCalled();
  expect(set.typography).not.toHaveBeenCalled();
  expect(set.pageSize).not.toHaveBeenCalled();
});

test("a host's own looks are offered beside the native default, worn by one attribute, and kept like any pick", async () => {
  const loaded = vi.fn(() => Promise.resolve());
  registerHostLooks([
    { id: 'blueprint', label: 'Blueprint', sheet: loaded, swatches: ['#dde8f5', '#123f94'] },
    { id: 'console', label: 'Console', sheet: () => Promise.resolve() },
  ]);
  const user = userEvent.setup();
  const view = render(<PrefsDialog onClose={() => {}} />);
  const control = screen.getByRole('button', { name: /^Visual theme\b/ });
  await user.click(control);
  const names = screen.getAllByRole('option').map((option) => option.textContent?.replace('✓', ''));
  expect(names.slice(0, 3)).toEqual(['Workbench default', 'Blueprint', 'Console']);
  await user.click(screen.getByRole('option', { name: 'Blueprint' }));
  expect(control).toHaveTextContent('Blueprint');
  expect(document.documentElement).toHaveAttribute('data-host-look', 'blueprint');
  // Worn over the native tokens: no kit look's attributes, and the sheet fetched once.
  expect(document.documentElement).not.toHaveAttribute('data-visual-theme');
  expect(document.documentElement).not.toHaveAttribute('data-custom-theme');
  expect(loaded).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(WORKBENCH_VISUAL_THEME_KEY)).toBe('blueprint');
  expect(localStorage.getItem(VISUAL_THEME_KEY)).toBeNull();
  // The next page: the look is worn before the host's main declares it, and again once it has.
  view.unmount();
  registerHostLooks([]);
  initVisualTheme();
  expect(document.documentElement).not.toHaveAttribute('data-host-look');
  registerHostLooks([{ id: 'blueprint', label: 'Blueprint', sheet: loaded }]);
  expect(document.documentElement).toHaveAttribute('data-host-look', 'blueprint');
  render(<PrefsDialog onClose={() => {}} />);
  const again = screen.getByRole('button', { name: /^Visual theme\b/ });
  expect(again).toHaveTextContent('Blueprint');
  // A built-in look takes its place, and the native default takes every look away.
  await user.click(again);
  await user.click(screen.getByRole('option', { name: 'Sage' }));
  expect(document.documentElement).not.toHaveAttribute('data-host-look');
  expect(document.documentElement).toHaveAttribute('data-visual-theme', 'sage');
  await user.click(again);
  await user.click(screen.getByRole('option', { name: 'Workbench default' }));
  expect(document.documentElement).not.toHaveAttribute('data-host-look');
  expect(localStorage.getItem(WORKBENCH_VISUAL_THEME_KEY)).toBeNull();
  // An App's screen is dressed by its own theme: it never offers or wears one.
  setVisualTheme('blueprint');
  inApp();
  expect(document.documentElement).not.toHaveAttribute('data-host-look');
  expect(visualThemeOptions().some((theme) => theme.value === 'blueprint')).toBe(false);
  expect(set.typography).not.toHaveBeenCalled();
});

test('color mode applies each explicit choice once without changing other preferences', async () => {
  inApp();
  const user = userEvent.setup();
  render(<PrefsDialog onClose={() => {}} />);
  const control = screen.getByRole('button', { name: /^Color mode\b/ });
  expect(control).toHaveTextContent('System');
  for (const label of ['Dark', 'Light', 'System']) {
    await user.click(control);
    await user.click(screen.getByRole('option', { name: label }));
    expect(control).toHaveTextContent(label);
  }
  expect(set.colorMode.mock.calls).toEqual([['dark'], ['light'], ['system']]);
  expect(screen.getByRole('button', { name: /^Visual theme\b/ })).toHaveTextContent('Workshop');
  expect(localStorage.getItem(VISUAL_THEME_KEY)).toBeNull();
  expect(set.density).not.toHaveBeenCalled();
  expect(set.typography).not.toHaveBeenCalled();
  expect(set.render).not.toHaveBeenCalled();
});

test('visual presets show swatches, persist immediately, and leave the other preferences alone', async () => {
  inApp();
  const user = userEvent.setup();
  render(<PrefsDialog onClose={() => {}} />);
  expect(screen.getByRole('button', { name: /^Visual theme\b/ })).toHaveTextContent('Workshop');
  await user.click(screen.getByRole('button', { name: /^Visual theme\b/ }));
  const option = screen.getByRole('option', { name: 'Mono' });
  expect(option.querySelectorAll('.dd-swatches > span')).toHaveLength(3);
  await user.click(option);
  expect(screen.getByRole('button', { name: /^Visual theme\b/ })).toHaveTextContent('Mono');
  expect(localStorage.getItem(VISUAL_THEME_KEY)).toBe('mono');
  expect(set.density).not.toHaveBeenCalled();
  expect(set.typography).not.toHaveBeenCalled();
  expect(set.colorMode).not.toHaveBeenCalled();
  expect(set.render).not.toHaveBeenCalled();
});

test('the App’s own theme is marked in the picker, and a reader’s pick can be reset to it', async () => {
  configureVisualThemes([], 'sage', true);
  const user = userEvent.setup();
  render(<PrefsDialog onClose={() => {}} />);
  const control = screen.getByRole('button', { name: /^Visual theme\b/ });
  expect(control).toHaveTextContent('Sage');
  expect(screen.queryByRole('button', { name: 'Reset to the App’s theme' })).toBeNull();
  await user.click(control);
  expect(screen.getByRole('option', { name: /Sage/ })).toHaveTextContent('This App’s theme');
  expect(screen.getByRole('option', { name: /Mono/ })).not.toHaveTextContent('This App’s theme');
  await user.click(screen.getByRole('option', { name: /Mono/ }));
  expect(control).toHaveTextContent('Mono');
  expect(localStorage.getItem(VISUAL_THEME_KEY)).toBe('mono');
  await user.click(screen.getByRole('button', { name: 'Reset to the App’s theme' }));
  expect(control).toHaveTextContent('Sage');
  expect(localStorage.getItem(VISUAL_THEME_KEY)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reset to the App’s theme' })).toBeNull();
});

test('under a dark-only theme the color mode is shown as dark and cannot be changed, and says why', async () => {
  const night = compileAppTheme(
    {
      id: 'night',
      label: 'Night',
      scheme: 'dark-only',
      colors: { dark: { ground: '#101114', surface: '#17181c', ink: '#f2f2f2', accent: '#8fb4ff' } },
    },
    'ui.customThemes[0]',
    new Set(),
    { faces: false },
  );
  colorMode = 'light';
  configureVisualThemes([night], 'night', true);
  render(<PrefsDialog onClose={() => {}} />);
  const control = screen.getByRole('button', { name: /^Color mode\b/ });
  expect(control).toHaveTextContent('Dark');
  expect(control).toBeDisabled();
  expect(screen.getByText('This theme is dark only.')).toBeTruthy();
});

test('typography exposes an explicit route back to the app default', async () => {
  const user = userEvent.setup();
  render(<PrefsDialog onClose={() => {}} />);
  expect(screen.getByRole('button', { name: /^Typography\b/ })).toHaveTextContent('App default');
  await user.click(screen.getByRole('button', { name: /^Typography\b/ }));
  await user.click(screen.getByRole('option', { name: /^Mono/ }));
  expect(set.typography).toHaveBeenCalledWith('mono');
});

test('shows each setting as it is and writes a change to its own store', async () => {
  const user = userEvent.setup();
  render(<PrefsDialog onClose={() => {}} />);
  expect(screen.getByRole('button', { name: /^Density\b/ })).toHaveTextContent('Comfortable');
  expect(screen.getByRole('button', { name: /^Rows per related list\b/ })).toHaveTextContent('10');
  await user.click(screen.getByRole('button', { name: /^Density\b/ }));
  await user.click(screen.getByRole('option', { name: /Compact/ }));
  expect(set.density).toHaveBeenCalledWith('compact');
  await user.click(screen.getByRole('button', { name: /^Rows per list\b/ }));
  await user.click(screen.getByRole('option', { name: '50' }));
  expect(set.pageSize).toHaveBeenCalledWith(50);
  await user.click(screen.getByRole('button', { name: /^Rows per related list\b/ }));
  await user.click(screen.getByRole('option', { name: '20' }));
  expect(relatedRows()).toBe(20);
  expect(screen.getByRole('button', { name: /^Rows per related list\b/ })).toHaveTextContent('20');
  await user.click(screen.getByRole('button', { name: /^Rows per related list\b/ }));
  expect(screen.getByRole('option', { name: '20' })).toHaveAttribute('aria-selected', 'true');
  expect(set.render).toHaveBeenCalledTimes(2);
});

test('Close closes, and closing is reported once', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<PrefsDialog onClose={onClose} />);
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Palette appears only for themes with variants and does not change color mode', async () => {
  configureVisualThemes(
    [
      {
        id: 'example',
        label: 'Example',
        light: { surface: '#ffffff', ink: '#111111', accent: '#225577' },
        dark: { surface: '#111111', ink: '#ffffff', accent: '#aaddff' },
        palettes: [{ id: 'mint', label: 'Mint', light: { accent: '#21644e' }, dark: { accent: '#85e0b5' } }],
      },
    ],
    'example',
    true,
  );
  const user = userEvent.setup();
  render(<PrefsDialog onClose={() => {}} />);
  await user.click(screen.getByRole('button', { name: /^Palette\b/ }));
  await user.click(screen.getByRole('option', { name: 'Mint' }));
  expect(visualPaletteChoice()).toBe('mint');
  expect(screen.getByRole('button', { name: /^Color mode\b/ })).toHaveTextContent('System');
  await user.click(screen.getByRole('button', { name: /^Visual theme\b/ }));
  await user.click(screen.getByRole('option', { name: 'Mono' }));
  // Every built-in look offers the twelve palettes, its own colors under the one it names.
  expect(screen.getByRole('button', { name: /^Palette\b/ })).toHaveTextContent('Ink');
  expect(set.colorMode).not.toHaveBeenCalled();
});

test('language changes update the open preferences without changing presentation settings', async () => {
  const { setMessageScope, setMessageLanguage } = await import('../messages.js');
  setMessageScope('prefs-language-test');
  setMessageLanguage('en');
  const user = userEvent.setup();
  render(<PrefsDialog onClose={() => {}} />);
  try {
    await user.click(screen.getByRole('button', { name: /^Language\b/ }));
    await user.click(screen.getByRole('option', { name: 'Español' }));
    /* The Spanish words are fetched on demand (messages.ts fetchWords); the switch lands when they arrive. */
    expect(await screen.findByRole('dialog', { name: 'Preferencias' })).toBeVisible();
    expect(document.documentElement.lang).toBe('es');
    expect(screen.getByRole('button', { name: /^Idioma\b/ })).toHaveTextContent('Español');
    expect(set.density).not.toHaveBeenCalled();
    expect(set.typography).not.toHaveBeenCalled();
    expect(set.render).not.toHaveBeenCalled();
  } finally {
    cleanup();
    setMessageLanguage('en');
    setMessageScope();
  }
});
