/**
 * docker_template/edit.ts tests.
 *
 * TDD: written before edit.ts exists -> RED first.
 *
 * Covers the edit pipeline: stop existing container, remove it, overwrite
 * my-<Name>.xml, pull the image ONLY if missing (never a stealth update --
 * the dedicated "Update Container" mutation is the unconditional-pull
 * path), rebuild via rebuild_container, audited. input.name must match the
 * EXISTING container (no rename support). There is no cosmetic log-line
 * rendering of the equivalent `docker run` command here -- it has no
 * functional effect on the edit outcome and would mean shelling out to
 * `php -r`, which this service avoids entirely.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuditLogger } from '../../../audit.js';
import type { DockerClient } from '../../../platform/docker-client.js';
import type { StreamedProcessRunner } from '../../../platform/process-runner.js';
import { getSnapshot } from '../../../operations/registry.js';
import { editDockerTemplate, type WriteTemplateFile } from '../edit.js';

function makeFakeDockerClient(overrides: Partial<DockerClient> = {}): DockerClient {
  return {
    getContainer: vi.fn(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue({
        Id: 'abc',
        Name: '/plex',
        Image: 'sha256:xyz',
        State: { Running: true },
        Config: { Image: 'lscr.io/linuxserver/plex' },
      }),
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
    onLine('Rebuilding plex...');
    return { exitCode };
  });
}

function makeFakeAudit(): AuditLogger {
  return { recordAuditEvent: vi.fn() };
}

const baseInput = {
  name: 'plex',
  repository: 'lscr.io/linuxserver/plex',
  configs: [],
};

describe('editDockerTemplate', () => {
  it('returns an operation snapshot immediately with status RUNNING', () => {
    const writeTemplateFile: WriteTemplateFile = vi.fn().mockResolvedValue(undefined);
    const audit = makeFakeAudit();

    const op = editDockerTemplate(baseInput, {
      dockerClient: makeFakeDockerClient(),
      runRebuildContainer: makeFakeRebuild(),
      writeTemplateFile,
      audit,
      caller: { id: 'u1', name: 'admin' },
    });

    expect(op.status).toBe('RUNNING');
  });

  it('records an audit event synchronously before returning', () => {
    const writeTemplateFile: WriteTemplateFile = vi.fn().mockResolvedValue(undefined);
    const audit = makeFakeAudit();

    editDockerTemplate(baseInput, {
      dockerClient: makeFakeDockerClient(),
      runRebuildContainer: makeFakeRebuild(),
      writeTemplateFile,
      audit,
      caller: { id: 'u1', name: 'admin' },
    });

    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'docker.templateEdit',
        target: 'plex',
        outcome: 'initiated',
      }),
    );
  });

  it('stops then removes the existing container before rewriting the template', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const dockerClient = makeFakeDockerClient({
      getContainer: vi.fn(() => ({
        start: vi.fn().mockResolvedValue(undefined),
        stop,
        remove,
        inspect: vi.fn().mockResolvedValue({
          Id: 'abc',
          Name: '/plex',
          Image: 'sha256:xyz',
          State: { Running: true },
          Config: { Image: 'lscr.io/linuxserver/plex' },
        }),
      })),
    });
    const writeTemplateFile: WriteTemplateFile = vi.fn().mockResolvedValue(undefined);

    const op = editDockerTemplate(baseInput, {
      dockerClient,
      runRebuildContainer: makeFakeRebuild(),
      writeTemplateFile,
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
    });
    expect(stop).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
    expect(writeTemplateFile).toHaveBeenCalledWith('plex', expect.stringContaining('<Repository>'));
  });

  it('skips the pull when the image already exists locally', async () => {
    const pull = vi.fn();
    const dockerClient = makeFakeDockerClient({
      getImage: vi.fn(() => ({
        inspect: vi.fn().mockResolvedValue({ RepoDigests: ['repo@sha256:already'] }),
        remove: vi.fn().mockResolvedValue(undefined),
      })),
      pull,
    });

    const op = editDockerTemplate(baseInput, {
      dockerClient,
      runRebuildContainer: makeFakeRebuild(),
      writeTemplateFile: vi.fn().mockResolvedValue(undefined),
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
    });
    expect(pull).not.toHaveBeenCalled();
  });

  it('pulls when the image is missing locally', async () => {
    const pull = vi.fn().mockResolvedValue(undefined);
    const dockerClient = makeFakeDockerClient({
      getImage: vi.fn(() => ({
        inspect: vi.fn().mockRejectedValue(new Error('no such image')),
        remove: vi.fn().mockResolvedValue(undefined),
      })),
      pull,
    });

    const op = editDockerTemplate(baseInput, {
      dockerClient,
      runRebuildContainer: makeFakeRebuild(),
      writeTemplateFile: vi.fn().mockResolvedValue(undefined),
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
    });
    expect(pull).toHaveBeenCalled();
  });

  it('does not call start() after rebuild -- rebuild_container handles autostart, calling start() would resurrect a stopped container', async () => {
    const start = vi.fn();
    const dockerClient = makeFakeDockerClient({
      getContainer: vi.fn(() => ({
        start,
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({
          Id: 'abc',
          Name: '/plex',
          Image: 'sha256:xyz',
          State: { Running: true },
          Config: { Image: 'lscr.io/linuxserver/plex' },
        }),
      })),
    });

    const op = editDockerTemplate(baseInput, {
      dockerClient,
      runRebuildContainer: makeFakeRebuild(),
      writeTemplateFile: vi.fn().mockResolvedValue(undefined),
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('treats a stop() 404 (already stopped/removed) as success, not failure', async () => {
    const dockerClient = makeFakeDockerClient({
      getContainer: vi.fn(() => ({
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockRejectedValue({ statusCode: 404 }),
        remove: vi.fn().mockRejectedValue({ statusCode: 404 }),
        inspect: vi.fn().mockResolvedValue({
          Id: 'abc',
          Name: '/plex',
          Image: 'sha256:xyz',
          State: { Running: true },
          Config: { Image: 'lscr.io/linuxserver/plex' },
        }),
      })),
    });

    const op = editDockerTemplate(baseInput, {
      dockerClient,
      runRebuildContainer: makeFakeRebuild(),
      writeTemplateFile: vi.fn().mockResolvedValue(undefined),
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
    });
  });

  it('rejects a name mismatch synchronously without any side effect', () => {
    expect(() =>
      editDockerTemplate(
        { ...baseInput, name: 'not valid name!' },
        {
          dockerClient: makeFakeDockerClient(),
          runRebuildContainer: makeFakeRebuild(),
          writeTemplateFile: vi.fn().mockResolvedValue(undefined),
          audit: makeFakeAudit(),
          caller: { id: 'u1', name: 'admin' },
        },
      ),
    ).toThrow(/Invalid container name/);
  });

  it('transitions to FAILED when rebuild_container exits non-zero', async () => {
    const op = editDockerTemplate(baseInput, {
      dockerClient: makeFakeDockerClient(),
      runRebuildContainer: makeFakeRebuild(1),
      writeTemplateFile: vi.fn().mockResolvedValue(undefined),
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('FAILED');
    });
  });
});
