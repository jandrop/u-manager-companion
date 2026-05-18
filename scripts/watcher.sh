#!/bin/bash
# U-Manager Companion: bundle watcher.
#
# Sits in the background waiting for the unraid-api bundle to change.
# Triggers on close_write (in-place overwrite — what `tar -xz` from a
# Slackware package does) plus moved_to/create (atomic rename — what
# safer installers do). Both shapes happen in the wild.
#
# patch.py's own writes ALSO fire close_write — so each real bundle
# replacement causes one extra no-op invocation of apply.sh after the
# patches are re-applied. That's fine because patch.py is idempotent
# (it bails on the second run with "no changes needed"), so the loop
# terminates in two iterations regardless of how many writes patch.py
# fires during the initial re-application.

set -u

BUNDLE_DIR="/usr/local/unraid-api/dist/assets"
APPLY_SH="/boot/config/plugins/u-manager-companion/apply.sh"
DEBOUNCE_SECONDS=3

# `logger` so the output ends up in syslog (this script runs detached
# from a terminal via setsid, so stdout would otherwise be discarded).
log() { logger -t u-manager-companion-watcher "$*"; }

log "watcher started, waiting for bundle replacements in $BUNDLE_DIR"

while true; do
    if [ ! -d "$BUNDLE_DIR" ]; then
        # Bundle directory doesn't exist yet (unraid-api still warming up).
        # Wait and retry instead of crashing the loop.
        sleep 10
        continue
    fi
    # Block until a new bundle file appears. -q silences inotifywait's own
    # output; we only care about the unblock.
    inotifywait -q -e close_write,moved_to,create "$BUNDLE_DIR" >/dev/null 2>&1 || {
        # If inotifywait exits with an error (e.g. dir vanished), back off.
        sleep 5
        continue
    }
    # Give the writer a moment to finish dropping the new bundle.
    sleep "$DEBOUNCE_SECONDS"
    log "bundle change detected, re-applying patches"
    bash "$APPLY_SH" --no-watcher 2>&1 | logger -t u-manager-companion-watcher
done
