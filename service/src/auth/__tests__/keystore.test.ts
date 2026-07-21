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
 *   - file shape: {createdAt, id, key, name, permissions: [], roles: [str]}.
 *   - observed roles: ADMIN, VIEWER. Empty permissions -> role carries
 *     authority (ADMIN=full, VIEWER=read-only); non-empty permissions,
 *     if present, are honored instead.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadKeyStore, resolveIdentityFromKey } from '../keystore.js';

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
      permissions: ['DOCKER:READ_WRITE'],
      roles: ['VIEWER'],
    });

    const identity = resolveIdentityFromKey('scoped-key-value', dir);
    expect(identity?.permissions).toEqual(['DOCKER:READ_WRITE']);
    // Explicit permissions present -> authority is NOT derived from role.
    expect(identity?.authority).toBe('scoped');
  });

  it('returns null (fail-closed) for an empty or missing key store dir', () => {
    const identity = resolveIdentityFromKey('admin-key-value', path.join(dir, 'missing'));
    expect(identity).toBeNull();
  });
});
