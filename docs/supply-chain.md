# Supply chain: scanning and triage

Dependencies are watched in two places and triaged by one rule.

- **Renovate** (`renovate.json`) opens a grouped pull request before 6 a.m. on
  Mondays: one for dev dependencies (never automerged), one for runtime
  minor and patch updates, one for GitHub Actions (pinned by digest). A major
  version of a runtime dependency is its own pull request. A security update
  is not held for Monday. Node and the Docker base image are chosen with the
  release, not by the bot.
- **`npm run audit:prod`** (`npm audit --omit=dev --audit-level=high`) runs as
  the `audit` job in CI. It reads the lockfile, so it covers what a user
  installs, not the build tools. A high or critical advisory fails the run.
  An OSV scanner would be a second source, but it needs a new action or
  dependency; it is not added.

## What blocks a release, what waits

| Finding | Where | Action |
| --- | --- | --- |
| High or critical, runtime dependency, reachable from the code we ship | `audit` job | Blocks a release. Upgrade, or pin with an `overrides` entry and say why in the changelog |
| High or critical, runtime dependency we do not reach (a code path we never call) | `audit` job | Still fails the job; the fix is the upgrade. If none exists, record the advisory id, the reason it is unreachable and a review date in the pull request that unblocks the release, never a silent ignore |
| Moderate, runtime | `npm audit` | Waits for the weekly Renovate pull request; fix in the next release |
| Any severity, dev or build-only | `npm audit` (full) | Waits for the weekly pull request; blocks a release only if it can reach the published packages or the image |
| The container image's base or its packages | The pinned `NODE_IMAGE` in the `Dockerfile` | No scan runs in CI; take the newer pinned base when one is announced, and treat a high or critical one as blocking |
| A malicious package, or a compromised maintainer | Anyone | Stop the release, rotate what the build could read, and publish an advisory |

Triage is weekly, with the Renovate pull requests. A finding that waits is
written in the changelog entry that ships with it only if a user can be
affected. Reports from outside go through `SECURITY.md`.

At the time of writing `npm audit --omit=dev` reports two moderate advisories
(`fflate`, through `satori`) and no high ones.
