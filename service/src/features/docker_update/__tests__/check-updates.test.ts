import { describe, expect, it, vi } from 'vitest';
import type { AuditLogger } from '../../../audit.js';
import type { StreamedProcessRunner } from '../../../platform/process-runner.js';
import { checkForDockerUpdates } from '../check-updates.js';

function makeFakeAudit(): AuditLogger {
  return { recordAuditEvent: vi.fn() };
}

describe('checkForDockerUpdates', () => {
  it('returns true when the dockerupdate script exits 0', async () => {
    const runDockerUpdateScript: StreamedProcessRunner = vi.fn().mockResolvedValue({ exitCode: 0 });

    const result = await checkForDockerUpdates({
      runDockerUpdateScript,
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
    });

    expect(result).toBe(true);
  });

  it('returns false when the script exits non-zero', async () => {
    const runDockerUpdateScript: StreamedProcessRunner = vi.fn().mockResolvedValue({ exitCode: 1 });

    const result = await checkForDockerUpdates({
      runDockerUpdateScript,
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
    });

    expect(result).toBe(false);
  });

  it('invokes the dockerupdate CLI with no arguments', async () => {
    const runDockerUpdateScript: StreamedProcessRunner = vi.fn().mockResolvedValue({ exitCode: 0 });

    await checkForDockerUpdates({
      runDockerUpdateScript,
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
    });

    expect(runDockerUpdateScript).toHaveBeenCalledWith(
      expect.stringContaining('dockerupdate'),
      [],
      expect.any(Function),
    );
  });

  it('records an audit event with outcome matching the exit code', async () => {
    const audit = makeFakeAudit();
    const runDockerUpdateScript: StreamedProcessRunner = vi.fn().mockResolvedValue({ exitCode: 0 });

    await checkForDockerUpdates({ runDockerUpdateScript, audit, caller: { id: 'u1', name: 'admin' } });

    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'docker.checkForUpdates', outcome: 'succeeded' }),
    );
  });

  it('records outcome failed when the script exits non-zero', async () => {
    const audit = makeFakeAudit();
    const runDockerUpdateScript: StreamedProcessRunner = vi.fn().mockResolvedValue({ exitCode: 1 });

    await checkForDockerUpdates({ runDockerUpdateScript, audit, caller: { id: 'u1', name: 'admin' } });

    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'docker.checkForUpdates', outcome: 'failed' }),
    );
  });
});
