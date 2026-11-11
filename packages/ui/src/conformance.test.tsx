/* The default kit is held to the suite a kit is held to: an App that plugs nothing in draws what the suite expects. */
import { test, vi } from 'vitest';

/* happy-dom lays nothing out; the popups place themselves on these instead (DateField.test.tsx, Typeahead.test.tsx). */
vi.mock('./internal/anchor.js', () => ({ zoomAnchor: () => null, layoutViewport: () => ({ x: 0, y: 0, width: 1200, height: 900 }) }));
vi.mock('./internal/ruler.js', () => ({
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
const { uiKitConformance } = await import('./conformance.js');

uiKitConformance({}, test);
