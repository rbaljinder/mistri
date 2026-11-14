import { createLocalStorage, createPreference } from '@ui-sdk/core';

const stored = (name: string) => createLocalStorage(`mistri-ui-next-${name}`);

export const mode = createPreference({
  values: ['system', 'light', 'dark'],
  defaultValue: 'system',
  attribute: 'data-m-mode',
  global: true,
  storage: stored('mode'),
});

export const accent = createPreference({
  values: ['blue', 'moss', 'violet', 'clay'],
  defaultValue: 'blue',
  attribute: 'data-m-accent',
  global: true,
  storage: stored('accent'),
});

export const corners = createPreference({
  values: ['square', 'soft', 'round'],
  defaultValue: 'soft',
  attribute: 'data-m-corners',
  global: true,
  storage: stored('corners'),
});

export const density = createPreference({
  values: ['compact', 'comfortable', 'spacious'],
  defaultValue: 'comfortable',
  attribute: 'data-m-density',
  global: true,
  storage: stored('density'),
});

export const preferences = [mode, accent, corners, density];
