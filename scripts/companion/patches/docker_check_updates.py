"""checkForUpdates mutation — refresh the Docker update-status cache.

Mirrors the "CHECK FOR UPDATES" button in Unraid's Docker page. The
web UI POSTs to `/plugins/dynamix.docker.manager/include/DockerUpdate.php`
which simply calls `$DockerTemplates->downloadTemplates()` followed
by `getAllInfo($ncsi, $ncsi)` to refresh
`/var/lib/docker/unraid-update-status.json`. We shell out to the
companion CLI `scripts/dockerupdate` which does the same thing in
non-check mode.

Returns Boolean (true on exit code 0). The client should refetch its
Docker container list afterwards so the new `updateAvailable` flags
surface.
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

PATCH_MARKER = "/* u-manager-companion: docker-check-updates-v1 */"
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
        log("docker-check-updates patch: bundle not found")
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
    # No params on this mutation, but find a metadata suffix so we have
    # a usable identifier without scanning a wider window.
    if not all([d_mut, m_mut]):
        log(
            "docker-check-updates patch: suffix detection failed "
            f"(d_mut={d_mut} m_mut={m_mut})"
        )
        return False

    insert_at = content.find(ANCHOR_MUT_CLOSE)
    if insert_at == -1:
        log("docker-check-updates patch: DockerMutationsResolver close not found")
        return False
    insert_at += len(ANCHOR_MUT_CLOSE)

    overlay = (
        "\n"
        + PATCH_MARKER
        + "\n"
        + _check_service_iife()
        + _mutation_decorator(d_mut, m_mut)
    )
    new_content = content[:insert_at] + overlay + content[insert_at:]
    with open(bundle, "w") as f:
        f.write(new_content)
    log(f"patched docker-check-updates in {os.path.basename(bundle)}")
    return True


def _check_service_iife() -> str:
    return r""";(() => {
    if (globalThis.__dockerCheckUpdates) return; // idempotent
    const DOCKERUPDATE_SCRIPT = '/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/dockerupdate';

    async function check() {
        const child = execa(DOCKERUPDATE_SCRIPT, [], { reject: false, shell: 'bash' });
        const result = await child;
        return result.exitCode === 0;
    }

    globalThis.__dockerCheckUpdates = { check };
})();

"""


def _mutation_decorator(d: str, m: str) -> str:
    method_def = r""";(() => {
    DockerMutationsResolver.prototype.checkForUpdates = function patchedCheckForUpdates() {
        return globalThis.__dockerCheckUpdates.check();
    };
})();

"""
    description = (
        'Refresh the Docker update-status cache (templates + remote digests) '
        'on the server. Mirrors the "Check for Updates" button on the Unraid '
        'Docker page. Clients should refetch the Docker container list '
        'afterwards to pick up the updated `updateAvailable` flags.'
    )
    decorator = (
        f"_ts_decorate${d}([\n"
        f"    ResolveField(()=>Boolean, {{ description: {repr(description)} }}),\n"
        f"    UsePermissions({{\n"
        f"        action: AuthAction.UPDATE_ANY,\n"
        f"        resource: Resource.DOCKER\n"
        f"    }}),\n"
        f'    _ts_metadata${m}("design:type", Function),\n'
        f'    _ts_metadata${m}("design:paramtypes", []),\n'
        f'    _ts_metadata${m}("design:returntype", Promise)\n'
        f'], DockerMutationsResolver.prototype, "checkForUpdates", null);\n'
    )
    return method_def + decorator


def apply() -> bool:
    return patch_bundle()
