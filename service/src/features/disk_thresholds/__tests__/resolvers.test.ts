/**
 * features/disk_thresholds resolvers tests.
 *
 * TDD: written before resolvers.ts exists -> RED first.
 *
 * Covers the read (getDiskThresholds -- ungated, not audited) and write
 * (updateDiskThresholds -- validated, audited BEFORE the file write) side
 * of the feature module. Talks to dynamix.cfg through an injectable
 * DynamixConfigClient (platform.ts), so nothing here ever touches a real
 * filesystem.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuditLogger } from '../../../audit.js';
import type { DiskThresholdsInput, DynamixConfigClient } from '../platform.js';
import { getDiskThresholds, updateDiskThresholds } from '../resolvers.js';

const FIXTURE = '[display]\nwarning="80"\ncritical="90"\nhot="45"\nmax="55"\nhotssd="60"\nmaxssd="70"\n[parity]\nmode="3"\n';

const VALID_INPUT: DiskThresholdsInput = { warning: 75, critical: 85, hot: 40, max: 50, hotssd: 55, maxssd: 65 };

const DEFAULTS_FIXTURE =
  '[display]\nwarning="70"\ncritical="90"\nhot="45"\nmax="55"\nhotssd="60"\nmaxssd="70"\n';

function makeClient(overrides: Partial<DynamixConfigClient> = {}): DynamixConfigClient {
  return {
    readText: vi.fn().mockResolvedValue(FIXTURE),
    readDefaultsText: vi.fn().mockResolvedValue(DEFAULTS_FIXTURE),
    writeText: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeCaller() {
  return { id: 'u1', name: 'admin' };
}

describe('getDiskThresholds', () => {
  it('returns the parsed thresholds read from the client', async () => {
    const client = makeClient();

    const result = await getDiskThresholds({ client });

    expect(result).toEqual({ warning: 80, critical: 90, hot: 45, max: 55, hotssd: 60, maxssd: 70, defaults: { warning: 70, critical: 90, hot: 45, max: 55, hotssd: 60, maxssd: 70 } });
  });

  // Not audited -- ClientDeps carries no audit dependency at all, matching
  // shares' read-only queries (listShares, getShareSecurity, ...).
  it('does not require an audit dependency', async () => {
    const client = makeClient();
    await expect(getDiskThresholds({ client })).resolves.toBeDefined();
  });
});

describe('updateDiskThresholds -- validation', () => {
  it.each([
    ['warning', -1],
    ['warning', 101],
    ['critical', -1],
    ['critical', 101],
  ])('rejects %s = %i (outside the [0,100] percentage range)', async (key, value) => {
    const client = makeClient();
    const audit: AuditLogger = { recordAuditEvent: vi.fn() };
    const input = { ...VALID_INPUT, [key]: value } as DiskThresholdsInput;

    await expect(
      updateDiskThresholds(input, { client, audit, caller: makeCaller() }),
    ).rejects.toThrow();
    expect(client.writeText).not.toHaveBeenCalled();
  });

  it.each([
    ['hot', -1],
    ['hot', 301],
    ['max', -1],
    ['max', 301],
    ['hotssd', -1],
    ['hotssd', 301],
    ['maxssd', -1],
    ['maxssd', 301],
  ])('rejects %s = %i (outside the [0,300] temperature range)', async (key, value) => {
    const client = makeClient();
    const audit: AuditLogger = { recordAuditEvent: vi.fn() };
    const input = { ...VALID_INPUT, [key]: value } as DiskThresholdsInput;

    await expect(
      updateDiskThresholds(input, { client, audit, caller: makeCaller() }),
    ).rejects.toThrow();
    expect(client.writeText).not.toHaveBeenCalled();
  });

  it('rejects a non-integer value', async () => {
    const client = makeClient();
    const audit: AuditLogger = { recordAuditEvent: vi.fn() };
    const input = { ...VALID_INPUT, warning: 50.5 } as DiskThresholdsInput;

    await expect(
      updateDiskThresholds(input, { client, audit, caller: makeCaller() }),
    ).rejects.toThrow();
    expect(client.writeText).not.toHaveBeenCalled();
  });

  it('does NOT enforce warning < critical (inverted thresholds accepted)', async () => {
    const client = makeClient();
    const audit: AuditLogger = { recordAuditEvent: vi.fn() };
    const input: DiskThresholdsInput = { ...VALID_INPUT, warning: 90, critical: 10 };

    await expect(
      updateDiskThresholds(input, { client, audit, caller: makeCaller() }),
    ).resolves.toBeDefined();
  });

  it('accepts the boundary values 0 and 100/300', async () => {
    const client = makeClient();
    const audit: AuditLogger = { recordAuditEvent: vi.fn() };
    const boundary: DiskThresholdsInput = { warning: 0, critical: 100, hot: 0, max: 300, hotssd: 0, maxssd: 300 };

    await expect(
      updateDiskThresholds(boundary, { client, audit, caller: makeCaller() }),
    ).resolves.toBeDefined();
  });
});

describe('updateDiskThresholds -- audit + write', () => {
  it('records an audit entry BEFORE writeText is called', async () => {
    const order: string[] = [];
    const client = makeClient({
      writeText: vi.fn().mockImplementation(async () => {
        order.push('writeText');
      }),
    });
    const audit: AuditLogger = {
      recordAuditEvent: vi.fn(() => {
        order.push('audit');
      }),
    };

    await updateDiskThresholds(VALID_INPUT, { client, audit, caller: makeCaller() });

    expect(order).toEqual(['audit', 'writeText']);
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'diskThresholds.update', outcome: 'initiated' }),
    );
  });

  it('still records the audit entry when writeText rejects', async () => {
    const client = makeClient({ writeText: vi.fn().mockRejectedValue(new Error('EROFS')) });
    const audit: AuditLogger = { recordAuditEvent: vi.fn() };

    await expect(
      updateDiskThresholds(VALID_INPUT, { client, audit, caller: makeCaller() }),
    ).rejects.toThrow('EROFS');

    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'diskThresholds.update', outcome: 'initiated' }),
    );
  });

  it('returns the parse of the patched text, never a re-read', async () => {
    const readText = vi.fn().mockResolvedValue(FIXTURE);
    const client = makeClient({ readText });
    const audit: AuditLogger = { recordAuditEvent: vi.fn() };

    const result = await updateDiskThresholds(VALID_INPUT, { client, audit, caller: makeCaller() });

    expect(result).toEqual({
      ...VALID_INPUT,
      defaults: { warning: 70, critical: 90, hot: 45, max: 55, hotssd: 60, maxssd: 70 },
    });
    expect(readText).toHaveBeenCalledTimes(1);
  });

  // update.php's #cleanup: an emptied field removes the key so the value
  // inherits default.cfg. Writing the stock default instead would PIN it.
  it('a null clears the key instead of writing a value', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ writeText });
    const audit: AuditLogger = { recordAuditEvent: vi.fn() };

    const result = await updateDiskThresholds(
      { ...VALID_INPUT, warning: null },
      { client, audit, caller: makeCaller() },
    );

    const written = writeText.mock.calls[0]![0] as string;
    expect(written).not.toMatch(/^warning=/m);
    // The other five survive untouched, and so does everything else.
    expect(written).toMatch(/^critical="85"$/m);
    expect(written).toMatch(/^\[parity\]$/m);
    expect(result.warning).toBeNull();
  });

  it('clearing every key leaves the section with no threshold lines', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ writeText });
    const audit: AuditLogger = { recordAuditEvent: vi.fn() };

    const cleared = {
      warning: null, critical: null, hot: null,
      max: null, hotssd: null, maxssd: null,
    };
    const result = await updateDiskThresholds(cleared, {
      client, audit, caller: makeCaller(),
    });

    const written = writeText.mock.calls[0]![0] as string;
    for (const key of ['warning', 'critical', 'hot', 'max', 'hotssd', 'maxssd']) {
      expect(written).not.toMatch(new RegExp(`^${key}=`, 'm'));
    }
    expect(written).toMatch(/^\[display\]$/m);
    expect(written).toMatch(/^\[parity\]$/m);
    expect(result.warning).toBeNull();
    // Defaults still resolve so a client can render placeholders.
    expect(result.defaults.warning).toBe(70);
  });

  it('a null for an already-absent key is a no-op, not an append', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({
      readText: vi.fn().mockResolvedValue('[display]\ncritical="90"\n[parity]\n'),
      writeText,
    });
    const audit: AuditLogger = { recordAuditEvent: vi.fn() };

    await updateDiskThresholds(
      { warning: null, critical: 88, hot: null, max: null, hotssd: null, maxssd: null },
      { client, audit, caller: makeCaller() },
    );

    const written = writeText.mock.calls[0]![0] as string;
    expect(written).not.toMatch(/^warning=/m);
    expect(written).toMatch(/^critical="88"$/m);
  });

  it('writes byte-preserving patched content, keeping unrelated sections intact', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ writeText });
    const audit: AuditLogger = { recordAuditEvent: vi.fn() };

    await updateDiskThresholds(VALID_INPUT, { client, audit, caller: makeCaller() });

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('warning="75"'));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('[parity]\nmode="3"'));
  });
});
