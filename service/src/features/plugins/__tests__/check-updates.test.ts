/**
 * features/plugins/check-updates.ts tests.
 *
 * TDD: written before check-updates.ts exists -> RED first.
 *
 * Ported behavior target: plugin_check.py -- fires `plugin checkall`
 * DETACHED (fire-and-forget, matching the reference's execa
 * `{detached: true, stdio: 'ignore'}` + unref) and returns true
 * immediately WITHOUT waiting for the check to finish -- the reference's
 * comment is explicit: "the boolean does not indicate check outcome; the
 * client polls the list afterwards." NOT audited, since the read-only
 * update-check is not privileged -- this is the one privileged-adjacent
 * action in the whole feature surface that deliberately produces NO audit
 * record, so the test suite asserts a negative here as much as a
 * positive.
 */
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
