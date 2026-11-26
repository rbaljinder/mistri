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
import { beginWork } from '@mistriwork/kit/client/pendingWork.js';
import './host.js';
import { say } from '../../copy/components/components/sdk/componentLoader.js';
import { appFile } from '@mistriwork/kit/client/addressMount.js';
import { sessionIdentity, subscribeSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';

interface Served {
  kind: 'section' | 'value';
  href: string;
  css?: string;
}

const modules = new Map<string, Promise<ComponentType<never>>>();
const stylesheets = new Map<string, Promise<void>>();

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

/** Link a component stylesheet once and resolve when it loads (or fails / times out) so holds wait for CSS too. */
function linkStylesheet(href: string, id: string): Promise<void> {
  if (typeof document === 'undefined' || !document.head) return Promise.resolve();
  const key = `${id}\0${href}`;
  const pending = stylesheets.get(key);
  if (pending) return pending;
  const existing = document.head.querySelector<HTMLLinkElement>(`link[data-component-css="${CSS.escape(id)}"][href="${CSS.escape(href)}"]`);
  if (existing) {
    if (existing.sheet) return Promise.resolve();
    const waitExisting = new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 1200);
      existing.addEventListener('load', done, { once: true });
      existing.addEventListener('error', done, { once: true });
    });
    stylesheets.set(key, waitExisting);
    return waitExisting;
  }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.componentCss = id;
  const wait = new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 1200);
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
  });
  stylesheets.set(key, wait);
  document.head.append(link);
  // In happy-dom/jsdom where `<link rel="stylesheet">` never fires `load`, resolve synchronously if already attached with no real network.
  if (link.sheet) {
    stylesheets.set(key, Promise.resolve());
    return Promise.resolve();
  }
  return wait;
}

/** The component the App declares under `id`, its default export; rejects when it is not served or will not load. */
export function loadComponent(id: string): Promise<ComponentType<never>> {
  const entry = served(id);
  if (entry || !tenantPending()) return loadEntry(id, entry);
  return afterTenantContext(id).then(() => loadEntry(id, served(id)));
}

/* A tenant App's payload lists its components only for a chosen tenant, so a section drawn before the choice (or in the
   moment after it, before the payload is replaced) finds none: that is not a refusal, the answer has not arrived. */
const tenantPending = () => sessionIdentity().tenantRequired === true;

/** Resolves once the tenant is chosen and the payload names the part, looking a few times as it follows; a part still absent then is the App's own gap. */
async function afterTenantContext(id: string): Promise<void> {
  await new Promise<void>((resolve) => {
    if (sessionIdentity().tenant) return resolve();
    const stop = subscribeSessionIdentity(() => {
      if (!sessionIdentity().tenant) return;
      stop();
      resolve();
    });
  });
  for (let look = 0; look < 10 && !served(id); look++) await new Promise((resolve) => setTimeout(resolve, 100));
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
    const settled = beginWork();
    const cssReady = entry.css ? linkStylesheet(entry.css, id) : Promise.resolve();
    const jsReady = (import(/* @vite-ignore */ entry.href) as Promise<{ default?: unknown }>).then((module) => {
      const part = module.default;
      if (typeof part !== 'function' && (typeof part !== 'object' || part === null))
        throw new Error(say('theComponentHasNoDefault', { id }));
      return part as ComponentType<never>;
    });
    loading = Promise.all([jsReady, cssReady])
      .then(([part]) => part)
      .finally(settled);
    // A failed fetch is not kept: the next draw asks again (a Reload is offered meanwhile).
    loading.catch(() => {
      if (modules.get(entry.href) === loading) modules.delete(entry.href);
    });
    modules.set(entry.href, loading);
  }
  return loading;
}
