/**
 * Where the page every server sends comes from. The page is the kit's: its index.html, its entry (boot.js) and the
 * shell, which start the main of the product that built it (shellStart.js, `virtual:mistri/shell-main`). Each product
 * builds it into its own dist/client with the kit's Vite preset (`@mistriwork/kit/vite`) — the database browser's with
 * config/vite.tablewalk.config.ts, the App framework's with config/vite.mistri.config.ts — and names that build with
 * `clientFiles`; the engine serves whichever files it is handed (clientHttp.ts, devclient.ts).
 *
 * From source — under tsx — Vite serves the kit's client folder with the vite.config.ts of the product's workspace,
 * and watches only that workspace. The kit's client folder is its sources in a checkout (src/client) and the built
 * modules an install carries (dist/client), each beside this module. Built, the page is the product's bundle; a server
 * under tsx sends that one too when MISTRI_BUILT_CLIENT=1.
 */
import { fileURLToPath } from 'node:url';
import type { ClientFiles } from '@mistriwork/engine/server/devclient.js';

/** The kit's client folder: the page's index.html, its entry and every module the shell is drawn with. */
export const KIT_CLIENT: Pick<ClientFiles, 'source'> = {
  source: fileURLToPath(new URL('./client/', import.meta.url)),
};

/**
 * A product's page: the kit's client folder, `built`, the folder the product's own client build wrote, and
 * `workspace`, the folder whose vite.config.ts, dependency cache and files Vite may use when it serves from source —
 * the product's, since only the product knows where it is checked out.
 */
export function clientFiles({ built, workspace }: { built: string; workspace: string }): ClientFiles {
  return { ...KIT_CLIENT, built, workspace };
}
