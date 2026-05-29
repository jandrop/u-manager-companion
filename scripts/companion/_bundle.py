"""Bundle / pubsub file discovery and minified-identifier helpers.

These are imported by every `patches/*.py` module — kept here so each
patch file does not need to repeat the same constants and regex
helpers.
"""
from __future__ import annotations

import glob
import re
from typing import Optional

PUBSUB_FILE = (
    "/usr/local/unraid-api/node_modules/@unraid/shared/dist/pubsub/graphql.pubsub.js"
)
BUNDLE_GLOB = "/usr/local/unraid-api/dist/assets/plugin.module-*.js"
INDEX_BUNDLE_GLOB = "/usr/local/unraid-api/dist/assets/index-*.js"


def find_bundle() -> Optional[str]:
    for path in glob.glob(BUNDLE_GLOB):
        with open(path, "r") as f:
            content = f.read()
        if "class MetricsResolver" in content and "class InfoNetwork extends Node" in content:
            return path
    return None


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
