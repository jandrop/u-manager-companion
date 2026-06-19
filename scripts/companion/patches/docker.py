"""Docker resolver patches.

* `docker-stats`: switch the stats subscription from `docker stats CLI`
  (which freezes its `NetIO` sample for the whole invocation) to the
  Docker socket via dockerode.
* `docker-logs`: capture both stdout and stderr from `docker logs`.
* `docker-refresh`: refresh the update-status cache after an
  `updateContainer` mutation so the badge clears immediately.
"""
from __future__ import annotations

import os
import re

from companion._bundle import find_bundle
from companion._runtime import log

DOCKER_STATS_MARKER = "/* u-manager-companion: docker-stats override */"

def patch_docker_stats_bundle() -> bool:
    """Replace `DockerStatsService` runtime so it streams from the Docker
    socket (dockerode) instead of spawning the `docker stats` CLI.

    The CLI re-uses the same /containers/<id>/stats sample for the whole
    invocation window — cumulative counters like `NetIO` stay frozen
    between subscription emissions. The socket endpoint always returns
    a fresh kernel sample. Verified locally on 2026-05-16:
      docker stats        → frozen `40.1GB / 220GB`
      socket API stream   → rx +109 MB in 3s (36 MB/s) while torrent
                            downloads.

    Monkey-patches `DockerStatsService.prototype.startStatsStream` /
    `stopStatsStream` after the class has been decorated by NestJS, so
    the existing module registration and DI keep working. The injected
    code reuses `getDockerClient`, `pubsub` and `GRAPHQL_PUBSUB_CHANNEL`
    that are already in the module scope.

    Tracked upstream: PR pending on the unraid-api fork.
    """
    bundle = find_bundle()
    if not bundle:
        log("docker-stats patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if DOCKER_STATS_MARKER in content:
        return False

    anchor_re = re.compile(
        r"DockerStatsService = _ts_decorate\$[\w$]+\(\[\s*Injectable\(\)\s*\],\s*DockerStatsService\);"
    )
    match = anchor_re.search(content)
    if not match:
        log("docker-stats patch: anchor not found")
        return False

    overlay = "\n" + DOCKER_STATS_MARKER + "\n" + r"""
;(() => {
    const proto = DockerStatsService.prototype;
    function formatBytes(b) {
        if (b < 1024) return `${b}B`;
        if (b < 1048576) return `${(b/1024).toFixed(1)}KiB`;
        if (b < 1073741824) return `${(b/1048576).toFixed(1)}MiB`;
        if (b < 1099511627776) return `${(b/1073741824).toFixed(2)}GiB`;
        return `${(b/1099511627776).toFixed(2)}TiB`;
    }
    function cpuPct(d) {
        const cd = d.cpu_stats.cpu_usage.total_usage - d.precpu_stats.cpu_usage.total_usage;
        const sd = (d.cpu_stats.system_cpu_usage ?? 0) - (d.precpu_stats.system_cpu_usage ?? 0);
        const oc = d.cpu_stats.online_cpus ?? 1;
        if (sd <= 0 || cd < 0) return 0;
        return (cd / sd) * oc * 100;
    }
    function memUsed(d) {
        return Math.max(0, (d.memory_stats.usage ?? 0) - (d.memory_stats.stats?.cache ?? 0));
    }
    function sumNet(n) {
        let rx = 0, tx = 0;
        if (n) for (const v of Object.values(n)) { rx += v.rx_bytes ?? 0; tx += v.tx_bytes ?? 0; }
        return { rx, tx };
    }
    function sumBlk(es) {
        let r = 0, w = 0;
        if (es) for (const e of es) {
            if (e.op === 'Read' || e.op === 'read') r += e.value;
            else if (e.op === 'Write' || e.op === 'write') w += e.value;
        }
        return { r, w };
    }
    function destroyStream(s) {
        try { if (s && typeof s.destroy === 'function') s.destroy(); } catch (e) {}
    }

    proto.startStatsStream = async function patchedStart() {
        if (this._dockerodeActive) return;
        this._dockerodeActive = true;
        this._dockerodeStreams = new Map();
        this.logger.log('Starting docker stats stream (u-manager-companion: dockerode override)');
        const docker = getDockerClient();
        const openFor = (id) => {
            if (!this._dockerodeActive || this._dockerodeStreams.has(id)) return;
            docker.getContainer(id).stats({ stream: true }).then((stream) => {
                if (!this._dockerodeActive) { destroyStream(stream); return; }
                this._dockerodeStreams.set(id, stream);
                stream.on('data', (chunk) => {
                    try {
                        const d = JSON.parse(chunk.toString());
                        const usage = memUsed(d);
                        const limit = d.memory_stats.limit ?? 0;
                        const { rx, tx } = sumNet(d.networks);
                        const { r, w } = sumBlk(d.blkio_stats?.io_service_bytes_recursive);
                        pubsub.publish(GRAPHQL_PUBSUB_CHANNEL.DOCKER_STATS, {
                            dockerContainerStats: {
                                id,
                                cpuPercent: cpuPct(d),
                                memUsage: formatBytes(usage) + ' / ' + formatBytes(limit),
                                memPercent: limit > 0 ? (usage / limit) * 100 : 0,
                                netIO: formatBytes(rx) + ' / ' + formatBytes(tx),
                                blockIO: formatBytes(r) + ' / ' + formatBytes(w),
                            },
                        });
                    } catch (e) { /* per-chunk parse errors are non-fatal */ }
                });
                stream.on('error', () => { destroyStream(stream); this._dockerodeStreams.delete(id); });
                stream.on('end', () => { this._dockerodeStreams.delete(id); });
            }).catch(() => { /* container may have stopped between list and stats */ });
        };
        try {
            const list = await docker.listContainers();
            for (const c of list) openFor(c.Id);
            docker.getEvents({ filters: { type: ['container'] } }).then((events) => {
                this._dockerodeEvents = events;
                events.on('data', (chunk) => {
                    try {
                        const evt = JSON.parse(chunk.toString());
                        if (evt.Type !== 'container') return;
                        const id = evt.id;
                        if (!id) return;
                        if (evt.Action === 'start') openFor(id);
                        else if (['die','stop','kill','destroy'].includes(evt.Action)) {
                            const s = this._dockerodeStreams.get(id);
                            if (s) { destroyStream(s); this._dockerodeStreams.delete(id); }
                        }
                    } catch (e) {}
                });
                events.on('error', () => {});
            }).catch(() => {});
        } catch (err) {
            this.logger.error('Failed to start patched docker stats', err);
            this._dockerodeActive = false;
        }
    };

    proto.stopStatsStream = function patchedStop() {
        if (!this._dockerodeActive) return;
        this._dockerodeActive = false;
        this.logger.log('Stopping docker stats stream (patched)');
        if (this._dockerodeStreams) {
            for (const s of this._dockerodeStreams.values()) destroyStream(s);
            this._dockerodeStreams.clear();
        }
        if (this._dockerodeEvents) { destroyStream(this._dockerodeEvents); this._dockerodeEvents = null; }
    };
})();
"""
    insert_at = match.end()
    content = content[:insert_at] + overlay + content[insert_at:]
    with open(bundle, "w") as f:
        f.write(content)
    log(f"fixed live Docker container stats ({os.path.basename(bundle)})")
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
        patch_docker_stats_bundle(),
        patch_docker_logs_bundle(),
        patch_docker_refresh_bundle(),
    ])
