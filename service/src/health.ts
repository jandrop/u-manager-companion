/**
 * Health/capabilities resolver.
 *
 * This is the primary detection signal CompanionStatusCubit queries on
 * /companion/graphql -- success here means "service reachable and
 * understood," independent of whether unraid-api itself is up.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CAPABILITY_KEYS, SCHEMA_VERSION } from './schema/version.js';

/**
 * Injected by esbuild's `define` at build time (build/bundle.mjs) with the
 * value of package.json's `version`. In the bundled artifact this is a string
 * literal; in the ts/vitest context the identifier is undeclared, so
 * `typeof` below is 'undefined' and we fall back to reading package.json from
 * the real source tree. Declared here so tsc accepts the reference.
 */
declare const __COMPANION_SERVICE_VERSION__: string | undefined;

interface CompanionCapabilities {
  schemaVersion: string;
  serviceVersion: string;
  features: readonly string[];
}

/**
 * Reads `version` from the service's own package.json once and caches it
 * for the process lifetime -- serviceVersion never changes at runtime.
 */
let cachedServiceVersion: string | undefined;

function resolveServiceVersion(): string {
  if (cachedServiceVersion !== undefined) return cachedServiceVersion;
  // Prefer the build-time injected constant (bundled artifact): reading a file
  // at runtime would crash the SEA single-binary, which has no package.json on
  // disk beside it. `typeof` guards the undeclared-identifier case in ts/test.
  if (typeof __COMPANION_SERVICE_VERSION__ === 'string') {
    cachedServiceVersion = __COMPANION_SERVICE_VERSION__;
    return cachedServiceVersion;
  }
  // Dev/test fallback: read package.json from the real source tree. Wrapped so
  // a missing file degrades to '0.0.0' rather than throwing inside a resolver.
  try {
    const packageJsonPath = path.join(__dirname, '..', 'package.json');
    const raw = readFileSync(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedServiceVersion =
      typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    cachedServiceVersion = '0.0.0';
  }
  return cachedServiceVersion;
}

/** Builds the CompanionCapabilities payload for the `capabilities` query. */
export function getCapabilities(): CompanionCapabilities {
  return {
    schemaVersion: SCHEMA_VERSION,
    serviceVersion: resolveServiceVersion(),
    features: CAPABILITY_KEYS,
  };
}
