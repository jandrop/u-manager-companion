/**
 * Reads Unraid's device ids out of emhttp's state files.
 *
 * That id (`ST9250410AS_5VG0SM9X`) is the section name in smart-one.cfg and
 * the `diskId` the SMART mutations take, and neither endpoint exposes it --
 * the native `Disk.id` is `<serverId>:<serialNum>`.
 *
 * Nor can it be rebuilt from name + serial: the flash device reports
 * `Flash Drive` / `0374922050003774`, but its id is
 * `Samsung_Flash_Drive_0374922050003774-0:0`.
 *
 * Parsing is pure; DiskStateClient is the seam server.ts wires to the paths
 * in platform/config.ts and tests replace with a fake.
 */
import { readFile } from 'node:fs/promises';

/** One addressable device: `diskId` for the SMART mutations, `idx` for
 * updateDiskUtilizationThresholds. */
export interface DiskIdentifierRecord {
  /** Unraid's device id, verbatim from the ini's `id` key. */
  readonly diskId: string;
  /** `/dev/sdX`. Empty when the ini carries no device, never a bare `/dev/`. */
  readonly device: string;
  /** The ini section name: `disk1`, `parity`, `cache`, `flash`, `dev1`. */
  readonly slot: string;
  /** Array slot index. Null for unassigned devices and for a non-numeric value. */
  readonly idx: number | null;
  /** True for disks.ini entries, false for devs.ini. */
  readonly assigned: boolean;
}

/** emhttp quotes its section names (`["disk1"]`), unlike the plain
 * `[section]` of the /boot cfg files. */
const SECTION_HEADER_RE = /^\[\s*"?([^"[\]]*)"?\s*\]$/;
const KEY_VALUE_RE = /^([^=]+)=(.*)$/;
const INTEGER_RE = /^-?\d+$/;
const DEVICE_PATH_PREFIX = '/dev/';

function stripQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, '$1');
}

interface IniSection {
  readonly name: string;
  readonly fields: ReadonlyMap<string, string>;
}

/** Every section in file order, values unquoted. Duplicate keys are
 * last-wins. */
function parseSections(text: string): readonly IniSection[] {
  const sections: { name: string; fields: Map<string, string> }[] = [];
  let current: { name: string; fields: Map<string, string> } | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;

    const header = SECTION_HEADER_RE.exec(line);
    if (header) {
      current = { name: header[1] ?? '', fields: new Map() };
      sections.push(current);
      continue;
    }

    if (!current) continue;
    const keyValue = KEY_VALUE_RE.exec(line);
    if (!keyValue) continue;
    current.fields.set(keyValue[1]!.trim(), stripQuotes(keyValue[2]!.trim()));
  }

  return sections;
}

/** An empty value stays empty rather than becoming a bare `/dev/`. */
export function normaliseDevicePath(raw: string): string {
  const device = raw.trim();
  if (device === '' || device.startsWith('/')) return device;
  return `${DEVICE_PATH_PREFIX}${device}`;
}

function parseIdx(raw: string | undefined): number | null {
  if (raw === undefined || !INTEGER_RE.test(raw.trim())) return null;
  return Number(raw.trim());
}

function toRecords(
  text: string,
  assigned: boolean,
  readIdx: (fields: ReadonlyMap<string, string>) => number | null,
): readonly DiskIdentifierRecord[] {
  const records: DiskIdentifierRecord[] = [];
  for (const { name, fields } of parseSections(text)) {
    // An empty id addresses nothing, and every unassigned array slot has one.
    const diskId = fields.get('id')?.trim() ?? '';
    if (diskId === '') continue;

    records.push({
      diskId,
      device: normaliseDevicePath(fields.get('device') ?? ''),
      slot: name,
      idx: readIdx(fields),
      assigned,
    });
  }
  return records;
}

/** Assigned array devices from `disks.ini`, in file order. */
export function parseAssignedDiskIdentifiers(text: string): readonly DiskIdentifierRecord[] {
  return toRecords(text, true, (fields) => parseIdx(fields.get('idx')));
}

/** Unassigned devices from `devs.ini`, in file order. `idx` is always null:
 * they occupy no array slot. */
export function parseUnassignedDiskIdentifiers(text: string): readonly DiskIdentifierRecord[] {
  return toRecords(text, false, () => null);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** ENOENT reads as empty -- `devs.ini` is absent on a box with no unassigned
 * devices. Any other errno propagates, so EACCES is never read as "none". */
export async function readTextOrEmpty(read: () => Promise<string>): Promise<string> {
  try {
    return await read();
  } catch (error) {
    if (isEnoent(error)) return '';
    throw error;
  }
}

/** The file-reading seam; tests inject a fake. */
export interface DiskStateClient {
  readAssignedText(): Promise<string>;
  readUnassignedText(): Promise<string>;
}

export function createDiskStateClient(disksIniPath: string, devsIniPath: string): DiskStateClient {
  return {
    readAssignedText: () => readTextOrEmpty(() => readFile(disksIniPath, 'utf8')),
    readUnassignedText: () => readTextOrEmpty(() => readFile(devsIniPath, 'utf8')),
  };
}
