import { afterEach, expect, test } from 'vitest';
import { measureFrom, refreshViewportScale, viewportBox, viewportScale, viewportSize } from './ruler.js';
import { drawPopupsIn, popupContainer } from './popups.js';

afterEach(() => {
  measureFrom(() => document.documentElement);
  drawPopupsIn(() => undefined);
  document.documentElement.style.removeProperty('zoom');
});

test('a box and the viewport come back divided by the root zoom, read once until the density moves it', () => {
  const root = document.createElement('div');
  root.style.setProperty('zoom', '2');
  document.body.append(root);
  measureFrom(() => root);
  const box = document.createElement('div');
  box.getBoundingClientRect = () => ({ top: 20, bottom: 60, left: 10, right: 50, width: 40, height: 40 }) as DOMRect;
  expect(viewportScale()).toBe(2);
  expect(viewportBox(box)).toEqual({ top: 10, bottom: 30, left: 5, right: 25, width: 20, height: 20 });
  expect(viewportSize()).toEqual({ width: window.innerWidth / 2, height: window.innerHeight / 2 });
  root.style.setProperty('zoom', '4');
  expect(viewportScale()).toBe(2);
  refreshViewportScale();
  expect(viewportScale()).toBe(4);
  root.remove();
});

test('popups go where Base UI chooses until a shell names its own container', () => {
  expect(popupContainer()).toBeUndefined();
  const portals = document.createElement('div');
  drawPopupsIn(() => portals);
  expect(popupContainer()).toBe(portals);
});
