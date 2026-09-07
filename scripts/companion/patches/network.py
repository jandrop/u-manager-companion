"""Network device data — InfoNetwork extras + DevicesService.generateNetwork().

`metrics.network` and the `systemMetricsNetwork` subscription used to
require this patch too, but upstream ships both natively from Unraid
API 4.35.0 onwards (with a different per-interface shape — see the
`unraid_api` package CLAUDE.md). This patch focuses only on the two
pieces still missing from upstream:

* `DevicesService.generateNetwork()` returns `[]` in stock unraid-api.
  We replace it with a real impl that reads `/sys/class/net` +
  `/proc/net/dev` + `lspci -mm` so `info.devices.network` surfaces
  every NIC/bond/bridge with vendor/model identity, the LAN IP
  inherited from a user bridge, and per-interface traffic rates.

* `InfoNetwork` upstream exposes only `iface/model/vendor/mac/virtual/
  speed/dhcp`. We extend it with `status`, `ipAddress`, `type` and the
  rx/tx counters so the app's network card has all the identity +
  utilisation data in one round-trip.

Anything resolver/subscription-side (`Metrics.network`,
`MetricsResolver.network`, `systemMetricsNetwork`) is now native and
no longer touched here.
"""
from __future__ import annotations

import os
import re

from companion._bundle import (
    find_bundle,
    find_decorator_suffix,
    find_metadata_suffix,
)
from companion._runtime import log

# `ipAddress` is added to `InfoNetwork` by this patch and never exists
# in upstream, so the single-quoted form `'ipAddress'` emitted by our
# `info_field` template is a safe idempotency check.
BUNDLE_MARKER = "InfoNetwork.prototype, 'ipAddress', void 0)"

# Body marker, bumped whenever generateNetwork() changes shape. BUNDLE_MARKER
# alone only proves *some* version of this patch is present, so on a box
# already carrying an older one it would bail out and leave the old resolver
# running until the next reboot restored a pristine bundle. Checking the body
# marker too lets a plugin upgrade re-patch in place. v2 dropped
# systeminformation's networkInterfaces() (hundreds of forks per call) and the
# one-second sampling sleep.
RESOLVER_MARKER = "/* u-manager-companion: network-resolver-v2 */"


def patch_bundle() -> bool:
    bundle = find_bundle()
    if not bundle:
        log("network patch: no compatible bundle found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    already_patched = BUNDLE_MARKER in content
    if already_patched and RESOLVER_MARKER in content:
        return False

    info_d = find_decorator_suffix(content, 'InfoNetwork.prototype, "dhcp", void 0)')
    info_m = find_metadata_suffix(content, 'InfoNetwork.prototype, "dhcp", void 0)')
    if not info_d or not info_m:
        log(
            f"network patch: missing InfoNetwork decorator suffix "
            f"(info={info_d}/{info_m})"
        )
        return False

    # ── 1. Extend InfoNetwork class body ─────────────────────────────────
    old_class = (
        "class InfoNetwork extends Node {\n"
        "    iface;\n"
        "    model;\n"
        "    vendor;\n"
        "    mac;\n"
        "    virtual;\n"
        "    speed;\n"
        "    dhcp;\n"
        "}"
    )
    new_class = (
        "class InfoNetwork extends Node {\n"
        "    iface;\n"
        "    model;\n"
        "    vendor;\n"
        "    mac;\n"
        "    virtual;\n"
        "    speed;\n"
        "    dhcp;\n"
        "    status;\n"
        "    ipAddress;\n"
        "    type;\n"
        "    rxBytes;\n"
        "    txBytes;\n"
        "    rxBytesPerSec;\n"
        "    txBytesPerSec;\n"
        "}"
    )
    if not already_patched:
        if old_class not in content:
            log("InfoNetwork class body shape changed, aborting")
            return False
        content = content.replace(old_class, new_class, 1)
    elif new_class not in content:
        # An older version of this patch already extended the class body but
        # in a shape we no longer recognise (upstream changed InfoNetwork, or
        # a stale patch predates `new_class`'s current field list). Refusing
        # to guess at a partial rewrite here — same fail-closed posture as
        # the pristine-bundle check above.
        log("InfoNetwork class body already extended in an unrecognised shape, aborting")
        return False

    # ── 2. Inject field decorators before ObjectType call ────────────────
    info_objectType_anchor = (
        f"InfoNetwork = _ts_decorate${info_d}([\n"
        f"    ObjectType({{\n"
        f"        implements: ()=>Node\n"
        f"    }})\n"
        f"], InfoNetwork);"
    )

    def info_field(prop: str, gtype: str, desc: str, js_type: str) -> str:
        return (
            f"_ts_decorate${info_d}([\n"
            f"    Field(()=>{gtype}, {{ nullable: true, description: '{desc}' }}),\n"
            f"    _ts_metadata${info_m}('design:type', {js_type})\n"
            f"], InfoNetwork.prototype, '{prop}', void 0);\n"
        )

    new_info_fields = (
        info_field("status", "String", "Connection status (connected/disconnected/unknown)", "String")
        + info_field("ipAddress", "String", "IPv4 address", "String")
        + info_field("type", "String", "Interface type (ethernet/bridge/bond/other)", "String")
        + info_field("rxBytes", "Float", "Total bytes received since last reset", "Number")
        + info_field("txBytes", "Float", "Total bytes transmitted since last reset", "Number")
        + info_field("rxBytesPerSec", "Float", "Current receive speed in bytes per second", "Number")
        + info_field("txBytesPerSec", "Float", "Current transmit speed in bytes per second", "Number")
    )
    if info_objectType_anchor not in content:
        log("InfoNetwork ObjectType decoration not found, aborting")
        return False
    if not already_patched:
        content = content.replace(info_objectType_anchor, new_info_fields + info_objectType_anchor, 1)

    # ── 3. Replace DevicesService.generateNetwork() with real impl ───────
    # Match the original stub (or any prior incomplete patch) up to before generateUsb.
    devices_pattern = re.compile(
        r"    async generateNetwork\(\) \{.*?\n    \}\n(?=    async generateUsb)",
        re.DOTALL,
    )
    new_generate_network = (
        r'''    async generateNetwork() {
        /* u-manager-companion: network-resolver-v2 */
        try {
            const { readFile, readdir } = await import('fs/promises');
            const { networkInterfaces: kernelInterfaces } = await import('os');

            // List every interface known to the kernel — includes enslaved
            // physical NICs (eth0/eth1) that systeminformation hides.
            const allIfaces = (await readdir('/sys/class/net/').catch(() => []))
                .filter((n) => n !== 'bonding_masters');

            // One readdir per interface, reused for both the real-interface
            // test and the `virtual` flag further down.
            const entriesByIface = new Map();
            await Promise.all(allIfaces.map(async (n) => {
                entriesByIface.set(n, await readdir(`/sys/class/net/${n}`).catch(() => []));
            }));

            // Real interfaces: physical NIC, bond, wireless, or loopback —
            // mirrors what Unraid's web UI exposes. Bridges, tunnels and Docker
            // virtual devices are filtered out.
            const isRealInterface = (name) => {
                if (name === 'lo') return true;
                const entries = entriesByIface.get(name) ?? [];
                return entries.includes('device') || entries.includes('bonding') || entries.includes('wireless');
            };
            const realIfaces = allIfaces.filter(isRealInterface);

            const parseTraffic = (raw) => {
                const map = new Map();
                for (const line of raw.split('\n').slice(2)) {
                    const m = line.trim().match(/^(\S+):\s+(\d+)(?:\s+\d+){6}\s+\d+\s+(\d+)/);
                    if (m) map.set(m[1], { rxBytes: parseFloat(m[2]), txBytes: parseFloat(m[3]) });
                }
                return map;
            };

            // Rate is computed against the PREVIOUS call's snapshot rather than
            // sleeping to take a second one. The old version blocked every
            // request for a full second purely to produce a delta; with the app
            // polling this field at 1Hz the previous sample is ~1s old anyway.
            // The first call after startup has no baseline, so the rates stay
            // undefined until the second one — the same shape this resolver
            // already returns when /proc/net/dev cannot be read.
            const sampledAt = Date.now();
            const snapNow = parseTraffic(await readFile('/proc/net/dev', 'utf8').catch(() => ''));
            const prevSample = globalThis.__umNetPrevSample;
            globalThis.__umNetPrevSample = { at: sampledAt, snap: snapNow };
            const elapsedSec = prevSample ? (sampledAt - prevSample.at) / 1000 : 0;

            // PCI vendor/model cannot change while the process lives, but
            // resolving it used to spawn lspci and walk sysfs on every single
            // request. Resolve once, then reuse.
            if (!globalThis.__umNetPciMap) {
                const lspciIndex = new Map();
                const lspci = await execa('lspci', ['-mm']).catch(() => null);
                if (lspci) {
                    for (const line of lspci.stdout.split('\n')) {
                        const parts = [];
                        let m;
                        const re = /"([^"]*)"/g;
                        while ((m = re.exec(line)) !== null) parts.push(m[1]);
                        if (parts.length >= 3) lspciIndex.set('0000:' + line.split(' ')[0], { vendor: parts[1], model: parts[2] });
                    }
                }
                // Resolve PCI slot for a (possibly bonded) interface — traverses
                // bond.active_slave so vendor/model surface on bond0 itself.
                // For virtio NICs (KVM/QEMU guests) /sys/class/net/<iface>/device
                // points to the virtio bus, not the PCI device itself; the PCI
                // uevent lives one directory up.
                const resolvePciSlot = async (name, depth = 0) => {
                    if (depth > 3) return null;
                    const direct = await readFile(`/sys/class/net/${name}/device/uevent`, 'utf8').catch(() => '');
                    let slotM = direct.match(/PCI_SLOT_NAME=(.+)/);
                    if (slotM) return slotM[1].trim();
                    const parent = await readFile(`/sys/class/net/${name}/device/../uevent`, 'utf8').catch(() => '');
                    slotM = parent.match(/PCI_SLOT_NAME=(.+)/);
                    if (slotM) return slotM[1].trim();
                    const slaves = await readFile(`/sys/class/net/${name}/bonding/slaves`, 'utf8').catch(() => '');
                    if (slaves.trim()) {
                        const activeSlave = await readFile(`/sys/class/net/${name}/bonding/active_slave`, 'utf8').catch(() => '');
                        return resolvePciSlot(activeSlave.trim() || slaves.trim().split(/\s+/)[0], depth + 1);
                    }
                    return null;
                };
                const built = new Map();
                await Promise.all(realIfaces.map(async (name) => {
                    const slot = await resolvePciSlot(name);
                    const pci = slot ? lspciIndex.get(slot) : undefined;
                    if (pci) built.set(name, pci);
                }));
                globalThis.__umNetPciMap = built;
            }
            const pciMap = globalThis.__umNetPciMap;

            // IPv4 addresses and MACs straight from the kernel via getifaddrs.
            // This replaces systeminformation's networkInterfaces(), which
            // shelled out to hundreds of child processes per call; under
            // concurrency those forks serialised and stalled the whole API.
            const ipByIface = new Map();
            const macByIface = new Map();
            for (const [name, addrs] of Object.entries(kernelInterfaces() ?? {})) {
                for (const addr of addrs ?? []) {
                    if (addr.family === 'IPv4' && !ipByIface.has(name)) ipByIface.set(name, addr.address);
                    if (addr.mac && addr.mac !== '00:00:00:00:00:00' && !macByIface.has(name)) macByIface.set(name, addr.mac);
                }
            }

            // `dhcp` also came from systeminformation. Unraid's own network.cfg
            // is the authoritative source: IFNAME[n] names the interface,
            // USE_DHCP[n] carries the setting, and BONDNICS[n] lists the
            // enslaved NICs that inherit it.
            const dhcpByIface = new Map();
            const netCfg = await readFile('/boot/config/network.cfg', 'utf8').catch(() => '');
            if (netCfg) {
                const cfgNames = new Map();
                const cfgSlaves = new Map();
                for (const m of netCfg.matchAll(/^IFNAME\[(\d+)\]="([^"]*)"/gm)) cfgNames.set(m[1], m[2]);
                for (const m of netCfg.matchAll(/^BONDNICS\[(\d+)\]="([^"]*)"/gm)) cfgSlaves.set(m[1], m[2].trim().split(/\s+/).filter(Boolean));
                for (const m of netCfg.matchAll(/^USE_DHCP\[(\d+)\]="([^"]*)"/gm)) {
                    const enabled = m[2] === 'yes';
                    const iface = cfgNames.get(m[1]);
                    if (iface) dhcpByIface.set(iface, enabled);
                    for (const slave of cfgSlaves.get(m[1]) ?? []) dhcpByIface.set(slave, enabled);
                }
            }

            // In typical Unraid setups the IP lives on a user bridge (br0)
            // that's built on top of a bond/NIC we DO expose. Walk every user
            // bridge and propagate its IP down to each brif port so bond0/eth
            // surface the LAN address the user actually cares about.
            const isUserBridge = (n) => n.startsWith('br') && !/^br-[a-f0-9]+$/.test(n);
            const inheritedIp = new Map();
            await Promise.all(allIfaces.filter(isUserBridge).map(async (bridge) => {
                const bridgeIp = ipByIface.get(bridge);
                if (!bridgeIp) return;
                const ports = await readdir(`/sys/class/net/${bridge}/brif`).catch(() => []);
                for (const port of ports) {
                    if (!inheritedIp.has(port)) inheritedIp.set(port, bridgeIp);
                }
            }));

            const deriveType = (name) => {
                if (name === 'lo') return 'loopback';
                if (/^(eth|em|ens|enp|en\d)/.test(name)) return 'ethernet';
                if (name.startsWith('bond')) return 'bond';
                if (name.startsWith('wlan') || name.startsWith('wifi')) return 'wireless';
                return 'other';
            };
            const mapStatus = (op) => op === 'up' ? 'connected' : op === 'down' ? 'disconnected' : 'unknown';

            return Promise.all(realIfaces.map(async (name) => {
                const entries = entriesByIface.get(name) ?? [];
                const [addressRaw, operstateRaw, speedText] = await Promise.all([
                    readFile(`/sys/class/net/${name}/address`, 'utf8').catch(() => ''),
                    readFile(`/sys/class/net/${name}/operstate`, 'utf8').catch(() => ''),
                    readFile(`/sys/class/net/${name}/speed`, 'utf8').catch(() => ''),
                ]);
                const mac = macByIface.get(name) || addressRaw.trim();
                const operstate = operstateRaw.trim();
                const parsedSpeed = parseInt(speedText.trim(), 10);
                const speedRaw = Number.isFinite(parsedSpeed) ? parsedSpeed : null;
                // realIfaces is, by construction, only physical NICs, bonds,
                // wireless adapters, and loopback (isRealInterface() above) --
                // Docker/veth/bridge/tunnel interfaces never reach this point.
                // None of those are "virtual" in the sense this field reports,
                // matching the fallback the pre-fork-storm code used whenever
                // systeminformation had no entry for a given interface.
                const virtual = false;
                // network.cfg has no concept of loopback DHCP -- it is never
                // DHCP-assigned, so report it deterministically rather than
                // leaving it null (systeminformation used to report this).
                const dhcp = name === 'lo' ? false : dhcpByIface.get(name);
                // Surface the upstream bridge's IP (e.g. br0 -> bond0) when
                // the interface has no IP of its own.
                const ip4 = ipByIface.get(name) ?? inheritedIp.get(name);
                const previous = prevSample?.snap.get(name);
                const current = snapNow.get(name);
                const pci = pciMap.get(name);
                const rxBytesPerSec = previous && current && elapsedSec > 0 ? Math.max(0, (current.rxBytes - previous.rxBytes) / elapsedSec) : undefined;
                const txBytesPerSec = previous && current && elapsedSec > 0 ? Math.max(0, (current.txBytes - previous.txBytes) / elapsedSec) : undefined;
                return {
                    id: `network/${name}`,
                    iface: name,
                    model: pci?.model ?? undefined,
                    vendor: pci?.vendor ?? undefined,
                    mac: mac || undefined,
                    virtual,
                    speed: speedRaw != null && speedRaw >= 0 ? `${speedRaw} Mbps` : undefined,
                    dhcp,
                    status: mapStatus(operstate),
                    ipAddress: ip4 || undefined,
                    type: deriveType(name),
                    rxBytes: current?.rxBytes ?? undefined,
                    txBytes: current?.txBytes ?? undefined,
                    rxBytesPerSec,
                    txBytesPerSec,
                };
            }));
        } catch (error) {
            this.logger.error(`Failed to generate network devices: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined);
            return [];
        }
    }
'''
    )
    new_content, replaced = devices_pattern.subn(lambda _m: new_generate_network, content, count=1)
    if replaced != 1:
        log("could not find DevicesService.generateNetwork() to replace")
        return False
    content = new_content

    with open(bundle, "w") as f:
        f.write(content)
    log(
        f"fixed network info (vendor/model fields) "
        f"({os.path.basename(bundle)})"
    )
    return True


def apply() -> bool:
    return patch_bundle()
