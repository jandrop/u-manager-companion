"""Docker resolver patches.

* `docker-stats`: removes the old dockerode override we used to inject.
  Upstream fixed the frozen counters, and the override now breaks the
  subscription outright, so this only cleans up already-patched bundles.
* `docker-logs`: capture both stdout and stderr from `docker logs`.
* `docker-refresh`: refresh the update-status cache after an
  `updateContainer` mutation so the badge clears immediately.
"""
from __future__ import annotations

import os

from companion._bundle import find_bundle
from companion._runtime import log

DOCKER_STATS_MARKER = "/* u-manager-companion: docker-stats override */"
# Closing line of the injected IIFE. Unique inside the block: every other
# nested call there closes with `});` or `}).catch(...)`.
DOCKER_STATS_END = "\n})();\n"

def remove_docker_stats_override() -> bool:
    """Strip the old dockerode override out of an already-patched bundle.

    We used to replace `DockerStatsService.prototype.startStatsStream` so
    the stats subscription streamed from the Docker socket instead of the
    `docker stats` CLI, because upstream froze `NetIO`/`BlockIO` at
    `0B / 0B` (unraid/api #2007 and #2008).

    Those are fixed upstream. On 4.37.1 the native CLI source reports live
    counters again, and the override is now actively harmful: its
    `await docker.listContainers()` never resolves against the shared
    dockerode singleton the rest of the API uses, so no stats stream is
    ever opened and `dockerContainerStats` emits nothing at all. Every
    failure path inside it is swallowed, so the only trace is a
    "Starting docker stats stream" line that logs before the hang.

    Patches are applied in place with no pristine copy to fall back on, so
    dropping the injection alone would leave every already-patched server
    broken until its next unraid-api upgrade. This removes the block
    instead, and is a no-op on a clean bundle.
    """
    bundle = find_bundle()
    if not bundle:
        log("docker-stats cleanup: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    start = content.find(DOCKER_STATS_MARKER)
    if start == -1:
        return False
    end = content.find(DOCKER_STATS_END, start)
    if end == -1:
        log("docker-stats cleanup: override tail not found, leaving bundle untouched")
        return False
    # The overlay was inserted as "\n" + marker + ... + DOCKER_STATS_END, so
    # take the leading newline with it and the bundle returns to its original
    # bytes rather than accumulating blank lines on every boot.
    if start > 0 and content[start - 1] == "\n":
        start -= 1
    content = content[:start] + content[end + len(DOCKER_STATS_END):]
    with open(bundle, "w") as f:
        f.write(content)
    log(f"removed obsolete Docker stats override ({os.path.basename(bundle)})")
    return True

DOCKER_LOGS_OLD = (
    "const { stdout } = await execa('docker', args);\n"
    "            const lines = this.parseDockerLogOutput(stdout);"
)
DOCKER_LOGS_NEW = (
    "const { all } = await execa('docker', args, { all: true });\n"
    "            const lines = this.parseDockerLogOutput(all);"
)


def patch_docker_logs_bundle() -> bool:
    """Capture both stdout and stderr in DockerLogService.getContainerLogs().

    The upstream resolver shells out to `docker logs --timestamps --tail N
    <id>` via execa and only reads `.stdout`. Containers that write to
    stderr (most Python apps, Caddy, AdGuard, ...) return an empty array.

    Switching to execa's `{ all: true }` mode merges both streams into
    `.all` while keeping the per-line `--timestamps` prefix, so the
    existing parser and cursor logic work unchanged.
    """
    bundle = find_bundle()
    if not bundle:
        log("docker-logs patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if DOCKER_LOGS_NEW in content:
        return False
    if DOCKER_LOGS_OLD not in content:
        log("docker-logs patch: original getContainerLogs shape not found")
        return False
    content = content.replace(DOCKER_LOGS_OLD, DOCKER_LOGS_NEW, 1)
    with open(bundle, "w") as f:
        f.write(content)
    log(f"fixed Docker logs missing stderr output ({os.path.basename(bundle)})")
    return True


DOCKER_REFRESH_OLD = (
    "        } catch (error) {\n"
    "            this.logger.error(`Failed to update container ${containerName}:`, error);\n"
    "            throw new Error(`Failed to update container ${containerName}`);\n"
    "        }\n"
    "        const updatedContainers = await this.getContainers();"
)
DOCKER_REFRESH_NEW = (
    "        } catch (error) {\n"
    "            this.logger.error(`Failed to update container ${containerName}:`, error);\n"
    "            throw new Error(`Failed to update container ${containerName}`);\n"
    "        }\n"
    "        /* u-manager-companion: refresh-digests-post-update */\n"
    "        try {\n"
    "            await this.dockerManifestService.refreshDigests();\n"
    "        } catch (error) {\n"
    "            this.logger.warn(`Failed to refresh digests after updating ${containerName}: ${error instanceof Error ? error.message : String(error)}`);\n"
    "        }\n"
    "        const updatedContainers = await this.getContainers();"
)


def patch_docker_refresh_bundle() -> bool:
    """Refresh the docker update-status cache after `updateContainer` returns.

    The official `update_container` script writes the cache inline via
    `setUpdateStatus()` when Docker emits a top-level "Digest:" event during
    the pull stream. That event isn't guaranteed for every pull — when the
    registry returns the digest under a per-layer `id` instead of a clean
    top-level summary line, the cache keeps the pre-update `local` digest.

    The result is a freshly-updated container that the app's
    `containerUpdateStatuses` query keeps reporting as UPDATE_AVAILABLE
    until the user manually clicks "Check for updates" in the web UI
    (which calls `DockerTemplates->getAllInfo(true)` → `reloadUpdateStatus`).

    This patch makes `DockerService.updateContainer` call
    `dockerManifestService.refreshDigests()` after the script finishes, so
    the cache is repopulated with fresh local/remote digests in the same
    flow that already happens on "Check for updates". Wrapped in
    try/catch so a refresh failure (offline registry, slow remote) never
    breaks the mutation itself.

    Tracked upstream: PR pending on the unraid-api fork
    (`fix/docker-update-refresh-digests`).
    """
    bundle = find_bundle()
    if not bundle:
        log("docker-refresh patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if "/* u-manager-companion: refresh-digests-post-update */" in content:
        return False
    if DOCKER_REFRESH_OLD not in content:
        log("docker-refresh patch: updateContainer shape not found")
        return False
    content = content.replace(DOCKER_REFRESH_OLD, DOCKER_REFRESH_NEW, 1)
    with open(bundle, "w") as f:
        f.write(content)
    log(f"fixed Docker list refresh after image update ({os.path.basename(bundle)})")
    return True


def apply() -> bool:
    return any([
        remove_docker_stats_override(),
        patch_docker_logs_bundle(),
        patch_docker_refresh_bundle(),
    ])
