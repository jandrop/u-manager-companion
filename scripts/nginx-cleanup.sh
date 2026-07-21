#!/bin/bash
# U-Manager Companion: nginx include cleanup (belt-and-suspenders).
#
# The service itself already removes its nginx include + strips the
# appended `include <path>;` line from locations.conf + does a validated
# reload on a graceful shutdown (service/src/nginx/uninstall.ts,
# uninstallNginxIntegration()). This script is the BASH-side fallback the
# plugin's remove block calls in ADDITION to
# stopping the service -- in case the service was killed uncleanly (e.g. a
# hung process the supervisor couldn't stop gracefully) and never got to run
# its own cleanup path, this makes sure no orphaned `location` block is left
# proxying to a port nothing is listening on anymore.
#
# Pure bash + real nginx binary -- no Node/service process required, so it
# still works even if the service binary itself is gone or broken.
#
# Usage: nginx-cleanup.sh <include-path> <locations-conf-path> <nginx-binary>

set -u

LOG_TAG="u-manager-companion-nginx-cleanup"
log() { logger -t "$LOG_TAG" "$*"; }

INCLUDE_PATH="${1:-/boot/config/plugins/u-manager-companion/nginx/companion-graphql.conf}"
LOCATIONS_CONF_PATH="${2:-/etc/nginx/conf.d/locations.conf}"
NGINX_BIN="${3:-/usr/sbin/nginx}"

# 1. Remove our own include file, if present.
if [ -f "$INCLUDE_PATH" ]; then
    rm -f "$INCLUDE_PATH"
    log "removed include file $INCLUDE_PATH"
fi

# 2. Strip the single appended `include <path>;` line from locations.conf,
#    leaving every other line (including other plugins' includes) untouched.
if [ -f "$LOCATIONS_CONF_PATH" ]; then
    INCLUDE_LINE="include ${INCLUDE_PATH};"
    if grep -qF "$INCLUDE_LINE" "$LOCATIONS_CONF_PATH" 2>/dev/null; then
        # grep -v -F -x on the trimmed line would be ideal, but locations.conf
        # lines may carry leading whitespace/indentation -- match by trimmed
        # content per line instead of requiring an exact untrimmed match.
        TMP_FILE=$(mktemp "${LOCATIONS_CONF_PATH}.XXXXXX")
        awk -v line="$INCLUDE_LINE" '{ t=$0; sub(/^[ \t]+/, "", t); sub(/[ \t]+$/, "", t); if (t != line) print }' \
            "$LOCATIONS_CONF_PATH" >"$TMP_FILE"
        # Same-directory rename keeps this atomic (matches the service's own
        # atomic-write convention) instead of leaving locations.conf
        # partially written if this step is interrupted.
        mv "$TMP_FILE" "$LOCATIONS_CONF_PATH"
        log "stripped include line from $LOCATIONS_CONF_PATH"
    fi
fi

# 3. Validated reload: only reload if the (now companion-free) tree still
#    passes `nginx -t` -- never blindly reload, and never fail the uninstall
#    if nginx itself is unavailable for any reason (e.g. running inside a
#    sandboxed test harness).
if [ -x "$NGINX_BIN" ]; then
    if "$NGINX_BIN" -t >/dev/null 2>&1; then
        "$NGINX_BIN" -s reload >/dev/null 2>&1
        log "nginx config valid, reloaded"
    else
        log "WARNING: nginx -t failed after cleanup, skipping reload (webgui config left as-is)"
    fi
fi
