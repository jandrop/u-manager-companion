/**
 * Best-effort fs-watch cache invalidation on the key-store directory.
 *
 * The 60s validated-key cache TTL (context.ts, CONTEXT_CACHE_TTL_MS) is
 * the PRIMARY invalidation guarantee -- this module only ACCELERATES
 * invalidation when it can. Two layers, matching watcher.sh's existing
 * pattern (combined event classes + debounce) for the SAME underlying
 * reason: a single inotify event class is not fully trustworthy on the
 * FAT `/boot` mount:
 *
 *   1. fs.watch on the directory, debounced -- coalesces bursts of
 *      events (e.g. a key file being written, then a sibling touched)
 *      into a single invalidateAll() call.
 *   2. A poll fallback (re-stat the directory on an interval <= the
 *      cache TTL) that ALWAYS runs alongside the watcher, so a mount
 *      where fs.watch is silent (or throws outright, e.g. unsupported
 *      on some FAT/overlay setups) still gets invalidated within one
 *      TTL window -- never "stale forever."
 *
 * Both layers call the SAME onInvalidate callback (context.ts's
 * ContextCache#invalidateAll) -- an extra, redundant invalidation is
 * harmless (next request just re-resolves and re-caches); a MISSED one
 * is bounded by the poll interval, never unbounded.
 */
import { statSync, watch as nodeWatch, type FSWatcher } from 'node:fs';
import { CONTEXT_CACHE_TTL_MS } from '../context.js';

export interface KeyStoreWatchOptions {
  readonly dir: string;
  readonly onInvalidate: () => void;
  /** Coalesces bursts of fs.watch events into one invalidation call.
   * Default matches watcher.sh's DEBOUNCE_SECONDS=3 convention. */
  readonly debounceMs?: number;
  /** Poll-fallback interval. Must stay <= the cache TTL so the "never
   * stale longer than one TTL window" guarantee holds even with zero
   * working fs-watch events. Defaults to the TTL itself. */
  readonly pollIntervalMs?: number;
  /** Injectable for tests (avoids depending on a real inotify-capable
   * filesystem in the unit-test environment). Defaults to node:fs's
   * `watch`. */
  readonly watchFn?: typeof nodeWatch;
}

export interface KeyStoreWatchHandle {
  /** Stops both the fs.watch listener (if any) and the poll loop. */
  stop(): void;
}

const DEFAULT_DEBOUNCE_MS = 3_000;

function resolveMtimeMs(dir: string): number | null {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Starts best-effort fs-watch + poll-fallback invalidation on the
 * key-store directory. Always returns a handle -- a broken/unsupported
 * fs.watch never prevents the poll fallback from running (fail-safe:
 * degrade to poll-only rather than throw and leave the cache
 * unmonitored).
 */
export function startKeyStoreWatch(options: KeyStoreWatchOptions): KeyStoreWatchHandle {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const pollIntervalMs = Math.min(
    options.pollIntervalMs ?? CONTEXT_CACHE_TTL_MS,
    CONTEXT_CACHE_TTL_MS,
  );
  const watchFn = options.watchFn ?? nodeWatch;

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const invalidateDebounced = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      options.onInvalidate();
    }, debounceMs);
    debounceTimer.unref?.();
  };

  let watcher: FSWatcher | undefined;
  try {
    watcher = watchFn(options.dir, { persistent: false });
    watcher.on('change', () => {
      invalidateDebounced();
    });
    // fs.watch's 'error' event fires for conditions like the watched
    // directory being removed out from under it -- swallow and rely on
    // the poll fallback rather than crash the process.
    watcher.on('error', () => {
      /* no-op: poll fallback covers this */
    });
  } catch {
    // fs.watch unsupported on this platform/mount -- poll-only mode.
    watcher = undefined;
  }

  // Poll fallback: always runs, independent of whether fs.watch is
  // working -- ensures the cache is never stale for longer than one TTL
  // window even with zero working fs-watch events.
  let lastMtimeMs = resolveMtimeMs(options.dir);
  const pollTimer = setInterval(() => {
    const currentMtimeMs = resolveMtimeMs(options.dir);
    if (currentMtimeMs !== lastMtimeMs) {
      lastMtimeMs = currentMtimeMs;
      options.onInvalidate();
    }
  }, pollIntervalMs);
  pollTimer.unref?.();

  return {
    stop() {
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(pollTimer);
      watcher?.close();
    },
  };
}
