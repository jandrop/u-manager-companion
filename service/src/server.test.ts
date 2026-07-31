/**
 * Server wiring smoke tests -- Apollo Server v5 standalone HTTP +
 * graphql-ws WS on ONE loopback-only http.Server.
 *
 * "Local smoke test (no live box)": everything here runs against a temp-dir
 * stub filesystem (temp key store, nginx integration disabled via config)
 * -- no real box paths, no real nginx binary, no real docker socket (auth
 * succeeds via the key store fixture; nothing here exercises a privileged
 * mutation end-to-end, which is covered separately on the live box).
 *
 * Also covers listUpdatableContainerNames, the update-all target resolver
 * wired into buildFeatureModuleDeps: it maps the update-status file's image
 * repo:tag keys onto container names, which is the seam that broke
 * update-all in production.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { listUpdatableContainerNames, startServer, type CompanionServer } from './server.js';
import { resolveCompanionConfig, type CompanionConfig } from './platform/config.js';
import type { DockerClient, DockerContainerListEntry } from './platform/docker-client.js';

/** Finds a free TCP port by letting the OS assign one, then releasing it. */
async function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Failed to resolve ephemeral port'));
        return;
      }
      const { port } = address;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

let dir: string;
let keyStoreDir: string;
let running: CompanionServer | undefined;

const ADMIN_KEY = 'admin-key-value';

function writeAdminKeyFile(): void {
  writeFileSync(
    path.join(keyStoreDir, '11111111-1111-1111-1111-111111111111.json'),
    JSON.stringify({
      createdAt: '2026-01-01T00:00:00.000Z',
      id: '11111111-1111-1111-1111-111111111111',
      key: ADMIN_KEY,
      name: 'admin-key',
      permissions: [],
      roles: ['ADMIN'],
    }),
  );
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'companion-server-'));
  keyStoreDir = path.join(dir, 'keys');
  mkdirSync(keyStoreDir, { recursive: true });
  writeAdminKeyFile();
});

afterEach(async () => {
  if (running) {
    await running.close();
    running = undefined;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function startTestServer(overrides: Partial<Record<string, string>> = {}): Promise<{
  server: CompanionServer;
  config: CompanionConfig;
  port: number;
}> {
  const port = await getEphemeralPort();
  const config = resolveCompanionConfig({
    COMPANION_SERVICE_PORT: String(port),
    COMPANION_KEYSTORE_DIR: keyStoreDir,
    COMPANION_NGINX_ENABLED: 'false',
    COMPANION_LOCAL_API_SOCKET: path.join(dir, 'no-such.sock'),
    COMPANION_RUN_DIR: dir,
    ...overrides,
  });
  const server = await startServer({ config });
  running = server;
  return { server, config, port };
}

describe('startServer -- bind + transport', () => {
  it('binds to 127.0.0.1 only, never 0.0.0.0 or a LAN-facing interface', async () => {
    const { server } = await startTestServer();
    const address = server.httpServer.address();
    expect(address).not.toBeNull();
    if (address && typeof address !== 'string') {
      expect(address.address).toBe('127.0.0.1');
      expect(address.address).not.toBe('0.0.0.0');
    }
  });
});

describe('startServer -- HTTP capabilities smoke test', () => {
  it('serves a capabilities query and returns the expected shape', async () => {
    const { port } = await startTestServer();

    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ADMIN_KEY },
      body: JSON.stringify({ query: '{ capabilities { schemaVersion serviceVersion features } }' }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data?: { capabilities?: { schemaVersion: string; serviceVersion: string; features: string[] } };
    };
    expect(payload.data?.capabilities?.schemaVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Array.isArray(payload.data?.capabilities?.features)).toBe(true);
    expect(payload.data?.capabilities?.features.length).toBeGreaterThan(0);
  });

  it('rejects an HTTP request with no api key as a GraphQL-standard UNAUTHENTICATED error', async () => {
    const { port } = await startTestServer();

    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ capabilities { schemaVersion } }' }),
    });

    const payload = (await response.json()) as { errors?: Array<{ extensions?: { code?: string } }> };
    expect(payload.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });

  it('maps a resolver PermissionError to a clean FORBIDDEN error with no stacktrace', async () => {
    // A VIEWER (read-only) key authenticates but is not authorised for a
    // privileged operation. The denial must surface as FORBIDDEN, not a
    // stacktrace-leaking INTERNAL_SERVER_ERROR (Bug C, found live on box).
    writeFileSync(
      path.join(keyStoreDir, '22222222-2222-2222-2222-222222222222.json'),
      JSON.stringify({
        createdAt: '2026-01-01T00:00:00.000Z',
        id: '22222222-2222-2222-2222-222222222222',
        key: 'viewer-key-value',
        name: 'viewer-key',
        permissions: [],
        roles: ['VIEWER'],
      }),
    );
    const { port } = await startTestServer();

    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'viewer-key-value' },
      body: JSON.stringify({ query: 'mutation { unraidPlugins { checkForUpdates } }' }),
    });

    const payload = (await response.json()) as {
      errors?: Array<{ extensions?: Record<string, unknown> }>;
    };
    expect(payload.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(payload.errors?.[0]?.extensions).not.toHaveProperty('stacktrace');
  });

  it('rejects an HTTP request with an unrecognised api key as UNAUTHENTICATED', async () => {
    const { port } = await startTestServer();

    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'not-a-real-key' },
      body: JSON.stringify({ query: '{ capabilities { schemaVersion } }' }),
    });

    const payload = (await response.json()) as { errors?: Array<{ extensions?: { code?: string } }> };
    expect(payload.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });
});

describe('startServer -- WS connection_init auth smoke test', () => {
  it('accepts connection_init with a valid api key', async () => {
    const { port } = await startTestServer();

    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, 'graphql-transport-ws');
    const opened = new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'connection_init', payload: { 'x-api-key': ADMIN_KEY } }));
      });
      ws.once('message', (data: Buffer) => {
        const message = JSON.parse(data.toString()) as { type: string };
        if (message.type === 'connection_ack') {
          resolve();
        } else {
          reject(new Error(`Unexpected message type: ${message.type}`));
        }
      });
      ws.once('error', reject);
      ws.once('close', (code) => reject(new Error(`Socket closed unexpectedly with code ${code}`)));
    });

    await opened;
    ws.close();
  });

  it('closes with 4401 when connection_init carries an invalid api key', async () => {
    const { port } = await startTestServer();

    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, 'graphql-transport-ws');
    const closeCode = await new Promise<number>((resolve, reject) => {
      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'connection_init', payload: { 'x-api-key': 'bogus-key' } }));
      });
      ws.once('close', (code) => resolve(code));
      ws.once('error', reject);
    });

    expect(closeCode).toBe(4401);
  });

  it('closes with 4401 when connection_init carries no api key at all', async () => {
    const { port } = await startTestServer();

    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, 'graphql-transport-ws');
    const closeCode = await new Promise<number>((resolve, reject) => {
      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'connection_init', payload: {} }));
      });
      ws.once('close', (code) => resolve(code));
      ws.once('error', reject);
    });

    expect(closeCode).toBe(4401);
  });
});

describe('startServer -- invalid port env', () => {
  it('rejects an invalid COMPANION_SERVICE_PORT env value', () => {
    expect(() => resolveCompanionConfig({ COMPANION_SERVICE_PORT: 'not-a-port' })).toThrow(
      /Invalid COMPANION_SERVICE_PORT/,
    );
  });
});

/** Nothing in listUpdatableContainerNames touches docker beyond
 * listContainers, so the rest of the DockerClient surface is a hard failure
 * rather than a silent no-op. */
function unusedDockerCall(): never {
  throw new Error('Not reachable from listUpdatableContainerNames');
}

function makeDockerClientStub(listContainers: DockerClient['listContainers']): DockerClient {
  return {
    getContainer: unusedDockerCall,
    getImage: unusedDockerCall,
    pull: unusedDockerCall,
    pruneVolumes: unusedDockerCall,
    listContainers,
  };
}

function makeContainerListStub(
  containers: readonly DockerContainerListEntry[],
): DockerClient['listContainers'] {
  return async () => containers;
}

/** Digest pair shaped like Unraid's own entries -- local !== remote is the
 * "update available" signal. */
const UPDATABLE = { local: 'sha256:old', remote: 'sha256:new', status: 'false' };
const UP_TO_DATE = { local: 'sha256:same', remote: 'sha256:same', status: 'true' };

describe('listUpdatableContainerNames', () => {
  let statusPath: string;

  beforeEach(() => {
    statusPath = path.join(dir, 'unraid-update-status.json');
  });

  function writeStatusFile(content: unknown): void {
    writeFileSync(statusPath, typeof content === 'string' ? content : JSON.stringify(content));
  }

  it('maps the status file image repo:tag keys onto container names', async () => {
    // The exact live failure: these keys were handed to docker verbatim and
    // came back as "404 no such container: lscr.io/linuxserver/plex:latest".
    writeStatusFile({
      'lscr.io/linuxserver/plex:latest': UPDATABLE,
      'lscr.io/linuxserver/transmission:latest': UPDATABLE,
      'lscr.io/linuxserver/sonarr:latest': UP_TO_DATE,
    });
    const dockerClient = makeDockerClientStub(
      makeContainerListStub([
        { Id: 'a', Image: 'lscr.io/linuxserver/plex:latest', Names: ['/plex'] },
        { Id: 'b', Image: 'lscr.io/linuxserver/transmission:latest', Names: ['/transmission'] },
        { Id: 'c', Image: 'lscr.io/linuxserver/sonarr:latest', Names: ['/sonarr'] },
      ]),
    );

    await expect(listUpdatableContainerNames(dockerClient, statusPath)).resolves.toEqual([
      'plex',
      'transmission',
    ]);
  });

  it('matches a container image with no explicit tag against a :latest key', async () => {
    writeStatusFile({ 'lscr.io/linuxserver/plex:latest': UPDATABLE });
    const dockerClient = makeDockerClientStub(
      makeContainerListStub([{ Id: 'a', Image: 'lscr.io/linuxserver/plex', Names: ['/plex'] }]),
    );

    await expect(listUpdatableContainerNames(dockerClient, statusPath)).resolves.toEqual(['plex']);
  });

  it('skips an updatable image that has no matching container', async () => {
    writeStatusFile({ 'lscr.io/linuxserver/plex:latest': UPDATABLE });
    const dockerClient = makeDockerClientStub(
      makeContainerListStub([{ Id: 'b', Image: 'other/image:latest', Names: ['/other'] }]),
    );

    await expect(listUpdatableContainerNames(dockerClient, statusPath)).resolves.toEqual([]);
  });

  it('returns every container sharing one updatable image', async () => {
    writeStatusFile({ 'lscr.io/linuxserver/plex:latest': UPDATABLE });
    const dockerClient = makeDockerClientStub(
      makeContainerListStub([
        { Id: 'a', Image: 'lscr.io/linuxserver/plex:latest', Names: ['/plex'] },
        { Id: 'b', Image: 'lscr.io/linuxserver/plex:latest', Names: ['/plex-4k'] },
      ]),
    );

    await expect(listUpdatableContainerNames(dockerClient, statusPath)).resolves.toEqual([
      'plex',
      'plex-4k',
    ]);
  });

  it('does not mistake a registry host port for an image tag', async () => {
    writeStatusFile({ 'localhost:5000/app:latest': UPDATABLE, 'localhost:5000/other': UPDATABLE });
    const dockerClient = makeDockerClientStub(
      makeContainerListStub([
        { Id: 'a', Image: 'localhost:5000/app', Names: ['/app'] },
        { Id: 'b', Image: 'localhost:5000/other:latest', Names: ['/other'] },
      ]),
    );

    await expect(listUpdatableContainerNames(dockerClient, statusPath)).resolves.toEqual([
      'app',
      'other',
    ]);
  });

  it('ignores a digest-pinned image instead of mangling it into a repo:tag', async () => {
    writeStatusFile({ 'lscr.io/linuxserver/plex@sha256:abc': UPDATABLE });
    const dockerClient = makeDockerClientStub(
      makeContainerListStub([
        { Id: 'a', Image: 'lscr.io/linuxserver/plex@sha256:abc', Names: ['/plex'] },
      ]),
    );

    await expect(listUpdatableContainerNames(dockerClient, statusPath)).resolves.toEqual([]);
  });

  it('returns an empty list when the status file is missing', async () => {
    const dockerClient = makeDockerClientStub(
      makeContainerListStub([{ Id: 'a', Image: 'lscr.io/linuxserver/plex:latest', Names: ['/plex'] }]),
    );

    await expect(
      listUpdatableContainerNames(dockerClient, path.join(dir, 'no-such-status.json')),
    ).resolves.toEqual([]);
  });

  it('returns an empty list when the status file is malformed', async () => {
    writeStatusFile('{ not json');
    const dockerClient = makeDockerClientStub(
      makeContainerListStub([{ Id: 'a', Image: 'lscr.io/linuxserver/plex:latest', Names: ['/plex'] }]),
    );

    await expect(listUpdatableContainerNames(dockerClient, statusPath)).resolves.toEqual([]);
  });

  it('returns an empty list when listing containers fails', async () => {
    writeStatusFile({ 'lscr.io/linuxserver/plex:latest': UPDATABLE });
    const dockerClient = makeDockerClientStub(async () => {
      throw new Error('docker socket unavailable');
    });

    await expect(listUpdatableContainerNames(dockerClient, statusPath)).resolves.toEqual([]);
  });
});
