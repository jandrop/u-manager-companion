import { describe, expect, it, vi } from 'vitest';
import type { DiskStateClient } from '../platform.js';
import { listDiskIdentifiers } from '../resolvers.js';

const DISKS_INI = [
  '["parity"]',
  'name="parity"',
  'id=""',
  'device="sdd"',
  'idx="0"',
  '["disk1"]',
  'name="disk1"',
  'id="WDC_WD30NPRZ-11YRMT0_WD-WX31DB60NPU8"',
  'device="sde"',
  'idx="1"',
  '["disk2"]',
  'name="disk2"',
  'id=""',
  'device=""',
  'idx="2"',
  '["cache"]',
  'name="cache"',
  'id="CT1000MX500SSD1_2347E8851BBD"',
  'device="sdh"',
  '["flash"]',
  'name="flash"',
  'id="Samsung_Flash_Drive_0374922050003774-0:0"',
  'device="sdl"',
  '',
].join('\n');

const DEVS_INI = ['["dev1"]', 'name="dev1"', 'id="ST9250410AS_5VG0SM9X"', 'device="sdj"', ''].join(
  '\n',
);

function makeClient(assignedText: string, unassignedText: string): DiskStateClient {
  return {
    readAssignedText: vi.fn().mockResolvedValue(assignedText),
    readUnassignedText: vi.fn().mockResolvedValue(unassignedText),
  };
}

describe('listDiskIdentifiers', () => {
  it('returns disks.ini entries first, then devs.ini, each in file order', async () => {
    const records = await listDiskIdentifiers({ client: makeClient(DISKS_INI, DEVS_INI) });

    expect(records).toEqual([
      {
        diskId: 'WDC_WD30NPRZ-11YRMT0_WD-WX31DB60NPU8',
        device: '/dev/sde',
        slot: 'disk1',
        idx: 1,
        assigned: true,
      },
      {
        diskId: 'CT1000MX500SSD1_2347E8851BBD',
        device: '/dev/sdh',
        slot: 'cache',
        idx: null,
        assigned: true,
      },
      {
        diskId: 'Samsung_Flash_Drive_0374922050003774-0:0',
        device: '/dev/sdl',
        slot: 'flash',
        idx: null,
        assigned: true,
      },
      {
        diskId: 'ST9250410AS_5VG0SM9X',
        device: '/dev/sdj',
        slot: 'dev1',
        idx: null,
        assigned: false,
      },
    ]);
  });

  it('serves the assigned disks alone when devs.ini is missing', async () => {
    const records = await listDiskIdentifiers({ client: makeClient(DISKS_INI, '') });

    expect(records.map((record) => record.slot)).toEqual(['disk1', 'cache', 'flash']);
    expect(records.every((record) => record.assigned)).toBe(true);
  });

  it('serves the unassigned devices alone when disks.ini is missing', async () => {
    const records = await listDiskIdentifiers({ client: makeClient('', DEVS_INI) });

    expect(records.map((record) => record.slot)).toEqual(['dev1']);
  });

  it('returns an empty list when both files are missing, never an error', async () => {
    await expect(listDiskIdentifiers({ client: makeClient('', '') })).resolves.toEqual([]);
  });

  it('propagates a read failure that is not a missing file', async () => {
    const client: DiskStateClient = {
      readAssignedText: vi.fn().mockRejectedValue(new Error('EACCES: permission denied')),
      readUnassignedText: vi.fn().mockResolvedValue(DEVS_INI),
    };

    await expect(listDiskIdentifiers({ client })).rejects.toThrow('EACCES');
  });

  it('reads each file exactly once', async () => {
    const client = makeClient(DISKS_INI, DEVS_INI);

    await listDiskIdentifiers({ client });

    expect(client.readAssignedText).toHaveBeenCalledTimes(1);
    expect(client.readUnassignedText).toHaveBeenCalledTimes(1);
  });
});
