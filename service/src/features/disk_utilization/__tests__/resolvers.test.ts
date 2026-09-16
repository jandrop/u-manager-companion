import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../../context.js';
import type { AuditCaller, AuditLogger } from '../../../audit.js';
import {
  buildDiskUtilizationCommands,
  updateDiskUtilizationThresholds,
  type DiskUtilizationThresholdsInput,
} from '../resolvers.js';

const CALLER: AuditCaller = { id: 'u1', name: 'admin' };
const SUCCESS_BODY = '<script>replaceName("disk1");</script>';

function makeDeps(response: string = SUCCESS_BODY) {
  const order: string[] = [];
  const sendCommand = vi.fn(async () => {
    order.push('send');
    return response;
  });
  const audit: AuditLogger = {
    recordAuditEvent: vi.fn(() => {
      order.push('audit');
    }),
  };
  return { client: { sendCommand }, audit, caller: CALLER, order, sendCommand };
}

async function run(input: DiskUtilizationThresholdsInput, response?: string) {
  const deps = makeDeps(response);
  const result = await updateDiskUtilizationThresholds(input, deps);
  return { ...deps, result };
}

describe('buildDiskUtilizationCommands', () => {
  it('emits only the fields the caller named, keyed by slot index', () => {
    expect(buildDiskUtilizationCommands({ diskIdx: 1, warning: 80 })).toEqual({
      changeDisk: 'Apply',
      'diskWarning.1': '80',
    });
    expect(buildDiskUtilizationCommands({ diskIdx: 3, critical: 95 })).toEqual({
      changeDisk: 'Apply',
      'diskCritical.3': '95',
    });
    expect(buildDiskUtilizationCommands({ diskIdx: 2, warning: 70, critical: 90 })).toEqual({
      changeDisk: 'Apply',
      'diskWarning.2': '70',
      'diskCritical.2': '90',
    });
  });

  it('emits an EMPTY value for an explicit null, which is how emhttpd clears a field', () => {
    expect(buildDiskUtilizationCommands({ diskIdx: 1, warning: null, critical: null })).toEqual({
      changeDisk: 'Apply',
      'diskWarning.1': '',
      'diskCritical.1': '',
    });
  });

  it('emits 0 as a real value, distinct from cleared', () => {
    expect(buildDiskUtilizationCommands({ diskIdx: 1, warning: 0 })).toEqual({
      changeDisk: 'Apply',
      'diskWarning.1': '0',
    });
  });
});

describe('updateDiskUtilizationThresholds', () => {
  it('returns true and sends one changeDisk=Apply on success', async () => {
    const { result, sendCommand } = await run({ diskIdx: 1, warning: 80 });

    expect(result).toBe(true);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith({ changeDisk: 'Apply', 'diskWarning.1': '80' });
  });

  it('leaves an omitted field out of the payload entirely', async () => {
    const { sendCommand } = await run({ diskIdx: 1, critical: 90 });

    expect(sendCommand).toHaveBeenCalledWith({ changeDisk: 'Apply', 'diskCritical.1': '90' });
  });

  it('accepts an inverted pair -- the webGUI has no such check', async () => {
    const { result, sendCommand } = await run({ diskIdx: 1, warning: 95, critical: 10 });

    expect(result).toBe(true);
    expect(sendCommand).toHaveBeenCalledWith({
      changeDisk: 'Apply',
      'diskWarning.1': '95',
      'diskCritical.1': '10',
    });
  });

  it('accepts both range bounds', async () => {
    await expect(run({ diskIdx: 1, warning: 0, critical: 100 })).resolves.toBeTruthy();
  });

  it('records the audit entry BEFORE the emhttpd round-trip', async () => {
    const { audit, order } = await run({ diskIdx: 4, warning: 80 });

    expect(order).toEqual(['audit', 'send']);
    expect(audit.recordAuditEvent).toHaveBeenCalledWith({
      action: 'diskUtilizationThresholds.update',
      caller: CALLER,
      target: '4',
      outcome: 'initiated',
    });
  });

  it('audits a write that emhttpd then refuses', async () => {
    const deps = makeDeps('500 Internal Server Error');

    await expect(updateDiskUtilizationThresholds({ diskIdx: 1, warning: 80 }, deps)).rejects.toThrow(
      /emhttpd refused/,
    );
    expect(deps.audit.recordAuditEvent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['warning above 100', { diskIdx: 1, warning: 101 }],
    ['critical above 100', { diskIdx: 1, critical: 101 }],
    ['negative warning', { diskIdx: 1, warning: -1 }],
    ['fractional critical', { diskIdx: 1, critical: 90.5 }],
  ] as const)('rejects %s without any IO', async (_label, input) => {
    const deps = makeDeps();

    await expect(updateDiskUtilizationThresholds(input, deps)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(deps.sendCommand).not.toHaveBeenCalled();
    expect(deps.audit.recordAuditEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', 0],
    ['negative', -2],
    ['fractional', 1.5],
  ] as const)('rejects a %s diskIdx', async (_label, diskIdx) => {
    const deps = makeDeps();

    await expect(
      updateDiskUtilizationThresholds({ diskIdx, warning: 80 }, deps),
    ).rejects.toThrow(/diskIdx/);
    expect(deps.sendCommand).not.toHaveBeenCalled();
  });

  it('rejects a request that names neither field', async () => {
    const deps = makeDeps();

    await expect(updateDiskUtilizationThresholds({ diskIdx: 1 }, deps)).rejects.toThrow(
      /warning|critical/,
    );
    expect(deps.sendCommand).not.toHaveBeenCalled();
  });
});
