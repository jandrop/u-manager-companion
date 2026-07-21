/**
 * fs-watch BEST-EFFORT cache invalidation on key-store files.
 *
 * The 60s TTL (context.ts) is the PRIMARY guarantee; this module is an
 * accelerator only, mirroring watcher.sh's combined-event + debounce
 * pattern (rename/change events are not fully reliable on the FAT
 * /boot mount) PLUS a poll fallback (re-stat on an interval <= TTL) so
 * the cache is never stale for longer than one TTL window even with
 * zero working fs-watch events (the "simulated-silent fs-watch ->
 * poll-fallback path").
 *
 * TDD: written before watch.ts exists -> RED first.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startKeyStoreWatch } from '../watch.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'companion-watch-'));
  vi.useFakeTimers();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startKeyStoreWatch', () => {
  it('debounces multiple rapid fs events into a single invalidation call', () => {
    const invalidate = vi.fn();
    const fakeWatcher = { on: vi.fn(), close: vi.fn() };
    const watchFn = vi.fn().mockReturnValue(fakeWatcher);

    const handle = startKeyStoreWatch({
      dir,
      onInvalidate: invalidate,
      debounceMs: 200,
      pollIntervalMs: 60_000,
      watchFn: watchFn as unknown as typeof import('node:fs').watch,
    });

    // Grab the listener the module registered with fs.watch and fire it
    // multiple times rapidly, simulating close_write + moved_to + create
    // all landing for the same underlying change.
    const listener = fakeWatcher.on.mock.calls.find(([event]) => event === 'change')?.[1] as
      | (() => void)
      | undefined;
    expect(listener).toBeTypeOf('function');

    listener?.();
    vi.advanceTimersByTime(50);
    listener?.();
    vi.advanceTimersByTime(50);
    listener?.();

    // Not yet fired -- still within the debounce window from the last event.
    expect(invalidate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(invalidate).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('falls back to polling on an interval <= TTL when fs.watch throws (simulated-silent fs-watch)', () => {
    const invalidate = vi.fn();
    const watchFn = vi.fn().mockImplementation(() => {
      throw new Error('fs.watch unsupported on this mount');
    });

    const handle = startKeyStoreWatch({
      dir,
      onInvalidate: invalidate,
      debounceMs: 200,
      pollIntervalMs: 1_000,
      watchFn: watchFn as unknown as typeof import('node:fs').watch,
    });

    // No fs.watch event possible (it threw) -- poll fallback must still
    // detect the directory mtime change and invalidate.
    writeFileSync(path.join(dir, 'new-key.json'), '{}', 'utf8');

    vi.advanceTimersByTime(1_000);
    expect(invalidate).toHaveBeenCalled();

    handle.stop();
  });

  it('poll fallback interval is bounded to at most the cache TTL by default', () => {
    const invalidate = vi.fn();
    const watchFn = vi.fn().mockImplementation(() => {
      throw new Error('unsupported');
    });

    const handle = startKeyStoreWatch({
      dir,
      onInvalidate: invalidate,
      watchFn: watchFn as unknown as typeof import('node:fs').watch,
    });

    // Default poll interval must be <= 60s (CONTEXT_CACHE_TTL_MS) so the
    // "never stale longer than one TTL window" guarantee holds even with
    // zero working fs-watch events.
    writeFileSync(path.join(dir, 'another-key.json'), '{}', 'utf8');
    vi.advanceTimersByTime(60_000);
    expect(invalidate).toHaveBeenCalled();

    handle.stop();
  });

  it('stop() halts both the debounce timer and the poll loop', () => {
    const invalidate = vi.fn();
    const fakeWatcher = { on: vi.fn(), close: vi.fn() };
    const watchFn = vi.fn().mockReturnValue(fakeWatcher);

    const handle = startKeyStoreWatch({
      dir,
      onInvalidate: invalidate,
      debounceMs: 200,
      pollIntervalMs: 1_000,
      watchFn: watchFn as unknown as typeof import('node:fs').watch,
    });

    handle.stop();
    expect(fakeWatcher.close).toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
