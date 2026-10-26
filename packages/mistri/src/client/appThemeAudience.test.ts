/**
 * A signed-out visitor's look (`ui.theme.for.public`, told as `audience: 'public'` by appLook) is the public's: a
 * pick the reader made once in the shell does not move it, so a public page is the same page for everyone.
 */
import { afterEach, expect, test } from 'vitest';
import { applyAppTheme } from './appTheme.js';
import { configureVisualThemes, initVisualTheme, setVisualTheme, visualThemeChoice } from '../../../kit/src/client/visualTheme.js';

afterEach(() => {
  window.localStorage.clear();
  configureVisualThemes();
  initVisualTheme();
});

test("a public look is worn whatever the reader picked; the App's own look still yields to the pick", () => {
  initVisualTheme();
  applyAppTheme(true, { id: 'rides', ui: { theme: { preset: 'lumen' } } } as never);
  setVisualTheme('mono');
  expect(visualThemeChoice()).toBe('mono');
  applyAppTheme(true, { id: 'rides', ui: { theme: { preset: 'sage', audience: 'public' } } } as never);
  expect(visualThemeChoice()).toBe('sage');
  applyAppTheme(true, { id: 'rides', ui: { theme: { preset: 'lumen' } } } as never);
  expect(visualThemeChoice()).toBe('mono');
});
