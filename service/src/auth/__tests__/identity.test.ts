/**
 * `{ me }` fallback probe against the LOCAL unraid-api /graphql.
 *
 * This is the SECONDARY auth path: reached only when key-store
 * resolution (keystore.ts) fails or is unrecognised. A successful `{ me
 * }` response (any resolvable identity) is accepted; couples this path
 * to unraid-api being up -- if the key store is unreadable AND
 * unraid-api is down, the request is fail-closed rejected.
 *
 * TDD: written before identity.ts exists -> RED first. `fetch` is
 * mocked via vi.stubGlobal so no real network call happens.
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveIdentityViaMeFallback } from '../identity.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

describe('resolveIdentityViaMeFallback', () => {
  it('POSTs a { me } query to the local unraid-api /graphql with the presented key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: { me: { id: 'user-1', name: 'root' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const identity = await resolveIdentityViaMeFallback('some-key', {
      localApiUrl: 'http://127.0.0.1:3001/graphql',
    });

    expect(identity).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3001/graphql');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('some-key');
    const body = JSON.parse(init.body as string) as { query: string };
    expect(body.query).toMatch(/me\s*{/);
  });

  it('resolves a conservative-default identity when { me } succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ data: { me: { id: 'user-1', name: 'root' } } }),
          { status: 200 },
        ),
      ),
    );

    const identity = await resolveIdentityViaMeFallback('some-key', {
      localApiUrl: 'http://127.0.0.1:3001/graphql',
    });

    expect(identity?.id).toBe('user-1');
    expect(identity?.authority).toBe('scoped');
  });

  it('returns null when the response has GraphQL errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ errors: [{ message: 'Unauthorized' }] }),
          { status: 200 },
        ),
      ),
    );

    const identity = await resolveIdentityViaMeFallback('bad-key', {
      localApiUrl: 'http://127.0.0.1:3001/graphql',
    });

    expect(identity).toBeNull();
  });

  it('returns null when the response has no me field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { me: null } }), { status: 200 }),
      ),
    );

    const identity = await resolveIdentityViaMeFallback('bad-key', {
      localApiUrl: 'http://127.0.0.1:3001/graphql',
    });

    expect(identity).toBeNull();
  });

  it('returns null (does not throw) when the HTTP request itself fails (unraid-api down)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );

    const identity = await resolveIdentityViaMeFallback('some-key', {
      localApiUrl: 'http://127.0.0.1:3001/graphql',
    });

    expect(identity).toBeNull();
  });

  it('returns null on a non-2xx HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Internal Error', { status: 500 })),
    );

    const identity = await resolveIdentityViaMeFallback('some-key', {
      localApiUrl: 'http://127.0.0.1:3001/graphql',
    });

    expect(identity).toBeNull();
  });
});

describe('resolveIdentityViaMeFallback -- unix socket default transport', () => {
  it('POSTs over the unix socket when no localApiUrl is given', async () => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        expect(req.method).toBe('POST');
        expect(req.url).toBe('/graphql');
        expect(req.headers['x-api-key']).toBe('socket-key');
        const parsed = JSON.parse(raw) as { query: string };
        expect(parsed.query).toMatch(/me\s*{/);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { me: { id: 'socket-user', name: 'root' } } }));
      });
    });

    // Unix socket paths have a short OS-level length limit (~104 bytes on
    // macOS) -- use a short mkdtemp-rooted name, not tmpdir() + a long
    // descriptive filename, which can overflow that limit on CI/dev
    // machines with deep TMPDIR paths.
    const socketDir = mkdtempSync(path.join(tmpdir(), 'cid-'));
    const socketPath = path.join(socketDir, 's.sock');
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    try {
      const identity = await resolveIdentityViaMeFallback('socket-key', {
        localApiSocketPath: socketPath,
      });
      expect(identity?.id).toBe('socket-user');
      expect(identity?.authority).toBe('scoped');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(socketDir, { recursive: true, force: true });
    }
  });

  it('resolves to null (never throws) when the unix socket is unreachable', async () => {
    const socketDir = mkdtempSync(path.join(tmpdir(), 'cid-'));
    const missingSocketPath = path.join(socketDir, 'missing.sock');
    try {
      const identity = await resolveIdentityViaMeFallback('some-key', {
        localApiSocketPath: missingSocketPath,
        timeoutMs: 500,
      });
      expect(identity).toBeNull();
    } finally {
      rmSync(socketDir, { recursive: true, force: true });
    }
  });

  it('prefers the explicit tcp localApiUrl over the unix socket when both are provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { me: { id: 'tcp-user', name: 'root' } } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const identity = await resolveIdentityViaMeFallback('some-key', {
      localApiUrl: 'http://127.0.0.1:3001/graphql',
      localApiSocketPath: '/var/run/should-not-be-used.sock',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(identity?.id).toBe('tcp-user');
  });
});
