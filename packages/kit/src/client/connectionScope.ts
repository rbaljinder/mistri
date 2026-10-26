import { pageBridge } from './uiBridge.js';
import { appRequestScope, setAppRequestScope } from './requestIdentity.js';

/** Listener metadata remains available before a failed app database can open. */
export function setAppConfigured(configured: boolean | null): void {
  setAppRequestScope(configured);
}

/** UI scope only. This does not replace server authorization. */
export function canManageConnections(): boolean {
  return appRequestScope() === false && !pageBridge.activeApp();
}

/** App Workbench uses the same listener boundary as the app itself. */
export function canUseDatabaseTools(): boolean {
  return appRequestScope() === false && !pageBridge.activeApp();
}
