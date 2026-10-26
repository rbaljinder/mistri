#!/bin/sh
#
# Serve one sample App from its build, with its data seeded on first boot.
# The entrypoint of examples/docker/Dockerfile, for every service in
# docker-compose.yml:
#
#   start.sh <tick> [extra server flags]
#
# In the image the builds are /app/builds, and the first boot's data is a
# template the builder stage seeded at /config — the path the volume is
# mounted at, because a config names its database by absolute path — copied
# into the volume once. A source checkout has no templates: MISTRI_ROOT,
# MISTRI_BUILDS and MISTRI_DATA point this at the checkout, its builds
# and a data directory, and it seeds in place, as the samples' READMEs do.
# That is how the same file is proved without a daemon (README,
# "Running the same thing without Docker"). The server flags are the ones
# the root image's entrypoint passes to its server.
set -eu

APP="${1:?usage: start.sh <tick> [server flags]}"
shift

ROOT="${MISTRI_ROOT:-/app}"
BUILDS="${MISTRI_BUILDS:-$ROOT/builds}"
TEMPLATES="$ROOT/templates"
# The image creates /config for the `node` user, so a named volume mounted
# there is writable without a chown step. That is why the data lives in the
# config directory rather than a /data of its own.
DATA="${MISTRI_DATA:-${XDG_CONFIG_HOME:-/config}}"

if [ -f "$TEMPLATES/$APP.config" ]; then
  CONFIG="$(cat "$TEMPLATES/$APP.config")"
  # The config's existence is what makes a restart a skip: the volume keeps
  # its data, and copying the template over it would throw that away.
  [ -e "$CONFIG" ] || cp -R "$TEMPLATES/$APP/." "$DATA/"
else
  CONFIG="$(node "$ROOT/examples/docker/seed.mjs" "$APP" "$DATA")"
fi

# exec, so tini signals node directly and `docker stop` closes the database
# instead of timing out on a shell that swallowed SIGTERM.
exec node "$ROOT/node_modules/@mistriwork/mistri/dist/server/index.js" \
  --host "${MISTRI_HOST:-0.0.0.0}" \
  --port "${MISTRI_PORT:-4111}" \
  --config "$CONFIG" \
  --app "$BUILDS/$APP" \
  "$@"
