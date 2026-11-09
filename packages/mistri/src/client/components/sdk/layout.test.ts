/**
 * `layoutPoint`: a pointer's place inside an element in layout pixels. The density zoom makes a pointer event's client
 * coordinates and an element's drawn box screen pixels while the page places in layout pixels; both are divided by the
 * one ruler (`viewportScale`), so the point is the same whatever the zoom.
 */
import { afterEach, expect, test } from 'vitest';
import { refreshViewportScale } from '@mistriwork/ui/internal/ruler.js';
import { layoutPoint } from './layout.js';

afterEach(() => {
  document.documentElement.style.removeProperty('zoom');
  refreshViewportScale();
});

const element = (box: { left: number; top: number }) => {
  const node = document.createElement('div');
  node.getBoundingClientRect = () => ({ ...box, right: box.left + 200, bottom: box.top + 100, width: 200, height: 100 }) as DOMRect;
  return node;
};

test('a point is measured from the element’s corner in layout pixels, at the zoom the root wears', () => {
  const column = element({ left: 100, top: 50 });
  expect(layoutPoint({ clientX: 160, clientY: 90 }, column)).toEqual({ x: 60, y: 40 });
  // Zoomed 1.25: the screen shows everything 1.25 times larger, the box and the pointer alike.
  document.documentElement.style.setProperty('zoom', '1.25');
  refreshViewportScale();
  const zoomed = element({ left: 125, top: 62.5 });
  expect(layoutPoint({ clientX: 200, clientY: 112.5 }, zoomed)).toEqual({ x: 60, y: 40 });
});
