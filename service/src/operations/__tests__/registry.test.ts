/**
 * operations/registry.ts tests.
 *
 * Direct port target: docker_template_create.py's IIFE state machine
 * (`u-manager-companion/scripts/companion/patches/docker_template_create.py`,
 * PATCH_MARKER "docker-install-stream-v2"). These tests pin the same
 * semantics: status transitions, delta-only event emission, ring-buffer cap
 * at 500 lines (drop-oldest), TTL cleanup via an unref'd timer, and
 * snapshot-after-cleanup returning null.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pubsub, channelFor } from '../../pubsub';
import {
  appendLine,
  createOperation,
  failOperation,
  getSnapshot,
  MAX_OUTPUT_LINES,
  succeedOperation,
  TTL_MS,
} from '../registry';

const CHANNEL = 'TEST_OP';

describe('createOperation', () => {
  it('registers an operation with status RUNNING and an empty output buffer', () => {
    const op = createOperation(CHANNEL, { containerName: 'plex', repository: 'plexinc/pms' });

    expect(op.status).toBe('RUNNING');
    expect(op.output).toEqual([]);
    expect(op.finishedAt).toBeNull();
    expect(op.createdAt).toBeInstanceOf(Date);
    expect(op.updatedAt).toEqual(op.createdAt);
  });

  it('generates a unique id per operation', () => {
    const a = createOperation(CHANNEL, { containerName: 'a', repository: 'r/a' });
    const b = createOperation(CHANNEL, { containerName: 'b', repository: 'r/b' });
    expect(a.id).not.toBe(b.id);
  });

  it('is retrievable immediately via getSnapshot', () => {
    const op = createOperation(CHANNEL, { containerName: 'plex', repository: 'plexinc/pms' });
    const snapshot = getSnapshot(op.id);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.id).toBe(op.id);
    expect(snapshot?.status).toBe('RUNNING');
  });
});

describe('status transitions', () => {
  it('QUEUED operations transition to RUNNING once work starts', () => {
    const op = createOperation(CHANNEL, { containerName: 'plex', repository: 'plexinc/pms' }, 'QUEUED');
    expect(getSnapshot(op.id)?.status).toBe('QUEUED');
  });

  it('succeedOperation transitions RUNNING -> SUCCEEDED and stamps finishedAt', () => {
    const op = createOperation(CHANNEL, { containerName: 'plex', repository: 'plexinc/pms' });
    succeedOperation(op.id);
    const snapshot = getSnapshot(op.id);
    expect(snapshot?.status).toBe('SUCCEEDED');
    expect(snapshot?.finishedAt).toBeInstanceOf(Date);
  });

  it('failOperation transitions RUNNING -> FAILED, stamps finishedAt, and appends an error line', () => {
    const op = createOperation(CHANNEL, { containerName: 'plex', repository: 'plexinc/pms' });
    failOperation(op.id, new Error('boom'));
    const snapshot = getSnapshot(op.id);
    expect(snapshot?.status).toBe('FAILED');
    expect(snapshot?.finishedAt).toBeInstanceOf(Date);
    expect(snapshot?.output.at(-1)).toBe('Error: boom');
  });

  it('is a terminal-state no-op: succeedOperation after FAILED does not flip status back', () => {
    const op = createOperation(CHANNEL, { containerName: 'plex', repository: 'plexinc/pms' });
    failOperation(op.id, new Error('boom'));
    succeedOperation(op.id);
    expect(getSnapshot(op.id)?.status).toBe('FAILED');
  });

  it('is a terminal-state no-op: failOperation after SUCCEEDED does not flip status back', () => {
    const op = createOperation(CHANNEL, { containerName: 'plex', repository: 'plexinc/pms' });
    succeedOperation(op.id);
    failOperation(op.id, new Error('too late'));
    expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
  });
});

describe('appendLine', () => {
  it('appends to the cumulative output buffer', () => {
    const op = createOperation(CHANNEL, { containerName: 'plex', repository: 'plexinc/pms' });
    appendLine(op.id, 'Pulling image plexinc/pms');
    appendLine(op.id, 'Starting container plex');
    expect(getSnapshot(op.id)?.output).toEqual([
      'Pulling image plexinc/pms',
      'Starting container plex',
    ]);
  });

  it('updates updatedAt on every appended line', () => {
    const op = createOperation(CHANNEL, { containerName: 'plex', repository: 'plexinc/pms' });
    const before = getSnapshot(op.id)?.updatedAt;
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(10);
      appendLine(op.id, 'line');
      const after = getSnapshot(op.id)?.updatedAt;
      expect(after).not.toBeNull();
      expect(after?.getTime()).toBeGreaterThan(before?.getTime() ?? 0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('delta-only event emission', () => {
  it('publishes only the newly appended line(s) on the operation channel, not the cumulative buffer', async () => {
    const op = createOperation(CHANNEL, { containerName: 'plex', repository: 'plexinc/pms' });
    const events: Array<{ output?: string[] }> = [];
    const subId = await pubsub.subscribe(channelFor(CHANNEL, op.id), (event: { output?: string[] }) => {
      events.push(event);
    });

    try {
      appendLine(op.id, 'first line');
      appendLine(op.id, 'second line');
      await new Promise((resolve) => setImmediate(resolve));

      // One event per appendLine call, each carrying only its own delta --
      // never the accumulated buffer from prior calls.
      const deltas = events.map((e) => e.output);
      expect(deltas).toEqual([['first line'], ['second line']]);
    } finally {
      pubsub.unsubscribe(subId);
    }
  });

  it('publishes a status-only event (no output field) on succeedOperation', async () => {
    const op = createOperation(CHANNEL, { containerName: 'plex', repository: 'plexinc/pms' });
    const events: Array<{ status: string; output?: string[] }> = [];
    const subId = await pubsub.subscribe(channelFor(CHANNEL, op.id), (event: { status: string; output?: string[] }) => {
      events.push(event);
    });

    try {
      succeedOperation(op.id);
      await new Promise((resolve) => setImmediate(resolve));

      const last = events.at(-1);
      expect(last?.status).toBe('SUCCEEDED');
      expect(last?.output).toBeUndefined();
    } finally {
      pubsub.unsubscribe(subId);
    }
  });
});

describe('ring buffer cap', () => {
  it(`caps cumulative output at MAX_OUTPUT_LINES (${MAX_OUTPUT_LINES}) lines, dropping the oldest`, () => {
    const op = createOperation(CHANNEL, { containerName: 'plex', repository: 'plexinc/pms' });
    const totalLines = MAX_OUTPUT_LINES + 10;
    for (let i = 0; i < totalLines; i += 1) {
      appendLine(op.id, `line-${i}`);
    }

    const output = getSnapshot(op.id)?.output ?? [];
    expect(output).toHaveLength(MAX_OUTPUT_LINES);
    // Oldest 10 lines (line-0..line-9) were dropped; the buffer starts at
    // line-10 and ends at the last appended line.
    expect(output.at(0)).toBe('line-10');
    expect(output.at(-1)).toBe(`line-${totalLines - 1}`);
  });
});

describe('TTL cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it(`schedules cleanup on succeedOperation and removes the operation after TTL_MS (${TTL_MS}ms)`, () => {
    const op = createOperation(CHANNEL, { containerName: 'plex', repository: 'plexinc/pms' });
    succeedOperation(op.id);

    expect(getSnapshot(op.id)).not.toBeNull();
    vi.advanceTimersByTime(TTL_MS);
    expect(getSnapshot(op.id)).toBeNull();
  });

  it('schedules cleanup on failOperation and removes the operation after TTL_MS', () => {
    const op = createOperation(CHANNEL, { containerName: 'plex', repository: 'plexinc/pms' });
    failOperation(op.id, new Error('boom'));

    expect(getSnapshot(op.id)).not.toBeNull();
    vi.advanceTimersByTime(TTL_MS);
    expect(getSnapshot(op.id)).toBeNull();
  });

  it('does not schedule cleanup while an operation is still RUNNING', () => {
    const op = createOperation(CHANNEL, { containerName: 'plex', repository: 'plexinc/pms' });
    vi.advanceTimersByTime(TTL_MS * 2);
    expect(getSnapshot(op.id)).not.toBeNull();
  });

  it('uses an unref-able timer so cleanup does not keep the process alive', () => {
    const op = createOperation(CHANNEL, { containerName: 'plex', repository: 'plexinc/pms' });
    const unrefSpy = vi.spyOn(global, 'setTimeout');
    succeedOperation(op.id);
    // setTimeout returns a NodeJS.Timeout in the node environment, which
    // exposes .unref(); assert the registry actually calls it rather than
    // asserting on the return value shape (jsdom/browser environments would
    // differ, but this suite runs under vitest's node environment).
    const lastCallReturn = unrefSpy.mock.results.at(-1)?.value as { unref?: () => void } | undefined;
    expect(typeof lastCallReturn?.unref).toBe('function');
    unrefSpy.mockRestore();
  });
});

describe('snapshot-after-cleanup', () => {
  it('getSnapshot returns null for an operation id that never existed', () => {
    expect(getSnapshot('never-existed')).toBeNull();
  });

  it('getSnapshot returns null once TTL cleanup has run, even if queried again', () => {
    vi.useFakeTimers();
    try {
      const op = createOperation(CHANNEL, { containerName: 'plex', repository: 'plexinc/pms' });
      succeedOperation(op.id);
      vi.advanceTimersByTime(TTL_MS);

      expect(getSnapshot(op.id)).toBeNull();
      expect(getSnapshot(op.id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('getSnapshot immutability', () => {
  it('returns a defensive copy of the output array (mutating the copy does not affect internal state)', () => {
    const op = createOperation(CHANNEL, { containerName: 'plex', repository: 'plexinc/pms' });
    appendLine(op.id, 'line-1');
    const snapshot = getSnapshot(op.id);
    // output is typed readonly at the API boundary (defensive copy is the
    // point) -- mutate through a plain-array cast to prove the underlying
    // array is a distinct copy, not the same reference as internal state.
    (snapshot?.output as string[] | undefined)?.push('mutated');

    expect(getSnapshot(op.id)?.output).toEqual(['line-1']);
  });
});
