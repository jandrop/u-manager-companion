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
  7. Share mutations: add `createShare`, `updateShare` and `deleteShare`
     to the GraphQL Mutation root. The upstream `SharesResolver` ships
     only a read-only `shares` query; the actual write path in stock
     Unraid is still the legacy PHP emhttp UI which POSTs form fields
     to `/var/run/emhttpd.socket`. These mutations replicate that
     protocol from inside unraid-api so the U-Manager mobile app (and
     any other GraphQL client) can manage shares with the same x-api-key
     auth used for everything else.

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
        const changesMatch = xml.match(/<CHANGES>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/CHANGES>/);
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


CHANGELOG_CDATA_OLD = (
    r"        const changesMatch = xml.match(/<CHANGES>([\s\S]*?)<\/CHANGES>/);"
)
CHANGELOG_CDATA_NEW = (
    r"        const changesMatch = xml.match(/<CHANGES>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/CHANGES>/);"
)


def patch_changelog_cdata_strip_bundle() -> bool:
    """Strip `<![CDATA[ ... ]]>` markers from the captured `<CHANGES>` body.

    Companion .plg files now wrap their `<CHANGES>` block in CDATA so the
    XML parses cleanly when changelog entries contain backtick-quoted text
    like `<filename>` or `<CHANGES>` (otherwise `plugin check` fails and
    /tmp/plugins/<name>.plg never refreshes). The existing
    parsePluginManifest regex captures the inside of `<CHANGES>` greedy
    of any wrapper, so the CDATA markers themselves now appear at the
    top of the Release Notes view in the U-Manager app.

    This patch tweaks the regex to make the CDATA markers optional
    capture group separators so they get stripped before the body is
    returned. Already-CDATA-free plugins keep working unchanged.

    Idempotent: looks for the original one-line regex and replaces it
    with the CDATA-tolerant version. Re-runs are no-ops once the new
    regex is in place.
    """
    bundle = find_bundle()
    if not bundle:
        log("changelog-cdata patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if CHANGELOG_CDATA_NEW in content:
        return False
    if CHANGELOG_CDATA_OLD not in content:
        log("changelog-cdata patch: original regex line not found")
        return False
    content = content.replace(CHANGELOG_CDATA_OLD, CHANGELOG_CDATA_NEW, 1)
    with open(bundle, "w") as f:
        f.write(content)
    log(f"patched changelog CDATA stripping in {os.path.basename(bundle)}")
    return True


INDEX_BUNDLE_GLOB = "/usr/local/unraid-api/dist/assets/index-*.js"

ARRAY_SUBSCRIPTION_OLD = (
    "pubsub.publish(GRAPHQL_PUBSUB_CHANNEL.ARRAY, {\n"
    "                            array\n"
    "                        });"
)
ARRAY_SUBSCRIPTION_NEW = (
    "pubsub.publish(GRAPHQL_PUBSUB_CHANNEL.ARRAY, {\n"
    "                            arraySubscription: array\n"
    "                        });"
)


def patch_array_subscription_bundle() -> bool:
    """Fix `Subscription.arraySubscription` returning null.

    The listener in `array-event-listener.ts` publishes `{ array }` to
    `PUBSUB_CHANNEL.ARRAY`, but the subscription resolver field is named
    `arraySubscription`. NestJS by default reads `payload.arraySubscription`
    from the publish payload, finds `undefined`, and returns null —
    which fails the non-nullable return type and triggers the error
    "Cannot return null for non-nullable field Subscription.arraySubscription"
    every time a disk state file is reloaded.

    The canonical fix publishes under the matching key:
        pubsub.publish(..., { arraySubscription: array })

    This patch lives in `index-*.js` (the bundle that contains the store
    listener), not the main `plugin.module-*.js` patched everywhere else,
    so it uses its own bundle finder.

    Tracked upstream: PR pending on the unraid-api fork
    (fix/array-subscription-payload-key).
    """
    candidates = glob.glob(INDEX_BUNDLE_GLOB)
    bundle = next(
        (
            p
            for p in candidates
            if "pubsub.publish(GRAPHQL_PUBSUB_CHANNEL.ARRAY" in open(p).read()
        ),
        None,
    )
    if not bundle:
        log("array-subscription patch: index bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if ARRAY_SUBSCRIPTION_NEW in content:
        return False
    if ARRAY_SUBSCRIPTION_OLD not in content:
        log("array-subscription patch: original publish call shape not found")
        return False
    content = content.replace(ARRAY_SUBSCRIPTION_OLD, ARRAY_SUBSCRIPTION_NEW, 1)
    with open(bundle, "w") as f:
        f.write(content)
    log(f"patched array-subscription payload key in {os.path.basename(bundle)}")
    return True


SHARE_MUTATIONS_MARKER = "/* u-manager-companion: share-mutations override */"
SHARE_EXTRA_FIELDS_MARKER = "/* u-manager-companion: share-extra-fields */"


def patch_share_extra_fields_bundle() -> bool:
    """Expose `useCache`, `cachePool` and `cachePool2` on the `Share`
    GraphQL type.

    The official `Share` ObjectType ships only a derived `cache: Boolean`
    field. The underlying `.cfg` stores three distinct values
    (`shareUseCache`, `shareCachePool`, `shareCachePool2`) that the
    mobile app needs to render the share editor in the right initial
    state — without them, "edit share" cannot pre-populate the
    primary/secondary storage dropdowns and the useCache mode.

    The `Share` class lives in `index-*.js` (alongside the other GraphQL
    models), not the main `plugin.module-*.js` patched elsewhere. We
    inject three `_ts_decorate([Field(...)], Share.prototype, "...", void 0)`
    blocks right before the final `Share = _ts_decorate([ObjectType(...)],
    Share);` line. The runtime entity returned by `getShares('users')`
    already has these properties (parsed from `shares.ini`), so all we
    need is the GraphQL decoration to expose them.

    Tracked upstream: PR pending on the unraid-api fork
    (fix/share-mutations).
    """
    candidates = glob.glob(INDEX_BUNDLE_GLOB)
    bundle = next(
        (
            p
            for p in candidates
            if "], Share.prototype, \"luksStatus\", void 0);" in open(p).read()
        ),
        None,
    )
    if not bundle:
        log("share-extra-fields patch: index bundle with Share class not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if SHARE_EXTRA_FIELDS_MARKER in content:
        return False

    # The class is finalised by exactly this snippet — inject the new
    # field decorators directly before it so they decorate the
    # prototype before the ObjectType class decorator finalises Share.
    anchor = (
        "], Share.prototype, \"luksStatus\", void 0);\n"
        "Share = _ts_decorate([\n"
    )
    if anchor not in content:
        log("share-extra-fields patch: anchor not found in index bundle")
        return False

    extra_fields = (
        SHARE_EXTRA_FIELDS_MARKER + "\n"
        "_ts_decorate([\n"
        "    Field(()=>String, {\n"
        "        description: 'Raw cache usage mode written to the share .cfg (\"\", \"no\", \"yes\", \"prefer\", \"only\").',\n"
        "        nullable: true\n"
        "    }),\n"
        "    _ts_metadata(\"design:type\", Object)\n"
        "], Share.prototype, \"useCache\", void 0);\n"
        "_ts_decorate([\n"
        "    Field(()=>String, {\n"
        "        description: 'Primary storage pool name (e.g. \"cache\"). Empty when the share lives on the array.',\n"
        "        nullable: true\n"
        "    }),\n"
        "    _ts_metadata(\"design:type\", Object)\n"
        "], Share.prototype, \"cachePool\", void 0);\n"
        "_ts_decorate([\n"
        "    Field(()=>String, {\n"
        "        description: 'Secondary storage pool name. Empty when no secondary pool is configured.',\n"
        "        nullable: true\n"
        "    }),\n"
        "    _ts_metadata(\"design:type\", Object)\n"
        "], Share.prototype, \"cachePool2\", void 0);\n"
    )

    content = content.replace(
        anchor,
        "], Share.prototype, \"luksStatus\", void 0);\n"
        + extra_fields
        + "Share = _ts_decorate([\n",
        1,
    )
    with open(bundle, "w") as f:
        f.write(content)
    log(f"patched share extra fields in {os.path.basename(bundle)}")
    return True


SHARES_PARSER_OLD = "cache: useCache === 'yes',"
SHARES_PARSER_NEW = "useCache,\n            cache: useCache === 'yes',"

ARRAY_DISK_SHARE_ENABLED_MARKER = (
    "/* u-manager-companion: array-disk-share-enabled */"
)
SLOTS_PARSER_OLD = (
    "isSpinning: slot.spundown ? slot.spundown === '0' : null"
)
SLOTS_PARSER_NEW = (
    "isSpinning: slot.spundown ? slot.spundown === '0' : null,\n"
    "            shareEnabled: slot.shareEnabled !== undefined "
    "? toBoolean(slot.shareEnabled) : null"
)


def patch_array_disk_share_enabled_bundle() -> bool:
    """Expose `shareEnabled` on the `ArrayDisk` GraphQL type.

    Pool entries in `disks.ini` carry a `shareEnabled="yes"|"no"` flag
    that controls whether the pool is selectable as primary/secondary
    storage in the legacy share editor. The official `ArrayDisk` does
    not expose it, so the mobile share editor can't replicate the web
    UI's filtering and ends up offering pools that the user already
    disabled in Pool Settings.

    Same shape as `patch_share_extra_fields_bundle()` — injects a
    single `_ts_decorate([Field(...)], ArrayDisk.prototype, "shareEnabled",
    void 0)` block before the final ObjectType class decoration in
    `index-*.js`. Runtime values are populated by the companion's
    sibling slots-parser patch.

    Tracked upstream: PR pending on the unraid-api fork
    (fix/share-mutations).
    """
    candidates = glob.glob(INDEX_BUNDLE_GLOB)
    bundle = next(
        (
            p
            for p in candidates
            if '], ArrayDisk.prototype, "isSpinning", void 0);' in open(p).read()
        ),
        None,
    )
    if not bundle:
        log("array-disk-share-enabled: index bundle with ArrayDisk not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if ARRAY_DISK_SHARE_ENABLED_MARKER in content:
        return False

    anchor = (
        '], ArrayDisk.prototype, "isSpinning", void 0);\n'
        "ArrayDisk = _ts_decorate([\n"
    )
    if anchor not in content:
        log("array-disk-share-enabled: anchor not found")
        return False

    field_block = (
        ARRAY_DISK_SHARE_ENABLED_MARKER + "\n"
        "_ts_decorate([\n"
        "    Field(()=>Boolean, {\n"
        "        nullable: true,\n"
        "        description: 'For pool devices, whether the pool is allowed to back user shares (`shareEnabled` flag from disks.ini).'\n"
        "    }),\n"
        "    _ts_metadata(\"design:type\", Object)\n"
        "], ArrayDisk.prototype, \"shareEnabled\", void 0);\n"
    )

    content = content.replace(
        anchor,
        '], ArrayDisk.prototype, "isSpinning", void 0);\n'
        + field_block
        + "ArrayDisk = _ts_decorate([\n",
        1,
    )
    with open(bundle, "w") as f:
        f.write(content)
    log(f"patched ArrayDisk.shareEnabled in {os.path.basename(bundle)}")
    return True


def patch_slots_parser_share_enabled_bundle() -> bool:
    """Preserve `shareEnabled` on parsed ArrayDisk entities.

    The slots parser at `api/src/store/state-parsers/slots.ts`
    constructs each `ArrayDisk` result with an explicit field list
    that excludes `shareEnabled` — even though the source ini entry
    has it for pool devices. The complementary
    `patch_array_disk_share_enabled_bundle` patch exposes the
    GraphQL field, but without this passthrough the resolver reads
    `undefined` from every entity.

    Idempotent via substring check on the new assignment.
    Tracked upstream: PR pending on the unraid-api fork
    (fix/share-mutations).
    """
    candidates = glob.glob("/usr/local/unraid-api/dist/assets/slots-*.js")
    bundle = next(
        (p for p in candidates if SLOTS_PARSER_OLD in open(p).read()),
        None,
    )
    if not bundle:
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if "shareEnabled: slot.shareEnabled" in content:
        return False
    content = content.replace(SLOTS_PARSER_OLD, SLOTS_PARSER_NEW, 1)
    with open(bundle, "w") as f:
        f.write(content)
    log(f"patched slots parser shareEnabled passthrough in {os.path.basename(bundle)}")
    return True


def patch_shares_parser_use_cache_bundle() -> bool:
    """Preserve `useCache` on parsed share entities.

    The state parser at `api/src/store/state-parsers/shares.ts`
    destructures `useCache` from the ini and uses it only to derive
    `cache: useCache === 'yes'` — the raw `useCache` value is dropped.
    The companion's `patch_share_extra_fields_bundle()` exposes a
    `useCache` GraphQL field, so this complementary patch makes sure
    the runtime entity actually carries the value the resolver reads.

    Idempotent via the `useCache,\\n            cache: useCache` check.
    Tracked upstream: PR pending on the unraid-api fork
    (fix/share-mutations).
    """
    candidates = glob.glob("/usr/local/unraid-api/dist/assets/shares-*.js")
    bundle = next(
        (p for p in candidates if SHARES_PARSER_OLD in open(p).read()),
        None,
    )
    if not bundle:
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if "useCache,\n            cache: useCache" in content:
        return False
    content = content.replace(SHARES_PARSER_OLD, SHARES_PARSER_NEW, 1)
    with open(bundle, "w") as f:
        f.write(content)
    log(f"patched shares parser useCache passthrough in {os.path.basename(bundle)}")
    return True


def patch_share_mutations_bundle() -> bool:
    """Expose `createShare`, `updateShare` and `deleteShare` mutations.

    The official unraid-api ships a stub at
    `api/src/core/modules/add-share.ts` that throws `NotImplementedError`
    and isn't even wired into the schema. Share CRUD in stock Unraid
    goes through the legacy emhttp PHP UI which POSTs to the emhttpd
    unix socket at `/var/run/emhttpd.socket` with form-encoded fields.

    This patch injects three new methods onto the existing
    `SharesResolver.prototype` plus the matching NestJS `@Mutation`
    decorator calls so the GraphQL schema picks them up at runtime.
    The methods reuse the bundle's existing `emcmd()` helper, which
    already knows how to talk to the socket and inject the CSRF token
    from `/var/local/emhttp/var.ini`.

    Shape:
        createShare(name: String!, settings: JSON): Share
        updateShare(name: String!, settings: JSON): Share
        deleteShare(name: String!): Boolean!

    `settings` is a `GraphQLJSON` scalar with optional keys: `comment`,
    `cachePool`, `cachePool2`, `useCache`, `cow`, `floor`, `allocator`,
    `splitLevel`, `include[]`, `exclude[]`. Omitted keys keep their
    current value on update; on create they fall back to emhttpd's
    defaults (matches what the legacy UI sends from `ShareEdit.page`
    when the user clicks "Add Share" with all defaults).

    Tracked upstream: PR pending on the unraid-api fork
    (fix/share-mutations).
    """
    bundle = find_bundle()
    if not bundle:
        log("share-mutations patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if SHARE_MUTATIONS_MARKER in content:
        return False

    # The class is closed by exactly this 5-line decoration. We inject the
    # mutation overlay immediately after it so the new prototype methods
    # are visible to the decorator calls that follow.
    anchor = (
        "SharesResolver = _ts_decorate$6([\n"
        "    Resolver(()=>Share),\n"
        '    _ts_metadata$4("design:type", Function),\n'
        '    _ts_metadata$4("design:paramtypes", [])\n'
        "], SharesResolver);"
    )
    if anchor not in content:
        log("share-mutations patch: SharesResolver class decoration anchor not found")
        return False

    overlay = "\n" + SHARE_MUTATIONS_MARKER + "\n" + r"""
function _ts_param$share(paramIndex, decorator) {
    return function(target, key) { decorator(target, key, paramIndex); };
}
;(() => {
    const proto = SharesResolver.prototype;
    const VALID_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;
    // The bundle is loaded as an ES module, so `require()` is unavailable.
    // Cache the dynamic-import promises once so the modules resolve on
    // first call and every subsequent invocation pays no cost.
    const netModulePromise = import('node:net');
    const fsPromiseModulePromise = import('node:fs/promises');
    const timersPromiseModulePromise = import('node:timers/promises');

    function buildCommands(s) {
        s = s || {};
        return {
            shareComment: s.comment != null ? String(s.comment) : '',
            shareCachePool: s.cachePool != null ? String(s.cachePool) : '',
            shareCachePool2: s.cachePool2 != null ? String(s.cachePool2) : '',
            shareUseCache: s.useCache != null ? String(s.useCache) : '',
            shareCOW: s.cow != null ? String(s.cow) : 'auto',
            shareFloor: s.floor != null ? String(s.floor) : '',
            shareAllocator: s.allocator != null ? String(s.allocator) : 'highwater',
            shareSplitLevel: s.splitLevel != null ? String(s.splitLevel) : '',
            shareInclude: Array.isArray(s.include) ? s.include.join(',') : '',
            shareExclude: Array.isArray(s.exclude) ? s.exclude.join(',') : '',
        };
    }

    function validateName(name) {
        if (!name || typeof name !== 'string') throw new Error('Share name is required.');
        if (name.length > 40) throw new Error('Share name must be at most 40 characters.');
        if (!VALID_NAME_RE.test(name)) throw new Error('Invalid share name. Must start with a letter and contain only letters, digits, dot, underscore or hyphen.');
        if (name.endsWith('.')) throw new Error('Share name may not end with a dot.');
    }

    async function readCsrfToken() {
        try {
            const { readFile } = await fsPromiseModulePromise;
            const data = await readFile('/var/local/emhttp/var.ini', 'utf-8');
            const m = data.match(/^csrf_token=\"?([^\"\n]+)\"?/m);
            return m ? m[1] : '';
        } catch (e) { return ''; }
    }

    /**
     * Send a form-encoded POST to /var/run/emhttpd.socket and return the
     * raw response body. emhttpd replies with HTTP/0.9 on success (just
     * the body, no status line) and a partial HTTP/1.1 frame on error,
     * so we bypass Node's http parser and read bytes directly off the
     * socket.
     */
    async function callEmhttpd(commands) {
        const { createConnection } = await netModulePromise;
        const csrf = await readCsrfToken();
        if (!csrf) {
            throw new Error('CSRF token unavailable. Is /var/local/emhttp/var.ini readable?');
        }
        const body = new URLSearchParams(Object.assign({}, commands, { csrf_token: csrf })).toString();
        const request =
            'POST /update HTTP/1.1\r\n' +
            'Host: localhost\r\n' +
            'Content-Type: application/x-www-form-urlencoded\r\n' +
            'Content-Length: ' + Buffer.byteLength(body) + '\r\n' +
            'Connection: close\r\n' +
            '\r\n' +
            body;
        return await new Promise((resolve, reject) => {
            const socket = createConnection('/var/run/emhttpd.socket');
            const chunks = [];
            let settled = false;
            let idleTimer;
            const settle = (ok, payload) => {
                if (settled) return;
                settled = true;
                if (idleTimer) clearTimeout(idleTimer);
                try { socket.destroy(); } catch (e) {}
                if (ok) resolve(payload); else reject(payload);
            };
            // Hard ceiling — emhttpd's `cmdEditShare=Add Share` and
            // `=Delete` respond fast (sub-second) but `=Apply` (update)
            // can sit on the connection for ~12s before sending the HTTP
            // headers. 30s is comfortable for all three; anything longer
            // and the socket is truly stuck.
            socket.setTimeout(30000);
            socket.on('connect', () => {
                // Half-close the write side immediately — emhttpd's HTTP/0.9
                // success response leaves the read side open indefinitely
                // otherwise, because there is no Content-Length or
                // chunked-encoding marker for the parser to detect EOF.
                socket.end(request);
            });
            socket.on('data', (chunk) => {
                chunks.push(chunk);
                // Some response bodies arrive in two fragments — debounce
                // 200ms after the last byte before declaring "done".
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(
                    () => settle(true, Buffer.concat(chunks).toString('utf8')),
                    200
                );
            });
            socket.on('end', () => settle(true, Buffer.concat(chunks).toString('utf8')));
            socket.on('timeout', () => settle(false, new Error('emhttpd socket timeout')));
            socket.on('error', (err) => settle(false, err));
        });
    }

    /**
     * Detect explicit failure in emhttpd's response body.
     * Success bodies look like `<script>replaceName("name");</script>`.
     * Failure bodies are bare strings such as `500 Internal Server Error`
     * or a partial HTTP/1.1 frame whose body contains the error text.
     */
    function isFailureResponse(body) {
        if (!body) return false;
        if (/<script\b/i.test(body)) return false;
        if (/^\s*500\b|Internal Server Error|Bad Request|Unauthorized|Forbidden/i.test(body)) return true;
        return false;
    }

    /**
     * Poll `getShares('users')` for at most `maxMs` until `predicate`
     * returns truthy on its result. Returns the matched share or
     * `undefined` if it never appeared.
     *
     * The in-memory share store is refreshed by a chokidar watcher
     * around `/usr/local/emhttp/state/shares.ini`. That refresh races
     * with our mutation completing, so we have to poll instead of
     * sleeping for a fixed duration.
     */
    async function pollForShare(predicate, maxMs) {
        const { setTimeout: delay } = await timersPromiseModulePromise;
        const start = Date.now();
        const step = 50;
        while (Date.now() - start < maxMs) {
            const match = getShares('users').find(predicate);
            if (match) return match;
            await delay(step);
        }
        return undefined;
    }

    proto.createShare = async function patchedCreateShare(name, settings) {
        validateName(name);
        const existing = getShares('users').find(s => s.name === name);
        if (existing) throw new Error('A share named "' + name + '" already exists.');
        const response = await callEmhttpd(Object.assign({
            cmdEditShare: 'Add Share',
            shareName: name,
            shareNameOrig: '',
        }, buildCommands(settings)));
        if (isFailureResponse(response)) {
            throw new Error('emhttpd refused createShare: ' + response.trim().slice(0, 200));
        }
        const created = await pollForShare(s => s.name === name, 10000);
        if (!created) {
            // The state file watcher hasn't picked up the new share yet —
            // the .cfg is on disk, but the in-memory store is stale. Rather
            // than fail (the share IS created on disk), return a synthetic
            // entity built from the input so the client gets a useful
            // response and can refetch the shares list itself.
            return {
                id: name,
                name,
                comment: settings && settings.comment != null ? String(settings.comment) : '',
                allocator: settings && settings.allocator != null ? String(settings.allocator) : 'highwater',
                cow: settings && settings.cow != null ? String(settings.cow) : 'auto',
                splitLevel: settings && settings.splitLevel != null ? String(settings.splitLevel) : '',
                floor: settings && settings.floor != null ? String(settings.floor) : '',
                useCache: settings && settings.useCache != null ? String(settings.useCache) : '',
                include: Array.isArray(settings && settings.include) ? settings.include : [],
                exclude: Array.isArray(settings && settings.exclude) ? settings.exclude : [],
                size: 0,
                free: null,
                used: 0,
                cache: null,
                nameOrig: name,
                color: null,
                luksStatus: null,
            };
        }
        return created;
    };

    proto.updateShare = async function patchedUpdateShare(name, settings) {
        if (!name) throw new Error('Share name is required.');
        const current = getShares('users').find(s => s.name === name);
        if (!current) throw new Error('No share named "' + name + '".');
        const merged = Object.assign({
            comment: current.comment,
            cachePool: current.cachePool,
            cachePool2: current.cachePool2,
            useCache: current.useCache,
            cow: current.cow,
            floor: current.floor,
            allocator: current.allocator,
            splitLevel: current.splitLevel,
            include: current.include,
            exclude: current.exclude,
        }, settings || {});
        const response = await callEmhttpd(Object.assign({
            cmdEditShare: 'Apply',
            shareName: name,
            shareNameOrig: name,
        }, buildCommands(merged)));
        if (isFailureResponse(response)) {
            throw new Error('emhttpd refused updateShare: ' + response.trim().slice(0, 200));
        }
        // No reliable comparable field on the Share entity here — just
        // wait briefly for the state file to refresh and return what we
        // see. If the predicate fails the caller still gets the prior
        // value, which matches "best-effort" semantics for updates.
        const { setTimeout: delay } = await timersPromiseModulePromise;
        await delay(300);
        return getShares('users').find(s => s.name === name);
    };

    proto.deleteShare = async function patchedDeleteShare(name) {
        if (!name) throw new Error('Share name is required.');
        const existing = getShares('users').find(s => s.name === name);
        if (!existing) throw new Error('No share named "' + name + '".');
        const response = await callEmhttpd({
            cmdEditShare: 'Delete',
            confirmDelete: 'on',
            shareName: name,
            shareNameOrig: name,
        });
        if (isFailureResponse(response)) {
            throw new Error('emhttpd refused deleteShare: ' + response.trim().slice(0, 200));
        }
        return true;
    };
})();
_ts_decorate$6([
    Mutation(()=>Share, {
        description: 'Create a new user share.'
    }),
    UsePermissions({
        action: AuthAction.CREATE_ANY,
        resource: Resource.SHARE
    }),
    _ts_param$share(0, Args('name', { type: ()=>String })),
    _ts_param$share(1, Args('settings', { type: ()=>GraphQLJSON, nullable: true })),
    _ts_metadata$4("design:type", Function),
    _ts_metadata$4("design:paramtypes", [String, Object]),
    _ts_metadata$4("design:returntype", Promise)
], SharesResolver.prototype, "createShare", null);
_ts_decorate$6([
    Mutation(()=>Share, {
        description: 'Update an existing user share. Omitted fields keep their current value.'
    }),
    UsePermissions({
        action: AuthAction.UPDATE_ANY,
        resource: Resource.SHARE
    }),
    _ts_param$share(0, Args('name', { type: ()=>String })),
    _ts_param$share(1, Args('settings', { type: ()=>GraphQLJSON, nullable: true })),
    _ts_metadata$4("design:type", Function),
    _ts_metadata$4("design:paramtypes", [String, Object]),
    _ts_metadata$4("design:returntype", Promise)
], SharesResolver.prototype, "updateShare", null);
_ts_decorate$6([
    Mutation(()=>Boolean, {
        description: 'Delete a user share by name. The share directory must be empty.'
    }),
    UsePermissions({
        action: AuthAction.DELETE_ANY,
        resource: Resource.SHARE
    }),
    _ts_param$share(0, Args('name', { type: ()=>String })),
    _ts_metadata$4("design:type", Function),
    _ts_metadata$4("design:paramtypes", [String]),
    _ts_metadata$4("design:returntype", Promise)
], SharesResolver.prototype, "deleteShare", null);
"""

    content = content.replace(anchor, anchor + overlay, 1)
    with open(bundle, "w") as f:
        f.write(content)
    log(f"patched share mutations in {os.path.basename(bundle)}")
    return True


SHARE_SECURITY_MARKER = "/* u-manager-companion: share-security override v2 */"
# Legacy marker from v1 of this patch — the v1 `shareSecurity` resolver
# read fields off `getShares('users')` which never carries SMB security
# data (that lives in /usr/local/emhttp/state/sec.ini). v2 reads sec.ini
# directly. We strip the v1 block on every apply so existing installs
# migrate cleanly.
SHARE_SECURITY_LEGACY_MARKER = (
    "/* u-manager-companion: share-security override */"
)

def patch_share_security_bundle() -> bool:
    """Expose SMB security state + mutations for the share editor's
    second-step flow.

    The legacy web UI's `SecuritySMB.page` is a separate page that
    edits per-share `export` / `caseSensitive` / `security` /
    `readList` / `writeList` / `volsizelimit` and a per-user access
    matrix (read-write / read-only / no-access). Backend POSTs use
    two emhttpd commands distinct from share CRUD:

      * `changeShareSecurity=Apply` with shareName + shareExport +
        shareSecurity + shareCaseSensitive + shareVolsizelimit
      * `changeShareAccess=Apply` with shareName +
        `userAccess.<idx>=read-write|read-only|no-access` per user

    We expose three new GraphQL fields on `SharesResolver`:

      shareSecurity(name): JSON       — current SMB security blob
      shareSecurityUsers: JSON        — array of {id, name, isRoot}
      updateShareSecurity(name, settings): Boolean
      updateShareAccess(name, access): Boolean

    The `users` and `shareSecurity` shapes are returned as the raw
    `GraphQLJSON` scalar — the client deserialises them. Same pattern
    as the existing share mutations.

    Tracked upstream: PR pending on the unraid-api fork
    (fix/share-security).
    """
    bundle = find_bundle()
    if not bundle:
        log("share-security patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()

    # ── Legacy cleanup ───────────────────────────────────────────────
    # If v1 of the patch is in the bundle, strip the entire block
    # before re-applying v2. The v1 block always ends at the
    # updateShareAccess `_ts_decorate$6(...)` closing call — anchor
    # the regex on that to stay precise.
    if SHARE_SECURITY_LEGACY_MARKER in content:
        legacy_pattern = re.compile(
            re.escape(SHARE_SECURITY_LEGACY_MARKER)
            + r".*?\], SharesResolver\.prototype, \"updateShareAccess\", null\);\n?",
            re.DOTALL,
        )
        new_content, removed = legacy_pattern.subn("", content, count=1)
        if removed:
            content = new_content
            with open(bundle, "w") as f:
                f.write(content)
            log("share-security patch: removed legacy v1 block")
            # Re-read so subsequent anchors still match the fresh content.

    if SHARE_SECURITY_MARKER in content:
        return False

    # We chain after the share-mutations overlay, which itself sits
    # right after `SharesResolver = _ts_decorate$6([...], SharesResolver);`.
    # The chain is robust because we anchor on the marker of the
    # previous patch — that marker is guaranteed present whenever
    # share mutations are active (and we always run them before
    # share-security in main()).
    anchor = SHARE_MUTATIONS_MARKER
    if anchor not in content:
        log(
            "share-security patch: share-mutations marker not present; "
            "the security overlay depends on it being applied first"
        )
        return False

    # Find the END of the share-mutations overlay so we can insert
    # AFTER it. Use the last decorator block of that overlay as the
    # tail anchor — it ends with `..., "deleteShare", null);`.
    tail = '], SharesResolver.prototype, "deleteShare", null);\n'
    tail_idx = content.find(tail, content.find(anchor))
    if tail_idx == -1:
        log("share-security patch: share-mutations tail not found")
        return False
    insert_at = tail_idx + len(tail)

    overlay = "\n" + SHARE_SECURITY_MARKER + "\n" + r"""
;(() => {
    const proto = SharesResolver.prototype;
    // Reuse the dynamic-import promises declared by the share-mutations
    // overlay — they're already in module scope thanks to that earlier
    // injection.
    const netModulePromiseSec = import('node:net');
    const fsPromiseModulePromiseSec = import('node:fs/promises');
    const iniModulePromiseSec = import('ini');
    const timersPromiseModulePromiseSec = import('node:timers/promises');

    async function readCsrfTokenSec() {
        try {
            const { readFile } = await fsPromiseModulePromiseSec;
            const data = await readFile('/var/local/emhttp/var.ini', 'utf-8');
            const m = data.match(/^csrf_token=\"?([^\"\n]+)\"?/m);
            return m ? m[1] : '';
        } catch (e) { return ''; }
    }

    async function callEmhttpdSec(commands) {
        const { createConnection } = await netModulePromiseSec;
        const csrf = await readCsrfTokenSec();
        if (!csrf) throw new Error('CSRF token unavailable.');
        const body = new URLSearchParams(Object.assign({}, commands, { csrf_token: csrf })).toString();
        const request =
            'POST /update HTTP/1.1\r\n' +
            'Host: localhost\r\n' +
            'Content-Type: application/x-www-form-urlencoded\r\n' +
            'Content-Length: ' + Buffer.byteLength(body) + '\r\n' +
            'Connection: close\r\n' +
            '\r\n' +
            body;
        return await new Promise((resolve, reject) => {
            const socket = createConnection('/var/run/emhttpd.socket');
            const chunks = [];
            let settled = false;
            let idleTimer;
            const settle = (ok, payload) => {
                if (settled) return;
                settled = true;
                if (idleTimer) clearTimeout(idleTimer);
                try { socket.destroy(); } catch (e) {}
                if (ok) resolve(payload); else reject(payload);
            };
            socket.setTimeout(30000);
            socket.on('connect', () => socket.end(request));
            socket.on('data', (chunk) => {
                chunks.push(chunk);
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(
                    () => settle(true, Buffer.concat(chunks).toString('utf8')),
                    200
                );
            });
            socket.on('end', () => settle(true, Buffer.concat(chunks).toString('utf8')));
            socket.on('timeout', () => settle(false, new Error('emhttpd socket timeout')));
            socket.on('error', (err) => settle(false, err));
        });
    }

    function isFailureResponseSec(body) {
        if (!body) return false;
        if (/<script\b/i.test(body)) return false;
        if (/^\s*500\b|Internal Server Error|Bad Request|Unauthorized|Forbidden/i.test(body)) return true;
        return false;
    }

    proto.shareSecurity = async function patchedShareSecurity(name) {
        if (!name) throw new Error('Share name is required.');
        const share = getShares('users').find(s => s.name === name);
        if (!share) throw new Error('No share named "' + name + '".');
        // The SMB security blob lives in /usr/local/emhttp/state/sec.ini,
        // not in shares.ini. `getShares('users')` only returns
        // shares.ini-derived data, so it never carries `export`,
        // `caseSensitive`, `security`, `readList`, `writeList` or
        // `volsizelimit`. Read sec.ini directly to get the real
        // current state — any IO/parse error falls back to defaults
        // so a missing sec.ini doesn't break the editor entirely.
        let sec = {};
        try {
            const { readFile } = await fsPromiseModulePromiseSec;
            const ini = await iniModulePromiseSec;
            const content = await readFile('/usr/local/emhttp/state/sec.ini', 'utf-8');
            const parsed = ini.parse ? ini.parse(content) : ini.default.parse(content);
            sec = parsed[name] || {};
        } catch (e) { /* defaults below */ }
        return {
            export: sec.export || '-',
            security: sec.security || 'public',
            caseSensitive: sec.caseSensitive || 'auto',
            readList: sec.readList ? String(sec.readList).split(',').filter(Boolean) : [],
            writeList: sec.writeList ? String(sec.writeList).split(',').filter(Boolean) : [],
            volsizelimit: sec.volsizelimit != null ? String(sec.volsizelimit) : '',
        };
    };

    proto.shareSecurityUsers = async function patchedShareSecurityUsers() {
        try {
            const { readFile } = await fsPromiseModulePromiseSec;
            const ini = await iniModulePromiseSec;
            const content = await readFile('/usr/local/emhttp/state/users.ini', 'utf-8');
            const parsed = ini.parse ? ini.parse(content) : ini.default.parse(content);
            return Object.entries(parsed).map(([key, data]) => ({
                id: String(data.idx ?? key),
                name: data.name || key,
                description: data.desc || '',
                isRoot: (data.name || key) === 'root',
            }));
        } catch (e) {
            return [];
        }
    };

    proto.updateShareSecurity = async function patchedUpdateShareSecurity(name, settings) {
        if (!name) throw new Error('Share name is required.');
        settings = settings || {};
        const response = await callEmhttpdSec({
            changeShareSecurity: 'Apply',
            shareName: name,
            shareExport: settings.export != null ? String(settings.export) : '-',
            shareSecurity: settings.security != null ? String(settings.security) : 'public',
            shareCaseSensitive: settings.caseSensitive != null ? String(settings.caseSensitive) : 'auto',
            shareVolsizelimit: settings.volsizelimit != null ? String(settings.volsizelimit) : '',
        });
        if (isFailureResponseSec(response)) {
            throw new Error('emhttpd refused updateShareSecurity: ' + response.trim().slice(0, 200));
        }
        const { setTimeout: delay } = await timersPromiseModulePromiseSec;
        await delay(150);
        return true;
    };

    proto.updateShareAccess = async function patchedUpdateShareAccess(name, access) {
        if (!name) throw new Error('Share name is required.');
        if (!Array.isArray(access)) throw new Error('access must be a list of {userId, access} entries.');
        const payload = { changeShareAccess: 'Apply', shareName: name };
        for (const entry of access) {
            if (!entry || entry.userId == null) continue;
            const value = String(entry.access || 'no-access');
            payload['userAccess.' + String(entry.userId)] = value;
        }
        const response = await callEmhttpdSec(payload);
        if (isFailureResponseSec(response)) {
            throw new Error('emhttpd refused updateShareAccess: ' + response.trim().slice(0, 200));
        }
        const { setTimeout: delay } = await timersPromiseModulePromiseSec;
        await delay(150);
        return true;
    };
})();
_ts_decorate$6([
    Query(()=>GraphQLJSON, {
        description: 'Current SMB security state for a user share.'
    }),
    UsePermissions({
        action: AuthAction.READ_ANY,
        resource: Resource.SHARE
    }),
    _ts_param$share(0, Args('name', { type: ()=>String })),
    _ts_metadata$4("design:type", Function),
    _ts_metadata$4("design:paramtypes", [String]),
    _ts_metadata$4("design:returntype", Promise)
], SharesResolver.prototype, "shareSecurity", null);
_ts_decorate$6([
    Query(()=>GraphQLJSON, {
        description: 'List of Unraid users available for share access control.'
    }),
    UsePermissions({
        action: AuthAction.READ_ANY,
        resource: Resource.SHARE
    }),
    _ts_metadata$4("design:type", Function),
    _ts_metadata$4("design:paramtypes", []),
    _ts_metadata$4("design:returntype", Promise)
], SharesResolver.prototype, "shareSecurityUsers", null);
_ts_decorate$6([
    Mutation(()=>Boolean, {
        description: 'Update SMB security for a share (export, security mode, case-sensitive, Time Machine size).'
    }),
    UsePermissions({
        action: AuthAction.UPDATE_ANY,
        resource: Resource.SHARE
    }),
    _ts_param$share(0, Args('name', { type: ()=>String })),
    _ts_param$share(1, Args('settings', { type: ()=>GraphQLJSON, nullable: true })),
    _ts_metadata$4("design:type", Function),
    _ts_metadata$4("design:paramtypes", [String, Object]),
    _ts_metadata$4("design:returntype", Promise)
], SharesResolver.prototype, "updateShareSecurity", null);
_ts_decorate$6([
    Mutation(()=>Boolean, {
        description: 'Update per-user access for a share (read-write/read-only/no-access by user id).'
    }),
    UsePermissions({
        action: AuthAction.UPDATE_ANY,
        resource: Resource.SHARE
    }),
    _ts_param$share(0, Args('name', { type: ()=>String })),
    _ts_param$share(1, Args('access', { type: ()=>GraphQLJSON })),
    _ts_metadata$4("design:type", Function),
    _ts_metadata$4("design:paramtypes", [String, Object]),
    _ts_metadata$4("design:returntype", Promise)
], SharesResolver.prototype, "updateShareAccess", null);
"""

    content = content[:insert_at] + overlay + content[insert_at:]
    with open(bundle, "w") as f:
        f.write(content)
    log(f"patched share security in {os.path.basename(bundle)}")
    return True


SHARE_IS_EMPTY_MARKER = "/* u-manager-companion: share-is-empty */"
# Legacy marker from the first iteration of this patch — when it also
# exposed a `companionInfo` resolver for client-side companion
# detection. The client now uses the upstream `installedUnraidPlugins`
# query for detection, so the bundled resolver is dead code. We strip
# the old block on every apply so installs that already received the
# v1 patch migrate cleanly.
SHARE_IS_EMPTY_LEGACY_MARKER = (
    "/* u-manager-companion: companion-info + share-is-empty */"
)

def patch_share_is_empty_bundle() -> bool:
    """Expose `shareIsEmpty(name: String!): Boolean!` so the U-Manager
    share editor can decide whether to surface the Delete button.

    emhttpd refuses to remove a non-empty share, and turning that into
    a button-press error is poor UX. We mirror the legacy web UI's
    `ShareList.php?scan=<name>` algorithm (RecursiveDirectoryIterator,
    skip `.DS_Store`, stop at the first real file) in a Node helper
    attached to `SharesResolver.prototype`.

    The TS counterpart lives in
    `unraid-api/api/src/unraid-api/graph/shares/shares.resolver.ts`
    (`shareIsEmpty`) on the `fix/share-mutations` branch and is the
    canonical source for the upstream PR.

    Attached to `SharesResolver` rather than a new `@Resolver` class
    because adding one at runtime would also require injecting NestJS
    module wiring — much more invasive. NestJS merges every resolver's
    queries into a single root, so the client sees it at
    `query.shareIsEmpty` regardless of host.
    """
    bundle = find_bundle()
    if not bundle:
        log("share-is-empty patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()

    # ── Legacy cleanup ───────────────────────────────────────────────
    # If the bundle already has the v1 marker, snip the entire old
    # block out before doing anything else. The block always ends with
    # the shareIsEmpty `_ts_decorate$6(...)` closing call — anchor on
    # that line so the regex stays specific.
    if SHARE_IS_EMPTY_LEGACY_MARKER in content:
        legacy_pattern = re.compile(
            re.escape(SHARE_IS_EMPTY_LEGACY_MARKER)
            + r".*?\], SharesResolver\.prototype, \"shareIsEmpty\", null\);\n?",
            re.DOTALL,
        )
        new_content, removed = legacy_pattern.subn("", content, count=1)
        if removed:
            content = new_content
            log("share-is-empty patch: removed legacy companion-info block")

    if SHARE_IS_EMPTY_MARKER in content:
        # Need to write back even if the new marker is already there:
        # the legacy cleanup may have modified `content`.
        with open(bundle, "w") as f:
            f.write(content)
        return False

    # Anchor at the end of the share-security patch: every patch_*
    # function so far appends straight onto SharesResolver, so we tail
    # the last decoration we added — `updateShareAccess` — and inject
    # right after its closing `_ts_decorate$6(...)`. If that anchor is
    # missing it means the share-security patch hasn't run yet and we
    # bail; main() runs patches in a fixed order so the dependency is
    # implicit.
    anchor = '], SharesResolver.prototype, "updateShareAccess", null);'
    if anchor not in content:
        log("share-is-empty patch: updateShareAccess anchor not found")
        return False

    overlay = "\n" + SHARE_IS_EMPTY_MARKER + "\n" + r"""
function _ts_param$shareIsEmpty(paramIndex, decorator) {
    return function(target, key) { decorator(target, key, paramIndex); };
}
;(() => {
    const proto = SharesResolver.prototype;
    const fsPromiseModulePromise = import('node:fs/promises');
    const pathModulePromise = import('node:path');

    /**
     * Walk `/mnt/user/<name>` recursively and return true when nothing
     * user-visible lives inside.
     *
     * Directories on their own don't count, `.DS_Store` is ignored
     * (macOS dumps these on every SMB share), symlinks are followed,
     * and the iteration stops on the first real file — so populated
     * shares are detected in O(1) and only empty shares pay the full
     * traversal cost. Any IO error resolves to `true` so the caller
     * never blocks the Delete button on a transient FS issue.
     */
    async function scanEmpty(directory) {
        const { readdir, stat } = await fsPromiseModulePromise;
        const { join } = await pathModulePromise;
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch (e) {
            return true;
        }
        for (const entry of entries) {
            const entryPath = join(directory, entry.name);
            let isDir = entry.isDirectory();
            let isFile = entry.isFile();
            if (entry.isSymbolicLink()) {
                try {
                    const s = await stat(entryPath);
                    isDir = s.isDirectory();
                    isFile = s.isFile();
                } catch (e) { continue; }
            }
            if (isFile && entry.name !== '.DS_Store') return false;
            if (isDir) {
                const childEmpty = await scanEmpty(entryPath);
                if (!childEmpty) return false;
            }
        }
        return true;
    }

    proto.shareIsEmpty = async function patchedShareIsEmpty(name) {
        if (!name || typeof name !== 'string') return true;
        return scanEmpty('/mnt/user/' + name);
    };
})();
_ts_decorate$6([
    Query(()=>Boolean, {
        description: 'Returns true when /mnt/user/<name> contains no user-visible files. Mirrors the legacy ShareList.php?scan=<name> handler.'
    }),
    UsePermissions({
        action: AuthAction.READ_ANY,
        resource: Resource.SHARE
    }),
    _ts_param$shareIsEmpty(0, Args('name', { type: ()=>String })),
    _ts_metadata$4("design:type", Function),
    _ts_metadata$4("design:paramtypes", [String]),
    _ts_metadata$4("design:returntype", Promise)
], SharesResolver.prototype, "shareIsEmpty", null);
"""

    insert_at = content.index(anchor) + len(anchor)
    content = content[:insert_at] + overlay + content[insert_at:]
    with open(bundle, "w") as f:
        f.write(content)
    log(f"patched shareIsEmpty in {os.path.basename(bundle)}")
    return True


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
    log(f"patched disks-service no-wake in {os.path.basename(bundle)}")
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
    changed_array_subscription = patch_array_subscription_bundle()
    changed_changelog_cdata = patch_changelog_cdata_strip_bundle()
    changed_share_mutations = patch_share_mutations_bundle()
    changed_share_security = patch_share_security_bundle()
    changed_share_extra_fields = patch_share_extra_fields_bundle()
    changed_shares_parser = patch_shares_parser_use_cache_bundle()
    changed_array_disk_share_enabled = patch_array_disk_share_enabled_bundle()
    changed_slots_parser = patch_slots_parser_share_enabled_bundle()
    changed_share_is_empty = patch_share_is_empty_bundle()
    changed_disks_service = patch_disks_service_bundle()
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
        changed_array_subscription,
        changed_changelog_cdata,
        changed_share_mutations,
        changed_share_security,
        changed_share_extra_fields,
        changed_shares_parser,
        changed_array_disk_share_enabled,
        changed_slots_parser,
        changed_share_is_empty,
        changed_disks_service,
    ]):
        restart_api()
        log("patches applied — unraid-api will restart")
    else:
        log("no changes needed (already patched)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
