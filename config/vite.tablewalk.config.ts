/**
 * The client as the database browser's: the kit's page with this product's main (workbenchShell.js), the entry and
 * the Workbench's chunk, into packages/tablewalk/dist/client. Everything but what is named here is the kit's preset
 * (`@mistriwork/kit/vite`), which a checkout of the database browser on its own builds with the same way.
 */
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kitClientConfig, kitModule } from '../packages/kit/src/vite.ts';
import { SURFACE_PAGES } from '../packages/engine/src/server/clientSurface.ts';

/* The repository root, whatever directory this file sits in. */
const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLIENT = resolve(HERE, 'packages/tablewalk/src/client');

export default defineConfig(
  kitClientConfig({
    workspace: HERE,
    main: resolve(CLIENT, 'workbenchShell.js'),
    clients: [CLIENT],
    build: {
      outDir: resolve(HERE, 'packages/tablewalk/dist/client'),
      /* The kit's shell, this product's main and its tools: its only page fetches all of it at once. */
      surfaces: { workbench: [kitModule('app.js'), resolve(CLIENT, 'workbenchShell.js'), resolve(CLIENT, 'workbench.js')] },
      /* index.html is the entry alone. */
      pages: { [SURFACE_PAGES.workbench]: ['workbench'] },
    },
  }),
);
