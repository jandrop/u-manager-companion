#!/bin/bash
# U-Manager Companion: patch orchestrator
#
# Runs on every plugin install, which Unraid invokes on every boot. Waits for
# the unraid-api to be installed in /usr/local/unraid-api (it may not exist on
# clean boots until emhttp has populated it), then applies the patches.

set -u

LOG_PREFIX="[u-manager-companion]"
PATCH_SCRIPT="/boot/config/plugins/u-manager-companion/patch.py"
TIMEOUT=60

log() { echo "$LOG_PREFIX $*"; }

if [ ! -f "$PATCH_SCRIPT" ]; then
    log "patch script missing at $PATCH_SCRIPT, aborting"
    exit 1
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
python3 "$PATCH_SCRIPT"
log "done"
