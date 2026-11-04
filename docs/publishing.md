# Publishing mistri

Releases use the checked-in GitHub Actions workflows. The six framework
packages (`@mistriwork/engine`, `@mistriwork/ui`, `@mistriwork/kit`,
`@mistriwork/mistri`, `create-mistri` and `@mistriwork/cloudflare`) share the
root `package.json` version. This repository publishes no container image and
no installer: the database browser, its image and its desktop installers are
released from their own repository (https://github.com/rbaljinder/tablewalk).

## Prepare and review

1. Bump the version with `node scripts/bump-version.mjs <version>` (for example
   `1.0.0-rc.16`). It sets the root and the six packages, the exact pins the
   packages hold on each other, the version lines in `packages/mistri/README.md`
   and the site's status page, `package-lock.json` (through `npm install
   --package-lock-only`), and the changelog, whose `## Unreleased` becomes
   `## <version>` with a fresh `## Unreleased` above it. `--check` verifies that
   everything agrees and changes nothing; `test/bump-version.test.ts` runs it on
   every `npm test`. `npm version` is not the way: it bumps the root alone.
2. Finish the release changelog and reconcile current-version statements in the
   README, getting-started guide, capabilities page and roadmap. Historical
   release sections keep their original versions.
3. Run the full local gates: `npm test` with live PostgreSQL/cache/search
   fixtures, then `npm run e2e`. Keep them sequential because they share
   disposable fixtures. Run authored sample typechecks from a clean checkout,
   production/package checks, and site/Storybook checks when those change.
4. Read `npm pack --dry-run` output. Only the package allowlist ships: `dist`,
   `schema`, README, LICENSE and package metadata. Never include runtime
   credentials, private databases, maintainer notes or development fixtures.
5. Open the release PR and wait for CI: all test/browser shards, installed
   package checks and the example App's image build must pass. Keep the
   working branch as one amended commit; check remote state before a leased
   force push. Merge only the reviewed, passing revision.

## Publish the merged release

Tag the merged commit on `main` as `v<version>`, matching `package.json` and the
release changelog entry, then push that tag. Publication requires explicit
maintainer authorization. Never move a published release tag or attempt to
reuse an npm version.

- `release.yml` checks that the tag matches every package's version and that
  the tarballs hold what they should, then requires a green `ci.yml` run on
  the tagged commit (`ci-green`): it re-runs no suite, so CI is where the live
  and browser tests prove the commit. Only then does it publish the six
  packages to npm in dependency order. Full releases update `latest`;
  prereleases publish under `next`.
- npm uses the trusted publisher configured for this repository and workflow.
  The workflow authenticates through GitHub OIDC; it does not require copying
  a local npm token into repository secrets.

See the workflow file for the exact prerequisites and ordering.

Publication is resumable. `scripts/publish-packages.mjs` publishes one package at
a time in dependency order and skips any `name@version` that `npm view` says is
already live, because `npm publish --workspaces` can stop after two of six and a
version is permanent. If the job fails partway, run it again (re-run the failed
job, or push nothing new): preflight warns about the packages already live and
the publish step finishes the rest. Preflight fails only when every package is
already live, or when the tag does not match the version. `--check` and
`--dry-run` show the plan without publishing anything.

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
- Verify the GitHub release tag.
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
