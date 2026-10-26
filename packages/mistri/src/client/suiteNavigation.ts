/** Suite account requests never pass through an App's tenant transport. */
import { useSyncExternalStore } from 'react';
import { captureAccountIdentity, subscribeSessionIdentity, type SessionIdentitySnapshot } from '@mistriwork/kit/client/sessionIdentity.js';

export interface SuiteNavigationScope {
  readonly basePath: string;
  readonly owner: SessionIdentitySnapshot;
  readonly generation: number;
}
export interface SuiteApp {
  id: string;
  name: string;
  href: string;
}
export interface SuitePreference {
  accountId: string;
  defaultApp: string | null;
  revision: number;
}

let scope: SuiteNavigationScope | null = null;
let generation = 0;
const listeners = new Set<() => void>();
const pending = new Set<AbortController>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => scope;

function clear() {
  scope = null;
  for (const controller of pending) controller.abort();
  pending.clear();
}
subscribeSessionIdentity(() => {
  if (scope && scope.owner !== captureAccountIdentity()) {
    clear();
    emit();
  }
});

function safePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\\\p{Cc}]/u.test(value);
}

/** Called only with whoami metadata, after establishing its account identity. */
export function configureSuiteNavigation(metadata?: unknown): void {
  const owner = captureAccountIdentity();
  const base = metadata && typeof metadata === 'object' ? (metadata as { basePath?: unknown }).basePath : undefined;
  const valid =
    typeof base === 'string' &&
    (base === '' || safePath(base)) &&
    !/[?#]/.test(base) &&
    !base.split('/').some((part) => part === '.' || part === '..');
  const basePath = valid ? base.replace(/\/$/, '') : null;
  if (scope && owner === scope.owner && basePath === scope.basePath) return;
  clear();
  if (basePath !== null && owner.mode === 'authenticated' && owner.accountId) {
    scope = Object.freeze({ basePath, owner, generation: ++generation });
  }
  emit();
}

export const useSuiteNavigation = () => useSyncExternalStore(subscribe, snapshot, snapshot);
export const suiteNavigationCurrent = (captured: SuiteNavigationScope) => scope === captured && captured.owner === captureAccountIdentity();

export class SuiteRequestError extends Error {
  constructor(readonly status: number) {
    super('suite-request');
  }
}

async function request(
  captured: SuiteNavigationScope,
  route: 'apps' | 'preferences',
  signal: AbortSignal,
  body?: object,
): Promise<Record<string, unknown>> {
  if (!suiteNavigationCurrent(captured) || signal.aborted) throw new SuiteRequestError(409);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  pending.add(controller);
  try {
    const response = await fetch(`${captured.basePath}/api/suite/${route}`, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'x-mistri-account': captured.owner.accountId!, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new SuiteRequestError(response.status);
    const value: unknown = await response.json();
    if (controller.signal.aborted || !suiteNavigationCurrent(captured)) throw new SuiteRequestError(409);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).accountId !== captured.owner.accountId
    )
      throw new SuiteRequestError(409);
    return value as Record<string, unknown>;
  } finally {
    signal.removeEventListener('abort', abort);
    pending.delete(controller);
  }
}

export async function suiteApps(captured: SuiteNavigationScope, signal: AbortSignal): Promise<SuiteApp[]> {
  const value = await request(captured, 'apps', signal);
  if (!Array.isArray(value.apps)) throw new SuiteRequestError(502);
  const ids = new Set<string>();
  return value.apps.map((app: unknown) => {
    if (!app || typeof app !== 'object') throw new SuiteRequestError(502);
    const { id, name, href } = app as Record<string, unknown>;
    if (typeof id !== 'string' || !id || ids.has(id) || typeof name !== 'string' || !name || !safePath(href))
      throw new SuiteRequestError(502);
    ids.add(id);
    return { id, name, href };
  });
}

function preference(value: Record<string, unknown>): SuitePreference {
  if (
    (value.defaultApp !== null && (typeof value.defaultApp !== 'string' || !value.defaultApp)) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0
  )
    throw new SuiteRequestError(502);
  return { accountId: value.accountId as string, defaultApp: value.defaultApp as string | null, revision: value.revision as number };
}

export async function suitePreference(captured: SuiteNavigationScope, signal: AbortSignal): Promise<SuitePreference> {
  return preference(await request(captured, 'preferences', signal));
}

export async function saveSuitePreference(
  captured: SuiteNavigationScope,
  signal: AbortSignal,
  defaultApp: string | null,
  expectedRevision: number,
): Promise<SuitePreference> {
  return preference(await request(captured, 'preferences', signal, { defaultApp, expectedRevision }));
}
