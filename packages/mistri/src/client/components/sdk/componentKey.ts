/**
 * Which build of an App's component is current: its id and the hashed
 * address the App payload serves it at (`/{app}/_components/<id>-<hash>.js`).
 * A save that changes the component's code gives it a new address (server
 * appComponents.ts), so a cache keyed by this asks for the new code, where one
 * keyed by the id alone drew the old one for the page's life. A platform
 * input has no address, and is its id.
 */
import { useSyncExternalStore } from 'react';
import { pageBridge } from '@mistriwork/kit/client/uiBridge.js';
import { appPresentation, subscribeAppPresentation } from '@mistriwork/kit/client/connectionTransition.js';

function componentKey(id: string): string {
  const components = (pageBridge.activeApp() as { components?: Record<string, { href: string }> } | null)?.components;
  const href = components && Object.hasOwn(components, id) ? components[id].href : '';
  return href ? `${id}\n${href}` : id;
}

const generation = () => appPresentation().generation;

/** The same, read again whenever the App is replaced: a reload after a save is one (client appLive.ts). */
export function useComponentKey(id: string): string {
  useSyncExternalStore(subscribeAppPresentation, generation, generation);
  return componentKey(id);
}
