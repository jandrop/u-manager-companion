import { describe, expect, it, vi } from 'vitest';
import {
  normaliseDevicePath,
  parseAssignedDiskIdentifiers,
  parseUnassignedDiskIdentifiers,
  readTextOrEmpty,
} from '../platform.js';

// Excerpt of a real disks.ini: parity and disk2 are empty slots, cache and
// flash carry no idx, and the flash id bears a colon.
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

// A real devs.ini: one unassigned device, no idx key.
const DEVS_INI = ['["dev1"]', 'name="dev1"', 'id="ST9250410AS_5VG0SM9X"', 'device="sdj"', ''].join(
  '\n',
);

function enoent(): Error {
  return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
}

describe('parseAssignedDiskIdentifiers', () => {
  it('lists only the slots that carry an id, in file order', () => {
    expect(parseAssignedDiskIdentifiers(DISKS_INI).map((record) => record.slot)).toEqual([
      'disk1',
      'cache',
      'flash',
    ]);
  });

  it('skips every empty-id slot, parity and disk2 included', () => {
    const slots = parseAssignedDiskIdentifiers(DISKS_INI).map((record) => record.slot);
    expect(slots).not.toContain('parity');
    expect(slots).not.toContain('disk2');
  });

  it('reads the id verbatim and normalises the bare device to /dev/sdX', () => {
    const [disk1] = parseAssignedDiskIdentifiers(DISKS_INI);
    expect(disk1).toEqual({
      diskId: 'WDC_WD30NPRZ-11YRMT0_WD-WX31DB60NPU8',
      device: '/dev/sde',
      slot: 'disk1',
      idx: 1,
      assigned: true,
    });
  });

  it('keeps a colon-bearing id byte-for-byte -- it is the smart-one.cfg section key', () => {
    const flash = parseAssignedDiskIdentifiers(DISKS_INI).find(
      (record) => record.slot === 'flash',
    );
    expect(flash?.diskId).toBe('Samsung_Flash_Drive_0374922050003774-0:0');
  });

  it('reports idx null for a slot with no idx key, and marks every entry assigned', () => {
    const cache = parseAssignedDiskIdentifiers(DISKS_INI).find(
      (record) => record.slot === 'cache',
    );
    expect(cache?.idx).toBeNull();
    expect(parseAssignedDiskIdentifiers(DISKS_INI).every((record) => record.assigned)).toBe(true);
  });

  it('keeps idx 0 -- parity is a real slot whenever it carries an id', () => {
    const text = ['["parity"]', 'id="ST8000DM004_ZR13ABCD"', 'device="sdd"', 'idx="0"'].join('\n');
    expect(parseAssignedDiskIdentifiers(text)[0]?.idx).toBe(0);
  });

  it('reports idx null for a non-numeric value rather than NaN', () => {
    const text = ['["disk1"]', 'id="X_1"', 'device="sde"', 'idx="not-a-number"'].join('\n');
    expect(parseAssignedDiskIdentifiers(text)[0]?.idx).toBeNull();
  });

  it('leaves an already-absolute device path alone', () => {
    const text = ['["disk1"]', 'id="X_1"', 'device="/dev/sde"'].join('\n');
    expect(parseAssignedDiskIdentifiers(text)[0]?.device).toBe('/dev/sde');
  });

  it('reports an empty device as empty, never a bare /dev/', () => {
    const text = ['["disk1"]', 'id="X_1"', 'device=""'].join('\n');
    expect(parseAssignedDiskIdentifiers(text)[0]?.device).toBe('');
  });

  it('reports an absent device key as empty', () => {
    expect(parseAssignedDiskIdentifiers('["disk1"]\nid="X_1"')[0]?.device).toBe('');
  });

  it('yields nothing for empty text -- a missing file contributes no entries', () => {
    expect(parseAssignedDiskIdentifiers('')).toEqual([]);
  });

  it('yields nothing for text with no sections at all', () => {
    expect(parseAssignedDiskIdentifiers('id="orphan"\ndevice="sde"\n')).toEqual([]);
  });

  it('accepts an unquoted section name and unquoted values', () => {
    expect(parseAssignedDiskIdentifiers('[disk1]\nid=X_1\ndevice=sde\nidx=1')[0]).toEqual({
      diskId: 'X_1',
      device: '/dev/sde',
      slot: 'disk1',
      idx: 1,
      assigned: true,
    });
  });

  it('parses CRLF text the same as LF', () => {
    expect(parseAssignedDiskIdentifiers(DISKS_INI.replace(/\n/g, '\r\n'))).toEqual(
      parseAssignedDiskIdentifiers(DISKS_INI),
    );
  });
});

describe('parseUnassignedDiskIdentifiers', () => {
  it('reads devs.ini with idx null and assigned false', () => {
    expect(parseUnassignedDiskIdentifiers(DEVS_INI)).toEqual([
      {
        diskId: 'ST9250410AS_5VG0SM9X',
        device: '/dev/sdj',
        slot: 'dev1',
        idx: null,
        assigned: false,
      },
    ]);
  });

  it('forces idx null even when the file carries one -- an unassigned device has no slot', () => {
    const text = ['["dev1"]', 'id="ST9250410AS_5VG0SM9X"', 'device="sdj"', 'idx="7"'].join('\n');
    expect(parseUnassignedDiskIdentifiers(text)[0]?.idx).toBeNull();
  });

  it('skips an empty-id device', () => {
    expect(parseUnassignedDiskIdentifiers('["dev1"]\nid=""\ndevice="sdj"')).toEqual([]);
  });

  it('yields nothing for empty text', () => {
    expect(parseUnassignedDiskIdentifiers('')).toEqual([]);
  });
});

describe('normaliseDevicePath', () => {
  it.each([
    ['a bare device name', 'sdj', '/dev/sdj'],
    ['an already-absolute path', '/dev/sdj', '/dev/sdj'],
    ['an nvme device', 'nvme0n1', '/dev/nvme0n1'],
    ['an empty value', '', ''],
    ['a whitespace-only value', '   ', ''],
    ['a padded device name', ' sdj ', '/dev/sdj'],
  ])('maps %s', (_label, input, expected) => {
    expect(normaliseDevicePath(input)).toBe(expected);
  });
});

describe('readTextOrEmpty', () => {
  it('returns the text a successful read produces', async () => {
    await expect(readTextOrEmpty(async () => 'content')).resolves.toBe('content');
  });

  it('degrades ENOENT to empty -- devs.ini is absent with no unassigned devices', async () => {
    await expect(
      readTextOrEmpty(() => Promise.reject(enoent())),
    ).resolves.toBe('');
  });

  it('propagates any other errno, so EACCES is never read as "no devices"', async () => {
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const read = vi.fn().mockRejectedValue(eacces);

    await expect(readTextOrEmpty(read)).rejects.toThrow('EACCES');
  });
});
