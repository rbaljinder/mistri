# mistri documentation

Markdown-first documentation powered by Astro Starlight. The root is `site/`;
author pages in `site/src/content/docs/`. The home page is `index.mdx`, drawn
with the components in `src/components/` (its hero is `Hero.astro`), and guides
under `docs/` publish at `/docs/<slug>/`.

From the repository root, with Node 24+ and dependencies installed (the root's,
then `cd storybook && npm install`):

```sh
npm run build:site
npm run preview:site
```

`npm run build:site` builds the Starlight pages, then the component library
(`storybook/`) into `site/dist/components/`, served at `/components/` beside the
Components guide. Open http://127.0.0.1:4715. `npm run dev:site` reloads edits while authoring;
Starlight's full-text search works in the built preview, not the dev server.

## Authoring

Use Markdown with YAML `title` and `description`. Starlight supplies the page H1;
start body sections at H2. Every page has one shape: the title; one sentence on
what it is for (the `description`, repeated as the first paragraph); one
runnable example, cut from a sample App and cited by its file and line (Tick
for basics, Lintel for policy and decisions, Ladle for the general path), or a
command when the task is done at the command line; the details in short
sections; and a `## Related` list. Rationale belongs in the repository's
`docs/`, not here. The reference pages (`app-dsl`, `dsl-*`, `cli`,
`cli-browser`) are generated: edit `reference-notes/` or the code's USAGE, then
run `node scripts/dsl-reference.mjs` or `node scripts/cli-reference.mjs`. The home uses Starlight's splash template; its
pictures are entries in `shots.json` like every other screenshot, except the
assistant's, which needs a conversation first:
`node --import tsx scripts/site-assistant-shot.mjs` stages one with a scripted
model (`scripts/site-assistant-shot.json`) and writes it. Update
`astro.config.mjs` when adding a navigation entry. Keep branding in
`src/styles/custom.css`; use Starlight's shared navigation, theme and search.
Screenshots live in `src/assets/` as WebP, referenced by relative Markdown
paths so Astro optimizes them; files served as they are, such as the favicon,
belong in `public/`. Never copy private configuration or fixtures, and never
capture credentials in a screenshot.

Guides distinguish the current release, preview features, private foundations
and roadmap items. Keep those boundaries accurate; synthetic states do not prove
implemented workflows. The homepage's MCP tool counts are checked by the prose test.

## Checks

```sh
node --import tsx --test test/site.test.ts test/prose.test.ts
npm run test:site:browser
```

The first command builds and checks pages, local links, fragments and assets.
The browser script checks the built output on desktop/mobile, including search,
navigation, no-JavaScript content and 404 responses. It does not touch App fixtures.

## Cloudflare Pages

Publish **only `site/dist/`**, never the source directory. No adapter, database,
server functions or secrets are needed to build the static site.

The existing `.github/workflows/site.yml` builds on main and deploys to the
`tablewalk` Pages project when both Cloudflare secrets are configured. Manual
feature-branch runs retain the branch name for preview deployments. Publishing
requires explicit authorization; a local build does not deploy anything.

For a Pages Git build, use repository root `/`, build command `npm run build:site`,
output `site/dist`, and Node 24. Use one deployment mechanism to avoid duplicate
publishes. The configured canonical URL is https://mistriwork.dev.
