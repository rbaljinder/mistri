/**
 * The dev observer's page (packages/mistri/src/client/observe/) as the App
 * framework's package carries it: its dist/observe, served at /_mistri/observe by a `--dev` start
 * and by nothing else (packages/mistri/src/server/observe/http.ts). Its own build, so none of
 * it rides in an App's bundle or counts against a surface's budget; from
 * source the same page goes through Vite's middleware like the rest of the
 * client.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsMayBeTs, ownSourcesOnly } from '../vite.config.js';

/* The repository root, whatever directory this file sits in. */
const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)));

export default defineConfig({
  root: resolve(HERE, 'packages/mistri/src/client'),
  base: '/_mistri/observe/',
  configFile: false,
  plugins: [jsMayBeTs(), react({ include: /\.[jt]sx$/ }), ownSourcesOnly(resolve(HERE, 'packages/mistri/dist/observe'))],
  build: {
    outDir: resolve(HERE, 'packages/mistri/dist/observe'),
    emptyOutDir: true,
    target: 'es2023',
    sourcemap: true,
    rolldownOptions: { input: resolve(HERE, 'packages/mistri/src/client/observe/index.html') },
  },
});
