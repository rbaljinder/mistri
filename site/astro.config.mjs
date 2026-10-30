import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';

export default defineConfig({
  site: 'https://mistriwork.dev',
  output: 'static',
  /* Screenshots are captured at twice their CSS size (see src/lightbox.ts).
     Constrained layout gives each a srcset, so a phone fetches a width it can
     use, a retina desk the sharp file, and the lightbox the file as captured. */
  image: { layout: 'constrained' },
  /* Pages merged or renamed since the 0.8.5 docs redesign: addresses the site once served. */
  redirects: {
    '/docs/agent-skill/': '/docs/build-with-an-agent/',
    '/docs/walking-query-mcp/': '/docs/query/',
    '/docs/operations/': '/docs/observe/',
    '/docs/check-output/': '/docs/check-codes/',
    '/docs/access-sources/': '/docs/roles/',
    '/docs/workflows/': '/docs/events-and-jobs/',
    '/docs/pages-forms/': '/docs/forms/',
    /* The page is titled "The DSL in one App"; a reader guessed its address from that. */
    '/docs/dsl-in-one-app/': '/docs/dsl-tour/',
    /* The database browser's quickstart and walk became one page when it became a product of its own (1.0). */
    '/docs/quickstart-browse/': '/docs/database-browser/',
    '/docs/walk/': '/docs/database-browser/',
    /* Merged in the 1.0 docs revamp: the ways to start are one page, and what a crawler reads is part of the public pages. */
    '/docs/quickstart-new-app/': '/docs/getting-started/#from-a-schema-of-your-own',
    '/docs/seo-and-images/': '/docs/landing-pages/#search-engines-and-link-previews',
  },
  integrations: [
    starlight({
      /* A broken link or anchor fails the build. /components/ is the Storybook
       build, copied in by `npm run build:site` after this one, so it is not a
       page this build can see. */
      /* /components/ and the changelog are pages of their own (src/pages), which the validator cannot see. */
      plugins: [starlightLinksValidator({ errorOnRelativeLinks: false, exclude: ['/components/', '/components/**', '/docs/changelog/'] })],
      title: 'mistri',
      description:
        'A few lines of TypeScript. A complete App. Lists, record pages, forms, dashboards, public pages, sign-in and roles, on PostgreSQL.',
      favicon: '/assets/favicon.svg',
      /* The mark: an m whose last stroke lays the block that completes it. */
      logo: { light: './src/assets/mistri-mark-light.svg', dark: './src/assets/mistri-mark-dark.svg' },
      customCss: ['./src/styles/custom.css'],
      /* Code in GitHub's plain themes on the page's own stone, square-ish and
         flat, set in the same mono as inline code. */
      expressiveCode: {
        themes: ['github-dark-default', 'github-light-default'],
        styleOverrides: {
          borderRadius: '8px',
          borderColor: 'var(--sl-color-hairline-light)',
          codeBackground: 'var(--tw-code-bg)',
          codeFontFamily: 'var(--__sl-font-mono)',
          uiFontFamily: 'var(--__sl-font)',
          frames: {
            shadowColor: 'transparent',
            editorTabBarBackground: 'var(--tw-code-bar)',
            editorActiveTabBackground: 'var(--tw-code-bg)',
            editorActiveTabIndicatorTopColor: 'transparent',
            editorActiveTabIndicatorBottomColor: 'transparent',
            terminalTitlebarBackground: 'var(--tw-code-bar)',
            terminalBackground: 'var(--tw-code-bg)',
          },
        },
      },
      components: {
        MarkdownContent: './src/components/MarkdownContent.astro',
        Hero: './src/components/Hero.astro',
        Header: './src/components/Header.astro',
        Footer: './src/components/Footer.astro',
      },
      /* Inter, the face of Lumen (the look an App wears by default), shipped
         beside the site as the client ships it (packages/kit/src/client/fonts), so the site
         and the screens on it are set in one face. Preloaded: every page uses it. */
      head: [
        {
          tag: 'link',
          attrs: { rel: 'preload', href: '/fonts/inter-latin.woff2', as: 'font', type: 'font/woff2', crossorigin: '' },
        },
        /* The mark in the sizes a browser, a phone's home screen and a pinned tab ask for, and the link preview. */
        { tag: 'link', attrs: { rel: 'icon', href: '/assets/favicon-32.png', type: 'image/png', sizes: '32x32' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/assets/apple-touch-icon.png' } },
        { tag: 'link', attrs: { rel: 'manifest', href: '/site.webmanifest' } },
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://mistriwork.dev/assets/og.png' } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://mistriwork.dev/assets/og.png' } },
      ],
      /* One path, in the order a reader takes it: start an App, build it (the
       loop, extending it, testing it), say what it does, its data and who may
       see it, its screens, ship it, and look something up. The database
       browser, tablewalk, is a product of its own: one line on the home and
       the last group here. Each page is in exactly one place, and
       test/docs-site.test.ts holds that. */
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'Home', slug: 'index' },
            { label: 'Get started', slug: 'docs/getting-started' },
            { label: 'An App from your database', slug: 'docs/quickstart-app' },
            { label: 'Build an App with a coding agent', slug: 'docs/build-with-an-agent' },
            { label: 'Tick in fifteen minutes', slug: 'docs/tick-tutorial' },
            { label: 'The DSL in one App', slug: 'docs/dsl-tour' },
            { label: 'Sample Apps', slug: 'docs/examples' },
          ],
        },
        {
          label: 'Build',
          items: [
            { label: 'Choose a building block', slug: 'docs/choose' },
            { label: 'Conventions', slug: 'docs/conventions' },
            { label: 'Reload and restart', slug: 'docs/reload-and-restart' },
            { label: 'Custom components', slug: 'docs/custom-components' },
            { label: 'The general path', slug: 'docs/general-path' },
            { label: 'Mount in your server', slug: 'docs/mount-in-your-server' },
            { label: 'Embed in a React app', slug: 'docs/embed-in-a-react-app' },
            { label: 'Test an App', slug: 'docs/testing-apps' },
            { label: 'Testing workflow', slug: 'docs/test-workflow' },
            { label: 'Fake external services', slug: 'docs/service-virtualization' },
          ],
        },
        {
          label: 'Behavior',
          items: [
            { label: 'Actions', slug: 'docs/actions' },
            { label: 'Commands', slug: 'docs/commands' },
            { label: 'Command forms and bulk', slug: 'docs/command-forms' },
            { label: 'Events, jobs and workflows', slug: 'docs/events-and-jobs' },
            { label: 'Decisions', slug: 'docs/decisions' },
            { label: 'Live sync', slug: 'docs/live-sync' },
            { label: 'Email', slug: 'docs/email' },
            { label: 'Tenant mail', slug: 'docs/tenant-mail' },
            { label: 'Integrations', slug: 'docs/integrations' },
            { label: 'An assistant', slug: 'docs/assistant' },
            { label: 'An API-only App', slug: 'docs/build-an-api' },
          ],
        },
        {
          label: 'Data',
          items: [
            { label: 'Resources and fields', slug: 'docs/access-model' },
            { label: 'Relationships', slug: 'docs/relationships' },
            { label: 'Sources', slug: 'docs/sources' },
            { label: 'Dates and types', slug: 'docs/dates-and-types' },
            { label: 'Query language', slug: 'docs/query' },
            { label: 'Segments', slug: 'docs/segments' },
            { label: 'Tags', slug: 'docs/tags' },
            { label: "Stock that can't be oversold", slug: 'docs/stock' },
            { label: 'File storage', slug: 'docs/file-storage' },
            { label: 'Change your schema', slug: 'docs/change-your-schema' },
            { label: 'Change it from schema.sql', slug: 'docs/schema-sql' },
            {
              label: 'Access',
              items: [
                { label: 'Security model', slug: 'docs/security' },
                { label: 'Sign-in', slug: 'docs/sign-in' },
                { label: 'Roles and field access', slug: 'docs/roles' },
                { label: 'Row access', slug: 'docs/row-access' },
                { label: 'Secrets and hidden columns', slug: 'docs/secrets' },
                { label: 'Tenant Apps', slug: 'docs/tenant-apps' },
                { label: 'Identity providers', slug: 'docs/identity-providers' },
                { label: 'SAML 2.0', slug: 'docs/saml' },
                { label: 'SCIM provisioning', slug: 'docs/scim' },
                { label: 'Sign in from your app', slug: 'docs/embed-sign-in' },
              ],
            },
          ],
        },
        {
          label: 'UI',
          items: [
            { label: 'Lists', slug: 'docs/lists' },
            { label: 'Record pages', slug: 'docs/pages' },
            { label: 'Forms', slug: 'docs/forms' },
            { label: 'Dashboards', slug: 'docs/dashboards' },
            { label: 'Navigation and the shell', slug: 'docs/nav-and-shell' },
            { label: 'Public pages', slug: 'docs/landing-pages' },
            { label: 'Display rules', slug: 'docs/vocabularies' },
            { label: 'Money, lines and live totals', slug: 'docs/order-lines' },
            { label: 'Documents', slug: 'docs/documents' },
            { label: 'Icons', slug: 'docs/icons' },
            { label: 'Languages', slug: 'docs/languages' },
            { label: 'Looks', slug: 'docs/looks' },
            { label: 'Themes and branding', slug: 'docs/themes' },
            { label: 'Theme recipes', slug: 'docs/theme-recipes' },
            { label: 'Blocks gallery', slug: 'docs/blocks' },
            { label: 'Component tour', slug: 'docs/components' },
            { label: '@mistriwork/ui on its own', slug: 'docs/mistri-ui' },
            { label: 'Component library', link: '/components/', attrs: { target: '_blank' } },
            /* How each kind of page is composed: rules pointing at one worked
           example each, and the pages `mistri docs compose-*` prints. */
            {
              label: 'Design it well',
              collapsed: true,
              items: [
                { label: 'A record page', slug: 'docs/compose-record-page' },
                { label: 'A form', slug: 'docs/compose-form' },
                { label: 'An overview page', slug: 'docs/compose-overview' },
                { label: 'A list', slug: 'docs/compose-list' },
                { label: 'A dashboard', slug: 'docs/compose-dashboard' },
                { label: 'The navigation and shell', slug: 'docs/compose-shell' },
              ],
            },
          ],
        },
        {
          label: 'Ship',
          items: [
            { label: 'Build and deploy', slug: 'docs/build-and-deploy' },
            { label: 'Move from tablewalk 0.9', slug: 'docs/upgrade-from-0-9' },
            { label: 'Connections and services', slug: 'docs/services' },
            { label: 'Several Apps in one server', slug: 'docs/suites' },
            { label: 'Observe and operate', slug: 'docs/observe' },
            { label: 'Incident runbook', slug: 'docs/incident-runbook' },
            { label: 'Performance and pools', slug: 'docs/performance' },
            { label: 'Performance by default', slug: 'docs/performance-by-default' },
            { label: 'Behavior analytics', slug: 'docs/analytics' },
            { label: 'Experiment analytics', slug: 'docs/experiments' },
          ],
        },
        {
          label: 'Reference',
          items: [
            /* Generated by scripts/dsl-reference.mjs and scripts/cli-reference.mjs; shipped, so `mistri docs dsl-views` reads them offline. */
            { label: 'DSL reference', slug: 'docs/app-dsl' },
            {
              label: 'DSL keys',
              collapsed: true,
              items: [
                { label: 'Root keys', slug: 'docs/dsl-root' },
                { label: 'resources', slug: 'docs/dsl-resources' },
                { label: 'views', slug: 'docs/dsl-views' },
                { label: 'pages', slug: 'docs/dsl-pages' },
                { label: 'auth', slug: 'docs/dsl-auth' },
                { label: 'ui', slug: 'docs/dsl-ui' },
                { label: 'api', slug: 'docs/dsl-api' },
                { label: 'flags and analytics', slug: 'docs/dsl-flags' },
                { label: 'features', slug: 'docs/dsl-features' },
                { label: 'shared shapes', slug: 'docs/dsl-shapes' },
              ],
            },
            { label: 'Command line', slug: 'docs/cli' },
            { label: 'mistri check', slug: 'docs/check-codes' },
            { label: 'Design checks', slug: 'docs/design-lint' },
            { label: 'The theme contract', slug: 'docs/theme-contract' },
            { label: 'App API', slug: 'docs/app-api' },
            { label: 'Glossary', slug: 'docs/glossary' },
            { label: 'Compatibility', slug: 'docs/compatibility' },
            { label: 'Status & roadmap', slug: 'docs/status' },
            /* Generated from CHANGELOG.md as the site builds (src/pages/docs/changelog.astro), so it is a link, not a slug. */
            { label: 'Changelog', link: '/docs/changelog/' },
          ],
        },
        /* tablewalk, the database browser: a package and a command of its own, with no App in it. */
        {
          label: 'Database browser',
          items: [
            { label: 'Database browser', slug: 'docs/database-browser' },
            { label: 'MCP for coding agents', slug: 'docs/mcp' },
            { label: 'Keyboard', slug: 'docs/keyboard' },
            { label: 'Command line', slug: 'docs/cli-browser' },
          ],
        },
      ],
    }),
  ],
});
