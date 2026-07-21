/**
 * Per-request context resolution.
 *
 * Pipeline under test: extract key (HTTP header or WS connection_init
 * payload) -> keystore lookup -> `{ me }` fallback -> reject. Validated
 * results are cached by key HASH (never the raw key) with a 60s TTL --
 * the cache is the PRIMARY invalidation guarantee; fs-watch is a
 * best-effort accelerator layered on top, not exercised here.
 *
 * TDD: written before context.ts exists -> RED first.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createContextCache,
  extractKeyFromHttpHeaders,
  extractKeyFromConnectionInitPayload,
  resolveAuthContext,
  AuthenticationError,
} from './context.js';

let dir: string;

function writeKeyFile(filename: string, data: Record<string, unknown>): void {
  writeFileSync(path.join(dir, filename), JSON.stringify(data), 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'companion-context-'));
  writeKeyFile('11111111-1111-1111-1111-111111111111.json', {
    createdAt: '2026-01-01T00:00:00.000Z',
    id: '11111111-1111-1111-1111-111111111111',
    key: 'admin-key-value',
    name: 'admin-key',
    permissions: [],
    roles: ['ADMIN'],
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('extractKeyFromHttpHeaders', () => {
  it('reads x-api-key (lowercase) from a Headers-like object', () => {
    const headers = new Headers({ 'x-api-key': 'abc123' });
    expect(extractKeyFromHttpHeaders(headers)).toBe('abc123');
  });

  it('reads x-api-key from a plain record', () => {
    expect(extractKeyFromHttpHeaders({ 'x-api-key': 'abc123' })).toBe('abc123');
  });

  it('returns null when the header is absent', () => {
    expect(extractKeyFromHttpHeaders({})).toBeNull();
  });
});

describe('extractKeyFromConnectionInitPayload', () => {
  it('reads x-api-key from the connection_init payload', () => {
    expect(extractKeyFromConnectionInitPayload({ 'x-api-key': 'ws-key' })).toBe('ws-key');
  });

  it('returns null for a missing or malformed payload', () => {
    expect(extractKeyFromConnectionInitPayload(undefined)).toBeNull();
    expect(extractKeyFromConnectionInitPayload(null)).toBeNull();
    expect(extractKeyFromConnectionInitPayload('not-an-object')).toBeNull();
    expect(extractKeyFromConnectionInitPayload({})).toBeNull();
  });
});

describe('resolveAuthContext', () => {
  it('resolves an identity via the key store on a cache miss', async () => {
    const cache = createContextCache();
    const identity = await resolveAuthContext('admin-key-value', {
      cache,
      keyStoreDir: dir,
      meFallback: async () => null,
    });
    expect(identity.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(identity.authority).toBe('full');
  });

  it('falls back to { me } when the key store does not resolve the key', async () => {
    const cache = createContextCache();
    const meFallback = vi.fn().mockResolvedValue({
      id: 'me-1',
      name: 'fallback-user',
      roles: [],
      permissions: [],
      authority: 'scoped' as const,
    });

    const identity = await resolveAuthContext('unknown-key', {
      cache,
      keyStoreDir: dir,
      meFallback,
    });

    expect(meFallback).toHaveBeenCalledWith('unknown-key');
    expect(identity.id).toBe('me-1');
  });

  it('rejects with AuthenticationError when both key store and { me } fallback fail', async () => {
    const cache = createContextCache();
    await expect(
      resolveAuthContext('bogus-key', {
        cache,
        keyStoreDir: dir,
        meFallback: async () => null,
      }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('rejects with AuthenticationError when no key is presented at all', async () => {
    const cache = createContextCache();
    await expect(
      resolveAuthContext(null, {
        cache,
        keyStoreDir: dir,
        meFallback: async () => null,
      }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('caches a validated identity by key HASH, never the raw key, and reuses it on a hit', async () => {
    const cache = createContextCache();
    const meFallback = vi.fn().mockResolvedValue(null);

    await resolveAuthContext('admin-key-value', { cache, keyStoreDir: dir, meFallback });
    // Second call: even if the key-store dir is now wiped, the cached
    // result must still resolve -- proves the cache path short-circuits
    // the keystore/meFallback lookup on a hit.
    rmSync(dir, { recursive: true, force: true });
    const identity = await resolveAuthContext('admin-key-value', {
      cache,
      keyStoreDir: dir,
      meFallback,
    });

    expect(identity.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(meFallback).not.toHaveBeenCalled();

    // Never store the raw key string as a cache key.
    const cacheKeys = cache.debugKeys();
    expect(cacheKeys).not.toContain('admin-key-value');
    for (const cacheKey of cacheKeys) {
      expect(cacheKey).not.toBe('admin-key-value');
    }
  });

  it('expires the cache entry after the TTL (60s) and re-resolves', async () => {
    vi.useFakeTimers();
    const cache = createContextCache();

    await resolveAuthContext('admin-key-value', {
      cache,
      keyStoreDir: dir,
      meFallback: async () => null,
    });

    // Advance past the 60s TTL.
    vi.advanceTimersByTime(61_000);

    // Re-write the key file with a DIFFERENT name to prove a fresh
    // keystore read happens (not a stale cache hit).
    writeKeyFile('11111111-1111-1111-1111-111111111111.json', {
      createdAt: '2026-01-01T00:00:00.000Z',
      id: '11111111-1111-1111-1111-111111111111',
      key: 'admin-key-value',
      name: 'renamed-admin-key',
      permissions: [],
      roles: ['ADMIN'],
    });

    const identity = await resolveAuthContext('admin-key-value', {
      cache,
      keyStoreDir: dir,
      meFallback: async () => null,
    });

    expect(identity.name).toBe('renamed-admin-key');
  });

  it('invalidateAll clears every cached entry immediately (used by fs-watch invalidation)', async () => {
    const cache = createContextCache();
    const meFallback = vi.fn().mockResolvedValue(null);

    await resolveAuthContext('admin-key-value', { cache, keyStoreDir: dir, meFallback });
    cache.invalidateAll();

    // Wipe the store; if the cache were still warm this would still
    // resolve. It must NOT, proving invalidateAll actually cleared it.
    rmSync(dir, { recursive: true, force: true });
    await expect(
      resolveAuthContext('admin-key-value', { cache, keyStoreDir: dir, meFallback }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });
});
