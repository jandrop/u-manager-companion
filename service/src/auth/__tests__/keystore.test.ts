/**
 * Key-store parser, verified shape per box-verification.
 *
 * TDD: written before keystore.ts exists -> RED first.
 *
 * Fixture shape mirrors the VERIFIED on-box format exactly:
 *   - dir: /boot/config/plugins/dynamix.my.servers/keys/*.json (path is
 *     injectable via COMPANION_KEYSTORE_DIR for tests, same pattern as
 *     server.ts's resolvePort()).
 *   - filename = <uuid>.json, NOT the key value.
 *   - file shape: {createdAt, id, key, name, permissions, roles: [str]}.
 *   - observed roles: ADMIN, VIEWER. Empty permissions -> role carries
 *     authority (ADMIN=full, VIEWER=read-only). Explicit grants are
 *     objects ({resource, actions}), honored INSTEAD of the role, and
 *     normalized to the `RESOURCE:action` strings permissions.ts
 *     compares against.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadKeyStore, resolveIdentityFromKey } from '../keystore.js';
import { isAuthorized } from '../permissions.js';

let dir: string;

function writeKeyFile(
  filename: string,
  data: Record<string, unknown>,
): void {
  writeFileSync(path.join(dir, filename), JSON.stringify(data), 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'companion-keystore-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadKeyStore', () => {
  it('parses every *.json file in the key-store dir', () => {
    writeKeyFile('11111111-1111-1111-1111-111111111111.json', {
      createdAt: '2026-01-01T00:00:00.000Z',
      id: '11111111-1111-1111-1111-111111111111',
      key: 'admin-key-value',
      name: 'admin-key',
      permissions: [],
      roles: ['ADMIN'],
    });
    writeKeyFile('22222222-2222-2222-2222-222222222222.json', {
      createdAt: '2026-01-01T00:00:00.000Z',
      id: '22222222-2222-2222-2222-222222222222',
      key: 'viewer-key-value',
      name: 'viewer-key',
      permissions: [],
      roles: ['VIEWER'],
    });

    const entries = loadKeyStore(dir);
    expect(entries).toHaveLength(2);
  });

  it('ignores non-.json files in the directory', () => {
    writeKeyFile('11111111-1111-1111-1111-111111111111.json', {
      createdAt: '2026-01-01T00:00:00.000Z',
      id: '11111111-1111-1111-1111-111111111111',
      key: 'admin-key-value',
      name: 'admin-key',
      permissions: [],
      roles: ['ADMIN'],
    });
    writeFileSync(path.join(dir, 'README.txt'), 'not a key', 'utf8');

    const entries = loadKeyStore(dir);
    expect(entries).toHaveLength(1);
  });

  it('skips malformed JSON files instead of throwing (fail-safe parse)', () => {
    writeKeyFile('11111111-1111-1111-1111-111111111111.json', {
      createdAt: '2026-01-01T00:00:00.000Z',
      id: '11111111-1111-1111-1111-111111111111',
      key: 'admin-key-value',
      name: 'admin-key',
      permissions: [],
      roles: ['ADMIN'],
    });
    writeFileSync(path.join(dir, '33333333-3333-3333-3333-333333333333.json'), '{not json', 'utf8');

    const entries = loadKeyStore(dir);
    expect(entries).toHaveLength(1);
  });

  it('skips entries missing required fields (key or id)', () => {
    writeKeyFile('44444444-4444-4444-4444-444444444444.json', {
      createdAt: '2026-01-01T00:00:00.000Z',
      name: 'no-id-or-key',
      permissions: [],
      roles: ['ADMIN'],
    });

    const entries = loadKeyStore(dir);
    expect(entries).toHaveLength(0);
  });

  it('returns an empty list when the directory does not exist (fail-closed, not throw)', () => {
    const entries = loadKeyStore(path.join(dir, 'does-not-exist'));
    expect(entries).toEqual([]);
  });
});

describe('resolveIdentityFromKey', () => {
  beforeEach(() => {
    writeKeyFile('11111111-1111-1111-1111-111111111111.json', {
      createdAt: '2026-01-01T00:00:00.000Z',
      id: '11111111-1111-1111-1111-111111111111',
      key: 'admin-key-value',
      name: 'admin-key',
      permissions: [],
      roles: ['ADMIN'],
    });
    writeKeyFile('22222222-2222-2222-2222-222222222222.json', {
      createdAt: '2026-01-01T00:00:00.000Z',
      id: '22222222-2222-2222-2222-222222222222',
      key: 'viewer-key-value',
      name: 'viewer-key',
      permissions: [],
      roles: ['VIEWER'],
    });
  });

  it('matches the presented x-api-key against the key field (not filename)', () => {
    const identity = resolveIdentityFromKey('admin-key-value', dir);
    expect(identity).not.toBeNull();
    expect(identity?.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(identity?.name).toBe('admin-key');
  });

  it('returns null when no key matches', () => {
    const identity = resolveIdentityFromKey('unknown-value', dir);
    expect(identity).toBeNull();
  });

  it('ADMIN role with empty permissions carries full authority', () => {
    const identity = resolveIdentityFromKey('admin-key-value', dir);
    expect(identity?.authority).toBe('full');
  });

  it('VIEWER role with empty permissions carries read-only authority', () => {
    const identity = resolveIdentityFromKey('viewer-key-value', dir);
    expect(identity?.authority).toBe('read-only');
  });

  it('honors non-empty permissions array over role default when present', () => {
    writeKeyFile('55555555-5555-5555-5555-555555555555.json', {
      createdAt: '2026-01-01T00:00:00.000Z',
      id: '55555555-5555-5555-5555-555555555555',
      key: 'scoped-key-value',
      name: 'scoped-key',
      permissions: [{ resource: 'DOCKER', actions: ['UPDATE_ANY'] }],
      roles: ['VIEWER'],
    });

    const identity = resolveIdentityFromKey('scoped-key-value', dir);
    expect(identity?.permissions).toEqual(['DOCKER:update']);
    // Explicit permissions present -> authority is NOT derived from role.
    expect(identity?.authority).toBe('scoped');
  });

  it('returns null (fail-closed) for an empty or missing key store dir', () => {
    const identity = resolveIdentityFromKey('admin-key-value', path.join(dir, 'missing'));
    expect(identity).toBeNull();
  });
});

/**
 * The shape unraid-api writes for a key created with
 * `unraid-api apikey --create -r VIEWER -p DISPLAY:UPDATE_ANY`:
 *
 *   "permissions": [{ "resource": "DISPLAY", "actions": ["UPDATE_ANY"] }]
 */
describe('object-shaped permissions', () => {
  function writeGranted(key: string, permissions: unknown, roles = ['VIEWER']): void {
    writeKeyFile(`${key}.json`, {
      createdAt: '2026-01-01T00:00:00.000Z',
      id: key,
      key: `${key}-value`,
      name: key,
      permissions,
      roles,
    });
  }

  it('normalizes a granted update into the key permissions.ts compares', () => {
    writeGranted('granted', [{ resource: 'DISPLAY', actions: ['UPDATE_ANY'] }]);

    const identity = resolveIdentityFromKey('granted-value', dir);
    expect(identity?.permissions).toEqual(['DISPLAY:update']);
    expect(identity?.authority).toBe('scoped');
  });

  it('keeps a wildcard resource as a wildcard', () => {
    writeGranted('wildcard', [{ resource: '*', actions: ['UPDATE_ANY'] }]);

    expect(resolveIdentityFromKey('wildcard-value', dir)?.permissions).toEqual([
      '*:update',
    ]);
  });

  it('reads Unraid\'s wildcard action as covering updates', () => {
    writeGranted('star-action', [{ resource: 'SHARE', actions: ['*'] }]);

    expect(resolveIdentityFromKey('star-action-value', dir)?.permissions).toEqual([
      'SHARE:update',
    ]);
  });

  // _OWN scopes a grant to objects the caller owns, and this service
  // only writes server-wide config.
  it('does not treat an _OWN grant as permission to change anything', () => {
    writeGranted('own-only', [{ resource: 'DISPLAY', actions: ['UPDATE_OWN'] }]);

    expect(resolveIdentityFromKey('own-only-value', dir)?.permissions).toEqual([]);
  });

  it('ignores read grants', () => {
    writeGranted('read-only-grant', [{ resource: 'DOCKER', actions: ['READ_ANY'] }]);

    expect(resolveIdentityFromKey('read-only-grant-value', dir)?.permissions).toEqual(
      [],
    );
  });

  // The grant normalizes away to nothing. Deriving authority from what
  // survived would fall back to the role and grant full authority.
  it('keeps a narrowed ADMIN key scoped even when nothing normalizes', () => {
    writeGranted('narrow-admin', [{ resource: 'DOCKER', actions: ['READ_ANY'] }], [
      'ADMIN',
    ]);

    const identity = resolveIdentityFromKey('narrow-admin-value', dir);
    expect(identity?.permissions).toEqual([]);
    expect(identity?.authority).toBe('scoped');
  });

  it('drops an unreadable grant without losing the rest of the key', () => {
    writeGranted('partly-broken', [
      null,
      { resource: 'DISPLAY' },
      { actions: ['UPDATE_ANY'] },
      { resource: 'SHARE', actions: ['UPDATE_ANY'] },
    ]);

    const identity = resolveIdentityFromKey('partly-broken-value', dir);
    expect(identity?.permissions).toEqual(['SHARE:update']);
  });

  it('still rejects a key whose permissions field is not a list', () => {
    writeGranted('not-a-list', { resource: 'DISPLAY', actions: ['UPDATE_ANY'] });

    expect(resolveIdentityFromKey('not-a-list-value', dir)).toBeNull();
  });

  // Strings go through the same action mapping as objects.
  it('maps a string grant written with Unraid\'s action name', () => {
    writeGranted('string-grant', ['DISPLAY:UPDATE_ANY']);

    expect(resolveIdentityFromKey('string-grant-value', dir)?.permissions).toEqual(
      ['DISPLAY:update'],
    );
  });

  it('accepts a string grant already in normalized form', () => {
    writeGranted('normalized-grant', ['SHARE:update']);

    expect(
      resolveIdentityFromKey('normalized-grant-value', dir)?.permissions,
    ).toEqual(['SHARE:update']);
  });

  it('ignores a string grant that does not permit changes', () => {
    writeGranted('string-read', ['DOCKER:READ_ANY']);

    expect(resolveIdentityFromKey('string-read-value', dir)?.permissions).toEqual(
      [],
    );
  });

  it('ignores a string with no resource/action separator', () => {
    writeGranted('no-separator', ['DISPLAY', ':update', '']);

    expect(resolveIdentityFromKey('no-separator-value', dir)?.permissions).toEqual(
      [],
    );
  });

  it('ignores a string with an empty or over-segmented action', () => {
    writeGranted('odd-segments', ['DISPLAY:', 'DISPLAY:UPDATE_ANY:extra']);

    expect(resolveIdentityFromKey('odd-segments-value', dir)?.permissions).toEqual(
      [],
    );
  });

  // unraid-api's own action parser is case-insensitive.
  it('reads an action regardless of case', () => {
    writeGranted('mixed-case', [{ resource: 'DISPLAY', actions: ['update_any'] }]);

    expect(resolveIdentityFromKey('mixed-case-value', dir)?.permissions).toEqual([
      'DISPLAY:update',
    ]);
  });

  it('still refuses an _OWN grant whatever its case', () => {
    writeGranted('own-lower', [{ resource: 'DISPLAY', actions: ['update_own'] }]);

    expect(resolveIdentityFromKey('own-lower-value', dir)?.permissions).toEqual([]);
  });
});

/**
 * This file and permissions.test.ts meet at a bare `RESOURCE:action`
 * string, and each suite only pins its own side of it: the normalizer
 * here produces `CONFIG:update`, the map there requires `CONFIG:update`.
 * Change either spelling alone and both suites stay green while every
 * scoped key silently loses access -- exactly the failure this fix
 * exists to repair. So walk the whole path once, on the real seam: a key
 * file on disk -> resolved identity -> authorization decision.
 */
describe('key file -> authorization decision', () => {
  it('authorizes the plugin operations for a key granted CONFIG on disk', () => {
    writeKeyFile('66666666-6666-6666-6666-666666666666.json', {
      createdAt: '2026-01-01T00:00:00.000Z',
      id: '66666666-6666-6666-6666-666666666666',
      key: 'config-key-value',
      name: 'config-key',
      // Verbatim shape of `unraid-api apikey --create -p CONFIG:UPDATE_ANY`.
      permissions: [{ resource: 'CONFIG', actions: ['UPDATE_ANY'] }],
      roles: ['VIEWER'],
    });

    const identity = resolveIdentityFromKey('config-key-value', dir);
    if (!identity) throw new Error('the CONFIG-granted key should resolve');

    expect(identity.authority).toBe('scoped');
    expect(isAuthorized(identity, 'plugins.uninstall')).toBe(true);
    // The VIEWER role must not widen anything beyond the explicit grant.
    expect(isAuthorized(identity, 'power')).toBe(false);
  });

  it('leaves a VIEWER key with no grants unable to reach the same operation', () => {
    writeKeyFile('77777777-7777-7777-7777-777777777777.json', {
      createdAt: '2026-01-01T00:00:00.000Z',
      id: '77777777-7777-7777-7777-777777777777',
      key: 'plain-viewer-value',
      name: 'plain-viewer',
      permissions: [],
      roles: ['VIEWER'],
    });

    const identity = resolveIdentityFromKey('plain-viewer-value', dir);
    if (!identity) throw new Error('the VIEWER key should resolve');

    expect(identity.authority).toBe('read-only');
    expect(isAuthorized(identity, 'plugins.uninstall')).toBe(false);
  });
});
