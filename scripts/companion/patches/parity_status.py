"""ArrayService: report the real parity-check status, fixing a paused
check that the stock API reports as `cancelled`.

The API resolves `array.parityCheckStatus` from the in-memory emhttp
store (`getParityCheckStatus(emhttp.var)`), which is NOT refreshed after
a parity check is paused. `mdResyncPos` goes stale at `0` while the real
`/var/local/emhttp/var.ini` holds the saved position, so the (otherwise
correct) upstream status logic falls through to the leftover
`sbSyncExit === -4 -> CANCELLED` branch. The dashboard card only shows
for `running`/`paused`, so a paused check silently disappears.

The status LOGIC is upstream and correct (unraid/api `parity-check-status.ts`,
added in #1611); only the `var` data feeding it is stale — the same class
of bug as `array_state.py` (mdState staleness, #1788). This patch reads the
resync fields fresh from `var.ini` at query time and re-derives `status`,
`progress` and `speed`, mirroring the upstream computation byte-for-byte.

No sync `fs` is available in the bundle, so the read is async — fine, the
wrapped `getArrayData` is already `async` (same call site array_state.py
wraps).
"""
from __future__ import annotations

import os

from companion._bundle import find_bundle
from companion._runtime import log

PARITY_STATUS_MARKER = "/* u-manager-companion: parity fresh resync vars */"

# Injected right after the ArrayService decoration statement (same anchor
# array_state.py uses). Both overlays compose: each wraps the previous
# `getArrayData`, so `state` and `parityCheckStatus` are both refreshed.
_OVERLAY = "\n" + PARITY_STATUS_MARKER + "\n" + r"""
async function __umFreshResyncVars() {
    try {
        const { readFile } = await import('node:fs/promises');
        const ini = await readFile('/var/local/emhttp/var.ini', 'utf8');
        const num = (k) => {
            const m = ini.match(new RegExp(k + '="?(-?[0-9]+)'));
            return m ? Number(m[1]) : undefined;
        };
        return {
            mdResyncPos: num('mdResyncPos'),
            mdResyncDt: num('mdResyncDt'),
            mdResyncDb: num('mdResyncDb'),
            mdResyncSize: num('mdResyncSize'),
            sbSynced: num('sbSynced'),
            sbSynced2: num('sbSynced2'),
            sbSyncExit: num('sbSyncExit'),
        };
    } catch (e) { return null; }
}
;(() => {
    const proto = ArrayService.prototype;
    const orig = proto.getArrayData;
    proto.getArrayData = async function patchedGetArrayDataParity() {
        const data = await orig.call(this);
        try {
            const v = await __umFreshResyncVars();
            const p = data && data.parityCheckStatus;
            if (v && p) {
                const pos = v.mdResyncPos ?? 0, dt = v.mdResyncDt ?? 0;
                const db = v.mdResyncDb ?? 0, size = v.mdResyncSize ?? 0;
                const s1 = v.sbSynced ?? 0, s2 = v.sbSynced2 ?? 0, ex = v.sbSyncExit ?? 0;
                let status;
                if (pos > 0) status = dt > 0 ? 'running' : 'paused';
                else if (s1 === 0) status = 'never_run';
                else if (ex === -4) status = 'cancelled';
                else if (ex !== 0) status = 'failed';
                else if (s2 > 0) status = 'completed';
                else status = 'never_run';
                p.status = status;
                p.progress = size <= 0 ? 0 : Math.round(Math.min(100, Math.max(0, (pos / size) * 100)));
                p.speed = String((dt === 0 || db === 0) ? 0 : Math.round((db * 1024) / dt / 1024 / 1024));
            }
        } catch (e) {}
        return data;
    };
})();
"""

# Unique anchor verified against the live bundle (appears once).
_ANCHOR = "], ArrayService);"


def patch_parity_status_bundle() -> bool:
    """Recompute parityCheckStatus from the live var.ini resync fields."""
    bundle = find_bundle()
    if not bundle:
        log("parity-status patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if PARITY_STATUS_MARKER in content:
        return False
    if _ANCHOR not in content:
        log("parity-status patch: ArrayService decoration anchor not found")
        return False

    idx = content.index(_ANCHOR) + len(_ANCHOR)
    content = content[:idx] + _OVERLAY + content[idx:]

    with open(bundle, "w") as f:
        f.write(content)
    log(f"fixed stale parity status when paused ({os.path.basename(bundle)})")
    return True


def apply() -> bool:
    """Entry point called by the orchestrator."""
    return patch_parity_status_bundle()
