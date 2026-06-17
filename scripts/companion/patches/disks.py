"""DisksService: stop waking spun-down drives on `{ disks { ... } }`.

Replaces `DisksService.prototype.getDisks` so it never calls
`systeminformation.diskLayout()` (which shells out to
`smartctl --xall` per device without `-n standby`). The replacement
mirrors the official webGUI strategy: identity from `lsblk`/sysfs,
SMART status via `smartctl -n standby -H` for spinning drives only.

Tracked upstream at unraid/api#2018.
"""
from __future__ import annotations

import os
import re

from companion._bundle import find_bundle
from companion._runtime import log

DISKS_SERVICE_MARKER = "/* u-manager-companion: disks-service no-wake */"

def patch_disks_service_bundle() -> bool:
    """Reimplement `DisksService.getDisks` so it never wakes spun-down
    drives.

    Upstream calls `diskLayout()` from the `systeminformation` npm
    package, which shells out to `smartctl --xall` per disk. Without
    `-n standby`, that command issues ATA IDENTIFY/READ LOG to every
    device, which makes modern large HDDs (Seagate Exos ≥16 TB, WD Gold
    ≥16 TB, etc.) leave standby and spin up the platters. The official
    Unraid web UI never does this — it relies on the cached
    `disks.ini` for identity and shells out to `smartctl -n standby -H`
    only for the SMART health.

    This patch replaces `getDisks` with an implementation that mirrors
    the web UI strategy:

    * Identity (vendor/model/serial/firmware/transport) comes from
      `lsblk -d -J -O`, which reads sysfs only.
    * `smartStatus` comes from `smartctl -n standby -H -j`. If the
      drive is asleep `smartctl` exits with code 2 without touching it
      and the patch returns `UNKNOWN`.
    * Partitions come from `blockDevices()` (lsblk under the hood),
      same as upstream.
    * `parseDisk` on the prototype is reused as-is — we just feed it
      the shape it already expects.

    Tracked upstream: u_manager GitHub issue #32, will file an upstream
    bug at unraid/api once the client-side workaround ships.
    """
    bundle = find_bundle()
    if not bundle:
        log("disks-service patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if DISKS_SERVICE_MARKER in content:
        return False

    anchor_re = re.compile(
        r"DisksService = _ts_decorate\$[\w$]+\(\[\s*Injectable\(\)\s*,",
    )
    match = anchor_re.search(content)
    if not match:
        log("disks-service patch: anchor not found")
        return False

    # Find the end of the full decoration statement (`], DisksService);`).
    closing = content.find("], DisksService);", match.end())
    if closing == -1:
        log("disks-service patch: closing of decoration not found")
        return False
    insert_at = closing + len("], DisksService);")

    overlay = "\n" + DISKS_SERVICE_MARKER + "\n" + r"""
;(() => {
    const proto = DisksService.prototype;

    // lsblk reports `vendor: "ATA"` for any SATA drive sitting behind
    // a SAS HBA — useless for the UI. Derive the real manufacturer from
    // the model string instead. Falls back to whatever lsblk says when
    // we don't recognise the prefix (e.g. NVMe, USB enclosures).
    function deriveVendor(rawVendor, model) {
        const trimmed = (rawVendor || '').trim();
        const looksGeneric = !trimmed || trimmed.toUpperCase() === 'ATA';
        if (!looksGeneric) return trimmed;
        const m = (model || '').trim().toUpperCase();
        if (m.startsWith('WDC') || m.startsWith('WD_') || m.startsWith('WD ')) return 'Western Digital';
        if (m.startsWith('ST') && /^ST\d/.test(m)) return 'Seagate';
        if (m.startsWith('HGST') || m.startsWith('HUH') || m.startsWith('HUS')) return 'HGST';
        if (m.startsWith('TOSHIBA') || m.startsWith('HDWE') || m.startsWith('MG0')) return 'Toshiba';
        if (m.startsWith('SAMSUNG') || m.startsWith('MZ') || m.startsWith('PM')) return 'Samsung';
        if (m.startsWith('CRUCIAL') || m.startsWith('CT')) return 'Crucial';
        if (m.startsWith('INTEL') || m.startsWith('SSDSC')) return 'Intel';
        if (m.startsWith('KINGSTON') || m.startsWith('SA400') || m.startsWith('SUV')) return 'Kingston';
        if (m.startsWith('SANDISK')) return 'SanDisk';
        if (m.startsWith('MICRON') || m.startsWith('MTFD')) return 'Micron';
        return trimmed;
    }

    // Skip virtual / non-rotational block devices that lsblk enumerates
    // but that the legacy `diskLayout()` from systeminformation filtered
    // out: zram swap, loop mounts, md/dm aggregates, cdrom/floppy etc.
    function isPhysicalDisk(d) {
        if (d?.type !== 'disk') return false;
        const name = (d.name || '').trim();
        const RX = /^(sd[a-z]|hd[a-z]|nvme\d+n\d+|mmcblk\d+)$/;
        return RX.test(name);
    }

    async function listDisksViaLsblk() {
        const { stdout } = await execa('lsblk', ['-d', '-J', '-O']);
        let parsed;
        try { parsed = JSON.parse(stdout); } catch (e) { return []; }
        const devices = Array.isArray(parsed?.blockdevices) ? parsed.blockdevices : [];
        return devices
            .filter(isPhysicalDisk)
            .map((d) => ({
                device: d.path || ('/dev/' + d.name),
                name: (d.model || '').trim(),
                vendor: deriveVendor(d.vendor, d.model),
                serialNum: (d.serial || d.wwn || '').trim(),
                firmwareRevision: (d.rev || '').trim(),
                interfaceType: (d.tran || '').trim(),
                size: typeof d.size === 'number' ? d.size : (parseInt(d.size, 10) || 0),
                type: 'disk',
            }));
    }

    async function getSmartStatusSafe(device) {
        try {
            const result = await execa('smartctl', ['-n', 'standby', '-H', '-j', device], {
                reject: false,
                timeout: 5000,
            });
            // exit code 2 = "Device is in STANDBY mode" (per smartctl docs).
            // Do not return real status — disk was not queried.
            if (result.exitCode === 2) return 'UNKNOWN';
            const parsed = JSON.parse(result.stdout || '{}');
            const passed = parsed?.smart_status?.passed;
            if (passed === true) return 'OK';
            if (passed === false) return 'FAIL';
            return 'UNKNOWN';
        } catch (e) {
            return 'UNKNOWN';
        }
    }

    proto.getDisks = async function patchedGetDisks() {
        const partitions = (await blockDevices()).filter((d) => d.type === 'part');
        const arrayDisks = this.configService.get('store.emhttp.disks', []) || [];

        const lsblkDisks = await listDisksViaLsblk();
        const enriched = await Promise.all(lsblkDisks.map(async (d) => ({
            ...d,
            smartStatus: await getSmartStatusSafe(d.device),
        })));

        const { data } = await batchProcess(enriched, async (disk) =>
            this.parseDisk(disk, partitions, arrayDisks),
        );
        return data;
    };
})();
"""

    content = content[:insert_at] + overlay + content[insert_at:]
    with open(bundle, "w") as f:
        f.write(content)
    log(f"prevented disk spin-up when fetching disk info ({os.path.basename(bundle)})")
    return True


def apply() -> bool:
    return patch_disks_service_bundle()
