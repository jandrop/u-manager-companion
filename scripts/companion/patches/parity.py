"""Parity-check related patches.

* `parity-resume`: align the pause/resume/cancel mutations with the
  field names the legacy emhttpd handler actually recognises so a
  paused check resumes from the saved `mdResyncPos` instead of
  restarting at byte 0.
* `array-subscription`: fix `Subscription.arraySubscription` returning
  null on the stock API, so the live parity status events reach the
  app.
"""
from __future__ import annotations

import glob
import os
import re

from companion._bundle import INDEX_BUNDLE_GLOB, find_bundle
from companion._runtime import log

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


def apply() -> bool:
    return any([
        patch_parity_resume_bundle(),
        patch_array_subscription_bundle(),
    ])
