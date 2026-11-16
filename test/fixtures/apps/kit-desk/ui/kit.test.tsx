/* The fixture kit is held to the suite the platform's own kit passes: a plain-HTML kit with no dependency conforms. */
import { test, vi } from 'vitest';

/* happy-dom lays nothing out; the slots this kit leaves to the platform place their popups on these instead, as in
   packages/ui/src/conformance.test.tsx. */
vi.mock('../../../../../packages/ui/src/internal/ruler.js', () => ({
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
const { uiKitConformance } = await import('@mistriwork/ui/conformance.js');
const { default: kit } = await import('./kit.tsx');

uiKitConformance(kit, test);
