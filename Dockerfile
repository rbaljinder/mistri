# syntax=docker/dockerfile:1
#
# tablewalk in a container.
#
# Two properties this file is built around, both of which keep the build's
# tools out of the image that runs:
#
#   - The client is built here, with the server, and served as it was built.
#     `npm run build` bundles it into each product's dist/client with Vite
#     (vite.tablewalk.config.ts, vite.mistri.config.ts):
#     minified, content-named, source maps beside it, and a brotli and a gzip
#     copy of every text file, so the runtime copies files and compresses
#     nothing per request.
#   - Only the server is TypeScript, and it is compiled here rather than run
#     through tsx at container start. tsx pulls in esbuild — tens of megabytes
#     of native toolchain — to do at every boot what one build can do once.
#
# The result is a runtime stage holding node and a node_modules laid out as
# `npm install tablewalk` leaves it: the four workspace packages' dist/ and
# their registry dependencies (pg among them). Nothing else.

# Node 24 is not a preference, it is a requirement: the SQLite adapter is
# `node:sqlite`, which needs an --experimental-sqlite flag before 23.4 and is
# only a supported built-in from 24. Pinned to an exact patch so a rebuild six
# months from now produces the image that was tested, not the one that is
# current. Bump it deliberately.
ARG NODE_IMAGE=node:24.22.1-alpine3.24

# ---------------------------------------------------------------------------
# Build: compile the server, then throw the compiler away.
# ---------------------------------------------------------------------------
# On the machine's own platform even for an arm64 image: what it produces (a
# pruned node_modules holding the packages' dist/) is plain JavaScript with no native add-on, so the
# runtime stage of either platform takes it as it is, and the compile runs at
# native speed instead of under emulation.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /src

# Manifests first, so editing a source file does not re-run the install. The
# lockfile is copied with it because `npm ci` refuses to run without one, which
# is the point of using ci over install. Each workspace package's manifest
# (scripts/boundary/entries.json) is copied with them, since `npm ci` links the
# workspaces and refuses to run without them; their sources come later.
COPY package.json package-lock.json ./
COPY packages/engine/package.json ./packages/engine/
COPY packages/ui/package.json ./packages/ui/
COPY packages/kit/package.json ./packages/kit/
COPY packages/mistri/package.json ./packages/mistri/
COPY packages/tablewalk/package.json ./packages/tablewalk/
COPY packages/create-mistri/package.json ./packages/create-mistri/
RUN npm ci --no-audit --no-fund

# Run the complete build: client, UI, Observer, embed and SSR bundles, then bundle and
# public-authoring type budgets using the same fixtures as the package build.
COPY tsconfig.json tsconfig.build.json tsconfig.commands.json vite.config.ts vite.tablewalk.config.ts vite.mistri.config.ts vite.ui.config.ts vite.observe.config.ts vite.embed.config.ts vite.ssr.config.ts ./
COPY scripts ./scripts
COPY test/fixtures/apps/crm ./test/fixtures/apps/crm
COPY test/fixtures/apps/ignition ./test/fixtures/apps/ignition
# The shipped reference (`tablewalk docs`, mistri's dist/docs) is the site's Markdown and
# its guide screenshots, copied into dist by package-docs.mjs during the build.
COPY site/src/content/docs/docs ./site/src/content/docs/docs
COPY site/src/assets/guide ./site/src/assets/guide
# What the tablewalk package carries (scripts/pack-manifest.mjs CARRIED): the
# agent skill `tablewalk agent init` installs and the sample Apps.
COPY skills ./skills
COPY examples ./examples
COPY packages ./packages
RUN npm run build

# tsx, typescript, vite and esbuild exist to build, and the client's libraries
# (React, Base UI, TanStack, Phosphor) are in the kit's dist/client bundle; all of them
# are devDependencies. Nothing imports them at runtime,
# and pruning here rather than reinstalling in the next stage keeps one
# lockfile-driven install for the whole file. `pg` survives: it is an optional
# dependency, not a dev one.
# The workspace links go too: they point into the source tree, which the
# runtime stage does not have. In their place each package is copied in as its
# tarball would unpack (scripts/install-packages.mjs), so the image runs the
# installed layout an `npm install tablewalk` has.
RUN npm prune --omit=dev \
 && rm -rf node_modules/tablewalk node_modules/create-mistri node_modules/@mistriwork \
 && node -e "import('./scripts/install-packages.mjs').then((m) => m.installPackages('/src/node_modules'))"

# The source maps ship in the npm package, for a person debugging an installed
# copy. An image is run, not debugged in place, and they were most of dist/'s
# bytes; a stack trace from one maps against the package of the same version.
RUN find node_modules/tablewalk node_modules/@mistriwork -name '*.map' -delete

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# tini is PID 1 so that signals and orphans are handled by something whose job
# that is. The server does install SIGINT/SIGTERM handlers, so Ctrl-C would
# work without this — but a PID 1 with no handler for a signal ignores it
# outright, and that failure mode ("docker stop takes ten seconds then kills
# it") is exactly the one people blame on the application.
RUN apk add --no-cache tini

ENV NODE_ENV=production

# Nothing about any database is in this image. Everything tablewalk browses is
# read at start from files mounted at /config, which means changing it is
# editing a file on the host and restarting — never a rebuild:
#
#   /config/tablewalk.json          connections and views  (connections.ts)
#   /config/tablewalk/layouts.json  record layouts         (layouts.ts)
#   /config/tablewalk/credentials.json   passwords, if you insist on a file
#
# One directory rather than three mount points, because the last two come from
# XDG_CONFIG_HOME, which both modules honour. The first is passed explicitly by
# the entrypoint and overridable with TABLEWALK_CONFIG.
ENV XDG_CONFIG_HOME=/config

# Loopback *inside the container* would mean nothing outside it could ever
# reach the server — the default that is right on a laptop is the one setting
# that cannot work here. The container is the boundary now, so the safety has
# to be re-established at the publish step instead: `-p 127.0.0.1:4111:4111`,
# never `-p 4111:4111`. DEPLOY.md says so in more words.
ENV TABLEWALK_HOST=0.0.0.0

WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY docker/entrypoint.sh /usr/local/bin/tablewalk-entrypoint

# The node image already ships an unprivileged `node` (uid 1000). /config is
# created and handed to it so that a *named volume* mounted there inherits the
# right owner; a bind mount keeps the host's ownership, which is why DEPLOY.md
# tells you to expect uid 1000. It stays empty in the image — an empty /config
# with no mount is a tablewalk with nothing to browse, which is the correct
# behaviour and says so on startup.
RUN chmod +x /usr/local/bin/tablewalk-entrypoint \
 && mkdir -p /config/tablewalk \
 && chown -R node:node /config
USER node

EXPOSE 4111

# Loopback on purpose: this runs inside the container, and pointing it at the
# published address would test the port mapping rather than the process. GET
# endpoints skip the cross-origin guard, so no Host games are needed. /healthz
# is liveness only (packages/engine/src/server/http/probes.ts): it answers before any gate and
# opens no database, so a slow or absent database never kills the container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TABLEWALK_PORT||process.env.PORT||4111)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/tablewalk-entrypoint"]
CMD []
