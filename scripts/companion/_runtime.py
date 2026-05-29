"""Process-level helpers shared by every patch."""
from __future__ import annotations

import os
import sys


def log(msg: str) -> None:
    print(f"[u-manager-companion] {msg}", file=sys.stderr)


def restart_api() -> None:
    try:
        with os.popen("pgrep -f 'node /usr/local/unraid-api'") as p:
            pids = [int(x) for x in p.read().split() if x.strip().isdigit()]
        for pid in pids:
            os.kill(pid, 15)
        log(f"sent SIGTERM to unraid-api pids: {pids}")
    except Exception as e:  # pragma: no cover
        log(f"failed to restart unraid-api: {e}")
