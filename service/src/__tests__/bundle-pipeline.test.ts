/**
 * Build-pipeline smoke tests.
 *
 * Runs the real esbuild step (build/bundle.mjs) against the real source and
 * asserts on its output -- not a mock. This is the "bundle builds" leg of
 * a three-part smoke test (bundle / entry-starts / size-check).
 *
 * The SEA injection step itself (scripts/build-sea.sh) targets linux-x64
 * and cannot be executed on this darwin dev machine -- that leg is
 * exercised for real on the live box. This suite covers what IS verifiable
 * locally: the CJS bundle esbuild produces is valid, requireable, and
 * starts without throwing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';

// This file compiles to CommonJS (package.json "type": "commonjs"), so the
// native __dirname is used directly rather than an import.meta.url shim.
const serviceRoot = path.resolve(__dirname, '..', '..');
const bundleOut = path.join(serviceRoot, 'dist', 'bundle.cjs');

describe('esbuild bundle pipeline', () => {
  beforeAll(() => {
    // Start from a clean slate so this test proves the build step itself
    // produces the artifact, not that a stale one happens to exist.
    rmSync(path.join(serviceRoot, 'dist'), { recursive: true, force: true });
    execFileSync('node', ['build/bundle.mjs'], { cwd: serviceRoot, stdio: 'pipe' });
  }, 30_000);

  it('produces a single CJS bundle file', () => {
    expect(existsSync(bundleOut)).toBe(true);
    const { size } = statSync(bundleOut);
    expect(size).toBeGreaterThan(0);
  });

  it('the bundle is requireable as CommonJS and exports startServer', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- verifying CJS interop is the point of this test
    const mod = require(bundleOut);
    expect(typeof mod.startServer).toBe('function');
  });

  it('the bundled entry starts and binds 127.0.0.1 only (matches src/server.ts behavior)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(bundleOut);
    // startServer is async and returns a CompanionServer wrapper
    // (httpServer + close()); nginx integration is disabled here
    // (COMPANION_NGINX_ENABLED=false) so this bundle-smoke test never
    // depends on a real /etc/nginx/... tree existing on the build machine.
    const companionServer = await mod.startServer({
      port: 0,
      config: mod.resolveCompanionConfig({
        COMPANION_NGINX_ENABLED: 'false',
        COMPANION_KEYSTORE_DIR: path.join(serviceRoot, 'dist', '__bundle_test_keys__'),
      }),
    });

    const address = companionServer.httpServer.address();
    expect(address).not.toBeNull();
    if (address && typeof address !== 'string') {
      expect(address.address).toBe('127.0.0.1');
    }

    await companionServer.close();
  });
});
