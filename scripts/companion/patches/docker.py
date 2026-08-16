"""Docker resolver patches.

* `docker-stats`: strip the old dockerode override from patched bundles.
* `docker-stats-ansi`: widen the ANSI strip so cursor-home stops corrupting
  the first container id.
* `docker-logs`: capture stderr as well as stdout from `docker logs`.
* `docker-refresh`: refresh the update-status cache after `updateContainer`.
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

    Upstream fixed the frozen counters (unraid/api #2007, #2008). On 4.37.1
    the override is harmful: its `listContainers()` never resolves against
    the API's shared dockerode singleton, so the subscription emits nothing.

    Removes the block rather than just dropping the injection: patches apply
    in place, so already-patched servers would stay broken otherwise.
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

DOCKER_ANSI_OLD = r"line.replace(/\x1B\[[0-9;]*[mK]/g, '')"
DOCKER_ANSI_NEW = r"line.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')"


def patch_docker_stats_ansi_bundle() -> bool:
    """Strip every CSI escape in `DockerStatsService.processStatsLine`.

    Upstream's `/\\x1B\\[[0-9;]*[mK]/g` covers only SGR and erase-line, but
    each refresh frame opens with erase-display plus cursor-home, so the
    first row arrives as `ESC[J ESC[H <containerId>;...`. Those bytes
    survive into the parsed id and no client can match it: measured 49 of
    1078 events polluted, 21 clean ids for 22 containers.

    `[a-zA-Z]` covers the whole CSI family; `?` allows the private
    `ESC[?25l` cursor toggles.
    """
    bundle = find_bundle()
    if not bundle:
        log("docker-stats-ansi patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if DOCKER_ANSI_NEW in content:
        return False
    if DOCKER_ANSI_OLD not in content:
        log("docker-stats-ansi patch: original processStatsLine shape not found")
        return False
    content = content.replace(DOCKER_ANSI_OLD, DOCKER_ANSI_NEW, 1)
    with open(bundle, "w") as f:
        f.write(content)
    log(f"fixed Docker stats ID corrupted by ANSI escapes ({os.path.basename(bundle)})")
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

    `update_container` only writes the cache when Docker emits a top-level
    "Digest:" line, which some registries never send. The container then
    keeps reporting UPDATE_AVAILABLE until the user hits "Check for updates".

    Calls `refreshDigests()` after the script finishes, wrapped in try/catch
    so an offline registry never breaks the mutation itself.

    Tracked upstream: `fix/docker-update-refresh-digests`.
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
        patch_docker_stats_ansi_bundle(),
        patch_docker_logs_bundle(),
        patch_docker_refresh_bundle(),
    ])
