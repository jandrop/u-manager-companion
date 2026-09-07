import { describe, expect, it, vi } from 'vitest';
import type { AuditLogger } from '../../../audit.js';
import type { DetachedProcessRunner } from '../../../platform/process-runner.js';
import { checkForPluginUpdates } from '../check-updates.js';

function makeFakeAudit(): AuditLogger {
  return { recordAuditEvent: vi.fn() };
}

describe('checkForPluginUpdates', () => {
  it('returns true immediately without waiting for the check to finish', () => {
    const runDetached: DetachedProcessRunner = vi.fn();

    const result = checkForPluginUpdates({ runDetached, audit: makeFakeAudit() });

    expect(result).toBe(true);
  });

  it('fires `plugin checkall` detached', () => {
    const runDetached: DetachedProcessRunner = vi.fn();

    checkForPluginUpdates({ runDetached, audit: makeFakeAudit() });

    expect(runDetached).toHaveBeenCalledWith(expect.stringContaining('plugin'), ['checkall']);
  });

  it('does NOT record an audit event -- non-privileged read', () => {
    const audit = makeFakeAudit();
    checkForPluginUpdates({ runDetached: vi.fn(), audit });

    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });
});
