/**
 * docker-client.ts tests -- the NDJSON splitter + the two stream methods.
 *
 * TDD: written before the splitter/stream methods exist -> RED first.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type Docker from 'dockerode';
import { createDockerClient, createNdjsonSplitter } from '../docker-client.js';

describe('createNdjsonSplitter', () => {
  it('reassembles one JSON object split across two chunks', () => {
    const onObject = vi.fn();
    const split = createNdjsonSplitter<{ read: string }>(onObject, vi.fn());

    split('{"read":"20');
    expect(onObject).not.toHaveBeenCalled();
    split('26-08-16"}\n');

    expect(onObject).toHaveBeenCalledTimes(1);
    expect(onObject).toHaveBeenCalledWith({ read: '2026-08-16' });
  });

  it('splits two coalesced JSON objects delivered in one chunk', () => {
    const onObject = vi.fn();
    const split = createNdjsonSplitter<{ id: number }>(onObject, vi.fn());

    split('{"id":1}\n{"id":2}\n');

    expect(onObject).toHaveBeenCalledTimes(2);
    expect(onObject).toHaveBeenNthCalledWith(1, { id: 1 });
    expect(onObject).toHaveBeenNthCalledWith(2, { id: 2 });
  });

  it('reports a malformed line via onDecodeError and keeps delivering the next one', () => {
    const onObject = vi.fn();
    const onDecodeError = vi.fn();
    const split = createNdjsonSplitter<{ id: number }>(onObject, onDecodeError);

    split('{not json}\n{"id":1}\n');

    expect(onDecodeError).toHaveBeenCalledTimes(1);
    expect(onDecodeError).toHaveBeenCalledWith(expect.anything(), '{not json}');
    expect(onObject).toHaveBeenCalledTimes(1);
    expect(onObject).toHaveBeenCalledWith({ id: 1 });
  });
});

/** Minimal fake dockerode ReadableStream: a plain EventEmitter plus a
 * spyable destroy(), which is everything attachHandlers/the stream methods
 * touch. Full dockerode stream typing is far larger than needed here. */
function fakeReadable(): NodeJS.ReadableStream & { destroy: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { destroy: vi.fn() }) as unknown as NodeJS.ReadableStream & {
    destroy: ReturnType<typeof vi.fn>;
  };
}

describe('createDockerClient -- streamContainerStats', () => {
  it('decodes chunks off the container stats stream and reports onEnd', async () => {
    const stream = fakeReadable();
    const statsMock = vi.fn().mockResolvedValue(stream);
    const fakeDockerode = {
      getContainer: vi.fn().mockReturnValue({ stats: statsMock }),
    } as unknown as Docker;
    const client = createDockerClient(fakeDockerode);

    const onChunk = vi.fn();
    const onEnd = vi.fn();
    const handle = await client.streamContainerStats('abc123', {
      onChunk,
      onDecodeError: vi.fn(),
      onError: vi.fn(),
      onEnd,
    });

    stream.emit('data', Buffer.from(`${JSON.stringify({ read: '2026-08-16T00:00:00Z' })}\n`));
    expect(onChunk).toHaveBeenCalledWith({ read: '2026-08-16T00:00:00Z' });

    stream.emit('end');
    expect(onEnd).toHaveBeenCalledTimes(1);

    handle.destroy();
    handle.destroy();
    expect(stream.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('createDockerClient -- streamContainerEvents', () => {
  it('decodes chunks off the daemon events stream and reports onError', async () => {
    const stream = fakeReadable();
    const fakeDockerode = {
      getEvents: vi.fn().mockResolvedValue(stream),
    } as unknown as Docker;
    const client = createDockerClient(fakeDockerode);

    const onChunk = vi.fn();
    const onError = vi.fn();
    const handle = await client.streamContainerEvents({
      onChunk,
      onDecodeError: vi.fn(),
      onError,
      onEnd: vi.fn(),
    });

    stream.emit('data', Buffer.from(`${JSON.stringify({ status: 'start', id: 'c1' })}\n`));
    expect(onChunk).toHaveBeenCalledWith({ status: 'start', id: 'c1' });

    const boom = new Error('socket reset');
    stream.emit('error', boom);
    expect(onError).toHaveBeenCalledWith(boom);

    handle.destroy();
  });
});
