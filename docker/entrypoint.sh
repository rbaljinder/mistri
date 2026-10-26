#!/bin/sh
#
# Turn environment into a command line.
#
# That is the whole job. The image knows nothing about any database: every
# connection, view and layout is read at start from files the operator mounted,
# so changing what tablewalk browses is editing a file on the host and
# restarting the container, never rebuilding the image.
#
# The server's own flags remain the interface. This exists only because a
# compose file sets environment variables and cannot easily rewrite CMD. Each
# variable maps to exactly one flag, and anything passed to `docker run` after
# the image name is appended verbatim — so `docker run … --schema public` works
# without this script having heard of --schema.
set -eu

CONFIG_HOME="${XDG_CONFIG_HOME:-/config}"

set -- --host "${TABLEWALK_HOST:-0.0.0.0}" --port "${TABLEWALK_PORT:-${PORT:-4111}}" "$@"

# An explicit TABLEWALK_CONFIG wins; otherwise the conventional mount point is
# used when something is actually mounted there. Passing neither is a supported
# way to run this and not a mistake: the server then does its own search, which
# includes $XDG_CONFIG_HOME/tablewalk/connections.json, and `--db` or
# DATABASE_URL alone is a perfectly good single-database setup.
#
# Naming the file explicitly rather than relying on the search matters for the
# error: `--config` makes a missing file fatal and says which path was missing,
# where the search would quietly find nothing and print the usage text instead.
if [ -n "${TABLEWALK_CONFIG:-}" ]; then
  set -- --config "${TABLEWALK_CONFIG}" "$@"
elif [ -f "$CONFIG_HOME/tablewalk.json" ]; then
  set -- --config "$CONFIG_HOME/tablewalk.json" "$@"
fi

# exec so node replaces this shell. tini signals its own child; a shell left in
# the middle would absorb SIGTERM, and `docker stop` would time out and kill
# the server without it ever closing a connection.
exec node /app/node_modules/tablewalk/dist/server/index.js "$@"
