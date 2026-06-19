"""Server power mutations: shutdown, reboot, sleep.

Adds a `serverPower { shutdown, reboot, sleep }` mutation tree to the
GraphQL Mutation root. Each mutation shells out to the same scripts the
Unraid web UI calls (`/usr/local/sbin/powerdown`, `rc.s3sleep`).
"""
from __future__ import annotations

import os
import re

from companion._bundle import find_bundle, find_decorator_suffix, find_metadata_suffix
from companion._runtime import log

POWER_MUTATIONS_MARKER = "serverPower = new ServerPowerMutations();"

def patch_power_mutations_bundle() -> bool:
    """Expose `serverPower: ServerPowerMutations { shutdown, reboot, sleep }`.

    Matches the namespaced shape used by `parityCheck` / `array` / etc. on
    the upstream Mutation root. Earlier revisions of this companion shipped
    a flat `shutdownServer`/`rebootServer`/`sleepServer` set of root
    mutations — this revision REPLACES them with the namespace shape, so it
    also reverts the flat additions if they're present in the bundle.

    Tracked upstream: PR pending on the unraid-api fork.
    """
    bundle = find_bundle()
    if not bundle:
        log("power-mutations patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if POWER_MUTATIONS_MARKER in content:
        return False

    # Suffixes for both injection scopes — the ServerService class lives in
    # a different bundle scope than ServerResolver (different _ts_decorate$X
    # function suffixes), so resolve each independently.
    service_anchor = "}\nServerService = _ts_decorate$"
    service_idx = content.find(service_anchor)
    if service_idx == -1:
        log("power-mutations patch: ServerService closer not found")
        return False
    end = content.find("(", service_idx + len(service_anchor))
    service_suffix = content[service_idx + len(service_anchor) : end]

    resolver_anchor = 'ServerResolver.prototype, "updateServerIdentity", null);'
    resolver_suffix = find_decorator_suffix(content, resolver_anchor)
    meta_suffix = find_metadata_suffix(content, resolver_anchor)
    if not all([service_suffix, resolver_suffix, meta_suffix]):
        log(
            f"power-mutations patch: missing suffix "
            f"(service={service_suffix} resolver={resolver_suffix} meta={meta_suffix})"
        )
        return False

    # ── PHASE A: revert the flat v1 additions if they're still in the bundle ──
    v1_method_block = (
        "    async shutdownServer() {\n"
        "        return this.serverService.shutdownServer();\n"
        "    }\n"
        "    async rebootServer() {\n"
        "        return this.serverService.rebootServer();\n"
        "    }\n"
        "    async sleepServer() {\n"
        "        return this.serverService.sleepServer();\n"
        "    }\n"
        "    "
    )
    if v1_method_block in content:
        content = content.replace(v1_method_block, "", 1)

    v1_decorator_pattern = re.compile(
        r'(\], ServerResolver\.prototype, "updateServerIdentity", null\);\n)'
        r'(?:_ts_decorate\$[\w$]+\(\[\s*\n\s*Mutation\(\(\)=>Boolean,.*?'
        r'\], ServerResolver\.prototype, "(?:shutdownServer|rebootServer|sleepServer)", null\);\n){3}',
        re.DOTALL,
    )
    if v1_decorator_pattern.search(content):
        content = v1_decorator_pattern.sub(r"\1", content, count=1)

    # ── PHASE B: ServerService methods ──
    # Mirrors what the web UI's `Powerdown.php` does:
    #     exec("/sbin/poweroff 1>/dev/null 2>&1 &")
    #     exec("/sbin/reboot   1>/dev/null 2>&1 &")
    # …and what `dynamix.s3.sleep`'s SleepMode.php does for sleep.
    # No `powerdown` wrapper script, so we don't depend on it existing on
    # the user's system.
    service_methods = (
        "    fireAndForget(command, args) {\n"
        "        const subprocess = execa(command, args, { detached: true, stdio: 'ignore' });\n"
        "        subprocess.unref();\n"
        "    }\n"
        "    async shutdownServer() {\n"
        "        this.logger.log('Server shutdown requested via API');\n"
        "        this.fireAndForget('/sbin/poweroff', []);\n"
        "        return true;\n"
        "    }\n"
        "    async rebootServer() {\n"
        "        this.logger.log('Server reboot requested via API');\n"
        "        this.fireAndForget('/sbin/reboot', []);\n"
        "        return true;\n"
        "    }\n"
        "    async sleepServer() {\n"
        "        const { existsSync } = await import('fs');\n"
        "        const path = '/usr/local/emhttp/plugins/dynamix.s3.sleep/scripts/rc.s3sleep';\n"
        "        if (!existsSync(path)) {\n"
        "            throw new GraphQLError('Sleep is not available. Install the Dynamix S3 Sleep plugin to enable this feature.');\n"
        "        }\n"
        "        this.logger.log('Server sleep requested via API');\n"
        "        this.fireAndForget(path, []);\n"
        "        return true;\n"
        "    }\n"
    )
    service_closer = f"}}\nServerService = _ts_decorate${service_suffix}(["
    if service_closer not in content:
        log("power-mutations patch: service closer anchor not found")
        return False
    if "this.fireAndForget('/sbin/poweroff', [])" not in content:
        content = content.replace(service_closer, service_methods + service_closer, 1)

    # ── PHASE C: ServerPowerMutations ObjectType class ──
    # Inject BEFORE `class RootMutations` so it's already in scope when
    # the RootMutations field decorator runs (the decorator's
    # `typeof ServerPowerMutations === "undefined" ? Object : SP` check
    # still hits the TDZ ReferenceError if the class hasn't been
    # *declared* yet at module-load time).
    #
    # We discover the decorator suffix used by neighbouring namespace
    # classes (e.g. UnraidPluginsMutations) so the ObjectType decoration
    # picks up the right `_ts_decorate$` helper for this scope.
    sp_class_anchor = "class UnraidPluginsMutations {"
    sp_class_decoration_anchor = "UnraidPluginsMutations = _ts_decorate$"
    sp_class_d_idx = content.find(sp_class_decoration_anchor)
    if sp_class_d_idx == -1:
        log("power-mutations patch: UnraidPluginsMutations decorator anchor not found")
        return False
    end = content.find("(", sp_class_d_idx + len(sp_class_decoration_anchor))
    sp_class_suffix = content[sp_class_d_idx + len(sp_class_decoration_anchor) : end]
    if not sp_class_suffix:
        log("power-mutations patch: could not extract namespace decorator suffix")
        return False

    sp_class_block = (
        "class ServerPowerMutations {\n"
        "}\n"
        f"ServerPowerMutations = _ts_decorate${sp_class_suffix}([\n"
        f"    ObjectType({{\n"
        f"        description: 'Server power-state mutations: shut down, reboot, and S3 sleep.'\n"
        f"    }})\n"
        f"], ServerPowerMutations);\n"
    )
    if sp_class_anchor not in content:
        log("power-mutations patch: UnraidPluginsMutations class anchor not found")
        return False
    if "class ServerPowerMutations {" not in content:
        content = content.replace(sp_class_anchor, sp_class_block + sp_class_anchor, 1)

    # ── PHASE D: ServerPowerMutationsResolver class + 3 ResolveField decorators ──
    sp_resolver_class = (
        "class ServerPowerMutationsResolver {\n"
        "    serverService;\n"
        "    constructor(serverService) {\n"
        "        this.serverService = serverService;\n"
        "    }\n"
        "    async shutdown() {\n"
        "        return this.serverService.shutdownServer();\n"
        "    }\n"
        "    async reboot() {\n"
        "        return this.serverService.rebootServer();\n"
        "    }\n"
        "    async sleep() {\n"
        "        return this.serverService.sleepServer();\n"
        "    }\n"
        "}\n"
    )

    def field_decorator(method: str, description: str) -> str:
        return (
            f"_ts_decorate${resolver_suffix}([\n"
            f"    UsePermissions({{\n"
            f"        action: AuthAction.UPDATE_ANY,\n"
            f"        resource: Resource.SERVERS\n"
            f"    }}),\n"
            f"    ResolveField(()=>Boolean, {{\n"
            f"        description: '{description}'\n"
            f"    }}),\n"
            f'    _ts_metadata${meta_suffix}("design:type", Function),\n'
            f'    _ts_metadata${meta_suffix}("design:paramtypes", []),\n'
            f'    _ts_metadata${meta_suffix}("design:returntype", Promise)\n'
            f'], ServerPowerMutationsResolver.prototype, "{method}", null);\n'
        )

    sp_resolver_decorators = (
        field_decorator("shutdown", "Cleanly stop the array and power the server off.")
        + field_decorator("reboot", "Cleanly stop the array and reboot the server.")
        + field_decorator(
            "sleep",
            "Put the server into S3 sleep. Requires the Dynamix S3 Sleep plugin.",
        )
    )

    sp_class_decoration = (
        f"ServerPowerMutationsResolver = _ts_decorate${resolver_suffix}([\n"
        f"    Injectable(),\n"
        f"    Resolver(()=>ServerPowerMutations),\n"
        f'    _ts_metadata${meta_suffix}("design:type", Function),\n'
        f'    _ts_metadata${meta_suffix}("design:paramtypes", [\n'
        f'        typeof ServerService === "undefined" ? Object : ServerService\n'
        f"    ])\n"
        f"], ServerPowerMutationsResolver);\n"
    )

    sr_class_decoration_pattern = re.compile(
        r"ServerResolver = _ts_decorate\$[\w$]+\(\[(?:[^\[\]]|\[[^\[\]]*\])+\], ServerResolver\);"
    )
    m_end = sr_class_decoration_pattern.search(content)
    if not m_end:
        log("power-mutations patch: ServerResolver class decoration end not found")
        return False
    if "class ServerPowerMutationsResolver {" not in content:
        content = (
            content[: m_end.end()]
            + "\n"
            + sp_resolver_class
            + sp_resolver_decorators
            + sp_class_decoration
            + content[m_end.end() :]
        )

    # ── PHASE E: expose `serverPower` as a FIELD on `RootMutations` ──
    # Mirrors how `array`, `docker`, `unraidPlugins` etc. are exposed —
    # NestJS resolves `Mutation.serverPower` to the field's runtime value
    # (a freshly-constructed wrapper instance) and then dispatches each
    # inner field to `ServerPowerMutationsResolver`.
    #
    # An earlier revision of this patch used `@Mutation(()=>ServerPowerMutations)`
    # on a method of `ServerResolver` instead. That registers a top-level
    # mutation field in the schema but the runtime resolution silently
    # returns null in the running unraid-api, leaving the GraphQL response
    # at "Cannot return null for non-nullable field Mutation.serverPower".
    # The field-on-root pattern is the canonical one for namespaced
    # mutations and matches what's already in the upstream code.

    # First, REVERT the earlier @Mutation-method pattern if present.
    legacy_method_block = (
        "    async serverPower() {\n"
        "        return new ServerPowerMutations();\n"
        "    }\n"
        "    "
    )
    if legacy_method_block in content:
        content = content.replace(legacy_method_block, "", 1)

    # The legacy decorator block came in two shapes (with and without
    # `UsePermissions`). Match either with a regex.
    legacy_decorator_re = re.compile(
        r"\n?_ts_decorate\$[\w$]+\(\[\n"
        r"    Mutation\(\(\)=>ServerPowerMutations, \{\n"
        r"        description: 'Server power-state mutations: shutdown, reboot, sleep\.'\n"
        r"    \}\),\n"
        r"(?:    UsePermissions\(\{\n"
        r"        action: AuthAction\.UPDATE_ANY,\n"
        r"        resource: Resource\.SERVERS\n"
        r"    \}\),\n)?"
        r"    _ts_metadata\$[\w$]+\(\"design:type\", Function\),\n"
        r"    _ts_metadata\$[\w$]+\(\"design:paramtypes\", \[\]\),\n"
        r"    _ts_metadata\$[\w$]+\(\"design:returntype\", Promise\)\n"
        r"\], ServerResolver\.prototype, \"serverPower\", null\);\n"
    )
    content = legacy_decorator_re.sub("", content, count=1)

    # Discover the decorator suffix used by RootMutations' existing
    # `@Field(()=>UnraidPluginsMutations,...)` registration — same suffix
    # for our new `serverPower` field, same scope.
    root_anchor = 'RootMutations.prototype, "unraidPlugins", void 0);'
    root_d = find_decorator_suffix(content, root_anchor)
    root_m = find_metadata_suffix(content, root_anchor)
    if not all([root_d, root_m]):
        log(
            f"power-mutations patch: RootMutations suffix not found "
            f"(decorator={root_d} metadata={root_m})"
        )
        return False

    # Add `serverPower = new ServerPowerMutations();` to the RootMutations
    # class body, immediately after `unraidPlugins = new ...` (which
    # is the last existing namespace field).
    root_class_anchor = "    unraidPlugins = new UnraidPluginsMutations();\n"
    if root_class_anchor not in content:
        log("power-mutations patch: RootMutations class anchor not found")
        return False
    if "serverPower = new ServerPowerMutations();" not in content:
        content = content.replace(
            root_class_anchor,
            root_class_anchor + "    serverPower = new ServerPowerMutations();\n",
            1,
        )

    # Add the matching `@Field()` decorator next to the existing
    # `unraidPlugins` one.
    unraid_field_anchor = (
        f"_ts_decorate${root_d}([\n"
        f"    Field(()=>UnraidPluginsMutations, {{\n"
        f"        description: 'Unraid plugin related mutations'\n"
        f"    }}),\n"
        f'    _ts_metadata${root_m}("design:type", typeof UnraidPluginsMutations === "undefined" ? Object : UnraidPluginsMutations)\n'
        f'], RootMutations.prototype, "unraidPlugins", void 0);'
    )
    serverpower_field_decorator = (
        f"\n_ts_decorate${root_d}([\n"
        f"    Field(()=>ServerPowerMutations, {{\n"
        f"        description: 'Server power-state mutations: shutdown, reboot, sleep.'\n"
        f"    }}),\n"
        f'    _ts_metadata${root_m}("design:type", typeof ServerPowerMutations === "undefined" ? Object : ServerPowerMutations)\n'
        f'], RootMutations.prototype, "serverPower", void 0);'
    )
    if unraid_field_anchor not in content:
        log("power-mutations patch: UnraidPlugins field decorator anchor not found")
        return False
    if 'RootMutations.prototype, "serverPower", void 0);' not in content:
        content = content.replace(
            unraid_field_anchor,
            unraid_field_anchor + serverpower_field_decorator,
            1,
        )

    # ── PHASE F: add `serverPower()` resolver method to `RootMutationsResolver`
    # so the GraphQL `Mutation.serverPower` field gets registered. The class
    # field on `RootMutations` alone is NOT enough — NestJS walks the
    # `RootMutationsResolver` providers to discover top-level mutations via
    # their `@Mutation()` decorators. Without this method the new field
    # silently drops out of the schema.
    if 'RootMutationsResolver.prototype, "serverPower", null);' not in content:
        method_anchor = (
            "    unraidPlugins() {\n"
            "        return new UnraidPluginsMutations();\n"
            "    }\n"
        )
        if method_anchor not in content:
            log("power-mutations patch: RootMutationsResolver method anchor not found")
            return False
        sp_method = (
            "    serverPower() {\n"
            "        return new ServerPowerMutations();\n"
            "    }\n"
        )
        content = content.replace(method_anchor, method_anchor + sp_method, 1)

        # Detect the suffix used by the existing `unraidPlugins` decorator
        # in this scope (different chunk from RootMutations' Field decorator).
        unraid_dec_re = re.compile(
            r"_ts_decorate\$([\w$]+)\(\[\n"
            r"    Mutation\(\(\)=>UnraidPluginsMutations, \{\n"
            r"        name: 'unraidPlugins'\n"
            r"    \}\),\n"
            r"    _ts_metadata\$([\w$]+)\(\"design:type\", Function\),\n"
            r"    _ts_metadata\$[\w$]+\(\"design:paramtypes\", \[\]\),\n"
            r"    _ts_metadata\$[\w$]+\(\"design:returntype\", typeof UnraidPluginsMutations === \"undefined\" \? Object : UnraidPluginsMutations\)\n"
            r"\], RootMutationsResolver\.prototype, \"unraidPlugins\", null\);\n"
        )
        m_dec = unraid_dec_re.search(content)
        if not m_dec:
            log("power-mutations patch: unraidPlugins resolver decorator not found")
            return False
        rm_d, rm_m = m_dec.group(1), m_dec.group(2)

        sp_resolver_decorator = (
            f"_ts_decorate${rm_d}([\n"
            f"    Mutation(()=>ServerPowerMutations, {{\n"
            f"        name: 'serverPower'\n"
            f"    }}),\n"
            f'    _ts_metadata${rm_m}("design:type", Function),\n'
            f'    _ts_metadata${rm_m}("design:paramtypes", []),\n'
            f'    _ts_metadata${rm_m}("design:returntype", typeof ServerPowerMutations === "undefined" ? Object : ServerPowerMutations)\n'
            f'], RootMutationsResolver.prototype, "serverPower", null);\n'
        )
        insert_at = m_dec.end()
        content = content[:insert_at] + sp_resolver_decorator + content[insert_at:]

    # ── PHASE G: register ServerPowerMutationsResolver in ResolversModule providers ──
    providers_anchor = (
        "RootMutationsResolver,\n"
        "            ServerResolver,\n"
        "            ServerService,"
    )
    if "            ServerPowerMutationsResolver,\n" not in content:
        if providers_anchor not in content:
            log("power-mutations patch: ResolversModule providers anchor not found")
            return False
        content = content.replace(
            providers_anchor,
            "RootMutationsResolver,\n"
            "            ServerPowerMutationsResolver,\n"
            "            ServerResolver,\n"
            "            ServerService,",
            1,
        )

    with open(bundle, "w") as f:
        f.write(content)
    log(f"enabled shutdown/reboot/sleep from the app ({os.path.basename(bundle)})")
    return True


def apply() -> bool:
    return patch_power_mutations_bundle()
