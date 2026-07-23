/**
 * Central runtime configuration.
 *
 * Every real fs/nginx/socket path the startup sequence (startup.ts) and
 * server.ts need is resolved HERE, once, from environment overrides with
 * sensible defaults -- never hardcoded ad hoc at call sites.
 * Kept as plain data + one factory function (no class) so tests can construct
 * an independent CompanionConfig per test without any module-level mutable
 * state, matching the injectable pattern the rest of the service follows
 * (auth/keystore.ts's resolveKeyStoreDir(), server.ts's resolvePort()).
 *
 * nginx integration is TOGGLEABLE (nginxEnabled) so the service can start in
 * a "no nginx" mode for local/dev smoke tests off-box -- the real
 * paths under /etc/nginx and /usr/sbin/nginx would simply fail on darwin/CI,
 * and there is no reason a local capabilities-query smoke test should depend
 * on a real nginx installation being present.
 */

/** Real nginx paths on Unraid: locations.conf is GENERATED
 * by /etc/rc.d/rc.nginx and included inside every server block; nginx itself
 * is directly usable at /usr/sbin/nginx for -t/-s reload. */
const DEFAULT_LOCATIONS_CONF_PATH = '/etc/nginx/conf.d/locations.conf';
const DEFAULT_NGINX_BINARY_PATH = '/usr/sbin/nginx';

/** Plugin-owned paths under /boot (flash); our own include file lives
 * alongside the rest of the plugin's on-flash assets. */
const DEFAULT_PLUGIN_BOOT_DIR = '/boot/config/plugins/u-manager-companion';
const DEFAULT_INCLUDE_PATH = `${DEFAULT_PLUGIN_BOOT_DIR}/nginx/companion-graphql.conf`;

/** Runtime working directory on rootfs (RAM) -- audit log
 * and any other run-time-only state lives here, distinct from the /boot
 * persisted assets above. */
const DEFAULT_RUN_DIR = '/usr/local/emhttp/plugins/u-manager-companion/service';

/** Loopback-only bind port for the GraphQL service itself (127.0.0.1 only,
 * nginx proxies /companion/graphql to this port). */
const DEFAULT_SERVICE_PORT = 34400;

/** Production unix socket path for the local unraid-api's own GraphQL
 * endpoint -- MUST match auth/identity.ts's DEFAULT_LOCAL_API_SOCKET_PATH
 * exactly (kept as a duplicated literal rather than a cross-module import so
 * config.ts stays free of a dependency on the auth module; both point at the
 * same path and are covered by server.test.ts's auth smoke tests). */
const DEFAULT_LOCAL_API_SOCKET_PATH = '/var/run/unraid-api.sock';

/** Unraid's own update-status cache (local!=remote digest pairs) -- the
 * source of truth `readUpdatableTargets()`/`listUpdatableContainerNames()`
 * reads AND the file `syncUpdateStatusForRepo()` (docker_update/update.ts)
 * rewrites after a successful update so the "update available" badge
 * clears. */
const DEFAULT_UPDATE_STATUS_PATH = '/var/lib/docker/unraid-update-status.json';

/** Unraid webui's per-container info cache (dynamix.docker.manager) --
 * DockerTemplates::getAllInfo() short-circuits on this cached `updated`
 * flag without re-checking the JSON above unless reload=true, so
 * syncUpdateStatusForRepo() must patch this file too. */
const DEFAULT_DOCKER_WEBUI_INFO_PATH =
  '/usr/local/emhttp/state/plugins/dynamix.docker.manager/docker.json';

export interface CompanionConfig {
  /** Loopback-only port the Apollo/graphql-ws server binds. */
  readonly servicePort: number;
  /** On-disk API key-store directory (auth/keystore.ts). */
  readonly keyStoreDir: string;
  /** Local unraid-api GraphQL endpoint for the `{ me }` fallback probe
   * (tcp transport). UNDEFINED by default -- the production
   * default is the UNIX SOCKET transport in
   * auth/identity.ts, not this tcp URL. Only set (via COMPANION_LOCAL_API_URL)
   * for dev environments where unraid-api listens on tcp instead (e.g.
   * `.env.development`'s port 3001). When undefined, localApiSocketPath is
   * used instead. */
  readonly localApiUrl: string | undefined;
  /** Local unraid-api unix socket path (production default
   * transport). Only consulted when localApiUrl is
   * undefined -- mirrors auth/identity.ts's own resolveIdentityViaMeFallback
   * priority (explicit tcp URL wins if present, socket otherwise). */
  readonly localApiSocketPath: string;
  /** Whether the nginx same-origin integration (include + self-heal) runs
   * at all. False in local/dev/test "no nginx" mode. */
  readonly nginxEnabled: boolean;
  /** Platform-generated locations.conf the service appends its include line
   * to (nginx/locations-append.ts, self-heal-monitor.ts). */
  readonly locationsConfPath: string;
  /** Absolute path to our plugin-owned nginx include file. */
  readonly includePath: string;
  /** Path to the real nginx binary, used for `-t`/`-s reload`. */
  readonly nginxBinaryPath: string;
  /** Service run-dir on rootfs -- audit log lives at `<runDir>/audit.log`. */
  readonly runDir: string;
  /** Unraid's update-status cache path (docker_update/update.ts's
   * syncUpdateStatusForRepo() + server.ts's listUpdatableContainerNames()). */
  readonly dockerUpdateStatusPath: string;
  /** Unraid webui's docker-info cache path (docker_update/update.ts's
   * syncUpdateStatusForRepo()). */
  readonly dockerWebuiInfoPath: string;
}

/** Parses a boolean-ish env value ('1'/'true' => true, anything else => the
 * provided default). Kept permissive (case-insensitive, trims whitespace)
 * since this is operator-facing plugin/env configuration, not user input. */
function parseBooleanEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  const normalised = raw.trim().toLowerCase();
  if (normalised === '1' || normalised === 'true') return true;
  if (normalised === '0' || normalised === 'false') return false;
  return defaultValue;
}

function parsePortEnv(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid COMPANION_SERVICE_PORT: ${raw}`);
  }
  return parsed;
}

/**
 * Resolves the full runtime config from environment overrides + defaults.
 * Called once at service startup (startup.ts); every module that
 * needs a real path receives it from the resulting CompanionConfig object
 * rather than re-reading process.env itself, EXCEPT the modules that already
 * have their own resolve*() default-env pattern
 * (auth/keystore.ts's resolveKeyStoreDir(), auth/identity.ts's
 * resolveDefaultLocalApiUrl()) -- resolveCompanionConfig() defers to those
 * existing resolvers for keyStoreDir/localApiUrl so there is exactly ONE
 * source of truth per path, not two independently-drifting env readers.
 */
export function resolveCompanionConfig(env: NodeJS.ProcessEnv = process.env): CompanionConfig {
  return {
    servicePort: parsePortEnv(env['COMPANION_SERVICE_PORT'], DEFAULT_SERVICE_PORT),
    keyStoreDir: env['COMPANION_KEYSTORE_DIR'] ?? '/boot/config/plugins/dynamix.my.servers/keys',
    localApiUrl: env['COMPANION_LOCAL_API_URL'],
    localApiSocketPath: env['COMPANION_LOCAL_API_SOCKET'] ?? DEFAULT_LOCAL_API_SOCKET_PATH,
    nginxEnabled: parseBooleanEnv(env['COMPANION_NGINX_ENABLED'], true),
    locationsConfPath: env['COMPANION_LOCATIONS_CONF_PATH'] ?? DEFAULT_LOCATIONS_CONF_PATH,
    includePath: env['COMPANION_INCLUDE_PATH'] ?? DEFAULT_INCLUDE_PATH,
    nginxBinaryPath: env['COMPANION_NGINX_BINARY_PATH'] ?? DEFAULT_NGINX_BINARY_PATH,
    runDir: env['COMPANION_RUN_DIR'] ?? DEFAULT_RUN_DIR,
    dockerUpdateStatusPath: env['COMPANION_UPDATE_STATUS_PATH'] ?? DEFAULT_UPDATE_STATUS_PATH,
    dockerWebuiInfoPath: env['COMPANION_DOCKER_WEBUI_INFO_PATH'] ?? DEFAULT_DOCKER_WEBUI_INFO_PATH,
  };
}
