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

### 3. Stderr logs for `docker.logs`

- **Type:** bug fix
- **Upstream tracking:** _(PR pending on the upstream fork)_
- **Why U-Manager needs it:** the app renders a live log stream for each Docker container. Without this patch any container whose process writes its logs to stderr (most Python apps, Caddy, AdGuard Home, transmission, unbound, …) returns an empty `lines` array — the log view stays blank even though `docker logs <name>` shows plenty of output.

Upstream's `DockerLogService.getContainerLogs()` shells out to `docker logs --timestamps --tail N <id>` via `execa` and only reads the resulting `.stdout` property. But `docker logs` faithfully forwards each container line on the original stream it was written to — so stderr-only containers contribute nothing to `.stdout`. The patch swaps to execa's `{ all: true }` mode, which merges stdout and stderr into a single `.all` buffer while keeping each line's `--timestamps` prefix intact, so the existing parser and the `since`-cursor logic keep working unchanged.

**Sample query:**

```graphql
query {
  docker {
    logs(id: "<container-id>", tail: 5) {
      containerId
      cursor
      lines {
        timestamp
        message
      }
    }
  }
}
```

**Sample response** (real, from `caddy` — a stderr-only container that returned `lines: []` before the patch):

```json
{
  "docker": {
    "logs": {
      "containerId": "a42869b5...:a94ccb76b4fc",
      "cursor": "2026-05-18T20:18:38.604Z",
      "lines": [
        {
          "timestamp": "2026-05-18T20:18:38.604Z",
          "message": "{\"level\":\"error\",\"ts\":1779135518.604777,\"logger\":\"tls.renew\",\"msg\":\"could not get certificate from issuer\",\"identifier\":\"starkindustries.homes\"}"
        }
      ]
    }
  }
}
```

---

### 4. `parityCheck.resume` continues instead of restarting

- **Type:** bug fix
- **Upstream tracking:** [unraid/api#1815](https://github.com/unraid/api/issues/1815)
- **Why U-Manager needs it:** the app exposes pause/resume controls for parity checks (a check on a multi-disk array can take ~20 hours). Without this patch the resume mutation silently throws away the saved position — clicking resume after a pause restarts from byte 0, undoing all the work the check had already done.

Upstream's `ParityService.updateParityCheck()` POSTs `cmdCheck=Resume` to emhttpd, but emhttpd identifies which action to run by the field NAME, not its value (the Unraid web UI submits dynamic field names like `cmdCheckPause`/`cmdCheckResume`/`cmdCheckCancel` with empty values — see `/usr/local/emhttp/plugins/dynamix/ArrayOperation.page`). With `cmdCheck=Resume`, emhttpd falls through to the plain `cmdCheck` submit handler — which starts a fresh check — and the saved `mdResyncPos` is discarded. Pause and cancel happen to work via fallback handling, but resume is the broken one.

The patch rewrites the action map to use the same field names the web UI submits. Verified live on Unraid 7.3.0:

| Stage | `mdResyncPos` |
|---|---|
| Before pause | 521 044 |
| After pause  | 1 655 644 (saved) |
| After resume | 2 395 484 (continued growing) |

### 5. Share CRUD mutations — `createShare`, `updateShare`, `deleteShare`

- **Type:** missing feature
- **Upstream tracking:** the official `SharesResolver` ships only a read-only `shares` query. There's a stub at `api/src/core/modules/add-share.ts` that literally throws `NotImplementedError` and isn't wired into the schema. PR pending on the unraid-api fork.
- **Why U-Manager needs it:** the app needs to create, edit and delete user shares from the phone — the same flow the web UI exposes under **Shares → Add Share**. Without these mutations the app would have to either reach the legacy `/update.htm` PHP endpoint (which requires a session cookie + CSRF token, breaking the API-key-only auth model) or push users back to the web UI.

The legacy web UI POSTs `cmdEditShare=Add Share` / `=Apply` / `=Delete` with form-encoded fields to `/var/run/emhttpd.socket`, with a CSRF token read from `/var/local/emhttp/var.ini`. emhttpd writes a `.cfg` to `/boot/config/shares/<name>.cfg` and creates `/mnt/user/<name>/`. The patch reproduces that exact protocol from inside unraid-api: the resolver methods open a unix-socket connection, send a raw HTTP request, and parse emhttpd's HTTP/0.9 (success) or HTTP/1.1 (error) reply.

GraphQL shape:

```graphql
mutation {
  createShare(name: "downloads", settings: { comment: "Torrent downloads", allocator: "highwater" }) { ... Share }
  updateShare(name: "downloads", settings: { comment: "Updated" })                                   { ... Share }
  deleteShare(name: "downloads")
}
```

`settings` is a `GraphQLJSON` scalar with optional keys: `comment`, `cachePool`, `cachePool2`, `useCache`, `cow`, `floor`, `allocator`, `splitLevel`, `include[]`, `exclude[]`. On update, omitted keys keep their current value (the resolver merges the partial against the existing share before sending to emhttpd, because `cmdEditShare=Apply` is destructive on omitted fields).

Permissions follow the standard pattern — `CREATE_ANY` / `UPDATE_ANY` / `DELETE_ANY` on `Resource.SHARE`. The name regex matches what `ShareEdit.page` enforces client-side: 1-40 chars, starts with a letter, only `[A-Za-z0-9._-]`, may not end with a dot.

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
- The **Docker logs stderr** patch uses the patched substring itself
  as its marker (`{ all } = await execa('docker'`) — re-running on an
  already-patched bundle is a no-op.
- The **parity resume** patch uses the patched action map as its
  marker (`cmdCheckResume: ''`), so re-applying is a no-op once the
  fix is in place.
- The bundle filename is resolved dynamically (`plugin.module-*.js`)
  so each `unraid-api` release that changes the bundle hash is
  picked up automatically.
- NestJS decorator suffixes (`_ts_decorate$XXX`,
  `_ts_metadata$YYY`) are extracted from the bundle at runtime, not
  hardcoded — the patches survive upstream's minification reshuffle
  between releases.

