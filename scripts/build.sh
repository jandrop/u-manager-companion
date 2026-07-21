#!/bin/bash
# Build a deterministic distribution tarball for the companion package.
#
# The SHA256 the .plg declares must match the SHA256 of the asset
# served by the GitHub release; otherwise `plugin install` aborts on
# every user's machine. Determinism is enforced via:
#   --sort=name          (alphabetical order, not filesystem order)
#   --owner=0 --group=0  (no machine-specific user/group)
#   --numeric-owner      (don't resolve uid → name)
#   --mtime fixed        (no per-build timestamps)
#   gzip -n              (omit embedded mtime in gzip header)
#
# Output: dist/companion-<VERSION>.tar.gz (legacy patch payload +
# supervisor/cleanup scripts) + printed SHA256 for the .plg's tarball
# <FILE> entry.
#
# Also copies the standalone GraphQL service bundle (service/dist/bundle.cjs,
# built separately via `npm run build` inside service/) into dist/ under
# its own release-asset name and prints its SHA256, for the
# .plg's SECOND <FILE> entry (the service bundle is fetched to &plgdir;
# directly, NOT bundled inside the legacy tarball -- it has its own
# lifecycle: copied to the rootfs run dir on every boot, unlike the
# extract-once-per-install tarball payload).
#
# Usage: scripts/build.sh <version>
#   scripts/build.sh 2026.05.29.2

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    echo "Usage: $0 <version>"
    echo "Example: $0 2026.05.29.2"
    exit 1
fi

cd "$(dirname "$0")/.."

# Prefer GNU tar (`gtar` on macOS via brew, `tar` on Linux).
if command -v gtar >/dev/null 2>&1; then
    TAR=gtar
else
    TAR=tar
fi

if ! "$TAR" --help 2>&1 | grep -q -- '--sort'; then
    echo "ERROR: GNU tar required (your '$TAR' looks like bsdtar)."
    echo "On macOS: brew install gnu-tar"
    echo "build.sh will then prefer 'gtar' automatically."
    exit 1
fi

mkdir -p dist
OUT="dist/companion-${VERSION}.tar.gz"

cd scripts
"$TAR" \
    --sort=name \
    --owner=0 --group=0 --numeric-owner \
    --mtime='@1700000000' \
    --no-xattrs \
    --exclude='__pycache__' \
    --exclude='._*' \
    -cf - patch.py apply.sh watcher.sh service-supervisor.sh nginx-cleanup.sh companion \
  | gzip -n -9 > "../${OUT}"
cd ..

SHA=$(sha256sum "$OUT" | cut -d' ' -f1)
SIZE=$(wc -c < "$OUT" | tr -d ' ')

echo
echo "Tarball:  $OUT"
echo "Size:     $SIZE bytes"
echo "SHA256:   $SHA"
echo
echo "Paste into UManagerCompanion.plg's tarball <FILE> entry:"
echo "  <SHA256>$SHA</SHA256>"

# Service bundle asset (optional here -- only packaged if the service has
# already been built via `npm run build` inside service/). Not treated as a
# hard failure when absent, since build.sh is also used to package
# tarball-only releases before the service work exists on a given branch.
SERVICE_BUNDLE="service/dist/bundle.cjs"
if [ -f "$SERVICE_BUNDLE" ]; then
    SERVICE_OUT="dist/companion-service-${VERSION}.cjs"
    cp "$SERVICE_BUNDLE" "$SERVICE_OUT"
    SERVICE_SHA=$(sha256sum "$SERVICE_OUT" | cut -d' ' -f1)
    SERVICE_SIZE=$(wc -c < "$SERVICE_OUT" | tr -d ' ')

    echo
    echo "Service bundle:  $SERVICE_OUT"
    echo "Size:            $SERVICE_SIZE bytes"
    echo "SHA256:          $SERVICE_SHA"
    echo
    echo "Paste into UManagerCompanion.plg's service bundle <FILE> entry:"
    echo "  <SHA256>$SERVICE_SHA</SHA256>"
else
    echo
    echo "NOTE: $SERVICE_BUNDLE not found -- skipping service bundle packaging."
    echo "Run 'npm run build' inside service/ first if this release includes"
    echo "the standalone GraphQL service."
fi
