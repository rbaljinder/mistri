# Publishing tablewalk

Releases use the checked-in GitHub Actions workflows. The package, container
image and desktop installers share the root `package.json` version. The
standalone database browser must remain independently installable and usable.

## Prepare and review

1. Finish the release changelog and reconcile current-version statements in the
   README, getting-started guide, capabilities page and roadmap. Historical
   release sections keep their original versions.
2. Run the full local gates: `npm test` with live PostgreSQL/cache/search
   fixtures, then `npm run e2e`. Keep them sequential because they share
   disposable fixtures. Run authored sample typechecks from a clean checkout,
   production/package checks, and site/Storybook checks when those change.
3. Read `npm pack --dry-run` output. Only the package allowlist ships: `dist`,
   `schema`, README, LICENSE and package metadata. Never include runtime
   credentials, private databases, maintainer notes or development fixtures.
4. Open the release PR and wait for CI: all test/browser shards, installed
   package checks, container startup and desktop staging must pass. Keep the
   working branch as one amended commit; check remote state before a leased
   force push. Merge only the reviewed, passing revision.

## Publish the merged release

Tag the merged commit on `main` as `v<version>`, matching `package.json` and the
release changelog entry, then push that tag. Publication requires explicit
maintainer authorization. Never move a published release tag or attempt to
reuse an npm version.

- `release.yml` checks the version and tarball, reruns live tests and browser
  tests, publishes npm, then builds and pushes the container image. Full releases
  update `latest`; prereleases leave the container's `latest` tag unchanged.
- npm uses the trusted publisher configured for this repository and workflow.
  The workflow authenticates through GitHub OIDC; it does not require copying
  a local npm token into repository secrets.
- `desktop-release.yml` builds Windows, Linux and universal macOS installers and
  attaches them to the GitHub release. macOS uses the configured Developer ID
  certificate and notarization credentials. Windows and Linux are unsigned.
- Wait for every desktop upload before setting the final release notes, because
  those upload steps also write the release body.

See the workflow files for the exact prerequisites and ordering. An installer
appearing on GitHub does not establish that npm or container publication finished.

## Verify what users receive

A successful npm publish can precede public package availability while npm
processes the upload. Check the publish log and poll the registry with a bounded
wait; do not rerun publication merely because an immediate lookup returns 404.
If processing does not finish, record the unresolved availability and investigate
it rather than reporting a completed npm release.

After the version is visible:

- Verify the exact npm version and, for a full release, the `latest` dist-tag.
  Install the public package in a fresh directory outside the source checkout.
  Check `--version`, server startup, the first-run page and its client assets.
- Verify the public container version and `latest` manifests have the expected
  digest. A successful authenticated push does not prove anonymous pulls work.
- Verify the GitHub release tag and all expected installer assets. Confirm
  macOS signing/notarization from the build result; keep unsigned Windows
  instructions accurate.
- Link the final release notes to the shipped behavior and state any actual
  remaining limitations. Preserve an evidence record in private maintainer notes.

## Deploy the documentation site

The Cloudflare Pages project is `mistri` (`--project-name mistri`, as `.github/workflows/site.yml`
passes it); its production branch is `main`. The workflow is the truth where
this page and it disagree. The site's address is a custom domain on the project
(the domain's DNS is held at Cloudflare), and the project's own `mistri.pages.dev`
answers too.

The `site.yml` workflow runs on relevant pushes to `main` (and by hand). It
installs both `npm ci` trees (the root and `storybook/`), runs `npm run
build:site`, refuses a `site/dist` without `components/index.html` and
`components/iframe.html`, and deploys with `wrangler pages deploy site/dist
--project-name mistri --branch <the ref's name>` only when both
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets are
configured. A green workflow may therefore mean **built but not deployed**;
check the deployment step and public content.

An authenticated local Wrangler session is a supported fallback after deployment
is authorized. Build from the intended release revision, then run:

```sh
npm ci --prefix storybook
npm run build:site
test -f site/dist/components/index.html
npm run test:site:browser
npx wrangler@4 whoami
npx wrangler@4 pages deploy site/dist --project-name mistri --branch main
```

Upload only the built `site/dist` directory. Verify the resulting deployment is
Production and that the public homepage and changed guides serve the new build.
Local OAuth credentials stay local; do not copy them into GitHub secrets. A
future CI token should be provisioned specifically for its deployment role.

The component library at `/components/` is Storybook, a separate package with
its own `node_modules`. `npm run build:site` builds it **after** the
documentation site, into `site/dist/components`, so a checkout without
`npm ci --prefix storybook` fails there with the documentation already written:
deploying that `site/dist` would publish the site without its library. The
`test -f` above refuses that. Keep review fixtures synthetic and verify the
deployed `/components/` independently of the documentation pages.
