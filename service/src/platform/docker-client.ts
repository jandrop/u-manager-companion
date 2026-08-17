/**
 * Thin, injectable wrapper over `dockerode`. Feature modules depend on the
 * `DockerClient` INTERFACE below, never on `dockerode` directly -- tests
 * inject a fake implementation so no suite ever needs a real docker socket.
 * Covers only the small surface feature modules actually use: pull with
 * progress events, container start/stop/remove/inspect, image
 * inspect/remove, volume prune, list containers. Deliberately NOT a
 * full re-export of dockerode's API surface.
 */
import Docker from 'dockerode';

/** One decoded event from dockerode's `followProgress` progress callback --
 * carries `event.status`, `event.id`, `event.error`, and
 * `event.progressDetail` for rendering pull progress to the caller. */
export interface DockerPullProgressEvent {
  readonly status?: string;
  readonly id?: string;
  readonly error?: string;
  readonly progressDetail?: {
    readonly current?: number;
    readonly total?: number;
  };
}

export interface DockerContainerInspect {
  readonly Id: string;
  readonly Name: string;
  readonly Image: string;
  readonly State: { readonly Running: boolean };
  readonly Config: { readonly Image: string };
}

export interface DockerContainerHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  remove(options?: { readonly force?: boolean; readonly v?: boolean }): Promise<void>;
  inspect(): Promise<DockerContainerInspect>;
}

export interface DockerImageInspect {
  readonly RepoDigests?: readonly string[];
}

export interface DockerImageHandle {
  inspect(): Promise<DockerImageInspect>;
  remove(options?: { readonly force?: boolean }): Promise<void>;
}

export interface DockerContainerListEntry {
  readonly Id: string;
  readonly Image: string;
  readonly Names: readonly string[];
}

/** Untrusted wire data off the stats socket: every field optional, nothing
 * assumed present -- a host-network container has no `networks`, a cgroup-v1
 * host has no `inactive_file`, etc. */
export interface DockerStatsChunk {
  readonly read?: string;
  readonly cpu_stats?: {
    readonly cpu_usage?: { readonly total_usage?: number };
    readonly system_cpu_usage?: number;
    readonly online_cpus?: number;
  };
  readonly precpu_stats?: {
    readonly cpu_usage?: { readonly total_usage?: number };
    readonly system_cpu_usage?: number;
  };
  readonly memory_stats?: {
    readonly usage?: number;
    readonly limit?: number;
    readonly stats?: {
      readonly inactive_file?: number;
      readonly total_inactive_file?: number;
      readonly cache?: number;
    };
  };
  readonly networks?: Record<string, { readonly rx_bytes?: number; readonly tx_bytes?: number }>;
  readonly blkio_stats?: {
    readonly io_service_bytes_recursive?: readonly { readonly op?: string; readonly value?: number }[];
  };
}

/** One decoded Docker daemon event -- only the fields the lifecycle
 * orchestrator's start/die/stop/kill/destroy handling needs. */
export interface DockerEventChunk {
  readonly status?: string;
  readonly id?: string;
  readonly Actor?: { readonly ID?: string };
}

/** Four callbacks because each maps to a DIFFERENT recovery: onChunk is
 * data; onDecodeError drops one frame and the stream lives; onError means
 * the stream is dead and must be reopened; onEnd is a clean close (e.g. the
 * container stopped). */
export interface DockerStreamHandlers<TChunk> {
  onChunk(chunk: TChunk): void;
  onDecodeError(error: unknown, rawLine: string): void;
  onError(error: unknown): void;
  onEnd(): void;
}

/** `destroy()` is idempotent and safe to call after onEnd/onError. */
export interface DockerStreamHandle {
  destroy(): void;
}

/**
 * Docker frames newline-delimited JSON over a socket that may split ONE
 * object across chunks or coalesce SEVERAL into one. A naive per-chunk
 * `JSON.parse` therefore drops or corrupts samples. Holds the trailing
 * partial line until its newline arrives.
 *
 * Exported as a pure function so the framing logic is testable without a
 * socket.
 */
export function createNdjsonSplitter<T>(
  onObject: (value: T) => void,
  onDecodeError: (error: unknown, rawLine: string) => void,
): (chunk: Buffer | string) => void {
  let buffered = '';
  return (chunk) => {
    buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newlineIndex = buffered.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffered.slice(0, newlineIndex).trim();
      buffered = buffered.slice(newlineIndex + 1);
      if (line) {
        try {
          onObject(JSON.parse(line) as T);
        } catch (error) {
          onDecodeError(error, line);
        }
      }
      newlineIndex = buffered.indexOf('\n');
    }
  };
}

/** Wires a raw dockerode ReadableStream to the NDJSON splitter + handlers,
 * returning an idempotent destroy() handle. Shared by both stream methods
 * below -- chunk framing is a transport property, not a stats/events one. */
function attachHandlers<T>(
  stream: NodeJS.ReadableStream,
  handlers: DockerStreamHandlers<T>,
): DockerStreamHandle {
  const split = createNdjsonSplitter<T>(handlers.onChunk, handlers.onDecodeError);
  stream.on('data', (chunk: Buffer) => split(chunk));
  stream.on('error', (error: unknown) => handlers.onError(error));
  stream.on('end', () => handlers.onEnd());

  let destroyed = false;
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    },
  };
}

/** Docker API errors carry a `statusCode` (e.g. 304 already-started, 404
 * not-found) that callers branch on -- narrow, structural check rather
 * than importing dockerode's error classes. */
export interface DockerApiError {
  readonly statusCode?: number;
}

export function isDockerApiError(value: unknown): value is DockerApiError {
  return typeof value === 'object' && value !== null && 'statusCode' in value;
}

export interface DockerClient {
  getContainer(nameOrId: string): DockerContainerHandle;
  getImage(nameOrId: string): DockerImageHandle;
  /** Pulls `repoTag`, invoking `onProgress` for every decoded progress
   * event, and resolves once the pull completes (or rejects on failure).
   * Wraps dockerode's `pull()` + `modem.followProgress()` pair. */
  pull(repoTag: string, onProgress: (event: DockerPullProgressEvent) => void): Promise<void>;
  pruneVolumes(): Promise<void>;
  listContainers(options?: { readonly all?: boolean }): Promise<readonly DockerContainerListEntry[]>;
  /** Opens a live `docker stats --stream` socket for one container. Resolves
   * once the stream is open; chunks/errors/end arrive via `handlers`. */
  streamContainerStats(
    id: string,
    handlers: DockerStreamHandlers<DockerStatsChunk>,
  ): Promise<DockerStreamHandle>;
  /** Opens the daemon-wide container lifecycle events stream, filtered to
   * start/die/stop/kill/destroy -- the events the stats lifecycle cares
   * about. */
  streamContainerEvents(handlers: DockerStreamHandlers<DockerEventChunk>): Promise<DockerStreamHandle>;
}

let cachedDockerode: Docker | undefined;

/** Lazily constructs the shared dockerode instance (default socket path).
 * Kept lazy + cached so importing this module never touches the docker
 * socket unless a feature actually calls createDockerClient() in
 * production. */
function resolveDockerode(): Docker {
  cachedDockerode ??= new Docker();
  return cachedDockerode;
}

/**
 * Production DockerClient implementation, backed by a real dockerode
 * instance. `docker` is injectable (defaults to the shared lazy instance)
 * so a test COULD construct this against a fake dockerode-shaped object,
 * though feature-module tests are expected to inject a full DockerClient
 * fake instead of going through this factory at all.
 */
export function createDockerClient(docker: Docker = resolveDockerode()): DockerClient {
  return {
    getContainer(nameOrId) {
      const container = docker.getContainer(nameOrId);
      return {
        async start() {
          await container.start();
        },
        async stop() {
          await container.stop();
        },
        async remove(options) {
          await container.remove(options ?? {});
        },
        async inspect() {
          return (await container.inspect()) as unknown as DockerContainerInspect;
        },
      };
    },
    getImage(nameOrId) {
      const image = docker.getImage(nameOrId);
      return {
        async inspect() {
          return (await image.inspect()) as unknown as DockerImageInspect;
        },
        async remove(options) {
          await image.remove(options ?? {});
        },
      };
    },
    async pull(repoTag, onProgress) {
      const stream = await docker.pull(repoTag, {});
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(
          stream,
          (error: Error | null) => (error ? reject(error) : resolve()),
          (event: DockerPullProgressEvent) => onProgress(event),
        );
      });
    },
    async pruneVolumes() {
      await docker.pruneVolumes();
    },
    async listContainers(options) {
      const containers = await docker.listContainers(options ?? { all: true });
      return containers.map((container) => ({
        Id: container.Id,
        Image: container.Image,
        Names: container.Names,
      }));
    },
    async streamContainerStats(id, handlers) {
      const stream = await docker.getContainer(id).stats({ stream: true });
      return attachHandlers(stream, handlers);
    },
    async streamContainerEvents(handlers) {
      const stream = await docker.getEvents({
        filters: { type: ['container'], event: ['start', 'die', 'stop', 'kill', 'destroy'] },
      });
      return attachHandlers(stream, handlers);
    },
  };
}
