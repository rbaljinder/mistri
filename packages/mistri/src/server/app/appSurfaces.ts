/**
 * Surfaces: `surfaces/<key>.surface.ts`, one per file, each `export default defineSurface({ label, reads, commands })`
 * from `@mistriwork/mistri/page`; the file's name is the surface's key, which a front end the App draws itself names
 * in `X-Mistri-Surface` (shared/appSurfaces.ts says what the server holds it to).
 *
 * Read as a free-form page's definition is (appPages.ts): compiled, then evaluated in a throwaway worker with no
 * environment, where every host module is an inert stand-in and `defineSurface` hands back its fields. A surface is a
 * page with nothing to draw, so what only a page drawn by mistri has — a component, a place in nav, a layout, a head,
 * address parameters, a signed-out door — is refused with the page's own code.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord, VIEW_KEY } from '@mistriwork/engine/shared/model.js';
import { isMessageRef } from '@mistriwork/engine/shared/appMessages.js';
import type { ComponentDecl } from '@mistriwork/engine/shared/appComponents.js';
import type { SurfaceFile } from '../../shared/appSurfaces.js';
import { compilePageModule } from './appComponents.js';
import { astParser, evaluate, withStandIns } from './appPages.js';

/** A surface's file name: its key, then the suffix. */
const SURFACE_FILE = /^(.+)\.surface\.(ts|js)$/;
/** The keys `defineSurface` takes: a page's, but what a page drawn by mistri alone has. */
const SURFACE_KEYS = ['label', 'icon', 'description', 'favorite', 'roles', 'reads', 'commands', 'forms', 'loader'];
/* A page's keys a surface has no use for, each refused with the page's code for it and the reason. */
const PAGE_ONLY: Readonly<Record<string, readonly [code: string, why: string]>> = {
  component: ['page-file', 'a surface draws nothing; the front end that names it draws'],
  nav: ['page-nav', "a surface has no place in the App's menu"],
  layout: ['page-layout', 'a surface has no frame to lay out'],
  head: ['page-layout', 'a surface has no head to shape'],
  params: ['page-params', 'a surface keeps no address; the front end keeps its own'],
  public: ['page-public', 'a surface is used by a signed-in person; a signed-out visitor uses a public form or page'],
  actions: ['page-action', "a fixed action writes through the record page's update route, which a surface does not open; name a command"],
};

/** The surface files an App directory holds, by name under surfaces/; none without a surfaces/ folder. */
export async function surfaceFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, 'surfaces'))).filter((file) => SURFACE_FILE.test(file)).sort();
  } catch {
    return [];
  }
}

/** Every surface file's fields, read under stand-ins. Throws naming the file and the fix. */
export async function readSurfaceFiles(dir: string, files: readonly string[], where: string): Promise<SurfaceFile[]> {
  const read: SurfaceFile[] = [];
  for (const file of files) {
    const at = `${where}: surfaces/${file}`;
    const key = SURFACE_FILE.exec(file)![1];
    if (!VIEW_KEY.test(key))
      throw new Error(`[page-path] ${at}: "${key}" is not a surface's key — lowercase letters, digits and hyphens, at most 43 characters.`);
    const decl: ComponentDecl = { id: `surface-${key}`, module: `./surfaces/${file}`, kind: 'page' };
    const code = await compilePageModule(dir, decl);
    if (code === undefined)
      throw new Error(`${where}: has surfaces, which are compiled with rolldown: install it beside mistri (\`npm i -D rolldown\`).`);
    let fields: unknown;
    try {
      fields = await evaluate(withStandIns(await astParser(), code), 'surface');
    } catch (error) {
      throw new Error(`[page-file] ${at}: ${(error as Error).message}`);
    }
    read.push({ key, at, fields: checkedFields(fields, at) });
  }
  return read;
}

function checkedFields(raw: unknown, at: string): Record<string, unknown> {
  if (!isRecord(raw))
    throw new Error(`[page-file] ${at} has no default export made by defineSurface: export default defineSurface({ … }).`);
  for (const name of Object.keys(raw)) {
    if (Object.hasOwn(PAGE_ONLY, name)) {
      const [code, why] = PAGE_ONLY[name];
      throw new Error(`[${code}] ${at}: defineSurface has "${name}", and ${why}. Remove it.`);
    }
    if (!SURFACE_KEYS.includes(name))
      throw new Error(`[page-file] ${at}: defineSurface has no "${name}". It takes ${SURFACE_KEYS.join(', ')}.`);
  }
  if (!isMessageRef(raw.label) && (typeof raw.label !== 'string' || !raw.label.trim()))
    throw new Error(`[page-file] ${at} has no "label": what the surface is called, as text or msg('…').`);
  if (raw.description !== undefined && !isMessageRef(raw.description) && typeof raw.description !== 'string')
    throw new Error(`[page-file] ${at}: "description" is text or msg('…').`);
  return raw;
}
