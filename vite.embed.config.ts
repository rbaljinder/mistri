/**
 * `@mistriwork/mistri/react` as the published package carries it: dist/embed, the
 * served client built once more, as a library a host's bundler takes in.
 *
 * Same source as dist/client (vite.config.ts), three differences:
 *
 *   - the seams. packages/kit/src/client/shellHost.ts, addressMount.js and transport.ts are
 *     the page's globals when served; here each is swapped for its twin in
 *     src/embed/seams/, which answers from the host the shell is bound to
 *     (packages/mistri/src/embed/binding.ts). The served client's bytes do not change.
 *   - the stylesheets. Every sheet the shell imports becomes a module that
 *     hands its text, scoped to `.tw-root` and nested in `@layer tablewalk`
 *     (scripts/embed-css.mjs), to the Provider's adopted sheets
 *     (packages/mistri/src/embed/styles.ts). A host imports no CSS of ours, and none of ours
 *     reaches the host's elements.
 *   - the page. index.html's body, the shell's skeleton, is read from the one
 *     file at build time (`virtual:mistri-skeleton`), with its stylesheets.
 *
 * React and React DOM are the host's (optional peers, as for @mistriwork/mistri/ui);
 * the routers are the host's and are imported only by their own adapter's
 * entry. TanStack Query is bundled with its own client: the shell's cache is
 * not the host's (an isolated client, so the host's v5 minor is not ours to
 * match). The entry is small and loads the shell as a chunk of its own the
 * first time an element is on screen; the host's bundler code-splits the rest
 * as it would its own.
 *
 * `embedPlugins` is the same set for a source server: e2e/support/embedReactHost.ts
 * serves a React host from src/ through Vite's middleware, as every test suite
 * serves the client.
 */
import { defineConfig, type Plugin } from 'vite';
import type { CodeSplittingGroup } from 'rolldown';
import react from '@vitejs/plugin-react';
import { esmExternalRequirePlugin } from 'rolldown/plugins';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsMayBeTs, noDevtoolsClient, ownSourcesOnly, shortCatalogKeys } from './vite.config.js';
import { KIT_CLIENT } from './packages/kit/src/clientFiles.ts';
import { tablewalkScope } from './scripts/embed-css.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = KIT_CLIENT.source;
const EMBED = resolve(HERE, 'packages/mistri/src/embed');
/* Every package's sources: what this build scopes is ours, wherever it sits. */
const SRC = /\/packages\/[^/]+\/src\//;
/* The kit's modules, as a module of another package names them. */
const KIT = '@mistriwork/kit/client/';

/** The client's seams and their twins (packages/mistri/src/embed/binding.ts says why). */
const SEAMS = new Map([
  [resolve(CLIENT, 'shellHost'), resolve(EMBED, 'seams/shellHost.ts')],
  [resolve(CLIENT, 'addressMount'), resolve(EMBED, 'seams/addressMount.ts')],
  [resolve(CLIENT, 'transport'), resolve(EMBED, 'seams/transport.ts')],
]);

function seamsForEmbed(): Plugin {
  return {
    name: 'mistri:embed-seams',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || importer.startsWith(resolve(EMBED, 'seams'))) return null;
      const named = source.startsWith(KIT) ? resolve(CLIENT, source.slice(KIT.length)) : undefined;
      if (!named && !source.startsWith('.')) return null;
      const target = (named ?? resolve(dirname(importer.split('?')[0]), source)).replace(/\.(js|ts|tsx)$/, '');
      return SEAMS.get(target) ?? null;
    },
  };
}

const ADOPT = '\0tablewalk-adopt:';
const STYLES = resolve(EMBED, 'styles.ts');

/**
 * `import './x.css'` (and `import('./lumenLook.css')`, a look's sheet loaded
 * when worn) becomes a module that adopts the sheet's scoped text. Vite's
 * `?inline` does the reading — @imports inlined, urls resolved — and the
 * PostCSS pass (`css.postcss` below) the scoping.
 */
function adoptedCss(): Plugin {
  return {
    name: 'mistri:embed-adopted-css',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!importer || importer.startsWith(ADOPT) || !source.endsWith('.css')) return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      /* Not ending in .css, or Vite's own CSS plugin would read this module as a stylesheet. */
      return resolved ? `${ADOPT}${resolved.id}.js` : null;
    },
    load(id) {
      if (!id.startsWith(ADOPT)) return null;
      const file = id.slice(ADOPT.length, -'.js'.length);
      return [
        `import css from ${JSON.stringify(`${file}?inline`)};`,
        `import { adoptCss } from ${JSON.stringify(STYLES)};`,
        'adoptCss(css);',
        'export default css;',
      ].join('\n');
    },
  };
}

const SKELETON = 'virtual:mistri-skeleton';

/** index.html's body and stylesheets, read from the file the served page is built from. */
function shellSkeleton(): Plugin {
  const page = resolve(CLIENT, 'index.html');
  return {
    name: 'mistri:embed-skeleton',
    resolveId: (source) => (source === SKELETON ? `\0${SKELETON}` : null),
    load(id) {
      if (id !== `\0${SKELETON}`) return null;
      this.addWatchFile(page);
      const html = readFileSync(page, 'utf8');
      const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1];
      if (!body) this.error('packages/kit/src/client/index.html has no <body> to read the shell from.');
      const markup = body
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<noscript>[\s\S]*?<\/noscript>/g, '')
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/>\s+</g, '><')
        .replace(/\s+/g, ' ')
        .trim();
      const sheets = [...html.matchAll(/<link rel="stylesheet" href="\/([\w./-]+\.css)"/g)].map((match) => resolve(CLIENT, match[1]));
      if (!sheets.length) this.error('packages/kit/src/client/index.html links no stylesheet for the shell.');
      return [...sheets.map((sheet) => `import ${JSON.stringify(sheet)};`), `export const skeleton = ${JSON.stringify(markup)};`].join(
        '\n',
      );
    },
  };
}

/**
 * Three chunks past the entries. The library build left alone cuts the graph
 * at every shared module, some four hundred files; the served build has the
 * same problem and the same answer (vite.config.ts, `surfaces`):
 *
 *   router    what the router adapters need (the navigator), so an adapter
 *             costs a host a kilobyte, not the Provider;
 *   provider  the rest of what the Provider entry imports — small, because a
 *             host pays for it on every page that names @mistriwork/mistri/react;
 *   shell     everything packages/mistri/src/embed/shell.ts reaches by static imports and the
 *             entries do not: the client, loaded the first time an element is
 *             on screen.
 *
 * Highest first: a group takes its modules' dependencies with it unless a
 * group before it has them. Parts loaded on demand stay chunks of their own,
 * as they are when served.
 */
function embedChunks(): { plugin: Plugin; groups: CodeSplittingGroup[] } {
  const home = new Map<string, 'router' | 'provider' | 'shell'>();
  const plugin: Plugin = {
    name: 'mistri:embed-chunks',
    apply: 'build',
    buildEnd() {
      const ids = [...this.getModuleIds()];
      const reach = (roots: string[], stop: Set<string> = new Set()) => {
        const seen = new Set<string>();
        const pending = [...roots];
        while (pending.length) {
          const id = pending.pop()!;
          if (seen.has(id) || stop.has(id)) continue;
          seen.add(id);
          pending.push(...(this.getModuleInfo(id)?.importedIds ?? []));
        }
        return seen;
      };
      const entries = ids.filter((id) => this.getModuleInfo(id)?.isEntry);
      const provider = resolve(EMBED, 'index.tsx');
      const shell = resolve(EMBED, 'shell.ts');
      for (const root of [provider, shell]) if (!ids.includes(root)) this.error(`${root} is not in the embed build.`);
      const adapters = reach(entries.filter((id) => id !== provider));
      const entry = reach(entries);
      home.clear();
      for (const id of reach([shell], entry)) home.set(id, 'shell');
      for (const id of entry) if (!entries.includes(id)) home.set(id, adapters.has(id) ? 'router' : 'provider');
    },
  };
  const order = ['router', 'provider', 'shell'] as const;
  const groups = order.map((name, i) => ({ name, priority: order.length - i, test: (id: string) => home.get(id) === name }));
  return { plugin, groups };
}
const CHUNKS = embedChunks();

const VERSION = (JSON.parse(readFileSync(resolve(HERE, 'packages/mistri/package.json'), 'utf8')) as { version: string }).version;

/** Every plugin the embed needs, for this build and for a source server's Vite. */
export function embedPlugins(): Plugin[] {
  return [
    seamsForEmbed(),
    adoptedCss(),
    shellSkeleton(),
    jsMayBeTs(),
    noDevtoolsClient(),
    react({ include: /\.[jt]sx$/ }),
    shortCatalogKeys(),
    {
      name: 'mistri:embed-settings',
      config: () => ({
        define: { __MISTRI_VERSION__: JSON.stringify(VERSION) },
        /* Only tablewalk's own sheets (and what they import) are scoped. */
        css: { postcss: { plugins: [tablewalkScope({ only: (file: string) => SRC.test(file) })] } },
      }),
    },
  ];
}

/* The routers are the host's, each imported only by its own adapter; React is the host's. */
const EXTERNAL = [/^react(\/|$)/, /^react-dom(\/|$)/, /^next(\/|$)/, /^react-router(\/|$)/, /^@tanstack\/react-router(\/|$)/];

export default defineConfig({
  root: HERE,
  configFile: false,
  plugins: [...embedPlugins(), CHUNKS.plugin, ownSourcesOnly(resolve(HERE, 'packages/mistri/dist/embed'))],
  build: {
    outDir: resolve(HERE, 'packages/mistri/dist/embed'),
    emptyOutDir: true,
    target: 'es2023',
    minify: true,
    sourcemap: true,
    lib: {
      entry: {
        'react/index': resolve(EMBED, 'index.tsx'),
        'react/next': resolve(EMBED, 'next.ts'),
        'react/react-router': resolve(EMBED, 'react-router.ts'),
        'react/tanstack-router': resolve(EMBED, 'tanstack-router.ts'),
      },
      formats: ['es'],
    },
    rolldownOptions: {
      /*
       * The plugin is what makes these external, and the only thing that may:
       * Base UI's CommonJS helpers (use-sync-external-store) `require("react")`,
       * and the plugin turns each such call into an import of the host's React.
       * Naming the same specifiers in `external` as well resolves them before
       * the plugin sees them, and the require() is left to rolldown's runtime,
       * which throws in a browser — the built embed did not start from 0.9.0 to
       * 0.9.8 that way. scripts/bundle-budget.mjs refuses any require() left in
       * dist/embed; e2e/embed-built.spec.ts starts the built library in a page.
       */
      plugins: [esmExternalRequirePlugin({ external: EXTERNAL })],
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'react/chunks/[name]-[hash].js',
        /* Every entry is a client module to a host that renders on the server (Next's App Router). */
        banner: (chunk) => (chunk.isEntry ? "'use client';" : ''),
        codeSplitting: { groups: CHUNKS.groups },
      },
    },
  },
});
