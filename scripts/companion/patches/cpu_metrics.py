"""CPU live metrics — frequency + load average on CpuUtilization.

Unraid's GraphQL `CpuUtilization` type exposes only `percentTotal` and the
per-core `cpus` array. This patch adds four nullable Float fields with live
data the stock API does not surface:

  * ``frequency``     — average current core frequency in MHz (/proc/cpuinfo)
  * ``loadAverage1``  — 1-minute system load average (/proc/loadavg)
  * ``loadAverage5``  — 5-minute system load average
  * ``loadAverage15`` — 15-minute system load average

These ride the existing CPU subscription/query: `CpuUtilization` is returned
by both `metrics.cpu` and `systemMetricsCpu`, so the app gets the values at
the same ~1 Hz cadence with no extra polling.

Patch is idempotent: ``apply()`` returns ``False`` immediately if the marker
is already in the bundle (safe to re-run on every boot / API upgrade).

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
BUNDLE_MARKER = "CpuUtilization.prototype, 'loadAverage15', void 0)"

_SERVICE_MARKER = "/* u-manager-companion: cpu metrics */"

# Tail of the CpuService decoration; appears once in plugin.module-*.js.
_SERVICE_ANCHOR = "], CpuService);"

# Wrap injected after the CpuService decoration. Reads /proc/loadavg and
# /proc/cpuinfo via fs.promises on each tick — both are cheap in-memory
# kernel files, so no caching is needed.
_OVERLAY = (
    "\n"
    + _SERVICE_MARKER
    + "\n"
    + """;(() => {
    const __umOrigGenCpu = CpuService.prototype.generateCpuLoad;
    CpuService.prototype.generateCpuLoad = async function patchedGenCpuLoad() {
        const base = await __umOrigGenCpu.apply(this, arguments);
        try {
            const { readFile } = await import('node:fs/promises');
            // System load average (1/5/15 min) from /proc/loadavg.
            try {
                const la = await readFile('/proc/loadavg', 'utf8');
                const p = la.trim().split(/\\s+/);
                if (p.length >= 3) {
                    base.loadAverage1 = parseFloat(p[0]);
                    base.loadAverage5 = parseFloat(p[1]);
                    base.loadAverage15 = parseFloat(p[2]);
                }
            } catch (_e) {}
            // Live average core frequency in MHz from /proc/cpuinfo.
            try {
                const info = await readFile('/proc/cpuinfo', 'utf8');
                let sum = 0, n = 0;
                for (const mm of info.matchAll(/cpu MHz\\s*:\\s*([0-9.]+)/g)) {
                    sum += parseFloat(mm[1]); n++;
                }
                if (n > 0) base.frequency = sum / n;
            } catch (_e) {}
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

    # Phase 1a: add the four field names to the CpuUtilization class body.
    old_class = (
        "class CpuUtilization extends Node {\n"
        "    percentTotal;\n"
        "    cpus;\n"
        "}"
    )
    new_class = (
        "class CpuUtilization extends Node {\n"
        "    percentTotal;\n"
        "    cpus;\n"
        "    frequency;\n"
        "    loadAverage1;\n"
        "    loadAverage5;\n"
        "    loadAverage15;\n"
        "}"
    )
    if old_class not in content:
        log("cpu-metrics patch: CpuUtilization class body shape changed, aborting")
        return False
    content = content.replace(old_class, new_class, 1)
    log("cpu-metrics: Phase 1a — class body extended")

    # Phase 1b: register the four fields with @Field decorators, after the
    # last existing one (cpus).
    cpus_anchor = '], CpuUtilization.prototype, "cpus", void 0);'
    d = find_decorator_suffix(content, cpus_anchor)
    m = find_metadata_suffix(content, cpus_anchor)
    if not d or not m:
        log(
            f"cpu-metrics patch: missing CpuUtilization decorator suffix "
            f"(d={d}, m={m}), aborting"
        )
        return False

    def _field_block(prop: str, desc: str) -> str:
        return (
            f"_ts_decorate${d}([\n"
            f"    Field(()=>Float, {{ nullable: true, description: '{desc}' }}),\n"
            f"    _ts_metadata${m}('design:type', Number)\n"
            f"], CpuUtilization.prototype, '{prop}', void 0);\n"
        )

    new_decorator_blocks = (
        _field_block("frequency", "Average current core frequency in MHz")
        + _field_block("loadAverage1", "1-minute system load average")
        + _field_block("loadAverage5", "5-minute system load average")
        + _field_block("loadAverage15", "15-minute system load average")
    )

    # Insert AFTER the complete cpus decorator statement. Confirm the anchor
    # appears exactly once.
    count = content.count(cpus_anchor)
    if count != 1:
        log(
            f"cpu-metrics patch: cpus decorator anchor found {count} times "
            f"(expected 1), aborting"
        )
        return False
    content = content.replace(cpus_anchor, cpus_anchor + "\n" + new_decorator_blocks, 1)
    log("cpu-metrics: Phase 1b — field decorators injected")

    # Phase 2: wrap CpuService.prototype.generateCpuLoad to compute and attach
    # the four values.
    count2 = content.count(_SERVICE_ANCHOR)
    if count2 != 1:
        log(
            f"cpu-metrics patch: CpuService anchor found {count2} times "
            f"(expected 1), aborting"
        )
        return False
    idx = content.index(_SERVICE_ANCHOR) + len(_SERVICE_ANCHOR)
    content = content[:idx] + _OVERLAY + content[idx:]
    log("cpu-metrics: Phase 2 — generateCpuLoad prototype wrap injected")

    with open(bundle, "w") as fh:
        fh.write(content)
    log(f"cpu-metrics patch applied ({os.path.basename(bundle)})")
    return True


def apply() -> bool:
    """Entry point called by the orchestrator (patch.py)."""
    bundle = find_bundle()
    if not bundle:
        log("cpu-metrics patch: no compatible bundle found")
        return False
    return _patch_bundle(bundle)
