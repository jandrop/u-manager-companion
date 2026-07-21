/**
 * Thin, injectable wrapper over `dockerode`. Feature modules depend on the
 * `DockerClient` INTERFACE below, never on `dockerode` directly -- tests
 * inject a fake implementation so no suite ever needs a real docker socket.
 * Mirrors only the small surface the
 * ported Python patches actually use (`getDockerClient()` calls in
 * docker_template_create.py / docker_update_stream.py / etc.): pull with
 * progress events, container start/stop/remove/inspect, image
 * inspect/remove, volume prune, list containers. Deliberately NOT a
 * full re-export of dockerode's API surface.
 */
import Docker from 'dockerode';

/** One decoded event from dockerode's `followProgress` progress callback --
 * mirrors the shape the Python patches' `formatPullEvent()` consumes
 * (`event.status`, `event.id`, `event.error`, `event.progressDetail`). */
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

/** Docker API errors carry a `statusCode` (e.g. 304 already-started, 404
 * not-found) that the ported logic branches on -- narrow, structural check
 * rather than importing dockerode's error classes. */
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
   * Wraps dockerode's `pull()` + `modem.followProgress()` pair -- the exact
   * two-step the ported Python patches use. */
  pull(repoTag: string, onProgress: (event: DockerPullProgressEvent) => void): Promise<void>;
  pruneVolumes(): Promise<void>;
  listContainers(options?: { readonly all?: boolean }): Promise<readonly DockerContainerListEntry[]>;
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
  };
}
