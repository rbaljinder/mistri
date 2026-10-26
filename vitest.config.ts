/**
 * Component tests, in a DOM.
 *
 * `npm test` runs the language, the adapters and the DOM-free client
 * modules under node:test; the browser suite drives the whole page in
 * Chromium. Between them sits this: a component drawn into happy-dom,
 * driven with a keyboard and a mouse, against a fetch that answers like
 * the server would. Fast enough to run on every push, close enough to
 * the browser to catch a control that does not do what its label says.
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import base from './vite.config.js';
import { COMPONENT_GLOBS, ownedBy, suites } from './scripts/test-owners.mjs';

/* `TABLEWALK_TEST_PACKAGE=kit npm run test:components`: one package's component tests and the shared ones, as
   `--package` keeps the Node and browser suites to them (scripts/test-owners.mjs). */
const kept = process.env.TABLEWALK_TEST_PACKAGE;

const routers = (file: string) => fileURLToPath(new URL(`./test/embed-routers/${file}`, import.meta.url));
const sdk = (file: string) => fileURLToPath(new URL(`./packages/mistri/src/client/components/sdk/${file}`, import.meta.url));

export default mergeConfig(
  base,
  defineConfig({
    /* A sample App's component and page tests import @mistriwork/mistri/ui and @mistriwork/mistri/page as an author's do;
     in this checkout that is the SDK's source, not the dist/ui a package ships. */
    resolve: {
      alias: [
        { find: /^@mistriwork\/mistri\/ui\/testing$/, replacement: sdk('testing.tsx') },
        { find: /^@mistriwork\/mistri\/ui$/, replacement: sdk('index.ts') },
        { find: /^@mistriwork\/mistri\/page$/, replacement: sdk('page.tsx') },
        /* @mistriwork/mistri/react's adapters name routers this repository does not install (packages/mistri/src/embed/adapters.test.tsx mocks them). */
        { find: /^react-router$/, replacement: routers('react-router.ts') },
        { find: /^@tanstack\/react-router$/, replacement: routers('tanstack-react-router.ts') },
        { find: /^next\/navigation$/, replacement: routers('next-navigation.ts') },
      ],
    },
    test: {
      root: '.',
      include: kept ? ownedBy(suites().components, kept) : COMPONENT_GLOBS,
      environment: 'happy-dom',
      // Whole-App imports and isolated DOMs compete for memory on developer
      // machines. Two workers avoid swap-driven functional-test timeouts; callers
      // can override with --maxWorkers on dedicated runners.
      maxWorkers: 2,
      setupFiles: ['test/components.setup.ts'],
      // Removes the temp folder Vitest leaves behind after each run (see the file).
      globalSetup: ['test/components.globalSetup.ts'],
    },
  }),
);
