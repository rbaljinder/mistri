/**
 * A dashboard, as the vanilla client reaches it.
 *
 * The screen is a component (components/Dashboard.tsx) and its pure parts are
 * components/dashboardModel.ts; what stays here is the walk's business — which
 * dashboard a page id names, how the reader's window and picks ride the
 * address, the crumb — and the route itself.
 */
import { createElement } from 'react';
import { currentEntry, el, renderCrumbs, state } from './core.js';
import { syncHash } from './url.js';
import { shell } from './shellMode.js';
import { element } from './components/mount.js';
import { parseRootSlot, rootSlot, windowSlug } from './components/dashboardModel.js';
import { dashPageId, dashboardAt } from './components/appRooms.js';

/** The dashboard behind a `dash-<view key>` page id, or null. */
export function dashboardFor(pageId) {
  const app = shell().app();
  return (app && dashboardAt(app, pageId)) ?? null;
}

/**
 * The dashboard route with a window, picks and sections' own periods in its slot. The optional home
 * view preserves the landing shell when controls are used there.
 */
export function dashboardEntry(dashboard, windowNow, picks, home = false, periods = {}) {
  const body = rootSlot(windowNow, picks, periods, dashboard.window);
  return {
    kind: 'page',
    pageId: dashPageId(dashboard.id),
    table: undefined,
    label: dashboard.label,
    rootBody: body || undefined,
    ...(home ? { tab: 'home' } : {}),
  };
}
