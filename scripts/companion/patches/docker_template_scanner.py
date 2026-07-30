"""Stop DockerTemplateScannerService rescanning containers that can never match.

`syncMissingContainers()` runs a full `scanTemplates()` whenever a container is
missing from `templateMappings`. A scan reads every template XML off the flash
and rewrites docker.config.json with fsync, on Node's 4 libuv workers. So a
container that never matches -- a GitLab CI runner's throwaway container --
turns every docker query into flash I/O and the API stops answering while it
runs. It never crashes, so `unraid-api status` stays green throughout.

v1 deduped on the set of unmapped names. CI containers come and go, the set
oscillates 1 <-> 2, the key never repeats and the guard never fires.
Measured over 20 queries: 11 scans unpatched, 10 with v1, 0 with v2.

v2 uses two independent rules:
  1. skip `runner-<token>-project-N-concurrent-N-` and `-cache-` names. Also
     stops templateMappings growing -- those were 1323 of 1409 entries.
  2. test key presence, not truthiness. `scanTemplates()` already writes
     `mappings[name] = null` for a container it could not match, then re-reads
     it with `!mappings[name]` and treats its own record as "never tried".

Rule 2 means a template added later is not picked up until the API restarts.

Injected after the service's decoration statement, same as array_state.py.
"""
from __future__ import annotations

import os

from companion._bundle import find_bundle
from companion._runtime import log

SCANNER_DEDUPE_MARKER = "/* u-manager-companion: docker template scanner dedupe v2 */"
_V1_MARKER = "/* u-manager-companion: docker template scanner dedupe v1 */"

_OVERLAY = "\n" + SCANNER_DEDUPE_MARKER + "\n" + r"""
;(() => {
    const proto = DockerTemplateScannerService.prototype;
    const orig = proto.syncMissingContainers;
    if (typeof orig !== 'function') return;

    // GitLab CI throwaway containers, both naming shapes.
    const EPHEMERAL = /^runner-[0-9a-z]+-(project-\d+-concurrent-\d+|cache)-/i;

    proto.syncMissingContainers = async function patchedSyncMissingContainers(containers) {
        try {
            const config = this.dockerConfigService.getConfig();
            const mappings = (config && config.templateMappings) || {};
            const skipSet = new Set((config && config.skipTemplatePaths) || []);
            const unmapped = [];
            for (const c of (containers || [])) {
                const n = this.getPrimaryContainerName(c);
                if (!n) continue;
                if (EPHEMERAL.test(n)) continue;
                if (n in mappings) continue;   // null means "already tried"
                if (skipSet.has(n)) continue;
                unmapped.push(n);
            }
            if (unmapped.length === 0) return false;
        } catch (e) {
            // fall back to the original on any inspection error
        }
        return orig.call(this, containers);
    };
})();
"""

# Unique in the live bundle (verified: appears exactly once).
_ANCHOR = "], DockerTemplateScannerService);"


def patch_docker_template_scanner_bundle() -> bool:
    """Stop DockerTemplateScannerService re-scanning for unmappable containers."""
    bundle = find_bundle()
    if not bundle:
        log("docker-template-scanner patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if SCANNER_DEDUPE_MARKER in content:
        return False
    if _V1_MARKER in content:
        # Leave v1 in place; v2 is appended after it, wraps it, and
        # short-circuits before v1's set-key logic runs.
        log("docker-template-scanner patch: v1 overlay present, layering v2 on top")
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
