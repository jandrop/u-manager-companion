"""Share-related patches (the largest group).

* `share-extra-fields`: expose `useCache`, `cachePool`, `cachePool2`
  on the `Share` GraphQL type.
* `array-disk-share-enabled`: expose `shareEnabled` on `ArrayDisk`.
* `slots-parser-share-enabled`: preserve `shareEnabled` on parsed
  ArrayDisk entities.
* `shares-parser-use-cache`: preserve `useCache` on parsed shares.
* `share-mutations`: add `createShare` / `updateShare` /
  `deleteShare` mutations.
* `share-security`: expose SMB security state + mutations for the
  share editor's "Security" tab.
* `share-is-empty`: add `shareIsEmpty(name)` query so the editor can
  gate the Delete button.
"""
from __future__ import annotations

import glob
import os
import re

from companion._bundle import (
    BUNDLE_GLOB,
    find_bundle,
    find_bundle_with,
    find_decorator_suffix,
    find_metadata_suffix,
)
from companion._runtime import log

SHARE_MUTATIONS_MARKER = "/* u-manager-companion: share-mutations override */"
SHARE_EXTRA_FIELDS_MARKER = "/* u-manager-companion: share-extra-fields */"


def patch_share_extra_fields_bundle() -> bool:
    """Expose `useCache`, `cachePool` and `cachePool2` on the `Share`
    GraphQL type.

    The official `Share` ObjectType ships only a derived `cache: Boolean`
    field. The underlying `.cfg` stores three distinct values
    (`shareUseCache`, `shareCachePool`, `shareCachePool2`) that the
    mobile app needs to render the share editor in the right initial
    state — without them, "edit share" cannot pre-populate the
    primary/secondary storage dropdowns and the useCache mode.

    The `Share` class lives in `index-*.js` (alongside the other GraphQL
    models), not the main `plugin.module-*.js` patched elsewhere. We
    inject three `_ts_decorate([Field(...)], Share.prototype, "...", void 0)`
    blocks right before the final `Share = _ts_decorate([ObjectType(...)],
    Share);` line. The runtime entity returned by `getShares('users')`
    already has these properties (parsed from `shares.ini`), so all we
    need is the GraphQL decoration to expose them.

    Tracked upstream: PR pending on the unraid-api fork
    (fix/share-mutations).
    """
    bundle = find_bundle_with('], Share.prototype, "luksStatus", void 0);')
    if not bundle:
        log("share-extra-fields patch: index bundle with Share class not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if SHARE_EXTRA_FIELDS_MARKER in content:
        return False

    # The class is finalised by exactly this snippet — inject the new
    # field decorators directly before it so they decorate the
    # prototype before the ObjectType class decorator finalises Share.
    anchor = (
        "], Share.prototype, \"luksStatus\", void 0);\n"
        "Share = _ts_decorate([\n"
    )
    if anchor not in content:
        log("share-extra-fields patch: anchor not found in index bundle")
        return False

    extra_fields = (
        SHARE_EXTRA_FIELDS_MARKER + "\n"
        "_ts_decorate([\n"
        "    Field(()=>String, {\n"
        "        description: 'Raw cache usage mode written to the share .cfg (\"\", \"no\", \"yes\", \"prefer\", \"only\").',\n"
        "        nullable: true\n"
        "    }),\n"
        "    _ts_metadata(\"design:type\", Object)\n"
        "], Share.prototype, \"useCache\", void 0);\n"
        "_ts_decorate([\n"
        "    Field(()=>String, {\n"
        "        description: 'Primary storage pool name (e.g. \"cache\"). Empty when the share lives on the array.',\n"
        "        nullable: true\n"
        "    }),\n"
        "    _ts_metadata(\"design:type\", Object)\n"
        "], Share.prototype, \"cachePool\", void 0);\n"
        "_ts_decorate([\n"
        "    Field(()=>String, {\n"
        "        description: 'Secondary storage pool name. Empty when no secondary pool is configured.',\n"
        "        nullable: true\n"
        "    }),\n"
        "    _ts_metadata(\"design:type\", Object)\n"
        "], Share.prototype, \"cachePool2\", void 0);\n"
    )

    content = content.replace(
        anchor,
        "], Share.prototype, \"luksStatus\", void 0);\n"
        + extra_fields
        + "Share = _ts_decorate([\n",
        1,
    )
    with open(bundle, "w") as f:
        f.write(content)
    log(f"enabled extra share fields in API ({os.path.basename(bundle)})")
    return True


SHARES_PARSER_OLD = "cache: useCache === 'yes',"
SHARES_PARSER_NEW = "useCache,\n            cache: useCache === 'yes',"

ARRAY_DISK_SHARE_ENABLED_MARKER = (
    "/* u-manager-companion: array-disk-share-enabled */"
)
SLOTS_PARSER_OLD = (
    "isSpinning: slot.spundown ? slot.spundown === '0' : null"
)
SLOTS_PARSER_NEW = (
    "isSpinning: slot.spundown ? slot.spundown === '0' : null,\n"
    "            shareEnabled: slot.shareEnabled !== undefined "
    "? toBoolean(slot.shareEnabled) : null"
)


def patch_array_disk_share_enabled_bundle() -> bool:
    """Expose `shareEnabled` on the `ArrayDisk` GraphQL type.

    Pool entries in `disks.ini` carry a `shareEnabled="yes"|"no"` flag
    that controls whether the pool is selectable as primary/secondary
    storage in the legacy share editor. The official `ArrayDisk` does
    not expose it, so the mobile share editor can't replicate the web
    UI's filtering and ends up offering pools that the user already
    disabled in Pool Settings.

    Same shape as `patch_share_extra_fields_bundle()` — injects a
    single `_ts_decorate([Field(...)], ArrayDisk.prototype, "shareEnabled",
    void 0)` block before the final ObjectType class decoration in
    `index-*.js`. Runtime values are populated by the companion's
    sibling slots-parser patch.

    Tracked upstream: PR pending on the unraid-api fork
    (fix/share-mutations).
    """
    bundle = find_bundle_with('], ArrayDisk.prototype, "isSpinning", void 0);')
    if not bundle:
        log("array-disk-share-enabled: index bundle with ArrayDisk not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if ARRAY_DISK_SHARE_ENABLED_MARKER in content:
        return False

    anchor = (
        '], ArrayDisk.prototype, "isSpinning", void 0);\n'
        "ArrayDisk = _ts_decorate([\n"
    )
    if anchor not in content:
        log("array-disk-share-enabled: anchor not found")
        return False

    field_block = (
        ARRAY_DISK_SHARE_ENABLED_MARKER + "\n"
        "_ts_decorate([\n"
        "    Field(()=>Boolean, {\n"
        "        nullable: true,\n"
        "        description: 'For pool devices, whether the pool is allowed to back user shares (`shareEnabled` flag from disks.ini).'\n"
        "    }),\n"
        "    _ts_metadata(\"design:type\", Object)\n"
        "], ArrayDisk.prototype, \"shareEnabled\", void 0);\n"
    )

    content = content.replace(
        anchor,
        '], ArrayDisk.prototype, "isSpinning", void 0);\n'
        + field_block
        + "ArrayDisk = _ts_decorate([\n",
        1,
    )
    with open(bundle, "w") as f:
        f.write(content)
    log(f"enabled per-disk share toggle in API ({os.path.basename(bundle)})")
    return True


def patch_slots_parser_share_enabled_bundle() -> bool:
    """Preserve `shareEnabled` on parsed ArrayDisk entities.

    The slots parser at `api/src/store/state-parsers/slots.ts`
    constructs each `ArrayDisk` result with an explicit field list
    that excludes `shareEnabled` — even though the source ini entry
    has it for pool devices. The complementary
    `patch_array_disk_share_enabled_bundle` patch exposes the
    GraphQL field, but without this passthrough the resolver reads
    `undefined` from every entity.

    Idempotent via substring check on the new assignment.
    Tracked upstream: PR pending on the unraid-api fork
    (fix/share-mutations).
    """
    candidates = glob.glob("/usr/local/unraid-api/dist/assets/slots-*.js")
    bundle = next(
        (p for p in candidates if SLOTS_PARSER_OLD in open(p).read()),
        None,
    )
    if not bundle:
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if "shareEnabled: slot.shareEnabled" in content:
        return False
    content = content.replace(SLOTS_PARSER_OLD, SLOTS_PARSER_NEW, 1)
    with open(bundle, "w") as f:
        f.write(content)
    log(f"enabled per-disk share toggle pass-through ({os.path.basename(bundle)})")
    return True


def patch_shares_parser_use_cache_bundle() -> bool:
    """Preserve `useCache` on parsed share entities.

    The state parser at `api/src/store/state-parsers/shares.ts`
    destructures `useCache` from the ini and uses it only to derive
    `cache: useCache === 'yes'` — the raw `useCache` value is dropped.
    The companion's `patch_share_extra_fields_bundle()` exposes a
    `useCache` GraphQL field, so this complementary patch makes sure
    the runtime entity actually carries the value the resolver reads.

    Idempotent via the `useCache,\\n            cache: useCache` check.
    Tracked upstream: PR pending on the unraid-api fork
    (fix/share-mutations).
    """
    candidates = glob.glob("/usr/local/unraid-api/dist/assets/shares-*.js")
    bundle = next(
        (p for p in candidates if SHARES_PARSER_OLD in open(p).read()),
        None,
    )
    if not bundle:
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if "useCache,\n            cache: useCache" in content:
        return False
    content = content.replace(SHARES_PARSER_OLD, SHARES_PARSER_NEW, 1)
    with open(bundle, "w") as f:
        f.write(content)
    log(f"enabled cache pool info pass-through ({os.path.basename(bundle)})")
    return True


def patch_share_mutations_bundle() -> bool:
    """Expose `createShare`, `updateShare` and `deleteShare` mutations.

    The official unraid-api ships a stub at
    `api/src/core/modules/add-share.ts` that throws `NotImplementedError`
    and isn't even wired into the schema. Share CRUD in stock Unraid
    goes through the legacy emhttp PHP UI which POSTs to the emhttpd
    unix socket at `/var/run/emhttpd.socket` with form-encoded fields.

    This patch injects three new methods onto the existing
    `SharesResolver.prototype` plus the matching NestJS `@Mutation`
    decorator calls so the GraphQL schema picks them up at runtime.
    The methods reuse the bundle's existing `emcmd()` helper, which
    already knows how to talk to the socket and inject the CSRF token
    from `/var/local/emhttp/var.ini`.

    Shape:
        createShare(name: String!, settings: JSON): Share
        updateShare(name: String!, settings: JSON): Share
        deleteShare(name: String!): Boolean!

    `settings` is a `GraphQLJSON` scalar with optional keys: `comment`,
    `cachePool`, `cachePool2`, `useCache`, `cow`, `floor`, `allocator`,
    `splitLevel`, `include[]`, `exclude[]`. Omitted keys keep their
    current value on update; on create they fall back to emhttpd's
    defaults (matches what the legacy UI sends from `ShareEdit.page`
    when the user clicks "Add Share" with all defaults).

    Tracked upstream: PR pending on the unraid-api fork
    (fix/share-mutations).
    """
    bundle = find_bundle()
    if not bundle:
        log("share-mutations patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()
    if SHARE_MUTATIONS_MARKER in content:
        return False

    # The class is closed by exactly this 5-line decoration. We inject the
    # mutation overlay immediately after it so the new prototype methods
    # are visible to the decorator calls that follow.
    anchor = (
        "SharesResolver = _ts_decorate$6([\n"
        "    Resolver(()=>Share),\n"
        '    _ts_metadata$4("design:type", Function),\n'
        '    _ts_metadata$4("design:paramtypes", [])\n'
        "], SharesResolver);"
    )
    if anchor not in content:
        log("share-mutations patch: SharesResolver class decoration anchor not found")
        return False

    overlay = "\n" + SHARE_MUTATIONS_MARKER + "\n" + r"""
function _ts_param$share(paramIndex, decorator) {
    return function(target, key) { decorator(target, key, paramIndex); };
}
;(() => {
    const proto = SharesResolver.prototype;
    const VALID_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;
    // The bundle is loaded as an ES module, so `require()` is unavailable.
    // Cache the dynamic-import promises once so the modules resolve on
    // first call and every subsequent invocation pays no cost.
    const netModulePromise = import('node:net');
    const fsPromiseModulePromise = import('node:fs/promises');
    const timersPromiseModulePromise = import('node:timers/promises');

    function buildCommands(s) {
        s = s || {};
        return {
            shareComment: s.comment != null ? String(s.comment) : '',
            shareCachePool: s.cachePool != null ? String(s.cachePool) : '',
            shareCachePool2: s.cachePool2 != null ? String(s.cachePool2) : '',
            shareUseCache: s.useCache != null ? String(s.useCache) : '',
            shareCOW: s.cow != null ? String(s.cow) : 'auto',
            shareFloor: s.floor != null ? String(s.floor) : '',
            shareAllocator: s.allocator != null ? String(s.allocator) : 'highwater',
            shareSplitLevel: s.splitLevel != null ? String(s.splitLevel) : '',
            shareInclude: Array.isArray(s.include) ? s.include.join(',') : '',
            shareExclude: Array.isArray(s.exclude) ? s.exclude.join(',') : '',
        };
    }

    function validateName(name) {
        if (!name || typeof name !== 'string') throw new Error('Share name is required.');
        if (name.length > 40) throw new Error('Share name must be at most 40 characters.');
        if (!VALID_NAME_RE.test(name)) throw new Error('Invalid share name. Must start with a letter and contain only letters, digits, dot, underscore or hyphen.');
        if (name.endsWith('.')) throw new Error('Share name may not end with a dot.');
    }

    async function readCsrfToken() {
        try {
            const { readFile } = await fsPromiseModulePromise;
            const data = await readFile('/var/local/emhttp/var.ini', 'utf-8');
            const m = data.match(/^csrf_token=\"?([^\"\n]+)\"?/m);
            return m ? m[1] : '';
        } catch (e) { return ''; }
    }

    /**
     * Send a form-encoded POST to /var/run/emhttpd.socket and return the
     * raw response body. emhttpd replies with HTTP/0.9 on success (just
     * the body, no status line) and a partial HTTP/1.1 frame on error,
     * so we bypass Node's http parser and read bytes directly off the
     * socket.
     */
    async function callEmhttpd(commands) {
        const { createConnection } = await netModulePromise;
        const csrf = await readCsrfToken();
        if (!csrf) {
            throw new Error('CSRF token unavailable. Is /var/local/emhttp/var.ini readable?');
        }
        const body = new URLSearchParams(Object.assign({}, commands, { csrf_token: csrf })).toString();
        const request =
            'POST /update HTTP/1.1\r\n' +
            'Host: localhost\r\n' +
            'Content-Type: application/x-www-form-urlencoded\r\n' +
            'Content-Length: ' + Buffer.byteLength(body) + '\r\n' +
            'Connection: close\r\n' +
            '\r\n' +
            body;
        return await new Promise((resolve, reject) => {
            const socket = createConnection('/var/run/emhttpd.socket');
            const chunks = [];
            let settled = false;
            let idleTimer;
            const settle = (ok, payload) => {
                if (settled) return;
                settled = true;
                if (idleTimer) clearTimeout(idleTimer);
                try { socket.destroy(); } catch (e) {}
                if (ok) resolve(payload); else reject(payload);
            };
            // Hard ceiling — emhttpd's `cmdEditShare=Add Share` and
            // `=Delete` respond fast (sub-second) but `=Apply` (update)
            // can sit on the connection for ~12s before sending the HTTP
            // headers. 30s is comfortable for all three; anything longer
            // and the socket is truly stuck.
            socket.setTimeout(30000);
            socket.on('connect', () => {
                // Half-close the write side immediately — emhttpd's HTTP/0.9
                // success response leaves the read side open indefinitely
                // otherwise, because there is no Content-Length or
                // chunked-encoding marker for the parser to detect EOF.
                socket.end(request);
            });
            socket.on('data', (chunk) => {
                chunks.push(chunk);
                // Some response bodies arrive in two fragments — debounce
                // 200ms after the last byte before declaring "done".
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(
                    () => settle(true, Buffer.concat(chunks).toString('utf8')),
                    200
                );
            });
            socket.on('end', () => settle(true, Buffer.concat(chunks).toString('utf8')));
            socket.on('timeout', () => settle(false, new Error('emhttpd socket timeout')));
            socket.on('error', (err) => settle(false, err));
        });
    }

    /**
     * Detect explicit failure in emhttpd's response body.
     * Success bodies look like `<script>replaceName("name");</script>`.
     * Failure bodies are bare strings such as `500 Internal Server Error`
     * or a partial HTTP/1.1 frame whose body contains the error text.
     */
    function isFailureResponse(body) {
        if (!body) return false;
        if (/<script\b/i.test(body)) return false;
        if (/^\s*500\b|Internal Server Error|Bad Request|Unauthorized|Forbidden/i.test(body)) return true;
        return false;
    }

    /**
     * Poll `getShares('users')` for at most `maxMs` until `predicate`
     * returns truthy on its result. Returns the matched share or
     * `undefined` if it never appeared.
     *
     * The in-memory share store is refreshed by a chokidar watcher
     * around `/usr/local/emhttp/state/shares.ini`. That refresh races
     * with our mutation completing, so we have to poll instead of
     * sleeping for a fixed duration.
     */
    async function pollForShare(predicate, maxMs) {
        const { setTimeout: delay } = await timersPromiseModulePromise;
        const start = Date.now();
        const step = 50;
        while (Date.now() - start < maxMs) {
            const match = getShares('users').find(predicate);
            if (match) return match;
            await delay(step);
        }
        return undefined;
    }

    proto.createShare = async function patchedCreateShare(name, settings) {
        validateName(name);
        const existing = getShares('users').find(s => s.name === name);
        if (existing) throw new Error('A share named "' + name + '" already exists.');
        const response = await callEmhttpd(Object.assign({
            cmdEditShare: 'Add Share',
            shareName: name,
            shareNameOrig: '',
        }, buildCommands(settings)));
        if (isFailureResponse(response)) {
            throw new Error('emhttpd refused createShare: ' + response.trim().slice(0, 200));
        }
        const created = await pollForShare(s => s.name === name, 10000);
        if (!created) {
            // The state file watcher hasn't picked up the new share yet —
            // the .cfg is on disk, but the in-memory store is stale. Rather
            // than fail (the share IS created on disk), return a synthetic
            // entity built from the input so the client gets a useful
            // response and can refetch the shares list itself.
            return {
                id: name,
                name,
                comment: settings && settings.comment != null ? String(settings.comment) : '',
                allocator: settings && settings.allocator != null ? String(settings.allocator) : 'highwater',
                cow: settings && settings.cow != null ? String(settings.cow) : 'auto',
                splitLevel: settings && settings.splitLevel != null ? String(settings.splitLevel) : '',
                floor: settings && settings.floor != null ? String(settings.floor) : '',
                useCache: settings && settings.useCache != null ? String(settings.useCache) : '',
                include: Array.isArray(settings && settings.include) ? settings.include : [],
                exclude: Array.isArray(settings && settings.exclude) ? settings.exclude : [],
                size: 0,
                free: null,
                used: 0,
                cache: null,
                nameOrig: name,
                color: null,
                luksStatus: null,
            };
        }
        return created;
    };

    proto.updateShare = async function patchedUpdateShare(name, settings) {
        if (!name) throw new Error('Share name is required.');
        const current = getShares('users').find(s => s.name === name);
        if (!current) throw new Error('No share named "' + name + '".');
        const merged = Object.assign({
            comment: current.comment,
            cachePool: current.cachePool,
            cachePool2: current.cachePool2,
            useCache: current.useCache,
            cow: current.cow,
            floor: current.floor,
            allocator: current.allocator,
            splitLevel: current.splitLevel,
            include: current.include,
            exclude: current.exclude,
        }, settings || {});
        const response = await callEmhttpd(Object.assign({
            cmdEditShare: 'Apply',
            shareName: name,
            shareNameOrig: name,
        }, buildCommands(merged)));
        if (isFailureResponse(response)) {
            throw new Error('emhttpd refused updateShare: ' + response.trim().slice(0, 200));
        }
        // No reliable comparable field on the Share entity here — just
        // wait briefly for the state file to refresh and return what we
        // see. If the predicate fails the caller still gets the prior
        // value, which matches "best-effort" semantics for updates.
        const { setTimeout: delay } = await timersPromiseModulePromise;
        await delay(300);
        return getShares('users').find(s => s.name === name);
    };

    proto.deleteShare = async function patchedDeleteShare(name) {
        if (!name) throw new Error('Share name is required.');
        const existing = getShares('users').find(s => s.name === name);
        if (!existing) throw new Error('No share named "' + name + '".');
        const response = await callEmhttpd({
            cmdEditShare: 'Delete',
            confirmDelete: 'on',
            shareName: name,
            shareNameOrig: name,
        });
        if (isFailureResponse(response)) {
            throw new Error('emhttpd refused deleteShare: ' + response.trim().slice(0, 200));
        }
        return true;
    };
})();
_ts_decorate$6([
    Mutation(()=>Share, {
        description: 'Create a new user share.'
    }),
    UsePermissions({
        action: AuthAction.CREATE_ANY,
        resource: Resource.SHARE
    }),
    _ts_param$share(0, Args('name', { type: ()=>String })),
    _ts_param$share(1, Args('settings', { type: ()=>GraphQLJSON, nullable: true })),
    _ts_metadata$4("design:type", Function),
    _ts_metadata$4("design:paramtypes", [String, Object]),
    _ts_metadata$4("design:returntype", Promise)
], SharesResolver.prototype, "createShare", null);
_ts_decorate$6([
    Mutation(()=>Share, {
        description: 'Update an existing user share. Omitted fields keep their current value.'
    }),
    UsePermissions({
        action: AuthAction.UPDATE_ANY,
        resource: Resource.SHARE
    }),
    _ts_param$share(0, Args('name', { type: ()=>String })),
    _ts_param$share(1, Args('settings', { type: ()=>GraphQLJSON, nullable: true })),
    _ts_metadata$4("design:type", Function),
    _ts_metadata$4("design:paramtypes", [String, Object]),
    _ts_metadata$4("design:returntype", Promise)
], SharesResolver.prototype, "updateShare", null);
_ts_decorate$6([
    Mutation(()=>Boolean, {
        description: 'Delete a user share by name. The share directory must be empty.'
    }),
    UsePermissions({
        action: AuthAction.DELETE_ANY,
        resource: Resource.SHARE
    }),
    _ts_param$share(0, Args('name', { type: ()=>String })),
    _ts_metadata$4("design:type", Function),
    _ts_metadata$4("design:paramtypes", [String]),
    _ts_metadata$4("design:returntype", Promise)
], SharesResolver.prototype, "deleteShare", null);
"""

    content = content.replace(anchor, anchor + overlay, 1)
    with open(bundle, "w") as f:
        f.write(content)
    log(f"enabled create/edit/delete shares from the app ({os.path.basename(bundle)})")
    return True


SHARE_SECURITY_MARKER = "/* u-manager-companion: share-security override v2 */"
# Legacy marker from v1 of this patch — the v1 `shareSecurity` resolver
# read fields off `getShares('users')` which never carries SMB security
# data (that lives in /usr/local/emhttp/state/sec.ini). v2 reads sec.ini
# directly. We strip the v1 block on every apply so existing installs
# migrate cleanly.
SHARE_SECURITY_LEGACY_MARKER = (
    "/* u-manager-companion: share-security override */"
)

def patch_share_security_bundle() -> bool:
    """Expose SMB security state + mutations for the share editor's
    second-step flow.

    The legacy web UI's `SecuritySMB.page` is a separate page that
    edits per-share `export` / `caseSensitive` / `security` /
    `readList` / `writeList` / `volsizelimit` and a per-user access
    matrix (read-write / read-only / no-access). Backend POSTs use
    two emhttpd commands distinct from share CRUD:

      * `changeShareSecurity=Apply` with shareName + shareExport +
        shareSecurity + shareCaseSensitive + shareVolsizelimit
      * `changeShareAccess=Apply` with shareName +
        `userAccess.<idx>=read-write|read-only|no-access` per user

    We expose three new GraphQL fields on `SharesResolver`:

      shareSecurity(name): JSON       — current SMB security blob
      shareSecurityUsers: JSON        — array of {id, name, isRoot}
      updateShareSecurity(name, settings): Boolean
      updateShareAccess(name, access): Boolean

    The `users` and `shareSecurity` shapes are returned as the raw
    `GraphQLJSON` scalar — the client deserialises them. Same pattern
    as the existing share mutations.

    Tracked upstream: PR pending on the unraid-api fork
    (fix/share-security).
    """
    bundle = find_bundle()
    if not bundle:
        log("share-security patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()

    # ── Legacy cleanup ───────────────────────────────────────────────
    # If v1 of the patch is in the bundle, strip the entire block
    # before re-applying v2. The v1 block always ends at the
    # updateShareAccess `_ts_decorate$6(...)` closing call — anchor
    # the regex on that to stay precise.
    if SHARE_SECURITY_LEGACY_MARKER in content:
        legacy_pattern = re.compile(
            re.escape(SHARE_SECURITY_LEGACY_MARKER)
            + r".*?\], SharesResolver\.prototype, \"updateShareAccess\", null\);\n?",
            re.DOTALL,
        )
        new_content, removed = legacy_pattern.subn("", content, count=1)
        if removed:
            content = new_content
            with open(bundle, "w") as f:
                f.write(content)
            log("share-security patch: removed legacy v1 block")
            # Re-read so subsequent anchors still match the fresh content.

    if SHARE_SECURITY_MARKER in content:
        return False

    # We chain after the share-mutations overlay, which itself sits
    # right after `SharesResolver = _ts_decorate$6([...], SharesResolver);`.
    # The chain is robust because we anchor on the marker of the
    # previous patch — that marker is guaranteed present whenever
    # share mutations are active (and we always run them before
    # share-security in main()).
    anchor = SHARE_MUTATIONS_MARKER
    if anchor not in content:
        log(
            "share-security patch: share-mutations marker not present; "
            "the security overlay depends on it being applied first"
        )
        return False

    # Find the END of the share-mutations overlay so we can insert
    # AFTER it. Use the last decorator block of that overlay as the
    # tail anchor — it ends with `..., "deleteShare", null);`.
    tail = '], SharesResolver.prototype, "deleteShare", null);\n'
    tail_idx = content.find(tail, content.find(anchor))
    if tail_idx == -1:
        log("share-security patch: share-mutations tail not found")
        return False
    insert_at = tail_idx + len(tail)

    overlay = "\n" + SHARE_SECURITY_MARKER + "\n" + r"""
;(() => {
    const proto = SharesResolver.prototype;
    // Reuse the dynamic-import promises declared by the share-mutations
    // overlay — they're already in module scope thanks to that earlier
    // injection.
    const netModulePromiseSec = import('node:net');
    const fsPromiseModulePromiseSec = import('node:fs/promises');
    const iniModulePromiseSec = import('ini');
    const timersPromiseModulePromiseSec = import('node:timers/promises');

    async function readCsrfTokenSec() {
        try {
            const { readFile } = await fsPromiseModulePromiseSec;
            const data = await readFile('/var/local/emhttp/var.ini', 'utf-8');
            const m = data.match(/^csrf_token=\"?([^\"\n]+)\"?/m);
            return m ? m[1] : '';
        } catch (e) { return ''; }
    }

    async function callEmhttpdSec(commands) {
        const { createConnection } = await netModulePromiseSec;
        const csrf = await readCsrfTokenSec();
        if (!csrf) throw new Error('CSRF token unavailable.');
        const body = new URLSearchParams(Object.assign({}, commands, { csrf_token: csrf })).toString();
        const request =
            'POST /update HTTP/1.1\r\n' +
            'Host: localhost\r\n' +
            'Content-Type: application/x-www-form-urlencoded\r\n' +
            'Content-Length: ' + Buffer.byteLength(body) + '\r\n' +
            'Connection: close\r\n' +
            '\r\n' +
            body;
        return await new Promise((resolve, reject) => {
            const socket = createConnection('/var/run/emhttpd.socket');
            const chunks = [];
            let settled = false;
            let idleTimer;
            const settle = (ok, payload) => {
                if (settled) return;
                settled = true;
                if (idleTimer) clearTimeout(idleTimer);
                try { socket.destroy(); } catch (e) {}
                if (ok) resolve(payload); else reject(payload);
            };
            socket.setTimeout(30000);
            socket.on('connect', () => socket.end(request));
            socket.on('data', (chunk) => {
                chunks.push(chunk);
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(
                    () => settle(true, Buffer.concat(chunks).toString('utf8')),
                    200
                );
            });
            socket.on('end', () => settle(true, Buffer.concat(chunks).toString('utf8')));
            socket.on('timeout', () => settle(false, new Error('emhttpd socket timeout')));
            socket.on('error', (err) => settle(false, err));
        });
    }

    function isFailureResponseSec(body) {
        if (!body) return false;
        if (/<script\b/i.test(body)) return false;
        if (/^\s*500\b|Internal Server Error|Bad Request|Unauthorized|Forbidden/i.test(body)) return true;
        return false;
    }

    proto.shareSecurity = async function patchedShareSecurity(name) {
        if (!name) throw new Error('Share name is required.');
        const share = getShares('users').find(s => s.name === name);
        if (!share) throw new Error('No share named "' + name + '".');
        // The SMB security blob lives in /usr/local/emhttp/state/sec.ini,
        // not in shares.ini. `getShares('users')` only returns
        // shares.ini-derived data, so it never carries `export`,
        // `caseSensitive`, `security`, `readList`, `writeList` or
        // `volsizelimit`. Read sec.ini directly to get the real
        // current state — any IO/parse error falls back to defaults
        // so a missing sec.ini doesn't break the editor entirely.
        let sec = {};
        try {
            const { readFile } = await fsPromiseModulePromiseSec;
            const ini = await iniModulePromiseSec;
            const content = await readFile('/usr/local/emhttp/state/sec.ini', 'utf-8');
            const parsed = ini.parse ? ini.parse(content) : ini.default.parse(content);
            sec = parsed[name] || {};
        } catch (e) { /* defaults below */ }
        return {
            export: sec.export || '-',
            security: sec.security || 'public',
            caseSensitive: sec.caseSensitive || 'auto',
            readList: sec.readList ? String(sec.readList).split(',').filter(Boolean) : [],
            writeList: sec.writeList ? String(sec.writeList).split(',').filter(Boolean) : [],
            volsizelimit: sec.volsizelimit != null ? String(sec.volsizelimit) : '',
        };
    };

    proto.shareSecurityUsers = async function patchedShareSecurityUsers() {
        try {
            const { readFile } = await fsPromiseModulePromiseSec;
            const ini = await iniModulePromiseSec;
            const content = await readFile('/usr/local/emhttp/state/users.ini', 'utf-8');
            const parsed = ini.parse ? ini.parse(content) : ini.default.parse(content);
            return Object.entries(parsed).map(([key, data]) => ({
                id: String(data.idx ?? key),
                name: data.name || key,
                description: data.desc || '',
                isRoot: (data.name || key) === 'root',
            }));
        } catch (e) {
            return [];
        }
    };

    proto.updateShareSecurity = async function patchedUpdateShareSecurity(name, settings) {
        if (!name) throw new Error('Share name is required.');
        settings = settings || {};
        const response = await callEmhttpdSec({
            changeShareSecurity: 'Apply',
            shareName: name,
            shareExport: settings.export != null ? String(settings.export) : '-',
            shareSecurity: settings.security != null ? String(settings.security) : 'public',
            shareCaseSensitive: settings.caseSensitive != null ? String(settings.caseSensitive) : 'auto',
            shareVolsizelimit: settings.volsizelimit != null ? String(settings.volsizelimit) : '',
        });
        if (isFailureResponseSec(response)) {
            throw new Error('emhttpd refused updateShareSecurity: ' + response.trim().slice(0, 200));
        }
        const { setTimeout: delay } = await timersPromiseModulePromiseSec;
        await delay(150);
        return true;
    };

    proto.updateShareAccess = async function patchedUpdateShareAccess(name, access) {
        if (!name) throw new Error('Share name is required.');
        if (!Array.isArray(access)) throw new Error('access must be a list of {userId, access} entries.');
        const payload = { changeShareAccess: 'Apply', shareName: name };
        for (const entry of access) {
            if (!entry || entry.userId == null) continue;
            const value = String(entry.access || 'no-access');
            payload['userAccess.' + String(entry.userId)] = value;
        }
        const response = await callEmhttpdSec(payload);
        if (isFailureResponseSec(response)) {
            throw new Error('emhttpd refused updateShareAccess: ' + response.trim().slice(0, 200));
        }
        const { setTimeout: delay } = await timersPromiseModulePromiseSec;
        await delay(150);
        return true;
    };
})();
_ts_decorate$6([
    Query(()=>GraphQLJSON, {
        description: 'Current SMB security state for a user share.'
    }),
    UsePermissions({
        action: AuthAction.READ_ANY,
        resource: Resource.SHARE
    }),
    _ts_param$share(0, Args('name', { type: ()=>String })),
    _ts_metadata$4("design:type", Function),
    _ts_metadata$4("design:paramtypes", [String]),
    _ts_metadata$4("design:returntype", Promise)
], SharesResolver.prototype, "shareSecurity", null);
_ts_decorate$6([
    Query(()=>GraphQLJSON, {
        description: 'List of Unraid users available for share access control.'
    }),
    UsePermissions({
        action: AuthAction.READ_ANY,
        resource: Resource.SHARE
    }),
    _ts_metadata$4("design:type", Function),
    _ts_metadata$4("design:paramtypes", []),
    _ts_metadata$4("design:returntype", Promise)
], SharesResolver.prototype, "shareSecurityUsers", null);
_ts_decorate$6([
    Mutation(()=>Boolean, {
        description: 'Update SMB security for a share (export, security mode, case-sensitive, Time Machine size).'
    }),
    UsePermissions({
        action: AuthAction.UPDATE_ANY,
        resource: Resource.SHARE
    }),
    _ts_param$share(0, Args('name', { type: ()=>String })),
    _ts_param$share(1, Args('settings', { type: ()=>GraphQLJSON, nullable: true })),
    _ts_metadata$4("design:type", Function),
    _ts_metadata$4("design:paramtypes", [String, Object]),
    _ts_metadata$4("design:returntype", Promise)
], SharesResolver.prototype, "updateShareSecurity", null);
_ts_decorate$6([
    Mutation(()=>Boolean, {
        description: 'Update per-user access for a share (read-write/read-only/no-access by user id).'
    }),
    UsePermissions({
        action: AuthAction.UPDATE_ANY,
        resource: Resource.SHARE
    }),
    _ts_param$share(0, Args('name', { type: ()=>String })),
    _ts_param$share(1, Args('access', { type: ()=>GraphQLJSON })),
    _ts_metadata$4("design:type", Function),
    _ts_metadata$4("design:paramtypes", [String, Object]),
    _ts_metadata$4("design:returntype", Promise)
], SharesResolver.prototype, "updateShareAccess", null);
"""

    content = content[:insert_at] + overlay + content[insert_at:]
    with open(bundle, "w") as f:
        f.write(content)
    log(f"enabled SMB user access in share editor ({os.path.basename(bundle)})")
    return True


SHARE_IS_EMPTY_MARKER = "/* u-manager-companion: share-is-empty */"
# Legacy marker from the first iteration of this patch — when it also
# exposed a `companionInfo` resolver for client-side companion
# detection. The client now uses the upstream `installedUnraidPlugins`
# query for detection, so the bundled resolver is dead code. We strip
# the old block on every apply so installs that already received the
# v1 patch migrate cleanly.
SHARE_IS_EMPTY_LEGACY_MARKER = (
    "/* u-manager-companion: companion-info + share-is-empty */"
)

def patch_share_is_empty_bundle() -> bool:
    """Expose `shareIsEmpty(name: String!): Boolean!` so the U-Manager
    share editor can decide whether to surface the Delete button.

    emhttpd refuses to remove a non-empty share, and turning that into
    a button-press error is poor UX. We mirror the legacy web UI's
    `ShareList.php?scan=<name>` algorithm (RecursiveDirectoryIterator,
    skip `.DS_Store`, stop at the first real file) in a Node helper
    attached to `SharesResolver.prototype`.

    The TS counterpart lives in
    `unraid-api/api/src/unraid-api/graph/shares/shares.resolver.ts`
    (`shareIsEmpty`) on the `fix/share-mutations` branch and is the
    canonical source for the upstream PR.

    Attached to `SharesResolver` rather than a new `@Resolver` class
    because adding one at runtime would also require injecting NestJS
    module wiring — much more invasive. NestJS merges every resolver's
    queries into a single root, so the client sees it at
    `query.shareIsEmpty` regardless of host.
    """
    bundle = find_bundle()
    if not bundle:
        log("share-is-empty patch: bundle not found")
        return False
    with open(bundle, "r") as f:
        content = f.read()

    # ── Legacy cleanup ───────────────────────────────────────────────
    # If the bundle already has the v1 marker, snip the entire old
    # block out before doing anything else. The block always ends with
    # the shareIsEmpty `_ts_decorate$6(...)` closing call — anchor on
    # that line so the regex stays specific.
    if SHARE_IS_EMPTY_LEGACY_MARKER in content:
        legacy_pattern = re.compile(
            re.escape(SHARE_IS_EMPTY_LEGACY_MARKER)
            + r".*?\], SharesResolver\.prototype, \"shareIsEmpty\", null\);\n?",
            re.DOTALL,
        )
        new_content, removed = legacy_pattern.subn("", content, count=1)
        if removed:
            content = new_content
            log("share-is-empty patch: removed legacy companion-info block")

    if SHARE_IS_EMPTY_MARKER in content:
        # Need to write back even if the new marker is already there:
        # the legacy cleanup may have modified `content`.
        with open(bundle, "w") as f:
            f.write(content)
        return False

    # Anchor at the end of the share-security patch: every patch_*
    # function so far appends straight onto SharesResolver, so we tail
    # the last decoration we added — `updateShareAccess` — and inject
    # right after its closing `_ts_decorate$6(...)`. If that anchor is
    # missing it means the share-security patch hasn't run yet and we
    # bail; main() runs patches in a fixed order so the dependency is
    # implicit.
    anchor = '], SharesResolver.prototype, "updateShareAccess", null);'
    if anchor not in content:
        log("share-is-empty patch: updateShareAccess anchor not found")
        return False

    overlay = "\n" + SHARE_IS_EMPTY_MARKER + "\n" + r"""
function _ts_param$shareIsEmpty(paramIndex, decorator) {
    return function(target, key) { decorator(target, key, paramIndex); };
}
;(() => {
    const proto = SharesResolver.prototype;
    const fsPromiseModulePromise = import('node:fs/promises');
    const pathModulePromise = import('node:path');

    /**
     * Walk `/mnt/user/<name>` recursively and return true when nothing
     * user-visible lives inside.
     *
     * Directories on their own don't count, `.DS_Store` is ignored
     * (macOS dumps these on every SMB share), symlinks are followed,
     * and the iteration stops on the first real file — so populated
     * shares are detected in O(1) and only empty shares pay the full
     * traversal cost. Any IO error resolves to `true` so the caller
     * never blocks the Delete button on a transient FS issue.
     */
    async function scanEmpty(directory) {
        const { readdir, stat } = await fsPromiseModulePromise;
        const { join } = await pathModulePromise;
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch (e) {
            return true;
        }
        for (const entry of entries) {
            const entryPath = join(directory, entry.name);
            let isDir = entry.isDirectory();
            let isFile = entry.isFile();
            if (entry.isSymbolicLink()) {
                try {
                    const s = await stat(entryPath);
                    isDir = s.isDirectory();
                    isFile = s.isFile();
                } catch (e) { continue; }
            }
            if (isFile && entry.name !== '.DS_Store') return false;
            if (isDir) {
                const childEmpty = await scanEmpty(entryPath);
                if (!childEmpty) return false;
            }
        }
        return true;
    }

    proto.shareIsEmpty = async function patchedShareIsEmpty(name) {
        if (!name || typeof name !== 'string') return true;
        return scanEmpty('/mnt/user/' + name);
    };
})();
_ts_decorate$6([
    Query(()=>Boolean, {
        description: 'Returns true when /mnt/user/<name> contains no user-visible files. Mirrors the legacy ShareList.php?scan=<name> handler.'
    }),
    UsePermissions({
        action: AuthAction.READ_ANY,
        resource: Resource.SHARE
    }),
    _ts_param$shareIsEmpty(0, Args('name', { type: ()=>String })),
    _ts_metadata$4("design:type", Function),
    _ts_metadata$4("design:paramtypes", [String]),
    _ts_metadata$4("design:returntype", Promise)
], SharesResolver.prototype, "shareIsEmpty", null);
"""

    insert_at = content.index(anchor) + len(anchor)
    content = content[:insert_at] + overlay + content[insert_at:]
    with open(bundle, "w") as f:
        f.write(content)
    log(f"enabled empty-share detection in API ({os.path.basename(bundle)})")
    return True


def apply() -> bool:
    return any([
        patch_share_extra_fields_bundle(),
        patch_array_disk_share_enabled_bundle(),
        patch_slots_parser_share_enabled_bundle(),
        patch_shares_parser_use_cache_bundle(),
        patch_share_mutations_bundle(),
        patch_share_security_bundle(),
        patch_share_is_empty_bundle(),
    ])
