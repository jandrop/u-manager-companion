/**
 * On-disk API key-store reader. VERIFIED shape per box-verification:
 *
 *   dir: /boot/config/plugins/dynamix.my.servers/keys/*.json
 *   file: {createdAt, id, key, name, permissions: [], roles: [str]}
 *   filename = <id>.json (uuid), NOT the key value -- the presented
 *   x-api-key is matched against the `key` FIELD, never the filename.
 *
 * Observed roles: ADMIN, VIEWER. Both observed keys had an empty
 * `permissions` array, so ROLES carry the authority in that case
 * (ADMIN=full, VIEWER=read-only). A non-empty `permissions` array, if
 * ever present, is honored instead of the role default.
 *
 * Fail-safe by design: a missing directory, an unreadable file, or a
 * malformed JSON entry is SKIPPED, not thrown -- one corrupt key file
 * must never take down auth for every other valid key. This mirrors the
 * "fail-closed on individual denial, not fail-crash on individual
 * corruption" posture the rest of the auth pipeline takes.
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
  readonly permissions: readonly string[];
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

function isKeyStoreEntry(value: unknown): value is KeyStoreEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record['id'] !== 'string' || record['id'].length === 0) return false;
  if (typeof record['key'] !== 'string' || record['key'].length === 0) return false;
  if (typeof record['name'] !== 'string') return false;
  if (!Array.isArray(record['roles'])) return false;
  if (!record['roles'].every((role) => typeof role === 'string')) return false;
  if (!Array.isArray(record['permissions'])) return false;
  if (!record['permissions'].every((permission) => typeof permission === 'string')) {
    return false;
  }
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
      if (isKeyStoreEntry(parsed)) {
        entries.push({
          id: parsed.id,
          key: parsed.key,
          name: parsed.name,
          roles: parsed.roles,
          permissions: parsed.permissions,
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

function deriveAuthority(entry: KeyStoreEntry): Authority {
  if (entry.permissions.length > 0) return 'scoped';
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
