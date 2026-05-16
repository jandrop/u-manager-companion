# U-Manager Companion

An Unraid plugin that monkey-patches the official `unraid-api` GraphQL
bundle on boot to expose data the [U-Manager](https://u-manager.app)
mobile app needs but that upstream either ships as a stub or has a
real-time bug. Each patch is independently idempotent and disappears
naturally once upstream merges the equivalent fix.

> **Why a plugin, not just a config?** Unraid rebuilds
> `/usr/local/unraid-api/` from a read-only squashfs image on every
> boot. Anything we edit there evaporates on reboot or `unraid-api`
> upgrade. The plugin's `apply.sh` script runs on every boot, so the
> patches are re-applied automatically and silently.

---

## Install

In the Unraid WebGUI → **Plugins** → **Install Plugin**, paste:

```
https://raw.githubusercontent.com/jandrop/u-manager-companion/main/UManagerCompanion.plg
```

Click **INSTALL**. The patches apply immediately; the `unraid-api`
service restarts so changes take effect.

To update later, click **CHECK FOR UPDATES** on the Plugins tab —
the `.plg` is fetched fresh from this repo on every install/upgrade,
so anything committed to `main` propagates automatically.

## Uninstall

**Plugins** → **u-manager-companion** → **REMOVE**.

The currently-patched bundle stays active until the next reboot. On
the next boot, Unraid loads the pristine bundle from squashfs and no
patch is reapplied (the plugin is gone), so the API returns to
upstream behaviour without any further action.

---

## What it patches

### 1. Network device monitoring — `info.devices.network` + `systemMetricsNetwork`

- **Type:** mixed — bug fix (stubbed query) + feature add (new fields + new subscription)
- **Upstream tracking:** [unraid/api#1818](https://github.com/unraid/api/issues/1818)
- **Why U-Manager needs it:** the dashboard renders a Network Interfaces card with live up/down speed per interface (bond0, eth0, etc.). Without this patch, `info.devices.network` returns an empty array and there is no subscription to drive live updates — so the card has no data to show.

The patch replaces the stubbed `DevicesService.generateNetwork()` with a real implementation that reads `/sys/class/net/`, walks `bond.active_slave` to resolve PCI slots, propagates the user-bridge IP (`br0` → bond0 / eth0), and samples `/proc/net/dev` twice (1 s apart) to compute per-second rates. It also adds a `metrics.network` resolver and a `systemMetricsNetwork` subscription that polls every second and publishes the same payload over the existing pubsub channel pattern.

**Sample query** — one-off interface snapshot:

```graphql
query {
  info {
    devices {
      network {
        iface
        type
        status
        ipAddress
        speed
        rxBytesPerSec
        txBytesPerSec
      }
    }
  }
}
```

**Sample response** (real, from the dev server):

```json
{
  "info": {
    "devices": {
      "network": [
        {
          "iface": "bond0",
          "type": "bond",
          "status": "connected",
          "ipAddress": "192.168.1.132",
          "speed": "10000 Mbps",
          "rxBytesPerSec": 23819825,
          "txBytesPerSec": 2018076
        },
        {
          "iface": "eth0",
          "type": "ethernet",
          "status": "connected",
          "ipAddress": null,
          "speed": "1000 Mbps",
          "rxBytesPerSec": 146,
          "txBytesPerSec": 0
        },
        {
          "iface": "lo",
          "type": "loopback",
          "status": "unknown",
          "ipAddress": "127.0.0.1",
          "speed": null,
          "rxBytesPerSec": 7507,
          "txBytesPerSec": 7507
        }
      ]
    }
  }
}
```

**Sample subscription** — live snapshot every second:

```graphql
subscription {
  systemMetricsNetwork {
    id
    interfaces {
      iface
      rxBytes
      txBytes
      rxBytesPerSec
      txBytesPerSec
    }
  }
}
```

The subscription emits the same `interfaces` array shape, plus
cumulative `rxBytes` / `txBytes` so consumers can derive long-window
averages without keeping their own state.

---

### 2. Real-time Docker container stats — `dockerContainerStats`

- **Type:** bug fix
- **Upstream tracking:** [unraid/api#2007](https://github.com/unraid/api/issues/2007) (bug) · [unraid/api#2008](https://github.com/unraid/api/issues/2008) (Work Intent)
- **Why U-Manager needs it:** the Docker section renders one card per container with live CPU%, memory used / total, and ↑/↓ network speed. Without this patch the speed values stay frozen at `0 B/s` — the GraphQL subscription emits CPU and memory correctly but the cumulative `NetIO` / `BlockIO` strings never update, so the client can't derive a per-second rate.

The root cause is upstream's `DockerStatsService` spawning `docker stats --no-trunc` and parsing each output line. The CLI's "live stream" mode never refreshes the cumulative counters between ticks — they stay at the snapshot taken when the process started. This patch replaces that spawn with a per-container `dockerode` stats stream straight off the Docker socket (which DOES refresh every sample), parses each chunk in TypeScript, and publishes the same `DockerContainerStats` shape on the same pubsub channel. Container lifecycle events (`start` / `die` / `stop` / `kill` / `destroy`) are tracked via the Docker events stream so new containers get a fresh socket and removed ones release theirs.

**Sample subscription:**

```graphql
subscription {
  dockerContainerStats {
    id
    cpuPercent
    memUsage
    memPercent
    netIO
    blockIO
  }
}
```

**Sample chunk** (one event per running container, ~1 s apart):

```json
{
  "dockerContainerStats": {
    "id": "a42869b5...:057622b839bd",
    "cpuPercent": 5.5,
    "memUsage": "2.04GiB / 62.60GiB",
    "memPercent": 3.26,
    "netIO": "44.04GiB / 205.47GiB",
    "blockIO": "1.20GiB / 8.75GiB"
  }
}
```

Without the patch every successive emission for the same container
would carry the same `netIO` value forever. With the patch the
cumulative counters increase monotonically — clients can compute
`(netIO[t] - netIO[t-1]) / Δt` to render real download / upload
speeds per container.

---

## How idempotency works

`patch.py` is safe to re-run. Each patch is independent and uses its
own marker so partial-failure recovery and unraid-api version bumps
don't break anything:

- The **network** patch detects the already-patched bundle via the
  presence of `class NetworkUtilization extends Node` and skips
  unchanged. The shared pubsub enum patch adds
  `GRAPHQL_PUBSUB_CHANNEL["NETWORK_UTILIZATION"]` only if it's not
  already there.
- The **Docker stats** patch looks for the
  `/* u-manager-companion: docker-stats override */` marker
  comment before re-applying.
- The bundle filename is resolved dynamically (`plugin.module-*.js`)
  so each `unraid-api` release that changes the bundle hash is
  picked up automatically.
- NestJS decorator suffixes (`_ts_decorate$XXX`,
  `_ts_metadata$YYY`) are extracted from the bundle at runtime, not
  hardcoded — the patches survive upstream's minification reshuffle
  between releases.

