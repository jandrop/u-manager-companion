/**
 * On-disk API key-store reader. VERIFIED shape per box-verification:
 *
 *   dir: /boot/config/plugins/dynamix.my.servers/keys/*.json
 *   file: {createdAt, id, key, name, permissions, roles: [str]}
 *   filename = <id>.json (uuid), NOT the key value -- the presented
 *   x-api-key is matched against the `key` FIELD, never the filename.
 *
 * Observed roles: ADMIN, VIEWER. A key with an empty `permissions` array
 * takes its authority from the ROLE (ADMIN=full, VIEWER=read-only).
 * Explicit grants are objects, matching unraid-api's `Permission` model:
 *
 *   "permissions": [{ "resource": "DISPLAY", "actions": ["UPDATE_ANY"] }]
 *
 * They are normalized to the `RESOURCE:action` strings permissions.ts
 * compares against, so nothing downstream sees two shapes.
 *
 * Fail-safe by design: a missing directory, an unreadable file, or a
 * malformed JSON entry is SKIPPED, not thrown -- one corrupt key file
 * must never take down auth for every other valid key. This mirrors the
 * "fail-closed on individual denial, not fail-crash on individual
 * corruption" posture the rest of the auth pipeline takes. An unreadable
 * permission entry is dropped the same way; dropping one can only narrow
 * what a key may do.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Authority derived from role when `permissions` is empty, or 'scoped'
 * when a non-empty `permissions` array is present and takes precedence. */
export type Authority = 'full' | 'read-only' | 'scoped' | 'none';

export interface KeyStoreEntry {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly roles: readonly string[];
  /** Normalized `RESOURCE:action` grants. See toPermissionKeys(). */
  readonly permissions: readonly string[];
  /** Whether the key file listed any explicit grant. */
  readonly hasExplicitGrants: boolean;
}

export interface ResolvedIdentity {
  readonly id: string;
  readonly name: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly authority: Authority;
}

/**
 * Default key-store directory, per the VERIFIED on-box path.
 * Overridable via COMPANION_KEYSTORE_DIR, same env-override pattern
 * server.ts's resolvePort() uses -- lets tests point at a fixture dir
 * without touching the real filesystem.
 */
export function resolveKeyStoreDir(): string {
  return (
    process.env['COMPANION_KEYSTORE_DIR'] ??
    '/boot/config/plugins/dynamix.my.servers/keys'
  );
}

/**
 * Action names that permit a change. Matched upper-cased, as unraid-api's
 * own parser does.
 *
 * `_OWN` is excluded on purpose: it scopes a grant to objects the caller
 * owns, and everything this service writes is server-wide config with no
 * owner. `*` is Unraid's shorthand for the full CRUD set.
 */
const UPDATE_ACTIONS = new Set(['UPDATE_ANY', '*', 'UPDATE']);

/**
 * Builds the grant string for `resource` when any of `actions` permits a
 * change, or an empty list when none does.
 *
 * A wildcard resource is left as `*`; isAuthorized() matches it directly,
 * so a capability added later needs no change here.
 */
function toUpdateGrant(
  resource: string,
  actions: readonly unknown[],
): readonly string[] {
  return actions.some(
    (action) =>
      typeof action === 'string' && UPDATE_ACTIONS.has(action.toUpperCase()),
  )
    ? [`${resource}:update`]
    : [];
}

/**
 * Normalizes one `permissions` element, or returns an empty list when it
 * grants nothing this service gates on.
 *
 * Takes the object shape unraid-api writes, plus a `RESOURCE:ACTION`
 * string for any other writer. Strings go through the same action mapping
 * rather than passing through, so `DISPLAY:UPDATE_ANY` still resolves.
 */
function toPermissionKeys(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    const separator = value.indexOf(':');
    if (separator <= 0) return [];
    return toUpdateGrant(value.slice(0, separator), [
      value.slice(separator + 1),
    ]);
  }
  if (typeof value !== 'object' || value === null) return [];

  const record = value as Record<string, unknown>;
  const resource = record['resource'];
  const actions = record['actions'];
  if (typeof resource !== 'string' || resource.length === 0) return [];
  if (!Array.isArray(actions)) return [];

  return toUpdateGrant(resource, actions);
}

/** A key file as it comes off disk, before permissions are normalized. */
interface RawKeyRecord {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly roles: readonly string[];
  readonly permissions: readonly unknown[];
}

function isRawKeyRecord(value: unknown): value is RawKeyRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record['id'] !== 'string' || record['id'].length === 0) return false;
  if (typeof record['key'] !== 'string' || record['key'].length === 0) return false;
  if (typeof record['name'] !== 'string') return false;
  if (!Array.isArray(record['roles'])) return false;
  if (!record['roles'].every((role) => typeof role === 'string')) return false;
  if (!Array.isArray(record['permissions'])) return false;
  return true;
}

/**
 * Reads and parses every `*.json` file in `dir`, skipping anything that
 * doesn't exist, can't be read, or doesn't parse to the expected shape.
 * Never throws -- an unreadable store is an empty store (fail-closed at
 * the resolution layer, not a crash here).
 */
export function loadKeyStore(dir: string): readonly KeyStoreEntry[] {
  let filenames: string[];
  try {
    filenames = readdirSync(dir);
  } catch {
    return [];
  }

  const entries: KeyStoreEntry[] = [];
  for (const filename of filenames) {
    if (!filename.endsWith('.json')) continue;
    try {
      const raw = readFileSync(path.join(dir, filename), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isRawKeyRecord(parsed)) {
        entries.push({
          id: parsed.id,
          key: parsed.key,
          name: parsed.name,
          roles: parsed.roles,
          // Taken from the raw array, not the normalized one: a grant this
          // service does not gate on normalizes away to nothing, and an
          // empty result would hand the key its role's authority instead.
          hasExplicitGrants: parsed.permissions.length > 0,
          permissions: parsed.permissions.flatMap(toPermissionKeys),
        });
      }
    } catch {
      // Malformed/unreadable entry -- skip, don't let one bad file break
      // auth for every other valid key.
      continue;
    }
  }
  return entries;
}

/** Role names that carry full (admin) authority when permissions is empty. */
const FULL_AUTHORITY_ROLES = new Set(['ADMIN']);
/** Role names that carry read-only authority when permissions is empty. */
const READ_ONLY_AUTHORITY_ROLES = new Set(['VIEWER']);

/**
 * Explicit grants REPLACE the role here, where unraid-api adds the two
 * together. A key holding both ADMIN and a narrow grant is full admin on
 * /graphql but limited to its grants here. Deliberate: erring narrow can
 * only refuse something the user can widen.
 */
function deriveAuthority(entry: KeyStoreEntry): Authority {
  if (entry.hasExplicitGrants) return 'scoped';
  if (entry.roles.some((role) => FULL_AUTHORITY_ROLES.has(role))) return 'full';
  if (entry.roles.some((role) => READ_ONLY_AUTHORITY_ROLES.has(role))) {
    return 'read-only';
  }
  return 'none';
}

/**
 * Resolves a presented `x-api-key` value against the key store, matching
 * the `key` FIELD (never the filename -- filename is the entry's uuid).
 * Returns null when no entry matches or the store can't be read
 * (fail-closed: absence of a match is indistinguishable from absence of
 * the store, both reject).
 */
export function resolveIdentityFromKey(
  presentedKey: string,
  dir: string = resolveKeyStoreDir(),
): ResolvedIdentity | null {
  const entries = loadKeyStore(dir);
  const match = entries.find((entry) => entry.key === presentedKey);
  if (!match) return null;

  return {
    id: match.id,
    name: match.name,
    roles: match.roles,
    permissions: match.permissions,
    authority: deriveAuthority(match),
  };
}
