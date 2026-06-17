"""dockerTemplate(name) query + updateDockerTemplate(input) mutation.

Closes the loop on the Docker template lifecycle. After
`docker_template_create.py` (install) and `docker_template_delete.py`
(uninstall), this patch lets a client:

- read the saved user template for an existing container so it can
  hydrate an Edit form with the same shape used for Install
  (`dockerTemplate(name): DockerTemplate`).
- submit edits back via `updateDockerTemplate(input): DockerInstallOperation`
  which streams progress on the existing `dockerInstallUpdates(operationId)`
  subscription. The pipeline mirrors what the Unraid webgui does on
  Apply: stop + remove the old container, overwrite `my-<Name>.xml`,
  pull the image (in case the tag changed), `rebuild_container`, start.

Types reused from `docker_template_create.py`:

- `DockerTemplateInput`, `DockerConfigEntryInput`
- `DockerInstallOperation`, `DockerInstallEvent`, `DockerInstallStatus`
- subscription `dockerInstallUpdates(id)` and query
  `dockerInstallOperation(id)` — wrapped here so operations from
  THIS runtime resolve through the same endpoints.

`patch.py` enforces ordering: this patch runs AFTER
`docker_template_create.py` so its anchors land inside the bundle
after the install overlay.

The TS canonical of this patch lives on the
`feature/docker-template-edit` branch of the unraid-api fork.
"""
from __future__ import annotations

import os
import re
from typing import Optional

from companion._bundle import (
    find_bundle,
    find_decorator_suffix,
    find_metadata_suffix,
)
from companion._runtime import log

PATCH_MARKER = "/* u-manager-companion: docker-template-edit-v3 */"
# Markers from prior versions of this patch we know how to surgically
# strip when bumping the bundle. Lets `patch_bundle()` re-apply on a
# host where an older revision was already in place.
LEGACY_MARKERS = (
    "/* u-manager-companion: docker-template-edit-v1 */",
    "/* u-manager-companion: docker-template-edit-v2 */",
)
ANCHOR_INSTALL_MUT_END = (
    'DockerMutationsResolver.prototype, "installDockerTemplate", null);'
)
ANCHOR_INSTALL_QUERY_END = (
    'DockerResolver.prototype, "dockerInstallOperation", null);'
)
ANCHOR_MUT_CLOSE = "], DockerMutationsResolver);"
ANCHOR_RES_CLOSE = "], DockerResolver);"


def _find_param_suffix(content: str, anchor: str) -> Optional[str]:
    idx = content.find(anchor)
    if idx == -1:
        return None
    chunk = content[max(0, idx - 800) : idx]
    matches = re.findall(r"_ts_param\$([\w$]+)\(\d", chunk)
    return matches[-1] if matches else None


def _strip_legacy_overlays(content: str) -> tuple[str, bool]:
    """Remove the v1 overlay if present so v2 can land cleanly.

    v1 inserted two blocks, anchored independently — the mutation block
    (carrying the marker) and the query block (no marker). The end of
    each is recognisable by the resolver's final `_ts_decorate(...)`
    line we appended, so we walk the marker to its closing and the
    query block by its function-definition prefix.

    Returns `(content, stripped)`; on `stripped=True` the caller MUST
    write the bundle back to disk even if no new overlay is added.
    """
    stripped = False
    for legacy in LEGACY_MARKERS:
        if legacy not in content:
            continue
        # Mutation block: from "\n<legacy_marker>" through the closing
        # `], DockerMutationsResolver.prototype, "updateDockerTemplate", null);\n`
        mut_end_token = (
            '], DockerMutationsResolver.prototype, "updateDockerTemplate", null);'
        )
        start = content.find("\n" + legacy)
        if start != -1:
            end = content.find(mut_end_token, start)
            if end != -1:
                end += len(mut_end_token)
                if end < len(content) and content[end] == "\n":
                    end += 1
                content = content[:start] + content[end:]
                stripped = True
        # Query block: starts with our injected IIFE that monkey-patches
        # DockerResolver.prototype.dockerTemplate, ends with the matching
        # `_ts_decorate(...)` block.
        res_start_token = (
            ';(() => {\n'
            '    DockerResolver.prototype.dockerTemplate = '
            'function patchedDockerTemplate'
        )
        res_end_token = (
            '], DockerResolver.prototype, "dockerTemplate", null);'
        )
        start = content.find(res_start_token)
        if start != -1:
            # Walk back to include the preceding "\n" we injected.
            if start > 0 and content[start - 1] == "\n":
                start -= 1
            end = content.find(res_end_token, start)
            if end != -1:
                end += len(res_end_token)
                if end < len(content) and content[end] == "\n":
                    end += 1
                content = content[:start] + content[end:]
                stripped = True
    return content, stripped


def patch_bundle() -> bool:
    bundle = find_bundle()
    if not bundle:
        log("docker-template-edit patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()

    content, stripped_legacy = _strip_legacy_overlays(content)

    if PATCH_MARKER in content:
        # Already at the current version. Only write back if we stripped
        # a stale legacy overlay (otherwise the file content is byte-equal
        # to what's on disk and writing would be useless I/O).
        if stripped_legacy:
            with open(bundle, "w") as f:
                f.write(content)
            log(f"stripped legacy docker-template-edit overlay from {os.path.basename(bundle)}")
            return True
        return False

    d_mut = find_decorator_suffix(
        content,
        'DockerMutationsResolver.prototype, "updateAllContainers", null)',
    )
    m_mut = find_metadata_suffix(
        content,
        'DockerMutationsResolver.prototype, "updateAllContainers", null)',
    )
    p_mut = _find_param_suffix(
        content,
        'DockerMutationsResolver.prototype, "removeContainer", null)',
    )

    res_method_anchor = 'DockerResolver.prototype, "containers", null);'
    d_res = find_decorator_suffix(content, res_method_anchor)
    m_res = find_metadata_suffix(content, res_method_anchor)
    p_res = _find_param_suffix(content, res_method_anchor)

    if not all([d_mut, m_mut, p_mut, d_res, m_res, p_res]):
        log(
            "docker-template-edit patch: suffix detection failed "
            f"(d_mut={d_mut} m_mut={m_mut} p_mut={p_mut} "
            f"d_res={d_res} m_res={m_res} p_res={p_res})"
        )
        return False

    # Anchor AFTER install overlay end so __dockerInstall exists when our
    # IIFE runs. Falls back to the resolver-class close if install patch
    # is missing (patch.py should always run install first — safety net).
    install_mut_end = content.find(ANCHOR_INSTALL_MUT_END)
    if install_mut_end != -1:
        insert_mut = install_mut_end + len(ANCHOR_INSTALL_MUT_END)
    else:
        fallback = content.find(ANCHOR_MUT_CLOSE)
        if fallback == -1:
            log("docker-template-edit patch: no mutation anchor found")
            return False
        insert_mut = fallback + len(ANCHOR_MUT_CLOSE)

    install_query_end = content.find(ANCHOR_INSTALL_QUERY_END)
    if install_query_end != -1:
        insert_res = install_query_end + len(ANCHOR_INSTALL_QUERY_END)
    else:
        fallback = content.find(ANCHOR_RES_CLOSE)
        if fallback == -1:
            log("docker-template-edit patch: no resolver anchor found")
            return False
        insert_res = fallback + len(ANCHOR_RES_CLOSE)

    mut_overlay = (
        "\n"
        + PATCH_MARKER
        + "\n"
        + _object_types(d_mut, m_mut)
        + _edit_service_iife()
        + _mutation_decorator(d_mut, m_mut, p_mut)
    )
    res_overlay = "\n" + _query_decorator(d_res, m_res, p_res)

    if insert_res > insert_mut:
        new_content = (
            content[:insert_mut]
            + mut_overlay
            + content[insert_mut:insert_res]
            + res_overlay
            + content[insert_res:]
        )
    else:
        new_content = (
            content[:insert_res]
            + res_overlay
            + content[insert_res:insert_mut]
            + mut_overlay
            + content[insert_mut:]
        )

    with open(bundle, "w") as f:
        f.write(new_content)
    log(f"patched docker-template-edit in {os.path.basename(bundle)}")
    return True


# ─────────────────────────────────────────────────────────── GraphQL types


def _object_types(d: str, m: str) -> str:
    """Define DockerConfigEntry + DockerTemplate ObjectTypes.

    Read-side mirrors of DockerConfigEntryInput / DockerTemplateInput
    already registered by docker_template_create.py. Field shapes are
    identical so a single client model can hydrate both flows.
    """
    return _config_entry_object_block(d, m) + _template_object_block(d, m)


def _config_entry_object_block(d: str, m: str) -> str:
    body = "class DockerConfigEntry {\n"
    body += "    name; type; target; value; default; mode; description; display; required; mask;\n"
    body += "}\n"
    body += _object_field(d, m, 'DockerConfigEntry', 'name', 'String', 'String', nullable=False)
    body += _object_field(d, m, 'DockerConfigEntry', 'type', 'globalThis.DockerConfigEntryType', 'String', nullable=False)
    body += _object_field(d, m, 'DockerConfigEntry', 'target', 'String', 'String', nullable=False)
    for prop, jstype in [
        ('value', 'String'), ('default', 'String'), ('mode', 'String'),
        ('description', 'String'), ('display', 'String'),
        ('required', 'Boolean'), ('mask', 'Boolean'),
    ]:
        body += _object_field(d, m, 'DockerConfigEntry', prop, jstype, jstype)
    body += f"DockerConfigEntry = _ts_decorate${d}([\n    ObjectType()\n], DockerConfigEntry);\n\n"
    return body


def _template_object_block(d: str, m: str) -> str:
    body = "class DockerTemplate {\n"
    body += "    name; repository; network; privileged; shell; overview; icon; webui;\n"
    body += "    support; project; readme; registry; extraParams; postArgs;\n"
    body += "    cpuset; fixedMac; configs;\n"
    body += "}\n"
    body += _object_field(d, m, 'DockerTemplate', 'name', 'String', 'String', nullable=False)
    body += _object_field(d, m, 'DockerTemplate', 'repository', 'String', 'String', nullable=False)
    for prop in ['network', 'shell', 'overview', 'icon', 'webui', 'support',
                 'project', 'readme', 'registry', 'extraParams', 'postArgs',
                 'cpuset', 'fixedMac']:
        body += _object_field(d, m, 'DockerTemplate', prop, 'String', 'String')
    body += _object_field(d, m, 'DockerTemplate', 'privileged', 'Boolean', 'Boolean')
    body += _object_field(d, m, 'DockerTemplate', 'configs', '[DockerConfigEntry]', 'Array', nullable=False)
    body += f"DockerTemplate = _ts_decorate${d}([\n    ObjectType()\n], DockerTemplate);\n\n"
    return body


def _object_field(d: str, m: str, owner: str, prop: str, gtype: str, js_type: str,
                  nullable: bool = True) -> str:
    nullable_js = "true" if nullable else "false"
    return (
        f"_ts_decorate${d}([\n"
        f"    Field(()=>{gtype}, {{ nullable: {nullable_js} }}),\n"
        f"    _ts_metadata${m}('design:type', {js_type})\n"
        f"], {owner}.prototype, '{prop}', void 0);\n"
    )


# ─────────────────────────────────────────────────────────── service IIFE


def _edit_service_iife() -> str:
    """Module-level edit runtime: op store + read template + edit pipeline.

    Shares the `DOCKER_INSTALL:` channel prefix with the install runtime
    so the existing `dockerInstallUpdates(opId)` subscription works
    transparently for edit ops too. Wraps `__dockerInstall.getOperation`
    + `.subscribe` to fall through to this runtime — same pattern
    `docker_update_stream.py` uses for update ops.
    """
    return r""";(() => {
    if (globalThis.__dockerEdit) return; // idempotent

    // Wrap __dockerInstall.getOperation / .subscribe so the existing
    // dockerInstallOperation query + dockerInstallUpdates subscription
    // (registered by docker_template_create.py) also resolve operations
    // owned by THIS edit runtime. Idempotent via __umEditWrapped sentinel
    // — distinct from __umWrapped used by docker_update_stream so the two
    // wraps can coexist.
    if (globalThis.__dockerInstall && !globalThis.__dockerInstall.__umEditWrapped) {
        const prevGetOp = globalThis.__dockerInstall.getOperation;
        globalThis.__dockerInstall.getOperation = function(id) {
            const fromPrev = prevGetOp(id);
            if (fromPrev) return fromPrev;
            return globalThis.__dockerEdit && globalThis.__dockerEdit.getOperation
                ? globalThis.__dockerEdit.getOperation(id)
                : null;
        };
        const prevSubscribe = globalThis.__dockerInstall.subscribe;
        globalThis.__dockerInstall.subscribe = function(id) {
            if (globalThis.__dockerEdit
                && globalThis.__dockerEdit.hasOperation
                && globalThis.__dockerEdit.hasOperation(id)) {
                return globalThis.__dockerEdit.subscribe(id);
            }
            return prevSubscribe(id);
        };
        globalThis.__dockerInstall.__umEditWrapped = true;
    }

    const TEMPLATES_USER_DIR = '/boot/config/plugins/dockerMan/templates-user';
    const REBUILD_CONTAINER = '/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/rebuild_container';
    const CHANNEL_PREFIX = 'DOCKER_INSTALL:';
    const MAX_OUTPUT_LINES = 500;
    const COMPLETED_TTL_MS = 15 * 60 * 1000;
    const CONFIG_TYPES = new Set(['Path', 'Port', 'Variable', 'Label', 'Device']);

    const operations = new Map();
    const cleanupTimers = new Map();

    function sanitiseName(raw) {
        const trimmed = (raw || '').trim();
        if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
            throw new Error('Invalid container name "' + raw + '". Allowed: A-Z a-z 0-9 _ . -');
        }
        return trimmed;
    }
    function templatePath(name) { return TEMPLATES_USER_DIR + '/my-' + name + '.xml'; }
    function channelFor(id) { return CHANNEL_PREFIX + id; }

    function escXml(v) {
        return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function escAttr(v) { return escXml(v).replace(/"/g, '&quot;'); }
    function unescXml(v) {
        return String(v)
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, '&');
    }

    function configToXml(c) {
        const attrs = [
            'Name="' + escAttr(c.name) + '"',
            'Target="' + escAttr(c.target) + '"',
            'Default="' + escAttr(c.default || '') + '"',
            'Mode="' + escAttr(c.mode || '') + '"',
            'Description="' + escAttr(c.description || '') + '"',
            'Type="' + (c.type || 'Variable') + '"',
            'Display="' + escAttr(c.display || 'always') + '"',
            'Required="' + (c.required ? 'true' : 'false') + '"',
            'Mask="' + (c.mask ? 'true' : 'false') + '"',
        ];
        const value = c.value || '';
        return value === '' ? '<Config ' + attrs.join(' ') + '/>'
                            : '<Config ' + attrs.join(' ') + '>' + escXml(value) + '</Config>';
    }

    function pushTag(lines, tag, value) {
        const v = value || '';
        lines.push(v === '' ? '  <' + tag + '/>' : '  <' + tag + '>' + escXml(v) + '</' + tag + '>');
    }

    function buildTemplateXml(input, name) {
        const lines = [];
        lines.push('<?xml version="1.0"?>');
        lines.push('<Container version="2">');
        pushTag(lines, 'Name', name);
        pushTag(lines, 'Repository', input.repository);
        pushTag(lines, 'Registry', input.registry);
        pushTag(lines, 'Network', input.network || 'bridge');
        pushTag(lines, 'MyIP', '');
        pushTag(lines, 'Shell', input.shell || 'sh');
        pushTag(lines, 'Privileged', input.privileged ? 'true' : 'false');
        pushTag(lines, 'Support', input.support);
        pushTag(lines, 'Project', input.project);
        pushTag(lines, 'ReadMe', input.readme);
        pushTag(lines, 'Overview', input.overview);
        pushTag(lines, 'WebUI', input.webui);
        pushTag(lines, 'Icon', input.icon);
        pushTag(lines, 'ExtraParams', input.extraParams);
        pushTag(lines, 'PostArgs', input.postArgs);
        pushTag(lines, 'CPUset', input.cpuset);
        if (input.fixedMac) pushTag(lines, 'MyMAC', input.fixedMac);
        for (const cfg of (input.configs || [])) lines.push('  ' + configToXml(cfg));
        lines.push('</Container>');
        return lines.join('\n') + '\n';
    }

    // ────────────────────────────────────────────── XML parsing (read)

    function readTag(xml, tag) {
        const selfRe = new RegExp('<' + tag + '\\s*/>');
        if (selfRe.test(xml)) return '';
        const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>');
        const m = xml.match(re);
        return m ? unescXml(m[1]).trim() : null;
    }
    function readBool(xml, tag) {
        const v = readTag(xml, tag);
        if (v === null || v === '') return null;
        return v.toLowerCase() === 'true';
    }
    function parseTemplateXml(xml) {
        const configs = [];
        const re = /<Config\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/Config>)/g;
        let m;
        while ((m = re.exec(xml)) !== null) {
            const attrs = m[1];
            const inner = m[2] || '';
            const attr = (n) => {
                const am = attrs.match(new RegExp(n + '="([^"]*)"'));
                return am ? unescXml(am[1]) : null;
            };
            const t = attr('Type') || '';
            if (!CONFIG_TYPES.has(t)) continue;
            configs.push({
                name: attr('Name') || '',
                type: t,
                target: attr('Target') || '',
                value: inner ? unescXml(inner).trim() : null,
                default: attr('Default'),
                mode: attr('Mode'),
                description: attr('Description'),
                display: attr('Display'),
                required: attr('Required') ? attr('Required') === 'true' : null,
                mask: attr('Mask') ? attr('Mask') === 'true' : null,
            });
        }
        return {
            name: readTag(xml, 'Name') || '',
            repository: readTag(xml, 'Repository') || '',
            network: readTag(xml, 'Network'),
            privileged: readBool(xml, 'Privileged'),
            shell: readTag(xml, 'Shell'),
            overview: readTag(xml, 'Overview'),
            icon: readTag(xml, 'Icon'),
            webui: readTag(xml, 'WebUI'),
            support: readTag(xml, 'Support'),
            project: readTag(xml, 'Project'),
            readme: readTag(xml, 'ReadMe'),
            registry: readTag(xml, 'Registry'),
            extraParams: readTag(xml, 'ExtraParams'),
            postArgs: readTag(xml, 'PostArgs'),
            cpuset: readTag(xml, 'CPUset'),
            fixedMac: readTag(xml, 'MyMAC'),
            configs: configs,
        };
    }

    async function readTemplate(name) {
        const safe = sanitiseName(name);
        const { readFile } = await import('fs/promises');
        try {
            const xml = await readFile(templatePath(safe), 'utf8');
            return parseTemplateXml(xml);
        } catch (err) {
            if (err && err.code === 'ENOENT') return null;
            throw err;
        }
    }

    // ────────────────────────────────────────────── streaming helpers

    function formatPullEvent(event) {
        if (!event || typeof event !== 'object') return null;
        if (event.error) return 'Error: ' + event.error;
        if (!event.status) return null;
        const layer = event.id ? 'IMAGE ID [' + event.id + ']: ' : '';
        const d = event.progressDetail;
        if (d && typeof d.current === 'number' && typeof d.total === 'number' && d.total > 0) {
            const percent = Math.floor((d.current / d.total) * 100);
            const totalMb = (d.total / (1024 * 1024)).toFixed(0);
            return layer + event.status + ' ' + percent + '% of ' + totalMb + ' MB';
        }
        return layer + event.status;
    }

    function trimOutput(op) {
        if (op.output.length > MAX_OUTPUT_LINES) {
            op.output.splice(0, op.output.length - MAX_OUTPUT_LINES);
        }
    }
    function publishEvent(op, deltaLines) {
        const event = {
            operationId: op.id,
            status: op.status,
            output: deltaLines.length ? deltaLines : undefined,
            timestamp: new Date(),
        };
        try {
            pubsub.publish(channelFor(op.id), { dockerInstallUpdates: event });
        } catch (e) { /* best-effort */ }
    }
    function appendLine(op, line) {
        op.updatedAt = new Date();
        op.output.push(line);
        trimOutput(op);
        publishEvent(op, [line]);
    }
    function scheduleCleanup(id) {
        const existing = cleanupTimers.get(id);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
            operations.delete(id);
            cleanupTimers.delete(id);
        }, COMPLETED_TTL_MS);
        if (typeof timer.unref === 'function') timer.unref();
        cleanupTimers.set(id, timer);
    }
    function handleSuccess(op) {
        if (op.status !== 'RUNNING') return;
        op.status = 'SUCCEEDED';
        op.finishedAt = new Date();
        op.updatedAt = op.finishedAt;
        publishEvent(op, []);
        scheduleCleanup(op.id);
    }
    function handleFailure(op, error) {
        if (op.status !== 'RUNNING') return;
        op.status = 'FAILED';
        op.finishedAt = new Date();
        op.updatedAt = op.finishedAt;
        const line = 'Error: ' + (error && error.message ? error.message : String(error));
        op.output.push(line);
        trimOutput(op);
        publishEvent(op, [line]);
        scheduleCleanup(op.id);
    }

    // ────────────────────────────────────────────── edit pipeline

    // Wording mirrors dynamix.docker.manager's Helpers.php so the
    // streamed log reads identically to Unraid's web UI Apply panel.
    async function stopContainer(op, name) {
        appendLine(op, 'Stopping container: ' + name);
        const client = getDockerClient();
        try {
            await client.getContainer(name).stop();
            appendLine(op, "Successfully stopped container '" + name + "'");
        } catch (err) {
            if (err && (err.statusCode === 304 || err.statusCode === 404)) {
                appendLine(op, "Container '" + name + "' already stopped");
                return;
            }
            throw err;
        }
    }
    async function removeContainer(op, name) {
        appendLine(op, 'Removing container: ' + name);
        const client = getDockerClient();
        try {
            await client.getContainer(name).remove({ force: false, v: false });
            appendLine(op, "Successfully removed container '" + name + "'");
        } catch (err) {
            if (err && err.statusCode === 404) {
                appendLine(op, "Container '" + name + "' already removed");
                return;
            }
            throw err;
        }
    }
    // Match Unraid's Apply path — pull only when the image is missing.
    // Edit must not turn into a stealth update; the dedicated "Update
    // Container" button is the path that pulls unconditionally.
    async function pullImageIfMissing(op, repo) {
        if (!repo) return;
        const client = getDockerClient();
        try {
            await client.getImage(repo).inspect();
            return; // already present
        } catch (e) { /* fall through to pull */ }
        appendLine(op, 'Pulling image ' + repo);
        const stream = await client.pull(repo);
        await new Promise((resolve, reject) => {
            client.modem.followProgress(stream, (err) => err ? reject(err) : resolve(),
                (event) => {
                    const line = formatPullEvent(event);
                    if (line) appendLine(op, line);
                });
        });
    }
    // Mirror Helpers.php's `xmlToCommand` via a tiny PHP one-liner so
    // the user sees the exact `docker run` line Unraid would have
    // logged. `rebuild_container` runs the same command internally but
    // with echo=false, so without this call there's nothing to show.
    async function buildDockerRunCommand(xmlPath) {
        // xmlToVar reads $subnet via `global` to validate the Network
        // value; xmlToCommand additionally reads $docroot, $var, $driver.
        // Mirror rebuild_container's setup so the call doesn't blow up
        // with a TypeError on key_exists(string, null) the way it did
        // pre-v3 (silent failure left the container deleted but not
        // recreated).
        const code = [
            "$docroot = '/usr/local/emhttp';",
            "require_once \"$docroot/plugins/dynamix.docker.manager/include/DockerClient.php\";",
            "$custom = DockerUtil::custom();",
            "$subnet = DockerUtil::network($custom);",
            "$cpus = DockerUtil::cpus();",
            "$args = $argv; $path = end($args);",
            "list($c) = xmlToCommand($path);",
            "echo str_replace('/docker create ', '/docker run -d ', $c);",
        ].join(' ');
        const result = await execa('php', ['-r', code, '--', xmlPath], {
            reject: false,
        });
        if (result.exitCode !== 0) {
            throw new Error('xmlToCommand failed: ' + (result.stderr || result.stdout || 'unknown'));
        }
        return result.stdout.trim();
    }
    // Helpers.php's execCommand splits the rendered command on ` -` and
    // injects `<br>&nbsp;&nbsp;-` to lay each flag on its own line. We
    // do the same in plaintext for the streamed output.
    function formatCommandLines(cmd) {
        // Strip the leading /usr/local/.../scripts/docker wrapper path so
        // the first token reads `docker` (Helpers.php uses basename()).
        const cleaned = cmd.replace(/^\S*\/docker\b/, 'docker');
        const parts = cleaned.split(' -');
        if (parts.length <= 1) return [cleaned];
        const out = [parts[0]];
        for (let i = 1; i < parts.length; i++) out.push('  -' + parts[i]);
        return out;
    }
    async function fetchContainerId(name) {
        try {
            const inspect = await getDockerClient().getContainer(name).inspect();
            return inspect.Id || '';
        } catch (err) {
            return '';
        }
    }
    async function rebuildContainer(op, name) {
        // No "Running rebuild_container" preamble — Unraid's Apply path
        // never logs an equivalent line and the script is silent by
        // design (echo=false on every helper). Output is captured in
        // case rebuild_container ever surfaces something to stdout.
        const child = execa(REBUILD_CONTAINER, [encodeURIComponent(name)], {
            all: true, reject: false, shell: 'bash',
        });
        let buffer = '';
        const onChunk = (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.replace(/\s+$/, '');
                if (trimmed.length) appendLine(op, trimmed);
            }
        };
        if (child.all) child.all.on('data', onChunk);
        else {
            if (child.stdout) child.stdout.on('data', onChunk);
            if (child.stderr) child.stderr.on('data', onChunk);
        }
        const result = await child;
        if (buffer.trim().length) appendLine(op, buffer.trim());
        if (result.exitCode !== 0) {
            throw new Error('rebuild_container exited with code ' + result.exitCode);
        }
    }

    async function runUpdate(op, name) {
        await stopContainer(op, name);
        await removeContainer(op, name);

        const { mkdir, writeFile } = await import('fs/promises');
        await mkdir(TEMPLATES_USER_DIR, { recursive: true });
        const xml = buildTemplateXml(op.template, name);
        await writeFile(templatePath(name), xml, { encoding: 'utf8', mode: 0o644 });

        await pullImageIfMissing(op, op.template.repository);

        // Mirror Unraid's Apply panel: log the docker run command and
        // its outcome. rebuild_container handles autostart preservation
        // (stops the new container if the old one wasn't in /var/lib/
        // docker/unraid-autostart), so we don't call .start() afterward
        // — doing so would resurrect a container the user had stopped.
        const cmd = await buildDockerRunCommand(templatePath(name));
        appendLine(op, 'Command execution');
        for (const line of formatCommandLines(cmd)) appendLine(op, line);

        await rebuildContainer(op, name);

        const id = await fetchContainerId(name);
        if (id) appendLine(op, id);
        appendLine(op, 'The command finished successfully!');

        handleSuccess(op);
    }

    // ────────────────────────────────────────────── op store + public API

    function start(input) {
        const containerName = sanitiseName(input.name);
        const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2) + Date.now().toString(36);
        const createdAt = new Date();
        const op = {
            id,
            template: input,
            containerName,
            repository: input.repository,
            status: 'RUNNING',
            createdAt,
            updatedAt: createdAt,
            finishedAt: null,
            output: [],
        };
        operations.set(id, op);
        publishEvent(op, []);
        runUpdate(op, containerName).catch((err) => handleFailure(op, err));
        return toGraphqlOperation(op);
    }
    function toGraphqlOperation(op) {
        return {
            id: op.id,
            containerName: op.containerName,
            repository: op.repository,
            status: op.status,
            createdAt: op.createdAt,
            updatedAt: op.updatedAt || null,
            finishedAt: op.finishedAt || null,
            output: [...op.output],
        };
    }
    function getOperation(id) {
        const op = operations.get(id);
        return op ? toGraphqlOperation(op) : null;
    }
    function hasOperation(id) { return operations.has(id); }
    function subscribe(id) {
        if (!operations.has(id)) {
            throw new Error('Unknown Docker edit operation: ' + id);
        }
        return createSubscription(channelFor(id));
    }

    globalThis.__dockerEdit = { start, getOperation, hasOperation, subscribe, readTemplate };
})();

"""


# ─────────────────────────────────────────────── resolver method decorators


def _mutation_decorator(d: str, m: str, p: str) -> str:
    """Append `updateDockerTemplate` method + decorator to DockerMutationsResolver."""
    method_def = r""";(() => {
    DockerMutationsResolver.prototype.updateDockerTemplate = function patchedUpdateDockerTemplate(input) {
        return globalThis.__dockerEdit.start(input);
    };
})();

"""
    description = (
        'Start an async edit of an existing Docker container. Stops + removes '
        'the current container, overwrites my-<Name>.xml with the new template, '
        'pulls the image (in case the repository or tag changed) and recreates '
        'the container via the dynamix rebuild_container helper. Returns the '
        'operation immediately (status=RUNNING). Subscribe to '
        "dockerInstallUpdates(operationId) for per-line progress events. "
        "input.name must match the existing container name — rename isn't "
        "supported in this mutation."
    )
    decorator = (
        f"_ts_decorate${d}([\n"
        f"    ResolveField(()=>DockerInstallOperation, {{ description: {repr(description)} }}),\n"
        f"    UsePermissions({{\n"
        f"        action: AuthAction.UPDATE_ANY,\n"
        f"        resource: Resource.DOCKER\n"
        f"    }}),\n"
        f"    _ts_param${p}(0, Args('input', {{ type: ()=>DockerTemplateInput, nullable: false }})),\n"
        f'    _ts_metadata${m}("design:type", Function),\n'
        f'    _ts_metadata${m}("design:paramtypes", [Object]),\n'
        f'    _ts_metadata${m}("design:returntype", Promise)\n'
        f'], DockerMutationsResolver.prototype, "updateDockerTemplate", null);\n'
    )
    return method_def + decorator


def _query_decorator(d: str, m: str, p: str) -> str:
    """Append `dockerTemplate(name)` query method + decorator to DockerResolver."""
    method_def = r""";(() => {
    DockerResolver.prototype.dockerTemplate = function patchedDockerTemplate(name) {
        return globalThis.__dockerEdit.readTemplate(name);
    };
})();

"""
    description = (
        'Return the saved user template for an existing Docker container. '
        'Reads /boot/config/plugins/dockerMan/templates-user/my-<name>.xml and '
        "returns it in the same shape DockerTemplateInput expects, so an Edit "
        'form can hydrate from the result and submit it back via '
        'updateDockerTemplate(input). Returns null when no template is on '
        'disk for the given name.'
    )
    decorator = (
        f"_ts_decorate${d}([\n"
        f"    Query(()=>DockerTemplate, {{ nullable: true, description: {repr(description)} }}),\n"
        f"    UsePermissions({{\n"
        f"        action: AuthAction.READ_ANY,\n"
        f"        resource: Resource.DOCKER\n"
        f"    }}),\n"
        f"    _ts_param${p}(0, Args('name', {{ type: ()=>String }})),\n"
        f'    _ts_metadata${m}("design:type", Function),\n'
        f'    _ts_metadata${m}("design:paramtypes", [String]),\n'
        f'    _ts_metadata${m}("design:returntype", Promise)\n'
        f'], DockerResolver.prototype, "dockerTemplate", null);\n'
    )
    return method_def + decorator


def apply() -> bool:
    return patch_bundle()
