/**
 * docker_template/delete.ts tests.
 *
 * TDD: written before delete.ts exists -> RED first.
 *
 * Ported behavior target: docker_template_delete.py's `uninstallLikeWebUi`/
 * `deleteTemplate` -- stop if running, remove container, optionally remove
 * image (swallowing 409 ImageInUse) + prune volumes, LEAVE the
 * user-template XML in place so it resurfaces as a "Previous App". This
 * mutation is SYNCHRONOUS (schema: `Boolean!`, no streamed operation) --
 * unlike install/edit, matching the SDL in schema.graphql exactly.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuditLogger } from '../../../audit.js';
import type { DockerClient } from '../../../platform/docker-client.js';
import { deleteDockerTemplate } from '../delete.js';

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

function makeFakeAudit(): AuditLogger {
  return { recordAuditEvent: vi.fn() };
}

describe('deleteDockerTemplate', () => {
  it('stops a running container, removes it, removes the image, and prunes volumes by default', async () => {
    const inspect = vi.fn().mockResolvedValue({
      Id: 'abc',
      Name: '/plex',
      Image: 'sha256:xyz',
      State: { Running: true },
      Config: { Image: 'lscr.io/linuxserver/plex' },
    });
    const stop = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const removeImage = vi.fn().mockResolvedValue(undefined);
    const pruneVolumes = vi.fn().mockResolvedValue(undefined);
    const dockerClient = makeFakeDockerClient({
      getContainer: vi.fn(() => ({ start: vi.fn(), stop, remove, inspect })),
      getImage: vi.fn(() => ({ inspect: vi.fn(), remove: removeImage })),
      pruneVolumes,
    });

    const result = await deleteDockerTemplate('plex', undefined, undefined, {
      dockerClient,
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
    });

    expect(result).toBe(true);
    expect(stop).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith({ force: false, v: false });
    expect(removeImage).toHaveBeenCalled();
    expect(pruneVolumes).toHaveBeenCalled();
  });

  it('does not stop an already-stopped container', async () => {
    const inspect = vi.fn().mockResolvedValue({
      Id: 'abc',
      Name: '/plex',
      Image: 'sha256:xyz',
      State: { Running: false },
      Config: { Image: 'lscr.io/linuxserver/plex' },
    });
    const stop = vi.fn().mockResolvedValue(undefined);
    const dockerClient = makeFakeDockerClient({
      getContainer: vi.fn(() => ({ start: vi.fn(), stop, remove: vi.fn().mockResolvedValue(undefined), inspect })),
    });

    await deleteDockerTemplate('plex', undefined, undefined, {
      dockerClient,
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
    });

    expect(stop).not.toHaveBeenCalled();
  });

  it('skips image removal and volume prune when removeImage is false', async () => {
    const removeImage = vi.fn().mockResolvedValue(undefined);
    const pruneVolumes = vi.fn().mockResolvedValue(undefined);
    const dockerClient = makeFakeDockerClient({
      getImage: vi.fn(() => ({ inspect: vi.fn(), remove: removeImage })),
      pruneVolumes,
    });

    await deleteDockerTemplate('plex', true, false, {
      dockerClient,
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
    });

    expect(removeImage).not.toHaveBeenCalled();
    expect(pruneVolumes).not.toHaveBeenCalled();
  });

  it('swallows a 409 ImageInUse error when removing the image', async () => {
    const removeImage = vi.fn().mockRejectedValue({ statusCode: 409 });
    const dockerClient = makeFakeDockerClient({
      getImage: vi.fn(() => ({ inspect: vi.fn(), remove: removeImage })),
    });

    await expect(
      deleteDockerTemplate('plex', undefined, undefined, {
        dockerClient,
        audit: makeFakeAudit(),
        caller: { id: 'u1', name: 'admin' },
      }),
    ).resolves.toBe(true);
  });

  it('treats a 404 on inspect/remove as "nothing to remove", returning true (idempotent)', async () => {
    const inspect = vi.fn().mockRejectedValue({ statusCode: 404 });
    const dockerClient = makeFakeDockerClient({
      getContainer: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), remove: vi.fn(), inspect })),
    });

    const result = await deleteDockerTemplate('plex', undefined, undefined, {
      dockerClient,
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
    });

    expect(result).toBe(true);
  });

  it('returns false without touching docker when removeContainer is explicitly false', async () => {
    const inspect = vi.fn();
    const dockerClient = makeFakeDockerClient({
      getContainer: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), remove: vi.fn(), inspect })),
    });

    const result = await deleteDockerTemplate('plex', false, undefined, {
      dockerClient,
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
    });

    expect(result).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('rejects an invalid name synchronously', async () => {
    await expect(
      deleteDockerTemplate('bad name!', undefined, undefined, {
        dockerClient: makeFakeDockerClient(),
        audit: makeFakeAudit(),
        caller: { id: 'u1', name: 'admin' },
      }),
    ).rejects.toThrow(/Invalid container name/);
  });

  it('records an audit event with outcome succeeded on completion', async () => {
    const audit = makeFakeAudit();

    await deleteDockerTemplate('plex', undefined, undefined, {
      dockerClient: makeFakeDockerClient(),
      audit,
      caller: { id: 'u1', name: 'admin' },
    });

    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'docker.templateDelete',
        target: 'plex',
        outcome: 'succeeded',
      }),
    );
  });

  it('records an audit event with outcome failed when a non-404/409 error propagates', async () => {
    const audit = makeFakeAudit();
    const dockerClient = makeFakeDockerClient({
      getContainer: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        remove: vi.fn(),
        inspect: vi.fn().mockRejectedValue({ statusCode: 500 }),
      })),
    });

    await expect(
      deleteDockerTemplate('plex', undefined, undefined, {
        dockerClient,
        audit,
        caller: { id: 'u1', name: 'admin' },
      }),
    ).rejects.toBeTruthy();

    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'docker.templateDelete', outcome: 'failed' }),
    );
  });
});
