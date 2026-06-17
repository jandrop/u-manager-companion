"""Expose `unraidPlugins.checkForUpdates` to trigger an Unraid update check.

The official `unraid-api` has no GraphQL operation to run Unraid's plugin
update check — the thing that re-downloads each installed plugin's remote
`.plg` into `/tmp/plugins/<name>.plg` and refreshes `latestVersion`. That
only happens from the WebGUI Plugins page (or CA's periodic check). So the
mobile app's pull-to-refresh can re-read the cached state but can never make
Unraid actually check for newer versions.

This patch adds a `checkForUpdates: Boolean` ResolveField on
`UnraidPluginsMutationsResolver` (the `unraidPlugins` mutation namespace)
that fires `plugin checkall` detached in the background and returns
immediately. The app calls it on pull-to-refresh (only when the companion
is installed) and then re-queries `installedUnraidPluginsDetailed`, which
now reflects the refreshed `latestVersion`.

`plugin checkall` re-downloads every installed plugin's remote `.plg`, so it
can take a while across many plugins — hence detached/fire-and-forget; the
client polls the list afterwards.

Mirrors the resolver-method + ResolveField decoration shape used by
`plugins.py` (uninstallPlugin). Separate marker so it applies on top of an
already-patched bundle.
"""
from __future__ import annotations

import os

from companion._bundle import (
    find_bundle,
    find_decorator_suffix,
    find_metadata_suffix,
)
from companion._runtime import log

CHECK_UPDATES_MARKER = "/* u-manager-companion: plugin check-for-updates */"

# Anchor: the existing installLanguage resolver method (always present
# upstream). We insert checkForUpdates right after it.
_INSTALL_LANG_METHOD = (
    "    async installLanguage(input) {\n"
    "        return this.pluginsService.installLanguage(input);\n"
    "    }\n"
)

_CHECK_METHOD = (
    _INSTALL_LANG_METHOD
    + "    async checkForUpdates() {\n"
    + "        " + CHECK_UPDATES_MARKER + "\n"
    + "        try {\n"
    + "            const child = execa('/usr/local/sbin/plugin', ['checkall'], "
    "{ detached: true, stdio: 'ignore', reject: false, "
    "env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin' } });\n"
    + "            if (child && child.unref) child.unref();\n"
    + "        } catch (e) {}\n"
    + "        return true;\n"
    + "    }\n"
)

# Anchor for the ResolveField decoration block.
_INSTALL_LANG_DECORATOR = (
    '], UnraidPluginsMutationsResolver.prototype, "installLanguage", null);'
)


def apply() -> bool:
    """Add the `checkForUpdates` mutation to UnraidPluginsMutationsResolver."""
    bundle = find_bundle()
    if not bundle:
        log("plugin-check patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if CHECK_UPDATES_MARKER in content:
        return False

    resolver_d = find_decorator_suffix(
        content,
        'UnraidPluginsMutationsResolver.prototype, "installLanguage", null)',
    )
    resolver_m = find_metadata_suffix(
        content,
        'UnraidPluginsMutationsResolver.prototype, "installLanguage", null)',
    )
    if not resolver_d or not resolver_m:
        log(
            f"plugin-check patch: resolver suffix not found "
            f"(d={resolver_d} m={resolver_m})"
        )
        return False
    if _INSTALL_LANG_METHOD not in content or _INSTALL_LANG_DECORATOR not in content:
        log("plugin-check patch: installLanguage anchors not found")
        return False

    # PHASE A: resolver method (inline execa — no service method needed).
    content = content.replace(_INSTALL_LANG_METHOD, _CHECK_METHOD, 1)

    # PHASE B: ResolveField decoration for the new mutation.
    decoration = (
        _INSTALL_LANG_DECORATOR + "\n"
        f"_ts_decorate${resolver_d}([\n"
        "    ResolveField(()=>Boolean, {\n"
        "        description: 'Triggers an Unraid plugin update check "
        "(plugin checkall) in the background so installed plugins refresh "
        "their latestVersion; the client then re-queries the plugin list.'\n"
        "    }),\n"
        "    UsePermissions({\n"
        "        action: AuthAction.UPDATE_ANY,\n"
        "        resource: Resource.CONFIG\n"
        "    }),\n"
        f'    _ts_metadata${resolver_m}("design:type", Function),\n'
        f'    _ts_metadata${resolver_m}("design:paramtypes", []),\n'
        f'    _ts_metadata${resolver_m}("design:returntype", Promise)\n'
        '], UnraidPluginsMutationsResolver.prototype, "checkForUpdates", null);'
    )
    content = content.replace(_INSTALL_LANG_DECORATOR, decoration, 1)

    with open(bundle, "w") as f:
        f.write(content)
    log(f"enabled plugin update check from the app ({os.path.basename(bundle)})")
    return True
