/**
 * Where an App's components come from, for the kit's slots (componentSlot.tsx):
 * an author's is the SDK's chunk (componentLoader.ts), the platform's own
 * inputs a chunk of their own. The App shell installs it (appnav.js
 * `appShell`); the Workbench has none.
 */
import type { AppComponents } from '@mistriwork/kit/client/shellMode.js';
import { useComponentKey } from './componentKey.js';

export const appComponents: AppComponents = {
  load: (id) => import('./componentLoader.js').then(({ loadComponent }) => loadComponent(id)),
  builtIn: (name) => import('../builtInInputs.js').then(({ builtInInput }) => builtInInput(name)),
  useKey: useComponentKey,
};
