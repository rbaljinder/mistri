/**
 * An App's custom component, fetched the first time the page draws it: its
 * stylesheet linked once, its module imported from where the App payload
 * says it is served (`/{app}/_components/<id>-<hash>.js`). Importing this
 * module installs the page's side of `@mistriwork/mistri/ui` first (host.tsx), so a
 * component's bare imports find the page's own React before it evaluates.
 *
 * A module that cannot be fetched is almost always a deploy — the page was
 * opened before it and the hashed name it holds is gone — which the section
 * says as the built-in chunks do (onDemand.tsx), with a Reload.
 */
import type { ComponentType } from 'react';
import { pageBridge } from '@mistriwork/kit/client/uiBridge.js';
import './host.js';
import { say } from '../../copy/components/components/sdk/componentLoader.js';
import { appFile } from '@mistriwork/kit/client/addressMount.js';

interface Served {
  kind: 'section' | 'value';
  href: string;
  css?: string;
}

const modules = new Map<string, Promise<ComponentType<never>>>();

/* The payload says each file's inside address (`/{app}/_components/…`);
   it is fetched where the browser reaches it (addressMount.js `appFile`): an
   embedded shell's from its endpoint, never under the host's address. */
function served(id: string): Served | undefined {
  const components = (pageBridge.activeApp() as { components?: Record<string, Served> } | null)?.components;
  const entry = components && Object.hasOwn(components, id) ? components[id] : undefined;
  return entry && { kind: entry.kind, ...reached(entry) };
}

const reached = (entry: { href: string; css?: string }) => ({
  href: appFile(entry.href),
  ...(entry.css ? { css: appFile(entry.css) } : {}),
});

function linkStylesheet(href: string, id: string): void {
  if (document.head.querySelector(`link[data-component-css="${CSS.escape(id)}"][href="${CSS.escape(href)}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.componentCss = id;
  document.head.append(link);
}

/** The component the App declares under `id`, its default export; rejects when it is not served or will not load. */
export function loadComponent(id: string): Promise<ComponentType<never>> {
  return loadEntry(id, served(id));
}

/**
 * The component `id` from where `entry` says it is served (its inside address, `/{app}/_components/…`): what a public
 * form's page loads its input components by, from the form's own payload, having no App payload (sdk/publicInputs.ts).
 */
export function loadServedComponent(id: string, given: { href: string; css?: string } | undefined): Promise<ComponentType<never>> {
  return loadEntry(id, given && reached(given));
}

function loadEntry(id: string, entry: { href: string; css?: string } | undefined): Promise<ComponentType<never>> {
  if (!entry) return Promise.reject(new Error(say('theAppServesNoComponent', { id })));
  let loading = modules.get(entry.href);
  if (!loading) {
    if (entry.css) linkStylesheet(entry.css, id);
    loading = (import(/* @vite-ignore */ entry.href) as Promise<{ default?: unknown }>).then((module) => {
      const part = module.default;
      if (typeof part !== 'function' && (typeof part !== 'object' || part === null))
        throw new Error(say('theComponentHasNoDefault', { id }));
      return part as ComponentType<never>;
    });
    // A failed fetch is not kept: the next draw asks again (a Reload is offered meanwhile).
    loading.catch(() => {
      if (modules.get(entry.href) === loading) modules.delete(entry.href);
    });
    modules.set(entry.href, loading);
  }
  return loading;
}
