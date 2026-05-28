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
    disks,
    docker,
    network,
    parity,
    plugins,
    power,
    shares,
)


def main() -> int:
    results = [
        network.apply(),
        docker.apply(),
        parity.apply(),
        power.apply(),
        plugins.apply(),
        shares.apply(),
        disks.apply(),
    ]
    if any(results):
        restart_api()
        log("patches applied — unraid-api will restart")
    else:
        log("no changes needed (already patched)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
