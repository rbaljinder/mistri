/**
 * An icon name that names none drew an empty box, and nothing said so: a custom component's "hosue" was found by
 * looking. While the App is written the miss is said once in the console, with the nearest name, and drawn as a
 * house; served, the box stays empty and nothing is said.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { Icon, sayUnknownIcons } from './Icon.js';
import { nearestIconName } from './unknownIcon.js';
import { APP_ICON_GLYPHS } from '@mistriwork/engine/shared/iconGlyphs.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const house = APP_ICON_GLYPHS.house[0];

test('the nearest name is the one a slip of the keys meant, and none where nothing is near', () => {
  const names = Object.keys(APP_ICON_GLYPHS);
  expect(nearestIconName('hosue', names)).toBe('house');
  expect(nearestIconName('Calender', names)).toBe('calendar');
  expect(nearestIconName('spaceship-orbit', names)).toBeUndefined();
});

test('while the App is written, a miss is said once with the nearest name and drawn as a house', async () => {
  const said = vi.spyOn(console, 'error').mockImplementation(() => {});
  sayUnknownIcons(() => true);
  const { container } = render(
    <>
      <Icon name={'hosue' as never} />
      <Icon name={'hosue' as never} />
    </>,
  );
  await waitFor(() => expect(said).toHaveBeenCalledTimes(1));
  expect(String(said.mock.calls[0][0])).toMatch(/^mistri: no icon is called "hosue"; the nearest is "house"\./);
  const drawn = [...container.querySelectorAll('svg')].map((svg) => [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d')));
  expect(drawn).toEqual([[...house], [...house]]);
});

test('served, a miss keeps its empty box and says nothing', async () => {
  const said = vi.spyOn(console, 'error').mockImplementation(() => {});
  sayUnknownIcons(() => false);
  const { container } = render(<Icon name={'nowhere-mark' as never} />);
  await new Promise((done) => setTimeout(done, 50));
  expect(container.querySelector('path')).toBeNull();
  expect(said).not.toHaveBeenCalled();
});
