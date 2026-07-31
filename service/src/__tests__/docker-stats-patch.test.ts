/**
 * Regression tests for the `docker-stats` bundle patch.
 *
 * The patch is JavaScript embedded in a Python raw string and injected into
 * the unraid-api bundle at boot, so it never goes through this package's
 * build. These tests extract that exact source and run it against stubs, so
 * the behaviour is pinned even though the code ships as a string.
 *
 * What is being guarded: the patch opens one `docker stats` stream PER
 * CONTAINER. A stop/start pair -- which the app produces on every tab switch
 * and every resume -- used to destroy and re-open all of them, hammering the
 * API's event loop on servers with many containers.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const patchFile = path.join(repoRoot, 'scripts', 'companion', 'patches', 'docker.py');

/** Pulls the docker-stats overlay out of the Python raw string verbatim. */
function extractOverlayJs(): string {
  const src = readFileSync(patchFile, 'utf8');
  const marker = 'overlay = "\\n" + DOCKER_STATS_MARKER + "\\n" + r"""';
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('docker-stats overlay marker not found');
  const from = start + marker.length;
  const end = src.indexOf('"""', from);
  if (end === -1) throw new Error('docker-stats overlay terminator not found');
  return src.slice(from, end);
}

interface FakeStream {
  destroyed: boolean;
  destroy: () => void;
  on: (event: string, cb: (chunk?: unknown) => void) => void;
}

interface Harness {
  service: {
    startStatsStream: () => Promise<void>;
    stopStatsStream: () => void;
    logger: { log: (m: string) => void; error: (m: string, e?: unknown) => void };
  };
  /** Every stats stream ever handed out, in creation order. */
  created: FakeStream[];
  /** How many times `.stats({stream:true})` was requested. */
  statsCalls: () => number;
  liveStreams: () => number;
}

const CONTAINER_IDS = ['c1', 'c2', 'c3', 'c4', 'c5'];

/**
 * Evaluates the real overlay with stubbed module-scope dependencies and
 * returns the patched service instance plus stream bookkeeping.
 */
function buildHarness(): Harness {
  const created: FakeStream[] = [];

  const makeStream = (): FakeStream => {
    const s: FakeStream = {
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
      on() {
        /* handlers are not exercised here; this suite is about lifecycle */
      },
    };
    created.push(s);
    return s;
  };

  class DockerStatsService {
    logger = { log: () => {}, error: () => {} };
  }

  const getDockerClient = () => ({
    listContainers: async () => CONTAINER_IDS.map((Id) => ({ Id })),
    getContainer: () => ({ stats: async () => makeStream() }),
    getEvents: async () => makeStream(),
  });

  const pubsub = { publish: () => {} };
  const GRAPHQL_PUBSUB_CHANNEL = { DOCKER_STATS: 'DOCKER_STATS' };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const load = new Function(
    'DockerStatsService',
    'getDockerClient',
    'pubsub',
    'GRAPHQL_PUBSUB_CHANNEL',
    extractOverlayJs(),
  );
  load(DockerStatsService, getDockerClient, pubsub, GRAPHQL_PUBSUB_CHANNEL);

  const service = new DockerStatsService() as unknown as Harness['service'];
  return {
    service,
    created,
    // One events stream is opened alongside the per-container ones.
    statsCalls: () => created.length,
    liveStreams: () => created.filter((s) => !s.destroyed).length,
  };
}

describe('docker-stats patch stream lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens one stats stream per container plus the events stream', async () => {
    const h = buildHarness();
    await h.service.startStatsStream();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.statsCalls()).toBe(CONTAINER_IDS.length + 1);
    expect(h.liveStreams()).toBe(CONTAINER_IDS.length + 1);
  });

  it('does not tear down immediately on stop', async () => {
    const h = buildHarness();
    await h.service.startStatsStream();
    await vi.advanceTimersByTimeAsync(0);

    h.service.stopStatsStream();

    expect(h.liveStreams()).toBe(CONTAINER_IDS.length + 1);
  });

  it('collapses a stop/start pair without rebuilding any stream', async () => {
    const h = buildHarness();
    await h.service.startStatsStream();
    await vi.advanceTimersByTimeAsync(0);
    const opened = h.statsCalls();

    // Tab switch / app resume: stop immediately followed by start.
    h.service.stopStatsStream();
    await vi.advanceTimersByTimeAsync(1000);
    await h.service.startStatsStream();
    await vi.advanceTimersByTimeAsync(0);

    // Nothing new opened and nothing was destroyed.
    expect(h.statsCalls()).toBe(opened);
    expect(h.liveStreams()).toBe(opened);
  });

  it('survives repeated stop/start thrashing without leaking streams', async () => {
    const h = buildHarness();
    await h.service.startStatsStream();
    await vi.advanceTimersByTimeAsync(0);
    const opened = h.statsCalls();

    for (let i = 0; i < 10; i++) {
      h.service.stopStatsStream();
      await vi.advanceTimersByTimeAsync(500);
      await h.service.startStatsStream();
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(h.statsCalls()).toBe(opened);
    expect(h.liveStreams()).toBe(opened);
  });

  it('tears every stream down once the grace period elapses', async () => {
    const h = buildHarness();
    await h.service.startStatsStream();
    await vi.advanceTimersByTimeAsync(0);

    h.service.stopStatsStream();
    await vi.advanceTimersByTimeAsync(6000);

    expect(h.liveStreams()).toBe(0);
  });

  it('reopens streams when started again after a completed teardown', async () => {
    const h = buildHarness();
    await h.service.startStatsStream();
    await vi.advanceTimersByTimeAsync(0);
    const first = h.statsCalls();

    h.service.stopStatsStream();
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.liveStreams()).toBe(0);

    await h.service.startStatsStream();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.statsCalls()).toBe(first * 2);
    expect(h.liveStreams()).toBe(first);
  });
});
