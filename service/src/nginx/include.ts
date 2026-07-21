/**
 * nginx include-file content.
 *
 * Pure content builder -- no filesystem/process side effects live here, so
 * it's trivially unit-testable and reused by both the injection flow
 * (locations-append.ts + validated-reload.ts) and the self-heal monitor,
 * which all need to (re)generate the exact same bytes.
 *
 * Box-verified facts driving this shape: locations.conf is
 * included inside EVERY server block (HTTP + HTTPS, 3 occurrences), so one
 * location here is same-origin on every scheme/port the webgui serves. The
 * platform's own generated locations.conf already proxies WebSocket
 * upgrades the same way (ttyd webterminal/logterminal), so this pattern is
 * native to the box, not a novel one.
 */

export interface IncludeFileConfig {
  /** Loopback port the service binds (127.0.0.1 only). */
  readonly port: number;
}

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid nginx upstream port: ${port}`);
  }
}

/**
 * Builds the full content of the plugin-owned nginx include file: a single
 * `location /companion/graphql` block proxying to the localhost service,
 * with WebSocket upgrade support (subscriptions ride the same origin) and
 * `x-api-key` passthrough (auth is the service's job, not nginx's).
 */
export function buildIncludeFileContent(config: IncludeFileConfig): string {
  assertValidPort(config.port);

  return `# Managed by u-manager-companion. Do not edit by hand -- regenerated
# on every service startup and re-applied by the self-heal monitor.
location /companion/graphql {
    allow all;
    proxy_pass http://127.0.0.1:${config.port};
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header x-api-key $http_x_api_key;
}
`;
}
