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
import type { ReadTemplateFile } from '../read-template.js';

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
    streamContainerStats: vi.fn().mockRejectedValue(new Error('not used in this test')),
    streamContainerEvents: vi.fn().mockRejectedValue(new Error('not used in this test')),
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

/** Default fake reader: no prior template on disk (ENOENT), matching most
 * existing tests' fixtures that don't care about fixedIp preservation. */
function makeFakeReadTemplateFile(): ReadTemplateFile {
  return vi.fn().mockRejectedValue({ code: 'ENOENT' });
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
      readTemplateFile: makeFakeReadTemplateFile(),
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
      readTemplateFile: makeFakeReadTemplateFile(),
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
      readTemplateFile: makeFakeReadTemplateFile(),
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
      readTemplateFile: makeFakeReadTemplateFile(),
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
      readTemplateFile: makeFakeReadTemplateFile(),
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
      readTemplateFile: makeFakeReadTemplateFile(),
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
      readTemplateFile: makeFakeReadTemplateFile(),
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
          readTemplateFile: makeFakeReadTemplateFile(),
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
      readTemplateFile: makeFakeReadTemplateFile(),
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('FAILED');
    });
  });

  describe('fixedIp preserve-on-edit (regression gate)', () => {
    function priorXmlWith(fixedIp: string): string {
      return [
        '<?xml version="1.0"?>',
        '<Container version="2">',
        '  <Name>plex</Name>',
        '  <Repository>lscr.io/linuxserver/plex</Repository>',
        `  <MyIP>${fixedIp}</MyIP>`,
        '</Container>',
        '',
      ].join('\n');
    }

    it('S5: input omitting fixedIp preserves the on-disk value', async () => {
      const writeTemplateFile: WriteTemplateFile = vi.fn().mockResolvedValue(undefined);
      const readTemplateFile: ReadTemplateFile = vi.fn().mockResolvedValue(priorXmlWith('192.168.1.2'));

      const op = editDockerTemplate(baseInput, {
        dockerClient: makeFakeDockerClient(),
        runRebuildContainer: makeFakeRebuild(),
        writeTemplateFile,
        readTemplateFile,
        audit: makeFakeAudit(),
        caller: { id: 'u1', name: 'admin' },
      });

      await vi.waitFor(() => {
        expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
      });
      expect(writeTemplateFile).toHaveBeenCalledWith('plex', expect.stringContaining('<MyIP>192.168.1.2</MyIP>'));
    });

    it('S6: an explicit input fixedIp overrides the on-disk value', async () => {
      const writeTemplateFile: WriteTemplateFile = vi.fn().mockResolvedValue(undefined);
      const readTemplateFile: ReadTemplateFile = vi.fn().mockResolvedValue(priorXmlWith('192.168.1.2'));

      const op = editDockerTemplate(
        { ...baseInput, fixedIp: '10.0.0.9' },
        {
          dockerClient: makeFakeDockerClient(),
          runRebuildContainer: makeFakeRebuild(),
          writeTemplateFile,
          readTemplateFile,
          audit: makeFakeAudit(),
          caller: { id: 'u1', name: 'admin' },
        },
      );

      await vi.waitFor(() => {
        expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
      });
      expect(writeTemplateFile).toHaveBeenCalledWith('plex', expect.stringContaining('<MyIP>10.0.0.9</MyIP>'));
    });

    it('S7: an unreadable (ENOENT) prior template still completes the edit, writing the empty placeholder', async () => {
      const writeTemplateFile: WriteTemplateFile = vi.fn().mockResolvedValue(undefined);
      const readTemplateFile: ReadTemplateFile = vi.fn().mockRejectedValue({ code: 'ENOENT' });

      const op = editDockerTemplate(baseInput, {
        dockerClient: makeFakeDockerClient(),
        runRebuildContainer: makeFakeRebuild(),
        writeTemplateFile,
        readTemplateFile,
        audit: makeFakeAudit(),
        caller: { id: 'u1', name: 'admin' },
      });

      await vi.waitFor(() => {
        expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
      });
      expect(writeTemplateFile).toHaveBeenCalledWith('plex', expect.stringContaining('<MyIP/>'));
    });

    it('S8: a non-ENOENT read failure degrades quietly (edit still succeeds, one progress line logged)', async () => {
      const writeTemplateFile: WriteTemplateFile = vi.fn().mockResolvedValue(undefined);
      const readTemplateFile: ReadTemplateFile = vi.fn().mockRejectedValue({ code: 'EACCES' });

      const op = editDockerTemplate(baseInput, {
        dockerClient: makeFakeDockerClient(),
        runRebuildContainer: makeFakeRebuild(),
        writeTemplateFile,
        readTemplateFile,
        audit: makeFakeAudit(),
        caller: { id: 'u1', name: 'admin' },
      });

      await vi.waitFor(() => {
        expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
      });
      expect(writeTemplateFile).toHaveBeenCalledWith('plex', expect.stringContaining('<MyIP/>'));
      const output = getSnapshot(op.id)?.output ?? [];
      expect(output.some((line) => /fixed ip|MyIP/i.test(line))).toBe(true);
    });

    it('S9: an empty-string input fixedIp behaves as absent, preserving the on-disk value', async () => {
      const writeTemplateFile: WriteTemplateFile = vi.fn().mockResolvedValue(undefined);
      const readTemplateFile: ReadTemplateFile = vi.fn().mockResolvedValue(priorXmlWith('192.168.1.2'));

      const op = editDockerTemplate(
        { ...baseInput, fixedIp: '' },
        {
          dockerClient: makeFakeDockerClient(),
          runRebuildContainer: makeFakeRebuild(),
          writeTemplateFile,
          readTemplateFile,
          audit: makeFakeAudit(),
          caller: { id: 'u1', name: 'admin' },
        },
      );

      await vi.waitFor(() => {
        expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
      });
      expect(writeTemplateFile).toHaveBeenCalledWith('plex', expect.stringContaining('<MyIP>192.168.1.2</MyIP>'));
    });
  });
});
