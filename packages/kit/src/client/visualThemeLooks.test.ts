/**
 * A look is exactly its definition, and every look sets its titles at a
 * heading weight no heavier than 700.
 */
import { afterEach, expect, test } from 'vitest';
import { configureVisualThemes, customThemeTokens, initVisualTheme, visualThemeOverrides, visualThemePalette } from './visualTheme.js';
import type { ThemeDefinition } from '../../../engine/src/shared/theme.js';
import { THEME_PRESETS } from '../../../engine/src/shared/themePresets.js';

afterEach(() => {
  window.localStorage.clear();
  configureVisualThemes();
  initVisualTheme();
});

test('a look is exactly its definition', () => {
  for (const look of THEME_PRESETS) {
    configureVisualThemes([], look.id, true);
    expect(visualThemePalette(false)).toEqual(look.light);
    expect(visualThemePalette(true)).toEqual(look.dark);
    expect(visualThemeOverrides().radius).toBe(look.radius!.control);
    expect(customThemeTokens(false)['--field-radius']).toBe(look.radius!.field);
  }
});

test("a look titles at its own weight, never past 700, and an App theme takes its base's", () => {
  for (const look of THEME_PRESETS) {
    configureVisualThemes([], look.id, true);
    expect(Number(customThemeTokens(false)['--heading-weight'])).toBeLessThanOrEqual(700);
  }
  configureVisualThemes([], 'sage', true);
  expect(customThemeTokens(false)['--heading-weight']).toBe('600');
  const house: ThemeDefinition = {
    id: 'house',
    label: 'House',
    base: 'mono',
    light: { surface: '#ffffff', ink: '#0a0a0a', accent: '#171717' },
    dark: { surface: '#0a0a0a', ink: '#fafafa', accent: '#fafafa' },
  };
  configureVisualThemes([house], 'house', true);
  expect(customThemeTokens(false)['--heading-weight']).toBe('700');
});
