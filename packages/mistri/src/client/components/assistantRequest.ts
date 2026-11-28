/**
 * The assistant's requests, as its panel sends them. In an ordinary App they
 * are `api()`'s. In a tenant App they carry the tab's context lease and
 * nothing that names a tenant: the server recovers the lease and takes the
 * tenant from it alone (server tenant/tenantAssistant.ts), so a conversation
 * is always the current customer's. Kept in the assistant's own chunk.
 */
import { api, viewportSize } from '@mistriwork/kit/client/core.js';
import { captureSessionIdentity, captureTenantLease, sessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { TENANT_HTTP_HEADERS as names } from '../../shared/tenantContext.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';
import { shell } from '@mistriwork/kit/client/shellMode.js';

/** The account, and in a tenant App the tab's lease: what the server admits an assistant request by. */
export function assistantHeaders(): Record<string, string> {
  const identity = captureSessionIdentity();
  if (identity.mode !== 'authenticated' || !identity.accountId) return {};
  const lease = identity.tenantRequired ? captureTenantLease(identity) : undefined;
  /* The picks the shell would send with any read (an App's `choose`): the assistant acts for the person at this desk,
     so each tool it calls reads under them. The server reads each row again under the person's own reach, and falls
     back to their stored pick for a name left out; the assistant has no way to change either. */
  const chosen = new URLSearchParams(shell().chosen()).toString();
  return {
    ...(chosen ? { 'x-mistri-chosen': chosen } : {}),
    [names.account]: identity.accountId,
    ...(lease && identity.appId
      ? { [names.app]: identity.appId, [names.tab]: lease.tabId, [names.context]: lease.context, [names.revision]: String(lease.revision) }
      : {}),
  };
}

/**
 * Whose conversations the panel shows: the account's, in the lease's tenant, so the history switches with the customer
 * and with the person. The panel is kept while the page is, and a conversation it last showed was reopened for whoever
 * signed in next in that tab, who could only be refused it.
 */
export function assistantOwner(): string {
  const identity = captureSessionIdentity();
  const tenant = (identity.tenantRequired && captureTenantLease(identity)?.tenantId) || '';
  return `${identity.accountId ?? ''}\n${tenant}`;
}

export async function assistantApi(path: string, body?: Record<string, unknown>): Promise<unknown> {
  if (!captureSessionIdentity().tenantRequired) return api(path as never, ...((body === undefined ? [] : [body]) as never[]));
  const res = await fetchServer(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { ...assistantHeaders(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let value: { error?: unknown } | null = null;
  try {
    value = (await res.json()) as { error?: unknown };
  } catch {
    /* The status is all there is to say. */
  }
  if (!res.ok) throw Object.assign(new Error(typeof value?.error === 'string' ? value.error : `${res.status}`), { status: res.status });
  return value;
}

/** Execute a confirmed external HTTP/MCP write proposal via the server bridge and return its normalized outcome. */
export async function executeExternalProposal(
  app: string | undefined,
  tool: string,
  input: Record<string, unknown>,
): Promise<{ status: 'done' | 'failed'; detail?: string }> {
  try {
    const res = (await assistantApi('/api/assistant/external/execute', { app, tool, input })) as {
      ok: boolean;
      status: number;
      output: string;
    };
    if (!res.ok) return { status: 'failed', detail: res.output || `HTTP ${res.status}` };
    return { status: 'done', ...(res.output ? { detail: res.output.slice(0, 480) } : {}) };
  } catch (error) {
    return { status: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}

/* Panel presentation mode (sidebar, floating, fullscreen) and side-panel width are per-person preferences on this device. */
export type PanelPresentation = 'sidebar' | 'floating' | 'fullscreen';
export const ALL_PRESENTATIONS: readonly PanelPresentation[] = ['sidebar', 'floating', 'fullscreen'];
const modeKey = (app: string) => `mistri.assistant.mode.${app}.${sessionIdentity().accountId ?? 'local'}`;
const expandedKey = (app: string) => `mistri.assistant.expanded.${app}.${sessionIdentity().accountId ?? 'local'}`;
const widthKey = (app: string) => `mistri.assistant.width.${app}.${sessionIdentity().accountId ?? 'local'}`;
export const PANEL_WIDTH_MIN = 384;
export const PANEL_WIDTH_MAX = 832;
function panelCeiling(): number {
  const vw = viewportSize().width;
  return vw > 0 ? Math.max(PANEL_WIDTH_MIN, Math.min(PANEL_WIDTH_MAX, Math.floor(vw * 0.75))) : PANEL_WIDTH_MAX;
}
export function clampPanelWidth(px: number): number {
  return Math.round(Math.min(panelCeiling(), Math.max(PANEL_WIDTH_MIN, px)));
}
export function readPresentation(app: string, allowed: readonly PanelPresentation[], fallback: PanelPresentation): PanelPresentation {
  try {
    const saved = window.localStorage.getItem(modeKey(app)) as PanelPresentation | null;
    if (saved && allowed.includes(saved)) return saved;
    if (window.localStorage.getItem(expandedKey(app)) === '1' && allowed.includes('fullscreen')) return 'fullscreen';
  } catch {
    /* Remembered where the browser lets it be; the panel works either way. */
  }
  return allowed.includes(fallback) ? fallback : (allowed[0] ?? 'sidebar');
}
export function writePresentation(app: string, mode: PanelPresentation): void {
  try {
    window.localStorage.setItem(modeKey(app), mode);
    if (mode === 'fullscreen') window.localStorage.setItem(expandedKey(app), '1');
    else window.localStorage.removeItem(expandedKey(app));
  } catch {
    /* Remembered where the browser lets it be; the panel works either way. */
  }
}
export function readPanelWidth(app: string): number | null {
  try {
    const raw = Number(window.localStorage.getItem(widthKey(app)));
    return Number.isFinite(raw) && raw > 0 ? clampPanelWidth(raw) : null;
  } catch {
    return null;
  }
}
export function writePanelWidth(app: string, width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(widthKey(app));
    else window.localStorage.setItem(widthKey(app), String(Math.round(width)));
  } catch {
    /* Remembered where the browser lets it be; the panel works either way. */
  }
}
