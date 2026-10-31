# syntax=docker/dockerfile:1
#
# The compose sample, built for production: the image
# docker-compose.yml runs.
# Built from the repository root:
#
#   docker build -f examples/docker/Dockerfile -t mistri-samples:local .
#
# It is the root Dockerfile's builder stage with more in it. That stage
# builds the packages, runs `mistri build` for each App — typecheck,
# validation, bundle — and seeds each App's sample data into a template. The
# runtime stage ships node, the installed packages, their production
# dependencies, the builds and the seeded templates: no App's TypeScript, no
# seed script, no compiler. The servers start from the builds, which load no
# TypeScript and watch nothing, so a change to an App is
# `docker compose … up --build`.

# The same pin as the root Dockerfile, for the same reasons: node:sqlite
# needs 24, and an exact patch rebuilds into the image that was tested.
ARG NODE_IMAGE=node:24.22.1-alpine3.24

# ---------------------------------------------------------------------------
# Build: build the packages, build the Apps, seed their data.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /src

# The workspace's manifests first, so a source change keeps the install layer.
COPY package.json package-lock.json ./
COPY packages/engine/package.json ./packages/engine/
COPY packages/ui/package.json ./packages/ui/
COPY packages/kit/package.json ./packages/kit/
COPY packages/mistri/package.json ./packages/mistri/
COPY packages/tablewalk/package.json ./packages/tablewalk/
COPY packages/create-mistri/package.json ./packages/create-mistri/
RUN npm ci --no-audit --no-fund

# What `npm run build` reads, as the root Dockerfile copies it.
COPY tsconfig.json vite.config.ts ./
COPY config ./config
COPY scripts ./scripts
# Every package carries the repository's LICENSE (scripts/pack-manifest.mjs CARRIED), and the build lays the
# packages out as an install has them (scripts/install-packages.mjs) for its type budget.
COPY LICENSE ./
COPY test/fixtures/apps/crm ./test/fixtures/apps/crm
COPY test/fixtures/apps/ignition ./test/fixtures/apps/ignition
COPY site/src/content/docs/docs ./site/src/content/docs/docs
COPY site/src/assets/guide ./site/src/assets/guide
COPY skills ./skills
COPY examples ./examples
COPY packages ./packages
RUN npm run build

# Built by the mistri just built: the version the runtime ships, and the only
# one that serves them. `npm ci` installed TypeScript and Rolldown (Vite's
# bundler) as dev dependencies, so each build is typechecked and bundled.
# There is no database in this stage, so the builds stop at validation; each
# server attests its catalog, command journal and stores when it starts.
# A bundle's `@mistriwork/mistri/commands` is answered by the mistri serving it, wherever
# the build sits.
RUN for app in tick; do \
      node packages/mistri/dist/server/index.js build --app "examples/apps/$app" --out "builds/$app" || exit 1; \
    done

# The first boot's data, seeded here rather than in the running container, so
# the runtime ships no seed script and no sample's data depends on a network.
# Each is seeded at /config, the path its volume is mounted at, because a
# config names its database by absolute path; start.sh copies the template
# into the volume once.
COPY examples/databases ./examples/databases
COPY examples/docker/seed.mjs ./examples/docker/seed.mjs
RUN mkdir -p /templates \
 && for app in tick; do \
      mkdir -p /config \
      && node examples/docker/seed.mjs "$app" /config > "/templates/$app.config" \
      && mv /config "/templates/$app" || exit 1; \
    done

# typescript, vite and rolldown exist to build. Nothing at runtime imports
# them. `pg` and the auth backend survive: they are optional dependencies.
# The workspace's links become the packages as npm would install them, as in
# the root Dockerfile.
RUN npm prune --omit=dev \
 && rm -rf node_modules/tablewalk node_modules/create-mistri node_modules/@mistriwork \
 && node -e "import('./scripts/install-packages.mjs').then((m) => m.installPackages('/src/node_modules'))"
RUN find node_modules/tablewalk node_modules/@mistriwork -name '*.map' -delete

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# tini as PID 1, as in the root Dockerfile: signals reach node, and
# `docker stop` closes the databases instead of timing out.
RUN apk add --no-cache tini

ENV NODE_ENV=production
# The volume mounted here holds each App's database, its connection config
# and any layout saved from the UI.
ENV XDG_CONFIG_HOME=/config
# Loopback inside a container reaches nothing; the compose file publishes to
# the host's loopback instead (docs/deploy.md, "Bind broadly inside").
ENV MISTRI_HOST=0.0.0.0
ENV MISTRI_PORT=4111

WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/builds ./builds
# Owned by `node`, the unprivileged user that copies them into its volume on
# first boot; root-owned templates would not be readable there.
COPY --from=build --chown=node:node /templates ./templates
COPY examples/docker/start.sh ./start.sh

# /config is created for `node`, so a named volume mounted there inherits the
# right owner and needs no chown step.
RUN chmod +x ./start.sh \
 && mkdir -p /config/mistri \
 && chown -R node:node /config
USER node

EXPOSE 4111

# The App to serve is the command: `tick`.
ENTRYPOINT ["/sbin/tini", "--", "/app/start.sh"]
CMD ["tick"]
