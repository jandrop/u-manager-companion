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
# Output: dist/companion-<VERSION>.tar.gz + printed SHA256 for the .plg.
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
    -cf - patch.py apply.sh watcher.sh companion \
  | gzip -n -9 > "../${OUT}"
cd ..

SHA=$(sha256sum "$OUT" | cut -d' ' -f1)
SIZE=$(wc -c < "$OUT" | tr -d ' ')

echo
echo "Tarball:  $OUT"
echo "Size:     $SIZE bytes"
echo "SHA256:   $SHA"
echo
echo "Paste into UManagerCompanion.plg:"
echo "  <SHA256>$SHA</SHA256>"
