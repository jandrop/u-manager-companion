"""installDockerTemplate (streaming) + companion query/subscription.

Replaces the previous one-shot `applyDockerTemplate` with a streaming
install pipeline modelled after the existing plugin install flow:

- mutation `docker.installDockerTemplate(input)` returns immediately
  with a `DockerInstallOperation` (`status=RUNNING`).
- background work writes `my-<Name>.xml`, pulls the image with
  dockerode (`followProgress`) and shells out to the dynamix
  `rebuild_container` PHP CLI to create + start the container, all
  while emitting line-by-line output to a per-operation pubsub
  channel `DOCKER_INSTALL:<id>`.
- query `dockerInstallOperation(operationId)` returns a synchronous
  snapshot for clients reconnecting after backgrounding.
- subscription `dockerInstallUpdates(operationId)` streams
  `DockerInstallEvent`s — each carries the *delta* output lines
  since the previous event.

The TS canonical of this patch lives on the
`feature/docker-install-stream` branch of the unraid-api fork. The JS
overlay here is byte-equivalent to what that branch would produce.
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

PATCH_MARKER = "/* u-manager-companion: docker-install-stream-v2 */"
ANCHOR_MUT_CLOSE = "], DockerMutationsResolver);"
ANCHOR_RES_CLOSE = "], DockerResolver);"


def _find_param_suffix(content: str, anchor: str) -> Optional[str]:
    idx = content.find(anchor)
    if idx == -1:
        return None
    chunk = content[max(0, idx - 800) : idx]
    matches = re.findall(r"_ts_param\$([\w$]+)\(\d", chunk)
    return matches[-1] if matches else None


def patch_bundle() -> bool:
    bundle = find_bundle()
    if not bundle:
        log("docker-install-stream patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if PATCH_MARKER in content:
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
    # DockerResolver's class-level decoration block has too much
    # constructor-paramtypes noise immediately before the closing
    # `], DockerResolver);` for `find_decorator_suffix`'s 800-char
    # lookback. Hop instead through a known method-level decoration
    # close — `DockerResolver.prototype, "containers", null);` — which
    # has all three suffixes right above it.
    res_method_anchor = 'DockerResolver.prototype, "containers", null);'
    d_res = find_decorator_suffix(content, res_method_anchor)
    m_res = find_metadata_suffix(content, res_method_anchor)
    p_res = _find_param_suffix(content, res_method_anchor)

    if not all([d_mut, m_mut, p_mut, d_res, m_res, p_res]):
        log(
            "docker-install-stream patch: suffix detection failed "
            f"(d_mut={d_mut} m_mut={m_mut} p_mut={p_mut} "
            f"d_res={d_res} m_res={m_res} p_res={p_res})"
        )
        return False

    insert_mut = content.find(ANCHOR_MUT_CLOSE)
    if insert_mut == -1:
        log("docker-install-stream patch: DockerMutationsResolver close not found")
        return False
    insert_mut += len(ANCHOR_MUT_CLOSE)

    insert_res = content.find(ANCHOR_RES_CLOSE)
    if insert_res == -1:
        log("docker-install-stream patch: DockerResolver close not found")
        return False
    insert_res += len(ANCHOR_RES_CLOSE)

    # The mutation block needs the input/object types defined BEFORE
    # the resolver decorators reference them. Build everything as one
    # block injected after DockerMutationsResolver close. The
    # query+subscription block goes after DockerResolver close.
    mut_overlay = (
        "\n"
        + PATCH_MARKER
        + "\n"
        + _shared_types(d_mut, m_mut)
        + _install_service_iife()
        + _mutation_decorator(d_mut, m_mut, p_mut)
    )
    res_overlay = "\n" + _query_and_subscription_decorators(d_res, m_res, p_res)

    # Insert the resolver overlay first so the offsets used for the
    # mutation overlay (which has the LARGER offset) stay valid.
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
    log(f"enabled live Docker install progress in API ({os.path.basename(bundle)})")
    return True


# ─────────────────────────────────────────────────────────── GraphQL types


def _shared_types(d: str, m: str) -> str:
    """Define enum + input types + object types used by mutation/query/sub."""
    return (
        _enum_block(d, m)
        + _config_entry_input_block(d, m)
        + _template_input_block(d, m)
        + _install_event_block(d, m)
        + _install_operation_block(d, m)
    )


def _enum_block(d: str, m: str) -> str:
    return r""";(() => {
    if (typeof DockerConfigEntryType === 'undefined') {
        globalThis.DockerConfigEntryType = {
            PATH: 'Path', PORT: 'Port', VARIABLE: 'Variable',
            LABEL: 'Label', DEVICE: 'Device',
        };
        try {
            registerEnumType(globalThis.DockerConfigEntryType, {
                name: 'DockerConfigEntryType',
            });
        } catch (e) {}
    }
    if (typeof DockerInstallStatus === 'undefined') {
        globalThis.DockerInstallStatus = {
            QUEUED: 'QUEUED', RUNNING: 'RUNNING',
            SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED',
        };
        try {
            registerEnumType(globalThis.DockerInstallStatus, {
                name: 'DockerInstallStatus',
            });
        } catch (e) {}
    }
})();

"""


def _config_entry_input_block(d: str, m: str) -> str:
    body = "class DockerConfigEntryInput {\n"
    body += "    name; type; target; value; default; mode; description; display; required; mask;\n"
    body += "}\n"
    body += _input_field(d, m, 'DockerConfigEntryInput', 'name', 'String', 'String', nullable=False)
    body += _input_field(d, m, 'DockerConfigEntryInput', 'type', 'globalThis.DockerConfigEntryType', 'String', nullable=False)
    body += _input_field(d, m, 'DockerConfigEntryInput', 'target', 'String', 'String', nullable=False)
    for prop, jstype in [
        ('value', 'String'), ('default', 'String'), ('mode', 'String'),
        ('description', 'String'), ('display', 'String'),
        ('required', 'Boolean'), ('mask', 'Boolean'),
    ]:
        body += _input_field(d, m, 'DockerConfigEntryInput', prop, jstype, jstype)
    body += f"DockerConfigEntryInput = _ts_decorate${d}([\n    InputType()\n], DockerConfigEntryInput);\n\n"
    return body


def _template_input_block(d: str, m: str) -> str:
    body = "class DockerTemplateInput {\n"
    body += "    name; repository; network; privileged; shell; overview; icon; webui;\n"
    body += "    support; project; readme; registry; extraParams; postArgs;\n"
    body += "    cpuset; fixedMac; configs;\n"
    body += "}\n"
    body += _input_field(d, m, 'DockerTemplateInput', 'name', 'String', 'String', nullable=False)
    body += _input_field(d, m, 'DockerTemplateInput', 'repository', 'String', 'String', nullable=False)
    for prop in ['network', 'shell', 'overview', 'icon', 'webui', 'support',
                 'project', 'readme', 'registry', 'extraParams', 'postArgs',
                 'cpuset', 'fixedMac']:
        body += _input_field(d, m, 'DockerTemplateInput', prop, 'String', 'String')
    body += _input_field(d, m, 'DockerTemplateInput', 'privileged', 'Boolean', 'Boolean')
    body += _input_field(d, m, 'DockerTemplateInput', 'configs', '[DockerConfigEntryInput]', 'Array', nullable=False)
    body += f"DockerTemplateInput = _ts_decorate${d}([\n    InputType()\n], DockerTemplateInput);\n\n"
    return body


def _install_operation_block(d: str, m: str) -> str:
    body = "class DockerInstallOperation {\n"
    body += "    id; containerName; repository; status; createdAt; updatedAt; finishedAt; output;\n"
    body += "}\n"
    body += _object_field(d, m, 'DockerInstallOperation', 'id', 'ID', 'String', nullable=False)
    body += _object_field(d, m, 'DockerInstallOperation', 'containerName', 'String', 'String', nullable=False)
    body += _object_field(d, m, 'DockerInstallOperation', 'repository', 'String', 'String', nullable=False)
    body += _object_field(d, m, 'DockerInstallOperation', 'status', 'globalThis.DockerInstallStatus', 'String', nullable=False)
    body += _object_field(d, m, 'DockerInstallOperation', 'createdAt', 'GraphQLISODateTime', 'Date', nullable=False)
    body += _object_field(d, m, 'DockerInstallOperation', 'updatedAt', 'GraphQLISODateTime', 'Date')
    body += _object_field(d, m, 'DockerInstallOperation', 'finishedAt', 'GraphQLISODateTime', 'Date')
    body += _object_field(d, m, 'DockerInstallOperation', 'output', '[String]', 'Array', nullable=False)
    body += f"DockerInstallOperation = _ts_decorate${d}([\n    ObjectType()\n], DockerInstallOperation);\n\n"
    return body


def _install_event_block(d: str, m: str) -> str:
    body = "class DockerInstallEvent {\n"
    body += "    operationId; status; output; timestamp;\n"
    body += "}\n"
    body += _object_field(d, m, 'DockerInstallEvent', 'operationId', 'ID', 'String', nullable=False)
    body += _object_field(d, m, 'DockerInstallEvent', 'status', 'globalThis.DockerInstallStatus', 'String', nullable=False)
    body += _object_field(d, m, 'DockerInstallEvent', 'output', '[String]', 'Array')
    body += _object_field(d, m, 'DockerInstallEvent', 'timestamp', 'GraphQLISODateTime', 'Date', nullable=False)
    body += f"DockerInstallEvent = _ts_decorate${d}([\n    ObjectType()\n], DockerInstallEvent);\n\n"
    return body


def _input_field(d: str, m: str, owner: str, prop: str, gtype: str, js_type: str,
                 nullable: bool = True) -> str:
    nullable_js = "true" if nullable else "false"
    return (
        f"_ts_decorate${d}([\n"
        f"    Field(()=>{gtype}, {{ nullable: {nullable_js} }}),\n"
        f"    _ts_metadata${m}('design:type', {js_type})\n"
        f"], {owner}.prototype, '{prop}', void 0);\n"
    )


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


def _install_service_iife() -> str:
    """Module-level operation store + pull + run pipeline.

    Stored as IIFE-bound closures on a module-private object that the
    resolver methods reference via `globalThis.__dockerInstall`. The
    bundle loads once per unraid-api process so this state lives for
    the lifetime of the API.
    """
    return r""";(() => {
    if (globalThis.__dockerInstall) return; // idempotent
    const TEMPLATES_USER_DIR = '/boot/config/plugins/dockerMan/templates-user';
    const REBUILD_CONTAINER = '/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/rebuild_container';
    const CHANNEL_PREFIX = 'DOCKER_INSTALL:';
    const MAX_OUTPUT_LINES = 500;
    const COMPLETED_TTL_MS = 15 * 60 * 1000;

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

    async function pullImage(op, repo) {
        if (!repo) return;
        appendLine(op, 'Pulling image ' + repo);
        const client = getDockerClient();
        const stream = await client.pull(repo);
        await new Promise((resolve, reject) => {
            client.modem.followProgress(stream, (err) => err ? reject(err) : resolve(),
                (event) => {
                    const line = formatPullEvent(event);
                    if (line) appendLine(op, line);
                });
        });
    }

    async function rebuildContainer(op, name) {
        appendLine(op, 'Running rebuild_container ' + name);
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

    async function startContainer(op, name) {
        appendLine(op, 'Starting container ' + name);
        const client = getDockerClient();
        try {
            await client.getContainer(name).start();
            appendLine(op, 'Container ' + name + ' started');
        } catch (err) {
            if (err && err.statusCode === 304) {
                appendLine(op, 'Container ' + name + ' already running');
                return;
            }
            throw err;
        }
    }

    async function runInstall(op, name) {
        const { mkdir, writeFile } = await import('fs/promises');
        await mkdir(TEMPLATES_USER_DIR, { recursive: true });
        const xml = buildTemplateXml(op.template, name);
        await writeFile(templatePath(name), xml, { encoding: 'utf8', mode: 0o644 });
        appendLine(op, 'Wrote template ' + templatePath(name));
        await pullImage(op, op.template.repository);
        await rebuildContainer(op, name);
        // rebuild_container only auto-starts containers in
        // /var/lib/docker/unraid-autostart; fresh CA installs are not,
        // so without this the container stays Exited. Dockerode .start()
        // is idempotent (304 when already running).
        await startContainer(op, name);
        handleSuccess(op);
    }

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
        runInstall(op, containerName).catch((err) => handleFailure(op, err));
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

    function subscribe(id) {
        if (!operations.has(id)) {
            throw new Error('Unknown Docker install operation: ' + id);
        }
        return createSubscription(channelFor(id));
    }

    globalThis.__dockerInstall = { start, getOperation, subscribe };
})();

"""


# ─────────────────────────────────────────────── resolver method decorators


def _mutation_decorator(d: str, m: str, p: str) -> str:
    """Append `installDockerTemplate` method + decorator to DockerMutationsResolver."""
    method_def = r""";(() => {
    DockerMutationsResolver.prototype.installDockerTemplate = function patchedInstallDockerTemplate(input) {
        return globalThis.__dockerInstall.start(input);
    };
})();

"""
    description = (
        'Start an async install of a Docker template. Returns the operation '
        'immediately (status=RUNNING). Subscribe to dockerInstallUpdates(operationId) '
        'for per-line progress.'
    )
    decorator = (
        f"_ts_decorate${d}([\n"
        f"    ResolveField(()=>DockerInstallOperation, {{ description: {repr(description)} }}),\n"
        f"    UsePermissions({{\n"
        f"        action: AuthAction.CREATE_ANY,\n"
        f"        resource: Resource.DOCKER\n"
        f"    }}),\n"
        f"    _ts_param${p}(0, Args('input', {{ type: ()=>DockerTemplateInput, nullable: false }})),\n"
        f'    _ts_metadata${m}("design:type", Function),\n'
        f'    _ts_metadata${m}("design:paramtypes", [Object]),\n'
        f'    _ts_metadata${m}("design:returntype", Promise)\n'
        f'], DockerMutationsResolver.prototype, "installDockerTemplate", null);\n'
    )
    return method_def + decorator


def _query_and_subscription_decorators(d: str, m: str, p: str) -> str:
    """Append the Query + Subscription methods + decorators to DockerResolver."""
    method_def = r""";(() => {
    DockerResolver.prototype.dockerInstallOperation = function patchedDockerInstallOperation(operationId) {
        return globalThis.__dockerInstall.getOperation(operationId);
    };
    DockerResolver.prototype.dockerInstallUpdates = function patchedDockerInstallUpdates(operationId) {
        return globalThis.__dockerInstall.subscribe(operationId);
    };
})();

"""
    query_desc = (
        'Snapshot of a Docker install operation by ID. Returns null when the '
        'operation has been cleaned up (15 min after finishing) or never existed.'
    )
    query_dec = (
        f"_ts_decorate${d}([\n"
        f"    Query(()=>DockerInstallOperation, {{ nullable: true, description: {repr(query_desc)} }}),\n"
        f"    UsePermissions({{\n"
        f"        action: AuthAction.READ_ANY,\n"
        f"        resource: Resource.DOCKER\n"
        f"    }}),\n"
        f"    _ts_param${p}(0, Args('operationId', {{ type: ()=>ID }})),\n"
        f'    _ts_metadata${m}("design:type", Function),\n'
        f'    _ts_metadata${m}("design:paramtypes", [String]),\n'
        f'    _ts_metadata${m}("design:returntype", Object)\n'
        f'], DockerResolver.prototype, "dockerInstallOperation", null);\n'
    )

    sub_desc = (
        'Stream events from a Docker install operation. Each event carries the '
        'delta output lines emitted since the previous event.'
    )
    sub_dec = (
        f"_ts_decorate${d}([\n"
        f"    Subscription(()=>DockerInstallEvent, {{\n"
        f"        name: 'dockerInstallUpdates',\n"
        f"        resolve: (payload)=>payload.dockerInstallUpdates,\n"
        f"        description: {repr(sub_desc)}\n"
        f"    }}),\n"
        f"    UsePermissions({{\n"
        f"        action: AuthAction.READ_ANY,\n"
        f"        resource: Resource.DOCKER\n"
        f"    }}),\n"
        f"    _ts_param${p}(0, Args('operationId', {{ type: ()=>ID }})),\n"
        f'    _ts_metadata${m}("design:type", Function),\n'
        f'    _ts_metadata${m}("design:paramtypes", [String]),\n'
        f'    _ts_metadata${m}("design:returntype", Object)\n'
        f'], DockerResolver.prototype, "dockerInstallUpdates", null);\n'
    )

    return method_def + query_dec + sub_dec


def apply() -> bool:
    return patch_bundle()
