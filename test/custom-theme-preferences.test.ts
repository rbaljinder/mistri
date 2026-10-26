import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  configureVisualThemes,
  initVisualTheme,
  setVisualTheme,
  visualThemeChoice,
  VISUAL_THEME_KEY,
} from '../packages/kit/src/client/visualTheme.js';
import type { ThemeDefinition } from '../packages/engine/src/shared/theme.js';

const theme: ThemeDefinition = {
  id: 'harbor',
  label: 'Harbor',
  light: { surface: '#ffffff', ink: '#111111', accent: '#006677' },
  dark: { surface: '#111111', ink: '#ffffff', accent: '#99ddff' },
};
const saved = new Map<string, string>();
let blocked = false;
const storage = {
  getItem(key: string) {
    if (blocked) throw Error('blocked');
    return saved.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    if (blocked) throw Error('blocked');
    saved.set(key, value);
  },
  removeItem(key: string) {
    if (blocked) throw Error('blocked');
    saved.delete(key);
  },
};
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage, dispatchEvent() {} } });
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { documentElement: { dataset: {}, setAttribute() {}, removeAttribute() {} } },
});
after(() => {
  for (const [name, descriptor] of [
    ['window', originalWindow],
    ['document', originalDocument],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
beforeEach(() => {
  blocked = false;
  saved.clear();
  configureVisualThemes();
  initVisualTheme();
});
const app = (id: string, themes: ThemeDefinition[] = [theme], preset = 'lumen') =>
  configureVisualThemes(themes, preset, true, undefined, id);

test('same custom slug is isolated by stable App ID and restored after boot', () => {
  app('one');
  setVisualTheme('harbor');
  app('two');
  assert.equal(visualThemeChoice(), 'lumen');
  app('one', [{ ...theme, label: 'Renamed label' }]);
  assert.equal(visualThemeChoice(), 'harbor');
  initVisualTheme();
  assert.equal(visualThemeChoice(), 'harbor');
  app('two');
  assert.equal(visualThemeChoice(), 'lumen');
});

test('built-in choice stays global while custom choices remain local', () => {
  app('one');
  setVisualTheme('sage');
  setVisualTheme('harbor');
  assert.equal(saved.get(VISUAL_THEME_KEY), 'sage');
  app('two');
  assert.equal(visualThemeChoice(), 'sage');
  setVisualTheme('lumen');
  app('one');
  assert.equal(visualThemeChoice(), 'harbor');
  setVisualTheme('mono');
  app('two');
  assert.equal(visualThemeChoice(), 'mono');
  app('one');
  assert.equal(visualThemeChoice(), 'mono');
});

test('missing scoped theme falls back to App default and returns without losing preference', () => {
  app('one');
  setVisualTheme('sage');
  setVisualTheme('harbor');
  app('one', [], 'mono');
  assert.equal(visualThemeChoice(), 'mono');
  app('one');
  assert.equal(visualThemeChoice(), 'harbor');
  configureVisualThemes([], undefined, false);
  app('one');
  assert.equal(visualThemeChoice(), 'harbor');
});

test('legacy unscoped custom cannot bind another App; built-in persistence remains compatible', () => {
  saved.set(VISUAL_THEME_KEY, 'harbor');
  initVisualTheme();
  app('one');
  assert.equal(visualThemeChoice(), 'lumen');
  app('two');
  assert.equal(visualThemeChoice(), 'lumen');
  assert.equal(saved.get(VISUAL_THEME_KEY), 'harbor');
  setVisualTheme('harbor');
  assert.equal(visualThemeChoice(), 'harbor');
  app('one');
  assert.equal(visualThemeChoice(), 'lumen');
  saved.set(VISUAL_THEME_KEY, 'mono');
  initVisualTheme();
  assert.equal(visualThemeChoice(), 'mono');
});

test('blocked persistence keeps scoped choices tab-local and malformed entries cannot select a look', () => {
  saved.set(
    'mistri.custom-theme-choices',
    JSON.stringify([
      ['one', 'sage'],
      ['', 'harbor'],
      ['one', {}],
    ]),
  );
  initVisualTheme();
  app('one');
  assert.equal(visualThemeChoice(), 'lumen');
  blocked = true;
  setVisualTheme('harbor');
  app('two');
  assert.equal(visualThemeChoice(), 'lumen');
  app('one');
  assert.equal(visualThemeChoice(), 'harbor');
  setVisualTheme('mono');
  app('two');
  assert.equal(visualThemeChoice(), 'mono');
});
