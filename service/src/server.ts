/**
 * Companion service entry point.
 *
 * Wires everything the earlier pieces produced into one running process:
 *
 *   - @apollo/server v5 (`ApolloServer` + `executeHTTPGraphQLRequest`, the
 *     same public low-level API `startStandaloneServer` itself is built on
 *     -- used directly here, NOT `startStandaloneServer`, because that
 *     helper creates its OWN `http.Server` internally and gives no way to
 *     attach a `graphql-ws` WebSocket upgrade handler to the SAME server.
 *     Same-origin HTTP + WS on one loopback port requires owning the
 *     `http.Server` ourselves.
 *   - `graphql-ws`'s `useServer` (implements the `graphql-transport-ws`
 *     subprotocol -- exact match to the app's `graphql_flutter` client)
 *     mounted on a `ws.WebSocketServer` attached to the SAME
 *     `http.Server`'s `upgrade` event.
 *   - `context.ts`'s auth pipeline for both transports: HTTP via the
 *     `x-api-key` header per request; WS via the `connection_init` payload,
 *     resolved ONCE per socket in `onConnect` (WS auth is connection-level,
 *     not per-message).
 *   - `resolvers.ts` bound to the SDL loaded from `schema/schema.graphql`.
 *
 * SDL loading + bundling: the SDL is READ FROM src/schema/schema.graphql via
 * `readFileSync` at import time during development/tests (this file lives
 * one directory above schema/schema.graphql). For the esbuild-bundled/SEA
 * path, esbuild's `loader: { '.graphql': 'text' }` (see build/bundle.mjs)
 * inlines the file's CONTENT as a string constant into the single
 * bundle.cjs at build time -- so the single-binary artifact never needs to
 * locate a sibling file on disk at runtime (which would break once bundled
 * into the SEA blob's opaque single-file layout). Both paths resolve to the
 * exact same string; the `.graphql` extension's text-loader is what makes
 * esbuild treat the import as inlineable content instead of trying to parse
 * it as JS.
 *
 * The one behavior that MUST hold regardless of anything else, because it's
 * a hard security requirement: the service binds to 127.0.0.1 only, never
 * 0.0.0.0 or a LAN-facing interface.
 */
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { ApolloServer, HeaderMap } from '@apollo/server';
import { unwrapResolverError } from '@apollo/server/errors';
import { makeExecutableSchema } from '@graphql-tools/schema';
import type { IResolvers } from '@graphql-tools/utils';
// @ts-expect-error -- .graphql has no type declaration; esbuild's text loader
// (build/bundle.mjs) inlines its content as a string at bundle time, and
// ts-node/vitest resolve it via tsconfig's resolveJsonModule-adjacent raw
// import handled by the custom loader below in dev/test (see importSdl()).
import schemaGraphqlSourceText from './schema/schema.graphql';
import { useServer } from 'graphql-ws/lib/use/ws';
import { WebSocketServer, type WebSocket } from 'ws';

import { resolvers, type GraphqlContext, type FeatureModuleDeps } from './resolvers.js';
import {
  createContextCache,
  extractKeyFromHttpHeaders,
  extractKeyFromConnectionInitPayload,
  resolveAuthContext,
  toHttpAuthError,
  toWsConnectionInitCloseReason,
  AuthenticationError,
  PermissionError,
  WS_CONNECTION_INIT_UNAUTHORIZED_CODE,
  type ResolveAuthContextOptions,
} from './context.js';
import { resolveIdentityViaMeFallback } from './auth/identity.js';
import { resolveCompanionConfig, type CompanionConfig } from './platform/config.js';
import { runNginxStartupSequence } from './startup.js';
import { createAuditLogger, type AuditLogger } from './audit.js';
import { createDockerClient } from './platform/docker-client.js';
import { runStreamedProcess, runDetachedProcess } from './platform/process-runner.js';
import { installDockerTemplate } from './features/docker_template/install.js';
import { editDockerTemplate } from './features/docker_template/edit.js';
import { deleteDockerTemplate } from './features/docker_template/delete.js';
import { readDockerTemplate } from './features/docker_template/read-template.js';
import { updateContainerStream, updateAllContainersStream } from './features/docker_update/update.js';
import { checkForDockerUpdates } from './features/docker_update/check-updates.js';
import { shutdownServer, rebootServer, sleepServer } from './features/power/power.js';
import { uninstallPlugin } from './features/plugins/uninstall.js';
import { checkForPluginUpdates } from './features/plugins/check-updates.js';
import { listInstalledPluginsDetailed } from './features/plugins/list-installed-detailed.js';
import { createPluginManifestClient } from './features/plugins/platform.js';
import {
  createShare,
  deleteShare,
  getShareIsEmpty,
  getShareSecurity,
  getShareSecurityUsers,
  listShares,
  updateShare,
  updateShareAccess,
  updateShareSecurity,
} from './features/shares/resolvers.js';
import { createEmhttpdClient } from './features/shares/platform.js';
import { existsSync, promises as fsPromises } from 'node:fs';
import path from 'node:path';

const HOST = '127.0.0.1';

// Re-exported so callers (tests, the bundled CJS entry) can build a
// CompanionConfig without importing platform/config.js as a separate module
// specifier -- convenient for the bundle-pipeline smoke test, which only has
// `require(bundleOut)` (the flattened single-file entry) to work with.
export { resolveCompanionConfig };

/**
 * Builds the executable GraphQL schema from the SDL text + resolvers.ts's
 * resolver map. `@graphql-tools/schema`'s `makeExecutableSchema` is used
 * instead of `buildSchema` + manual field assignment because it accepts the
 * resolver map SHAPE resolvers.ts already exports (nested per-type resolver
 * objects) directly.
 */
function buildExecutableSchema() {
  return makeExecutableSchema({
    typeDefs: schemaGraphqlSourceText as unknown as string,
    // resolvers.ts's map is intentionally typed narrowly against
    // GraphqlContext for call-site safety; makeExecutableSchema's own typing
    // is deliberately broad (any valid GraphQL resolver map shape), so a
    // structural cast is required at this single seam.
    resolvers: resolvers as unknown as IResolvers,
  });
}

/** Injectable template-file writer -- production wiring shells to
 * fs/promises writeFile after ensuring the templates-user directory exists.
 * Shared by installDockerTemplate + editDockerTemplate (both accept the
 * same WriteTemplateFile shape per their module docs). */
async function writeTemplateFile(templatesUserDir: string, name: string, xmlContent: string): Promise<void> {
  await fsPromises.mkdir(templatesUserDir, { recursive: true });
  await fsPromises.writeFile(path.join(templatesUserDir, `my-${name}.xml`), xmlContent, 'utf8');
}

/** Injectable template-file reader for readDockerTemplate -- matches the
 * ReadTemplateFile contract's ENOENT-on-missing requirement (fs/promises'
 * own readFile already rejects with a Node-shaped {code:'ENOENT'} error, so
 * no adaptation is needed beyond the direct call). */
async function readTemplateFile(filePath: string): Promise<string> {
  return fsPromises.readFile(filePath, 'utf8');
}

/** Injectable existence check for the S3 Sleep plugin's script, used by
 * sleepServer's SleepServerDeps.sleepScriptExists. */
function sleepScriptExists(scriptPath: string): boolean {
  return existsSync(scriptPath);
}

const TEMPLATES_USER_DIR = '/boot/config/plugins/dockerMan/templates-user';
const S3_SLEEP_SCRIPT = '/usr/local/emhttp/plugins/dynamix.s3.sleep/scripts/rc.s3sleep';

/**
 * Reads "every container with an available update" from Unraid's own
 * update-status cache (see update.ts module doc for the digest-pair
 * format). Kept deliberately tolerant of a missing/malformed cache file:
 * an empty or unreadable status file means "no known updates," not a
 * hard failure.
 */
async function listUpdatableContainerNames(): Promise<readonly string[]> {
  const statusPath = '/var/lib/docker/unraid-update-status.json';
  try {
    const raw = await fsPromises.readFile(statusPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return [];
    // Shape: { [containerName]: { local: string, remote: string } } --
    // updatable when local !== remote. Any entry that doesn't fit this
    // shape is skipped rather than throwing, so one malformed entry never
    // blocks every other one.
    const entries = Object.entries(parsed as Record<string, unknown>);
    const updatable: string[] = [];
    for (const [name, value] of entries) {
      if (
        value &&
        typeof value === 'object' &&
        'local' in value &&
        'remote' in value &&
        (value as { local: unknown }).local !== (value as { remote: unknown }).remote
      ) {
        updatable.push(name);
      }
    }
    return updatable;
  } catch {
    return [];
  }
}

/**
 * Builds the real (production) FeatureModuleDeps -- every feature module
 * wired to its real platform dependency (dockerode, execa, fs), matching
 * each module's own exported Deps interface exactly. `caller` is bound
 * PER-REQUEST (from the resolved identity), so this factory is called once
 * per GraphQL context, not once at process startup -- the returned object
 * closes over the presented request's `caller`.
 */
function buildFeatureModuleDeps(config: CompanionConfig, audit: AuditLogger, caller: { id: string; name: string }): FeatureModuleDeps {
  const dockerClient = createDockerClient();
  const writeTemplate = (name: string, xmlContent: string) =>
    writeTemplateFile(TEMPLATES_USER_DIR, name, xmlContent);
  // createEmhttpdClient() with no args wires the default (native
  // shares.ini parse) getShares -- see platform.ts's module doc.
  const sharesClient = createEmhttpdClient();
  const pluginManifestClient = createPluginManifestClient();

  return {
    installDockerTemplate: (input) =>
      installDockerTemplate(input, {
        dockerClient,
        runRebuildContainer: runStreamedProcess,
        writeTemplateFile: writeTemplate,
        audit,
        caller,
      }),
    editDockerTemplate: (input) =>
      editDockerTemplate(input, {
        dockerClient,
        runRebuildContainer: runStreamedProcess,
        writeTemplateFile: writeTemplate,
        audit,
        caller,
      }),
    deleteDockerTemplate: (name, removeContainer, removeImage) =>
      deleteDockerTemplate(name, removeContainer, removeImage, { dockerClient, audit, caller }),
    readDockerTemplate: (name) => readDockerTemplate(name, { readTemplateFile }),
    updateContainerStream: (idOrName) =>
      updateContainerStream(idOrName, {
        dockerClient,
        runRebuildContainer: runStreamedProcess,
        audit,
        caller,
        updateStatusPath: config.dockerUpdateStatusPath,
        dockerWebuiInfoPath: config.dockerWebuiInfoPath,
      }),
    updateAllContainersStream: () =>
      updateAllContainersStream({
        dockerClient,
        runRebuildContainer: runStreamedProcess,
        audit,
        caller,
        listUpdatableContainerNames,
        updateStatusPath: config.dockerUpdateStatusPath,
        dockerWebuiInfoPath: config.dockerWebuiInfoPath,
      }),
    checkForDockerUpdates: () =>
      checkForDockerUpdates({ runDockerUpdateScript: runStreamedProcess, audit, caller }),
    shutdownServer: () => shutdownServer({ runDetached: runDetachedProcess, audit, caller }),
    rebootServer: () => rebootServer({ runDetached: runDetachedProcess, audit, caller }),
    sleepServer: () =>
      sleepServer({
        runDetached: runDetachedProcess,
        audit,
        caller,
        sleepScriptExists: () => sleepScriptExists(S3_SLEEP_SCRIPT),
      }),
    uninstallPlugin: (filename) =>
      uninstallPlugin(filename, { runPluginCli: runStreamedProcess, audit, caller }),
    checkForPluginUpdates: () => checkForPluginUpdates({ runDetached: runDetachedProcess, audit }),
    listShares: () => listShares({ client: sharesClient }),
    getShareSecurity: (name) => getShareSecurity(name, { client: sharesClient }),
    getShareSecurityUsers: () => getShareSecurityUsers({ client: sharesClient }),
    getShareIsEmpty: (name) => getShareIsEmpty(name, { client: sharesClient }),
    createShare: (name, settings) => createShare(name, settings, { client: sharesClient, audit, caller }),
    updateShare: (name, settings) => updateShare(name, settings, { client: sharesClient, audit, caller }),
    deleteShare: (name) => deleteShare(name, { client: sharesClient, audit, caller }),
    updateShareSecurity: (name, settings) =>
      updateShareSecurity(name, settings, { client: sharesClient, audit, caller }),
    updateShareAccess: (name, access) =>
      updateShareAccess(name, access, { client: sharesClient, audit, caller }),
    listInstalledPluginsDetailed: () =>
      listInstalledPluginsDetailed({ client: pluginManifestClient }),
  };
}

/**
 * Builds the ResolveAuthContextOptions bound to the REAL config for this
 * process: the configured key-store directory (config.keyStoreDir) and the
 * `{ me }` fallback bound to config.localApiUrl/config.localApiSocketPath
 * (identity.ts's own tcp-url-first, unix-socket-otherwise priority, verified
 * live on box) -- without this, both resolveAuthContext() call sites below
 * would silently fall back to context.ts's own env-read defaults
 * (resolveKeyStoreDir()) instead of the config this specific server instance
 * was started with, which breaks every test/dev invocation that passes a
 * config with overridden paths.
 */
function buildAuthContextOptions(
  config: CompanionConfig,
  cache: ReturnType<typeof createContextCache>,
): ResolveAuthContextOptions {
  return {
    cache,
    keyStoreDir: config.keyStoreDir,
    meFallback: (presentedKey) =>
      resolveIdentityViaMeFallback(presentedKey, {
        // exactOptionalPropertyTypes forbids assigning `undefined` directly
        // to an optional property -- omit the key entirely when
        // config.localApiUrl is unset (the verified-live unix-socket default
        // path) rather than passing `localApiUrl: undefined`.
        ...(config.localApiUrl !== undefined ? { localApiUrl: config.localApiUrl } : {}),
        localApiSocketPath: config.localApiSocketPath,
      }),
  };
}

export interface StartServerOptions {
  readonly port?: number;
  readonly config?: CompanionConfig;
}

export interface CompanionServer {
  readonly httpServer: HttpServer;
  /** Stops the WS server, the self-heal monitor (if running), and the
   * underlying HTTP server, in that order -- used by tests and a future
   * graceful-shutdown hook. */
  close(): Promise<void>;
}

/**
 * Starts the full companion service: Apollo Server v5 (HTTP) + graphql-ws
 * (WS) on ONE `http.Server` bound to 127.0.0.1 only, after running the nginx
 * startup sequence (crash-recovery -> ensure-include + validated reload ->
 * self-heal monitor, or a no-op when nginx integration is disabled).
 */
export async function startServer(options: StartServerOptions = {}): Promise<CompanionServer> {
  const config = options.config ?? resolveCompanionConfig();
  const port = options.port ?? config.servicePort;

  const schema = buildExecutableSchema();
  const apollo = new ApolloServer<GraphqlContext>({
    schema,
    // Never leak Node stacktraces in error responses (clean, GraphQL-
    // standard errors). Apollo includes them by default unless
    // NODE_ENV=production; we set it explicitly so the behaviour does not
    // depend on how the supervisor launches the process.
    includeStacktraceInErrorResponses: false,
    // Map our auth/permission errors thrown INSIDE resolvers to stable
    // GraphQL error codes. Without this, a resolver-thrown PermissionError is
    // wrapped by Apollo as INTERNAL_SERVER_ERROR (verified live on box), which
    // both misreports a 403-class denial as a 500 and hides the real reason.
    // unwrapResolverError() reaches the original error through Apollo's
    // GraphQLError wrapper.
    formatError: (formattedError, error) => {
      const original = unwrapResolverError(error);
      if (original instanceof PermissionError) {
        return { message: original.message, extensions: { code: 'FORBIDDEN' } };
      }
      if (original instanceof AuthenticationError) {
        return { message: original.message, extensions: { code: 'UNAUTHENTICATED' } };
      }
      return formattedError;
    },
  });
  await apollo.start();

  const cache = createContextCache();
  const audit = createAuditLogger({ logPath: path.join(config.runDir, 'audit.log') });

  const httpServer = createServer((req, res) => {
    void handleHttpRequest(req, res, apollo, config, cache, audit);
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  const wsDisposable = useServer<Record<string, unknown>>(
    {
      schema,
      context: async (ctx): Promise<GraphqlContext> => {
        // Per-operation context (WS per-operation path): reuses the
        // identity resolved once at connection_init time, stashed on
        // ctx.extra by onConnect below -- WS auth is connection-level, not
        // re-resolved per message.
        const identity = (ctx.extra as { identity?: GraphqlContext['identity'] }).identity;
        if (!identity) {
          // Should be unreachable: onConnect rejects before a socket with
          // no identity can ever reach an operation. Defensive fail-closed
          // per-operation error rather than a crash.
          throw new AuthenticationError('No identity resolved for this connection');
        }
        return { identity, deps: buildFeatureModuleDeps(config, audit, identity) };
      },
      onConnect: async (ctx) => {
        const presentedKey = extractKeyFromConnectionInitPayload(ctx.connectionParams);
        try {
          const identity = await resolveAuthContext(presentedKey, buildAuthContextOptions(config, cache));
          // Stash the resolved identity on `extra` (the raw ws socket +
          // upgrade request) so the `context` factory above can read it back
          // per-operation without re-resolving auth on every subscribe.
          (ctx.extra as { identity?: GraphqlContext['identity'] }).identity = identity;
          return true;
        } catch (error) {
          if (error instanceof AuthenticationError) {
            const { reason } = toWsConnectionInitCloseReason(error);
            const socket = ctx.extra.socket as WebSocket;
            socket.close(WS_CONNECTION_INIT_UNAUTHORIZED_CODE, reason);
            return false;
          }
          throw error;
        }
      },
    },
    wss,
  );

  const nginxMonitor = await runNginxStartupSequence(config);

  await new Promise<void>((resolve) => httpServer.listen(port, HOST, resolve));

  return {
    httpServer,
    async close(): Promise<void> {
      nginxMonitor.close();
      await wsDisposable.dispose();
      wss.close();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

/**
 * Handles a single HTTP request: resolves auth from the `x-api-key` header,
 * then delegates to Apollo's low-level `executeHTTPGraphQLRequest` (the same
 * public API `startStandaloneServer` itself calls internally -- see module
 * doc for why we can't use that helper directly here).
 */
async function handleHttpRequest(
  req: IncomingMessage,
  res: import('node:http').ServerResponse,
  apollo: ApolloServer<GraphqlContext>,
  config: CompanionConfig,
  cache: ReturnType<typeof createContextCache>,
  audit: AuditLogger,
): Promise<void> {
  try {
    const body = await readJsonBody(req);
    // Optional access logging, gated behind COMPANION_ACCESS_LOG (off by
    // default -- never logs in the shipped configuration). Used to verify,
    // end-to-end, that the mobile app actually reaches the service through
    // nginx. Logs method + a short operation snippet + whether a key was
    // presented; never logs the key value itself.
    if (process.env['COMPANION_ACCESS_LOG'] === '1') {
      const snippet =
        typeof (body as { query?: unknown })?.query === 'string'
          ? (body as { query: string }).query.replace(/\s+/g, ' ').slice(0, 80)
          : '(no query)';
      const hasKey = Boolean(req.headers['x-api-key']);
      process.stderr.write(
        `[access] ${req.method ?? '?'} ${req.url ?? '?'} key=${hasKey} op="${snippet}"\n`,
      );
    }
    const headers = new HeaderMap();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
    }

    const presentedKey = extractKeyFromHttpHeaders(req.headers as Record<string, string | undefined>);

    let identity: GraphqlContext['identity'];
    try {
      identity = await resolveAuthContext(presentedKey, buildAuthContextOptions(config, cache));
    } catch (error) {
      if (error instanceof AuthenticationError || error instanceof PermissionError) {
        writeGraphqlErrorResponse(res, toHttpAuthError(error));
        return;
      }
      throw error;
    }

    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const httpGraphQLResponse = await apollo.executeHTTPGraphQLRequest({
      httpGraphQLRequest: {
        method: (req.method ?? 'GET').toUpperCase(),
        headers,
        search: url.search,
        body,
      },
      context: async () => ({
        identity,
        deps: buildFeatureModuleDeps(config, audit, identity),
      }),
    });

    for (const [key, value] of httpGraphQLResponse.headers) {
      res.setHeader(key, value);
    }
    res.statusCode = httpGraphQLResponse.status ?? 200;

    if (httpGraphQLResponse.body.kind === 'complete') {
      res.end(httpGraphQLResponse.body.string);
      return;
    }
    for await (const chunk of httpGraphQLResponse.body.asyncIterator) {
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ errors: [{ message: error instanceof Error ? error.message : 'Internal error' }] }));
  }
}

/** Writes a single GraphQL-standard error response body (used for the
 * pre-Apollo auth-rejection path). */
function writeGraphqlErrorResponse(res: import('node:http').ServerResponse, error: import('graphql').GraphQLError): void {
  res.statusCode = 200; // GraphQL-standard: auth errors ride a 200 with an errors[] body, matching Apollo's own convention.
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ errors: [{ message: error.message, extensions: error.extensions }] }));
}

/** Reads + JSON-parses the request body. Returns undefined for a GET (no
 * body expected). Bounded by no explicit size limit here -- companion
 * mutation payloads (docker template installs, etc.) are small structured
 * JSON, never file uploads. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET') return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on('error', reject);
  });
}

// Only auto-start when this module is the process entry point (not when
// imported by tests or, later, by other modules).
if (require.main === module) {
  startServer().catch((error: unknown) => {
    // eslint-disable-next-line no-console -- startup failure, no logger module wired at this point
    console.error('Failed to start u-manager-companion service:', error);
    process.exitCode = 1;
  });
}
