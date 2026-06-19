"""Memory breakdown — zfsCache, docker, vm, system fields on MemoryUtilization.

Unraid's GraphQL `MemoryUtilization` type exposes only the flat
total/used/free/… counters. This patch adds four nullable BigInt fields
that break used memory down into its major consumers:

  * ``zfsCache``  — ZFS ARC size (/proc/spl/kstat/zfs/arcstats)
  * ``docker``    — sum of each container's memory.stat working set (cgroup)
  * ``vm``        — libvirt VM balloon RSS (virsh domstats, cached 15s)
  * ``system``    — the rest: max(0, used - (zfsCache + docker + vm))

"used" here is total - MemAvailable (what Unraid's dashboard shows), not
systeminformation's total - MemFree, so reclaimable cache stays out of it.

Patch is idempotent: ``apply()`` returns ``False`` immediately if the
marker is already in the bundle (safe to re-run on every boot / API
upgrade).

Tracked alongside companion patches for U-Manager
(https://github.com/jandrop/u-manager-companion).
"""
from __future__ import annotations

import os

from companion._bundle import (
    find_bundle,
    find_decorator_suffix,
    find_metadata_suffix,
)
from companion._runtime import log

# Marks the bundle as patched (used for the idempotency check). Picked
# because this exact string never shows up in the stock bundle.
BUNDLE_MARKER = "MemoryUtilization.prototype, 'system', void 0)"

_SERVICE_MARKER = "/* u-manager-companion: memory breakdown */"

# Tail of the MemoryService decoration; appears once in plugin.module-*.js.
_SERVICE_ANCHOR = "], MemoryService);"

# Wrap injected after the MemoryService decoration. Uses execa (in scope)
# for virsh and fs.promises for the /proc + cgroup reads. virsh is cached
# for 15s so it doesn't run on every ~2s subscription tick.
_OVERLAY = (
    "\n"
    + _SERVICE_MARKER
    + "\n"
    + """;(() => {
    const __umOrigGenMem = MemoryService.prototype.generateMemoryLoad;
    let __umVmBytes = 0, __umVmTs = 0;
    MemoryService.prototype.generateMemoryLoad = async function patchedGenMemLoad() {
        const base = await __umOrigGenMem.apply(this, arguments);
        try {
            const { readFile, readdir } = await import('node:fs/promises');
            // used = total - MemAvailable (Unraid-style; see module docstring).
            const total = Number(base.total ?? 0n);
            const available = Number(base.available ?? 0n);
            const used = Math.max(0, total - available);
            // ZFS ARC
            let zfsCache = 0;
            try {
                const arcText = await readFile('/proc/spl/kstat/zfs/arcstats', 'utf8');
                const m = arcText.match(/^size\\s+\\d+\\s+(\\d+)/m);
                if (m) zfsCache = parseInt(m[1], 10);
            } catch (_e) {}
            // Docker: sum each container's memory.stat working set (v2 or v1).
            // memory.current would also count page cache, so we avoid it.
            let docker = 0;
            const DOCKER_FIELDS = [
                'anon', 'kernel', 'kernel_stack', 'pagetables',
                'sec_pagetables', 'percpu', 'sock', 'vmalloc', 'shmem'
            ];
            try {
                let dockerBase = '/sys/fs/cgroup/docker/';
                let cids = await readdir(dockerBase).catch(() => []);
                if (cids.length === 0) {
                    dockerBase = '/sys/fs/cgroup/memory/docker/';
                    cids = await readdir(dockerBase).catch(() => []);
                }
                for (const cid of cids) {
                    try {
                        const stat = await readFile(`${dockerBase}${cid}/memory.stat`, 'utf8');
                        for (const field of DOCKER_FIELDS) {
                            const fm = stat.match(new RegExp(`^${field}\\\\s+(\\\\d+)`, 'm'));
                            if (fm) docker += parseInt(fm[1], 10);
                        }
                    } catch (_e) {}
                }
            } catch (_e) {}
            // VMs: virsh balloon.rss (KiB -> bytes), cached 15s
            let vm = __umVmBytes;
            try {
                if (Date.now() - __umVmTs > 15000) {
                    const { stdout } = await execa('virsh', ['domstats', '--list-active', '--balloon'])
                        .catch(() => ({ stdout: '' }));
                    let vmSum = 0;
                    for (const m of stdout.matchAll(/balloon\\.rss=(\\d+)/g)) {
                        vmSum += parseInt(m[1], 10) * 1024;
                    }
                    vm = vmSum;
                    __umVmBytes = vmSum;
                    __umVmTs = Date.now();
                }
            } catch (_e) { vm = __umVmBytes; }
            // whatever's left over
            const system = Math.max(0, used - (zfsCache + docker + vm));
            base.zfsCache = BigInt(zfsCache);
            base.docker   = BigInt(docker);
            base.vm       = BigInt(vm);
            base.system   = BigInt(system);
        } catch (_e) {}
        return base;
    };
})();
"""
)


def _patch_bundle(bundle: str) -> bool:
    """Apply both phases to *bundle*. Returns True if the bundle was modified."""
    with open(bundle, "r") as fh:
        content = fh.read()

    # Already patched? leave it alone.
    if BUNDLE_MARKER in content:
        return False

    modified = False

    # Phase 1a: add the four field names to the MemoryUtilization class body.
    old_class = (
        "class MemoryUtilization extends Node {\n"
        "    total;\n"
        "    used;\n"
        "    free;\n"
        "    available;\n"
        "    active;\n"
        "    buffcache;\n"
        "    percentTotal;\n"
        "    swapTotal;\n"
        "    swapUsed;\n"
        "    swapFree;\n"
        "    percentSwapTotal;\n"
        "}"
    )
    new_class = (
        "class MemoryUtilization extends Node {\n"
        "    total;\n"
        "    used;\n"
        "    free;\n"
        "    available;\n"
        "    active;\n"
        "    buffcache;\n"
        "    percentTotal;\n"
        "    swapTotal;\n"
        "    swapUsed;\n"
        "    swapFree;\n"
        "    percentSwapTotal;\n"
        "    zfsCache;\n"
        "    docker;\n"
        "    vm;\n"
        "    system;\n"
        "}"
    )
    if old_class not in content:
        log("memory-breakdown patch: MemoryUtilization class body shape changed, aborting")
        return False
    content = content.replace(old_class, new_class, 1)
    modified = True
    log("memory-breakdown: Phase 1a — class body extended")

    # Phase 1b: register the four fields with @Field decorators, after the
    # last existing one (percentSwapTotal).
    pst_anchor = '], MemoryUtilization.prototype, "percentSwapTotal", void 0);'
    d = find_decorator_suffix(content, pst_anchor)
    m = find_metadata_suffix(content, pst_anchor)
    if not d or not m:
        log(
            f"memory-breakdown patch: missing MemoryUtilization decorator suffix "
            f"(d={d}, m={m}), aborting"
        )
        return False

    def _field_block(prop: str, desc: str) -> str:
        return (
            f"_ts_decorate${d}([\n"
            f"    Field(()=>GraphQLBigInt, {{ nullable: true, description: '{desc}' }}),\n"
            f"    _ts_metadata${m}('design:type', Object)\n"
            f"], MemoryUtilization.prototype, '{prop}', void 0);\n"
        )

    new_decorator_blocks = (
        _field_block("zfsCache", "ZFS ARC cache size in bytes")
        + _field_block("docker",   "Total Docker container memory in bytes")
        + _field_block("vm",       "Total VM balloon RSS in bytes")
        + _field_block("system",   "OS/other memory not attributed to ZFS/Docker/VM, in bytes")
    )

    # Insert AFTER the complete percentSwapTotal decorator statement (not before
    # the closing `]`). Confirm the anchor appears exactly once.
    count = content.count(pst_anchor)
    if count != 1:
        log(
            f"memory-breakdown patch: percentSwapTotal decorator anchor found {count} times "
            f"(expected 1), aborting"
        )
        return False
    content = content.replace(pst_anchor, pst_anchor + "\n" + new_decorator_blocks, 1)
    log("memory-breakdown: Phase 1b — field decorators injected")

    # Phase 2: wrap MemoryService.prototype.generateMemoryLoad to compute
    # and attach the four values.
    count2 = content.count(_SERVICE_ANCHOR)
    if count2 != 1:
        log(
            f"memory-breakdown patch: MemoryService anchor found {count2} times "
            f"(expected 1), aborting"
        )
        return False
    idx = content.index(_SERVICE_ANCHOR) + len(_SERVICE_ANCHOR)
    content = content[:idx] + _OVERLAY + content[idx:]
    log("memory-breakdown: Phase 2 — generateMemoryLoad prototype wrap injected")

    with open(bundle, "w") as fh:
        fh.write(content)
    log(f"memory-breakdown patch applied ({os.path.basename(bundle)})")
    return True


def apply() -> bool:
    """Entry point called by the orchestrator (patch.py)."""
    bundle = find_bundle()
    if not bundle:
        log("memory-breakdown patch: no compatible bundle found")
        return False
    return _patch_bundle(bundle)
