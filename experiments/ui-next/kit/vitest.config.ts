import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const ui = (file: string) => fileURLToPath(new URL(`../../../packages/ui/src/${file}`, import.meta.url));

/* The kit is the one part of the experiment that knows mistri: it fills the slots @mistriwork/ui declares
   (packages/ui/src/UiKit.tsx) and is held to that package's own conformance suite. The suite and the slot types are
   read from the checkout's source, and what that source imports (React, Base UI) is found in this folder's
   node_modules, so the run needs no install at the repository root. */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@mistriwork\/ui\/(.*)\.js$/, replacement: ui('$1') },
      // Where an App's kit gets `defineUiKit`: the page's own module, which is this one in mistri's source.
      { find: /^@mistriwork\/mistri\/page$/, replacement: ui('UiKit.tsx') },
    ],
    dedupe: ['react', 'react-dom', '@base-ui/react'],
  },
  server: { fs: { allow: ['../../..'] } },
  test: {
    root: fileURLToPath(new URL('..', import.meta.url)),
    include: ['kit/**/*.test.tsx'],
    environment: 'happy-dom',
  },
});
