/**
 * Bundle-time stub for the `ssh2` package.
 *
 * `dockerode`'s transport dependency `docker-modem` EAGERLY `require()`s
 * `ssh2` at module load (`docker-modem/lib/modem.js`'s top-level
 * `ssh = require('./ssh')` -> `docker-modem/lib/ssh.js`'s
 * `require('ssh2').Client`), purely to support an OPTIONAL ssh://-scheme
 * docker-host transport this service never uses
 * (platform/docker-client.ts's createDockerClient() always talks to the
 * default unix docker socket, never an ssh host). `ssh2` itself eagerly
 * requires `cpu-features`, a NATIVE `.node` addon esbuild cannot bundle
 * into a single CJS file -- esbuild cannot bundle native addons, so any
 * feature needing one has to shell out to a platform CLI instead.
 *
 * Marking `ssh2` merely `external` in esbuild is NOT sufficient: the SEA
 * single-binary blob has no `node_modules/ssh2` on disk next to it at
 * runtime, so an eager `require('ssh2')` at module load would crash the
 * ENTIRE process at startup with MODULE_NOT_FOUND -- before a single
 * request is ever served -- even though nothing in this service's actual
 * code path ever touches ssh transport.
 *
 * This stub is aliased in for `ssh2` at bundle time (build/bundle.mjs's
 * `alias` option) instead: it provides the minimal `{ Client }` shape
 * `docker-modem/lib/ssh.js` destructures, so the eager require succeeds
 * with a dead, never-invoked class -- no native addon, no runtime
 * filesystem dependency, dead code stays dead.
 */
class StubSsh2ClientNeverUsedByThisService {
  constructor() {
    throw new Error(
      'u-manager-companion service: ssh:// docker-host transport is not supported ' +
        '(only the default unix docker socket is used). This stub should never be ' +
        'instantiated -- if you see this error, an ssh-scheme DOCKER_HOST was configured.',
    );
  }
}

module.exports = { Client: StubSsh2ClientNeverUsedByThisService };
