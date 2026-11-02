/**
 * The client as the App framework's: the kit's page with this product's main (appShell.js), the entry, the public
 * pages, an App's shell and a tenant's flows, into packages/mistri/dist/client. Everything but what is named here is
 * the kit's preset (`@mistriwork/kit/vite`).
 *
 *   index     the entry's own graph, the App framework's main (appShell.js, which every page runs before anything
 *             else), and whatever the public pages and the shell both need — so a first page is the entry and its
 *             own chunk, never a third one they share;
 *   public    the rest of what a public form, the landing and the sign-in screen need;
 *   shell     the rest of what an App needs to paint: the kit's shell (app.js) and the App's chrome (appnav.js);
 *   tenant    a tenant's flows, which load after the shell, so what they share with it is its.
 */
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kitClientConfig, kitModule } from '../packages/kit/src/vite.ts';
import { SURFACE_PAGES } from '../packages/engine/src/server/clientSurface.ts';

/* The repository root, whatever directory this file sits in. */
const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLIENT = resolve(HERE, 'packages/mistri/src/client');

export default defineConfig(
  kitClientConfig({
    workspace: HERE,
    main: resolve(CLIENT, 'appShell.js'),
    clients: [CLIENT],
    build: {
      outDir: resolve(HERE, 'packages/mistri/dist/client'),
      index: [resolve(CLIENT, 'appShell.js')],
      surfaces: {
        public: [resolve(CLIENT, 'publicSurface.js')],
        shell: [kitModule('app.js'), resolve(CLIENT, 'appnav.js')],
        tenant: [resolve(CLIENT, 'tenantShell.js')],
      },
      sharedWithEntry: [['shell', 'public']],
      /* An App's page preloads the shell with the App's chrome, a public one its own surface. */
      pages: { [SURFACE_PAGES.shell]: ['shell'], [SURFACE_PAGES.public]: ['public'] },
    },
  }),
);
