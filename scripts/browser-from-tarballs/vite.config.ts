/**
 * The database browser's page, built the way a checkout of the database browser on its own builds it: over the
 * installed @mistriwork/kit and @mistriwork/engine, by package name. scripts/prove-browser-from-tarballs.mjs copies
 * this file beside the browser's sources in a project that installed the packed tarballs, and builds with it; this
 * repository's own build is config/vite.tablewalk.config.ts, the same config over the kit's sources.
 *
 * Every name it imports is on the host list (scripts/boundary/entries.json `host`), which the boundary check holds.
 */
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kitClientConfig, kitModule } from '@mistriwork/kit/vite';
import { SURFACE_PAGES } from '@mistriwork/engine/server/clientSurface.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLIENT = resolve(HERE, 'src/client');

export default defineConfig(
  kitClientConfig({
    workspace: HERE,
    main: resolve(CLIENT, 'workbenchShell.js'),
    clients: [CLIENT],
    build: {
      outDir: resolve(HERE, 'dist/client'),
      surfaces: { workbench: [kitModule('app.js'), resolve(CLIENT, 'workbenchShell.js'), resolve(CLIENT, 'workbench.js')] },
      pages: { [SURFACE_PAGES.workbench]: ['workbench'] },
    },
  }),
);
