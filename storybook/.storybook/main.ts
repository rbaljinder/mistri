import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';
import type { Plugin, PluginOption } from 'vite';

/* The component library, drawn from ../src/client. Every story renders with
   the App's own stylesheets and looks, and the client's API is answered by
   the fixtures a story registers (../mocks/core.js), so nothing needs a
   server. A package of its own: tablewalk never depends on Storybook. */
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const CORE = fileURLToPath(new URL('../../packages/kit/src/client/core.js', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../mocks/core.js', import.meta.url));

/* Every import of the client's core, whatever relative path it is spelled
   with, reaches the fixtures instead; only the fixtures reach the real one. */
function fixtureCore(): Plugin {
  return {
    name: 'storybook:fixture-core',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || importer === FIXTURES || !/(^|\/)core\.js$/.test(source)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved?.id === CORE ? FIXTURES : null;
    },
  };
}

const named = (plugins: PluginOption[] | undefined): Plugin[] =>
  (plugins ?? []).flat(Infinity as 1).filter((p): p is Plugin => Boolean(p) && typeof p === 'object' && 'name' in p);

/* A sample App's component stylesheet stands where the server serves it: in
   the `components` layer (packages/mistri/src/server/app/appComponents.ts), so a look still
   dresses what it draws in a story as in the page. */
function componentLayer(): Plugin {
  return {
    name: 'storybook:component-layer',
    enforce: 'pre',
    transform(code, id) {
      if (!/\/(?:examples|test\/fixtures)\/apps\/[^/]+\/(widgets|pages)\/[^/]+\.css$/.test(id.split('?')[0])) return null;
      return { code: `@layer components {\n${code}\n}\n`, map: null };
    },
  };
}

/* An App's component and page examples (`widgets/*.examples.tsx`, `pages/*.examples.tsx`, @mistriwork/mistri/ui/testing's
   examples()) as stories: the default export is the meta, and each
   `export const Name = example({…})` one story, titled by its App and module
   — `Sample Apps/Lintel/…` for a public example, `Fixture Apps/Commons/Post
   stream` for a fixture that was one. Read off the source, as Storybook's
   own indexer reads a story file's exports. */
const EXAMPLES = /\/(examples|test\/fixtures)\/apps\/([^/]+)\/(?:widgets|pages)\/([^/]+)\.examples\.tsx$/;
const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ');
const sentence = (name: string) => {
  const said = words(name).toLowerCase();
  return said.charAt(0).toUpperCase() + said.slice(1);
};

const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: [
    '../stories/**/*.stories.@(ts|tsx)',
    '../../examples/apps/*/widgets/*.examples.tsx',
    '../../examples/apps/*/pages/*.examples.tsx',
    '../../test/fixtures/apps/*/widgets/*.examples.tsx',
    '../../test/fixtures/apps/*/pages/*.examples.tsx',
  ],
  experimental_indexers: async (existing) => [
    {
      test: /\.examples\.tsx$/,
      createIndex: async (fileName) => {
        const [, home, app, module] = EXAMPLES.exec(fileName) ?? [];
        if (!app) return [];
        const { readFile } = await import('node:fs/promises');
        const source = await readFile(fileName, 'utf8');
        return [...source.matchAll(/^export const ([A-Za-z_$][\w$]*)\s*=\s*example\(/gm)].map(([, exportName]) => ({
          type: 'story' as const,
          importPath: fileName,
          exportName,
          name: sentence(exportName),
          title: `${home === 'examples' ? 'Sample' : 'Fixture'} Apps/${app.charAt(0).toUpperCase()}${app.slice(1)}/${sentence(module)}`,
        }));
      },
    },
    ...(existing ?? []),
  ],
  // Forecourt's studio photos, rendered by `npm run photos`.
  staticDirs: ['../public'],
  core: { disableTelemetry: true },
  /* Accessibility findings per story, in the panel beside it (see preview.tsx). */
  addons: ['@storybook/addon-a11y'],
  async viteFinal(base) {
    const { loadConfigFromFile, mergeConfig } = await import('vite');
    /* The App's own module rules (`./thing.js` may name `./thing.ts`), read
       from the root vite.config.ts rather than copied, so a story resolves
       every import exactly as the App's dev server does. */
    const app = await loadConfigFromFile({ command: 'serve', mode: 'development' }, `${REPO}/vite.config.ts`);
    /* Only the rules for resolving a module. The App bundle's own chunking
       (its surfaces) and its precompression describe the App's build, not a
       static Storybook, and the surfaces check refuses a build without them; the root config, which names no
       product, refuses every build (productless), which a static Storybook is not. */
    const bundleOnly = new Set(['mistri:surfaces', 'mistri:surface-pages', 'mistri:precompress', 'mistri:productless']);
    const rules = named(app?.config.plugins).filter((plugin) => plugin.name.startsWith('tablewalk:') && !bundleOnly.has(plugin.name));
    const hasReact = named(base.plugins).some((plugin) => plugin.name.startsWith('vite:react'));
    const react = hasReact ? [] : [(await import('@vitejs/plugin-react')).default({ include: /\.[jt]sx$/ })];
    return mergeConfig(base, {
      publicDir: false,
      plugins: [fixtureCore(), componentLayer(), ...rules, ...react],
      /* A sample App's custom component imports @mistriwork/mistri/ui as an author's
         does; here that is the SDK's source (its fixture host draws it). Its
         examples import @mistriwork/mistri/ui/testing for example() and fixtures(),
         which a story takes from the fixture host itself, with no test runner. */
      resolve: {
        /* One React, wherever an import starts: a checkout whose node_modules is a link to another's
           resolves Storybook's renderer and the stories' components to two copies, and every hook throws. */
        dedupe: ['react', 'react-dom'],
        alias: [
          { find: /^@mistriwork\/mistri\/ui\/testing$/, replacement: `${REPO}/packages/mistri/src/client/components/sdk/fixture.tsx` },
          { find: /^@mistriwork\/mistri\/ui$/, replacement: `${REPO}/packages/mistri/src/client/components/sdk/index.ts` },
          { find: /^@mistriwork\/mistri\/page$/, replacement: `${REPO}/packages/mistri/src/client/components/sdk/page.tsx` },
        ],
      },
      /* src/client and src/shared sit outside this package. */
      server: { fs: { allow: [REPO] } },
    });
  },
};

export default config;
