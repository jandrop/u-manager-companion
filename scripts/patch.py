#!/usr/bin/env python3
"""U-Manager Companion: orchestrator.

The actual patches live under `companion/patches/`. Each module
exposes a single `apply() -> bool` returning whether anything
changed. This entrypoint runs them all in a fixed order and bounces
the unraid-api service if at least one patch took effect.

The script is idempotent: every `apply()` checks its own marker and
no-ops when the patch is already present, so it can be re-run after
every boot or unraid-api upgrade.

Tracking issue (upstream): https://github.com/unraid/api/issues/1818
"""
from __future__ import annotations

import os
import sys

# Make the bundled `companion` package importable when patch.py is
# launched directly (e.g. `python3 /boot/config/plugins/u-manager-companion/patch.py`).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from companion._runtime import log, restart_api
from companion.patches import (
    array_fsstate,
    array_state,
    cpu_metrics,
    disks,
    docker,
    docker_check_updates,
    docker_template_create,
    docker_template_delete,
    docker_template_edit,
    docker_update_stream,
    memory_breakdown,
    network,
    plugin_check,
    plugins,
    power,
    shares,
    unassigned_devices,
)


def main() -> int:
    results = [
        network.apply(),
        docker.apply(),
        power.apply(),
        plugins.apply(),
        plugin_check.apply(),
        shares.apply(),
        disks.apply(),
        unassigned_devices.apply(),
        array_state.apply(),
        array_fsstate.apply(),
        docker_template_create.apply(),
        docker_template_delete.apply(),
        docker_template_edit.apply(),
        docker_update_stream.apply(),
        docker_check_updates.apply(),
        memory_breakdown.apply(),
        cpu_metrics.apply(),
    ]
    if any(results):
        restart_api()
        log("patches applied — unraid-api will restart")
    else:
        log("no changes needed (already patched)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
