/**
 * docker_template/install.ts tests.
 *
 * TDD: written before install.ts exists -> RED first.
 *
 * Ported behavior target: docker_template_create.py's `start()`/
 * `runInstall()` pipeline -- write template XML, pull image (progress
 * lines), run rebuild_container (streamed), idempotent start() (304 =
 * already running), audited. Platform side effects (fs write, docker pull,
 * rebuild_container process, dockerode start) are ALL injected fakes here
 * -- this suite never touches a real filesystem path under
 * /boot/config/... or a real docker socket.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuditLogger } from '../../../audit.js';
import type { DockerClient, DockerPullProgressEvent } from '../../../platform/docker-client.js';
import type { StreamedProcessRunner } from '../../../platform/process-runner.js';
import { getSnapshot } from '../../../operations/registry.js';
import { installDockerTemplate, type WriteTemplateFile } from '../install.js';

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
    pull: vi.fn(async (_repoTag: string, onProgress: (e: DockerPullProgressEvent) => void) => {
      onProgress({ status: 'Downloading', id: 'layer1', progressDetail: { current: 50, total: 100 } });
      onProgress({ status: 'Pull complete', id: 'layer1' });
    }),
    pruneVolumes: vi.fn().mockResolvedValue(undefined),
    listContainers: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeFakeRebuild(exitCode = 0): StreamedProcessRunner {
  return vi.fn(async (_cmd, _args, onLine) => {
    onLine('Building container plex...');
    onLine('Done.');
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

describe('installDockerTemplate', () => {
  it('returns an operation snapshot immediately with status RUNNING', () => {
    const writeTemplateFile: WriteTemplateFile = vi.fn().mockResolvedValue(undefined);
    const audit = makeFakeAudit();

    const op = installDockerTemplate(baseInput, {
      dockerClient: makeFakeDockerClient(),
      runRebuildContainer: makeFakeRebuild(),
      writeTemplateFile,
      audit,
      caller: { id: 'u1', name: 'admin' },
    });

    expect(op.status).toBe('RUNNING');
    expect(op.subject).toMatchObject({ containerName: 'plex', repository: baseInput.repository });
  });

  it('records an audit event synchronously before returning', () => {
    const writeTemplateFile: WriteTemplateFile = vi.fn().mockResolvedValue(undefined);
    const audit = makeFakeAudit();

    installDockerTemplate(baseInput, {
      dockerClient: makeFakeDockerClient(),
      runRebuildContainer: makeFakeRebuild(),
      writeTemplateFile,
      audit,
      caller: { id: 'u1', name: 'admin' },
    });

    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'docker.templateInstall',
        caller: { id: 'u1', name: 'admin' },
        target: 'plex',
        outcome: 'initiated',
      }),
    );
  });

  it('rejects an invalid container name before any side effect runs', () => {
    const writeTemplateFile: WriteTemplateFile = vi.fn().mockResolvedValue(undefined);
    const audit = makeFakeAudit();

    expect(() =>
      installDockerTemplate(
        { ...baseInput, name: 'plex server!' },
        {
          dockerClient: makeFakeDockerClient(),
          runRebuildContainer: makeFakeRebuild(),
          writeTemplateFile,
          audit,
          caller: { id: 'u1', name: 'admin' },
        },
      ),
    ).toThrow(/Invalid container name/);
    expect(writeTemplateFile).not.toHaveBeenCalled();
    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });

  it('writes the template XML to the injected writer with the sanitised name', async () => {
    const writeTemplateFile: WriteTemplateFile = vi.fn().mockResolvedValue(undefined);
    const audit = makeFakeAudit();

    const op = installDockerTemplate(baseInput, {
      dockerClient: makeFakeDockerClient(),
      runRebuildContainer: makeFakeRebuild(),
      writeTemplateFile,
      audit,
      caller: { id: 'u1', name: 'admin' },
    });

    await vi.waitFor(() => {
      expect(writeTemplateFile).toHaveBeenCalledWith('plex', expect.stringContaining('<Repository>'));
    });
    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
    });
  });

  it('streams pull progress and rebuild_container output as delta lines, then succeeds', async () => {
    const writeTemplateFile: WriteTemplateFile = vi.fn().mockResolvedValue(undefined);
    const audit = makeFakeAudit();

    const op = installDockerTemplate(baseInput, {
      dockerClient: makeFakeDockerClient(),
      runRebuildContainer: makeFakeRebuild(),
      writeTemplateFile,
      audit,
      caller: { id: 'u1', name: 'admin' },
    });

    await vi.waitFor(() => {
      const snapshot = getSnapshot(op.id);
      expect(snapshot?.status).toBe('SUCCEEDED');
    });

    const snapshot = getSnapshot(op.id);
    const joined = (snapshot?.output ?? []).join('\n');
    expect(joined).toContain('Pulling image');
    expect(joined).toContain('Building container plex...');
    expect(joined).toContain('Starting container plex');
  });

  it('treats a 304 (already running) start() as success, not failure', async () => {
    const dockerClient = makeFakeDockerClient({
      getContainer: vi.fn(() => ({
        start: vi.fn().mockRejectedValue({ statusCode: 304 }),
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
    const writeTemplateFile: WriteTemplateFile = vi.fn().mockResolvedValue(undefined);
    const audit = makeFakeAudit();

    const op = installDockerTemplate(baseInput, {
      dockerClient,
      runRebuildContainer: makeFakeRebuild(),
      writeTemplateFile,
      audit,
      caller: { id: 'u1', name: 'admin' },
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
    });
    const joined = (getSnapshot(op.id)?.output ?? []).join('\n');
    expect(joined).toContain('already running');
  });

  it('transitions to FAILED when rebuild_container exits non-zero', async () => {
    const writeTemplateFile: WriteTemplateFile = vi.fn().mockResolvedValue(undefined);
    const audit = makeFakeAudit();

    const op = installDockerTemplate(baseInput, {
      dockerClient: makeFakeDockerClient(),
      runRebuildContainer: makeFakeRebuild(1),
      writeTemplateFile,
      audit,
      caller: { id: 'u1', name: 'admin' },
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('FAILED');
    });
  });

  it('transitions to FAILED when writing the template file rejects', async () => {
    const writeTemplateFile: WriteTemplateFile = vi.fn().mockRejectedValue(new Error('disk full'));
    const audit = makeFakeAudit();

    const op = installDockerTemplate(baseInput, {
      dockerClient: makeFakeDockerClient(),
      runRebuildContainer: makeFakeRebuild(),
      writeTemplateFile,
      audit,
      caller: { id: 'u1', name: 'admin' },
    });

    await vi.waitFor(() => {
      const snapshot = getSnapshot(op.id);
      expect(snapshot?.status).toBe('FAILED');
      expect(snapshot?.output.join('\n')).toContain('disk full');
    });
  });
});
