import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const ui = (file: string) => fileURLToPath(new URL(`../../packages/ui/src/${file}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    /* The kit (kit/) and the gallery's drop-in page read @mistriwork/ui from the checkout's source: its slot
       types, its masks and, for the page that draws both, its primitives and stylesheet. What that source imports
       is found here, so nothing has to be installed at the repository root. The library (src/) imports none of it. */
    alias: [
      { find: /^@mistriwork\/ui\/(.*)\.js$/, replacement: ui('$1') },
      // Where an App's kit gets `defineUiKit`: the page's own module, which is this one in mistri's source.
      { find: /^@mistriwork\/mistri\/page$/, replacement: ui('UiKit.tsx') },
      // Where an App's kit gets `defineUiKit`: the page's own module, which is this one in mistri's source.
      { find: /^@mistriwork\/mistri\/page$/, replacement: ui('UiKit.tsx') },
      { find: /^@mistriwork\/ui\/(.*\.css)$/, replacement: ui('$1') },
    ],
    dedupe: ['react', 'react-dom', '@base-ui/react'],
  },
  server: { fs: { allow: ['../..'] } },
  build: {
    // The theme is written in light-dark(); a lower target has the minifier rewrite every colour into a
    // custom-property toggle, which the mode switch (color-scheme on the root) would then have to drive.
    cssTarget: ['chrome125', 'safari18', 'firefox128'],
  },
});
