/**
 * `useDeployment()`: what this server presents the App as — its name, mark, theme, locale and base path — for a
 * free-form page that says the program's name or draws its mark. Read-only and presentation only: a deployment
 * override (the config's `"presentation"`) is already in it, and nothing of the server's own settings is.
 */
import { useMemo } from 'react';
import { useUiHost, type UiBranding, type UiDeployment } from './context.js';

export type { UiBranding, UiDeployment };

export function useDeployment(): UiDeployment {
  const host = useUiHost();
  return useMemo(() => Object.freeze({ ...host.deployment() }), [host]);
}

/** `useBranding()`: the brand the reader sees now — the current tenant's name, logo address and accent in a tenant App
 * that dresses one, else the App's own. Presentation only. */
export function useBranding(): UiBranding {
  const host = useUiHost();
  return useMemo(() => Object.freeze({ ...host.branding() }), [host]);
}
