"""deleteDockerTemplate mutation — uninstall a CA-installed container.

Companion to `docker_template_create.py`. Injects a Boolean mutation
that runs the same routine as the Unraid web UI's `uninstall_docker`
PHP handler (community.applications/include/exec.php:1593-1614):

  1. Stop the container if it is running.
  2. Remove the container (no force, no anonymous-volume wipe).
  3. Remove the container's image (best-effort — Unraid swallows the
     409 "image in use" error).
  4. `docker volume prune` to clean up orphaned anonymous volumes.
  5. **Leave the user-template XML in place** under
     `/boot/config/plugins/dockerMan/templates-user/my-<Name>.xml`
     so the entry resurfaces as a "Previous App" in the CA UI for
     one-click reinstall.

The TS canonical of this patch lives on the
`feature/docker-install-stream` branch of the unraid-api fork
(`DockerMutationsResolver.deleteDockerTemplate` →
`DockerTemplateService.delete` → `uninstallLikeWebUi`).
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

PATCH_MARKER = "/* u-manager-companion: docker-template-delete-v3 */"
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
        log("docker-template-delete patch: bundle not found")
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
            "docker-template-delete patch: suffix detection failed "
            f"(d_mut={d_mut} m_mut={m_mut} p_mut={p_mut})"
        )
        return False

    insert_at = content.find(ANCHOR_MUT_CLOSE)
    if insert_at == -1:
        log("docker-template-delete patch: DockerMutationsResolver close not found")
        return False
    insert_at += len(ANCHOR_MUT_CLOSE)

    overlay = (
        "\n"
        + PATCH_MARKER
        + "\n"
        + _delete_service_iife()
        + _mutation_decorator(d_mut, m_mut, p_mut)
    )

    new_content = content[:insert_at] + overlay + content[insert_at:]
    with open(bundle, "w") as f:
        f.write(new_content)
    log(f"enabled Docker container delete from the app ({os.path.basename(bundle)})")
    return True


def _delete_service_iife() -> str:
    """Module-level delete() implementation hung off globalThis."""
    return r""";(() => {
    if (globalThis.__dockerTemplateDelete) return; // idempotent

    function sanitiseName(raw) {
        const trimmed = (raw || '').trim();
        if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
            throw new Error('Invalid container name "' + raw + '". Allowed: A-Z a-z 0-9 _ . -');
        }
        return trimmed;
    }

    async function uninstallLikeWebUi(name, removeImage) {
        const client = getDockerClient();
        const container = client.getContainer(name);
        let imageId;

        // Step 1+2: stop if running, then remove the container.
        try {
            const inspect = await container.inspect();
            imageId = inspect.Image;
            if (inspect.State && inspect.State.Running) {
                try {
                    await container.stop();
                } catch (err) { /* best-effort, continue to remove */ }
            }
            await container.remove({ force: false, v: false });
        } catch (error) {
            if (error && error.statusCode === 404) return; // nothing to remove
            throw error;
        }

        // Stop here when the user unchecked "also remove image": the
        // image stays on disk and we skip the volume prune.
        if (!removeImage) return;

        // Step 3: remove the image. PHP `removeImage()` swallows the
        // 409 ImageInUse error (image still referenced by another
        // container); mirror that.
        if (imageId) {
            try {
                await client.getImage(imageId).remove({ force: false });
            } catch (err) { /* swallow 409 + log silently */ }
        }

        // Step 4: docker volume prune (best-effort).
        try {
            await client.pruneVolumes();
        } catch (err) { /* best-effort */ }
    }

    async function deleteTemplate(name, removeContainer, removeImage) {
        const safe = sanitiseName(name);
        if (removeContainer === false) {
            return false; // no-op branch reserved for future XML-only flows
        }
        await uninstallLikeWebUi(safe, removeImage !== false);
        return true;
    }

    globalThis.__dockerTemplateDelete = { delete: deleteTemplate };
})();

"""


def _mutation_decorator(d: str, m: str, p: str) -> str:
    """Append `deleteDockerTemplate` method + decorator to DockerMutationsResolver."""
    method_def = r""";(() => {
    DockerMutationsResolver.prototype.deleteDockerTemplate = function patchedDeleteDockerTemplate(name, removeContainer, removeImage) {
        return globalThis.__dockerTemplateDelete.delete(name, removeContainer, removeImage);
    };
})();

"""
    description = (
        'Uninstall a Docker container the same way the Unraid web UI '
        '"Remove container" dialog does. Always stops + removes the '
        'container. When removeImage is true (the default — matches the '
        '"also remove image" checkbox being checked) also removes the '
        "image and prunes unused volumes. The user-template XML under "
        '/boot/config/plugins/dockerMan/templates-user is kept so the '
        'entry surfaces as a "Previous App" for quick reinstall.'
    )
    decorator = (
        f"_ts_decorate${d}([\n"
        f"    ResolveField(()=>Boolean, {{ description: {repr(description)} }}),\n"
        f"    UsePermissions({{\n"
        f"        action: AuthAction.DELETE_ANY,\n"
        f"        resource: Resource.DOCKER\n"
        f"    }}),\n"
        f"    _ts_param${p}(0, Args('name', {{ type: ()=>String, nullable: false }})),\n"
        f"    _ts_param${p}(1, Args('removeContainer', {{ type: ()=>Boolean, nullable: true }})),\n"
        f"    _ts_param${p}(2, Args('removeImage', {{ type: ()=>Boolean, nullable: true }})),\n"
        f'    _ts_metadata${m}("design:type", Function),\n'
        f'    _ts_metadata${m}("design:paramtypes", [String, Boolean, Boolean]),\n'
        f'    _ts_metadata${m}("design:returntype", Promise)\n'
        f'], DockerMutationsResolver.prototype, "deleteDockerTemplate", null);\n'
    )
    return method_def + decorator


def apply() -> bool:
    return patch_bundle()
