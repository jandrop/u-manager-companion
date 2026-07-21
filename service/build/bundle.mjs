#!/usr/bin/env node
/**
 * esbuild bundling step -- flattens the service's dependency graph (including
 * ESM-only packages such as graphql-ws and parts of Apollo Server 4) into a
 * single CommonJS file.
 *
 * Why this step exists at all: Node's Single Executable Application (SEA)
 * feature requires ONE CommonJS entry file at injection time -- it does not
 * walk an ESM module graph. Without this pre-bundle, the raw compiled entry
 * point would fail the moment it required an ESM-only package. This step
 * exists to avoid tripping the Bun-fallback triggers.
 *
 * Output: service/dist/bundle.cjs -- a single flattened CJS file, ready to be
 * fed to `node --experimental-sea-config` (scripts/build-sea.sh).
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(__dirname, '..');
const outfile = path.join(serviceRoot, 'dist', 'bundle.cjs');

// Bake the service version in at BUILD time. health.ts must NOT read
// package.json at runtime: the SEA single-binary (and a bare `node bundle.cjs`
// run from /tmp) has no package.json on disk next to it, so __dirname/../
// package.json resolves to a nonexistent path and crashes the capabilities
// query (the app's detection signal). Reading it here, once, from the real
// source tree and injecting it as a constant keeps the artifact self-contained.
const serviceVersion = JSON.parse(
  readFileSync(path.join(serviceRoot, 'package.json'), 'utf8'),
).version ?? '0.0.0';

// Pinned to the Node major version the SEA binary embeds (esbuild's
// target MUST match the embedded Node version, not the host's Node version).
// Node 22 is the LTS line targeted for the linux-x64 SEA artifact; bump this
// alongside scripts/build-sea.sh's NODE_TARGET_VERSION when the embedded
// runtime is upgraded.
const ESBUILD_NODE_TARGET = 'node22';

mkdirSync(path.dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [path.join(serviceRoot, 'src', 'server.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ESBUILD_NODE_TARGET,
  // server.ts imports schema/schema.graphql directly -- it either inlines
  // the file at build time or reads it relative to the binary; the SEA
  // single-binary constraint decides which. The SEA blob is a single
  // opaque file with no sibling files on disk at runtime, so reading
  // schema.graphql relative to the binary at runtime is not an option --
  // esbuild's 'text' loader for the .graphql extension inlines the file's
  // full content as a JS string constant into bundle.cjs at BUILD time
  // instead, so the single-binary artifact never needs filesystem access to
  // resolve its own schema.
  loader: {
    '.graphql': 'text',
  },
  // dockerode's transport dependency docker-modem EAGERLY requires ssh2
  // at module load (for its optional ssh://-scheme docker-host support,
  // which this service never uses -- platform/docker-client.ts's
  // createDockerClient() always talks to the default unix docker socket).
  // ssh2 itself eagerly requires cpu-features, a NATIVE .node addon
  // esbuild cannot bundle. Marking these merely `external` is NOT
  // enough: the SEA single-binary blob has no node_modules next to
  // it at runtime, so an eager unresolved require() would crash the ENTIRE
  // process at startup. Instead, alias `ssh2` to a tiny in-repo stub
  // (build/stubs/ssh2-stub.js) that satisfies docker-modem's eager
  // `require('ssh2').Client` shape without pulling in the native addon at
  // all -- the dead ssh transport code path stays dead, and the bundle is
  // fully self-contained (see build/stubs/ssh2-stub.js's module doc).
  alias: {
    ssh2: path.join(serviceRoot, 'build', 'stubs', 'ssh2-stub.js'),
  },
  // import.meta.url has no direct CJS equivalent; esbuild's own banner
  // injects a polyfill so any dependency using it at bundle time still
  // resolves correctly in the flattened CJS output.
  banner: {
    js: [
      'const { pathToFileURL: __importMetaUrlShimPathToFileURL } = require("node:url");',
      'if (typeof globalThis.__filename === "undefined") { globalThis.__filename = __filename; }',
    ].join('\n'),
  },
  define: {
    // Rewritten per-file by esbuild's own import.meta handling; this define
    // is a defensive fallback for any stray `import.meta.url` reference that
    // slips through a dependency's own bundling. `undefined` here is
    // deliberate: on hit, the shim below is exercised instead of crashing at
    // parse time when a plugin bundles ESM-flavoured code inline.
    'import.meta.url': 'undefined',
    // Service version baked in at build time (see serviceVersion above) so
    // health.ts never touches the filesystem for it at runtime.
    __COMPANION_SERVICE_VERSION__: JSON.stringify(serviceVersion),
  },
  minify: false,
  sourcemap: false,
  logLevel: 'info',
  metafile: true,
});

const outputEntry = Object.entries(result.metafile.outputs).find(([file]) =>
  file.endsWith('bundle.cjs'),
);
const bytes = outputEntry ? outputEntry[1].bytes : 0;

console.log(`bundle.mjs: wrote ${outfile} (${(bytes / 1024).toFixed(1)} KiB)`);
