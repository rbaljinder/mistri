/**
 * The theme store: eight built-in looks, then the App's own themes, dress an
 * App — the reader's pick, else the App's preset, else Mono. Workbench starts
 * native and remembers its own explicit built-in choice.
 */
import { afterEach, expect, test, vi } from 'vitest';
import {
  configureVisualThemes,
  customThemeTokens,
  DEFAULT_VISUAL_THEME,
  initVisualTheme,
  setVisualPalette,
  visualPaletteChoice,
  visualPaletteOptions,
  VISUAL_PALETTE_KEY,
  setVisualTheme,
  validVisualTheme,
  visualThemeChoice,
  visualThemeOptions,
  visualThemeOverrides,
  visualThemePalette,
  visualThemesOffered,
  VISUAL_THEME_EVENT,
  VISUAL_THEME_KEY,
  VISUAL_THEME_REGISTRY_EVENT,
  WORKBENCH_VISUAL_THEME_KEY,
} from './visualTheme.js';
import type { ThemeDefinition } from '../../../engine/src/shared/theme.js';
import type { ResolvedBranding } from '../../../mistri/src/shared/branding.js';
import { THEME_PRESETS, themePreset } from '../../../engine/src/shared/themePresets.js';

const CUSTOM: ThemeDefinition = {
  id: 'custom',
  label: 'Custom',
  base: 'lumen',
  light: { surface: '#ffffff', ink: '#222222', accent: '#006b73' },
  dark: { surface: '#111111', ink: '#eeeeee', accent: '#88dddd' },
  fonts: { data: 'Arial, sans-serif', heading: 'Georgia, serif' },
  radius: { field: '3px' },
};
const root = () => document.documentElement;
const VARIANTS: ThemeDefinition = {
  ...CUSTOM,
  defaultPalette: 'teal',
  palettes: [
    { id: 'teal', label: 'Mint', light: { accent: '#21644e' }, dark: { accent: '#85e0b5' } },
    { id: 'violet', label: 'Sky', light: { accent: '#2456a6' }, dark: { accent: '#a8ccff' } },
  ],
};
/** This screen is an App: the looks apply. */
const app = (themes: readonly ThemeDefinition[] = [], preset?: string) => configureVisualThemes(themes, preset, true);

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  configureVisualThemes();
  root().removeAttribute('data-theme');
  document.body.className = '';
  initVisualTheme();
});

test('Workbench starts native, offers built-ins and remembers its own explicit pick independently of Apps', () => {
  window.localStorage.setItem(VISUAL_THEME_KEY, 'mono');
  initVisualTheme();
  expect(visualThemesOffered()).toBe(true);
  expect(visualThemeChoice()).toBe('default');
  expect(validVisualTheme('missing')).toBe('default');
  expect(root()).not.toHaveAttribute('data-visual-theme');
  expect(root()).not.toHaveAttribute('data-theme-style');
  expect(root()).not.toHaveAttribute('data-custom-theme');
  setVisualTheme('sage');
  expect(root()).toHaveAttribute('data-visual-theme', 'sage');
  expect(window.localStorage.getItem(WORKBENCH_VISUAL_THEME_KEY)).toBe('sage');
  expect(window.localStorage.getItem(VISUAL_THEME_KEY)).toBe('mono');
  initVisualTheme();
  expect(root()).toHaveAttribute('data-visual-theme', 'sage');
  // The App's own choice is kept, too.
  app();
  expect(visualThemesOffered()).toBe(true);
  expect(root()).toHaveAttribute('data-visual-theme', 'mono');
  // Returning restores Workbench's look, not the App's choice.
  configureVisualThemes([], undefined, false);
  expect(root()).toHaveAttribute('data-visual-theme', 'sage');
  setVisualTheme('default');
  expect(window.localStorage.getItem(WORKBENCH_VISUAL_THEME_KEY)).toBeNull();
  expect(root()).not.toHaveAttribute('data-visual-theme');
  expect(visualThemeChoice()).toBe('default');
  expect(customThemeTokens(false)).toEqual({});
  expect(visualPaletteOptions()).toEqual([]);
  initVisualTheme();
  expect(root()).not.toHaveAttribute('data-visual-theme');
});

test('flipping between an App and its Workbench tells the picker', () => {
  const listener = vi.fn();
  window.addEventListener(VISUAL_THEME_REGISTRY_EVENT, listener);
  try {
    app();
    configureVisualThemes();
    expect(listener).toHaveBeenCalledTimes(2);
  } finally {
    window.removeEventListener(VISUAL_THEME_REGISTRY_EVENT, listener);
  }
});

test('inside an App, Mono is the look when nobody picks one', () => {
  app();
  expect(DEFAULT_VISUAL_THEME).toBe('lumen');
  expect(visualThemeChoice()).toBe('lumen');
  expect(root()).toHaveAttribute('data-visual-theme', 'lumen');
  expect(root()).toHaveAttribute('data-theme-style', 'lumen');
  expect(visualThemeOverrides().font).toBe(themePreset('lumen')!.fonts!.data);
  expect(validVisualTheme(null)).toBe('lumen');
});

test("the picker offers the built-in looks, then the App's own themes", () => {
  expect(visualThemeOptions().map((theme) => theme.value)).toEqual(['default', 'lumen', 'mono', 'sage']);
  app([CUSTOM]);
  expect(visualThemeOptions().map((theme) => theme.value)).toEqual(['lumen', 'mono', 'sage', 'custom']);
});

test("a retired or unknown stored theme falls back to the App's preset, then Mono", () => {
  window.localStorage.setItem(VISUAL_THEME_KEY, 'dispatch');
  initVisualTheme();
  app();
  expect(visualThemeChoice()).toBe('lumen');
  app([], 'mono');
  expect(visualThemeChoice()).toBe('mono');
});

test("the App's preset is the default, and a reader's pick wins over it", () => {
  app([], 'mono');
  expect(root()).toHaveAttribute('data-theme-style', 'mono');
  setVisualTheme('lumen');
  expect(visualThemeChoice()).toBe('lumen');
  expect(window.localStorage.getItem(VISUAL_THEME_KEY)).toBe('lumen');
  // Picking what the App would give anyway keeps no preference.
  setVisualTheme('mono');
  expect(visualThemeChoice()).toBe('mono');
  expect(window.localStorage.getItem(VISUAL_THEME_KEY)).toBeNull();
});

test('a stored custom preference resolves after the registry loads and survives its temporary removal', () => {
  window.localStorage.setItem(VISUAL_THEME_KEY, 'custom');
  initVisualTheme();
  app();
  expect(visualThemeChoice()).toBe('lumen');
  app([CUSTOM]);
  expect(visualThemeChoice()).toBe('custom');
  expect(root()).toHaveAttribute('data-theme-style', 'lumen');
  app([]);
  expect(visualThemeChoice()).toBe('lumen');
  expect(window.localStorage.getItem(VISUAL_THEME_KEY)).toBe('custom');
  app([CUSTOM]);
  expect(visualThemeChoice()).toBe('custom');
});

test('same-slug custom themes apply only to the App whose reader selected them', () => {
  configureVisualThemes([CUSTOM], 'mono', true, undefined, 'one');
  setVisualTheme('custom');
  expect(root()).toHaveAttribute('data-visual-theme', 'custom');
  configureVisualThemes([{ ...CUSTOM, light: { ...CUSTOM.light, accent: '#660066' } }], 'sage', true, undefined, 'two');
  expect(root()).toHaveAttribute('data-visual-theme', 'sage');
  configureVisualThemes([CUSTOM], 'mono', true, undefined, 'one');
  expect(root()).toHaveAttribute('data-visual-theme', 'custom');
  expect(customThemeTokens(false)['--accent']).toBe(CUSTOM.light.accent);
  configureVisualThemes([], 'lumen', true, undefined, 'one');
  expect(root()).toHaveAttribute('data-visual-theme', 'lumen');
  configureVisualThemes([CUSTOM], 'mono', true, undefined, 'one');
  expect(root()).toHaveAttribute('data-visual-theme', 'custom');
});

test("an App theme inherits its base's palette, faces and radii without mutating its module", () => {
  const custom: ThemeDefinition = { ...CUSTOM, fonts: { heading: 'Georgia, serif' }, radius: undefined };
  const before = JSON.stringify(custom);
  const lumen = themePreset('lumen')!;
  app([custom], 'custom');
  expect(visualThemePalette(false).navGround).toBe(lumen.light.navGround);
  expect(visualThemePalette(true).accent).toBe('#88dddd');
  expect(customThemeTokens(false)).toMatchObject({
    '--surface': '#ffffff',
    '--heading-font': 'Georgia, serif',
    '--field-radius': lumen.radius!.field,
  });
  expect(customThemeTokens(true)['--surface']).toBe('#111111');
  expect(visualThemeOverrides().radius).toBe(lumen.radius!.control);
  expect(JSON.stringify(custom)).toBe(before);
});

test("a theme's round controls, panel corner and widths reach the sheets, and every other box keeps a box's corner", () => {
  const pebble: ThemeDefinition = {
    ...CUSTOM,
    id: 'pebble',
    radius: { control: '999px', field: '12px', pill: '999px', panel: '20px' },
    border: { panel: '0px', focus: '3px' },
  };
  app([pebble], 'pebble');
  expect(customThemeTokens(false)).toMatchObject({
    '--control-radius': '999px',
    '--field-radius': '12px',
    '--pill-radius': '999px',
    '--panel-radius': '20px',
    '--panel-border-width': '0px',
    '--focus-ring-width': '3px',
  });
  // A card, a menu and a dialog follow --radius: round there would be a pill of a card.
  expect(visualThemeOverrides().radius).toBe('8px');
  expect(customThemeTokens(false)).not.toHaveProperty('--radius');
  // A look that says none of them writes none of them, so the sheets keep their own.
  app([], 'lumen');
  for (const token of ['--control-radius', '--panel-radius', '--panel-border-width', '--focus-ring-width'])
    expect(customThemeTokens(false)).not.toHaveProperty(token);
});

test('selection persists, restores at boot, and notifies token owners', () => {
  const listener = vi.fn();
  window.addEventListener(VISUAL_THEME_EVENT, listener);
  try {
    app();
    setVisualTheme('mono');
    expect(window.localStorage.getItem(VISUAL_THEME_KEY)).toBe('mono');
    expect(listener).toHaveBeenCalledOnce();
    root().removeAttribute('data-visual-theme');
    initVisualTheme();
    expect(root()).toHaveAttribute('data-visual-theme', 'mono');
  } finally {
    window.removeEventListener(VISUAL_THEME_EVENT, listener);
  }
});

test("light/dark, density and the reader's typography stay the reader's", () => {
  app();
  root().dataset.theme = 'dark';
  document.body.className = 'density-compact type-mono';
  window.localStorage.setItem('mistri.typography', 'mono');
  setVisualTheme('mono');
  expect(root()).toHaveAttribute('data-theme', 'dark');
  expect(document.body.className).toBe('density-compact type-mono');
  expect(window.localStorage.getItem('mistri.typography')).toBe('mono');
  expect(visualThemeOverrides().font).toContain('ui-sans-serif');
});

test('unavailable preference storage falls back at boot but still allows tab-local changes', () => {
  const getItem = vi.fn(() => {
    throw new Error('blocked');
  });
  const setItem = vi.fn(() => {
    throw new Error('blocked');
  });
  vi.spyOn(window, 'localStorage', 'get').mockReturnValue({ getItem, setItem } as unknown as Storage);
  initVisualTheme();
  app();
  expect(visualThemeChoice()).toBe('lumen');
  setVisualTheme('mono');
  expect(visualThemeChoice()).toBe('mono');
  expect(root()).toHaveAttribute('data-visual-theme', 'mono');
  expect(getItem).toHaveBeenCalled();
  expect(setItem).toHaveBeenCalledWith(VISUAL_THEME_KEY, 'mono');
});

test.each(THEME_PRESETS)('$label is selectable, restored and mode-specific', (preset) => {
  app();
  setVisualTheme(preset.id);
  initVisualTheme();
  expect(visualThemeChoice()).toBe(preset.id);
  expect(root()).toHaveAttribute('data-theme-style', preset.id);
  expect(visualThemePalette(false)).toEqual(preset.light);
  expect(visualThemePalette(true)).toEqual(preset.dark);
  expect(customThemeTokens(false)['--surface']).toBe(preset.light.surface);
  expect(visualThemeOverrides().font).toBe(preset.fonts?.data);
});

test('palette selection layers over the theme, retains both modes and leaves structure alone', () => {
  configureVisualThemes([VARIANTS], 'custom', true, undefined, 'one');
  expect(visualPaletteOptions().map((p) => p.value)).toEqual(['default', 'teal', 'violet']);
  expect(visualPaletteChoice()).toBe('teal');
  const font = visualThemeOverrides();
  root().dataset.theme = 'dark';
  setVisualPalette('violet');
  expect(visualThemePalette(false).accent).toBe('#2456a6');
  expect(customThemeTokens(true)['--accent']).toBe('#a8ccff');
  expect(visualThemeOverrides()).toEqual(font);
  expect(root()).toHaveAttribute('data-theme', 'dark');
  expect(root()).toHaveAttribute('data-theme-palette', 'violet');
  setVisualPalette('default');
  expect(visualThemePalette(false).accent).toBe(CUSTOM.light.accent);
});

test('palette preferences restore per App and theme; retired choices fall back safely', () => {
  configureVisualThemes([VARIANTS], 'custom', true, 'violet', 'one');
  expect(visualPaletteChoice()).toBe('violet');
  setVisualPalette('default');
  initVisualTheme();
  expect(visualPaletteChoice()).toBe('default');
  configureVisualThemes([VARIANTS], 'custom', true, undefined, 'two');
  expect(visualPaletteChoice()).toBe('teal');
  setVisualPalette('violet');
  configureVisualThemes([VARIANTS], 'custom', true, undefined, 'one');
  expect(visualPaletteChoice()).toBe('default');
  setVisualTheme('mono');
  expect(visualPaletteChoice()).toBe('default');
  setVisualTheme('custom');
  setVisualPalette('violet');
  configureVisualThemes([{ ...VARIANTS, palettes: VARIANTS.palettes!.slice(0, 1) }], 'custom', true, undefined, 'one');
  expect(visualPaletteChoice()).toBe('teal');
  configureVisualThemes();
  expect(root()).not.toHaveAttribute('data-theme-palette');
});

test('blocked and malformed palette storage cannot break selection or boot', () => {
  localStorage.setItem(VISUAL_PALETTE_KEY, '{invalid');
  initVisualTheme();
  configureVisualThemes([VARIANTS], 'custom', true);
  expect(visualPaletteChoice()).toBe('teal');
  const storage = window.localStorage;
  const setItem = vi.fn(() => {
    throw new Error('blocked');
  });
  vi.spyOn(window, 'localStorage', 'get').mockReturnValue({ getItem: storage.getItem.bind(storage), setItem } as unknown as Storage);
  setVisualPalette('violet');
  expect(visualPaletteChoice()).toBe('violet');
  setVisualPalette('missing');
  expect(visualPaletteChoice()).toBe('violet');
  expect(setItem).toHaveBeenCalled();
  expect(storage.getItem(VISUAL_PALETTE_KEY)).toBe('{invalid');
});

test('Workbench ignores an App registry, authored defaults and lock policy, including colliding built-in IDs', () => {
  const impostor = { ...CUSTOM, id: 'sage' };
  configureVisualThemes([CUSTOM, impostor], 'custom', false, 'teal', 'private-app', { locked: true, isolated: true });
  expect(visualThemesOffered()).toBe(true);
  expect(visualThemeChoice()).toBe('default');
  expect(visualThemeOptions().some((theme) => theme.value === 'custom')).toBe(false);
  setVisualTheme('custom');
  expect(visualThemeChoice()).toBe('default');
  setVisualTheme('sage');
  expect(visualThemePalette(false)).toEqual(themePreset('sage')!.light);
  expect(customThemeTokens(false)['--accent']).not.toBe(CUSTOM.light.accent);
});

test('Workbench palettes persist in a namespace separate from every App and theme', () => {
  setVisualTheme('lumen');
  setVisualPalette('teal');
  expect(visualPaletteChoice()).toBe('teal');
  initVisualTheme();
  expect(visualThemeChoice()).toBe('lumen');
  expect(visualPaletteChoice()).toBe('teal');
  configureVisualThemes([], 'lumen', true, undefined, 'workbench');
  expect(visualPaletteChoice()).toBe('default');
  setVisualPalette('violet');
  configureVisualThemes();
  expect(visualPaletteChoice()).toBe('teal');
  setVisualTheme('default');
  setVisualPalette('violet');
  expect(visualPaletteChoice()).toBe('default');
  expect(root()).not.toHaveAttribute('data-theme-palette');
  setVisualTheme('lumen');
  expect(visualPaletteChoice()).toBe('teal');
});

test('unknown Workbench preferences fall back to native; blocked storage still permits explicit picks and reset', () => {
  localStorage.setItem(WORKBENCH_VISUAL_THEME_KEY, 'custom');
  initVisualTheme();
  expect(visualThemeChoice()).toBe('default');
  const blocked = () => {
    throw new Error('blocked');
  };
  vi.spyOn(window, 'localStorage', 'get').mockReturnValue({
    getItem: blocked,
    setItem: blocked,
    removeItem: blocked,
  } as unknown as Storage);
  initVisualTheme();
  expect(visualThemeChoice()).toBe('default');
  root().dataset.theme = 'dark';
  document.body.className = 'density-compact type-mono';
  setVisualTheme('sage');
  expect(root()).toHaveAttribute('data-visual-theme', 'sage');
  expect(root()).toHaveAttribute('data-theme', 'dark');
  expect(document.body.className).toBe('density-compact type-mono');
  setVisualTheme('default');
  expect(root()).not.toHaveAttribute('data-visual-theme');
  expect(root()).toHaveAttribute('data-theme', 'dark');
  expect(document.body.className).toBe('density-compact type-mono');
});

test('branded isolated built-in picks rehydrate only in their scope and never bypass the offered/locked policy', () => {
  const scope = JSON.stringify(['branding', 'deployment', 'app', 'north']);
  configureVisualThemes([CUSTOM], 'custom', true, undefined, scope, { isolated: true });
  setVisualTheme('mono');
  initVisualTheme();
  expect(visualThemeChoice()).toBe('mono');
  expect(root()).toHaveAttribute('data-visual-theme', 'mono');
  setVisualTheme('missing');
  expect(visualThemeChoice()).toBe('mono');
  configureVisualThemes([CUSTOM], 'custom', true, undefined, scope, { isolated: true, locked: true });
  expect(visualThemeOptions().map((theme) => theme.value)).toEqual(['custom']);
  expect(visualThemeChoice()).toBe('custom');
  setVisualTheme('mono');
  expect(visualThemeChoice()).toBe('custom');
  expect(visualThemesOffered()).toBe(false);
  const entries = JSON.parse(localStorage.getItem('mistri.custom-theme-choices')!);
  localStorage.setItem('mistri.custom-theme-choices', JSON.stringify([...entries, ['ordinary-app', 'mono']]));
  initVisualTheme();
  configureVisualThemes([CUSTOM], 'custom', true, undefined, 'ordinary-app');
  expect(visualThemeChoice()).toBe('custom');
  configureVisualThemes([CUSTOM], 'custom', true, undefined, JSON.stringify(['branding', 'deployment', 'app', 'south']), {
    isolated: true,
  });
  expect(visualThemeChoice()).toBe('custom');
});

// Last: the real token owner installs page-lifetime observers, as it does at boot.
test('one token owner restores Workbench looks, modes and native reset without retaining App-authored branding', async () => {
  const { applyAppTheme } = await import('../../../mistri/src/client/appTheme.js');
  const branding: ResolvedBranding = {
    status: 'resolved',
    theme: CUSTOM,
    identity: {
      deployment: 'test',
      app: 'app',
      source: 'test',
      bindingRevision: '1',
      catalogRevision: '1',
      tenant: 'north',
      recordKey: { id: 'north' },
      version: '1',
    },
    tokens: { light: {}, dark: {} },
    barStyle: 'plain',
    content: {},
    images: {},
    diagnostics: [],
  };
  const dressed = {
    id: 'app',
    writableTables: false as const,
    ui: {
      customThemes: [CUSTOM],
      theme: {
        preset: 'custom',
        accent: '#ff00ff',
        radius: '8px',
        font: 'App Face',
        branding,
        readerPicker: false,
      },
    },
  };
  root().dataset.theme = 'light';
  applyAppTheme(true, dressed);
  expect(root()).toHaveAttribute('data-record-branding');
  expect(root().style.getPropertyValue('--surface')).toBe(CUSTOM.light.surface);
  expect(visualThemesOffered()).toBe(false);
  applyAppTheme(false, dressed);
  expect(root()).not.toHaveAttribute('data-record-branding');
  expect(root()).not.toHaveAttribute('data-visual-theme');
  expect(root().style.getPropertyValue('--surface')).toBe('');
  expect(visualThemesOffered()).toBe(true);
  expect(document.body).not.toHaveClass('app-readonly');
  setVisualTheme('sage');
  expect(root().style.getPropertyValue('--ground')).toBe(themePreset('sage')!.light.ground);
  expect(root().style.getPropertyValue('--surface')).toBe(themePreset('sage')!.light.surface);
  expect(root().style.getPropertyValue('--mono')).toBe(themePreset('sage')!.fonts!.data);
  for (const key of ['--accent', '--link', '--accent-soft', '--radius', '--chart-1']) {
    expect(document.body.style.getPropertyValue(key)).toBe('');
  }
  root().dataset.theme = 'dark';
  await vi.waitFor(() => expect(root().style.getPropertyValue('--ground')).toBe(themePreset('sage')!.dark.ground));
  setVisualTheme('default');
  for (const key of ['--ground', '--surface', '--mono', '--heading-font', '--field-radius', '--radius']) {
    expect(root().style.getPropertyValue(key)).toBe('');
  }
  expect(root()).not.toHaveAttribute('data-visual-theme');
  expect(root()).toHaveAttribute('data-theme', 'dark');
  // Ordinary App authors still own their overrides after returning from Workbench.
  const ordinary = {
    id: 'ordinary',
    ui: { customThemes: [CUSTOM], theme: { preset: 'custom', accent: '#ff00ff', radius: '8px', font: 'App Face' } },
  };
  applyAppTheme(true, ordinary);
  expect(document.body.style.getPropertyValue('--radius')).toBe('8px');
  expect(root().style.getPropertyValue('--mono')).toBe('App Face');
  applyAppTheme(false, ordinary);
  expect(document.body.style.getPropertyValue('--radius')).toBe('');
  expect(root().style.getPropertyValue('--mono')).toBe('');
});
