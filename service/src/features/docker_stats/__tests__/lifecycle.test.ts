/**
 * stats.ts tests -- the lifecycle orchestrator: subscriber counting,
 * per-container + events streams, cadence/staleness, and the two failure
 * paths.
 *
 * TDD: written before stats.ts exists -> RED first. vi.useFakeTimers()
 * drives every timing assertion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DockerClient,
  DockerContainerListEntry,
  DockerEventChunk,
  DockerStatsChunk,
  DockerStreamHandlers,
} from '../../../platform/docker-client.js';
import type { DockerContainerStatsSample } from '../map.js';
import {
  subscribeDockerContainerStats,
  __resetDockerStatsForTests,
  TEARDOWN_GRACE_MS,
  STATS_FLUSH_INTERVAL_MS,
  STALE_SAMPLE_MS,
  RECONCILE_INTERVAL_MS,
  ENGINE_PROBE_TIMEOUT_MS,
  ENGINE_DOWN_FAIL_MS,
  type DockerStatsDeps,
} from '../stats.js';
import { GraphQLError } from 'graphql';

interface FakeHandle {
  readonly destroy: ReturnType<typeof vi.fn>;
}

/** Records every handler set registered per container id / for the events
 * stream, so a test can drive onChunk/onError/onEnd directly -- exactly the
 * synchronous, loggable, per-container failure shape D1 chose over a raw
 * stream or AsyncIterable. */
function createFakeDockerClient(initialContainers: readonly DockerContainerListEntry[] = []) {
  const statsHandlers = new Map<string, DockerStreamHandlers<DockerStatsChunk>>();
  const statsHandles = new Map<string, FakeHandle>();
  const failToOpen = new Set<string>();
  let eventsHandlers: DockerStreamHandlers<DockerEventChunk> | undefined;
  const eventsHandle: FakeHandle = { destroy: vi.fn() };
  let listContainersResult: readonly DockerContainerListEntry[] = initialContainers;
  let listContainersImpl: DockerClient['listContainers'] = () => Promise.resolve(listContainersResult);

  const client: DockerClient = {
    getContainer: vi.fn() as unknown as DockerClient['getContainer'],
    getImage: vi.fn() as unknown as DockerClient['getImage'],
    pull: vi.fn() as unknown as DockerClient['pull'],
    pruneVolumes: vi.fn() as unknown as DockerClient['pruneVolumes'],
    listContainers: (options) => listContainersImpl(options),
    streamContainerStats: vi.fn(async (id, handlers) => {
      if (failToOpen.has(id)) throw new Error(`cannot open stats stream for ${id}`);
      statsHandlers.set(id, handlers);
      const handle: FakeHandle = { destroy: vi.fn() };
      statsHandles.set(id, handle);
      return handle;
    }),
    streamContainerEvents: vi.fn(async (handlers) => {
      eventsHandlers = handlers;
      return eventsHandle;
    }),
  };

  return {
    client,
    statsHandlers,
    statsHandles,
    eventsHandle,
    get eventsHandlers() {
      return eventsHandlers;
    },
    failToOpen,
    setListContainers(entries: readonly DockerContainerListEntry[]): void {
      listContainersResult = entries;
    },
    setListContainersImpl(impl: DockerClient['listContainers']): void {
      listContainersImpl = impl;
    },
  };
}

function entry(id: string): DockerContainerListEntry {
  return { Id: id, Image: 'image', Names: [`/${id}`] };
}

function makeDeps(client: DockerClient): DockerStatsDeps & { log: ReturnType<typeof vi.fn> } {
  return { dockerClient: client, log: vi.fn() };
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetDockerStatsForTests();
});

afterEach(() => {
  __resetDockerStatsForTests();
  vi.useRealTimers();
});

describe('subscribeDockerContainerStats -- subscriber lifecycle', () => {
  it('first subscriber seeds and opens one stream per running container plus the events stream', async () => {
    const fake = createFakeDockerClient([entry('c1'), entry('c2')]);
    const deps = makeDeps(fake.client);

    await subscribeDockerContainerStats(deps);

    expect(fake.client.streamContainerStats).toHaveBeenCalledTimes(2);
    expect(fake.statsHandlers.has('c1')).toBe(true);
    expect(fake.statsHandlers.has('c2')).toBe(true);
    expect(fake.client.streamContainerEvents).toHaveBeenCalledTimes(1);
  });

  it('second subscriber opens nothing new', async () => {
    const fake = createFakeDockerClient([entry('c1')]);
    const deps = makeDeps(fake.client);

    await subscribeDockerContainerStats(deps);
    await subscribeDockerContainerStats(deps);

    expect(fake.client.streamContainerStats).toHaveBeenCalledTimes(1);
    expect(fake.client.streamContainerEvents).toHaveBeenCalledTimes(1);
  });

  it('tears down only after TEARDOWN_GRACE_MS once the last subscriber leaves', async () => {
    const fake = createFakeDockerClient([entry('c1')]);
    const deps = makeDeps(fake.client);

    const iterator = (await subscribeDockerContainerStats(deps))[Symbol.asyncIterator]();
    await iterator.return?.();

    expect(fake.statsHandles.get('c1')!.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(TEARDOWN_GRACE_MS - 1);
    expect(fake.statsHandles.get('c1')!.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(fake.statsHandles.get('c1')!.destroy).toHaveBeenCalled();
    expect(fake.eventsHandle.destroy).toHaveBeenCalled();
  });

  it('a reconnect inside the grace window keeps every existing stream', async () => {
    const fake = createFakeDockerClient([entry('c1')]);
    const deps = makeDeps(fake.client);

    const iterator = (await subscribeDockerContainerStats(deps))[Symbol.asyncIterator]();
    await iterator.return?.();
    await vi.advanceTimersByTimeAsync(TEARDOWN_GRACE_MS / 2);

    await subscribeDockerContainerStats(deps);
    await vi.advanceTimersByTimeAsync(TEARDOWN_GRACE_MS);

    expect(fake.statsHandles.get('c1')!.destroy).not.toHaveBeenCalled();
    // Reconnecting inside the grace window must not re-seed/re-open.
    expect(fake.client.streamContainerStats).toHaveBeenCalledTimes(1);
  });

  it('.return() on an iterator that was never pulled still releases the subscriber', async () => {
    const fake = createFakeDockerClient([entry('c1')]);
    const deps = makeDeps(fake.client);

    const iterable = await subscribeDockerContainerStats(deps);
    const iterator = iterable[Symbol.asyncIterator]();
    // Never call .next() -- the exact case an async-generator's `finally`
    // would miss (D4).
    await iterator.return?.();
    await vi.advanceTimersByTimeAsync(TEARDOWN_GRACE_MS + 1);

    expect(fake.statsHandles.get('c1')!.destroy).toHaveBeenCalled();
  });
});

describe('subscribeDockerContainerStats -- container start/die events', () => {
  it('a start event opens a stream; die removes the stream and its latest entry', async () => {
    const fake = createFakeDockerClient([]);
    const deps = makeDeps(fake.client);

    await subscribeDockerContainerStats(deps);
    expect(fake.client.streamContainerStats).not.toHaveBeenCalled();

    fake.eventsHandlers!.onChunk({ status: 'start', id: 'c1' });
    expect(fake.client.streamContainerStats).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();

    const c1Handlers = fake.statsHandlers.get('c1')!;
    c1Handlers.onChunk({ read: '2026-08-16T00:00:00Z', memory_stats: { usage: 100, limit: 200 } });

    fake.eventsHandlers!.onChunk({ status: 'die', id: 'c1' });
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.statsHandles.get('c1')!.destroy).toHaveBeenCalled();
  });
});

describe('subscribeDockerContainerStats -- cadence and staleness', () => {
  it('publishes a batch every STATS_FLUSH_INTERVAL_MS carrying the latest sample per container', async () => {
    const fake = createFakeDockerClient([entry('c1')]);
    const deps = makeDeps(fake.client);
    const iterator = (await subscribeDockerContainerStats(deps))[Symbol.asyncIterator]();

    fake.statsHandlers.get('c1')!.onChunk({ read: '2026-08-16T00:00:00Z', memory_stats: { usage: 100, limit: 200 } });

    const nextPromise = iterator.next();
    await vi.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
    const result = await nextPromise;

    expect(result.done).toBe(false);
    expect(result.value).toHaveLength(1);
    expect(result.value![0]!.id).toBe('c1');

    await iterator.return?.();
  });

  it('publishes an empty batch every tick when zero containers are running (healthy-idle)', async () => {
    const fake = createFakeDockerClient([]);
    const deps = makeDeps(fake.client);
    const iterator = (await subscribeDockerContainerStats(deps))[Symbol.asyncIterator]();

    const nextPromise = iterator.next();
    await vi.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
    const result = await nextPromise;

    expect(result.done).toBe(false);
    expect(result.value).toEqual([]);

    await iterator.return?.();
  });

  it('a container dying between flushes is absent from the next batch', async () => {
    const fake = createFakeDockerClient([entry('c1'), entry('c2')]);
    const deps = makeDeps(fake.client);
    const iterator = (await subscribeDockerContainerStats(deps))[Symbol.asyncIterator]();

    fake.statsHandlers.get('c1')!.onChunk({ memory_stats: { usage: 1, limit: 2 } });
    fake.statsHandlers.get('c2')!.onChunk({ memory_stats: { usage: 1, limit: 2 } });
    fake.eventsHandlers!.onChunk({ status: 'die', id: 'c2' });

    const nextPromise = iterator.next();
    await vi.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
    const result = await nextPromise;

    expect(result.value!.map((sample: DockerContainerStatsSample) => sample.id)).toEqual(['c1']);

    await iterator.return?.();
  });

  it('drops a sample past STALE_SAMPLE_MS and destroys its stream', async () => {
    const fake = createFakeDockerClient([entry('c1')]);
    const deps = makeDeps(fake.client);
    const iterator = (await subscribeDockerContainerStats(deps))[Symbol.asyncIterator]();

    fake.statsHandlers.get('c1')!.onChunk({ memory_stats: { usage: 1, limit: 2 } });

    const ticks = Math.ceil((STALE_SAMPLE_MS + STATS_FLUSH_INTERVAL_MS) / STATS_FLUSH_INTERVAL_MS);
    let lastBatch: readonly DockerContainerStatsSample[] = [];
    for (let i = 0; i < ticks; i += 1) {
      const nextPromise = iterator.next();
      await vi.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
      lastBatch = (await nextPromise).value ?? [];
    }

    expect(lastBatch).toEqual([]);
    expect(fake.statsHandles.get('c1')!.destroy).toHaveBeenCalled();

    await iterator.return?.();
  });

  it('self-heals via reconcile when streaming holds no live stream for a still-running container', async () => {
    const fake = createFakeDockerClient([entry('c1')]);
    const deps = makeDeps(fake.client);
    await subscribeDockerContainerStats(deps);
    expect(fake.client.streamContainerStats).toHaveBeenCalledTimes(1);

    // Simulate the latched-flag bug this task guards against: the stream
    // ends but the container is still running (still in the roster).
    fake.statsHandlers.get('c1')!.onEnd();
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);

    expect(fake.client.streamContainerStats).toHaveBeenCalledTimes(2);
  });
});

describe('subscribeDockerContainerStats -- stream open failure isolation', () => {
  it('one container failing to open its stats stream is logged and the others keep publishing', async () => {
    const fake = createFakeDockerClient([entry('bad'), entry('good')]);
    fake.failToOpen.add('bad');
    const deps = makeDeps(fake.client);

    await subscribeDockerContainerStats(deps);
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.log).toHaveBeenCalled();
    expect(fake.statsHandlers.has('good')).toBe(true);
    expect(fake.statsHandlers.has('bad')).toBe(false);
  });
});

describe('subscribeDockerContainerStats -- subscribe-time failure', () => {
  it('rejects with a GraphQLError, opens nothing, and restores the subscriber count', async () => {
    const fake = createFakeDockerClient();
    fake.setListContainersImpl(() => Promise.reject(new Error('ECONNREFUSED')));
    const deps = makeDeps(fake.client);

    await expect(subscribeDockerContainerStats(deps)).rejects.toThrow(GraphQLError);

    expect(fake.client.streamContainerStats).not.toHaveBeenCalled();
    expect(fake.client.streamContainerEvents).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalled();

    // Count was restored: a follow-up subscribe against a healthy engine
    // must seed fresh, not silently no-op as "already active".
    fake.setListContainersImpl(() => Promise.resolve([entry('c1')]));
    await subscribeDockerContainerStats(deps);
    expect(fake.client.streamContainerStats).toHaveBeenCalledTimes(1);
  });

  it('a probe that never settles rejects at ENGINE_PROBE_TIMEOUT_MS', async () => {
    const fake = createFakeDockerClient();
    fake.setListContainersImpl(() => new Promise(() => {})); // never resolves/rejects
    const deps = makeDeps(fake.client);

    const subscribePromise = subscribeDockerContainerStats(deps);
    const assertion = expect(subscribePromise).rejects.toThrow(GraphQLError);
    await vi.advanceTimersByTimeAsync(ENGINE_PROBE_TIMEOUT_MS);
    await assertion;
  });
});

describe('subscribeDockerContainerStats -- engine dies mid-subscription', () => {
  it('retries on backoff, then fails through the relay past ENGINE_DOWN_FAIL_MS', async () => {
    const fake = createFakeDockerClient([entry('c1')]);
    const deps = makeDeps(fake.client);
    const iterator = (await subscribeDockerContainerStats(deps))[Symbol.asyncIterator]();

    // Engine goes down: every subsequent listContainers (reconcile/retry)
    // rejects.
    fake.setListContainersImpl(() => Promise.reject(new Error('engine down')));
    fake.eventsHandlers!.onError(new Error('daemon events socket reset'));

    // Drain flush ticks (each an empty/healthy batch) until the eventual
    // failure sentinel arrives past ENGINE_DOWN_FAIL_MS. The catch handler
    // is attached synchronously (same tick as the promise) so a rejection
    // that settles mid-advance is never briefly unhandled.
    const ticks = Math.ceil((ENGINE_DOWN_FAIL_MS + STATS_FLUSH_INTERVAL_MS) / STATS_FLUSH_INTERVAL_MS);
    let rejected: unknown;
    for (let i = 0; i < ticks && rejected === undefined; i += 1) {
      const nextPromise = iterator.next().catch((error: unknown) => {
        rejected = error;
        return { done: true as const, value: undefined };
      });
      await vi.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
      await nextPromise;
    }

    expect(rejected).toBeInstanceOf(GraphQLError);
    expect(deps.log).toHaveBeenCalled();
  });
});
