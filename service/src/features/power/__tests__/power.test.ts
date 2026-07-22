/**
 * features/power tests.
 *
 * TDD: written before power.ts exists -> RED first.
 *
 * Covers the ServerService power methods: shutdown -> `/sbin/poweroff`,
 * reboot -> `/sbin/reboot`, both detached fire-and-forget. sleep ->
 * guarded on the Dynamix S3 Sleep plugin script existing, then detached
 * `rc.s3sleep`. CRITICAL ordering pin: the log must survive process
 * death, so the audit entry MUST be recorded BEFORE the detached call
 * fires, since /sbin/poweroff or /sbin/reboot can terminate this process
 * before a completion signal could ever be recorded -- these tests assert
 * call ORDER, not just that both happened.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuditLogger } from '../../../audit.js';
import type { DetachedProcessRunner } from '../../../platform/process-runner.js';
import { rebootServer, shutdownServer, sleepServer } from '../power.js';

function makeFakeAudit(): { audit: AuditLogger; calls: string[] } {
  const calls: string[] = [];
  return {
    audit: {
      recordAuditEvent: vi.fn((event) => {
        calls.push(`audit:${event.action}`);
      }),
    },
    calls,
  };
}

describe('shutdownServer', () => {
  it('records the audit entry BEFORE firing the detached poweroff call', () => {
    const { audit, calls } = makeFakeAudit();
    const runDetached: DetachedProcessRunner = vi.fn(() => {
      calls.push('detached:poweroff');
    });

    const result = shutdownServer({ runDetached, audit, caller: { id: 'u1', name: 'admin' } });

    expect(result).toBe(true);
    expect(calls).toEqual(['audit:power.shutdown', 'detached:poweroff']);
  });

  it('invokes /sbin/poweroff with no arguments', () => {
    const { audit } = makeFakeAudit();
    const runDetached: DetachedProcessRunner = vi.fn();

    shutdownServer({ runDetached, audit, caller: { id: 'u1', name: 'admin' } });

    expect(runDetached).toHaveBeenCalledWith('/sbin/poweroff', []);
  });

  it('records outcome initiated (terminal -- no completion signal possible)', () => {
    const { audit } = makeFakeAudit();
    shutdownServer({ runDetached: vi.fn(), audit, caller: { id: 'u1', name: 'admin' } });

    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'power.shutdown', outcome: 'initiated' }),
    );
  });
});

describe('rebootServer', () => {
  it('records the audit entry BEFORE firing the detached reboot call', () => {
    const { audit, calls } = makeFakeAudit();
    const runDetached: DetachedProcessRunner = vi.fn(() => {
      calls.push('detached:reboot');
    });

    const result = rebootServer({ runDetached, audit, caller: { id: 'u1', name: 'admin' } });

    expect(result).toBe(true);
    expect(calls).toEqual(['audit:power.reboot', 'detached:reboot']);
  });

  it('invokes /sbin/reboot with no arguments', () => {
    const { audit } = makeFakeAudit();
    const runDetached: DetachedProcessRunner = vi.fn();

    rebootServer({ runDetached, audit, caller: { id: 'u1', name: 'admin' } });

    expect(runDetached).toHaveBeenCalledWith('/sbin/reboot', []);
  });
});

describe('sleepServer', () => {
  it('records the audit entry BEFORE firing the detached sleep call, when available', () => {
    const { audit, calls } = makeFakeAudit();
    const runDetached: DetachedProcessRunner = vi.fn(() => {
      calls.push('detached:sleep');
    });

    const result = sleepServer({
      runDetached,
      audit,
      caller: { id: 'u1', name: 'admin' },
      sleepScriptExists: () => true,
    });

    expect(result).toBe(true);
    expect(calls).toEqual(['audit:power.sleep', 'detached:sleep']);
  });

  it('invokes the rc.s3sleep script path with no arguments', () => {
    const { audit } = makeFakeAudit();
    const runDetached: DetachedProcessRunner = vi.fn();

    sleepServer({ runDetached, audit, caller: { id: 'u1', name: 'admin' }, sleepScriptExists: () => true });

    expect(runDetached).toHaveBeenCalledWith(
      '/usr/local/emhttp/plugins/dynamix.s3.sleep/scripts/rc.s3sleep',
      [],
    );
  });

  it('throws and never fires the detached call when the S3 Sleep plugin script is missing', () => {
    const { audit } = makeFakeAudit();
    const runDetached: DetachedProcessRunner = vi.fn();

    expect(() =>
      sleepServer({
        runDetached,
        audit,
        caller: { id: 'u1', name: 'admin' },
        sleepScriptExists: () => false,
      }),
    ).toThrow(/Sleep is not available/);
    expect(runDetached).not.toHaveBeenCalled();
    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });
});
