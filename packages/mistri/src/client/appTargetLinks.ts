/** Suite navigation availability travels outside the source App's tenant transport. */
import { useSyncExternalStore } from 'react';
import { parseAppTarget, type BoundAppTarget } from '@mistriwork/engine/shared/appLinks.js';
import { parseBasePath } from '@mistriwork/engine/shared/mount.js';
import {
  captureAccountIdentity,
  captureSessionIdentity,
  subscribeSessionIdentity,
  subscribeTenantLease,
  tenantLeaseActive,
  type SessionIdentitySnapshot,
} from '@mistriwork/kit/client/sessionIdentity.js';
import { addHostListener, removeHostListener } from '@mistriwork/kit/client/shellHost.js';

export interface AppTargetLinksScope {
  readonly basePath: string;
  readonly appId: string;
  readonly owner: SessionIdentitySnapshot;
  /** An opaque render generation; context credentials never enter a URL. */
  readonly key: string;
}
let configured: { basePath: string; appId: string; account: SessionIdentitySnapshot } | null = null;
let scope: AppTargetLinksScope | null = null,
  generation = 0;
let removeWake: (() => void) | undefined;
const listeners = new Set<() => void>();
const pending = new Set<AbortController>();
const snapshot = () => scope;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
/** Shared navigation projections observe the same S3 owner as inline CTAs. */
export const captureAppTargetLinks = snapshot;
export const subscribeAppTargetLinks = subscribe;

function refresh(): void {
  for (const controller of pending) controller.abort();
  pending.clear();
  const owner = captureSessionIdentity();
  if (
    configured &&
    (owner.mode !== 'authenticated' || configured.account !== captureAccountIdentity() || configured.appId !== owner.appId)
  ) {
    configured = null;
    removeWake?.();
    removeWake = undefined;
  }
  scope =
    configured && (!owner.tenantRequired || (owner.tenant && tenantLeaseActive(owner)))
      ? Object.freeze({
          basePath: configured.basePath,
          appId: configured.appId,
          owner,
          key: JSON.stringify([++generation, owner.epoch, owner.accountId, owner.appId, owner.tenant?.tenantId ?? null]),
        })
      : null;
  for (const listener of listeners) listener();
}
subscribeSessionIdentity(refresh);
subscribeTenantLease(refresh);

/** Call after establishing whoami identity, only with the server's suite metadata. */
export function configureAppTargetLinks(metadata: { basePath: string; appId: string } | null): void {
  configured = null;
  removeWake?.();
  removeWake = undefined;
  const owner = captureSessionIdentity();
  if (metadata && owner.mode === 'authenticated' && metadata.appId === owner.appId) {
    try {
      if (typeof metadata.basePath === 'string' && parseBasePath(metadata.basePath) === metadata.basePath) {
        configured = { ...metadata, account: captureAccountIdentity() };
      }
    } catch {
      /* Invalid or absent metadata gives no suite endpoint. */
    }
  }
  if (configured && typeof window !== 'undefined') {
    const wake = () => {
      if (document.visibilityState !== 'hidden') refresh();
    };
    addHostListener(window, 'focus', wake);
    addHostListener(window, 'pageshow', wake);
    addHostListener(document, 'visibilitychange', wake);
    removeWake = () => {
      removeHostListener(window, 'focus', wake);
      removeHostListener(window, 'pageshow', wake);
      removeHostListener(document, 'visibilitychange', wake);
    };
  }
  refresh();
}

export const useAppTargetLinks = () => useSyncExternalStore(subscribe, snapshot, snapshot);
export const appTargetLinksCurrent = (captured: AppTargetLinksScope): boolean =>
  scope === captured &&
  captured.owner === captureSessionIdentity() &&
  captured.owner.mode === 'authenticated' &&
  (!captured.owner.tenantRequired || Boolean(captured.owner.tenant && tenantLeaseActive(captured.owner)));

export async function resolveAppTargetLink(
  captured: AppTargetLinksScope,
  target: BoundAppTarget,
  signal: AbortSignal,
): Promise<{ href: string } | null> {
  if (signal.aborted || !appTargetLinksCurrent(captured)) return null;
  const bound = parseAppTarget(target) as BoundAppTarget;
  const controller = new AbortController(),
    abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  pending.add(controller);
  try {
    const response = await fetch(`${captured.basePath}/api/suite/links/resolve`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-mistri-account': captured.owner.accountId! },
      body: JSON.stringify({ sourceApp: captured.appId, target: bound }),
    });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    if (controller.signal.aborted || !appTargetLinksCurrent(captured) || !value || typeof value !== 'object' || Array.isArray(value))
      return null;
    const result = value as Record<string, unknown>;
    return result.accountId === captured.owner.accountId && typeof result.href === 'string' ? { href: result.href } : null;
  } catch {
    return null;
  } finally {
    signal.removeEventListener('abort', abort);
    pending.delete(controller);
  }
}
