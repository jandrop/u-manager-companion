"""ArrayService: report the real array state, fixing stale `mdState`.

Unraid's GraphQL API resolves `array.state` from the in-memory emhttp
store (`emhttp.var.mdState`), which is NOT refreshed after the array is
started/stopped. So `{ array { state } }` goes stale AND the start/stop
mutation guard (`arrayIsRunning`) rejects the change ("already in that
state") even though the array really did change — the user gets stuck
and can't start/stop from the app (upstream unraid/api#1788).

The fix reads `mdState` fresh from `/var/local/emhttp/var.ini` (the same
file the WebGUI reads, always correct) at query time:

* a hoisted module-scope helper `__umFreshMdState(fallback)` reads the
  file and returns the live `mdState`, falling back to the stale store
  value if the file can't be read;
* `ArrayService.prototype.getArrayData` is wrapped so `result.state`
  reflects the live value (fixes the `state` query);
* `arrayIsRunning()` and `getArrayState()` (the start/stop guard) read
  the live value too (fixes start/stop from the app).

No sync `fs` is available in the bundle, so reads are async — fine here
because all three call sites are already `async`.

Tracked upstream at unraid/api#1788.
"""
from __future__ import annotations

import os

from companion._bundle import find_bundle
from companion._runtime import log

ARRAY_STATE_MARKER = "/* u-manager-companion: array-state fresh mdState */"

# Injected right after the ArrayService decoration statement. The helper
# is a top-level `async function` so it is hoisted and visible to the
# class methods that we rewrite below (which appear earlier in the file).
_OVERLAY = "\n" + ARRAY_STATE_MARKER + "\n" + r"""
async function __umFreshMdState(fallback) {
    try {
        const { readFile } = await import('node:fs/promises');
        const ini = await readFile('/var/local/emhttp/var.ini', 'utf8');
        const m = ini.match(/mdState="([^"]*)"/);
        if (m && m[1]) return m[1];
    } catch (e) {}
    return fallback;
}
;(() => {
    const proto = ArrayService.prototype;
    const orig = proto.getArrayData;
    proto.getArrayData = async function patchedGetArrayData() {
        const data = await orig.call(this);
        try { data.state = await __umFreshMdState(data.state); } catch (e) {}
        return data;
    };
})();
"""

# Unique anchors verified against the live bundle (each appears once).
_ANCHOR = "], ArrayService);"

_IS_RUNNING_OLD = "return emhttp.var.mdState === ArrayState.STARTED;"
_IS_RUNNING_NEW = (
    "return (await __umFreshMdState(emhttp.var.mdState)) === ArrayState.STARTED;"
)

_STATE_OLD = "return emhttp.var.mdState;"
_STATE_NEW = "return await __umFreshMdState(emhttp.var.mdState);"


def patch_array_state_bundle() -> bool:
    """Rewrite array-state reads in the bundle to use the live var.ini."""
    bundle = find_bundle()
    if not bundle:
        log("array-state patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if ARRAY_STATE_MARKER in content:
        return False

    if _ANCHOR not in content:
        log("array-state patch: ArrayService decoration anchor not found")
        return False
    if _IS_RUNNING_OLD not in content or _STATE_OLD not in content:
        log("array-state patch: mdState read anchors not found")
        return False

    # 1) inject the hoisted helper + getArrayData prototype override
    idx = content.index(_ANCHOR) + len(_ANCHOR)
    content = content[:idx] + _OVERLAY + content[idx:]

    # 2) make the start/stop guard and getArrayState read the live value.
    #    Order matters only cosmetically: the "=== STARTED" form is a
    #    superset string, but it ends in " === ..." not ";", so the
    #    bare "...mdState;" replace never touches it.
    content = content.replace(_IS_RUNNING_OLD, _IS_RUNNING_NEW, 1)
    content = content.replace(_STATE_OLD, _STATE_NEW, 1)

    with open(bundle, "w") as f:
        f.write(content)
    log(f"fixed stale array state after start/stop ({os.path.basename(bundle)})")
    return True


def apply() -> bool:
    """Entry point called by the orchestrator."""
    return patch_array_state_bundle()
