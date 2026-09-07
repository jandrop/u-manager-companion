/** Per-disk SMART settings: domain <-> file mapping, and the injectable
 * SmartConfigClient. Owns the -1 sentinel, smLevel's 2-decimal format and the
 * smEvents/smCustom pair; ini.ts underneath speaks only strings. */
import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { atomicWrite } from '../../platform/atomic-write.js';
import { listSectionNames, patchSection, readSectionValues, removeSection } from './ini.js';

/** Every key this feature writes. `smCustom` is written, never exposed. */
export const SMART_FILE_KEYS = [
  'hotTemp',
  'maxTemp',
  'smSelect',
  'smLevel',
  'smEvents',
  'smCustom',
] as const;

/** The codes the webGUI renders as checkboxes (Preselect.php). */
export const PRESELECT_ATTRIBUTES = [5, 187, 188, 197, 198, 199] as const;

/** Unraid's default monitored set. 188 is a preselect code but is default-off. */
export const DEFAULT_NOTIFY_ATTRIBUTES = [5, 187, 197, 198, 199] as const;

export interface DiskSmartSettingsRecord {
  readonly diskId: string;
  readonly configured: boolean;
  readonly hotTemp: number | null;
  readonly maxTemp: number | null;
  readonly smSelect: number | null;
  readonly smLevel: number | null;
  readonly notifyAttributes: readonly number[] | null;
  readonly defaultNotifyAttributes: readonly number[];
  readonly preselectAttributes: readonly number[];
}

export type DiskSmartSettingsInput = {
  readonly [K in
    | 'hotTemp'
    | 'maxTemp'
    | 'smSelect'
    | 'smLevel'
    | 'notifyAttributes']: DiskSmartSettingsRecord[K];
};

const INTEGER_RE = /^-?\d+$/;
const DECIMAL_RE = /^-?\d+(?:\.\d+)?$/;

const UNSET_SENTINEL = -1;

function parseIntOrNull(raw: string | undefined): number | null {
  if (raw === undefined || !INTEGER_RE.test(raw)) return null;
  const value = Number(raw);
  return value === UNSET_SENTINEL ? null : value;
}

function parseDecimalOrNull(raw: string | undefined): number | null {
  if (raw === undefined || !DECIMAL_RE.test(raw)) return null;
  const value = Number(raw);
  return value === UNSET_SENTINEL ? null : value;
}

function parseAttributeList(raw: string | undefined): readonly number[] | null {
  if (raw === undefined) return null;
  const codes = raw
    .split('|')
    .map((token) => token.trim())
    .filter((token) => INTEGER_RE.test(token))
    .map(Number);
  return codes.length > 0 ? codes : null;
}

/** One disk's record. `configured` reflects the section's presence, not its values. */
export function parseDiskSmartSettings(text: string, section: string): DiskSmartSettingsRecord {
  const values = readSectionValues(text, section);
  return {
    diskId: section,
    configured: values !== null,
    hotTemp: parseIntOrNull(values?.get('hotTemp')),
    maxTemp: parseIntOrNull(values?.get('maxTemp')),
    smSelect: parseIntOrNull(values?.get('smSelect')),
    smLevel: parseDecimalOrNull(values?.get('smLevel')),
    notifyAttributes: parseAttributeList(values?.get('smEvents')),
    defaultNotifyAttributes: [...DEFAULT_NOTIFY_ATTRIBUTES],
    preselectAttributes: [...PRESELECT_ATTRIBUTES],
  };
}

/** One record per section present, in file order. Nameless `[]` headers are skipped. */
export function parseAllDiskSmartSettings(text: string): readonly DiskSmartSettingsRecord[] {
  return listSectionNames(text)
    .filter((name) => name.length > 0)
    .map((name) => parseDiskSmartSettings(text, name));
}

function isPreselect(code: number): boolean {
  return (PRESELECT_ATTRIBUTES as readonly number[]).includes(code);
}

function canonicalAttributes(codes: readonly number[]): readonly number[] {
  const unique = [...new Set(codes)];
  return [
    ...PRESELECT_ATTRIBUTES.filter((code) => unique.includes(code)),
    ...unique.filter((code) => !isPreselect(code)),
  ];
}

function isDefaultSet(codes: readonly number[]): boolean {
  return (
    codes.length === DEFAULT_NOTIFY_ATTRIBUTES.length &&
    codes.every((code, index) => code === DEFAULT_NOTIFY_ATTRIBUTES[index])
  );
}

/** Domain input -> file values. `null` clears the key. smLevel of exactly 1 and
 * the default attribute set both write as absent, matching the webGUI. */
export function toFileValues(input: DiskSmartSettingsInput): ReadonlyMap<string, string | null> {
  const codes = input.notifyAttributes === null ? null : canonicalAttributes(input.notifyAttributes);
  const custom = codes === null ? [] : codes.filter((code) => !isPreselect(code));
  const smEvents =
    codes === null || codes.length === 0 || isDefaultSet(codes) ? null : codes.join('|');

  return new Map<string, string | null>([
    ['hotTemp', input.hotTemp === null ? null : String(input.hotTemp)],
    ['maxTemp', input.maxTemp === null ? null : String(input.maxTemp)],
    ['smSelect', input.smSelect === null ? null : String(input.smSelect)],
    ['smLevel', input.smLevel === null || input.smLevel === 1 ? null : input.smLevel.toFixed(2)],
    ['smEvents', smEvents],
    ['smCustom', smEvents === null || custom.length === 0 ? null : custom.join(',')],
  ]);
}

export function patchDiskSmartSettings(
  text: string,
  section: string,
  input: DiskSmartSettingsInput,
): string {
  return patchSection(text, section, toFileValues(input));
}

export function removeDiskSmartSection(text: string, section: string): string {
  return removeSection(text, section);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** ENOENT reads as empty: a missing file is the normal stock state. Every other
 * errno propagates, so EACCES is never mistaken for "unconfigured". */
export async function readTextOrEmpty(read: () => Promise<string>): Promise<string> {
  try {
    return await read();
  } catch (error) {
    if (isEnoent(error)) return '';
    throw error;
  }
}

/** Text-level file access. Fakes replace it in tests. */
export interface SmartConfigClient {
  readText(): Promise<string>;
  writeText(content: string): Promise<void>;
  deleteFile(): Promise<void>;
}

export function createSmartConfigClient(cfgPath: string): SmartConfigClient {
  return {
    readText: () => readTextOrEmpty(() => readFile(cfgPath, 'utf8')),
    writeText: async (content: string) => {
      atomicWrite(cfgPath, content);
    },
    deleteFile: async () => {
      rmSync(cfgPath, { force: true });
    },
  };
}
