/**
 * Lifecycle orchestrator for `dockerContainerStats`.
 *
 * Module-level state machine (mirrors docker_update/update.ts's module-level
 * `busy` flag): owns subscriber count, per-container streams, the events
 * stream, the flush cadence, reconcile/recovery, and both failure paths.
 * See sdd/docker-stats-subscription/design D3-D9 for the full rationale.
 */
import { GraphQLError } from 'graphql';
import type {
  DockerClient,
  DockerContainerListEntry,
  DockerStreamHandle,
} from '../../platform/docker-client.js';
import { toSample, type DockerContainerStatsSample } from './map.js';
import { pubsub } from '../../pubsub.js';

/** One frame/tick beats ~22 raw frames/s to a phone on the reference server. */
export const STATS_FLUSH_INTERVAL_MS = 2000;
/** App resume / tab switch must not rebuild every container's stream. */
export const TEARDOWN_GRACE_MS = 5000;
/** A hang here (not a rejection) is the exact bug this task fixes. */
export const ENGINE_PROBE_TIMEOUT_MS = 5000;
/** Task contract: fail the subscription so the client reconnects. */
export const ENGINE_DOWN_FAIL_MS = 30000;
export const ENGINE_RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000] as const;
/** Catches missed Docker events and the latched-flag recovery case. */
export const RECONCILE_INTERVAL_MS = 30000;
/** ~15x the engine's own ~1 Hz stats cadence. */
export const STALE_SAMPLE_MS = 15000;

const DOCKER_STATS_CHANNEL = 'DOCKER_STATS';
const DIE_EVENTS = new Set(['die', 'stop', 'kill', 'destroy']);

export interface DockerStatsDeps {
  readonly dockerClient: DockerClient;
  /** Every failure path must be diagnosable -- injected so tests can assert
   * a failed stream WAS logged (finding #2: never swallow). */
  readonly log: (message: string, error?: unknown) => void;
}

type Batch = readonly DockerContainerStatsSample[];

/** Discriminated payload on DOCKER_STATS_CHANNEL: a normal batch, or the
 * mid-stream engine-down sentinel the relay turns into a thrown GraphQLError. */
type DockerStatsMessage = { readonly kind: 'batch'; readonly samples: Batch } | { readonly kind: 'failure'; readonly message: string };

interface LatestEntry {
  readonly sample: DockerContainerStatsSample;
  /** Service-clock receipt time, distinct from the sample's own
   * `sampledAtMs` -- staleness is "we stopped hearing from this stream",
   * not a property of Docker's reported clock. */
  readonly receivedAtMs: number;
}

let subscriberCount = 0;
let streaming = false;
let teardownTimer: NodeJS.Timeout | undefined;
let flushTimer: NodeJS.Timeout | undefined;
let reconcileTimer: NodeJS.Timeout | undefined;
let retryTimer: NodeJS.Timeout | undefined;
let retryAttempt = 0;
let engineDownSince: number | undefined;
let startPromise: Promise<void> | undefined;
const statsStreams = new Map<string, DockerStreamHandle>();
const latest = new Map<string, LatestEntry>();
let eventsStream: DockerStreamHandle | undefined;

/** Test-only reset -- module-level state otherwise leaks across `it()`s in
 * the same file, matching docker_update/update.ts's own reset export. */
export function __resetDockerStatsForTests(): void {
  subscriberCount = 0;
  streaming = false;
  if (teardownTimer) clearTimeout(teardownTimer);
  if (flushTimer) clearInterval(flushTimer);
  if (reconcileTimer) clearInterval(reconcileTimer);
  if (retryTimer) clearTimeout(retryTimer);
  teardownTimer = undefined;
  flushTimer = undefined;
  reconcileTimer = undefined;
  retryTimer = undefined;
  retryAttempt = 0;
  engineDownSince = undefined;
  startPromise = undefined;
  statsStreams.clear();
  latest.clear();
  eventsStream = undefined;
}

/** Races a promise against a timeout so a HANG (not just a rejection) still
 * settles this function -- the historic bug was listContainers() hanging. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function closeContainerStream(id: string): void {
  statsStreams.get(id)?.destroy();
  statsStreams.delete(id);
  latest.delete(id);
}

/** Opens one container's stats stream. Failure here must never stop the
 * others -- logged and dropped, not thrown (task finding #2 + failure
 * isolation requirement). */
function openContainerStream(deps: DockerStatsDeps, id: string): void {
  if (statsStreams.has(id)) return;
  deps.dockerClient
    .streamContainerStats(id, {
      onChunk: (chunk) => {
        latest.set(id, { sample: toSample(id, chunk), receivedAtMs: Date.now() });
      },
      onDecodeError: (error, rawLine) => {
        deps.log(`Docker stats: malformed line for container ${id}: ${rawLine}`, error);
      },
      onError: (error) => {
        deps.log(`Docker stats stream failed for container ${id}`, error);
        closeContainerStream(id);
      },
      onEnd: () => {
        // Clean close -- the container stopped. Not an error, nothing to log.
        statsStreams.delete(id);
        latest.delete(id);
      },
    })
    .then((handle) => {
      if (!streaming) {
        handle.destroy();
        return;
      }
      statsStreams.set(id, handle);
    })
    .catch((error: unknown) => {
      deps.log(`Failed to open Docker stats stream for container ${id}`, error);
    });
}

function openEventsStream(deps: DockerStatsDeps): void {
  deps.dockerClient
    .streamContainerEvents({
      onChunk: (event) => {
        const id = event.Actor?.ID ?? event.id;
        if (!id) return;
        if (event.status === 'start') {
          openContainerStream(deps, id);
        } else if (event.status && DIE_EVENTS.has(event.status)) {
          closeContainerStream(id);
        }
      },
      onDecodeError: (error, rawLine) => {
        deps.log(`Docker events: malformed line: ${rawLine}`, error);
      },
      onError: (error) => {
        deps.log('Docker events stream failed', error);
        eventsStream = undefined;
        handleEngineDown(deps);
      },
      onEnd: () => {
        deps.log('Docker events stream ended unexpectedly');
        eventsStream = undefined;
        handleEngineDown(deps);
      },
    })
    .then((handle) => {
      if (!streaming) {
        handle.destroy();
        return;
      }
      eventsStream = handle;
    })
    .catch((error: unknown) => {
      deps.log('Failed to open Docker events stream', error);
      handleEngineDown(deps);
    });
}

function publish(message: DockerStatsMessage): void {
  // Best-effort, same posture as operations/registry.ts's publishEvent --
  // a publish failure (no active subscribers) must never break the caller.
  void pubsub.publish(DOCKER_STATS_CHANNEL, message).catch(() => {
    /* best-effort */
  });
}

function flush(): void {
  const now = Date.now();
  const batch: DockerContainerStatsSample[] = [];
  for (const [id, entry] of latest) {
    if (now - entry.receivedAtMs > STALE_SAMPLE_MS) {
      // Looks healthy, publishes nothing real -- the exact class of bug this
      // task exists to fix. Drop + destroy; the next reconcile reopens it.
      closeContainerStream(id);
      continue;
    }
    batch.push(entry.sample);
  }
  publish({ kind: 'batch', samples: batch });
}

/**
 * Single recovery point: lists running containers, opens streams missing
 * from statsStreams (covers missed events AND the latched-flag case where
 * `streaming` is true but holds no live streams), drops streams/entries for
 * containers no longer running, and reopens the events stream if it died.
 * Runs on RECONCILE_INTERVAL_MS and immediately on events-stream failure.
 */
async function reconcile(deps: DockerStatsDeps): Promise<void> {
  if (!streaming) return;
  let containers: readonly DockerContainerListEntry[];
  try {
    containers = await withTimeout(
      deps.dockerClient.listContainers({ all: false }),
      ENGINE_PROBE_TIMEOUT_MS,
      'Docker reconcile listContainers',
    );
  } catch (error) {
    deps.log('Docker reconcile: engine unreachable', error);
    handleEngineDown(deps);
    return;
  }

  // Engine answered -- any prior down-tracking is over.
  engineDownSince = undefined;
  retryAttempt = 0;

  const runningIds = new Set(containers.map((container) => container.Id));
  for (const id of [...statsStreams.keys()]) {
    if (!runningIds.has(id)) closeContainerStream(id);
  }
  for (const id of [...latest.keys()]) {
    if (!runningIds.has(id)) latest.delete(id);
  }
  for (const id of runningIds) {
    if (!statsStreams.has(id)) openContainerStream(deps, id);
  }
  if (!eventsStream) openEventsStream(deps);
}

/** Retries on backoff while the engine is down; past ENGINE_DOWN_FAIL_MS,
 * publishes the failure sentinel and tears down so the client reconnects
 * rather than staring at a stream that will never resume. */
function handleEngineDown(deps: DockerStatsDeps): void {
  if (!streaming) return;
  engineDownSince ??= Date.now();
  const downForMs = Date.now() - engineDownSince;

  if (downForMs >= ENGINE_DOWN_FAIL_MS) {
    deps.log(`Docker engine down for over ${ENGINE_DOWN_FAIL_MS}ms, failing the subscription`);
    publish({ kind: 'failure', message: 'Docker engine unreachable' });
    teardownNow();
    return;
  }

  if (retryTimer) return; // a retry is already scheduled
  const delayIndex = Math.min(retryAttempt, ENGINE_RETRY_BACKOFF_MS.length - 1);
  const delay = ENGINE_RETRY_BACKOFF_MS[delayIndex] ?? ENGINE_RETRY_BACKOFF_MS[ENGINE_RETRY_BACKOFF_MS.length - 1]!;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    retryAttempt += 1;
    void reconcile(deps);
  }, delay);
  retryTimer.unref?.();
}

function cancelTeardownTimer(): void {
  if (teardownTimer) {
    clearTimeout(teardownTimer);
    teardownTimer = undefined;
  }
}

function teardownNow(): void {
  streaming = false;
  subscriberCount = 0;
  engineDownSince = undefined;
  retryAttempt = 0;
  cancelTeardownTimer();
  if (flushTimer) clearInterval(flushTimer);
  if (reconcileTimer) clearInterval(reconcileTimer);
  if (retryTimer) clearTimeout(retryTimer);
  flushTimer = undefined;
  reconcileTimer = undefined;
  retryTimer = undefined;
  for (const handle of statsStreams.values()) handle.destroy();
  statsStreams.clear();
  latest.clear();
  eventsStream?.destroy();
  eventsStream = undefined;
  startPromise = undefined;
}

/**
 * Seeds via a time-boxed `listContainers`, opens one stream per running
 * container plus the events stream, and starts the flush/reconcile timers.
 * The probe MUST be time-boxed: an un-raced await turns "fail at subscribe
 * time" into "hang at subscribe time" -- the exact bug this task fixes.
 */
async function startStreaming(deps: DockerStatsDeps): Promise<void> {
  let containers: readonly DockerContainerListEntry[];
  try {
    containers = await withTimeout(
      deps.dockerClient.listContainers({ all: false }),
      ENGINE_PROBE_TIMEOUT_MS,
      'Docker engine probe',
    );
  } catch (error) {
    deps.log('Docker engine unreachable at subscribe time', error);
    throw new GraphQLError(
      `Docker engine unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  streaming = true;
  engineDownSince = undefined;
  retryAttempt = 0;

  for (const container of containers) openContainerStream(deps, container.Id);
  openEventsStream(deps);

  flushTimer = setInterval(flush, STATS_FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
  reconcileTimer = setInterval(() => void reconcile(deps), RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();
}

/** Increments the subscriber count and, for the first subscriber, owns the
 * seed. Concurrent acquires while STARTING share the same `startPromise` --
 * JS is synchronous up to the first await, so N simultaneous subscribe()
 * calls produce exactly one seed, never N (D3/D6). */
async function acquireSubscriber(deps: DockerStatsDeps): Promise<void> {
  cancelTeardownTimer();
  subscriberCount += 1;
  if (subscriberCount === 1) {
    startPromise = startStreaming(deps);
  }
  try {
    await startPromise;
  } catch (error) {
    subscriberCount = Math.max(0, subscriberCount - 1);
    throw error;
  }
}

function releaseSubscriber(): void {
  subscriberCount = Math.max(0, subscriberCount - 1);
  if (subscriberCount > 0) return;
  cancelTeardownTimer();
  teardownTimer = setTimeout(() => {
    teardownTimer = undefined;
    if (subscriberCount === 0) teardownNow();
  }, TEARDOWN_GRACE_MS);
  teardownTimer.unref?.();
}

/**
 * Hand-rolled AsyncIterableIterator wrapping pubsub.asyncIterator, releasing
 * on return()/throw()/a done result via a `released` latch -- NOT an
 * `async function*`'s `finally`, which never runs when the consumer calls
 * `.return()` before the first `next()` (D4).
 */
function createRelay(): AsyncIterableIterator<Batch> {
  const source = pubsub.asyncIterator<DockerStatsMessage>(DOCKER_STATS_CHANNEL);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseSubscriber();
  };

  const iterator: AsyncIterableIterator<Batch> = {
    async next(): Promise<IteratorResult<Batch>> {
      const result = await source.next();
      if (result.done) {
        release();
        return { done: true, value: undefined };
      }
      if (result.value.kind === 'failure') {
        release();
        throw new GraphQLError(result.value.message);
      }
      return { done: false, value: result.value.samples };
    },
    async return(value?: unknown): Promise<IteratorResult<Batch>> {
      release();
      await source.return?.();
      return { done: true, value: value as Batch };
    },
    async throw(error?: unknown): Promise<IteratorResult<Batch>> {
      release();
      if (source.throw) return source.throw(error) as Promise<IteratorResult<Batch>>;
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return iterator;
}

/**
 * Entry point: acquires a subscriber slot (rejecting with a GraphQLError at
 * subscribe time if the engine is unreachable), then returns a relay that
 * releases the slot on disconnect.
 */
export async function subscribeDockerContainerStats(deps: DockerStatsDeps): Promise<AsyncIterable<Batch>> {
  await acquireSubscriber(deps);
  return createRelay();
}
