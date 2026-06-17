"""Expose the array filesystem state (`fsState`) on `UnraidArray`.

`array.state` is `mdState` (STARTED/STOPPED only — a closed enum). The
Unraid WebGUI shows the transitional "Starting"/"Stopping" status, which
comes from `fsState` in `/var/local/emhttp/var.ini` and is NOT exposed by
the official GraphQL API. So while the filesystems are still mounting the
app shows "Started" with 0 B capacity, instead of "Starting".

This patch adds a new nullable `fsState: String` field on the
`UnraidArray` GraphQL type so the app can show the transitional state and
fall back to `array.state` when the companion isn't installed:

* the field is registered on the `UnraidArray` model in the index bundle
  (`index-*.js`), mirroring how `shares.py` adds `ArrayDisk.shareEnabled`;
* the value is populated from `var.ini`'s `fsState` line by wrapping
  `ArrayService.prototype.getArrayData` in the plugin bundle (a second
  wrapper on top of the one `array_state.py` installs — order-independent,
  each sets a different property).

Kept separate from `array_state.py` (own markers) so it applies on top of
an already-patched bundle without a pristine restore.
"""
from __future__ import annotations

import glob
import os

from companion._bundle import INDEX_BUNDLE_GLOB, find_bundle
from companion._runtime import log

FIELD_MARKER = "/* u-manager-companion: array fsState field */"
VALUE_MARKER = "/* u-manager-companion: array fsState value */"

# Existing UnraidArray field decoration we anchor the new field after.
_FIELD_ANCHOR = '], UnraidArray.prototype, "state", void 0);'

_FIELD_BLOCK = (
    _FIELD_ANCHOR + "\n" + FIELD_MARKER + "\n"
    "_ts_decorate([\n"
    "    Field(()=>String, {\n"
    "        nullable: true,\n"
    "        description: 'Filesystem state of the array "
    "(Started/Starting/Stopping/Stopped) from var.ini. Surfaces the "
    "mount/unmount transition that array.state (mdState) cannot express.'\n"
    "    }),\n"
    '    _ts_metadata("design:type", Object)\n'
    '], UnraidArray.prototype, "fsState", void 0);\n'
)

# Plugin-bundle anchor: end of the ArrayService decoration statement.
_VALUE_ANCHOR = "], ArrayService);"

_VALUE_OVERLAY = "\n" + VALUE_MARKER + "\n" + r"""
;(() => {
    const proto = ArrayService.prototype;
    const orig = proto.getArrayData;
    proto.getArrayData = async function patchedGetArrayDataFsState() {
        const data = await orig.call(this);
        try {
            const { readFile } = await import('node:fs/promises');
            const ini = await readFile('/var/local/emhttp/var.ini', 'utf8');
            const m = ini.match(/fsState="([^"]*)"/);
            data.fsState = (m && m[1]) ? m[1] : null;
        } catch (e) { data.fsState = null; }
        return data;
    };
})();
"""


def patch_fsstate_field() -> bool:
    """Register the `fsState` Field on the UnraidArray model (index bundle)."""
    bundle = next(
        (
            p
            for p in glob.glob(INDEX_BUNDLE_GLOB)
            if _FIELD_ANCHOR in open(p).read()
        ),
        None,
    )
    if not bundle:
        log("array-fsstate field: index bundle with UnraidArray not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if FIELD_MARKER in content:
        return False
    content = content.replace(_FIELD_ANCHOR, _FIELD_BLOCK, 1)
    with open(bundle, "w") as f:
        f.write(content)
    log(f"enabled array filesystem state field in API ({os.path.basename(bundle)})")
    return True


def patch_fsstate_value() -> bool:
    """Populate `data.fsState` from var.ini in getArrayData (plugin bundle)."""
    bundle = find_bundle()
    if not bundle:
        log("array-fsstate value: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if VALUE_MARKER in content:
        return False
    if _VALUE_ANCHOR not in content:
        log("array-fsstate value: ArrayService decoration not found")
        return False
    idx = content.index(_VALUE_ANCHOR) + len(_VALUE_ANCHOR)
    content = content[:idx] + _VALUE_OVERLAY + content[idx:]
    with open(bundle, "w") as f:
        f.write(content)
    log(f"enabled array filesystem state value in API ({os.path.basename(bundle)})")
    return True


def apply() -> bool:
    """Entry point called by the orchestrator."""
    field = patch_fsstate_field()
    value = patch_fsstate_value()
    return field or value
