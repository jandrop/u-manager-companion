#!/bin/bash
# U-Manager Companion: GraphQL service supervisor.
#
# Runs the standalone same-origin GraphQL service and keeps it alive: a
# detached `while true` respawn loop with capped exponential backoff,
# mirroring the supervision model apply.sh already uses for watcher.sh
# (setsid + pgrep spawn-guard), but for the new service process instead of
# the legacy bundle watcher.
#
# There is no systemd on Unraid, so this loop IS the process supervisor: on
# every service exit (crash, killed, or a normal return) it waits a backoff
# interval, then starts the service again. Backoff resets to the floor once
# a respawned instance stays up past BACKOFF_RESET_SECONDS, so a single bad
# restart doesn't permanently slow down recovery from a later, unrelated
# crash.
#
# PID file: /var/run/<name>-service.pid. /var/run is tmpfs (RAM-backed) on
# Unraid, so this file does NOT survive a reboot -- by construction, an
# absent PID file at boot is expected and not an error. No reboot-specific
# stale-PID handling is needed here for that reason.
#
# Invoked detached (setsid ... &) by the .plg install block, exactly like
# watcher.sh is today.

set -u

LOG_TAG="u-manager-companion-service"
PID_FILE="/var/run/u-manager-companion-service.pid"

# Backoff schedule: 1s -> 2s -> 4s -> 8s -> 16s -> 30s (capped). Doubles on
# every consecutive fast-fail, capped so a persistently crashing service
# still gets retried roughly every 30s instead of the loop going quiet.
INITIAL_BACKOFF_SECONDS=1
MAX_BACKOFF_SECONDS=30

# If the service stays up at least this long, treat the NEXT exit as a fresh
# failure and reset backoff to the floor -- a service that ran fine for an
# hour and then crashed once shouldn't inherit a 30s backoff from an
# unrelated earlier crash loop.
BACKOFF_RESET_SECONDS=60

# --------------------------------------------------------------------------
# Run command -- kept as a single clearly-marked variable so it can later be
# swapped for a self-contained SEA binary (the hardening path) without
# touching the respawn/backoff logic below.
#
# v1 runs the esbuild-bundled CJS entry (service/dist/bundle.cjs) via the
# box's own Node (v22.18.0 at /usr/local/bin/node). This is acceptable for
# v1 specifically because during the dual-mode window unraid-api -- which
# ships its own Node runtime -- is always present on any box this plugin
# targets; the service does not need to be self-contained until the legacy
# patch pipeline (and therefore the guaranteed-present Node runtime) is
# retired.
# --------------------------------------------------------------------------
RUN_DIR="/usr/local/emhttp/plugins/u-manager-companion/service"
SERVICE_CMD=(/usr/local/bin/node "$RUN_DIR/bundle.cjs")

log() { logger -t "$LOG_TAG" "$*"; }

# Record our own PID so the install/remove scripts can stop this exact
# supervisor instance without relying on `pkill -f` alone (kept as a
# belt-and-suspenders identifier -- pkill -f against the script path is still
# the primary stop mechanism used by install/remove, matching watcher.sh's
# existing convention).
echo $$ >"$PID_FILE"

log "supervisor started (pid $$), run command: ${SERVICE_CMD[*]}"

backoff=$INITIAL_BACKOFF_SECONDS

while true; do
    start_ts=$(date +%s)

    log "starting service: ${SERVICE_CMD[*]}"
    "${SERVICE_CMD[@]}" 2>&1 | logger -t "$LOG_TAG"
    # PIPESTATUS[0] is the service process's own exit code, not logger's.
    exit_code=${PIPESTATUS[0]}

    end_ts=$(date +%s)
    uptime_seconds=$((end_ts - start_ts))

    log "service exited (code $exit_code) after ${uptime_seconds}s, respawning in ${backoff}s"

    if [ "$uptime_seconds" -ge "$BACKOFF_RESET_SECONDS" ]; then
        # Ran long enough to be considered a fresh failure -- reset backoff.
        backoff=$INITIAL_BACKOFF_SECONDS
    else
        # Fast-fail: double the backoff, capped.
        backoff=$((backoff * 2))
        if [ "$backoff" -gt "$MAX_BACKOFF_SECONDS" ]; then
            backoff=$MAX_BACKOFF_SECONDS
        fi
    fi

    sleep "$backoff"
done
