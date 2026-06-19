"""Plugin management patches.

* `installed-plugins-manifest`: expose
  `installedUnraidPluginsDetailed` so the app gets full `.plg`
  metadata (version, latestVersion, lastCheckedAt, changelog).
* `uninstall-plugin`: add `unraidPlugins.uninstallPlugin(filename)`
  mutation.
* `changelog-cdata-strip`: strip the `<![CDATA[...]]>` wrapper around
  the captured `<CHANGES>` text returned by the manifest resolver.
"""
from __future__ import annotations

import os
import re

from companion._bundle import find_bundle, find_decorator_suffix, find_metadata_suffix
from companion._runtime import log

INSTALLED_PLUGINS_MANIFEST_MARKER = "class InstalledPluginManifest"

def patch_installed_plugins_manifest_bundle() -> bool:
    """Expose `installedUnraidPluginsDetailed: [InstalledPluginManifest!]!`.

    Upstream only ships `installedUnraidPlugins: [String!]!` which returns
    bare `.plg` filenames. Downstream consumers (this companion's main
    app, u_manager) then have to cross-reference an external feed
    (Community Applications) to get a plugin's name, author, version,
    description, icon, etc. — and any private/non-feed plugin shows up
    blank.

    This patch moves that parsing server-side by reading each `.plg` XML
    manifest from `/boot/config/plugins/` and emitting a structured
    `InstalledPluginManifest` per plugin.

    Tracked upstream: pending PR on the unraid-api fork.
    """
    bundle = find_bundle()
    if not bundle:
        log("installed-plugins-manifest patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if INSTALLED_PLUGINS_MANIFEST_MARKER in content:
        return False

    # ── Discover decorator suffixes ──
    # Model file scope (PluginInstallEvent / PluginInstallOperation)
    model_d = find_decorator_suffix(
        content, 'PluginInstallEvent.prototype, "timestamp", void 0)'
    )
    model_m = find_metadata_suffix(
        content, 'PluginInstallEvent.prototype, "timestamp", void 0)'
    )
    # Resolver file scope (UnraidPluginsResolver)
    resolver_d = find_decorator_suffix(
        content, 'UnraidPluginsResolver.prototype, "installedUnraidPlugins", null)'
    )
    resolver_m = find_metadata_suffix(
        content, 'UnraidPluginsResolver.prototype, "installedUnraidPlugins", null)'
    )
    # Service file scope (UnraidPluginsService) — different from resolver
    service_anchor = "}\nUnraidPluginsService = _ts_decorate$"
    service_idx = content.find(service_anchor)
    if service_idx == -1:
        log("installed-plugins-manifest patch: UnraidPluginsService closer not found")
        return False
    end = content.find("(", service_idx + len(service_anchor))
    service_d = content[service_idx + len(service_anchor) : end]

    if not all([model_d, model_m, resolver_d, resolver_m, service_d]):
        log(
            f"installed-plugins-manifest patch: missing suffix "
            f"(model={model_d}/{model_m} resolver={resolver_d}/{resolver_m} "
            f"service={service_d})"
        )
        return False

    # ── PHASE A: InstalledPluginManifest ObjectType in model scope ──
    model_anchor = "], PluginInstallEvent);"
    if model_anchor not in content:
        log("installed-plugins-manifest patch: PluginInstallEvent closer not found")
        return False

    def field_dec(prop: str, desc: str, nullable: bool) -> str:
        opts = (
            "{ nullable: true, description: '" + desc + "' }"
            if nullable
            else "{ description: '" + desc + "' }"
        )
        return (
            f"_ts_decorate${model_d}([\n"
            f"    Field(()=>String, {opts}),\n"
            f"    _ts_metadata${model_m}(\"design:type\", String)\n"
            f"], InstalledPluginManifest.prototype, \"{prop}\", void 0);\n"
        )

    # The lastCheckedAt field uses GraphQLISODateTime + Date type (rather
    # than the plain `String` of the other fields) so the API returns a
    # proper ISO 8601 timestamp the client can parse into a DateTime.
    last_checked_dec = (
        f"_ts_decorate${model_d}([\n"
        f"    Field(()=>GraphQLISODateTime, {{ nullable: true, description: 'Timestamp of the cached remote .plg at /tmp/plugins/<filename>.plg — when Unraid last fetched it via plugin checkall.' }}),\n"
        f'    _ts_metadata${model_m}("design:type", typeof Date === "undefined" ? Object : Date)\n'
        f'], InstalledPluginManifest.prototype, "lastCheckedAt", void 0);\n'
    )

    manifest_block = (
        "\nclass InstalledPluginManifest {\n"
        "    filename;\n"
        "    name;\n"
        "    author;\n"
        "    version;\n"
        "    description;\n"
        "    pluginURL;\n"
        "    support;\n"
        "    icon;\n"
        "    launch;\n"
        "    changelog;\n"
        "    latestVersion;\n"
        "    lastCheckedAt;\n"
        "}\n"
        + field_dec("filename", "Bare .plg filename in /boot/config/plugins", nullable=False)
        + field_dec(
            "name",
            "Plugin name slug from <!ENTITY name>. Falls back to filename without .plg.",
            nullable=False,
        )
        + field_dec("author", "Plugin author from <!ENTITY author>", nullable=True)
        + field_dec("version", "Plugin version string from <!ENTITY version>", nullable=True)
        + field_dec(
            "description",
            "Free-text description from <!ENTITY description>",
            nullable=True,
        )
        + field_dec(
            "pluginURL",
            "Remote .plg URL from <!ENTITY pluginURL>",
            nullable=True,
        )
        + field_dec("support", "Support thread URL from <!ENTITY support>", nullable=True)
        + field_dec("icon", "Icon path or URL from <!ENTITY icon>", nullable=True)
        + field_dec("launch", "Launch path from <!ENTITY launch>", nullable=True)
        + field_dec(
            "changelog",
            "Raw <CHANGES> body from the local .plg",
            nullable=True,
        )
        + field_dec(
            "latestVersion",
            "Version from /tmp/plugins/<filename>.plg if Unraid cached it",
            nullable=True,
        )
        + last_checked_dec
        + f"InstalledPluginManifest = _ts_decorate${model_d}([\n"
        + "    ObjectType({\n"
        + "        description: 'Parsed manifest of an installed Unraid plugin (.plg file)'\n"
        + "    })\n"
        + "], InstalledPluginManifest);\n"
    )
    content = content.replace(model_anchor, model_anchor + manifest_block, 1)

    # ── PHASE B: Service methods on UnraidPluginsService class body ──
    # Uses the bundle-level `path` and `fs` imports already in scope
    # (verified by the existing listInstalledPlugins() body).
    service_methods = r"""    async listInstalledPluginsDetailed() {
        const paths = this.configService.get('store.paths', {});
        const dynamixBase = paths?.['dynamix-base'] ?? '/boot/config/plugins/dynamix';
        const pluginsDir = path.resolve(dynamixBase, '..');
        const filenames = await this.listInstalledPlugins();
        return Promise.all(filenames.map((f) => this.parsePluginManifest(f, pluginsDir)));
    }
    async parsePluginManifest(filename, pluginsDir) {
        const fullPath = path.join(pluginsDir, filename);
        let xml = '';
        try { xml = await fs.readFile(fullPath, 'utf8'); }
        catch (e) { this.logger.warn(`Failed to read plugin manifest ${fullPath}: ${e}`); }
        const entities = {};
        const entityRe = /<!ENTITY\s+(\w+)\s+(?:"([^"]*)"|'([^']*)')/g;
        let em;
        while ((em = entityRe.exec(xml)) !== null) {
            entities[em[1]] = (em[2] ?? em[3] ?? '').trim();
        }
        const pluginTag = xml.match(/<PLUGIN\s+([^>]*)>/s);
        const attrs = {};
        if (pluginTag) {
            const attrRe = /(\w+)\s*=\s*"([^"]*)"/g;
            let am;
            while ((am = attrRe.exec(pluginTag[1])) !== null) {
                attrs[am[1]] = am[2];
            }
        }
        const resolve = (value, depth = 0) => {
            if (value == null) return null;
            if (depth > 5) return value;
            const replaced = value.replace(/&(\w+);/g, (_, key) => {
                const r = entities[key];
                return r !== undefined ? (resolve(r, depth + 1) ?? `&${key};`) : `&${key};`;
            });
            return replaced.trim() || null;
        };
        const pick = (key, ...aliases) => {
            for (const k of [key, ...aliases]) {
                if (attrs[k] != null) return resolve(attrs[k]);
            }
            for (const k of [key, ...aliases]) {
                if (entities[k] != null) return resolve(entities[k]);
            }
            return null;
        };
        const resolvedName = pick('name') ?? filename.replace(/\.plg$/, '');
        const description = await this.readPluginReadmeDescription(resolvedName);
        const changesMatch = xml.match(/<CHANGES>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/CHANGES>/);
        const changelogBody = changesMatch ? changesMatch[1].trim() : null;
        const changelog = changelogBody && changelogBody.length > 0 ? changelogBody : null;
        const updateInfo = await this.readCachedPluginUpdate(filename);
        return {
            filename,
            name: resolvedName,
            author: pick('author'),
            version: pick('version'),
            description,
            pluginURL: pick('pluginURL'),
            support: pick('support', 'supportURL'),
            icon: pick('icon'),
            launch: pick('launch'),
            changelog,
            latestVersion: updateInfo.latestVersion,
            lastCheckedAt: updateInfo.lastCheckedAt,
        };
    }
    async readPluginReadmeDescription(name) {
        const readmePath = `/usr/local/emhttp/plugins/${name}/README.md`;
        let body;
        try { body = await fs.readFile(readmePath, 'utf8'); }
        catch { return null; }
        const lines = body.split('\n');
        if (lines[0]?.trim().startsWith('**') && lines[0]?.trim().endsWith('**')) {
            lines.shift();
        }
        const cleaned = lines.join('\n').trim();
        return cleaned.length > 0 ? cleaned : null;
    }
    async readCachedPluginUpdate(filename) {
        const cachePath = `/tmp/plugins/${filename}`;
        let stat;
        try { stat = await fs.stat(cachePath); }
        catch { return { latestVersion: null, lastCheckedAt: null }; }
        let xml = '';
        try { xml = await fs.readFile(cachePath, 'utf8'); }
        catch { return { latestVersion: null, lastCheckedAt: stat.mtime }; }
        const versionMatch = xml.match(/<!ENTITY\s+version\s+(?:"([^"]*)"|'([^']*)')/s);
        const raw = versionMatch ? (versionMatch[1] ?? versionMatch[2] ?? '') : '';
        const latestVersion = raw.trim().length > 0 ? raw.trim() : null;
        return { latestVersion, lastCheckedAt: stat.mtime };
    }
"""
    service_closer_full = f"}}\nUnraidPluginsService = _ts_decorate${service_d}("
    if service_closer_full not in content:
        log("installed-plugins-manifest patch: service closer anchor mismatch")
        return False
    content = content.replace(service_closer_full, service_methods + service_closer_full, 1)

    # ── PHASE C: Resolver method body on UnraidPluginsResolver class ──
    resolver_closer_anchor = (
        "    pluginInstallUpdates(operationId) {\n"
        "        return this.pluginsService.subscribe(operationId);\n"
        "    }\n"
        "}"
    )
    if resolver_closer_anchor not in content:
        log("installed-plugins-manifest patch: resolver closer anchor not found")
        return False
    resolver_method = (
        "    pluginInstallUpdates(operationId) {\n"
        "        return this.pluginsService.subscribe(operationId);\n"
        "    }\n"
        "    async installedUnraidPluginsDetailed() {\n"
        "        return this.pluginsService.listInstalledPluginsDetailed();\n"
        "    }\n"
        "}"
    )
    content = content.replace(resolver_closer_anchor, resolver_method, 1)

    # ── PHASE D: Query decorator for the new method ──
    existing_query_anchor = (
        '], UnraidPluginsResolver.prototype, "installedUnraidPlugins", null);'
    )
    if existing_query_anchor not in content:
        log("installed-plugins-manifest patch: existing Query anchor not found")
        return False
    new_query_decoration = (
        existing_query_anchor + "\n"
        f"_ts_decorate${resolver_d}([\n"
        f"    Query(()=>[\n"
        f"            InstalledPluginManifest\n"
        f"        ], {{\n"
        f"        description: 'List installed Unraid OS plugins enriched with parsed .plg manifest metadata.'\n"
        f"    }}),\n"
        f"    UsePermissions({{\n"
        f"        action: AuthAction.READ_ANY,\n"
        f"        resource: Resource.CONFIG\n"
        f"    }}),\n"
        f"    _ts_metadata${resolver_m}(\"design:type\", Function),\n"
        f"    _ts_metadata${resolver_m}(\"design:paramtypes\", []),\n"
        f"    _ts_metadata${resolver_m}(\"design:returntype\", Promise)\n"
        f'], UnraidPluginsResolver.prototype, "installedUnraidPluginsDetailed", null);'
    )
    content = content.replace(existing_query_anchor, new_query_decoration, 1)

    with open(bundle, "w") as f:
        f.write(content)
    log(f"enabled detailed installed-plugins info in API ({os.path.basename(bundle)})")
    return True


UNINSTALL_PLUGIN_MARKER = 'async uninstallPlugin(filename) {'

def patch_uninstall_plugin_bundle() -> bool:
    """Expose `unraidPlugins.uninstallPlugin(filename: String!)` mutation.

    Upstream only ships `installPlugin` / `installLanguage` mutations
    on `UnraidPluginsMutationsResolver` — there's no way to remove a
    plugin via GraphQL. This patch wires `plugin remove FILENAME`
    (the same script `installPlugin` already shells out to) onto the
    existing operation pipeline so progress streams through
    `pluginInstallUpdates` exactly like an install.

    Tracked upstream: PR pending on the unraid-api fork
    (fix/plugin-uninstall-mutation).
    """
    bundle = find_bundle()
    if not bundle:
        log("uninstall-plugin patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if UNINSTALL_PLUGIN_MARKER in content:
        return False

    # Mutations resolver scope (UnraidPluginsMutationsResolver)
    resolver_d = find_decorator_suffix(
        content, 'UnraidPluginsMutationsResolver.prototype, "installLanguage", null)'
    )
    resolver_m = find_metadata_suffix(
        content, 'UnraidPluginsMutationsResolver.prototype, "installLanguage", null)'
    )
    # `_ts_param$N` is the helper that emits parameter decorators —
    # we need the same suffix the existing `Args('input')` call uses
    # so the new mutation's `Args('filename')` plays nicely.
    param_anchor = '_ts_param$'
    param_idx = content.find(
        param_anchor,
        content.find('UnraidPluginsMutationsResolver.prototype, "installPlugin"') - 800,
    )
    end = content.find('(', param_idx + len(param_anchor))
    param_suffix = content[param_idx + len(param_anchor) : end] if param_idx != -1 else ''

    if not all([resolver_d, resolver_m, param_suffix]):
        log(
            f"uninstall-plugin patch: missing suffix "
            f"(resolver={resolver_d}/{resolver_m} param={param_suffix})"
        )
        return False

    # ── PHASE A: service method on UnraidPluginsService class body ──
    service_method = r"""    async uninstallPlugin(filename) {
        const trimmed = filename.trim();
        if (!trimmed) throw new Error('Plugin filename cannot be empty.');
        if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
            throw new Error(`Invalid plugin filename: "${filename}".`);
        }
        if (!trimmed.toLowerCase().endsWith('.plg')) {
            throw new Error(`Plugin filename must end with .plg: "${filename}".`);
        }
        const id = randomUUID();
        const createdAt = new Date();
        const operation = {
            id,
            type: 'plugin',
            url: trimmed,
            name: trimmed.replace(/\.plg$/, ''),
            status: PluginInstallStatus.RUNNING,
            createdAt,
            updatedAt: createdAt,
            output: [],
            bufferedOutput: '',
            forced: false,
            action: 'uninstall',
        };
        this.operations.set(id, operation);
        this.logger.log(`Starting plugin uninstall for "${trimmed}" (operation ${id})`);
        this.publishEvent(operation, []);
        const command = await this.resolveInstallerCommand('plugin');
        const args = ['remove', trimmed];
        const child = execa(command, args, {
            all: true,
            reject: false,
            timeout: 5 * 60 * 1000,
        });
        operation.child = child;
        if (child.all) {
            child.all.on('data', (chunk) => {
                this.handleOutput(operation, chunk.toString());
            });
        } else {
            child.stdout?.on('data', (chunk) => this.handleOutput(operation, chunk.toString()));
            child.stderr?.on('data', (chunk) => this.handleOutput(operation, chunk.toString()));
        }
        child.on('error', (error) => {
            if (operation.status === PluginInstallStatus.RUNNING) {
                this.handleFailure(operation, error);
            }
        });
        child.on('close', (code) => {
            if (operation.status !== PluginInstallStatus.RUNNING) return;
            if (code === 0) {
                this.handleSuccess(operation);
            } else {
                this.handleFailure(operation, new Error(`plugin remove command exited with ${code}`));
            }
        });
        return this.toGraphqlOperation(operation);
    }
"""
    # Anchor: the `}` that closes UnraidPluginsService's class body,
    # followed by the decorator call. Inject the method right before
    # that closing brace.
    service_anchor_pattern = re.compile(
        r"(}\nUnraidPluginsService = _ts_decorate\$[\w$]+\(\[)", re.MULTILINE
    )
    if not service_anchor_pattern.search(content):
        log("uninstall-plugin patch: UnraidPluginsService closer not found")
        return False
    content = service_anchor_pattern.sub(
        lambda m: service_method + m.group(1), content, count=1
    )

    # ── PHASE B: resolver method body on UnraidPluginsMutationsResolver ──
    resolver_anchor = (
        "    async installLanguage(input) {\n"
        "        return this.pluginsService.installLanguage(input);\n"
        "    }\n"
        "}"
    )
    if resolver_anchor not in content:
        log("uninstall-plugin patch: resolver closer anchor not found")
        return False
    resolver_method = (
        "    async installLanguage(input) {\n"
        "        return this.pluginsService.installLanguage(input);\n"
        "    }\n"
        "    async uninstallPlugin(filename) {\n"
        "        return this.pluginsService.uninstallPlugin(filename);\n"
        "    }\n"
        "}"
    )
    content = content.replace(resolver_anchor, resolver_method, 1)

    # ── PHASE C: ResolveField decorator for the new method ──
    existing_decorator_anchor = (
        '], UnraidPluginsMutationsResolver.prototype, "installLanguage", null);'
    )
    if existing_decorator_anchor not in content:
        log("uninstall-plugin patch: installLanguage decorator anchor not found")
        return False
    new_decorator = (
        existing_decorator_anchor + "\n"
        f"_ts_decorate${resolver_d}([\n"
        f"    ResolveField(()=>PluginInstallOperation, {{\n"
        f"        description: 'Uninstalls an Unraid plugin by .plg filename and tracks the removal through the same operation pipeline the install flow uses.'\n"
        f"    }}),\n"
        f"    UsePermissions({{\n"
        f"        action: AuthAction.UPDATE_ANY,\n"
        f"        resource: Resource.CONFIG\n"
        f"    }}),\n"
        f"    _ts_param${param_suffix}(0, Args('filename')),\n"
        f"    _ts_metadata${resolver_m}(\"design:type\", Function),\n"
        f"    _ts_metadata${resolver_m}(\"design:paramtypes\", [\n"
        f"        String\n"
        f"    ]),\n"
        f"    _ts_metadata${resolver_m}(\"design:returntype\", Promise)\n"
        f'], UnraidPluginsMutationsResolver.prototype, "uninstallPlugin", null);'
    )
    content = content.replace(existing_decorator_anchor, new_decorator, 1)

    with open(bundle, "w") as f:
        f.write(content)
    log(f"enabled plugin uninstall from the app ({os.path.basename(bundle)})")
    return True


CHANGELOG_CDATA_OLD = (
    r"        const changesMatch = xml.match(/<CHANGES>([\s\S]*?)<\/CHANGES>/);"
)
CHANGELOG_CDATA_NEW = (
    r"        const changesMatch = xml.match(/<CHANGES>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/CHANGES>/);"
)


def patch_changelog_cdata_strip_bundle() -> bool:
    """Strip `<![CDATA[ ... ]]>` markers from the captured `<CHANGES>` body.

    Companion .plg files now wrap their `<CHANGES>` block in CDATA so the
    XML parses cleanly when changelog entries contain backtick-quoted text
    like `<filename>` or `<CHANGES>` (otherwise `plugin check` fails and
    /tmp/plugins/<name>.plg never refreshes). The existing
    parsePluginManifest regex captures the inside of `<CHANGES>` greedy
    of any wrapper, so the CDATA markers themselves now appear at the
    top of the Release Notes view in the U-Manager app.

    This patch tweaks the regex to make the CDATA markers optional
    capture group separators so they get stripped before the body is
    returned. Already-CDATA-free plugins keep working unchanged.

    Idempotent: looks for the original one-line regex and replaces it
    with the CDATA-tolerant version. Re-runs are no-ops once the new
    regex is in place.
    """
    bundle = find_bundle()
    if not bundle:
        log("changelog-cdata patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if CHANGELOG_CDATA_NEW in content:
        return False
    if CHANGELOG_CDATA_OLD not in content:
        log("changelog-cdata patch: original regex line not found")
        return False
    content = content.replace(CHANGELOG_CDATA_OLD, CHANGELOG_CDATA_NEW, 1)
    with open(bundle, "w") as f:
        f.write(content)
    log(f"fixed plugin changelog parsing for special characters ({os.path.basename(bundle)})")
    return True


def apply() -> bool:
    return any([
        patch_installed_plugins_manifest_bundle(),
        patch_uninstall_plugin_bundle(),
        patch_changelog_cdata_strip_bundle(),
    ])
