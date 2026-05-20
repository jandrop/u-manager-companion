#!/usr/bin/env python3
"""
U-Manager Companion: Patch the Unraid API GraphQL bundle to add network
metrics that the official API ships as stubs or doesn't ship at all.

The script is idempotent — it can be re-run after every boot or unraid-api
update with no effect if the patches are already applied.

Patches applied:
  1. Add NETWORK_UTILIZATION channel to the shared pubsub enum
  2. info.devices.network query: implement the stubbed-out generateNetwork()
     so it returns real interfaces with status, IP, vendor, model, traffic
     totals and current bytes-per-second.
  3. metrics.network query + systemMetricsNetwork subscription with 1s polling.
  4. docker.logs resolver: capture both stdout and stderr from `docker logs`,
     so containers that only emit on stderr (Python apps, Caddy, AdGuard, ...)
     return their log lines instead of an empty array.
  5. parityCheck.resume mutation: send the same emhttpd field names the web
     UI submits (cmdCheckResume/cmdCheckPause/cmdCheckCancel), so a paused
     parity check resumes from its saved position instead of restarting
     from zero.
  6. Power mutations: add `shutdownServer`, `rebootServer` and `sleepServer`
     to the GraphQL Mutation root. They shell out to /usr/local/sbin/powerdown
     and the Dynamix S3 Sleep plugin's rc.s3sleep respectively, gated by the
     same UPDATE_ANY / SERVERS permission as `updateServerIdentity`.

Tracking issue (upstream): https://github.com/unraid/api/issues/1818
"""
from __future__ import annotations

import glob
import os
import re
import sys
from typing import Optional

PUBSUB_FILE = "/usr/local/unraid-api/node_modules/@unraid/shared/dist/pubsub/graphql.pubsub.js"
BUNDLE_GLOB = "/usr/local/unraid-api/dist/assets/plugin.module-*.js"

# Idempotency markers — presence means "already patched"
PUBSUB_MARKER = "NETWORK_UTILIZATION"
BUNDLE_MARKER = "class NetworkUtilization extends Node"


def log(msg: str) -> None:
    print(f"[u-manager-companion] {msg}", file=sys.stderr)


def find_decorator_suffix(content: str, anchor: str) -> Optional[str]:
    """Find the `_ts_decorate$XXX` suffix used near a known anchor.

    Vite/terser sometimes mints identifiers containing `$` (e.g. `1$`,
    `2$A`), so the suffix charclass needs to accept `$` in addition to
    the usual `\\w` characters.
    """
    idx = content.find(anchor)
    if idx == -1:
        return None
    chunk = content[max(0, idx - 800) : idx]
    matches = re.findall(r"_ts_decorate\$([\w$]+)\(\[", chunk)
    return matches[-1] if matches else None


def find_metadata_suffix(content: str, anchor: str) -> Optional[str]:
    idx = content.find(anchor)
    if idx == -1:
        return None
    chunk = content[max(0, idx - 800) : idx]
    matches = re.findall(r"_ts_metadata\$([\w$]+)\(", chunk)
    return matches[-1] if matches else None


def patch_pubsub() -> bool:
    if not os.path.exists(PUBSUB_FILE):
        log(f"pubsub enum file not found at {PUBSUB_FILE}")
        return False
    with open(PUBSUB_FILE, "r") as f:
        content = f.read()
    if PUBSUB_MARKER in content:
        return False
    anchor = 'GRAPHQL_PUBSUB_CHANNEL["MEMORY_UTILIZATION"] = "MEMORY_UTILIZATION";'
    if anchor not in content:
        log("pubsub anchor not found, skipping")
        return False
    content = content.replace(
        anchor,
        anchor + '\n    GRAPHQL_PUBSUB_CHANNEL["NETWORK_UTILIZATION"] = "NETWORK_UTILIZATION";',
        1,
    )
    with open(PUBSUB_FILE, "w") as f:
        f.write(content)
    log("patched pubsub enum")
    return True


def find_bundle() -> Optional[str]:
    for path in glob.glob(BUNDLE_GLOB):
        with open(path, "r") as f:
            content = f.read()
        if "class MetricsResolver" in content and "class InfoNetwork extends Node" in content:
            return path
    return None


def patch_bundle() -> bool:
    bundle = find_bundle()
    if not bundle:
        log("no compatible bundle found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if BUNDLE_MARKER in content:
        return False

    # Extract decorator suffixes used by each target class.
    info_d = find_decorator_suffix(content, 'InfoNetwork.prototype, "dhcp", void 0)')
    info_m = find_metadata_suffix(content, 'InfoNetwork.prototype, "dhcp", void 0)')
    metrics_d = find_decorator_suffix(content, 'Metrics.prototype, "memory", void 0)')
    metrics_m = find_metadata_suffix(content, 'Metrics.prototype, "memory", void 0)')
    resolver_d = find_decorator_suffix(content, 'MetricsResolver.prototype, "memory", null)')
    resolver_m = find_metadata_suffix(content, 'MetricsResolver.prototype, "memory", null)')

    if not all([info_d, info_m, metrics_d, metrics_m, resolver_d, resolver_m]):
        log(
            f"could not extract all decorator suffixes "
            f"(info={info_d}/{info_m} metrics={metrics_d}/{metrics_m} "
            f"resolver={resolver_d}/{resolver_m})"
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
        "            const resolvePciSlot = async (name, depth = 0) => {\n"
        "                if (depth > 3) return null;\n"
        "                const uevent = await readFile(`/sys/class/net/${name}/device/uevent`, 'utf8').catch(() => '');\n"
        "                const slotM = uevent.match(/PCI_SLOT_NAME=(.+)/);\n"
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

    # ── 4. Add NetworkInterfaceUtilization + NetworkUtilization types + Metrics.network ──
    new_types = (
        "class NetworkInterfaceUtilization {\n"
        "    iface;\n"
        "    rxBytes;\n"
        "    txBytes;\n"
        "    rxBytesPerSec;\n"
        "    txBytesPerSec;\n"
        "}\n"
        f"_ts_decorate${metrics_d}([\n"
        f"    Field(()=>String, {{ description: 'Interface name' }}),\n"
        f"    _ts_metadata${metrics_m}('design:type', String)\n"
        f"], NetworkInterfaceUtilization.prototype, 'iface', void 0);\n"
        f"_ts_decorate${metrics_d}([\n"
        f"    Field(()=>Float, {{ description: 'Total bytes received' }}),\n"
        f"    _ts_metadata${metrics_m}('design:type', Number)\n"
        f"], NetworkInterfaceUtilization.prototype, 'rxBytes', void 0);\n"
        f"_ts_decorate${metrics_d}([\n"
        f"    Field(()=>Float, {{ description: 'Total bytes transmitted' }}),\n"
        f"    _ts_metadata${metrics_m}('design:type', Number)\n"
        f"], NetworkInterfaceUtilization.prototype, 'txBytes', void 0);\n"
        f"_ts_decorate${metrics_d}([\n"
        f"    Field(()=>Float, {{ description: 'Current receive speed (B/s)' }}),\n"
        f"    _ts_metadata${metrics_m}('design:type', Number)\n"
        f"], NetworkInterfaceUtilization.prototype, 'rxBytesPerSec', void 0);\n"
        f"_ts_decorate${metrics_d}([\n"
        f"    Field(()=>Float, {{ description: 'Current transmit speed (B/s)' }}),\n"
        f"    _ts_metadata${metrics_m}('design:type', Number)\n"
        f"], NetworkInterfaceUtilization.prototype, 'txBytesPerSec', void 0);\n"
        f"NetworkInterfaceUtilization = _ts_decorate${metrics_d}([\n"
        f"    ObjectType({{ description: 'Network utilization for a single interface' }})\n"
        f"], NetworkInterfaceUtilization);\n\n"
        "class NetworkUtilization extends Node {\n"
        "    interfaces;\n"
        "}\n"
        f"_ts_decorate${metrics_d}([\n"
        f"    Field(()=>[NetworkInterfaceUtilization], {{ description: 'Per-interface utilization' }}),\n"
        f"    _ts_metadata${metrics_m}('design:type', Array)\n"
        f"], NetworkUtilization.prototype, 'interfaces', void 0);\n"
        f"NetworkUtilization = _ts_decorate${metrics_d}([\n"
        f"    ObjectType({{ implements: ()=>Node, description: 'Snapshot of network utilization' }})\n"
        f"], NetworkUtilization);\n\n"
    )

    old_metrics_class = "class Metrics extends Node {\n    cpu;\n    memory;\n    temperature;\n}"
    new_metrics_class = (
        new_types
        + "class Metrics extends Node {\n    cpu;\n    memory;\n    network;\n    temperature;\n}"
    )
    if old_metrics_class not in content:
        log("Metrics class body shape changed, aborting")
        return False
    content = content.replace(old_metrics_class, new_metrics_class, 1)

    old_temp_dec = (
        f"_ts_decorate${metrics_d}([\n"
        f"    Field(()=>TemperatureMetrics, {{\n"
        f"        nullable: true,\n"
        f"        description: 'Temperature metrics'\n"
        f"    }}),\n"
        f'    _ts_metadata${metrics_m}("design:type", typeof TemperatureMetrics === "undefined" ? Object : TemperatureMetrics)\n'
        f'], Metrics.prototype, "temperature", void 0);'
    )
    new_temp_plus_network = old_temp_dec + (
        f"\n_ts_decorate${metrics_d}([\n"
        f"    Field(()=>NetworkUtilization, {{\n"
        f"        description: 'Current network utilization metrics',\n"
        f"        nullable: true\n"
        f"    }}),\n"
        f'    _ts_metadata${metrics_m}("design:type", typeof NetworkUtilization === "undefined" ? Object : NetworkUtilization)\n'
        f'], Metrics.prototype, "network", void 0);'
    )
    if old_temp_dec not in content:
        log("Metrics temperature decorator not found, aborting")
        return False
    content = content.replace(old_temp_dec, new_temp_plus_network, 1)

    # ── 5. Modify MetricsResolver ────────────────────────────────────────
    old_logger = "    logger = new Logger(MetricsResolver.name);"
    new_logger = "    networkPreviousSnapshot = new Map();\n    logger = new Logger(MetricsResolver.name);"
    if old_logger not in content:
        log("MetricsResolver logger field not found, aborting")
        return False
    content = content.replace(old_logger, new_logger, 1)

    old_memory_polling = (
        "this.subscriptionTracker.registerTopic(GRAPHQL_PUBSUB_CHANNEL.MEMORY_UTILIZATION, async ()=>{\n"
        "            const payload = await this.memoryService.generateMemoryLoad();\n"
        "            pubsub.publish(GRAPHQL_PUBSUB_CHANNEL.MEMORY_UTILIZATION, {\n"
        "                systemMetricsMemory: payload\n"
        "            });\n"
        "        }, 2000);"
    )
    network_polling = (
        "this.subscriptionTracker.registerTopic('NETWORK_UTILIZATION', async ()=>{\n"
        "            try {\n"
        "                const { readFile, readdir } = await import('fs/promises');\n"
        "                const raw = await readFile('/proc/net/dev', 'utf8').catch(() => '');\n"
        "                const now = Date.now();\n"
        "                const current = new Map();\n"
        "                for (const line of raw.split('\\n').slice(2)) {\n"
        "                    const m = line.trim().match(/^(\\S+):\\s+(\\d+)(?:\\s+\\d+){6}\\s+\\d+\\s+(\\d+)/);\n"
        "                    if (m) current.set(m[1], { rxBytes: parseFloat(m[2]), txBytes: parseFloat(m[3]), timestamp: now });\n"
        "                }\n"
        "                const isReal = async (name) => {\n"
        "                    if (name === 'lo') return true;\n"
        "                    const entries = await readdir(`/sys/class/net/${name}`).catch(() => []);\n"
        "                    return entries.includes('device') || entries.includes('bonding') || entries.includes('wireless');\n"
        "                };\n"
        "                const interfaces = [];\n"
        "                for (const [iface, sample] of current.entries()) {\n"
        "                    if (!await isReal(iface)) continue;\n"
        "                    const previous = this.networkPreviousSnapshot.get(iface);\n"
        "                    let rxBytesPerSec = 0;\n"
        "                    let txBytesPerSec = 0;\n"
        "                    if (previous) {\n"
        "                        const deltaSeconds = (sample.timestamp - previous.timestamp) / 1000;\n"
        "                        if (deltaSeconds > 0) {\n"
        "                            rxBytesPerSec = Math.max(0, (sample.rxBytes - previous.rxBytes) / deltaSeconds);\n"
        "                            txBytesPerSec = Math.max(0, (sample.txBytes - previous.txBytes) / deltaSeconds);\n"
        "                        }\n"
        "                    }\n"
        "                    interfaces.push({ iface, rxBytes: sample.rxBytes, txBytes: sample.txBytes, rxBytesPerSec, txBytesPerSec });\n"
        "                }\n"
        "                this.networkPreviousSnapshot = current;\n"
        "                pubsub.publish('NETWORK_UTILIZATION', {\n"
        "                    systemMetricsNetwork: { id: 'metrics/network', interfaces }\n"
        "                });\n"
        "            } catch (err) {\n"
        "                this.logger.warn('Failed to publish network metrics: ' + String(err));\n"
        "            }\n"
        "        }, 1000);"
    )
    if old_memory_polling not in content:
        log("memory polling registration not found, aborting")
        return False
    content = content.replace(
        old_memory_polling, old_memory_polling + "\n        " + network_polling, 1
    )

    old_memory_method = (
        "    async memory() {\n"
        "        return this.memoryService.generateMemoryLoad();\n"
        "    }"
    )
    new_methods = old_memory_method + (
        "\n"
        "    async network() {\n"
        "        try {\n"
        "            const { readFile, readdir } = await import('fs/promises');\n"
        "            const parseTraffic = (raw, now) => {\n"
        "                const map = new Map();\n"
        "                for (const line of raw.split('\\n').slice(2)) {\n"
        "                    const m = line.trim().match(/^(\\S+):\\s+(\\d+)(?:\\s+\\d+){6}\\s+\\d+\\s+(\\d+)/);\n"
        "                    if (m) map.set(m[1], { rxBytes: parseFloat(m[2]), txBytes: parseFloat(m[3]), timestamp: now });\n"
        "                }\n"
        "                return map;\n"
        "            };\n"
        "            const isReal = async (name) => {\n"
        "                if (name === 'lo') return true;\n"
        "                const entries = await readdir(`/sys/class/net/${name}`).catch(() => []);\n"
        "                return entries.includes('device') || entries.includes('bonding') || entries.includes('wireless');\n"
        "            };\n"
        "            const raw1 = await readFile('/proc/net/dev', 'utf8').catch(() => '');\n"
        "            const t1 = parseTraffic(raw1, Date.now());\n"
        "            await new Promise((resolve) => setTimeout(resolve, 1000));\n"
        "            const raw2 = await readFile('/proc/net/dev', 'utf8').catch(() => '');\n"
        "            const t2 = parseTraffic(raw2, Date.now());\n"
        "            const interfaces = [];\n"
        "            for (const [iface, sample] of t2.entries()) {\n"
        "                if (!await isReal(iface)) continue;\n"
        "                const previous = t1.get(iface);\n"
        "                let rxBytesPerSec = 0;\n"
        "                let txBytesPerSec = 0;\n"
        "                if (previous) {\n"
        "                    const deltaSeconds = (sample.timestamp - previous.timestamp) / 1000;\n"
        "                    if (deltaSeconds > 0) {\n"
        "                        rxBytesPerSec = Math.max(0, (sample.rxBytes - previous.rxBytes) / deltaSeconds);\n"
        "                        txBytesPerSec = Math.max(0, (sample.txBytes - previous.txBytes) / deltaSeconds);\n"
        "                    }\n"
        "                }\n"
        "                interfaces.push({ iface, rxBytes: sample.rxBytes, txBytes: sample.txBytes, rxBytesPerSec, txBytesPerSec });\n"
        "            }\n"
        "            return { id: 'metrics/network', interfaces };\n"
        "        } catch (err) {\n"
        "            this.logger.warn('Failed to compute network metrics: ' + String(err));\n"
        "            return { id: 'metrics/network', interfaces: [] };\n"
        "        }\n"
        "    }\n"
        "    async systemMetricsNetworkSubscription() {\n"
        "        return this.subscriptionHelper.createTrackedSubscription('NETWORK_UTILIZATION');\n"
        "    }"
    )
    if old_memory_method not in content:
        log("memory() method not found, aborting")
        return False
    content = content.replace(old_memory_method, new_methods, 1)

    old_memory_resolvefield_dec = (
        f"_ts_decorate${resolver_d}([\n"
        f"    ResolveField(()=>MemoryUtilization, {{\n"
        f"        nullable: true\n"
        f"    }}),\n"
        f'    _ts_metadata${resolver_m}("design:type", Function),\n'
        f'    _ts_metadata${resolver_m}("design:paramtypes", []),\n'
        f'    _ts_metadata${resolver_m}("design:returntype", Promise)\n'
        f'], MetricsResolver.prototype, "memory", null);'
    )
    new_network_resolvefield = old_memory_resolvefield_dec + (
        f"\n_ts_decorate${resolver_d}([\n"
        f"    ResolveField(()=>NetworkUtilization, {{\n"
        f"        nullable: true\n"
        f"    }}),\n"
        f'    _ts_metadata${resolver_m}("design:type", Function),\n'
        f'    _ts_metadata${resolver_m}("design:paramtypes", []),\n'
        f'    _ts_metadata${resolver_m}("design:returntype", Promise)\n'
        f'], MetricsResolver.prototype, "network", null);'
    )
    if old_memory_resolvefield_dec not in content:
        log("memory ResolveField decorator not found, aborting")
        return False
    content = content.replace(old_memory_resolvefield_dec, new_network_resolvefield, 1)

    old_memory_sub_dec_end = (
        '], MetricsResolver.prototype, "systemMetricsMemorySubscription", null);'
    )
    new_sub_dec_end = old_memory_sub_dec_end + (
        f"\n_ts_decorate${resolver_d}([\n"
        f"    Subscription(()=>NetworkUtilization, {{\n"
        f"        name: 'systemMetricsNetwork',\n"
        f"        resolve: (value)=>value.systemMetricsNetwork\n"
        f"    }}),\n"
        f"    UsePermissions({{\n"
        f"        action: AuthAction.READ_ANY,\n"
        f"        resource: Resource.INFO\n"
        f"    }}),\n"
        f'    _ts_metadata${resolver_m}("design:type", Function),\n'
        f'    _ts_metadata${resolver_m}("design:paramtypes", []),\n'
        f'    _ts_metadata${resolver_m}("design:returntype", Promise)\n'
        f'], MetricsResolver.prototype, "systemMetricsNetworkSubscription", null);'
    )
    if old_memory_sub_dec_end not in content:
        log("memory Subscription decorator end not found, aborting")
        return False
    content = content.replace(old_memory_sub_dec_end, new_sub_dec_end, 1)

    with open(bundle, "w") as f:
        f.write(content)
    log(f"patched bundle {os.path.basename(bundle)}")
    return True


DOCKER_STATS_MARKER = "/* u-manager-companion: docker-stats override */"


def patch_docker_stats_bundle() -> bool:
    """Replace `DockerStatsService` runtime so it streams from the Docker
    socket (dockerode) instead of spawning the `docker stats` CLI.

    The CLI re-uses the same /containers/<id>/stats sample for the whole
    invocation window — cumulative counters like `NetIO` stay frozen
    between subscription emissions. The socket endpoint always returns
    a fresh kernel sample. Verified locally on 2026-05-16:
      docker stats        → frozen `40.1GB / 220GB`
      socket API stream   → rx +109 MB in 3s (36 MB/s) while torrent
                            downloads.

    Monkey-patches `DockerStatsService.prototype.startStatsStream` /
    `stopStatsStream` after the class has been decorated by NestJS, so
    the existing module registration and DI keep working. The injected
    code reuses `getDockerClient`, `pubsub` and `GRAPHQL_PUBSUB_CHANNEL`
    that are already in the module scope.

    Tracked upstream: PR pending on the unraid-api fork.
    """
    bundle = find_bundle()
    if not bundle:
        log("docker-stats patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if DOCKER_STATS_MARKER in content:
        return False

    anchor_re = re.compile(
        r"DockerStatsService = _ts_decorate\$[\w$]+\(\[\s*Injectable\(\)\s*\],\s*DockerStatsService\);"
    )
    match = anchor_re.search(content)
    if not match:
        log("docker-stats patch: anchor not found")
        return False

    overlay = "\n" + DOCKER_STATS_MARKER + "\n" + r"""
;(() => {
    const proto = DockerStatsService.prototype;
    function formatBytes(b) {
        if (b < 1024) return `${b}B`;
        if (b < 1048576) return `${(b/1024).toFixed(1)}KiB`;
        if (b < 1073741824) return `${(b/1048576).toFixed(1)}MiB`;
        if (b < 1099511627776) return `${(b/1073741824).toFixed(2)}GiB`;
        return `${(b/1099511627776).toFixed(2)}TiB`;
    }
    function cpuPct(d) {
        const cd = d.cpu_stats.cpu_usage.total_usage - d.precpu_stats.cpu_usage.total_usage;
        const sd = (d.cpu_stats.system_cpu_usage ?? 0) - (d.precpu_stats.system_cpu_usage ?? 0);
        const oc = d.cpu_stats.online_cpus ?? 1;
        if (sd <= 0 || cd < 0) return 0;
        return (cd / sd) * oc * 100;
    }
    function memUsed(d) {
        return Math.max(0, (d.memory_stats.usage ?? 0) - (d.memory_stats.stats?.cache ?? 0));
    }
    function sumNet(n) {
        let rx = 0, tx = 0;
        if (n) for (const v of Object.values(n)) { rx += v.rx_bytes ?? 0; tx += v.tx_bytes ?? 0; }
        return { rx, tx };
    }
    function sumBlk(es) {
        let r = 0, w = 0;
        if (es) for (const e of es) {
            if (e.op === 'Read' || e.op === 'read') r += e.value;
            else if (e.op === 'Write' || e.op === 'write') w += e.value;
        }
        return { r, w };
    }
    function destroyStream(s) {
        try { if (s && typeof s.destroy === 'function') s.destroy(); } catch (e) {}
    }

    proto.startStatsStream = async function patchedStart() {
        if (this._dockerodeActive) return;
        this._dockerodeActive = true;
        this._dockerodeStreams = new Map();
        this.logger.log('Starting docker stats stream (u-manager-companion: dockerode override)');
        const docker = getDockerClient();
        const openFor = (id) => {
            if (!this._dockerodeActive || this._dockerodeStreams.has(id)) return;
            docker.getContainer(id).stats({ stream: true }).then((stream) => {
                if (!this._dockerodeActive) { destroyStream(stream); return; }
                this._dockerodeStreams.set(id, stream);
                stream.on('data', (chunk) => {
                    try {
                        const d = JSON.parse(chunk.toString());
                        const usage = memUsed(d);
                        const limit = d.memory_stats.limit ?? 0;
                        const { rx, tx } = sumNet(d.networks);
                        const { r, w } = sumBlk(d.blkio_stats?.io_service_bytes_recursive);
                        pubsub.publish(GRAPHQL_PUBSUB_CHANNEL.DOCKER_STATS, {
                            dockerContainerStats: {
                                id,
                                cpuPercent: cpuPct(d),
                                memUsage: formatBytes(usage) + ' / ' + formatBytes(limit),
                                memPercent: limit > 0 ? (usage / limit) * 100 : 0,
                                netIO: formatBytes(rx) + ' / ' + formatBytes(tx),
                                blockIO: formatBytes(r) + ' / ' + formatBytes(w),
                            },
                        });
                    } catch (e) { /* per-chunk parse errors are non-fatal */ }
                });
                stream.on('error', () => { destroyStream(stream); this._dockerodeStreams.delete(id); });
                stream.on('end', () => { this._dockerodeStreams.delete(id); });
            }).catch(() => { /* container may have stopped between list and stats */ });
        };
        try {
            const list = await docker.listContainers();
            for (const c of list) openFor(c.Id);
            docker.getEvents({ filters: { type: ['container'] } }).then((events) => {
                this._dockerodeEvents = events;
                events.on('data', (chunk) => {
                    try {
                        const evt = JSON.parse(chunk.toString());
                        if (evt.Type !== 'container') return;
                        const id = evt.id;
                        if (!id) return;
                        if (evt.Action === 'start') openFor(id);
                        else if (['die','stop','kill','destroy'].includes(evt.Action)) {
                            const s = this._dockerodeStreams.get(id);
                            if (s) { destroyStream(s); this._dockerodeStreams.delete(id); }
                        }
                    } catch (e) {}
                });
                events.on('error', () => {});
            }).catch(() => {});
        } catch (err) {
            this.logger.error('Failed to start patched docker stats', err);
            this._dockerodeActive = false;
        }
    };

    proto.stopStatsStream = function patchedStop() {
        if (!this._dockerodeActive) return;
        this._dockerodeActive = false;
        this.logger.log('Stopping docker stats stream (patched)');
        if (this._dockerodeStreams) {
            for (const s of this._dockerodeStreams.values()) destroyStream(s);
            this._dockerodeStreams.clear();
        }
        if (this._dockerodeEvents) { destroyStream(this._dockerodeEvents); this._dockerodeEvents = null; }
    };
})();
"""
    insert_at = match.end()
    content = content[:insert_at] + overlay + content[insert_at:]
    with open(bundle, "w") as f:
        f.write(content)
    log(f"patched docker-stats override in {os.path.basename(bundle)}")
    return True


DOCKER_LOGS_OLD = (
    "const { stdout } = await execa('docker', args);\n"
    "            const lines = this.parseDockerLogOutput(stdout);"
)
DOCKER_LOGS_NEW = (
    "const { all } = await execa('docker', args, { all: true });\n"
    "            const lines = this.parseDockerLogOutput(all);"
)


def patch_docker_logs_bundle() -> bool:
    """Capture both stdout and stderr in DockerLogService.getContainerLogs().

    The upstream resolver shells out to `docker logs --timestamps --tail N
    <id>` via execa and only reads `.stdout`. Containers that write to
    stderr (most Python apps, Caddy, AdGuard, ...) return an empty array.

    Switching to execa's `{ all: true }` mode merges both streams into
    `.all` while keeping the per-line `--timestamps` prefix, so the
    existing parser and cursor logic work unchanged.
    """
    bundle = find_bundle()
    if not bundle:
        log("docker-logs patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if DOCKER_LOGS_NEW in content:
        return False
    if DOCKER_LOGS_OLD not in content:
        log("docker-logs patch: original getContainerLogs shape not found")
        return False
    content = content.replace(DOCKER_LOGS_OLD, DOCKER_LOGS_NEW, 1)
    with open(bundle, "w") as f:
        f.write(content)
    log(f"patched docker-logs stderr capture in {os.path.basename(bundle)}")
    return True


DOCKER_REFRESH_OLD = (
    "        } catch (error) {\n"
    "            this.logger.error(`Failed to update container ${containerName}:`, error);\n"
    "            throw new Error(`Failed to update container ${containerName}`);\n"
    "        }\n"
    "        const updatedContainers = await this.getContainers();"
)
DOCKER_REFRESH_NEW = (
    "        } catch (error) {\n"
    "            this.logger.error(`Failed to update container ${containerName}:`, error);\n"
    "            throw new Error(`Failed to update container ${containerName}`);\n"
    "        }\n"
    "        /* u-manager-companion: refresh-digests-post-update */\n"
    "        try {\n"
    "            await this.dockerManifestService.refreshDigests();\n"
    "        } catch (error) {\n"
    "            this.logger.warn(`Failed to refresh digests after updating ${containerName}: ${error instanceof Error ? error.message : String(error)}`);\n"
    "        }\n"
    "        const updatedContainers = await this.getContainers();"
)


def patch_docker_refresh_bundle() -> bool:
    """Refresh the docker update-status cache after `updateContainer` returns.

    The official `update_container` script writes the cache inline via
    `setUpdateStatus()` when Docker emits a top-level "Digest:" event during
    the pull stream. That event isn't guaranteed for every pull — when the
    registry returns the digest under a per-layer `id` instead of a clean
    top-level summary line, the cache keeps the pre-update `local` digest.

    The result is a freshly-updated container that the app's
    `containerUpdateStatuses` query keeps reporting as UPDATE_AVAILABLE
    until the user manually clicks "Check for updates" in the web UI
    (which calls `DockerTemplates->getAllInfo(true)` → `reloadUpdateStatus`).

    This patch makes `DockerService.updateContainer` call
    `dockerManifestService.refreshDigests()` after the script finishes, so
    the cache is repopulated with fresh local/remote digests in the same
    flow that already happens on "Check for updates". Wrapped in
    try/catch so a refresh failure (offline registry, slow remote) never
    breaks the mutation itself.

    Tracked upstream: PR pending on the unraid-api fork
    (`fix/docker-update-refresh-digests`).
    """
    bundle = find_bundle()
    if not bundle:
        log("docker-refresh patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if "/* u-manager-companion: refresh-digests-post-update */" in content:
        return False
    if DOCKER_REFRESH_OLD not in content:
        log("docker-refresh patch: updateContainer shape not found")
        return False
    content = content.replace(DOCKER_REFRESH_OLD, DOCKER_REFRESH_NEW, 1)
    with open(bundle, "w") as f:
        f.write(content)
    log(f"patched docker-refresh post-update in {os.path.basename(bundle)}")
    return True


PARITY_RESUME_OLD = (
    "const states = {\n"
    "            pause: {\n"
    "                cmdNoCheck: 'Pause'\n"
    "            },\n"
    "            resume: {\n"
    "                cmdCheck: 'Resume'\n"
    "            },\n"
    "            cancel: {\n"
    "                cmdNoCheck: 'Cancel'\n"
    "            },\n"
    "            start: {\n"
    "                cmdCheck: 'Check'\n"
    "            }\n"
    "        };"
)
PARITY_RESUME_NEW = (
    "const states = {\n"
    "            pause: {\n"
    "                cmdCheckPause: ''\n"
    "            },\n"
    "            resume: {\n"
    "                cmdCheckResume: ''\n"
    "            },\n"
    "            cancel: {\n"
    "                cmdCheckCancel: ''\n"
    "            },\n"
    "            start: {\n"
    "                cmdCheck: 'Check'\n"
    "            }\n"
    "        };"
)


def patch_parity_resume_bundle() -> bool:
    """Realign parityCheck pause/resume/cancel field names with the web UI.

    The upstream resolver posts `cmdCheck=Resume` (and `cmdNoCheck=Pause`,
    `cmdNoCheck=Cancel`) to emhttpd. emhttpd identifies the action by the
    field NAME, not the value — so `cmdCheck=Resume` falls through to the
    plain `cmdCheck` submit handler (start a fresh check) and the saved
    mdResyncPos is discarded. Resuming via the API restarts at byte 0.

    The Unraid web UI submits dynamic field names instead — `cmdCheckPause`,
    `cmdCheckResume`, `cmdCheckCancel` — with empty values (see
    `/usr/local/emhttp/plugins/dynamix/ArrayOperation.page`). This patch
    rewrites the API's states map to use the same field names, so resume
    actually resumes and pause/cancel stop relying on emhttpd's fallback.

    Tracked upstream: https://github.com/unraid/api/issues/1815
    """
    bundle = find_bundle()
    if not bundle:
        log("parity-resume patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if PARITY_RESUME_NEW in content:
        return False
    if PARITY_RESUME_OLD not in content:
        log("parity-resume patch: original states map not found")
        return False
    content = content.replace(PARITY_RESUME_OLD, PARITY_RESUME_NEW, 1)
    with open(bundle, "w") as f:
        f.write(content)
    log(f"patched parity-resume action names in {os.path.basename(bundle)}")
    return True


POWER_MUTATIONS_MARKER = "serverPower = new ServerPowerMutations();"


def patch_power_mutations_bundle() -> bool:
    """Expose `serverPower: ServerPowerMutations { shutdown, reboot, sleep }`.

    Matches the namespaced shape used by `parityCheck` / `array` / etc. on
    the upstream Mutation root. Earlier revisions of this companion shipped
    a flat `shutdownServer`/`rebootServer`/`sleepServer` set of root
    mutations — this revision REPLACES them with the namespace shape, so it
    also reverts the flat additions if they're present in the bundle.

    Tracked upstream: PR pending on the unraid-api fork.
    """
    bundle = find_bundle()
    if not bundle:
        log("power-mutations patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if POWER_MUTATIONS_MARKER in content:
        return False

    # Suffixes for both injection scopes — the ServerService class lives in
    # a different bundle scope than ServerResolver (different _ts_decorate$X
    # function suffixes), so resolve each independently.
    service_anchor = "}\nServerService = _ts_decorate$"
    service_idx = content.find(service_anchor)
    if service_idx == -1:
        log("power-mutations patch: ServerService closer not found")
        return False
    end = content.find("(", service_idx + len(service_anchor))
    service_suffix = content[service_idx + len(service_anchor) : end]

    resolver_anchor = 'ServerResolver.prototype, "updateServerIdentity", null);'
    resolver_suffix = find_decorator_suffix(content, resolver_anchor)
    meta_suffix = find_metadata_suffix(content, resolver_anchor)
    if not all([service_suffix, resolver_suffix, meta_suffix]):
        log(
            f"power-mutations patch: missing suffix "
            f"(service={service_suffix} resolver={resolver_suffix} meta={meta_suffix})"
        )
        return False

    # ── PHASE A: revert the flat v1 additions if they're still in the bundle ──
    v1_method_block = (
        "    async shutdownServer() {\n"
        "        return this.serverService.shutdownServer();\n"
        "    }\n"
        "    async rebootServer() {\n"
        "        return this.serverService.rebootServer();\n"
        "    }\n"
        "    async sleepServer() {\n"
        "        return this.serverService.sleepServer();\n"
        "    }\n"
        "    "
    )
    if v1_method_block in content:
        content = content.replace(v1_method_block, "", 1)

    v1_decorator_pattern = re.compile(
        r'(\], ServerResolver\.prototype, "updateServerIdentity", null\);\n)'
        r'(?:_ts_decorate\$[\w$]+\(\[\s*\n\s*Mutation\(\(\)=>Boolean,.*?'
        r'\], ServerResolver\.prototype, "(?:shutdownServer|rebootServer|sleepServer)", null\);\n){3}',
        re.DOTALL,
    )
    if v1_decorator_pattern.search(content):
        content = v1_decorator_pattern.sub(r"\1", content, count=1)

    # ── PHASE B: ServerService methods ──
    # Mirrors what the web UI's `Powerdown.php` does:
    #     exec("/sbin/poweroff 1>/dev/null 2>&1 &")
    #     exec("/sbin/reboot   1>/dev/null 2>&1 &")
    # …and what `dynamix.s3.sleep`'s SleepMode.php does for sleep.
    # No `powerdown` wrapper script, so we don't depend on it existing on
    # the user's system.
    service_methods = (
        "    fireAndForget(command, args) {\n"
        "        const subprocess = execa(command, args, { detached: true, stdio: 'ignore' });\n"
        "        subprocess.unref();\n"
        "    }\n"
        "    async shutdownServer() {\n"
        "        this.logger.log('Server shutdown requested via API');\n"
        "        this.fireAndForget('/sbin/poweroff', []);\n"
        "        return true;\n"
        "    }\n"
        "    async rebootServer() {\n"
        "        this.logger.log('Server reboot requested via API');\n"
        "        this.fireAndForget('/sbin/reboot', []);\n"
        "        return true;\n"
        "    }\n"
        "    async sleepServer() {\n"
        "        const { existsSync } = await import('fs');\n"
        "        const path = '/usr/local/emhttp/plugins/dynamix.s3.sleep/scripts/rc.s3sleep';\n"
        "        if (!existsSync(path)) {\n"
        "            throw new GraphQLError('Sleep is not available. Install the Dynamix S3 Sleep plugin to enable this feature.');\n"
        "        }\n"
        "        this.logger.log('Server sleep requested via API');\n"
        "        this.fireAndForget(path, []);\n"
        "        return true;\n"
        "    }\n"
    )
    service_closer = f"}}\nServerService = _ts_decorate${service_suffix}(["
    if service_closer not in content:
        log("power-mutations patch: service closer anchor not found")
        return False
    if "this.fireAndForget('/sbin/poweroff', [])" not in content:
        content = content.replace(service_closer, service_methods + service_closer, 1)

    # ── PHASE C: ServerPowerMutations ObjectType class ──
    # Inject BEFORE `class RootMutations` so it's already in scope when
    # the RootMutations field decorator runs (the decorator's
    # `typeof ServerPowerMutations === "undefined" ? Object : SP` check
    # still hits the TDZ ReferenceError if the class hasn't been
    # *declared* yet at module-load time).
    #
    # We discover the decorator suffix used by neighbouring namespace
    # classes (e.g. UnraidPluginsMutations) so the ObjectType decoration
    # picks up the right `_ts_decorate$` helper for this scope.
    sp_class_anchor = "class UnraidPluginsMutations {"
    sp_class_decoration_anchor = "UnraidPluginsMutations = _ts_decorate$"
    sp_class_d_idx = content.find(sp_class_decoration_anchor)
    if sp_class_d_idx == -1:
        log("power-mutations patch: UnraidPluginsMutations decorator anchor not found")
        return False
    end = content.find("(", sp_class_d_idx + len(sp_class_decoration_anchor))
    sp_class_suffix = content[sp_class_d_idx + len(sp_class_decoration_anchor) : end]
    if not sp_class_suffix:
        log("power-mutations patch: could not extract namespace decorator suffix")
        return False

    sp_class_block = (
        "class ServerPowerMutations {\n"
        "}\n"
        f"ServerPowerMutations = _ts_decorate${sp_class_suffix}([\n"
        f"    ObjectType({{\n"
        f"        description: 'Server power-state mutations: shut down, reboot, and S3 sleep.'\n"
        f"    }})\n"
        f"], ServerPowerMutations);\n"
    )
    if sp_class_anchor not in content:
        log("power-mutations patch: UnraidPluginsMutations class anchor not found")
        return False
    if "class ServerPowerMutations {" not in content:
        content = content.replace(sp_class_anchor, sp_class_block + sp_class_anchor, 1)

    # ── PHASE D: ServerPowerMutationsResolver class + 3 ResolveField decorators ──
    sp_resolver_class = (
        "class ServerPowerMutationsResolver {\n"
        "    serverService;\n"
        "    constructor(serverService) {\n"
        "        this.serverService = serverService;\n"
        "    }\n"
        "    async shutdown() {\n"
        "        return this.serverService.shutdownServer();\n"
        "    }\n"
        "    async reboot() {\n"
        "        return this.serverService.rebootServer();\n"
        "    }\n"
        "    async sleep() {\n"
        "        return this.serverService.sleepServer();\n"
        "    }\n"
        "}\n"
    )

    def field_decorator(method: str, description: str) -> str:
        return (
            f"_ts_decorate${resolver_suffix}([\n"
            f"    UsePermissions({{\n"
            f"        action: AuthAction.UPDATE_ANY,\n"
            f"        resource: Resource.SERVERS\n"
            f"    }}),\n"
            f"    ResolveField(()=>Boolean, {{\n"
            f"        description: '{description}'\n"
            f"    }}),\n"
            f'    _ts_metadata${meta_suffix}("design:type", Function),\n'
            f'    _ts_metadata${meta_suffix}("design:paramtypes", []),\n'
            f'    _ts_metadata${meta_suffix}("design:returntype", Promise)\n'
            f'], ServerPowerMutationsResolver.prototype, "{method}", null);\n'
        )

    sp_resolver_decorators = (
        field_decorator("shutdown", "Cleanly stop the array and power the server off.")
        + field_decorator("reboot", "Cleanly stop the array and reboot the server.")
        + field_decorator(
            "sleep",
            "Put the server into S3 sleep. Requires the Dynamix S3 Sleep plugin.",
        )
    )

    sp_class_decoration = (
        f"ServerPowerMutationsResolver = _ts_decorate${resolver_suffix}([\n"
        f"    Injectable(),\n"
        f"    Resolver(()=>ServerPowerMutations),\n"
        f'    _ts_metadata${meta_suffix}("design:type", Function),\n'
        f'    _ts_metadata${meta_suffix}("design:paramtypes", [\n'
        f'        typeof ServerService === "undefined" ? Object : ServerService\n'
        f"    ])\n"
        f"], ServerPowerMutationsResolver);\n"
    )

    sr_class_decoration_pattern = re.compile(
        r"ServerResolver = _ts_decorate\$[\w$]+\(\[(?:[^\[\]]|\[[^\[\]]*\])+\], ServerResolver\);"
    )
    m_end = sr_class_decoration_pattern.search(content)
    if not m_end:
        log("power-mutations patch: ServerResolver class decoration end not found")
        return False
    if "class ServerPowerMutationsResolver {" not in content:
        content = (
            content[: m_end.end()]
            + "\n"
            + sp_resolver_class
            + sp_resolver_decorators
            + sp_class_decoration
            + content[m_end.end() :]
        )

    # ── PHASE E: expose `serverPower` as a FIELD on `RootMutations` ──
    # Mirrors how `array`, `docker`, `unraidPlugins` etc. are exposed —
    # NestJS resolves `Mutation.serverPower` to the field's runtime value
    # (a freshly-constructed wrapper instance) and then dispatches each
    # inner field to `ServerPowerMutationsResolver`.
    #
    # An earlier revision of this patch used `@Mutation(()=>ServerPowerMutations)`
    # on a method of `ServerResolver` instead. That registers a top-level
    # mutation field in the schema but the runtime resolution silently
    # returns null in the running unraid-api, leaving the GraphQL response
    # at "Cannot return null for non-nullable field Mutation.serverPower".
    # The field-on-root pattern is the canonical one for namespaced
    # mutations and matches what's already in the upstream code.

    # First, REVERT the earlier @Mutation-method pattern if present.
    legacy_method_block = (
        "    async serverPower() {\n"
        "        return new ServerPowerMutations();\n"
        "    }\n"
        "    "
    )
    if legacy_method_block in content:
        content = content.replace(legacy_method_block, "", 1)

    # The legacy decorator block came in two shapes (with and without
    # `UsePermissions`). Match either with a regex.
    legacy_decorator_re = re.compile(
        r"\n?_ts_decorate\$[\w$]+\(\[\n"
        r"    Mutation\(\(\)=>ServerPowerMutations, \{\n"
        r"        description: 'Server power-state mutations: shutdown, reboot, sleep\.'\n"
        r"    \}\),\n"
        r"(?:    UsePermissions\(\{\n"
        r"        action: AuthAction\.UPDATE_ANY,\n"
        r"        resource: Resource\.SERVERS\n"
        r"    \}\),\n)?"
        r"    _ts_metadata\$[\w$]+\(\"design:type\", Function\),\n"
        r"    _ts_metadata\$[\w$]+\(\"design:paramtypes\", \[\]\),\n"
        r"    _ts_metadata\$[\w$]+\(\"design:returntype\", Promise\)\n"
        r"\], ServerResolver\.prototype, \"serverPower\", null\);\n"
    )
    content = legacy_decorator_re.sub("", content, count=1)

    # Discover the decorator suffix used by RootMutations' existing
    # `@Field(()=>UnraidPluginsMutations,...)` registration — same suffix
    # for our new `serverPower` field, same scope.
    root_anchor = 'RootMutations.prototype, "unraidPlugins", void 0);'
    root_d = find_decorator_suffix(content, root_anchor)
    root_m = find_metadata_suffix(content, root_anchor)
    if not all([root_d, root_m]):
        log(
            f"power-mutations patch: RootMutations suffix not found "
            f"(decorator={root_d} metadata={root_m})"
        )
        return False

    # Add `serverPower = new ServerPowerMutations();` to the RootMutations
    # class body, immediately after `unraidPlugins = new ...` (which
    # is the last existing namespace field).
    root_class_anchor = "    unraidPlugins = new UnraidPluginsMutations();\n"
    if root_class_anchor not in content:
        log("power-mutations patch: RootMutations class anchor not found")
        return False
    if "serverPower = new ServerPowerMutations();" not in content:
        content = content.replace(
            root_class_anchor,
            root_class_anchor + "    serverPower = new ServerPowerMutations();\n",
            1,
        )

    # Add the matching `@Field()` decorator next to the existing
    # `unraidPlugins` one.
    unraid_field_anchor = (
        f"_ts_decorate${root_d}([\n"
        f"    Field(()=>UnraidPluginsMutations, {{\n"
        f"        description: 'Unraid plugin related mutations'\n"
        f"    }}),\n"
        f'    _ts_metadata${root_m}("design:type", typeof UnraidPluginsMutations === "undefined" ? Object : UnraidPluginsMutations)\n'
        f'], RootMutations.prototype, "unraidPlugins", void 0);'
    )
    serverpower_field_decorator = (
        f"\n_ts_decorate${root_d}([\n"
        f"    Field(()=>ServerPowerMutations, {{\n"
        f"        description: 'Server power-state mutations: shutdown, reboot, sleep.'\n"
        f"    }}),\n"
        f'    _ts_metadata${root_m}("design:type", typeof ServerPowerMutations === "undefined" ? Object : ServerPowerMutations)\n'
        f'], RootMutations.prototype, "serverPower", void 0);'
    )
    if unraid_field_anchor not in content:
        log("power-mutations patch: UnraidPlugins field decorator anchor not found")
        return False
    if 'RootMutations.prototype, "serverPower", void 0);' not in content:
        content = content.replace(
            unraid_field_anchor,
            unraid_field_anchor + serverpower_field_decorator,
            1,
        )

    # ── PHASE F: add `serverPower()` resolver method to `RootMutationsResolver`
    # so the GraphQL `Mutation.serverPower` field gets registered. The class
    # field on `RootMutations` alone is NOT enough — NestJS walks the
    # `RootMutationsResolver` providers to discover top-level mutations via
    # their `@Mutation()` decorators. Without this method the new field
    # silently drops out of the schema.
    if 'RootMutationsResolver.prototype, "serverPower", null);' not in content:
        method_anchor = (
            "    unraidPlugins() {\n"
            "        return new UnraidPluginsMutations();\n"
            "    }\n"
        )
        if method_anchor not in content:
            log("power-mutations patch: RootMutationsResolver method anchor not found")
            return False
        sp_method = (
            "    serverPower() {\n"
            "        return new ServerPowerMutations();\n"
            "    }\n"
        )
        content = content.replace(method_anchor, method_anchor + sp_method, 1)

        # Detect the suffix used by the existing `unraidPlugins` decorator
        # in this scope (different chunk from RootMutations' Field decorator).
        unraid_dec_re = re.compile(
            r"_ts_decorate\$([\w$]+)\(\[\n"
            r"    Mutation\(\(\)=>UnraidPluginsMutations, \{\n"
            r"        name: 'unraidPlugins'\n"
            r"    \}\),\n"
            r"    _ts_metadata\$([\w$]+)\(\"design:type\", Function\),\n"
            r"    _ts_metadata\$[\w$]+\(\"design:paramtypes\", \[\]\),\n"
            r"    _ts_metadata\$[\w$]+\(\"design:returntype\", typeof UnraidPluginsMutations === \"undefined\" \? Object : UnraidPluginsMutations\)\n"
            r"\], RootMutationsResolver\.prototype, \"unraidPlugins\", null\);\n"
        )
        m_dec = unraid_dec_re.search(content)
        if not m_dec:
            log("power-mutations patch: unraidPlugins resolver decorator not found")
            return False
        rm_d, rm_m = m_dec.group(1), m_dec.group(2)

        sp_resolver_decorator = (
            f"_ts_decorate${rm_d}([\n"
            f"    Mutation(()=>ServerPowerMutations, {{\n"
            f"        name: 'serverPower'\n"
            f"    }}),\n"
            f'    _ts_metadata${rm_m}("design:type", Function),\n'
            f'    _ts_metadata${rm_m}("design:paramtypes", []),\n'
            f'    _ts_metadata${rm_m}("design:returntype", typeof ServerPowerMutations === "undefined" ? Object : ServerPowerMutations)\n'
            f'], RootMutationsResolver.prototype, "serverPower", null);\n'
        )
        insert_at = m_dec.end()
        content = content[:insert_at] + sp_resolver_decorator + content[insert_at:]

    # ── PHASE G: register ServerPowerMutationsResolver in ResolversModule providers ──
    providers_anchor = (
        "RootMutationsResolver,\n"
        "            ServerResolver,\n"
        "            ServerService,"
    )
    if "            ServerPowerMutationsResolver,\n" not in content:
        if providers_anchor not in content:
            log("power-mutations patch: ResolversModule providers anchor not found")
            return False
        content = content.replace(
            providers_anchor,
            "RootMutationsResolver,\n"
            "            ServerPowerMutationsResolver,\n"
            "            ServerResolver,\n"
            "            ServerService,",
            1,
        )

    with open(bundle, "w") as f:
        f.write(content)
    log(f"patched power mutations (namespace) in {os.path.basename(bundle)}")
    return True


def restart_api() -> None:
    try:
        with os.popen("pgrep -f 'node /usr/local/unraid-api'") as p:
            pids = [int(x) for x in p.read().split() if x.strip().isdigit()]
        for pid in pids:
            os.kill(pid, 15)
        log(f"sent SIGTERM to unraid-api pids: {pids}")
    except Exception as e:  # pragma: no cover
        log(f"failed to restart unraid-api: {e}")


INSTALLED_PLUGINS_MANIFEST_MARKER = "class InstalledPluginManifest"


def patch_installed_plugins_manifest_bundle() -> bool:
    """Expose `installedUnraidPluginsDetailed: [InstalledPluginManifest!]!`.

    Upstream only ships `installedUnraidPlugins: [String!]!` which returns
    bare `.plg` filenames. Downstream consumers (this companion's main
    app, u_manager) then have to cross-reference an external feed
    (Community Applications) to get a plugin's name, author, version,
    description, icon, etc. — and any private/non-feed plugin shows up
    blank.

    This patch moves that parsing server-side by reading each `.plg` XML
    manifest from `/boot/config/plugins/` and emitting a structured
    `InstalledPluginManifest` per plugin.

    Tracked upstream: pending PR on the unraid-api fork.
    """
    bundle = find_bundle()
    if not bundle:
        log("installed-plugins-manifest patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if INSTALLED_PLUGINS_MANIFEST_MARKER in content:
        return False

    # ── Discover decorator suffixes ──
    # Model file scope (PluginInstallEvent / PluginInstallOperation)
    model_d = find_decorator_suffix(
        content, 'PluginInstallEvent.prototype, "timestamp", void 0)'
    )
    model_m = find_metadata_suffix(
        content, 'PluginInstallEvent.prototype, "timestamp", void 0)'
    )
    # Resolver file scope (UnraidPluginsResolver)
    resolver_d = find_decorator_suffix(
        content, 'UnraidPluginsResolver.prototype, "installedUnraidPlugins", null)'
    )
    resolver_m = find_metadata_suffix(
        content, 'UnraidPluginsResolver.prototype, "installedUnraidPlugins", null)'
    )
    # Service file scope (UnraidPluginsService) — different from resolver
    service_anchor = "}\nUnraidPluginsService = _ts_decorate$"
    service_idx = content.find(service_anchor)
    if service_idx == -1:
        log("installed-plugins-manifest patch: UnraidPluginsService closer not found")
        return False
    end = content.find("(", service_idx + len(service_anchor))
    service_d = content[service_idx + len(service_anchor) : end]

    if not all([model_d, model_m, resolver_d, resolver_m, service_d]):
        log(
            f"installed-plugins-manifest patch: missing suffix "
            f"(model={model_d}/{model_m} resolver={resolver_d}/{resolver_m} "
            f"service={service_d})"
        )
        return False

    # ── PHASE A: InstalledPluginManifest ObjectType in model scope ──
    model_anchor = "], PluginInstallEvent);"
    if model_anchor not in content:
        log("installed-plugins-manifest patch: PluginInstallEvent closer not found")
        return False

    def field_dec(prop: str, desc: str, nullable: bool) -> str:
        opts = (
            "{ nullable: true, description: '" + desc + "' }"
            if nullable
            else "{ description: '" + desc + "' }"
        )
        return (
            f"_ts_decorate${model_d}([\n"
            f"    Field(()=>String, {opts}),\n"
            f"    _ts_metadata${model_m}(\"design:type\", String)\n"
            f"], InstalledPluginManifest.prototype, \"{prop}\", void 0);\n"
        )

    # The lastCheckedAt field uses GraphQLISODateTime + Date type (rather
    # than the plain `String` of the other fields) so the API returns a
    # proper ISO 8601 timestamp the client can parse into a DateTime.
    last_checked_dec = (
        f"_ts_decorate${model_d}([\n"
        f"    Field(()=>GraphQLISODateTime, {{ nullable: true, description: 'Timestamp of the cached remote .plg at /tmp/plugins/<filename>.plg — when Unraid last fetched it via plugin checkall.' }}),\n"
        f'    _ts_metadata${model_m}("design:type", typeof Date === "undefined" ? Object : Date)\n'
        f'], InstalledPluginManifest.prototype, "lastCheckedAt", void 0);\n'
    )

    manifest_block = (
        "\nclass InstalledPluginManifest {\n"
        "    filename;\n"
        "    name;\n"
        "    author;\n"
        "    version;\n"
        "    description;\n"
        "    pluginURL;\n"
        "    support;\n"
        "    icon;\n"
        "    launch;\n"
        "    changelog;\n"
        "    latestVersion;\n"
        "    lastCheckedAt;\n"
        "}\n"
        + field_dec("filename", "Bare .plg filename in /boot/config/plugins", nullable=False)
        + field_dec(
            "name",
            "Plugin name slug from <!ENTITY name>. Falls back to filename without .plg.",
            nullable=False,
        )
        + field_dec("author", "Plugin author from <!ENTITY author>", nullable=True)
        + field_dec("version", "Plugin version string from <!ENTITY version>", nullable=True)
        + field_dec(
            "description",
            "Free-text description from <!ENTITY description>",
            nullable=True,
        )
        + field_dec(
            "pluginURL",
            "Remote .plg URL from <!ENTITY pluginURL>",
            nullable=True,
        )
        + field_dec("support", "Support thread URL from <!ENTITY support>", nullable=True)
        + field_dec("icon", "Icon path or URL from <!ENTITY icon>", nullable=True)
        + field_dec("launch", "Launch path from <!ENTITY launch>", nullable=True)
        + field_dec(
            "changelog",
            "Raw <CHANGES> body from the local .plg",
            nullable=True,
        )
        + field_dec(
            "latestVersion",
            "Version from /tmp/plugins/<filename>.plg if Unraid cached it",
            nullable=True,
        )
        + last_checked_dec
        + f"InstalledPluginManifest = _ts_decorate${model_d}([\n"
        + "    ObjectType({\n"
        + "        description: 'Parsed manifest of an installed Unraid plugin (.plg file)'\n"
        + "    })\n"
        + "], InstalledPluginManifest);\n"
    )
    content = content.replace(model_anchor, model_anchor + manifest_block, 1)

    # ── PHASE B: Service methods on UnraidPluginsService class body ──
    # Uses the bundle-level `path` and `fs` imports already in scope
    # (verified by the existing listInstalledPlugins() body).
    service_methods = r"""    async listInstalledPluginsDetailed() {
        const paths = this.configService.get('store.paths', {});
        const dynamixBase = paths?.['dynamix-base'] ?? '/boot/config/plugins/dynamix';
        const pluginsDir = path.resolve(dynamixBase, '..');
        const filenames = await this.listInstalledPlugins();
        return Promise.all(filenames.map((f) => this.parsePluginManifest(f, pluginsDir)));
    }
    async parsePluginManifest(filename, pluginsDir) {
        const fullPath = path.join(pluginsDir, filename);
        let xml = '';
        try { xml = await fs.readFile(fullPath, 'utf8'); }
        catch (e) { this.logger.warn(`Failed to read plugin manifest ${fullPath}: ${e}`); }
        const entities = {};
        const entityRe = /<!ENTITY\s+(\w+)\s+(?:"([^"]*)"|'([^']*)')/g;
        let em;
        while ((em = entityRe.exec(xml)) !== null) {
            entities[em[1]] = (em[2] ?? em[3] ?? '').trim();
        }
        const pluginTag = xml.match(/<PLUGIN\s+([^>]*)>/s);
        const attrs = {};
        if (pluginTag) {
            const attrRe = /(\w+)\s*=\s*"([^"]*)"/g;
            let am;
            while ((am = attrRe.exec(pluginTag[1])) !== null) {
                attrs[am[1]] = am[2];
            }
        }
        const resolve = (value, depth = 0) => {
            if (value == null) return null;
            if (depth > 5) return value;
            const replaced = value.replace(/&(\w+);/g, (_, key) => {
                const r = entities[key];
                return r !== undefined ? (resolve(r, depth + 1) ?? `&${key};`) : `&${key};`;
            });
            return replaced.trim() || null;
        };
        const pick = (key, ...aliases) => {
            for (const k of [key, ...aliases]) {
                if (attrs[k] != null) return resolve(attrs[k]);
            }
            for (const k of [key, ...aliases]) {
                if (entities[k] != null) return resolve(entities[k]);
            }
            return null;
        };
        const resolvedName = pick('name') ?? filename.replace(/\.plg$/, '');
        const description = await this.readPluginReadmeDescription(resolvedName);
        const changesMatch = xml.match(/<CHANGES>([\s\S]*?)<\/CHANGES>/);
        const changelogBody = changesMatch ? changesMatch[1].trim() : null;
        const changelog = changelogBody && changelogBody.length > 0 ? changelogBody : null;
        const updateInfo = await this.readCachedPluginUpdate(filename);
        return {
            filename,
            name: resolvedName,
            author: pick('author'),
            version: pick('version'),
            description,
            pluginURL: pick('pluginURL'),
            support: pick('support', 'supportURL'),
            icon: pick('icon'),
            launch: pick('launch'),
            changelog,
            latestVersion: updateInfo.latestVersion,
            lastCheckedAt: updateInfo.lastCheckedAt,
        };
    }
    async readPluginReadmeDescription(name) {
        const readmePath = `/usr/local/emhttp/plugins/${name}/README.md`;
        let body;
        try { body = await fs.readFile(readmePath, 'utf8'); }
        catch { return null; }
        const lines = body.split('\n');
        if (lines[0]?.trim().startsWith('**') && lines[0]?.trim().endsWith('**')) {
            lines.shift();
        }
        const cleaned = lines.join('\n').trim();
        return cleaned.length > 0 ? cleaned : null;
    }
    async readCachedPluginUpdate(filename) {
        const cachePath = `/tmp/plugins/${filename}`;
        let stat;
        try { stat = await fs.stat(cachePath); }
        catch { return { latestVersion: null, lastCheckedAt: null }; }
        let xml = '';
        try { xml = await fs.readFile(cachePath, 'utf8'); }
        catch { return { latestVersion: null, lastCheckedAt: stat.mtime }; }
        const versionMatch = xml.match(/<!ENTITY\s+version\s+(?:"([^"]*)"|'([^']*)')/s);
        const raw = versionMatch ? (versionMatch[1] ?? versionMatch[2] ?? '') : '';
        const latestVersion = raw.trim().length > 0 ? raw.trim() : null;
        return { latestVersion, lastCheckedAt: stat.mtime };
    }
"""
    service_closer_full = f"}}\nUnraidPluginsService = _ts_decorate${service_d}("
    if service_closer_full not in content:
        log("installed-plugins-manifest patch: service closer anchor mismatch")
        return False
    content = content.replace(service_closer_full, service_methods + service_closer_full, 1)

    # ── PHASE C: Resolver method body on UnraidPluginsResolver class ──
    resolver_closer_anchor = (
        "    pluginInstallUpdates(operationId) {\n"
        "        return this.pluginsService.subscribe(operationId);\n"
        "    }\n"
        "}"
    )
    if resolver_closer_anchor not in content:
        log("installed-plugins-manifest patch: resolver closer anchor not found")
        return False
    resolver_method = (
        "    pluginInstallUpdates(operationId) {\n"
        "        return this.pluginsService.subscribe(operationId);\n"
        "    }\n"
        "    async installedUnraidPluginsDetailed() {\n"
        "        return this.pluginsService.listInstalledPluginsDetailed();\n"
        "    }\n"
        "}"
    )
    content = content.replace(resolver_closer_anchor, resolver_method, 1)

    # ── PHASE D: Query decorator for the new method ──
    existing_query_anchor = (
        '], UnraidPluginsResolver.prototype, "installedUnraidPlugins", null);'
    )
    if existing_query_anchor not in content:
        log("installed-plugins-manifest patch: existing Query anchor not found")
        return False
    new_query_decoration = (
        existing_query_anchor + "\n"
        f"_ts_decorate${resolver_d}([\n"
        f"    Query(()=>[\n"
        f"            InstalledPluginManifest\n"
        f"        ], {{\n"
        f"        description: 'List installed Unraid OS plugins enriched with parsed .plg manifest metadata.'\n"
        f"    }}),\n"
        f"    UsePermissions({{\n"
        f"        action: AuthAction.READ_ANY,\n"
        f"        resource: Resource.CONFIG\n"
        f"    }}),\n"
        f"    _ts_metadata${resolver_m}(\"design:type\", Function),\n"
        f"    _ts_metadata${resolver_m}(\"design:paramtypes\", []),\n"
        f"    _ts_metadata${resolver_m}(\"design:returntype\", Promise)\n"
        f'], UnraidPluginsResolver.prototype, "installedUnraidPluginsDetailed", null);'
    )
    content = content.replace(existing_query_anchor, new_query_decoration, 1)

    with open(bundle, "w") as f:
        f.write(content)
    log(f"patched installed-plugins-manifest in {os.path.basename(bundle)}")
    return True


UNINSTALL_PLUGIN_MARKER = 'async uninstallPlugin(filename) {'


def patch_uninstall_plugin_bundle() -> bool:
    """Expose `unraidPlugins.uninstallPlugin(filename: String!)` mutation.

    Upstream only ships `installPlugin` / `installLanguage` mutations
    on `UnraidPluginsMutationsResolver` — there's no way to remove a
    plugin via GraphQL. This patch wires `plugin remove FILENAME`
    (the same script `installPlugin` already shells out to) onto the
    existing operation pipeline so progress streams through
    `pluginInstallUpdates` exactly like an install.

    Tracked upstream: PR pending on the unraid-api fork
    (fix/plugin-uninstall-mutation).
    """
    bundle = find_bundle()
    if not bundle:
        log("uninstall-plugin patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if UNINSTALL_PLUGIN_MARKER in content:
        return False

    # Mutations resolver scope (UnraidPluginsMutationsResolver)
    resolver_d = find_decorator_suffix(
        content, 'UnraidPluginsMutationsResolver.prototype, "installLanguage", null)'
    )
    resolver_m = find_metadata_suffix(
        content, 'UnraidPluginsMutationsResolver.prototype, "installLanguage", null)'
    )
    # `_ts_param$N` is the helper that emits parameter decorators —
    # we need the same suffix the existing `Args('input')` call uses
    # so the new mutation's `Args('filename')` plays nicely.
    param_anchor = '_ts_param$'
    param_idx = content.find(
        param_anchor,
        content.find('UnraidPluginsMutationsResolver.prototype, "installPlugin"') - 800,
    )
    end = content.find('(', param_idx + len(param_anchor))
    param_suffix = content[param_idx + len(param_anchor) : end] if param_idx != -1 else ''

    if not all([resolver_d, resolver_m, param_suffix]):
        log(
            f"uninstall-plugin patch: missing suffix "
            f"(resolver={resolver_d}/{resolver_m} param={param_suffix})"
        )
        return False

    # ── PHASE A: service method on UnraidPluginsService class body ──
    service_method = r"""    async uninstallPlugin(filename) {
        const trimmed = filename.trim();
        if (!trimmed) throw new Error('Plugin filename cannot be empty.');
        if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
            throw new Error(`Invalid plugin filename: "${filename}".`);
        }
        if (!trimmed.toLowerCase().endsWith('.plg')) {
            throw new Error(`Plugin filename must end with .plg: "${filename}".`);
        }
        const id = randomUUID();
        const createdAt = new Date();
        const operation = {
            id,
            type: 'plugin',
            url: trimmed,
            name: trimmed.replace(/\.plg$/, ''),
            status: PluginInstallStatus.RUNNING,
            createdAt,
            updatedAt: createdAt,
            output: [],
            bufferedOutput: '',
            forced: false,
            action: 'uninstall',
        };
        this.operations.set(id, operation);
        this.logger.log(`Starting plugin uninstall for "${trimmed}" (operation ${id})`);
        this.publishEvent(operation, []);
        const command = await this.resolveInstallerCommand('plugin');
        const args = ['remove', trimmed];
        const child = execa(command, args, {
            all: true,
            reject: false,
            timeout: 5 * 60 * 1000,
        });
        operation.child = child;
        if (child.all) {
            child.all.on('data', (chunk) => {
                this.handleOutput(operation, chunk.toString());
            });
        } else {
            child.stdout?.on('data', (chunk) => this.handleOutput(operation, chunk.toString()));
            child.stderr?.on('data', (chunk) => this.handleOutput(operation, chunk.toString()));
        }
        child.on('error', (error) => {
            if (operation.status === PluginInstallStatus.RUNNING) {
                this.handleFailure(operation, error);
            }
        });
        child.on('close', (code) => {
            if (operation.status !== PluginInstallStatus.RUNNING) return;
            if (code === 0) {
                this.handleSuccess(operation);
            } else {
                this.handleFailure(operation, new Error(`plugin remove command exited with ${code}`));
            }
        });
        return this.toGraphqlOperation(operation);
    }
"""
    # Anchor: the `}` that closes UnraidPluginsService's class body,
    # followed by the decorator call. Inject the method right before
    # that closing brace.
    service_anchor_pattern = re.compile(
        r"(}\nUnraidPluginsService = _ts_decorate\$[\w$]+\(\[)", re.MULTILINE
    )
    if not service_anchor_pattern.search(content):
        log("uninstall-plugin patch: UnraidPluginsService closer not found")
        return False
    content = service_anchor_pattern.sub(
        lambda m: service_method + m.group(1), content, count=1
    )

    # ── PHASE B: resolver method body on UnraidPluginsMutationsResolver ──
    resolver_anchor = (
        "    async installLanguage(input) {\n"
        "        return this.pluginsService.installLanguage(input);\n"
        "    }\n"
        "}"
    )
    if resolver_anchor not in content:
        log("uninstall-plugin patch: resolver closer anchor not found")
        return False
    resolver_method = (
        "    async installLanguage(input) {\n"
        "        return this.pluginsService.installLanguage(input);\n"
        "    }\n"
        "    async uninstallPlugin(filename) {\n"
        "        return this.pluginsService.uninstallPlugin(filename);\n"
        "    }\n"
        "}"
    )
    content = content.replace(resolver_anchor, resolver_method, 1)

    # ── PHASE C: ResolveField decorator for the new method ──
    existing_decorator_anchor = (
        '], UnraidPluginsMutationsResolver.prototype, "installLanguage", null);'
    )
    if existing_decorator_anchor not in content:
        log("uninstall-plugin patch: installLanguage decorator anchor not found")
        return False
    new_decorator = (
        existing_decorator_anchor + "\n"
        f"_ts_decorate${resolver_d}([\n"
        f"    ResolveField(()=>PluginInstallOperation, {{\n"
        f"        description: 'Uninstalls an Unraid plugin by .plg filename and tracks the removal through the same operation pipeline the install flow uses.'\n"
        f"    }}),\n"
        f"    UsePermissions({{\n"
        f"        action: AuthAction.UPDATE_ANY,\n"
        f"        resource: Resource.CONFIG\n"
        f"    }}),\n"
        f"    _ts_param${param_suffix}(0, Args('filename')),\n"
        f"    _ts_metadata${resolver_m}(\"design:type\", Function),\n"
        f"    _ts_metadata${resolver_m}(\"design:paramtypes\", [\n"
        f"        String\n"
        f"    ]),\n"
        f"    _ts_metadata${resolver_m}(\"design:returntype\", Promise)\n"
        f'], UnraidPluginsMutationsResolver.prototype, "uninstallPlugin", null);'
    )
    content = content.replace(existing_decorator_anchor, new_decorator, 1)

    with open(bundle, "w") as f:
        f.write(content)
    log(f"patched uninstall-plugin in {os.path.basename(bundle)}")
    return True


def main() -> int:
    changed_pubsub = patch_pubsub()
    changed_bundle = patch_bundle()
    changed_docker_stats = patch_docker_stats_bundle()
    changed_docker_logs = patch_docker_logs_bundle()
    changed_docker_refresh = patch_docker_refresh_bundle()
    changed_parity_resume = patch_parity_resume_bundle()
    changed_power = patch_power_mutations_bundle()
    changed_installed_manifest = patch_installed_plugins_manifest_bundle()
    changed_uninstall = patch_uninstall_plugin_bundle()
    if any([
        changed_pubsub,
        changed_bundle,
        changed_docker_stats,
        changed_docker_logs,
        changed_docker_refresh,
        changed_parity_resume,
        changed_power,
        changed_installed_manifest,
        changed_uninstall,
    ]):
        restart_api()
        log("patches applied — unraid-api will restart")
    else:
        log("no changes needed (already patched)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
