#!/usr/bin/env bash
# Builds the linux-x64 Node SEA (Single Executable Application) binary for
# the companion service.
#
# Steps:
#   1. esbuild bundle (build/bundle.mjs) must have already produced
#      dist/bundle.cjs -- run `npm run build` first (this script does it for
#      you if missing).
#   2. Download a linux-x64 Node binary matching the box-verified runtime
#      (Node v22.18.0 on the reference box) to use as the SEA
#      injection target. This is NOT the host's own `node` binary on
#      non-linux hosts (e.g. this Mac) -- SEA injection targets whichever
#      binary you feed it, so cross-building the linux-x64 artifact from
#      darwin works as long as you inject into a linux-x64 Node copy.
#   3. Generate the SEA blob via `node --experimental-sea-config` and inject
#      it into the copied binary via postject.
#
# Darwin dev-machine caveat: the resulting binary targets linux-x64 and
# cannot be executed on this Mac. Full end-to-end SEA smoke testing (does the
# injected binary actually start and serve a request) is a task to run on
# the real Unraid box. What THIS script's local run can still verify on
# darwin: the download succeeds, postject injection completes without
# error, and the size-budget check can run against the resulting file even
# though it can't be executed here.
set -euo pipefail

SERVICE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SERVICE_ROOT"

# Must match the box-verified Node runtime and the esbuild
# --target pin in build/bundle.mjs (ESBUILD_NODE_TARGET).
NODE_TARGET_VERSION="${NODE_TARGET_VERSION:-22.18.0}"
NODE_TARGET_PLATFORM="linux-x64"
NODE_DIST_DIR="$SERVICE_ROOT/.node-dist"
NODE_TARBALL="node-v${NODE_TARGET_VERSION}-${NODE_TARGET_PLATFORM}.tar.xz"
NODE_DIST_URL="https://nodejs.org/dist/v${NODE_TARGET_VERSION}/${NODE_TARBALL}"
NODE_EXTRACT_DIR="$NODE_DIST_DIR/node-v${NODE_TARGET_VERSION}-${NODE_TARGET_PLATFORM}"

OUT_DIR="$SERVICE_ROOT/dist"
BUNDLE_FILE="$OUT_DIR/bundle.cjs"
SEA_BLOB="$OUT_DIR/sea-prep.blob"
SEA_BINARY="$OUT_DIR/u-manager-companion-service-${NODE_TARGET_PLATFORM}"

echo "==> [1/4] Ensuring esbuild bundle exists"
if [ ! -f "$BUNDLE_FILE" ]; then
  echo "    bundle.cjs missing, running npm run build first"
  npm run build
fi

echo "==> [2/4] Fetching linux-x64 Node v${NODE_TARGET_VERSION} (injection target)"
mkdir -p "$NODE_DIST_DIR"
if [ ! -f "$NODE_EXTRACT_DIR/bin/node" ]; then
  curl -fsSL "$NODE_DIST_URL" -o "$NODE_DIST_DIR/$NODE_TARBALL"
  tar -xJf "$NODE_DIST_DIR/$NODE_TARBALL" -C "$NODE_DIST_DIR"
else
  echo "    already downloaded, skipping fetch"
fi

echo "==> [3/4] Generating SEA blob"
if ! node --experimental-sea-config sea-config.json; then
  echo "" >&2
  echo "SEA blob generation failed. This step needs a Node build with" >&2
  echo "single_executable_application support compiled in -- verify with:" >&2
  echo "  node -p \"process.config.variables.single_executable_application\"" >&2
  echo "" >&2
  echo "Known gap on a darwin dev machine: some Homebrew Node builds" >&2
  echo "on macOS report this as false, even from an official nodejs.org" >&2
  echo "source tarball. This does NOT block local development -- the" >&2
  echo "blob-generation and injection steps are re-run for real on the" >&2
  echo "live Unraid box, where Node v22.18.0 is confirmed present." >&2
  echo "A linux container (e.g. node:22-bullseye) with SEA enabled is a" >&2
  echo "viable local workaround if you want to validate before then." >&2
  exit 1
fi

echo "==> [4/4] Injecting blob into linux-x64 Node binary via postject"
mkdir -p "$OUT_DIR"
cp "$NODE_EXTRACT_DIR/bin/node" "$SEA_BINARY"
chmod +w "$SEA_BINARY"

# macOS's codesign step (removing the signature before injection) only
# applies when the injection target is a darwin binary. Skip it here: the
# target is linux-x64, which carries no macOS code signature to strip.
npx postject "$SEA_BINARY" NODE_SEA_BLOB "$SEA_BLOB" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

echo "==> Done: $SEA_BINARY"
ls -lh "$SEA_BINARY"
