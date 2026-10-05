#!/bin/bash
# U-Manager Companion: patch orchestrator
#
# Runs on every plugin install, which Unraid invokes on every boot. Waits for
# the unraid-api to be installed in /usr/local/unraid-api (it may not exist on
# clean boots until emhttp has populated it), then applies the patches and
# spawns a watcher daemon that re-applies them whenever the bundle is replaced
# (e.g. when Unraid Connect drops its own copy).
#
# Passing --no-watcher skips the watcher spawn; the watcher itself uses this
# when it re-invokes apply.sh after detecting a bundle change.

set -u

LOG_PREFIX="[u-manager-companion]"
PLUGIN_DIR="/boot/config/plugins/u-manager-companion"
PATCH_SCRIPT="$PLUGIN_DIR/patch.py"
WATCHER_SCRIPT="$PLUGIN_DIR/watcher.sh"
TIMEOUT=60

# Unraid 7.x stock does NOT include python3 in its base squashfs (it ships
# only when NerdTools, cache-mover or a similar plugin drags it in via
# /boot/extra/). We depend on python3 to run patch.py, so install it from a
# Slackware .txz pinned by SHA256 if the user's box doesn't already have it.
PYTHON_TXZ="/boot/extra/python3-3.12.10-x86_64-1.txz"
PYTHON_TXZ_URL="https://github.com/jandrop/u-manager-companion/releases/download/python-deps/python3-3.12.10-x86_64-1.txz"
PYTHON_TXZ_SHA256="89e997ce4821a4cc330ff147f3bddc4391057076b12b3acccc53066a5f60adcf"

log() { echo "$LOG_PREFIX $*"; }

if [ ! -f "$PATCH_SCRIPT" ]; then
    log "patch script missing at $PATCH_SCRIPT, aborting"
    exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
    log "python3 not found on this Unraid (stock 7.x doesn't ship it)"
    log "installing python3 from $PYTHON_TXZ_URL"
    # Verified before it reaches /boot/extra: Unraid installs anything there
    # as root on every boot.
    PYTHON_TXZ_TMP="$(mktemp /tmp/u-manager-companion-python.XXXXXX)"
    if ! wget -q -O "$PYTHON_TXZ_TMP" "$PYTHON_TXZ_URL"; then
        log "ERROR: failed to download python3 .txz from $PYTHON_TXZ_URL"
        rm -f "$PYTHON_TXZ_TMP"
        exit 1
    fi
    if ! echo "$PYTHON_TXZ_SHA256  $PYTHON_TXZ_TMP" | sha256sum -c --status; then
        log "ERROR: python3 .txz does not match the pinned SHA256, not installing it"
        rm -f "$PYTHON_TXZ_TMP"
        exit 1
    fi
    mkdir -p /boot/extra
    if ! mv "$PYTHON_TXZ_TMP" "$PYTHON_TXZ"; then
        log "ERROR: could not move python3 .txz to $PYTHON_TXZ"
        rm -f "$PYTHON_TXZ_TMP"
        exit 1
    fi
    if ! installpkg "$PYTHON_TXZ" >/dev/null; then
        log "ERROR: installpkg failed for $PYTHON_TXZ"
        exit 1
    fi
    if ! command -v python3 >/dev/null 2>&1; then
        log "ERROR: python3 still not on PATH after installpkg"
        exit 1
    fi
    log "python3 installed and persisted to /boot/extra (auto-loads on next boot)"
fi

# Wait up to TIMEOUT seconds for the unraid-api bundle to appear
log "waiting for unraid-api bundle..."
i=0
while [ $i -lt $TIMEOUT ]; do
    if ls /usr/local/unraid-api/dist/assets/plugin.module-*.js >/dev/null 2>&1; then
        break
    fi
    sleep 1
    i=$((i + 1))
done

if ! ls /usr/local/unraid-api/dist/assets/plugin.module-*.js >/dev/null 2>&1; then
    log "unraid-api bundle not found after ${TIMEOUT}s, skipping (will retry next boot)"
    exit 0
fi

log "applying patches..."
if ! python3 "$PATCH_SCRIPT"; then
    log "ERROR: patch.py failed (exit $?), aborting"
    exit 1
fi

# Start (or restart) the watcher daemon, unless we were invoked by the
# watcher itself (which would create an infinite spawn chain).
if [ "${1:-}" != "--no-watcher" ] && [ -f "$WATCHER_SCRIPT" ]; then
    if ! pgrep -f "$WATCHER_SCRIPT" >/dev/null 2>&1; then
        log "starting bundle watcher daemon"
        setsid bash "$WATCHER_SCRIPT" </dev/null >/dev/null 2>&1 &
    fi
fi

log "done"
