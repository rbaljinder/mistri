/**
 * The public pages' server renderer as the package carries it: dist/ssr,
 * one module for Node with React and the components it draws inside, so a
 * server renders a public page without React installed (React is the
 * client's, bundled; test/repo/server-dependencies.test.ts holds the server
 * to what an install brings). Under tsx the server loads the same module
 * through Vite instead (packages/mistri/src/server/publicRender.ts). Stylesheets are the
 * page's and are not emitted here.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsMayBeTs, ssrAddressMount } from '../vite.config.js';

/* The repository root, whatever directory this file sits in. */
const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)));

export default defineConfig({
  root: HERE,
  configFile: false,
  logLevel: 'warn',
  plugins: [ssrAddressMount(), jsMayBeTs(), react({ include: /\.[jt]sx$/ })],
  /* React's development build is never the server's: only the production half is bundled. */
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: resolve(HERE, 'packages/mistri/src/client/ssr/render.tsx'),
    outDir: resolve(HERE, 'packages/mistri/dist/ssr'),
    emptyOutDir: true,
    target: 'node24',
    minify: true,
    sourcemap: false,
    // One file: the parts the client loads on demand are drawn here in the same render.
    rolldownOptions: { output: { entryFileNames: 'render.js', codeSplitting: false } },
  },
});
