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


def patch_bundle() -> bool:
    bundle = find_bundle()
    if not bundle:
        log("network patch: no compatible bundle found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if BUNDLE_MARKER in content:
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
    if old_class not in content:
        log("InfoNetwork class body shape changed, aborting")
        return False
    content = content.replace(old_class, new_class, 1)

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
    content = content.replace(info_objectType_anchor, new_info_fields + info_objectType_anchor, 1)

    # ── 3. Replace DevicesService.generateNetwork() with real impl ───────
    # Match the original stub (or any prior incomplete patch) up to before generateUsb.
    devices_pattern = re.compile(
        r"    async generateNetwork\(\) \{.*?\n    \}\n(?=    async generateUsb)",
        re.DOTALL,
    )
    new_generate_network = (
        "    async generateNetwork() {\n"
        "        try {\n"
        "            const { readFile, readdir } = await import('fs/promises');\n"
        "            const SAMPLE_MS = 1000;\n"
        "\n"
        "            // List every interface known to the kernel — includes enslaved\n"
        "            // physical NICs (eth0/eth1) that systeminformation hides.\n"
        "            const allIfaces = (await readdir('/sys/class/net/').catch(() => []))\n"
        "                .filter((n) => n !== 'bonding_masters');\n"
        "\n"
        "            // Real interfaces: physical NIC, bond, wireless, or loopback —\n"
        "            // mirrors what Unraid's web UI exposes. Bridges, tunnels and Docker\n"
        "            // virtual devices are filtered out.\n"
        "            const isRealInterface = async (name) => {\n"
        "                if (name === 'lo') return true;\n"
        "                const entries = await readdir(`/sys/class/net/${name}`).catch(() => []);\n"
        "                return entries.includes('device') || entries.includes('bonding') || entries.includes('wireless');\n"
        "            };\n"
        "            const realIfaces = (await Promise.all(allIfaces.map(async (n) => [n, await isRealInterface(n)])))\n"
        "                .filter(([, ok]) => ok)\n"
        "                .map(([n]) => n);\n"
        "\n"
        "            const parseTraffic = (raw) => {\n"
        "                const map = new Map();\n"
        "                for (const line of raw.split('\\n').slice(2)) {\n"
        "                    const m = line.trim().match(/^(\\S+):\\s+(\\d+)(?:\\s+\\d+){6}\\s+\\d+\\s+(\\d+)/);\n"
        "                    if (m) map.set(m[1], { rxBytes: parseFloat(m[2]), txBytes: parseFloat(m[3]) });\n"
        "                }\n"
        "                return map;\n"
        "            };\n"
        "\n"
        "            const [sysInfoResult, snap1Result, lspciResult] = await Promise.allSettled([\n"
        "                networkInterfaces(),\n"
        "                readFile('/proc/net/dev', 'utf8'),\n"
        "                execa('lspci', ['-mm']),\n"
        "            ]);\n"
        "            const sysInfoByIface = new Map();\n"
        "            if (sysInfoResult.status === 'fulfilled') {\n"
        "                for (const i of sysInfoResult.value) sysInfoByIface.set(i.iface, i);\n"
        "            }\n"
        "            const snap1 = snap1Result.status === 'fulfilled' ? parseTraffic(snap1Result.value) : new Map();\n"
        "            const snap2 = await new Promise((resolve) =>\n"
        "                setTimeout(() => readFile('/proc/net/dev', 'utf8').then(parseTraffic).catch(() => new Map()).then(resolve), SAMPLE_MS)\n"
        "            );\n"
        "\n"
        "            const lspciIndex = new Map();\n"
        "            if (lspciResult.status === 'fulfilled') {\n"
        "                for (const line of lspciResult.value.stdout.split('\\n')) {\n"
        "                    const parts = [];\n"
        "                    let m;\n"
        "                    const re = /\"([^\"]*)\"/g;\n"
        "                    while ((m = re.exec(line)) !== null) parts.push(m[1]);\n"
        "                    if (parts.length >= 3) lspciIndex.set('0000:' + line.split(' ')[0], { vendor: parts[1], model: parts[2] });\n"
        "                }\n"
        "            }\n"
        "\n"
        "            // Resolve PCI slot for a (possibly bonded) interface — traverses\n"
        "            // bond.active_slave so vendor/model surface on bond0 itself.\n"
        "            // For virtio NICs (KVM/QEMU guests) /sys/class/net/<iface>/device\n"
        "            // points to the virtio bus, not the PCI device itself; the PCI\n"
        "            // uevent lives one directory up.\n"
        "            const resolvePciSlot = async (name, depth = 0) => {\n"
        "                if (depth > 3) return null;\n"
        "                const direct = await readFile(`/sys/class/net/${name}/device/uevent`, 'utf8').catch(() => '');\n"
        "                let slotM = direct.match(/PCI_SLOT_NAME=(.+)/);\n"
        "                if (slotM) return slotM[1].trim();\n"
        "                const parent = await readFile(`/sys/class/net/${name}/device/../uevent`, 'utf8').catch(() => '');\n"
        "                slotM = parent.match(/PCI_SLOT_NAME=(.+)/);\n"
        "                if (slotM) return slotM[1].trim();\n"
        "                const slaves = await readFile(`/sys/class/net/${name}/bonding/slaves`, 'utf8').catch(() => '');\n"
        "                if (slaves.trim()) {\n"
        "                    const activeSlave = await readFile(`/sys/class/net/${name}/bonding/active_slave`, 'utf8').catch(() => '');\n"
        "                    return resolvePciSlot(activeSlave.trim() || slaves.trim().split(/\\s+/)[0], depth + 1);\n"
        "                }\n"
        "                return null;\n"
        "            };\n"
        "            const pciMap = new Map();\n"
        "            await Promise.all(realIfaces.map(async (name) => {\n"
        "                const slot = await resolvePciSlot(name);\n"
        "                const pci = slot ? lspciIndex.get(slot) : undefined;\n"
        "                if (pci) pciMap.set(name, pci);\n"
        "            }));\n"
        "\n"
        "            // In typical Unraid setups the IP lives on a user bridge (br0)\n"
        "            // that's built on top of a bond/NIC we DO expose. Walk every user\n"
        "            // bridge and propagate its IP down to each brif port so bond0/eth\n"
        "            // surface the LAN address the user actually cares about.\n"
        "            const isUserBridge = (n) => n.startsWith('br') && !/^br-[a-f0-9]+$/.test(n);\n"
        "            const inheritedIp = new Map();\n"
        "            await Promise.all(allIfaces.filter(isUserBridge).map(async (bridge) => {\n"
        "                const bridgeInfo = sysInfoByIface.get(bridge);\n"
        "                const bridgeIp = bridgeInfo?.ip4;\n"
        "                if (!bridgeIp) return;\n"
        "                const ports = await readdir(`/sys/class/net/${bridge}/brif`).catch(() => []);\n"
        "                for (const port of ports) {\n"
        "                    if (!inheritedIp.has(port)) inheritedIp.set(port, bridgeIp);\n"
        "                }\n"
        "            }));\n"
        "\n"
        "            const deriveType = (name) => {\n"
        "                if (name === 'lo') return 'loopback';\n"
        "                if (/^(eth|em|ens|enp|en\\d)/.test(name)) return 'ethernet';\n"
        "                if (name.startsWith('bond')) return 'bond';\n"
        "                if (name.startsWith('wlan') || name.startsWith('wifi')) return 'wireless';\n"
        "                return 'other';\n"
        "            };\n"
        "            const mapStatus = (op) => op === 'up' ? 'connected' : op === 'down' ? 'disconnected' : 'unknown';\n"
        "\n"
        "            // For each real interface, prefer systeminformation; fall back to\n"
        "            // /sys/class/net/<name>/ for enslaved/missing ones.\n"
        "            return Promise.all(realIfaces.map(async (name) => {\n"
        "                const si = sysInfoByIface.get(name);\n"
        "                let mac, operstate, speedRaw, ip4, virtual, dhcp;\n"
        "                if (si) {\n"
        "                    mac = si.mac;\n"
        "                    operstate = si.operstate;\n"
        "                    speedRaw = si.speed;\n"
        "                    ip4 = si.ip4;\n"
        "                    virtual = si.virtual;\n"
        "                    dhcp = si.dhcp;\n"
        "                } else {\n"
        "                    mac = (await readFile(`/sys/class/net/${name}/address`, 'utf8').catch(() => '')).trim();\n"
        "                    operstate = (await readFile(`/sys/class/net/${name}/operstate`, 'utf8').catch(() => '')).trim();\n"
        "                    const sr = parseInt((await readFile(`/sys/class/net/${name}/speed`, 'utf8').catch(() => '')).trim(), 10);\n"
        "                    speedRaw = Number.isFinite(sr) ? sr : null;\n"
        "                    ip4 = undefined;\n"
        "                    virtual = false;\n"
        "                    dhcp = undefined;\n"
        "                }\n"
        "                // Surface the upstream bridge's IP (e.g. br0 -> bond0) when\n"
        "                // the interface has no IP of its own.\n"
        "                if (!ip4) ip4 = inheritedIp.get(name);\n"
        "                const t1 = snap1.get(name);\n"
        "                const t2 = snap2.get(name);\n"
        "                const pci = pciMap.get(name);\n"
        "                const rxBytesPerSec = t1 && t2 ? Math.max(0, (t2.rxBytes - t1.rxBytes) / (SAMPLE_MS / 1000)) : undefined;\n"
        "                const txBytesPerSec = t1 && t2 ? Math.max(0, (t2.txBytes - t1.txBytes) / (SAMPLE_MS / 1000)) : undefined;\n"
        "                return {\n"
        "                    id: `network/${name}`,\n"
        "                    iface: name,\n"
        "                    model: pci?.model ?? undefined,\n"
        "                    vendor: pci?.vendor ?? undefined,\n"
        "                    mac: mac || undefined,\n"
        "                    virtual,\n"
        "                    speed: speedRaw != null && speedRaw >= 0 ? `${speedRaw} Mbps` : undefined,\n"
        "                    dhcp,\n"
        "                    status: mapStatus(operstate),\n"
        "                    ipAddress: ip4 || undefined,\n"
        "                    type: deriveType(name),\n"
        "                    rxBytes: t1?.rxBytes ?? undefined,\n"
        "                    txBytes: t1?.txBytes ?? undefined,\n"
        "                    rxBytesPerSec,\n"
        "                    txBytesPerSec,\n"
        "                };\n"
        "            }));\n"
        "        } catch (error) {\n"
        "            this.logger.error(`Failed to generate network devices: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined);\n"
        "            return [];\n"
        "        }\n"
        "    }\n"
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
