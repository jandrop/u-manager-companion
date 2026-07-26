"""DockerTemplateScannerService: stop the runaway template-sync loop.

`DockerTemplateScannerService.syncMissingContainers(containers)` looks for
containers whose name is not in `templateMappings` (and not in
`skipTemplatePaths`) and, if any are found, logs `Found N containers without
template mappings, triggering sync` and calls `scanTemplates()`. But
`scanTemplates()` can only map a container that has a matching template XML.
A container that will never have one -- e.g. a GitLab CI runner's ephemeral
`runner-<id>-...-build` container -- stays unmapped forever, so every call
re-detects it and re-triggers a full scan. On a box where something polls the
container list often (or Docker events fire), this becomes a tight loop that
pegs the unraid-api's single Node thread and blocks the GraphQL event loop, so
the whole API stops responding.

This patch wraps `syncMissingContainers` with a dedupe guard: it only lets the
original run when the *set of unmappable container names* has changed since the
last scan. A persistently-unmappable container therefore triggers at most one
scan (not one per call), while a genuinely new app (new unmapped name) still
triggers a scan exactly once. Rescanning the same unmappable set is pointless
anyway -- it cannot conjure a template that does not exist.

Same mechanism as array_state.py / parity_status.py: inject an IIFE right after
the service's decoration statement, in the module scope where the
`DockerTemplateScannerService` binding is live.
"""
from __future__ import annotations

import os

from companion._bundle import find_bundle
from companion._runtime import log

SCANNER_DEDUPE_MARKER = "/* u-manager-companion: docker template scanner dedupe v1 */"

_OVERLAY = "\n" + SCANNER_DEDUPE_MARKER + "\n" + r"""
;(() => {
    const proto = DockerTemplateScannerService.prototype;
    const orig = proto.syncMissingContainers;
    if (typeof orig !== 'function') return;
    proto.syncMissingContainers = async function patchedSyncMissingContainers(containers) {
        try {
            const config = this.dockerConfigService.getConfig();
            const mappings = (config && config.templateMappings) || {};
            const skipSet = new Set((config && config.skipTemplatePaths) || []);
            const unmapped = [];
            for (const c of (containers || [])) {
                const n = this.getPrimaryContainerName(c);
                if (n && !mappings[n] && !skipSet.has(n)) unmapped.push(n);
            }
            if (unmapped.length === 0) {
                this.__umLastUnmappedKey = '';
                return false;
            }
            const key = unmapped.sort().join('|');
            if (key === this.__umLastUnmappedKey) {
                // Same unmappable container set as the last scan. Re-scanning
                // cannot create a template that does not exist, so skip it.
                // This breaks the runaway loop on ephemeral containers (e.g.
                // GitLab CI runner build containers) that never match a
                // template and would otherwise re-trigger a full scan on every
                // call, pegging the API's event loop.
                return false;
            }
            // Record BEFORE running so a throwing scan can't reopen the loop.
            this.__umLastUnmappedKey = key;
        } catch (e) {
            // On any inspection error, fall back to the original behaviour.
        }
        return orig.call(this, containers);
    };
})();
"""

# Unique in the live bundle (verified: appears exactly once).
_ANCHOR = "], DockerTemplateScannerService);"


def patch_docker_template_scanner_bundle() -> bool:
    """Dedupe DockerTemplateScannerService.syncMissingContainers scans."""
    bundle = find_bundle()
    if not bundle:
        log("docker-template-scanner patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if SCANNER_DEDUPE_MARKER in content:
        return False
    if _ANCHOR not in content:
        log("docker-template-scanner patch: decoration anchor not found")
        return False

    idx = content.index(_ANCHOR) + len(_ANCHOR)
    content = content[:idx] + _OVERLAY + content[idx:]

    with open(bundle, "w") as f:
        f.write(content)
    log(f"deduped docker template scanner sync ({os.path.basename(bundle)})")
    return True


def apply() -> bool:
    """Entry point called by the orchestrator."""
    return patch_docker_template_scanner_bundle()
