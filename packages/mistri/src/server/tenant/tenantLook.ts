/**
 * What a running tenant host may take from a save without a restart: the App's
 * look, and nothing else (G175). A tenant host captures its App once and hands
 * that capture to enrollment, policy, administration and every route, so a
 * save restarts it (tenantStartup.ts) — what it grants and to whom were fixed
 * at startup and must not move beneath a lease. A theme is not authority: the
 * palette, the type and the faces it serves change what a page looks like and
 * nothing it may read or write. So a save whose whole difference is the look
 * is worn in place, and any other difference, or any doubt, is still a restart.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AppDef } from '../../shared/app.js';
import type { LoadedApp } from '../app/apps.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';

export interface TenantLook {
  readonly theme?: AppDef['ui']['theme'];
  readonly customThemes?: AppDef['ui']['customThemes'];
  /** The faces the themes name, served at `/{app}/_fonts/` by the names the themes carry. */
  readonly fonts?: LoadedApp['fonts'];
}

function lookOf(loaded: LoadedApp): TenantLook {
  return captureTenantData({
    ...(loaded.app.ui.theme ? { theme: loaded.app.ui.theme } : {}),
    ...(loaded.app.ui.customThemes ? { customThemes: loaded.app.ui.customThemes } : {}),
    ...(loaded.fonts ? { fonts: loaded.fonts } : {}),
  });
}

/* The loaded App with its look taken out, compared as startup compares a load with the one observed (cli/tenant.ts). */
function unlooked(loaded: LoadedApp): unknown {
  const { theme: _theme, customThemes: _custom, ...ui } = loaded.app.ui;
  const { fonts: _fonts, ...rest } = loaded;
  /* A load is data, but should a function ever ride in it, JSON would drop it and call two loads equal: its source is
     compared instead, so any doubt is a restart. */
  return JSON.parse(
    JSON.stringify({ ...rest, app: { ...loaded.app, ui } }, (_key, value) => (typeof value === 'function' ? `fn:${String(value)}` : value)),
  );
}

/**
 * The new look when `after` differs from `before` in its look alone and every
 * file the save touched is one a definition's load reads as data: a module of
 * the definition's graph that is not a page file (a page carries its loader's
 * code) or the commands module. Code is not compared by a load's JSON, so a touched file that can hold code beyond
 * the definition is a restart even when the look also moved. `undefined`
 * means restart.
 */
export function lookOnlyChange(before: LoadedApp, after: LoadedApp, touched: readonly string[]): TenantLook | undefined {
  const graph = new Set((before.modules ?? []).map(real));
  const home = before.dir ?? '';
  const code = new Set([
    ...(before.pageFiles ?? []).map((file) => real(resolve(home, file))),
    ...(before.commands ? [real(before.commands.file)] : []),
  ]);
  if (!touched.length || !touched.every((file) => graph.has(real(file)) && !code.has(real(file)))) return undefined;
  const look = lookOf(after);
  if (isDeepStrictEqual(JSON.parse(JSON.stringify(look)), JSON.parse(JSON.stringify(lookOf(before))))) return undefined;
  return isDeepStrictEqual(unlooked(before), unlooked(after)) ? look : undefined;
}

/* The loader's graph is in real paths; a watcher names a file by the spelling it watched (a linked temp folder). */
function real(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return resolve(file);
  }
}

/** The App wearing the look a host last took in place (`undefined`: the one it started with). */
export function wearing(app: AppDef, look: TenantLook | undefined): AppDef {
  if (!look) return app;
  const { theme: _theme, customThemes: _custom, ...ui } = app.ui;
  return captureTenantData({
    ...app,
    ui: { ...ui, ...(look.theme ? { theme: look.theme } : {}), ...(look.customThemes ? { customThemes: look.customThemes } : {}) },
  });
}
