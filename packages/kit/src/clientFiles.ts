/**
 * Where the page every server sends comes from. The page is the kit's: its index.html, its entry (boot.js) and the
 * shell, which start whichever product sent the page (shellStart.js). Each product builds it into its own dist/client
 * — the database browser's with vite.tablewalk.config.ts, the App framework's with vite.mistri.config.ts, each
 * without the other's main — and names that build with `clientFiles`; the engine serves whichever files it is handed
 * (clientHttp.ts, devclient.ts).
 *
 * From source — under tsx, in a checkout — Vite serves `source` with the workspace's vite.config.ts, and watches only
 * the workspace. Built, the page is the product's bundle; a server under tsx sends that one too when
 * MISTRI_BUILT_CLIENT=1.
 */
import { fileURLToPath } from 'node:url';
import type { ClientFiles } from '@mistriwork/engine/server/devclient.js';

/** The page's sources, and the workspace whose Vite serves them. */
export const KIT_CLIENT: Pick<ClientFiles, 'source' | 'workspace'> = {
  source: fileURLToPath(new URL('./client/', import.meta.url)),
  workspace: fileURLToPath(new URL('../../../', import.meta.url)),
};

/** A product's page: the kit's sources, and `built`, the folder its own client build wrote. */
export function clientFiles(built: string): ClientFiles {
  return { ...KIT_CLIENT, built };
}
