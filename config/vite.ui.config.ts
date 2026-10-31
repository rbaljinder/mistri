/**
 * `@mistriwork/mistri/ui`, `@mistriwork/mistri/ui/testing` and `@mistriwork/mistri/page` as the published
 * package carries them: dist/ui, for a custom component's or a free-form
 * page's own tests and nothing else.
 *
 * In the page a component never loads these files. Its bare `@mistriwork/mistri/ui`
 * is served as the path of the page's own copy of the SDK
 * (packages/mistri/src/server/app/componentSdk.ts), so it shares the page's React and query
 * cache. A test has no page: there, Vitest resolves the package's exports map
 * to this build. The entries are one build so they share one copy of the
 * SDK's context — the host a test provides is the host the kit reads.
 *
 * Only what the test must share with the author's own code stays an import:
 * React and React DOM (one React in the test) and Testing Library (its
 * `fireEvent` and queries must reach the tree it rendered). Those are the
 * package's optional peers, installed by an author who writes components and
 * never by anyone else (test/repo/server-dependencies.test.ts). Everything
 * else the SDK uses — TanStack Query among it, which a component may not
 * import at all — is bundled here, because an install does not bring it.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { esmExternalRequirePlugin } from 'rolldown/plugins';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsMayBeTs, ownSourcesOnly } from '../vite.config.js';

/* The repository root, whatever directory this file sits in. */
const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SDK = resolve(HERE, 'packages/mistri/src/client/components/sdk');

export default defineConfig({
  root: HERE,
  configFile: false,
  plugins: [jsMayBeTs(), react({ include: /\.[jt]sx$/ }), ownSourcesOnly(resolve(HERE, 'packages/mistri/dist/ui'))],
  build: {
    outDir: resolve(HERE, 'packages/mistri/dist/ui'),
    emptyOutDir: true,
    target: 'es2023',
    minify: false,
    sourcemap: true,
    lib: {
      entry: { index: resolve(SDK, 'index.ts'), testing: resolve(SDK, 'testing.tsx'), page: resolve(SDK, 'page.tsx') },
      formats: ['es'],
    },
    rolldownOptions: {
      /* Base UI's CommonJS helpers must share the author's ESM React too. */
      plugins: [esmExternalRequirePlugin({ external: [/^react(\/|$)/, /^react-dom(\/|$)/, /^@testing-library\//] })],
      output: { entryFileNames: '[name].js', chunkFileNames: 'shared-[hash].js' },
    },
  },
});
