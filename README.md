# U-Manager Companion

Unraid plugin that patches the official `unraid-api` GraphQL service to expose
network device information that the upstream API currently ships as stubs.

## What it does

The plugin re-applies the following patches at every boot (Unraid resets
`/usr/local/unraid-api/` from the squashfs image on each restart):

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

Tracking issue: https://github.com/unraid/api/issues/1818

When the upstream PR is merged, this plugin becomes unnecessary.

## How idempotency works

`patch.py` is safe to re-run:

- It detects already-patched bundles by looking for `class NetworkUtilization
  extends Node` and skips them.
- It looks up the bundle file dynamically (`plugin.module-*.js`) so it survives
  unraid-api version bumps that change the bundle hash.
- All decorator suffixes used by the NestJS metadata system are extracted from
  the bundle at runtime, not hardcoded.

## Remove

Uninstall via **Plugins** → **u-manager-companion** → **Remove**. The patches
stay active until the next reboot, at which point the pristine API bundle is
loaded from squashfs.
