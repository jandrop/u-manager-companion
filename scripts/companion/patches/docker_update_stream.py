"""updateContainerStream + updateAllContainersStream mutations.

Mirrors the streaming install pipeline for the "apply update" (per
container) and "update all" buttons in Unraid's Docker page. Both
mutations return a `DockerInstallOperation` immediately
(`status=RUNNING`) and stream per-line progress through the existing
`dockerInstallUpdates(operationId)` subscription.

Per-container update pipeline (mirrors the Unraid PHP
`scripts/update_container`):

  1. pull image (dockerode + followProgress, with progress lines)
  2. stop container if Running
  3. remove container
  4. shell out to `scripts/rebuild_container <name>` (PHP CLI)
  5. start container if it was running before
  6. remove the old image when its SHA changed (best-effort)

Update All reads `/var/lib/docker/unraid-update-status.json`,
filters images whose `local != remote`, maps them to running
containers, and runs the per-container pipeline sequentially under
ONE operation. The operation's `output[]` aggregates every container's
log lines.

Types (DockerInstallOperation, DockerInstallEvent, DockerInstallStatus,
the `dockerInstallUpdates` subscription and the
`dockerInstallOperation` query) are reused from
`docker_template_create.py` — that patch MUST run before this one for
its IIFE / class registrations to be in scope. `patch.py` enforces
this order.

To make the existing `dockerInstallOperation(id)` query and
`dockerInstallUpdates(id)` subscription work for our update ops, we
wrap the resolver methods so they consult both the install runtime's
ops map and ours.

Concurrency: refuses to start a new update if any other docker update
is in flight (within this runtime). Install ops run independently —
docker daemon serialises per-container work, and the goal is just to
keep the UX log readable.
"""
from __future__ import annotations

import os
import re
from typing import Optional

from companion._bundle import (
    find_bundle,
    find_decorator_suffix,
    find_metadata_suffix,
)
from companion._runtime import log

PATCH_MARKER = "/* u-manager-companion: docker-update-stream-v1 */"
# We anchor AFTER the install patch's mutation overlay so our IIFE runs
# AFTER __dockerInstall is created. From inside our IIFE we monkey-patch
# __dockerInstall.getOperation/.subscribe to fall back to __dockerUpdate
# — this is the only way to extend the existing dockerInstallOperation /
# dockerInstallUpdates resolvers because NestJS captures the resolver
# method reference during decorator evaluation; reassigning the prototype
# method later does NOT propagate. The captured method is itself a tiny
# closure that calls `globalThis.__dockerInstall.getOperation(id)` LIVE,
# so wrapping that object property does work.
ANCHOR_INSTALL_MUT_END = (
    'DockerMutationsResolver.prototype, "installDockerTemplate", null);'
)
ANCHOR_MUT_CLOSE = "], DockerMutationsResolver);"


def _find_param_suffix(content: str, anchor: str) -> Optional[str]:
    idx = content.find(anchor)
    if idx == -1:
        return None
    chunk = content[max(0, idx - 800) : idx]
    matches = re.findall(r"_ts_param\$([\w$]+)\(\d", chunk)
    return matches[-1] if matches else None


def patch_bundle() -> bool:
    bundle = find_bundle()
    if not bundle:
        log("docker-update-stream patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if PATCH_MARKER in content:
        return False

    d_mut = find_decorator_suffix(
        content,
        'DockerMutationsResolver.prototype, "updateAllContainers", null)',
    )
    m_mut = find_metadata_suffix(
        content,
        'DockerMutationsResolver.prototype, "updateAllContainers", null)',
    )
    p_mut = _find_param_suffix(
        content,
        'DockerMutationsResolver.prototype, "removeContainer", null)',
    )
    if not all([d_mut, m_mut, p_mut]):
        log(
            "docker-update-stream patch: suffix detection failed "
            f"(d_mut={d_mut} m_mut={m_mut} p_mut={p_mut})"
        )
        return False

    # Anchor AFTER install patch's mut_overlay so our IIFE runs after
    # __dockerInstall is created. Falls back to the original anchor if
    # the install patch is missing (patch.py should always run install
    # first — this is a safety net).
    install_end = content.find(ANCHOR_INSTALL_MUT_END)
    if install_end != -1:
        insert_mut = install_end + len(ANCHOR_INSTALL_MUT_END)
    else:
        fallback = content.find(ANCHOR_MUT_CLOSE)
        if fallback == -1:
            log("docker-update-stream patch: no anchor found")
            return False
        insert_mut = fallback + len(ANCHOR_MUT_CLOSE)

    overlay = (
        "\n"
        + PATCH_MARKER
        + "\n"
        + _update_service_iife()
        + _mutation_decorators(d_mut, m_mut, p_mut)
    )

    new_content = content[:insert_mut] + overlay + content[insert_mut:]
    with open(bundle, "w") as f:
        f.write(new_content)
    log(f"enabled live Docker update progress in API ({os.path.basename(bundle)})")
    return True


# ─────────────────────────────────────────────────────────── service IIFE


def _update_service_iife() -> str:
    """Module-level update orchestrator: operations store + per-container
    pipeline + Update All resolver. Shares the channel prefix with the
    install runtime so the `dockerInstallUpdates(opId)` subscription
    works transparently for either origin.
    """
    return r""";(() => {
    if (globalThis.__dockerUpdate) return; // idempotent

    // Wrap __dockerInstall.getOperation / .subscribe so the existing
    // dockerInstallOperation query and dockerInstallUpdates subscription
    // (registered by docker_template_create.py) also resolve operations
    // owned by THIS update runtime. The captured resolver method is a
    // closure that reads `globalThis.__dockerInstall.getOperation` LIVE
    // on every call, so wrapping that object property propagates.
    // Idempotent via __umWrapped sentinel.
    if (globalThis.__dockerInstall && !globalThis.__dockerInstall.__umWrapped) {
        const origGetOp = globalThis.__dockerInstall.getOperation;
        globalThis.__dockerInstall.getOperation = function(id) {
            const fromInstall = origGetOp(id);
            if (fromInstall) return fromInstall;
            return globalThis.__dockerUpdate && globalThis.__dockerUpdate.getOperation
                ? globalThis.__dockerUpdate.getOperation(id)
                : null;
        };
        const origSubscribe = globalThis.__dockerInstall.subscribe;
        globalThis.__dockerInstall.subscribe = function(id) {
            if (globalThis.__dockerUpdate
                && globalThis.__dockerUpdate.hasOperation
                && globalThis.__dockerUpdate.hasOperation(id)) {
                return globalThis.__dockerUpdate.subscribe(id);
            }
            return origSubscribe(id);
        };
        globalThis.__dockerInstall.__umWrapped = true;
    }

    const REBUILD_CONTAINER = '/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/rebuild_container';
    const UPDATE_STATUS_JSON = '/var/lib/docker/unraid-update-status.json';
    const WEBUI_INFO_JSON = '/usr/local/emhttp/state/plugins/dynamix.docker.manager/docker.json';
    const CHANNEL_PREFIX = 'DOCKER_INSTALL:';
    const MAX_OUTPUT_LINES = 1000;
    const COMPLETED_TTL_MS = 15 * 60 * 1000;

    const operations = new Map();
    const cleanupTimers = new Map();
    let busy = false;

    function newId() {
        return (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
    function channelFor(id) { return CHANNEL_PREFIX + id; }

    function formatPullEvent(event) {
        if (!event || typeof event !== 'object') return null;
        if (event.error) return 'Error: ' + event.error;
        if (!event.status) return null;
        const layer = event.id ? 'IMAGE ID [' + event.id + ']: ' : '';
        const d = event.progressDetail;
        if (d && typeof d.current === 'number' && typeof d.total === 'number' && d.total > 0) {
            const percent = Math.floor((d.current / d.total) * 100);
            const totalMb = (d.total / (1024 * 1024)).toFixed(0);
            return layer + event.status + ' ' + percent + '% of ' + totalMb + ' MB';
        }
        return layer + event.status;
    }

    function trimOutput(op) {
        if (op.output.length > MAX_OUTPUT_LINES) {
            op.output.splice(0, op.output.length - MAX_OUTPUT_LINES);
        }
    }

    function publishEvent(op, deltaLines) {
        const event = {
            operationId: op.id,
            status: op.status,
            output: deltaLines.length ? deltaLines : undefined,
            timestamp: new Date(),
        };
        try {
            pubsub.publish(channelFor(op.id), { dockerInstallUpdates: event });
        } catch (e) { /* best-effort */ }
    }

    function appendLine(op, line) {
        op.updatedAt = new Date();
        op.output.push(line);
        trimOutput(op);
        publishEvent(op, [line]);
    }

    function scheduleCleanup(id) {
        const existing = cleanupTimers.get(id);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
            operations.delete(id);
            cleanupTimers.delete(id);
        }, COMPLETED_TTL_MS);
        if (typeof timer.unref === 'function') timer.unref();
        cleanupTimers.set(id, timer);
    }

    function handleSuccess(op) {
        if (op.status !== 'RUNNING') return;
        op.status = 'SUCCEEDED';
        op.finishedAt = new Date();
        op.updatedAt = op.finishedAt;
        publishEvent(op, []);
        scheduleCleanup(op.id);
    }

    function handleFailure(op, error) {
        if (op.status !== 'RUNNING') return;
        op.status = 'FAILED';
        op.finishedAt = new Date();
        op.updatedAt = op.finishedAt;
        const line = 'Error: ' + (error && error.message ? error.message : String(error));
        op.output.push(line);
        trimOutput(op);
        publishEvent(op, [line]);
        scheduleCleanup(op.id);
    }

    async function pullImage(op, repo) {
        if (!repo) return;
        const tagged = /:\S+$/.test(repo) ? repo : (repo + ':latest');
        appendLine(op, 'Pulling image ' + tagged);
        const client = getDockerClient();
        const stream = await client.pull(tagged);
        await new Promise((resolve, reject) => {
            client.modem.followProgress(stream, (err) => err ? reject(err) : resolve(),
                (event) => {
                    const line = formatPullEvent(event);
                    if (line) appendLine(op, line);
                });
        });
    }

    async function stopContainer(op, name) {
        appendLine(op, 'Stopping container ' + name);
        const client = getDockerClient();
        try {
            await client.getContainer(name).stop();
            appendLine(op, 'Stopped ' + name);
        } catch (err) {
            if (err && (err.statusCode === 304 || err.statusCode === 404)) {
                appendLine(op, 'Container ' + name + ' already stopped');
                return;
            }
            throw err;
        }
    }

    async function removeContainer(op, name) {
        appendLine(op, 'Removing container ' + name);
        const client = getDockerClient();
        try {
            await client.getContainer(name).remove({ force: false, v: false });
            appendLine(op, 'Removed ' + name);
        } catch (err) {
            if (err && err.statusCode === 404) {
                appendLine(op, 'Container ' + name + ' already removed');
                return;
            }
            throw err;
        }
    }

    async function rebuildContainer(op, name) {
        appendLine(op, 'Running rebuild_container ' + name);
        const child = execa(REBUILD_CONTAINER, [encodeURIComponent(name)], {
            all: true, reject: false, shell: 'bash',
        });
        let buffer = '';
        const onChunk = (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.replace(/\s+$/, '');
                if (trimmed.length) appendLine(op, trimmed);
            }
        };
        if (child.all) child.all.on('data', onChunk);
        else {
            if (child.stdout) child.stdout.on('data', onChunk);
            if (child.stderr) child.stderr.on('data', onChunk);
        }
        const result = await child;
        if (buffer.trim().length) appendLine(op, buffer.trim());
        if (result.exitCode !== 0) {
            throw new Error('rebuild_container exited with code ' + result.exitCode);
        }
    }

    async function startContainer(op, name) {
        appendLine(op, 'Starting container ' + name);
        const client = getDockerClient();
        try {
            await client.getContainer(name).start();
            appendLine(op, 'Container ' + name + ' started');
        } catch (err) {
            if (err && err.statusCode === 304) {
                appendLine(op, 'Container ' + name + ' already running');
                return;
            }
            throw err;
        }
    }

    async function removeOldImageBestEffort(op, oldImageId, newImageId) {
        if (!oldImageId || oldImageId === newImageId) return;
        try {
            await getDockerClient().getImage(oldImageId).remove({ force: false });
            appendLine(op, 'Removed orphan image ' + oldImageId);
        } catch (err) { /* swallow — likely still referenced */ }
    }

    async function inspectContainer(idOrName) {
        const c = await getDockerClient().getContainer(idOrName).inspect();
        const name = (c.Name || '').replace(/^\//, '') || String(idOrName);
        const repository = c.Config && c.Config.Image ? c.Config.Image : '';
        const wasRunning = !!(c.State && c.State.Running);
        const imageId = c.Image || '';
        return { name, repository, wasRunning, imageId };
    }

    async function updateOne(op, idOrName) {
        const before = await inspectContainer(idOrName);
        appendLine(op, '── Updating ' + before.name + ' ──');
        await pullImage(op, before.repository);
        if (before.wasRunning) await stopContainer(op, before.name);
        await removeContainer(op, before.name);
        await rebuildContainer(op, before.name);
        // rebuild_container honours the autostart list — if the container
        // was running and is not in autostart we need to start it back.
        try {
            const after = await inspectContainer(before.name);
            if (before.wasRunning && !(after && after.wasRunning)) {
                await startContainer(op, before.name);
            }
            await removeOldImageBestEffort(op, before.imageId, after.imageId);
        } catch (err) {
            // post-update inspect failure is non-fatal — the user still
            // got the pull + rebuild output above.
            appendLine(op, 'Post-update inspect failed: ' + (err && err.message ? err.message : String(err)));
        }
        // Mirror update_container.php's setUpdateStatus call AND patch
        // the webui-info cache — without this the badge stays on the
        // card because DockerTemplates::getAllInfo() reads the cached
        // 'updated' flag without re-checking the JSON unless reload=true.
        await syncUpdateStatusForRepo(op, before.repository, before.name);
    }

    async function syncUpdateStatusForRepo(op, repo, containerName) {
        if (!repo) return;
        try {
            const client = getDockerClient();
            const tagged = /:\S+$/.test(repo) ? repo : (repo + ':latest');
            const inspect = await client.getImage(tagged).inspect();
            const repoDigests = inspect.RepoDigests || [];
            if (!repoDigests.length) return;
            const first = repoDigests[0];
            const atIdx = first.indexOf('@');
            const digest = atIdx >= 0 ? first.slice(atIdx + 1) : first;
            if (!digest) return;
            const { readFile, writeFile } = await import('fs/promises');

            // 1. unraid-update-status.json — source of truth for local/remote
            //    digest pairs read by DockerUpdate::getUpdateStatus.
            let updateStatus = {};
            try {
                const raw = await readFile(UPDATE_STATUS_JSON, 'utf8');
                updateStatus = JSON.parse(raw);
            } catch (e) { /* file may not exist yet */ }
            updateStatus[tagged] = {
                local: digest,
                remote: digest,
                status: 'true',
            };
            await writeFile(UPDATE_STATUS_JSON,
                JSON.stringify(updateStatus, null, 4) + '\n',
                { encoding: 'utf8', mode: 0o644 });

            // 2. docker.json — getAllInfo() short-circuits on the cached
            //    'updated' flag, so update it for THIS container. The
            //    rebuild_container PHP CLI we shelled out to internally
            //    calls DockerClient::removeContainer which unsets the
            //    entry before recreating the container, so by the time
            //    we get here the key may be missing. Always recreate
            //    a minimal entry — the next getAllInfo() pass will
            //    backfill `running`, `template`, etc. while preserving
            //    our `updated` flag (it short-circuits when the field
            //    is non-empty, regardless of how shallow the entry is).
            if (containerName) {
                let webuiInfo = {};
                try {
                    const raw = await readFile(WEBUI_INFO_JSON, 'utf8');
                    webuiInfo = JSON.parse(raw);
                } catch (e) { /* file may not exist */ }
                if (!webuiInfo[containerName]) webuiInfo[containerName] = {};
                webuiInfo[containerName].updated = 'true';
                await writeFile(WEBUI_INFO_JSON,
                    JSON.stringify(webuiInfo, null, 4) + '\n',
                    { encoding: 'utf8', mode: 0o644 });
            }
        } catch (err) {
            appendLine(op, 'Could not sync update-status: ' + (err && err.message ? err.message : String(err)));
        }
    }

    async function readUpdatableTargets() {
        const { readFile } = await import('fs/promises');
        let json;
        try {
            const raw = await readFile(UPDATE_STATUS_JSON, 'utf8');
            json = JSON.parse(raw);
        } catch (e) {
            return [];
        }
        const updatable = new Set();
        for (const [image, info] of Object.entries(json)) {
            if (!info || !info.local || !info.remote) continue;
            if (info.local !== info.remote) updatable.add(image);
        }
        if (!updatable.size) return [];
        const client = getDockerClient();
        const all = await client.listContainers({ all: true });
        const targets = [];
        for (const c of all) {
            const image = c.Image || '';
            if (!image) continue;
            const tagged = image.includes(':') ? image : (image + ':latest');
            if (updatable.has(tagged) || updatable.has(image)) {
                const name = (c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : null);
                if (name) targets.push(name);
            }
        }
        return targets;
    }

    async function runSingleUpdate(op, idOrName) {
        await updateOne(op, idOrName);
        handleSuccess(op);
    }

    async function runUpdateAll(op) {
        const targets = await readUpdatableTargets();
        if (!targets.length) {
            appendLine(op, 'No containers with available updates.');
            handleSuccess(op);
            return;
        }
        appendLine(op, 'Updating ' + targets.length + ' container(s): ' + targets.join(', '));
        const failed = [];
        for (const name of targets) {
            try {
                await updateOne(op, name);
            } catch (err) {
                failed.push(name);
                appendLine(op, 'Error updating ' + name + ': ' + (err && err.message ? err.message : String(err)));
            }
        }
        if (failed.length) {
            handleFailure(op, new Error('Failed to update: ' + failed.join(', ')));
            return;
        }
        handleSuccess(op);
    }

    function toGraphqlOperation(op) {
        return {
            id: op.id,
            containerName: op.containerName,
            repository: op.repository,
            status: op.status,
            createdAt: op.createdAt,
            updatedAt: op.updatedAt || null,
            finishedAt: op.finishedAt || null,
            output: [...op.output],
        };
    }

    function bookOp(containerName, repository) {
        if (busy) throw new Error('Another Docker update is already in progress');
        busy = true;
        const id = newId();
        const createdAt = new Date();
        const op = {
            id,
            containerName,
            repository,
            status: 'RUNNING',
            createdAt,
            updatedAt: createdAt,
            finishedAt: null,
            output: [],
        };
        operations.set(id, op);
        publishEvent(op, []);
        return op;
    }

    async function startOne(idOrName) {
        // Resolve to friendly name + repository BEFORE booking the op so
        // the snapshot the mutation returns (and the cubit hydrates from)
        // carries the human-readable container name instead of the raw
        // PrefixedID docker hash.
        let containerName = String(idOrName);
        let repository = '';
        try {
            const snap = await inspectContainer(idOrName);
            containerName = snap.name;
            repository = snap.repository;
        } catch (e) { /* fall back to raw id */ }
        const op = bookOp(containerName, repository);
        runSingleUpdate(op, idOrName)
            .catch((err) => handleFailure(op, err))
            .finally(() => { busy = false; });
        return toGraphqlOperation(op);
    }

    function startAll() {
        const op = bookOp('All updatable containers', '*');
        runUpdateAll(op)
            .catch((err) => handleFailure(op, err))
            .finally(() => { busy = false; });
        return toGraphqlOperation(op);
    }

    function getOperation(id) {
        const op = operations.get(id);
        return op ? toGraphqlOperation(op) : null;
    }

    function subscribe(id) {
        if (!operations.has(id)) {
            throw new Error('Unknown Docker update operation: ' + id);
        }
        return createSubscription(channelFor(id));
    }

    function hasOperation(id) { return operations.has(id); }

    globalThis.__dockerUpdate = { startOne, startAll, getOperation, subscribe, hasOperation };
})();

"""


# ─────────────────────────────────────────────── resolver method decorators


def _mutation_decorators(d: str, m: str, p: str) -> str:
    """Append updateContainerStream + updateAllContainersStream methods + decorators."""
    method_def = r""";(() => {
    DockerMutationsResolver.prototype.updateContainerStream = function patchedUpdateContainerStream(id) {
        return globalThis.__dockerUpdate.startOne(id);
    };
    DockerMutationsResolver.prototype.updateAllContainersStream = function patchedUpdateAllContainersStream() {
        return globalThis.__dockerUpdate.startAll();
    };
})();

"""
    one_desc = (
        'Start an async update of a single Docker container. Returns the '
        'operation immediately (status=RUNNING). Subscribe to '
        'dockerInstallUpdates(operationId) for per-line progress.'
    )
    all_desc = (
        'Start an async update of every Docker container with an available '
        'update (matches the "Update All" button in the Unraid web UI). '
        'Returns one operation whose output stream aggregates all containers. '
        'Subscribe to dockerInstallUpdates(operationId) for per-line progress.'
    )

    one_dec = (
        f"_ts_decorate${d}([\n"
        f"    ResolveField(()=>DockerInstallOperation, {{ description: {repr(one_desc)} }}),\n"
        f"    UsePermissions({{\n"
        f"        action: AuthAction.UPDATE_ANY,\n"
        f"        resource: Resource.DOCKER\n"
        f"    }}),\n"
        f"    _ts_param${p}(0, Args('id', {{ type: ()=>PrefixedID, nullable: false }})),\n"
        f'    _ts_metadata${m}("design:type", Function),\n'
        f'    _ts_metadata${m}("design:paramtypes", [String]),\n'
        f'    _ts_metadata${m}("design:returntype", Object)\n'
        f'], DockerMutationsResolver.prototype, "updateContainerStream", null);\n'
    )
    all_dec = (
        f"_ts_decorate${d}([\n"
        f"    ResolveField(()=>DockerInstallOperation, {{ description: {repr(all_desc)} }}),\n"
        f"    UsePermissions({{\n"
        f"        action: AuthAction.UPDATE_ANY,\n"
        f"        resource: Resource.DOCKER\n"
        f"    }}),\n"
        f'    _ts_metadata${m}("design:type", Function),\n'
        f'    _ts_metadata${m}("design:paramtypes", []),\n'
        f'    _ts_metadata${m}("design:returntype", Object)\n'
        f'], DockerMutationsResolver.prototype, "updateAllContainersStream", null);\n'
    )
    return method_def + one_dec + all_dec


def apply() -> bool:
    return patch_bundle()
