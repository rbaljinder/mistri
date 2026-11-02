/**
 * How this repository serves the client from source, and the plugins its other builds share.
 *
 * The client is hand-written ES modules, in each package's src/client: the kit's page and shell, and each product's
 * rooms beside them. For a long time they went to the browser exactly as written — no bundler — which had one cost:
 * they could not import the TypeScript under src/shared, so the rules both sides need (what a row is called, how a
 * record's columns group, where one condition ends) existed twice, and test/mirrors.test.ts held the copies together.
 * Now they import the shared modules directly, and the kit's Vite preset (packages/kit/src/vite.ts,
 * `@mistriwork/kit/vite`) is what makes that runnable:
 *
 *   - at `npm run build`, each product builds the kit's page with its own main into its own dist/client
 *     (config/vite.tablewalk.config.ts, config/vite.mistri.config.ts), which is what its published package serves. A
 *     person running `npx tablewalk` still has no build step; the build moved into `npm run build`, which already
 *     compiled the server.
 *   - under tsx (`npm run dev`, `npm start`, the test suites), the server serves the kit's src/client through Vite's
 *     middleware — see packages/engine/src/server/devclient.ts — with this file's config, so an edit is a reload away
 *     and nothing has to be built first.
 *
 * This repository serves both products from one source tree, so here the page's main is the one the page names: the
 * database browser's where its server said so (the `mistri-shell` meta), the App framework's otherwise. A product
 * checked out on its own answers with its main alone.
 */
import { defineConfig, type Plugin } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHELL_MAIN, kitClientConfig, kitModule } from './packages/kit/src/vite.ts';

export { jsMayBeTs, noDevtoolsClient, ownSourcesOnly, shortCatalogKeys } from './packages/kit/src/vite.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The products' client folders, whose catalogs the builds read beside the kit's. */
export const PRODUCT_CLIENTS = {
  mistri: resolve(HERE, 'packages/mistri/src/client'),
  tablewalk: resolve(HERE, 'packages/tablewalk/src/client'),
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

/**
 * Both products' mains, for a page served from this repository's sources: the database browser's where the page
 * says so (its server writes `<meta name="mistri-shell" content="workbench">`), the App framework's otherwise. Each
 * is loaded only on the page that runs it.
 */
function eitherMain(): Plugin {
  const id = `\0${SHELL_MAIN}`;
  return {
    name: 'mistri:either-main',
    enforce: 'pre',
    resolveId: (source) => (source === SHELL_MAIN ? id : null),
    load(loaded) {
      if (loaded !== id) return null;
      return [
        `import { shellQuery } from ${JSON.stringify(kitModule('shellHost.js'))};`,
        'export async function start() {',
        `  const main = shellQuery('meta[name="mistri-shell"]')?.getAttribute('content') === 'workbench'`,
        `    ? await import(${JSON.stringify(resolve(PRODUCT_CLIENTS.tablewalk, 'workbenchShell.js'))})`,
        `    : await import(${JSON.stringify(resolve(PRODUCT_CLIENTS.mistri, 'appShell.js'))});`,
        '  return main.start();',
        '}',
      ].join('\n');
    },
  };
}

/** This config builds nothing: a client is one product's (config/vite.tablewalk.config.ts, config/vite.mistri.config.ts). */
function productless(): Plugin {
  return {
    name: 'mistri:productless',
    apply: 'build',
    buildStart() {
      this.error('Build the client as one product: vite build -c config/vite.tablewalk.config.ts, or -c config/vite.mistri.config.ts.');
    },
  };
}

export default defineConfig(
  kitClientConfig({
    workspace: HERE,
    main: eitherMain(),
    clients: Object.values(PRODUCT_CLIENTS),
    plugins: [ssrAddressMount(), productless()],
  }),
);
