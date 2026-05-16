# U-Manager Companion

Unraid plugin that patches the official `unraid-api` GraphQL service to fix
gaps that currently block U-Manager features. Each patch tracks an upstream
PR — once those land, this plugin becomes unnecessary.

## What it does

The plugin re-applies the following patches at every boot (Unraid resets
`/usr/local/unraid-api/` from the squashfs image on each restart):

### Network device monitoring

1. **`info.devices.network`** — implements the stubbed `generateNetwork()` so
   the query returns real interfaces with:
   - `status` (`connected` / `disconnected` / `unknown`)
   - `ipAddress`, `type` (ethernet / bridge / bond / other)
   - `vendor` and `model` (resolved by traversing `bridge → bond.active_slave →
     physical NIC` and looking up `lspci -mm`)
   - `rxBytes` / `txBytes` — cumulative bytes from `/proc/net/dev`
   - `rxBytesPerSec` / `txBytesPerSec` — instantaneous speed (1 s sample)
2. **`metrics.network` query** — same payload as the subscription, suitable for
   one-off lookups.
3. **`systemMetricsNetwork` subscription** — emits a snapshot every second so
   the app can draw live throughput graphs without polling.

Virtual Docker interfaces (`veth*`, `br-<hash>`, `docker0`) are filtered out.

### Subscription auth fix (CSRF)

4. **`auth.service` CSRF patch** — fixes a `TypeError: Cannot read properties
   of undefined (reading 'csrf_token')` that crashed every WebSocket
   subscription authenticated with an API key. Adds optional chaining
   (`request.query?.csrf_token`) so the cookie strategy fails cleanly and
   Passport falls through to the API-key strategy instead of returning a
   GraphQL error. Unblocks **all** subscriptions for API-key clients
   (`dockerContainerStats`, `systemMetricsNetwork`, parity, etc.).

### Real-time Docker stats

5. **`DockerStatsService` override** — replaces the upstream `docker stats
   --no-trunc` CLI consumer (which freezes `NetIO` / `BlockIO` counters at
   the first sample for the rest of the process lifetime) with a per-container
   stats stream over the Docker socket. After patching, CPU%, memory, network
   I/O and block I/O update every ~600 ms instead of staying at `0 B/s`. A
   Docker events listener adds and removes streams on `start` / `die` /
   `kill` / `destroy` so newly started containers are tracked automatically.

## Why a plugin?

The Unraid root filesystem is built from a squashfs image at every boot. Any
file we modify under `/usr/local/unraid-api/` is gone after a reboot or an
unraid-api update. The plugin's install script runs on every boot, so the
patches are re-applied automatically.

## Install

In the Unraid WebGUI → **Plugins** → **Install Plugin**, paste:

```
https://raw.githubusercontent.com/jandrop/u-manager-companion/main/UManagerCompanion.plg
```

Click **INSTALL**.

## Upstream

Each patch tracks an upstream fix:

- **Network device monitoring** — https://github.com/unraid/api/issues/1818
- **CSRF subscription auth** — fork branch `fix/csrf-subscription-auth`,
  upstream PR pending
- **Docker stats real-time** — fork branch `fix/docker-stats-cli-cache`,
  upstream PR pending

When the upstream PR for a given patch is merged, that patch becomes a no-op
on updated servers.

## How idempotency works

`patch.py` is safe to re-run. Each patch is independent and uses its own
marker so re-runs after a partial failure resume cleanly:

- The network patch detects already-patched bundles via `class NetworkUtilization
  extends Node` and skips them.
- The CSRF patch checks whether `request.query?.csrf_token` is already in the
  bundle.
- The Docker stats patch looks for the `/* u-manager-companion: docker-stats
  override */` marker.
- The bundle file is resolved dynamically (`plugin.module-*.js`) so it survives
  unraid-api version bumps that change the bundle hash.
- All decorator suffixes used by the NestJS metadata system are extracted from
  the bundle at runtime, not hardcoded.

## Remove

Uninstall via **Plugins** → **u-manager-companion** → **Remove**. The patches
stay active until the next reboot, at which point the pristine API bundle is
loaded from squashfs.
