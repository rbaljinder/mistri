#!/usr/bin/env bash
# One soak run on a disposable PostgreSQL 16 + Compass (writable). Cleans up on any exit.
#   scripts/soak/run.sh [out-dir]
# Driver: k6 (default; scripts/soak/k6/mixed.js, mixed scenarios) or SOAK_DRIVER=node (load.mjs, API only).
# Env: SOAK_STAGES=60:150,180:150,60:0 (seconds:users, ramped; the default for k6)   SOAK_THINK_MS=40
#      node driver only: SOAK_WARMUP_S=60 SOAK_DURATION_S=540 SOAK_VUS=20 SOAK_SNAPSHOTS=60,300,600
#      SOAK_WRITE_POOL=<n>   the server's --write-pool        SOAK_BROWSERS=2  k6 browser users (0 off)
#      SOAK_DIAGNOSTICS=1    MISTRI_DIAGNOSTICS=1 on the server: per-request JSONL and pool wait/hold
#                            histograms in <out>/diagnostics.jsonl (costs a little throughput)
#      SOAK_PG_LOG_STATEMENTS=1   log_statement=all in <out>/postgres.log (for a short probe run)
#      SOAK_PROVISION_EPOCH=1   provision the Postgres schema epoch first (a write is then four round trips)
#      SOAK_PROFILE_OFF=1    no CPU or allocation profiles (they hold memory; use it for a leak verdict)
#      SOAK_SERVER_DIR=<checkout>   serve that checkout (examples, src, dist) instead of this one; harness scripts stay here
#      SOAK_BUILT=1          run the server BUILT (node packages/mistri/dist/server/index.js, no tsx or Vite dev middleware);
#                            the checkout must have been built (npm run build) first
#      SOAK_INSPECT=1        node --inspect=9229, to attach Chrome DevTools live
#      PGBIN=<dir with initdb/pg_ctl/createdb>   SOAK_LOCK=<lock file other jobs wait on>
#      SOAK_MIN_FREE_GB=4 SOAK_MIN_FREE_PCT=10 SOAK_MIN_START_GB=8
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
SRV="$(cd "${SOAK_SERVER_DIR:-$ROOT}" && pwd)"
OUT="${1:-$ROOT/soak-results/$(date +%Y%m%d-%H%M%S)}"
PGBIN="${PGBIN:-$(dirname "$(command -v pg_ctl || echo /usr/lib/postgresql/16/bin/pg_ctl)")}"
ulimit -n 10240 2>/dev/null || ulimit -n 4096 # hundreds of users hold a socket each, on both ends
DRIVER="${SOAK_DRIVER:-k6}"
WARMUP="${SOAK_WARMUP_S:-60}"; DURATION="${SOAK_DURATION_S:-540}"; VUS="${SOAK_VUS:-20}"
mkdir -p "$OUT"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/soak.XXXXXX")"
SERVER_PID=""; PG_UP=""; K6_PID=""; MON_PID=""; LOCK_MINE=""
cleanup() {
  [ -n "$K6_PID" ] && kill "$K6_PID" 2>/dev/null
  [ -n "$MON_PID" ] && kill "$MON_PID" 2>/dev/null
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null
  [ -n "$PG_UP" ] && "$PGBIN/pg_ctl" -D "$TMP/pg" -m fast stop >/dev/null 2>&1
  # Only a lock this run wrote: another job's lock is never removed from under it.
  [ -n "$LOCK_MINE" ] && [ -f "$SOAK_LOCK" ] && [ "$(cat "$SOAK_LOCK" 2>/dev/null)" = "$LOCK_MINE" ] && rm -f "$SOAK_LOCK"
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

# The heavy-job lock, taken atomically (noclobber: the redirect fails if the file exists) and held to the end.
# A lock held by a dead pid is stale and goes. Waits up to 30 minutes, polling every 30 s.
if [ -n "${SOAK_LOCK:-}" ]; then
  for _ in $(seq 0 60); do
    if ( set -C; echo "soak $$" > "$SOAK_LOCK" ) 2>/dev/null; then LOCK_MINE="soak $$"; break; fi
    holder=$(awk '{print $2}' "$SOAK_LOCK" 2>/dev/null)
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null && [ "$holder" != "$$" ]; then rm -f "$SOAK_LOCK"; continue; fi
    sleep 30
  done
  [ -n "$LOCK_MINE" ] || { echo "could not take $SOAK_LOCK in 30 minutes"; exit 2; }
fi
# Another suite on the machine spoils both runs.
if [ -z "${SOAK_ALLOW_BUSY:-}" ]; then
  for _ in $(seq 0 60); do pgrep -f 'vitest|test-node|playwright test|bin/c8|/c8/' >/dev/null || break; sleep 30; done
  pgrep -f 'vitest|test-node|playwright test|bin/c8|/c8/' >/dev/null && { echo "another suite is running; not starting"; exit 2; }
fi

# df -Pk is POSIX: kilobytes available in column 4, the same on macOS and Linux.
avail_gb=$(( $(df -Pk "$OUT" | awk 'NR==2{print $4}') / 1048576 ))
[ "$avail_gb" -ge "${SOAK_MIN_START_GB:-8}" ] || { echo "only ${avail_gb} GB free; need ${SOAK_MIN_START_GB:-8}"; exit 2; }

freeport() { node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})'; }
PGPORT=$(freeport); APPPORT=$(freeport)
"$PGBIN/initdb" -D "$TMP/pg" -U soak --auth=trust -E UTF8 >/dev/null || exit 1
PGOPTS="-p $PGPORT -c unix_socket_directories= -c listen_addresses=127.0.0.1 -c max_connections=200 -c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track=all"
[ "${SOAK_PG_LOG_STATEMENTS:-}" = 1 ] && PGOPTS="$PGOPTS -c log_statement=all -c log_line_prefix=%x/%p:"
"$PGBIN/pg_ctl" -D "$TMP/pg" -o "$PGOPTS" -l "$OUT/postgres.log" -w start >/dev/null || exit 1
PG_UP=1
"$PGBIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U soak compass
URL="postgres://soak@127.0.0.1:$PGPORT/compass"
node "$SRV/test/fixtures/databases/crm/make-crm-db.mjs" "$TMP/compass.db" >/dev/null
node "$SRV/test/fixtures/databases/crm/seed-postgres.mjs" "$URL" "$TMP/compass.db" >/dev/null || exit 1
echo "{\"connections\":[{\"name\":\"compass\",\"url\":\"$URL\",\"writable\":true}]}" > "$TMP/config.json"
# The schema epoch (docs/postgresql.md): explicit maintenance, so a database has it only when provisioned.
# Off by default, as every earlier run was, so numbers compare; SOAK_PROVISION_EPOCH=1 measures a provisioned one.
[ "${SOAK_PROVISION_EPOCH:-}" = 1 ] && { (cd "$SRV" && node --import tsx -e "const m = await import('./packages/mistri/src/server/maintenance.ts'); console.log(JSON.stringify(await m.provisionStores({ postgres: process.argv[1] }, { only: ['schema-epoch'] })))" "$URL" >> "$OUT/provision.log" 2>&1) || exit 1; }
# In its own schema, after the seed (which refuses a public schema that has anything in it).
"$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT" -U soak -d compass -qc 'create schema soak_ext; create extension pg_stat_statements schema soak_ext; select soak_ext.pg_stat_statements_reset()' >/dev/null || exit 1
[ "${SOAK_PG_LOG_STATEMENTS:-}" = 1 ] && : > "$OUT/postgres.log"

# --expose-gc lets the sampler collect before a heap snapshot; --enable-source-maps lets it name
# TypeScript lines in profiles. node, not npx, so the pid is the server's.
SERVER_ARGS=(--config "$TMP/config.json" --app "$SRV/test/fixtures/apps/crm" --port "$APPPORT")
[ -n "${SOAK_WRITE_POOL:-}" ] && SERVER_ARGS+=(--write-pool "$SOAK_WRITE_POOL")
NODE_ARGS=(--expose-gc --enable-source-maps)
[ "${SOAK_INSPECT:-}" = 1 ] && NODE_ARGS+=(--inspect=9229)
if [ "${SOAK_DIAGNOSTICS:-}" = 1 ]; then export MISTRI_DIAGNOSTICS=1; ERR="$OUT/diagnostics.jsonl"; else ERR="$OUT/server.log"; fi
if [ "${SOAK_BUILT:-}" = 1 ]; then
  BIN="$SRV/packages/mistri/dist/server/index.js"
  [ -f "$BIN" ] || { echo "SOAK_BUILT=1 but $BIN is missing; npm run build there first"; exit 2; }
  # The built packages import each other by name; a checkout's exports answer dist/ under this condition.
  SERVER_ENTRY=(--conditions=mistri-built "$BIN")
else
  SERVER_ENTRY=(--import tsx "$SRV/packages/mistri/src/server/index.ts")
fi
# cwd is the served checkout, so profile paths come out relative to it and the server finds its own files.
( cd "$SRV" && SOAK_OUT="$OUT" exec node "${NODE_ARGS[@]}" --import "$ROOT/scripts/soak/sampler.mjs" "${SERVER_ENTRY[@]}" \
  "${SERVER_ARGS[@]}" > "$OUT/server.log" 2>> "$ERR" ) &
# > "$OUT/server.log" 2>> "$ERR" &
SERVER_PID=$!
for _ in $(seq 1 120); do curl -sf "http://localhost:$APPPORT/api/runtime" >/dev/null && break; sleep 1; done
curl -sf "http://localhost:$APPPORT/api/runtime" >/dev/null || { echo "server did not start; see $OUT/server.log"; exit 1; }
# Touch the routes once so the first request of the run is not the one that loads them.
for p in / /leads /sales-dashboard; do curl -s -o /dev/null "http://localhost:$APPPORT$p"; done

if [ "$DRIVER" = node ]; then
  node scripts/soak/load.mjs --url "http://localhost:$APPPORT" --pg "$URL" --out "$OUT" --server-pid "$SERVER_PID" \
    --vus "$VUS" --warmup "$WARMUP" --duration "$DURATION" --snapshots "${SOAK_SNAPSHOTS:-60,300,600}" \
    ${SOAK_STAGES:+--stages "$SOAK_STAGES"} ${SOAK_THINK_MS:+--think "$SOAK_THINK_MS"} \
    --min-free-gb "${SOAK_MIN_FREE_GB:-4}" --min-free-pct "${SOAK_MIN_FREE_PCT:-10}"
  RC=$?
  if [ "${SOAK_DIAGNOSTICS:-}" = 1 ]; then kill -TERM "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""; node scripts/soak/pools.mjs "$OUT"; fi
  node scripts/soak/report.mjs "$OUT" --warmup "$WARMUP" || true
  exit $RC
fi

command -v k6 >/dev/null || { echo "k6 is not installed (brew install k6, or the k6 package from grafana.com/docs/k6/latest/set-up/install-k6/)"; exit 1; }
STAGES="${SOAK_STAGES:-60:150,180:150,60:0}"
# The k6 browser needs a Chromium; Playwright's is the one this repository already installs.
if [ -z "${K6_BROWSER_EXECUTABLE_PATH:-}" ]; then
  for root in "$HOME/Library/Caches/ms-playwright" "$HOME/.cache/ms-playwright"; do
    c=$(ls -d "$root"/chromium_headless_shell-*/*/chrome-headless-shell "$root"/chromium-*/chrome-linux/chrome 2>/dev/null | sort | tail -1)
    [ -n "$c" ] && export K6_BROWSER_EXECUTABLE_PATH="$c" && break
  done
fi
export K6_BROWSER_HEADLESS=true
START_MS=$(node -e 'console.log(Date.now() + 1500)') # k6's clock starts after its setup, a second or so in
echo "{\"t\":$START_MS,\"phase\":\"k6\",\"stages\":\"$STAGES\",\"writePool\":\"${SOAK_WRITE_POOL:-default}\"}" >> "$OUT/events.ndjson"
BASE_URL="http://localhost:$APPPORT" STAGES="$STAGES" THINK_API_MS="${SOAK_THINK_MS:-40}" BROWSERS="${SOAK_BROWSERS:-2}" \
  SUMMARY_FILE="$OUT/k6-summary.json" \
  K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_PORT=-1 K6_WEB_DASHBOARD_EXPORT="$OUT/k6-dashboard.html" \
  k6 run --quiet --out "json=$OUT/points.json.gz" scripts/soak/k6/mixed.js > "$OUT/k6.log" 2>&1 &
K6_PID=$!
node scripts/soak/monitor.mjs --pg "$URL" --out "$OUT" --server-pid "$SERVER_PID" --k6-pid "$K6_PID" --stages "$STAGES" --start "$START_MS" --cpu-window "${SOAK_CPU_WINDOW:-30}" ${SOAK_PROFILE_OFF:+--no-profile} \
  --min-free-gb "${SOAK_MIN_FREE_GB:-4}" --min-free-pct "${SOAK_MIN_FREE_PCT:-10}" > "$OUT/monitor.log" 2>&1 &
MON_PID=$!
wait "$K6_PID"; RC=$?; K6_PID=""
wait "$MON_PID" 2>/dev/null; MON_PID=""
kill -0 "$SERVER_PID" 2>/dev/null && echo "{\"t\":$(node -e 'console.log(Date.now())'),\"phase\":\"k6-done\"}" >> "$OUT/events.ndjson"
# Pool wait and hold histograms are cumulative in the server's last summary line; a clean shutdown writes it.
if [ "${SOAK_DIAGNOSTICS:-}" = 1 ]; then kill -TERM "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""; node scripts/soak/pools.mjs "$OUT"; fi
(cd "$SRV" && node "$ROOT/scripts/soak/profiles.mjs" "$OUT") || true
node scripts/soak/report-k6.mjs "$OUT" --stages "$STAGES" || true
exit $RC
