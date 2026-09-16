import { describe, expect, it, vi } from 'vitest';
import type { AuditLogger } from '../../../audit.js';
import type { StreamedProcessRunner } from '../../../platform/process-runner.js';
import { getSnapshot } from '../../../operations/registry.js';
import { uninstallPlugin } from '../uninstall.js';

function makeFakeAudit(): AuditLogger {
  return { recordAuditEvent: vi.fn() };
}

function makeFakeRunner(exitCode = 0): StreamedProcessRunner {
  return vi.fn(async (_cmd, _args, onLine) => {
    onLine('Removing plugin...');
    onLine('Done.');
    return { exitCode };
  });
}

describe('uninstallPlugin', () => {
  it('returns an operation snapshot immediately with status RUNNING', () => {
    const op = uninstallPlugin('some.plugin.plg', {
      runPluginCli: makeFakeRunner(),
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
    });

    expect(op.status).toBe('RUNNING');
    expect(op.subject).toMatchObject({ name: 'some.plugin', url: 'some.plugin.plg' });
  });

  it('records an audit event synchronously before returning', () => {
    const audit = makeFakeAudit();
    uninstallPlugin('some.plugin.plg', {
      runPluginCli: makeFakeRunner(),
      audit,
      caller: { id: 'u1', name: 'admin' },
    });

    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'plugins.uninstall',
        target: 'some.plugin.plg',
        outcome: 'initiated',
      }),
    );
  });

  it('shells `plugin remove <filename>` and streams output', async () => {
    const runPluginCli = makeFakeRunner();
    const op = uninstallPlugin('some.plugin.plg', {
      runPluginCli,
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('SUCCEEDED');
    });
    expect(runPluginCli).toHaveBeenCalledWith(
      expect.stringContaining('plugin'),
      ['remove', 'some.plugin.plg'],
      expect.any(Function),
    );
    const joined = (getSnapshot(op.id)?.output ?? []).join('\n');
    expect(joined).toContain('Removing plugin...');
  });

  it('transitions to FAILED when the plugin CLI exits non-zero', async () => {
    const op = uninstallPlugin('some.plugin.plg', {
      runPluginCli: makeFakeRunner(1),
      audit: makeFakeAudit(),
      caller: { id: 'u1', name: 'admin' },
    });

    await vi.waitFor(() => {
      expect(getSnapshot(op.id)?.status).toBe('FAILED');
    });
  });

  it('rejects an empty filename synchronously without any side effect', () => {
    const runPluginCli = makeFakeRunner();
    const audit = makeFakeAudit();

    expect(() =>
      uninstallPlugin('', { runPluginCli, audit, caller: { id: 'u1', name: 'admin' } }),
    ).toThrow(/cannot be empty/);
    expect(runPluginCli).not.toHaveBeenCalled();
    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });

  it('rejects a filename containing a path separator', () => {
    expect(() =>
      uninstallPlugin('../../etc/passwd.plg', {
        runPluginCli: makeFakeRunner(),
        audit: makeFakeAudit(),
        caller: { id: 'u1', name: 'admin' },
      }),
    ).toThrow(/Invalid plugin filename/);
  });

  it('rejects a filename not ending in .plg', () => {
    expect(() =>
      uninstallPlugin('not-a-plugin.txt', {
        runPluginCli: makeFakeRunner(),
        audit: makeFakeAudit(),
        caller: { id: 'u1', name: 'admin' },
      }),
    ).toThrow(/must end with \.plg/);
  });
});
