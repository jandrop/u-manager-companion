/**
 * `{ me }` fallback identity probe against the LOCAL unraid-api.
 *
 * Reached only when key-store resolution (keystore.ts) fails or the
 * presented key is unrecognised. POSTs `{ me { id name } }` to the
 * local unraid-api's own /graphql endpoint using the presented key as
 * the x-api-key header -- unraid-api validates it against ITS OWN key
 * store (which may differ in format/location from our own assumptions),
 * so this path is the safety net when our direct key-store read fails
 * or the store's shape ever drifts.
 *
 * BOX-VERIFIED: production unraid-api does NOT listen on TCP
 * 127.0.0.1:3001 -- that port is DEV-ONLY (.env.development). The
 * real production transport is a UNIX SOCKET at
 * /var/run/unraid-api.sock, which is what nginx itself proxies `/graphql`
 * to (`proxy_pass http://unix:/var/run/unraid-api.sock:/graphql`,
 * locations.conf). This module therefore defaults to the unix socket via
 * Node's `http.request({ socketPath, path })`, with an env override
 * (COMPANION_LOCAL_API_SOCKET) for the socket path itself, PLUS the
 * pre-existing COMPANION_LOCAL_API_URL override for dev environments that
 * want the tcp transport instead (e.g. `.env.development`'s port 3001).
 * When `options.localApiUrl` (or the COMPANION_LOCAL_API_URL env var) is
 * present, it takes priority and the http/https tcp transport (`fetch`)
 * is used -- this is also what every existing test in identity.test.ts
 * exercises, since they all pass `localApiUrl` explicitly.
 *
 * Couples this path to unraid-api being up: if it's down, the request
 * rejects/times out and this resolves to null (never throws) so the
 * caller (context.ts) can fail closed rather than crash the request
 * pipeline.
 */
import { request as httpRequest } from 'node:http';
import type { Authority, ResolvedIdentity } from './keystore.js';

export interface MeFallbackOptions {
  /** Local unraid-api GraphQL endpoint (tcp transport). Overridable for
   * tests/dev; when present, takes priority over the unix-socket default. */
  readonly localApiUrl?: string;
  /** Local unraid-api unix socket path (production default transport).
   * Only used when localApiUrl is absent. */
  readonly localApiSocketPath?: string;
  /** Bounded timeout so a hung unraid-api never hangs auth resolution. */
  readonly timeoutMs?: number;
}

const ME_QUERY = 'query CompanionAuthMe { me { id name } }';

/** Box-verified production unix socket path. */
const DEFAULT_LOCAL_API_SOCKET_PATH = '/var/run/unraid-api.sock';

/**
 * Default local unraid-api GraphQL URL (tcp transport). Only consulted
 * when explicitly set via COMPANION_LOCAL_API_URL -- the production
 * default is the unix socket (resolveDefaultLocalApiSocketPath below),
 * matching the real box's transport. Kept for dev environments
 * (`.env.development`'s tcp port 3001) via the same env-override pattern
 * as COMPANION_SERVICE_PORT/COMPANION_KEYSTORE_DIR.
 */
function resolveDefaultLocalApiUrl(): string | undefined {
  return process.env['COMPANION_LOCAL_API_URL'];
}

/** Default local unraid-api unix socket path, overridable via
 * COMPANION_LOCAL_API_SOCKET (same env-override pattern as the rest of
 * the auth module's resolve*() helpers). */
function resolveDefaultLocalApiSocketPath(): string {
  return process.env['COMPANION_LOCAL_API_SOCKET'] ?? DEFAULT_LOCAL_API_SOCKET_PATH;
}

interface MeQueryResponse {
  readonly data?: { readonly me?: { readonly id?: unknown; readonly name?: unknown } | null };
  readonly errors?: readonly unknown[];
}

/**
 * POSTs the `{ me }` query over a unix socket using Node's low-level
 * `http.request({ socketPath, path })` -- the WHATWG `fetch` global has no
 * portable unix-socket dispatcher without pulling in `undici` as a direct
 * dependency, and this is the one transport this module needs it for.
 * Mirrors `fetch`'s contract closely enough for this call site: resolves
 * to `{ ok, json() }`, rejects on network/timeout error.
 */
function postOverUnixSocket(
  socketPath: string,
  path: string,
  body: string,
  presentedKey: string,
  timeoutMs: number,
): Promise<{ readonly ok: boolean; readonly json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-api-key': presentedKey,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: statusCode >= 200 && statusCode < 300,
            json: async () => JSON.parse(text) as unknown,
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Request to local unraid-api unix socket timed out'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * `{ me }` fallback path grants a CONSERVATIVE default authority
 * ('scoped', narrower than 'full': the { me } fallback path grants a
 * conservative default). Permission checks against a 'scoped' identity
 * with no explicit permissions list must be evaluated conservatively by
 * the caller (permissions.ts), not treated as automatic full access.
 */
const ME_FALLBACK_AUTHORITY: Authority = 'scoped';

/**
 * Resolves an identity via the `{ me }` fallback. Returns null (never
 * throws) on any failure: network error, non-2xx status, GraphQL
 * errors, or a null/missing `me` field -- all are "fallback did not
 * resolve an identity," which the caller treats identically to a
 * key-store miss (reject if both fail).
 */
export async function resolveIdentityViaMeFallback(
  presentedKey: string,
  options: MeFallbackOptions = {},
): Promise<ResolvedIdentity | null> {
  const url = options.localApiUrl ?? resolveDefaultLocalApiUrl();
  const timeoutMs = options.timeoutMs ?? 5_000;
  const body = JSON.stringify({ query: ME_QUERY });

  try {
    let response: { readonly ok: boolean; readonly json: () => Promise<unknown> };

    if (url) {
      // Explicit tcp URL (test fixture, or COMPANION_LOCAL_API_URL / dev
      // override) -- use fetch with an abort-based timeout.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': presentedKey,
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    } else {
      // Production default: POST over the local unraid-api unix socket.
      const socketPath = options.localApiSocketPath ?? resolveDefaultLocalApiSocketPath();
      response = await postOverUnixSocket(socketPath, '/graphql', body, presentedKey, timeoutMs);
    }

    if (!response.ok) return null;

    const payload = (await response.json()) as MeQueryResponse;
    if (payload.errors && payload.errors.length > 0) return null;

    const me = payload.data?.me;
    if (!me || typeof me.id !== 'string' || me.id.length === 0) return null;

    return {
      id: me.id,
      name: typeof me.name === 'string' ? me.name : '',
      roles: [],
      permissions: [],
      authority: ME_FALLBACK_AUTHORITY,
    };
  } catch {
    // Network failure, abort/timeout, or malformed JSON -- unraid-api is
    // unreachable or misbehaving. Resolve to "no identity," never throw.
    return null;
  }
}
