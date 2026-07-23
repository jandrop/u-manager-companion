/**
 * Per-request context resolution.
 *
 * Pipeline: extract key (HTTP `x-api-key` header, or the WS
 * `connection_init` payload's `x-api-key`) -> key-store lookup
 * (primary) -> `{ me }` fallback (secondary) -> reject (fail-closed) if
 * both fail. A validated identity is cached by a HASH of the presented
 * key (never the raw key itself) with a 60s TTL -- the TTL is the
 * PRIMARY invalidation guarantee; fs-watch (context/watch.ts) is
 * layered on top as a best-effort accelerator only, and
 * `invalidateAll()` here is the mechanism it calls into.
 *
 * Transport-specific error handling (dual auth-error semantics) is NOT
 * this module's job -- server.ts catches AuthenticationError and maps
 * it per-transport (HTTP -> extensions.code UNAUTHENTICATED GraphQL
 * error; WS connection_init -> close 4401; WS per-operation -> GraphQL
 * error, not a close). This module only ever throws the ONE error type;
 * transport mapping is a server-layer concern by design so this module
 * stays transport-agnostic.
 */
import { createHash } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { resolveIdentityFromKey, resolveKeyStoreDir, type ResolvedIdentity } from './auth/keystore.js';
import { resolveIdentityViaMeFallback } from './auth/identity.js';

/** Thrown when neither the key store nor the { me } fallback resolves an
 * identity for the presented key (or no key was presented at all).
 * Transport-specific mapping happens via the toHttpAuthError /
 * toWsConnectionInitCloseReason / toWsOperationAuthError helpers below,
 * consumed by server.ts, not here. */
export class AuthenticationError extends Error {
  constructor(message = 'Authentication failed') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/** Thrown when an identity is authenticated but lacks the permission
 * required for a specific operation (auth/permissions.ts's
 * isAuthorized() returning false). Distinct from AuthenticationError so
 * transport mapping can distinguish "who are you" from "you can't do
 * that" (dual auth-error semantics). */
export class PermissionError extends Error {
  constructor(message = 'Insufficient permissions') {
    super(message);
    this.name = 'PermissionError';
  }
}

/** Validated-key cache TTL in milliseconds. Primary invalidation
 * guarantee -- holds regardless of fs-watch event delivery reliability
 * on the FAT /boot mount. */
export const CONTEXT_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  readonly identity: ResolvedIdentity;
  readonly expiresAt: number;
}

export interface ContextCache {
  get(keyHash: string): ResolvedIdentity | null;
  set(keyHash: string, identity: ResolvedIdentity): void;
  /** Clears every entry immediately. Called by the fs-watch invalidator
   * and the poll fallback when the key store changes. */
  invalidateAll(): void;
  /** Test/debug-only: returns the raw cache keys (hashes) currently
   * stored, so tests can assert the raw key is never a cache key. */
  debugKeys(): readonly string[];
}

/**
 * Creates an in-memory `Map<keyHash, {identity, expiresAt}>` cache. One
 * instance is expected to live for the process lifetime, shared across
 * every request context resolution.
 */
export function createContextCache(): ContextCache {
  const store = new Map<string, CacheEntry>();

  return {
    get(keyHash) {
      const entry = store.get(keyHash);
      if (!entry) return null;
      if (Date.now() >= entry.expiresAt) {
        store.delete(keyHash);
        return null;
      }
      return entry.identity;
    },
    set(keyHash, identity) {
      store.set(keyHash, { identity, expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS });
    },
    invalidateAll() {
      store.clear();
    },
    debugKeys() {
      return [...store.keys()];
    },
  };
}

/** Hashes a presented key for cache storage -- the cache must never
 * hold the raw key string. SHA-256 is sufficient here: no
 * password-style brute-force concern (the key space is a random UUID
 * from the key store), this is purely a lookup-key transform. */
function hashKey(presentedKey: string): string {
  return createHash('sha256').update(presentedKey).digest('hex');
}

/** Extracts `x-api-key` from HTTP request headers. Accepts either a
 * WHATWG `Headers` instance or a plain lowercase-keyed record, since
 * Apollo Server's standalone HTTP handler and test fixtures use either
 * shape. */
export function extractKeyFromHttpHeaders(
  headers: Headers | Record<string, string | undefined>,
): string | null {
  const value =
    headers instanceof Headers ? headers.get('x-api-key') : headers['x-api-key'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Extracts `x-api-key` from a `graphql-ws` `connection_init` message
 * payload. The payload is untyped at the protocol level (`unknown`), so
 * this validates the shape defensively before trusting it. */
export function extractKeyFromConnectionInitPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)['x-api-key'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export interface ResolveAuthContextOptions {
  readonly cache: ContextCache;
  /** Injectable for tests; defaults to the verified on-box path via
   * resolveKeyStoreDir(). */
  readonly keyStoreDir?: string;
  /** Injectable for tests; defaults to the real { me } fallback probe. */
  readonly meFallback?: (presentedKey: string) => Promise<ResolvedIdentity | null>;
}

/**
 * Resolves the caller's identity for a presented key, per the pipeline:
 * cache hit short-circuits everything; on a miss, key-store lookup
 * first, then the `{ me }` fallback, then reject. A resolved identity
 * from EITHER path is cached under the same TTL.
 *
 * Throws AuthenticationError (never returns null) so callers (server.ts
 * resolvers/context builders) get a single, easy-to-catch failure mode
 * to map to transport-specific semantics.
 */
export async function resolveAuthContext(
  presentedKey: string | null,
  options: ResolveAuthContextOptions,
): Promise<ResolvedIdentity> {
  if (!presentedKey) {
    throw new AuthenticationError('No API key presented');
  }

  const keyHash = hashKey(presentedKey);
  const cached = options.cache.get(keyHash);
  if (cached) return cached;

  const keyStoreDir = options.keyStoreDir ?? resolveKeyStoreDir();
  const fromKeyStore = resolveIdentityFromKey(presentedKey, keyStoreDir);
  if (fromKeyStore) {
    options.cache.set(keyHash, fromKeyStore);
    return fromKeyStore;
  }

  const meFallback = options.meFallback ?? resolveIdentityViaMeFallback;
  const fromMeFallback = await meFallback(presentedKey);
  if (fromMeFallback) {
    options.cache.set(keyHash, fromMeFallback);
    return fromMeFallback;
  }

  throw new AuthenticationError('Key not recognised by key store or { me } fallback');
}

// ---------------------------------------------------------------------------
// Dual auth-error semantics by transport.
//
// server.ts is the ONLY place that knows which transport a given
// failure occurred on -- these helpers exist so that mapping is a
// single function call at each of the three transport boundaries,
// rather than ad hoc error-shaping scattered through server.ts.
// ---------------------------------------------------------------------------

/** WS close code for a rejected `connection_init` -- matches the
 * `graphql-transport-ws` subprotocol's documented "Unauthorized" close
 * convention. */
export const WS_CONNECTION_INIT_UNAUTHORIZED_CODE = 4401;

/**
 * HTTP path: any auth failure (unauthenticated OR unauthorized) becomes
 * a GraphQL-standard error with `extensions.code: UNAUTHENTICATED`. The
 * HTTP transport does not distinguish authentication vs. authorization
 * failures -- both are surfaced identically as "this request isn't
 * allowed," avoiding a permission-enumeration side-channel (an attacker
 * probing with a valid-but-underprivileged key learns nothing more than
 * one probing with no key at all).
 */
export function toHttpAuthError(error: AuthenticationError | PermissionError): GraphQLError {
  return new GraphQLError(error.message, {
    extensions: { code: 'UNAUTHENTICATED' },
  });
}

export interface WsCloseReason {
  readonly code: number;
  readonly reason: string;
}

/**
 * WS path, connection-level: a failed/missing key at `connection_init`
 * closes the socket -- no GraphQL error body is possible before the
 * handshake completes, so this returns a close code/reason pair for
 * server.ts to pass to the `graphql-ws` server's `onConnect` rejection
 * (which closes with 4401 per the subprotocol convention), not a
 * GraphQLError.
 */
export function toWsConnectionInitCloseReason(error: AuthenticationError): WsCloseReason {
  return {
    code: WS_CONNECTION_INIT_UNAUTHORIZED_CODE,
    reason: error.message,
  };
}

/**
 * WS path, per-operation: once a socket is established, a subsequent
 * failure on a SPECIFIC operation (either the key expired mid-session,
 * or a permission check fails) is a GraphQL error over the still-open
 * socket, NOT a close -- the connection itself remains valid for other
 * operations. `extensions.code` distinguishes the two failure kinds so
 * the app can tell "your session needs re-auth" from "you don't have
 * permission for this specific action."
 */
export function toWsOperationAuthError(
  error: AuthenticationError | PermissionError,
): GraphQLError {
  const code = error instanceof PermissionError ? 'FORBIDDEN' : 'UNAUTHENTICATED';
  return new GraphQLError(error.message, { extensions: { code } });
}
