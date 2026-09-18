/**
 * Reads one disk's warning/critical percentages out of /boot/config/disk.cfg,
 * keyed by slot index like the write side. The file is flat, with no
 * `[section]` headers. Writes go through emhttpd's `changeDisk` command.
 */
import { readFile } from 'node:fs/promises';

const KEY_VALUE_RE = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/;
const INTEGER_RE = /^-?\d+$/;

export interface DiskUtilizationThresholdsRecord {
  readonly diskIdx: number;
  readonly warning: number | null;
  readonly critical: number | null;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Raw, still-quoted value per `key=value` line; a duplicated key keeps
 * its last occurrence. */
function parseKeyValues(text: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = KEY_VALUE_RE.exec(line);
    if (!match) continue;
    values.set(match[1]!, match[2] ?? '');
  }
  return values;
}

/** An absent key, an empty value and non-integer junk all read as null:
 * the disk inherits the global percentage. `0` is a real value, the band
 * disabled, and must never collapse into that null. */
function parsePercentOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const unquoted = stripQuotes(raw).trim();
  return INTEGER_RE.test(unquoted) ? Number(unquoted) : null;
}

export function parseDiskUtilizationThresholds(
  text: string,
  diskIdx: number,
): DiskUtilizationThresholdsRecord {
  const values = parseKeyValues(text);
  return {
    diskIdx,
    warning: parsePercentOrNull(values.get(`diskWarning.${diskIdx}`)),
    critical: parsePercentOrNull(values.get(`diskCritical.${diskIdx}`)),
  };
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** ENOENT reads as empty, so every disk reads as inheriting the global
 * percentage. Every other errno propagates, so EACCES is never mistaken
 * for "nothing configured". */
export async function readTextOrEmpty(read: () => Promise<string>): Promise<string> {
  try {
    return await read();
  } catch (error) {
    if (isEnoent(error)) return '';
    throw error;
  }
}

/** Text-level file access, read-only. A fake replaces it in tests. */
export interface DiskConfigClient {
  readText(): Promise<string>;
}

export function createDiskConfigClient(cfgPath: string): DiskConfigClient {
  return {
    readText: () => readTextOrEmpty(() => readFile(cfgPath, 'utf8')),
  };
}
