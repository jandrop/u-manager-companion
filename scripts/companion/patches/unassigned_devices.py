"""Expose filesystem and size info for unassigned disks via a new GraphQL
query field `unassignedDevicesInfo`.

The stock `assignableDisks` field returns `Disk` objects whose
`partitions[].fsType` is a non-nullable closed enum (XFS/BTRFS/…). Any
exotic filesystem (NTFS, exFAT, swap) causes the entire GraphQL response
to fail with "Cannot return null for non-nullable field". Geometry fields
(`bytesPerSector`, `totalCylinders`, …) are similarly `Float!` but arrive
null for spun-down disks — another crash vector.

This patch avoids the landmine by adding a parallel query field
`unassignedDevicesInfo: [UnassignedDeviceInfo!]!` backed by
`lsblk -b -J`, which returns plain nullable strings/floats. The
`UnassignedDeviceInfo` type exposes:

  device      String!   — device path (/dev/sdj)
  fsType      String    — filesystem label (ntfs, ext4, btrfs, …) or null
  size        Float     — partition/disk size in bytes or null
  used        Float     — used bytes or null
  free        Float     — free bytes or null
  usedPercent Float     — 0-100 or null

The resolver cross-references `lsblk` output against
`DisksService.getAssignableDisks()` so only unassigned disks are returned.
ZFS members and squashfs are excluded (no useful FS stats available).
"""
from __future__ import annotations

import os

from companion._bundle import find_bundle, find_decorator_suffix, find_metadata_suffix
from companion._runtime import log

MARKER = "/* u-manager-companion: unassigned-devices-info */"

# Stable anchor: the class body that we extend with the new method.
_CLASS_BODY_OLD = (
    "class DisksResolver {\n"
    "    disksService;\n"
    "    constructor(disksService){\n"
    "        this.disksService = disksService;\n"
    "    }\n"
    "    async disks() {\n"
    "        return this.disksService.getDisks();\n"
    "    }\n"
    "    async assignableDisks() {\n"
    "        return this.disksService.getAssignableDisks();\n"
    "    }\n"
    "    async disk(id) {\n"
    "        return this.disksService.getDisk(id);\n"
    "    }\n"
    "    async temperature(disk) {\n"
    "        return this.disksService.getTemperature(disk.device);\n"
    "    }\n"
    "    async isSpinning(disk) {\n"
    "        return disk.isSpinning;\n"
    "    }\n"
    "}"
)

_NEW_METHOD = (
    "    async unassignedDevicesInfo() {\n"
    "        try {\n"
    "            const assignable = await this.disksService.getAssignableDisks();\n"
    "            const assignableSet = new Set(assignable.map(d => d.device));\n"
    "            const { stdout } = await execa('lsblk', ['-b', '-J', '-o', 'NAME,SIZE,FSTYPE,FSAVAIL,FSUSE%,MOUNTPOINT']);\n"
    "            const parsed = JSON.parse(stdout);\n"
    "            const devices = Array.isArray(parsed?.blockdevices) ? parsed.blockdevices : [];\n"
    "            const results = [];\n"
    "            for (const dev of devices) {\n"
    "                const devicePath = '/dev/' + dev.name;\n"
    "                if (!assignableSet.has(devicePath)) continue;\n"
    "                let fsType = null, size = null, used = null, free = null, usedPercent = null;\n"
    "                const partitions = Array.isArray(dev.children) ? dev.children : [];\n"
    "                const candidates = partitions.length > 0 ? partitions : [dev];\n"
    "                for (const c of candidates) {\n"
    "                    if (!c.fstype || c.fstype === 'zfs_member' || c.fstype === 'squashfs') continue;\n"
    "                    fsType = c.fstype;\n"
    "                    size = typeof c.size === 'number' ? c.size : null;\n"
    "                    free = typeof c.fsavail === 'number' ? c.fsavail : null;\n"
    "                    if (typeof c['fsuse%'] === 'string') {\n"
    "                        const pct = parseInt(c['fsuse%'], 10);\n"
    "                        if (!isNaN(pct)) usedPercent = pct;\n"
    "                    }\n"
    "                    if (size !== null && free !== null) used = size - free;\n"
    "                    break;\n"
    "                }\n"
    "                if (size === null && typeof dev.size === 'number') size = dev.size;\n"
    "                results.push({ device: devicePath, fsType, size, used, free, usedPercent });\n"
    "            }\n"
    "            return results;\n"
    "        } catch (err) {\n"
    "            return [];\n"
    "        }\n"
    "    }\n"
)


def patch_unassigned_devices_bundle() -> bool:
    """Add `UnassignedDeviceInfo` ObjectType and `unassignedDevicesInfo` Query
    to `DisksResolver`, backed by lsblk so filesystem info is safe to query
    even on exotic or spun-down disks.
    """
    bundle = find_bundle()
    if not bundle:
        log("unassigned-devices patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if MARKER in content:
        return False

    # ── Resolve minified decorator/metadata suffixes ──────────────────────
    anchor = 'DisksResolver.prototype, "assignableDisks", null)'
    d = find_decorator_suffix(content, anchor)
    m = find_metadata_suffix(content, anchor)
    if not d or not m:
        log(f"unassigned-devices patch: could not resolve suffixes (d={d} m={m})")
        return False

    # ── 1. Add unassignedDevicesInfo() to DisksResolver class body ─────────
    class_body_new = (
        "class DisksResolver {\n"
        "    disksService;\n"
        "    constructor(disksService){\n"
        "        this.disksService = disksService;\n"
        "    }\n"
        "    async disks() {\n"
        "        return this.disksService.getDisks();\n"
        "    }\n"
        "    async assignableDisks() {\n"
        "        return this.disksService.getAssignableDisks();\n"
        "    }\n"
        "    async disk(id) {\n"
        "        return this.disksService.getDisk(id);\n"
        "    }\n"
        "    async temperature(disk) {\n"
        "        return this.disksService.getTemperature(disk.device);\n"
        "    }\n"
        "    async isSpinning(disk) {\n"
        "        return disk.isSpinning;\n"
        "    }\n"
        + _NEW_METHOD
        + "}"
    )
    if _CLASS_BODY_OLD not in content:
        log("unassigned-devices patch: DisksResolver class body shape changed, aborting")
        return False
    content = content.replace(_CLASS_BODY_OLD, class_body_new, 1)

    # ── 2. Inject UnassignedDeviceInfo type + Query decorator ──────────────
    #
    # Inserted right after the `assignableDisks` Query decorator so that
    # it sits in the same scope with the same decorator identifiers.
    #
    assignable_dec_end = f'], DisksResolver.prototype, "assignableDisks", null);'
    if assignable_dec_end not in content:
        log("unassigned-devices patch: assignableDisks decorator end not found, aborting")
        return False

    def field(prop: str, gtype: str, desc: str, js_type: str, nullable: bool = True) -> str:
        opts = f"{{ nullable: true, description: '{desc}' }}" if nullable else f"{{ description: '{desc}' }}"
        return (
            f"_ts_decorate${d}([\n"
            f"    Field(()=>{gtype}, {opts}),\n"
            f"    _ts_metadata${m}('design:type', {js_type})\n"
            f"], UnassignedDeviceInfo.prototype, '{prop}', void 0);\n"
        )

    new_type_and_decorator = (
        "\n" + MARKER + "\n"
        "class UnassignedDeviceInfo {\n"
        "    device;\n"
        "    fsType;\n"
        "    size;\n"
        "    used;\n"
        "    free;\n"
        "    usedPercent;\n"
        "}\n"
        + field("device", "String", "Device path (e.g. /dev/sdc)", "String", nullable=False)
        + field("fsType", "String", "Filesystem type (ntfs, ext4, btrfs…) or null if unformatted", "String")
        + field("size", "Float", "Partition/disk size in bytes", "Number")
        + field("used", "Float", "Used bytes (size minus free)", "Number")
        + field("free", "Float", "Free bytes available", "Number")
        + field("usedPercent", "Float", "Used percentage 0-100", "Number")
        + f"UnassignedDeviceInfo = _ts_decorate${d}([\n"
        f"    ObjectType({{ description: 'Filesystem and size info for an unassigned disk' }})\n"
        f"], UnassignedDeviceInfo);\n"
        f"_ts_decorate${d}([\n"
        f"    Query(()=>[UnassignedDeviceInfo]),\n"
        f"    UsePermissions({{\n"
        f"        action: AuthAction.READ_ANY,\n"
        f"        resource: Resource.DISK\n"
        f"    }}),\n"
        f"    _ts_metadata${m}('design:type', Function),\n"
        f"    _ts_metadata${m}('design:paramtypes', []),\n"
        f"    _ts_metadata${m}('design:returntype', Promise)\n"
        f'], DisksResolver.prototype, "unassignedDevicesInfo", null);\n'
    )

    content = content.replace(
        assignable_dec_end,
        assignable_dec_end + new_type_and_decorator,
        1,
    )

    with open(bundle, "w") as f:
        f.write(content)
    log(f"enabled unassigned-devices filesystem info in API ({os.path.basename(bundle)})")
    return True


def apply() -> bool:
    """Entry point called by the orchestrator."""
    return patch_unassigned_devices_bundle()
