/**
 * docker_update/update.ts tests.
 *
 * TDD: written before update.ts exists -> RED first.
 *
 * Ported behavior target: docker_update_stream.py's `updateOne()`/
 * `startOne()`/`startAll()` pipeline -- pull, stop-if-running, remove,
 * rebuild_container, restart-if-was-running-and-not-auto-restarted,
 * best-effort orphan-image removal. Update-all reads updatable targets and
 * runs the per-container pipeline sequentially under ONE operation,
 * aggregating output. Concurrency: refuses to start a new update while one
 * is in flight (module-level `busy` flag, ported verbatim). Both mutations
 * are audited on start.
 *
 * The reference `syncUpdateStatusForRepo()` (rewriting
 * unraid-update-status.json + docker.json webui-info cache) IS ported --
 * without it the update pipeline recreates the container but never
 * refreshes Unraid's on-disk update-status caches, so the "update
 * available" badge persists in the app even after a successful update.
 * Runs after a successful rebuild, for both single update and update-all
 * (wired inside `updateOne`).
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { AuditLogger } from '../../../audit.js';
import type { DockerClient } from '../../../platform/docker-client.js';
import type { StreamedProcessRunner } from '../../../platform/process-runner.js';
import { getSnapshot } from '../../../operations/registry.js';
import { updateContainerStream, updateAllContainersStream, __resetUpdateBusyForTests } from '../update.js';

let dir: string;
let updateStatusPath: string;
let dockerWebuiInfoPath: string;

beforeEach(() => {
  __resetUpdateBusyForTests();
  dir = mkdtempSync(path.join(tmpdir(), 'companion-docker-update-'));
  updateStatusPath = path.join(dir, 'unraid-update-status.json');
  dockerWebuiInfoPath = path.join(dir, 'docker.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeContainerInspect(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    Id: 'abc',
    Name: '/plex',
    Image: 'sha256:new',
    State: { Running: true },
    Config: { Image: 'lscr.io/linuxserver/plex' },
    ...overrides,
  };
}

function makeFakeDockerClient(overrides: Partial<DockerClient> = {}): DockerClient {
  return {
    getContainer: vi.fn(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue(makeContainerInspect()),
    })),
    getImage: vi.fn(() => ({
      inspect: vi.fn().mockResolvedValue({ RepoDigests: [] }),
      remove: vi.fn().mockResolvedValue(undefined),
    })),
    pull: vi.fn().mockResolvedValue(undefined),
    pruneVolumes: vi.fn().mockResolvedValue(undefined),
    listContainers: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeFakeRebuild(exitCode = 0): StreamedProcessRunner {
  return vi.fn(async (_cmd, _args, onLine) => {
    onLine('rebuild done');
    return { exitCode };
  });
}

function makeFakeAudit(): AuditLogger {
  return { recordAuditEvent: vi.fn() };
}

describe('updateContainerStream', () => {
  it('returns an operation snapshot immediately with status RUNNING', () => {
    const op = updateContainerStream('plex', {
      dockerClient: makeFakeDockerClient(),
      runRebuildContainer: makeFakeRebuild(),
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
      updateStatusPath,
      dockerWebuiInfoPath,
    });

    expect(op.status).toBe('RUNNING');
  });

  it('records an audit event on start', () => {
    const audit = makeFakeAudit();
    updateContainerStream('plex', {
      dockerClient: makeFakeDockerClient(),
      runRebuildContainer: makeFakeRebuild(),
      audit,
      caller: { id: 'u1', name: 'admin' },
      updateStatusPath,
      dockerWebuiInfoPath,
    });

    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'docker.updateStream', outcome: 'initiated' }),
    );
  });

  it('pulls, stops, removes, rebuilds, and restarts a previously-running container', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    let inspectCallCount = 0;
    const inspect = vi.fn().mockImplementation(async () => {
      inspectCallCount += 1;
      // First inspect (pre-update snapshot): running. Second inspect
      // (post-rebuild snapshot): rebuild_container did NOT auto-restart it
      // (not in autostart list), so update.ts must call start() itself.
      return makeContainerInspect({ State: { Running: inspectCallCount === 1 } });
    });
    const dockerClient = makeFakeDockerClient({
      getContainer: vi.fn(() => ({ start, stop, remove, inspect })),
    });

    const op = updateContainerStream('plex', {
      dockerClient,
      runRebuildContainer: makeFakeRebuild(),
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
      updateStatusPath,
      dockerWebuiInfoPath,
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
    });
    expect(stop).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
    expect(start).toHaveBeenCalled();
  });

  it('does not restart a container that rebuild_container already auto-restarted', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const inspect = vi.fn().mockResolvedValue(makeContainerInspect({ State: { Running: true } }));
    const dockerClient = makeFakeDockerClient({
      getContainer: vi.fn(() => ({
        start,
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect,
      })),
    });

    const op = updateContainerStream('plex', {
      dockerClient,
      runRebuildContainer: makeFakeRebuild(),
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
      updateStatusPath,
      dockerWebuiInfoPath,
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('rejects a second concurrent update while one is in flight', () => {
    updateContainerStream('plex', {
      dockerClient: makeFakeDockerClient(),
      runRebuildContainer: makeFakeRebuild(),
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
      updateStatusPath,
      dockerWebuiInfoPath,
    });

    expect(() =>
      updateContainerStream('other', {
        dockerClient: makeFakeDockerClient(),
        runRebuildContainer: makeFakeRebuild(),
        audit: makeFakeAudit(),
        caller: { id: 'u1', name: 'admin' },
        updateStatusPath,
        dockerWebuiInfoPath,
      }),
    ).toThrow(/already in progress/);
  });

  it('transitions to FAILED when rebuild_container exits non-zero', async () => {
    const op = updateContainerStream('plex', {
      dockerClient: makeFakeDockerClient(),
      runRebuildContainer: makeFakeRebuild(1),
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
      updateStatusPath,
      dockerWebuiInfoPath,
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('FAILED');
    });
  });
});

describe('updateAllContainersStream', () => {
  it('reports "no updates" and succeeds immediately when nothing is updatable', async () => {
    const op = updateAllContainersStream({
      dockerClient: makeFakeDockerClient({ listContainers: vi.fn().mockResolvedValue([]) }),
      runRebuildContainer: makeFakeRebuild(),
      listUpdatableContainerNames: vi.fn().mockResolvedValue([]),
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
      updateStatusPath,
      dockerWebuiInfoPath,
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
    });
    const joined = (getSnapshot(op.id)?.output ?? []).join('\n');
    expect(joined).toMatch(/no.*update/i);
  });

  it('updates every target sequentially under one operation', async () => {
    const op = updateAllContainersStream({
      dockerClient: makeFakeDockerClient(),
      runRebuildContainer: makeFakeRebuild(),
      listUpdatableContainerNames: vi.fn().mockResolvedValue(['plex', 'sonarr']),
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
      updateStatusPath,
      dockerWebuiInfoPath,
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
    });
    const joined = (getSnapshot(op.id)?.output ?? []).join('\n');
    expect(joined).toContain('plex');
    expect(joined).toContain('sonarr');
  });

  it('fails the whole operation listing failed containers when one target errors, but continues the rest', async () => {
    let call = 0;
    const runRebuildContainer: StreamedProcessRunner = vi.fn(async (_cmd, args, onLine) => {
      call += 1;
      // args[0] is the encoded container name -- fail on the first only.
      onLine(`processing ${args[0]}`);
      return { exitCode: call === 1 ? 1 : 0 };
    });

    const op = updateAllContainersStream({
      dockerClient: makeFakeDockerClient(),
      runRebuildContainer,
      listUpdatableContainerNames: vi.fn().mockResolvedValue(['plex', 'sonarr']),
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
      updateStatusPath,
      dockerWebuiInfoPath,
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('FAILED');
    });
    const joined = (getSnapshot(op.id)?.output ?? []).join('\n');
    expect(joined).toContain('sonarr');
  });
});

describe('update-status cache sync', () => {
  it('writes the update-status and webui-info caches after a successful update', async () => {
    const dockerClient = makeFakeDockerClient({
      getImage: vi.fn(() => ({
        inspect: vi.fn().mockResolvedValue({ RepoDigests: ['lscr.io/linuxserver/plex@sha256:deadbeef'] }),
        remove: vi.fn().mockResolvedValue(undefined),
      })),
    });

    const op = updateContainerStream('plex', {
      dockerClient,
      runRebuildContainer: makeFakeRebuild(),
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
      updateStatusPath,
      dockerWebuiInfoPath,
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
    });

    const updateStatus: unknown = JSON.parse(readFileSync(updateStatusPath, 'utf8'));
    expect(updateStatus).toEqual({
      'lscr.io/linuxserver/plex:latest': {
        local: 'sha256:deadbeef',
        remote: 'sha256:deadbeef',
        status: 'true',
      },
    });

    const webuiInfo: unknown = JSON.parse(readFileSync(dockerWebuiInfoPath, 'utf8'));
    expect(webuiInfo).toEqual({ plex: { updated: 'true' } });
  });

  it('syncs the update-status caches for every target in an update-all run', async () => {
    const dockerClient = makeFakeDockerClient({
      getContainer: vi.fn((idOrName: string) => ({
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue(
          makeContainerInspect({
            Name: `/${idOrName}`,
            Config: { Image: `lscr.io/linuxserver/${idOrName}` },
          }),
        ),
      })),
      getImage: vi.fn(() => ({
        inspect: vi.fn().mockResolvedValue({ RepoDigests: ['repo@sha256:deadbeef'] }),
        remove: vi.fn().mockResolvedValue(undefined),
      })),
    });

    const op = updateAllContainersStream({
      dockerClient,
      runRebuildContainer: makeFakeRebuild(),
      listUpdatableContainerNames: vi.fn().mockResolvedValue(['plex', 'sonarr']),
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
      updateStatusPath,
      dockerWebuiInfoPath,
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
    });

    const webuiInfo: unknown = JSON.parse(readFileSync(dockerWebuiInfoPath, 'utf8'));
    expect(webuiInfo).toEqual({
      plex: { updated: 'true' },
      sonarr: { updated: 'true' },
    });
  });

  it('does not fail the update when the cache sync itself errors', async () => {
    // Point the update-status path at a directory (not a file) so the
    // write fails -- verifies the try/catch inside syncUpdateStatusForRepo
    // makes this non-fatal to the overall operation.
    const unwritablePath = dir;
    const dockerClient = makeFakeDockerClient({
      getImage: vi.fn(() => ({
        inspect: vi.fn().mockResolvedValue({ RepoDigests: ['repo@sha256:deadbeef'] }),
        remove: vi.fn().mockResolvedValue(undefined),
      })),
    });

    const op = updateContainerStream('plex', {
      dockerClient,
      runRebuildContainer: makeFakeRebuild(),
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
      updateStatusPath: unwritablePath,
      dockerWebuiInfoPath,
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
    });
    const joined = (getSnapshot(op.id)?.output ?? []).join('\n');
    expect(joined).toContain('Could not sync update-status');
  });
});
