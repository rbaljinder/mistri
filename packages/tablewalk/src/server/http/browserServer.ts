/**
 * The database browser's HTTP server: the engine's server (serverCore.ts)
 * with this product's dispatcher (browserHandler.ts) in the middle, and
 * nothing of the App framework — no App API, no inbound endpoints, no embed,
 * no observer. cli/browserServe.ts listens on it; the tests stand it up the
 * same way, so what they prove is the wiring that ships.
 */
import type { Server, ServerResponse } from 'node:http';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { RequestDiagnostics } from '@mistriwork/engine/server/operations/diagnostics.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import type { ConfigLayout } from '@mistriwork/engine/shared/recordview.js';
import type { SavedQuery } from '@mistriwork/engine/shared/sqlsaved.js';
import type { ViewDef } from '@mistriwork/engine/shared/view.js';
import { appMounts, NO_MOUNT } from '@mistriwork/engine/shared/mount.js';
import { handleBrowser } from './browserHandler.js';
import { listen, type Listening } from '@mistriwork/engine/server/http/serverCore.js';

interface BrowserOptions extends Listening {
  readonly registry: Registry;
  readonly views?: ViewDef[];
  /** The file this session read its connections from, and writes them back to. */
  readonly configPath?: string;
  readonly queries?: SavedQuery[];
  readonly pages?: PageDef[];
  readonly layouts?: ConfigLayout[];
  readonly diagnostics?: RequestDiagnostics;
  /** The path a reverse proxy serves it under (shared/mount.ts); there is no App to mount beneath it. */
  readonly addresses?: { readonly base?: string };
}

/**
 * `/_mistri/observe`: the dev observer's address (observe/mount.ts), reserved on every server. The database
 * browser never runs the observer, so the address answers 404 before the door, the routes or the shell can
 * answer it instead, as it does on an App server started without `--dev`.
 */
function reservedForTheObserver(res: ServerResponse, url: URL): Promise<void> | false {
  const reserved = '/_mistri/observe';
  if (url.pathname !== reserved && !url.pathname.startsWith(`${reserved}/`)) return false;
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: 'Not found.' }));
  return Promise.resolve();
}

/** The server, wired but not listening. */
export function createBrowserApp(options: BrowserOptions): Server {
  const mount = options.addresses?.base ? appMounts([], { base: options.addresses.base }) : NO_MOUNT;
  return listen(options, {
    mount: () => mount,
    answer: (req, res, url, inside) =>
      reservedForTheObserver(res, url) ||
      handleBrowser(req, res, url, {
        registry: options.registry,
        ...(options.views ? { views: options.views } : {}),
        ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
        bound: options.bound,
        ...(options.queries ? { queries: options.queries } : {}),
        ...(options.pages ? { pages: options.pages } : {}),
        ...(options.layouts ? { layouts: options.layouts } : {}),
        ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
        mount: inside,
      }),
  });
}
