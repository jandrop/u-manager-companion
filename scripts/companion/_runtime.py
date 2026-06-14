"""Process-level helpers shared by every patch."""
from __future__ import annotations

import subprocess
import sys


def log(msg: str) -> None:
    print(f"[u-manager-companion] {msg}", file=sys.stderr)


def restart_api() -> None:
    # Defer + detach the SIGTERM so any in-flight GraphQL request — in
    # particular the `installPlugin` mutation that triggered this patch
    # run — has time to return to the client before the API process
    # dies. The mobile app polls install progress every 2s, and the
    # operation state lives in unraid-api memory; killing the process
    # synchronously here would leave the install sheet hanging on
    # "Installing…" forever, because the restarted unraid-api has no
    # record of the operationId.
    #
    # start_new_session puts the helper in its own process group so it
    # survives unraid-api's death; the shell exits as soon as pkill
    # fires.
    try:
        subprocess.Popen(
            [
                "sh",
                "-c",
                "sleep 5; pkill -TERM -f 'node /usr/local/unraid-api'",
            ],
            start_new_session=True,
        )
        log("scheduled unraid-api restart in 5s")
    except Exception as e:  # pragma: no cover
        log(f"failed to schedule unraid-api restart: {e}")
