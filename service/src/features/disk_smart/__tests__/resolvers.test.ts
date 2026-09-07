import { describe, expect, it, vi } from 'vitest';
import type { AuditLogger } from '../../../audit.js';
import type { DiskSmartSettingsInput } from '../platform.js';
import {
  getAllDiskSmartSettings,
  getDiskSmartSettings,
  resetDiskSmartSettings,
  resolveDiskSectionId,
  updateDiskSmartSettings,
} from '../resolvers.js';

// A real-shaped serverId: sha256 hex, so always 64 lowercase chars and never a colon.
const HEX64 = '0123456789abcdef'.repeat(4);
const HEX63 = HEX64.slice(0, 63);
const HEX65 = `${HEX64}0`;
const HEX64_UPPER = `A${HEX64.slice(1)}`;

const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);

// Real device on the live box. Its trailing -0:0 is why a lastIndexOf(':') split collapses it to "0".
const FLASH_ID = 'Samsung_Flash_Drive_0374922050003774-0:0';
const HDD_ID = 'WDC_WD80EFZZ-68B1VN0_VGKW1TRT';

describe('resolveDiskSectionId -- accepted ids', () => {
  it.each([
    ['a bare colon-bearing flash id, verbatim', FLASH_ID, FLASH_ID],
    ['a prefixed colon-bearing flash id, never collapsed to "0"', `${HEX64}:${FLASH_ID}`, FLASH_ID],
    ['a prefixed colon-free disk id', `${HEX64}:${HDD_ID}`, HDD_ID],
    ['a bare disk id', HDD_ID, HDD_ID],
    ['a slot fallback id', 'slot-3-disk3', 'slot-3-disk3'],
    ['exactly ONE prefix, not greedily', `${HEX64}:${HEX64}:x`, `${HEX64}:x`],
    ['a 63-hex prefix is not a serverId shape', `${HEX63}:x`, `${HEX63}:x`],
    ['a 65-hex prefix is not a serverId shape', `${HEX65}:x`, `${HEX65}:x`],
    ['an uppercase-hex prefix is not a serverId shape', `${HEX64_UPPER}:x`, `${HEX64_UPPER}:x`],
    ['a lone colon-free id', 'disk1', 'disk1'],
    ['a dotted serial', 'ST8000.DM004-2CX188', 'ST8000.DM004-2CX188'],
    ['a SCSI-style four-part suffix', 'HGST_HUH728080ALE600-0:0:0:0', 'HGST_HUH728080ALE600-0:0:0:0'],
    ['exactly 128 chars', 'a'.repeat(128), 'a'.repeat(128)],
  ])('accepts %s', (_label, input, expected) => {
    expect(resolveDiskSectionId(input)).toBe(expected);
  });
});

describe('resolveDiskSectionId -- rejected ids', () => {
  it.each([
    ['header forgery via a newline', 'disk]\n[other'],
    ['a bare closing bracket', 'a]b'],
    ['a bare opening bracket', 'a[b'],
    ['only an opening bracket', '['],
    ['only a closing bracket', ']'],
    ['key-line forgery', 'x=1'],
    ['an LF', 'a\nb'],
    ['a CRLF', 'a\r\nb'],
    ['a bare CR', 'a\rb'],
    ['a NUL', `a${NUL}b`],
    ['another C0 control', `a${SOH}b`],
    ['a tab', 'a\tb'],
    ['a semicolon comment introducer', 'a;b'],
    ['a hash comment introducer', 'a#b'],
    ['a double quote', 'a"b'],
    ['a single quote', "a'b"],
    ['leading whitespace', ' a'],
    ['trailing whitespace', 'a '],
    ['an empty id', ''],
    ['whitespace only', ' '],
    ['an id that is empty after stripping the prefix', `${HEX64}:`],
    ['129 chars', 'a'.repeat(129)],
  ])('rejects %s', (_label, input) => {
    expect(() => resolveDiskSectionId(input)).toThrow();
  });

  it('never echoes the offending value in the error message', () => {
    const hostile = 'secret]\n[injected';
    let message = '';
    try {
      resolveDiskSectionId(hostile);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('secret');
    expect(message).not.toContain('injected');
  });
});

const TWO_DISKS =
  `[${HDD_ID}]\nhotTemp="45"\nmaxTemp="55"\nsmEvents="5|197"\n` +
  `[${FLASH_ID}]\nhotTemp="40"\n`;

function makeClient(text = TWO_DISKS) {
  return {
    readText: vi.fn().mockResolvedValue(text),
    writeText: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
  };
}

describe('getDiskSmartSettings', () => {
  it('returns the parsed record for a configured disk', async () => {
    const client = makeClient();

    await expect(getDiskSmartSettings(HDD_ID, { client })).resolves.toEqual({
      diskId: HDD_ID,
      configured: true,
      hotTemp: 45,
      maxTemp: 55,
      smSelect: null,
      smLevel: null,
      notifyAttributes: [5, 197],
      defaultNotifyAttributes: [5, 187, 197, 198, 199],
      preselectAttributes: [5, 187, 188, 197, 198, 199],
    });
  });

  it('resolves a prefixed id to the stored bare section', async () => {
    const client = makeClient();

    const record = await getDiskSmartSettings(`${HEX64}:${HDD_ID}`, { client });

    expect(record.diskId).toBe(HDD_ID);
    expect(record.configured).toBe(true);
  });

  it('reads a bare colon-bearing id without collapsing it', async () => {
    const record = await getDiskSmartSettings(FLASH_ID, { client: makeClient() });

    expect(record.diskId).toBe(FLASH_ID);
    expect(record.hotTemp).toBe(40);
  });

  it('reports an absent section as unconfigured while the sibling stays readable', async () => {
    const client = makeClient();

    const missing = await getDiskSmartSettings('slot-9-disk9', { client });
    const sibling = await getDiskSmartSettings(HDD_ID, { client });

    expect(missing.configured).toBe(false);
    expect(missing.hotTemp).toBeNull();
    expect(sibling.hotTemp).toBe(45);
  });

  it('does not throw when the file is missing', async () => {
    const record = await getDiskSmartSettings(HDD_ID, { client: makeClient('') });

    expect(record.configured).toBe(false);
  });

  it('never writes or deletes on a read', async () => {
    const client = makeClient();

    await getDiskSmartSettings(HDD_ID, { client });

    expect(client.writeText).not.toHaveBeenCalled();
    expect(client.deleteFile).not.toHaveBeenCalled();
  });

  it('rejects a hostile id with ZERO client calls -- the guard runs before any IO', async () => {
    const client = makeClient();

    await expect(getDiskSmartSettings('disk]\n[other', { client })).rejects.toThrow();

    expect(client.readText).not.toHaveBeenCalled();
    expect(client.writeText).not.toHaveBeenCalled();
    expect(client.deleteFile).not.toHaveBeenCalled();
  });
});

const VALID_INPUT: DiskSmartSettingsInput = {
  hotTemp: 45,
  maxTemp: 55,
  smSelect: 1,
  smLevel: 1.5,
  notifyAttributes: [5, 197],
};

function makeAudit(): AuditLogger {
  return { recordAuditEvent: vi.fn() };
}

function makeCaller() {
  return { id: 'u1', name: 'admin' };
}

describe('updateDiskSmartSettings -- validation runs before any IO', () => {
  it.each([
    ['hotTemp', -1],
    ['maxTemp', -1],
    ['smSelect', -1],
    ['smLevel', -1],
    ['hotTemp', -5],
    ['maxTemp', -0.5],
    ['hotTemp', 45.5],
    ['maxTemp', 301],
    ['smSelect', 1.5],
  ])('rejects %s = %s with ZERO client calls and no audit entry', async (key, value) => {
    const client = makeClient();
    const audit = makeAudit();
    const input = { ...VALID_INPUT, [key]: value } as DiskSmartSettingsInput;

    await expect(
      updateDiskSmartSettings(HDD_ID, input, { client, audit, caller: makeCaller() }),
    ).rejects.toThrow();

    expect(client.readText).not.toHaveBeenCalled();
    expect(client.writeText).not.toHaveBeenCalled();
    expect(client.deleteFile).not.toHaveBeenCalled();
    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });

  it('rejects an EMPTY notifyAttributes list -- the format cannot express "monitor nothing"', async () => {
    const client = makeClient();
    const audit = makeAudit();

    await expect(
      updateDiskSmartSettings(
        HDD_ID,
        { ...VALID_INPUT, notifyAttributes: [] },
        { client, audit, caller: makeCaller() },
      ),
    ).rejects.toThrow();

    expect(client.readText).not.toHaveBeenCalled();
    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-integer attribute', [5, 1.5]],
    ['a negative attribute', [5, -1]],
  ])('rejects %s', async (_label, notifyAttributes) => {
    const client = makeClient();

    await expect(
      updateDiskSmartSettings(
        HDD_ID,
        { ...VALID_INPUT, notifyAttributes },
        { client, audit: makeAudit(), caller: makeCaller() },
      ),
    ).rejects.toThrow();

    expect(client.readText).not.toHaveBeenCalled();
  });

  it('accepts an all-null input -- null is the explicit inherit channel', async () => {
    const client = makeClient();

    await expect(
      updateDiskSmartSettings(
        HDD_ID,
        { hotTemp: null, maxTemp: null, smSelect: null, smLevel: null, notifyAttributes: null },
        { client, audit: makeAudit(), caller: makeCaller() },
      ),
    ).resolves.toBeDefined();
  });

  it('accepts an unknown smSelect and a fractional smLevel -- raw passthrough', async () => {
    const client = makeClient();

    await expect(
      updateDiskSmartSettings(
        HDD_ID,
        { ...VALID_INPUT, smSelect: 7, smLevel: 4.25 },
        { client, audit: makeAudit(), caller: makeCaller() },
      ),
    ).resolves.toBeDefined();
  });

  it('rejects a hostile id with NO audit entry at all', async () => {
    const client = makeClient();
    const audit = makeAudit();

    await expect(
      updateDiskSmartSettings('disk]\n[other', VALID_INPUT, {
        client,
        audit,
        caller: makeCaller(),
      }),
    ).rejects.toThrow();

    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
    expect(client.readText).not.toHaveBeenCalled();
  });

  it('rejects a hostile id on reset with NO audit entry either', async () => {
    const client = makeClient();
    const audit = makeAudit();

    await expect(
      resetDiskSmartSettings('x=1', { client, audit, caller: makeCaller() }),
    ).rejects.toThrow();

    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
    expect(client.readText).not.toHaveBeenCalled();
    expect(client.deleteFile).not.toHaveBeenCalled();
  });
});

function makeTracedDeps(text = TWO_DISKS) {
  const order: string[] = [];
  const client = {
    readText: vi.fn(async () => {
      order.push('read');
      return text;
    }),
    writeText: vi.fn(async (_content: string) => {
      order.push('write');
    }),
    deleteFile: vi.fn(async () => {
      order.push('delete');
    }),
  };
  const audit: AuditLogger = {
    recordAuditEvent: vi.fn(() => {
      order.push('audit');
    }),
  };
  return { order, client, audit, caller: makeCaller() };
}

describe('updateDiskSmartSettings -- audit and result', () => {
  it('records exactly ONE audit entry naming the action, target and outcome', async () => {
    const deps = makeTracedDeps();

    await updateDiskSmartSettings(HDD_ID, VALID_INPUT, deps);

    expect(deps.audit.recordAuditEvent).toHaveBeenCalledTimes(1);
    expect(deps.audit.recordAuditEvent).toHaveBeenCalledWith({
      action: 'diskSmartSettings.update',
      caller: deps.caller,
      target: HDD_ID,
      outcome: 'initiated',
    });
  });

  it('records the audit entry BEFORE the write', async () => {
    const deps = makeTracedDeps();

    await updateDiskSmartSettings(HDD_ID, VALID_INPUT, deps);

    expect(deps.order).toEqual(['read', 'audit', 'write']);
  });

  it('audits the RESOLVED section id, not the prefixed wire id', async () => {
    const deps = makeTracedDeps();

    await updateDiskSmartSettings(`${HEX64}:${HDD_ID}`, VALID_INPUT, deps);

    expect(deps.audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ target: HDD_ID }),
    );
  });

  it('returns the parse of the text just written, without a second read', async () => {
    const deps = makeTracedDeps();

    const result = await updateDiskSmartSettings(HDD_ID, VALID_INPUT, deps);

    expect(deps.client.readText).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      diskId: HDD_ID,
      configured: true,
      hotTemp: 45,
      maxTemp: 55,
      smSelect: 1,
      smLevel: 1.5,
      notifyAttributes: [5, 197],
    });
  });

  it('creates the file when it is absent', async () => {
    const deps = makeTracedDeps('');

    const result = await updateDiskSmartSettings(
      HDD_ID,
      { hotTemp: 45, maxTemp: null, smSelect: null, smLevel: null, notifyAttributes: null },
      deps,
    );

    expect(deps.client.writeText).toHaveBeenCalledWith(`[${HDD_ID}]\nhotTemp="45"\n`);
    expect(result.configured).toBe(true);
  });

  it('clears one key and sets another in the same call, leaving the sibling intact', async () => {
    const deps = makeTracedDeps();

    const result = await updateDiskSmartSettings(
      HDD_ID,
      { hotTemp: null, maxTemp: 55, smSelect: null, smLevel: null, notifyAttributes: [5, 197] },
      deps,
    );

    expect(deps.client.writeText).toHaveBeenCalledWith(
      `[${HDD_ID}]\nmaxTemp="55"\nsmEvents="5|197"\n[${FLASH_ID}]\nhotTemp="40"\n`,
    );
    expect(result.hotTemp).toBeNull();
    expect(result.maxTemp).toBe(55);
  });

  it('never deletes the file on an update', async () => {
    const deps = makeTracedDeps();

    await updateDiskSmartSettings(HDD_ID, VALID_INPUT, deps);

    expect(deps.client.deleteFile).not.toHaveBeenCalled();
  });
});

describe('resetDiskSmartSettings', () => {
  const ONE_DISK = `[${HDD_ID}]\nhotTemp="45"\nsmType="sat"\n`;

  it('records exactly one audit entry for the reset action', async () => {
    const deps = makeTracedDeps();

    await resetDiskSmartSettings(HDD_ID, deps);

    expect(deps.audit.recordAuditEvent).toHaveBeenCalledTimes(1);
    expect(deps.audit.recordAuditEvent).toHaveBeenCalledWith({
      action: 'diskSmartSettings.reset',
      caller: deps.caller,
      target: HDD_ID,
      outcome: 'initiated',
    });
  });

  it('WRITES and never deletes while another disk is still configured', async () => {
    const deps = makeTracedDeps();

    await resetDiskSmartSettings(HDD_ID, deps);

    expect(deps.client.writeText).toHaveBeenCalledWith(`[${FLASH_ID}]\nhotTemp="40"\n`);
    expect(deps.client.deleteFile).not.toHaveBeenCalled();
    expect(deps.order).toEqual(['read', 'audit', 'write']);
  });

  it('leaves the sibling section byte-identical', async () => {
    const deps = makeTracedDeps();

    await resetDiskSmartSettings(HDD_ID, deps);

    const written = deps.client.writeText.mock.calls[0]![0];
    expect(written).toBe(`[${FLASH_ID}]\nhotTemp="40"\n`);
  });

  it('UNLINKS and never writes when the last section goes', async () => {
    const deps = makeTracedDeps(ONE_DISK);

    await resetDiskSmartSettings(HDD_ID, deps);

    expect(deps.client.deleteFile).toHaveBeenCalledTimes(1);
    expect(deps.client.writeText).not.toHaveBeenCalled();
    expect(deps.order).toEqual(['read', 'audit', 'delete']);
  });

  it('destroys unmodeled controller keys with the section', async () => {
    const deps = makeTracedDeps(`${ONE_DISK}[${FLASH_ID}]\nhotTemp="40"\n`);

    await resetDiskSmartSettings(HDD_ID, deps);

    const written = deps.client.writeText.mock.calls[0]![0];
    expect(written).not.toContain('smType');
    expect(written).toBe(`[${FLASH_ID}]\nhotTemp="40"\n`);
  });

  it('returns an unconfigured record with every value null', async () => {
    const deps = makeTracedDeps(ONE_DISK);

    await expect(resetDiskSmartSettings(HDD_ID, deps)).resolves.toEqual({
      diskId: HDD_ID,
      configured: false,
      hotTemp: null,
      maxTemp: null,
      smSelect: null,
      smLevel: null,
      notifyAttributes: null,
      defaultNotifyAttributes: [5, 187, 197, 198, 199],
      preselectAttributes: [5, 187, 188, 197, 198, 199],
    });
  });

  it('does not throw when the file is already absent', async () => {
    const deps = makeTracedDeps('');

    await expect(resetDiskSmartSettings(HDD_ID, deps)).resolves.toMatchObject({
      configured: false,
    });
    expect(deps.client.writeText).not.toHaveBeenCalled();
  });

  it('is a no-op write for a disk that was never configured', async () => {
    const deps = makeTracedDeps();

    await resetDiskSmartSettings('slot-9-disk9', deps);

    expect(deps.client.writeText).toHaveBeenCalledWith(TWO_DISKS);
    expect(deps.client.deleteFile).not.toHaveBeenCalled();
  });

  it('unlinks a file whose only remaining content is a comment', async () => {
    const deps = makeTracedDeps(`# comment\n${ONE_DISK}`);

    await resetDiskSmartSettings(HDD_ID, deps);

    expect(deps.client.deleteFile).toHaveBeenCalledTimes(1);
    expect(deps.client.writeText).not.toHaveBeenCalled();
  });
});

describe('getAllDiskSmartSettings', () => {
  function fakeClient(text: string) {
    return {
      readText: vi.fn().mockResolvedValue(text),
      writeText: vi.fn(),
      deleteFile: vi.fn(),
    };
  }

  it('reads the file ONCE for every disk', async () => {
    const client = fakeClient('[diskA]\nhotTemp="45"\n[diskB]\nhotTemp="40"\n');

    const records = await getAllDiskSmartSettings({ client });

    expect(client.readText).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(2);
  });

  it('is an empty list on a missing file, never a throw', async () => {
    const client = fakeClient('');
    await expect(getAllDiskSmartSettings({ client })).resolves.toEqual([]);
  });

  it('never writes -- it is a read', async () => {
    const client = fakeClient('[diskA]\nhotTemp="45"\n');

    await getAllDiskSmartSettings({ client });

    expect(client.writeText).not.toHaveBeenCalled();
    expect(client.deleteFile).not.toHaveBeenCalled();
  });

  it('returns section names verbatim, including a colon-bearing flash id', async () => {
    const client = fakeClient(`[${FLASH_ID}]\nhotTemp="45"\n[${HDD_ID}]\nmaxTemp="55"\n`);

    const records = await getAllDiskSmartSettings({ client });

    expect(records.map((record) => record.diskId)).toEqual([FLASH_ID, HDD_ID]);
  });

  it('agrees with the single-disk read for the same disk', async () => {
    const text = `[${HDD_ID}]\nhotTemp="41"\nmaxTemp="51"\nsmEvents="5|187|42"\n`;
    const bulk = await getAllDiskSmartSettings({ client: fakeClient(text) });
    const single = await getDiskSmartSettings(HDD_ID, { client: fakeClient(text) });

    expect(bulk[0]).toEqual(single);
  });

  it('is not audited -- reads never are', async () => {
    const client = fakeClient('[diskA]\nhotTemp="45"\n');
    const audit = { recordAuditEvent: vi.fn() } as unknown as AuditLogger;

    await getAllDiskSmartSettings({ client });

    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });

  it('propagates a non-ENOENT read failure instead of reporting no overrides', async () => {
    const client = {
      readText: vi.fn().mockRejectedValue(new Error('EACCES')),
      writeText: vi.fn(),
      deleteFile: vi.fn(),
    };

    await expect(getAllDiskSmartSettings({ client })).rejects.toThrow('EACCES');
  });
});
