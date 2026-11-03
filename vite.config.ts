/**
 * How this repository serves the client from source, and the plugins its other builds share.
 *
 * The client is hand-written ES modules, in each package's src/client: the kit's page and shell, and the App
 * framework's rooms beside them. For a long time they went to the browser exactly as written — no bundler — which had one cost:
 * they could not import the TypeScript under src/shared, so the rules both sides need (what a row is called, how a
 * record's columns group, where one condition ends) existed twice, and test/mirrors.test.ts held the copies together.
 * Now they import the shared modules directly, and the kit's Vite preset (packages/kit/src/vite.ts,
 * `@mistriwork/kit/vite`) is what makes that runnable:
 *
 *   - at `npm run build`, the App framework builds the kit's page with its own main into its own dist/client
 *     (config/vite.mistri.config.ts), which is what its published package serves. A person running an App from its
 *     source still has no build step; the build moved into `npm run build`, which already compiled the server.
 *   - under tsx (`npm run dev`, `npm start`, the test suites), the server serves the kit's src/client through Vite's
 *     middleware — see packages/engine/src/server/devclient.ts — with this file's config, so an edit is a reload away
 *     and nothing has to be built first.
 *
 * The database browser, which builds the same kit page with its own main, lives in its own repository
 * (https://github.com/rbaljinder/tablewalk).
 */
import { defineConfig, type Plugin } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kitClientConfig } from './packages/kit/src/vite.ts';

export { jsMayBeTs, noDevtoolsClient, ownSourcesOnly, shortCatalogKeys } from './packages/kit/src/vite.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The product's client folder, whose catalog the builds read beside the kit's. */
export const PRODUCT_CLIENTS = {
  mistri: resolve(HERE, 'packages/mistri/src/client'),
};

/**
 * The page's addressMount.js reads its mount from the page; the server
 * renderer (packages/mistri/src/client/ssr/render.tsx) has no page, so for a server render
 * only, that module is its server twin, which reads the mount of the
 * request being rendered. The client's own graph never sees the swap.
 */
export function ssrAddressMount(): Plugin {
  const page = resolve(HERE, 'packages/kit/src/client/addressMount.js');
  return {
    name: 'mistri:ssr-address-mount',
    enforce: 'pre',
    resolveId(source, importer, options) {
      if (!options?.ssr || !importer || !source.endsWith('addressMount.js')) return null;
      return resolve(dirname(importer), source) === page ? resolve(HERE, 'packages/mistri/src/client/ssr/addressMount.server.ts') : null;
    },
  };
}

/** This config builds nothing: the client is built by config/vite.mistri.config.ts. */
function productless(): Plugin {
  return {
    name: 'mistri:productless',
    apply: 'build',
    buildStart() {
      this.error('Build the client with its own config: vite build -c config/vite.mistri.config.ts.');
    },
  };
}

export default defineConfig(
  kitClientConfig({
    workspace: HERE,
    main: resolve(PRODUCT_CLIENTS.mistri, 'appShell.js'),
    clients: Object.values(PRODUCT_CLIENTS),
    plugins: [ssrAddressMount(), productless()],
  }),
);
