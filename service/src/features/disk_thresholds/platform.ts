/**
 * Disk-thresholds platform primitives + the injectable DynamixConfigClient
 * contract.
 *
 * Everything that can corrupt a user's dynamix.cfg -- the parse and the
 * byte-preserving patch -- lives in exported PURE functions
 * (parseDiskThresholds/patchDiskThresholds), testable with plain strings
 * and zero IO. DynamixConfigClient is deliberately TEXT-LEVEL only
 * (readText/writeText); every byte-level decision about the six target
 * keys happens in the pure functions above it, not inside the client.
 * Production wiring (server.ts) builds the REAL client (real fs read +
 * atomic write); tests inject a fake so nothing here ever touches the
 * real filesystem in a unit test.
 */
import { readFile } from 'node:fs/promises';
import { atomicWrite } from '../../platform/atomic-write.js';

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** The six global disk-health threshold keys, as they appear in
 * dynamix.cfg's [display] section. `unit` is deliberately excluded --
 * it's a client-side display preference (C/F), not a threshold. */
export const DISK_THRESHOLD_KEYS = ['warning', 'critical', 'hot', 'max', 'hotssd', 'maxssd'] as const;

export type DiskThresholdKey = (typeof DISK_THRESHOLD_KEYS)[number];

/** Read side -- null means the key is absent from [display], not a
 * substituted default. See design decision D2: inventing a value would
 * let a user open the edit form, see a plausible number, press Save, and
 * unknowingly pin a key that was deliberately unset. */
export interface DiskThresholdsRecord {
  readonly warning: number | null;
  readonly critical: number | null;
  readonly hot: number | null;
  readonly max: number | null;
  readonly hotssd: number | null;
  readonly maxssd: number | null;
}

/** Write side -- every field required. A mutation always supplies an
 * explicit value per field (see spec's "SDL Read/Write Asymmetry"). */
export type DiskThresholdsInput = { readonly [K in keyof DiskThresholdsRecord]: number };

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without any IO)
// ---------------------------------------------------------------------------

const SECTION_HEADER_RE = /^\[([^\]]*)\]$/;
/** indent, key, `= `-with-surrounding-whitespace, value, trailing whitespace. */
const KEY_VALUE_RE = /^(\s*)([A-Za-z0-9_.-]+)(\s*=\s*)(.*?)(\s*)$/;
const LINE_TERMINATOR_RE = /(\r\n|\n)$/;
const INTEGER_RE = /^-?\d+$/;

function isDiskThresholdKey(key: string): key is DiskThresholdKey {
  return (DISK_THRESHOLD_KEYS as readonly string[]).includes(key);
}

/** Splits `text` into lines that each keep their OWN terminator
 * (`\n`/`\r\n`), so a no-op rejoin (`lines.join('')`) is byte-identical
 * for any EOL mix. A plain `split(/\r?\n/)` + join would normalise mixed
 * EOLs; this does not. */
function splitPreservingTerminators(text: string): string[] {
  return text.split(/(?<=\n)/);
}

function terminatorOf(line: string): string {
  const match = LINE_TERMINATOR_RE.exec(line);
  return match ? match[1]! : '';
}

function stripTerminator(line: string): string {
  return line.replace(LINE_TERMINATOR_RE, '');
}

function sectionNameOf(strippedLine: string): string | null {
  const match = SECTION_HEADER_RE.exec(strippedLine.trim());
  return match ? (match[1] ?? '').toLowerCase() : null;
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

function parseThresholdValue(rawValue: string): number | null {
  const unquoted = stripQuotes(rawValue).trim();
  return INTEGER_RE.test(unquoted) ? Number(unquoted) : null;
}

/** Preserves the value's original quoting style: `"…"` -> `"<n>"`,
 * `'…'` -> `'<n>'`, bare -> `<n>`. */
function formatThresholdValue(rawValue: string, newValue: number): string {
  if (rawValue.length >= 2) {
    const first = rawValue[0];
    const last = rawValue[rawValue.length - 1];
    if (first === '"' && last === '"') return `"${newValue}"`;
    if (first === "'" && last === "'") return `'${newValue}'`;
  }
  return `${newValue}`;
}

/**
 * Parses dynamix.cfg content and returns the six target keys as read from
 * the [display] section. An absent key (or an entirely absent [display]
 * section) reads as `null`; a non-integer value (empty, `45.5`, junk)
 * also reads as `null` rather than throwing. Keys with the same name
 * living in a different section (e.g. [notify]'s own `warning`) are never
 * read -- scoping is strictly to [display].
 */
export function parseDiskThresholds(cfgText: string): DiskThresholdsRecord {
  const result: { -readonly [K in DiskThresholdKey]: number | null } = {
    warning: null,
    critical: null,
    hot: null,
    max: null,
    hotssd: null,
    maxssd: null,
  };

  let currentSection: string | null = null;
  for (const rawLine of splitPreservingTerminators(cfgText)) {
    const stripped = stripTerminator(rawLine);
    const sectionName = sectionNameOf(stripped);
    if (sectionName !== null) {
      currentSection = sectionName;
      continue;
    }
    if (currentSection !== 'display') continue;

    const kvMatch = KEY_VALUE_RE.exec(stripped);
    if (!kvMatch) continue;
    const key = kvMatch[2]!;
    if (!isDiskThresholdKey(key)) continue;
    result[key] = parseThresholdValue(kvMatch[4] ?? '');
  }

  return result;
}

interface SectionBounds {
  /** Index of the `[display]` header line itself. */
  readonly headerIndex: number;
  /** Index of the NEXT section header (any name) after headerIndex, or
   * `lines.length` when [display] runs to the end of the file. */
  readonly endIndex: number;
}

function findDisplaySectionBounds(lines: readonly string[]): SectionBounds | null {
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const sectionName = sectionNameOf(stripTerminator(lines[i]!));
    if (sectionName === null) continue;
    if (headerIndex === -1) {
      if (sectionName === 'display') headerIndex = i;
      continue;
    }
    return { headerIndex, endIndex: i };
  }
  return headerIndex === -1 ? null : { headerIndex, endIndex: lines.length };
}

/** Index of the last non-blank line strictly between `headerIndex` and
 * `endIndex` (exclusive), so an appended key lands with the rest of the
 * block's keys rather than after a trailing blank line separating the
 * next section. Falls back to `headerIndex` itself when the block holds
 * no non-blank content. */
function lastNonBlankLineIndex(lines: readonly string[], headerIndex: number, endIndex: number): number {
  for (let i = endIndex - 1; i > headerIndex; i -= 1) {
    if (stripTerminator(lines[i]!).trim() !== '') return i;
  }
  return headerIndex;
}

/** Dominant line terminator (`\r\n` vs `\n`) across `lines[start, end)`.
 * Returns '' when the range has no terminated lines at all. */
function dominantTerminator(lines: readonly string[], start: number, end: number): string {
  let crlf = 0;
  let lf = 0;
  for (let i = start; i < end; i += 1) {
    const terminator = terminatorOf(lines[i]!);
    if (terminator === '\r\n') crlf += 1;
    else if (terminator === '\n') lf += 1;
  }
  if (crlf === 0 && lf === 0) return '';
  return crlf > lf ? '\r\n' : '\n';
}

function appendMissingDisplaySection(cfgText: string, values: DiskThresholdsInput): string {
  const withTrailingNewline = cfgText.length > 0 && !/\r?\n$/.test(cfgText) ? `${cfgText}\n` : cfgText;
  const newSection = `\n[display]\n${DISK_THRESHOLD_KEYS.map((key) => `${key}="${values[key]}"\n`).join('')}`;
  return `${withTrailingNewline}${newSection}`;
}

/**
 * Patches dynamix.cfg content with new values for the six target keys,
 * scoped strictly to the [display] section. Preserves every unrelated
 * key, key order, every other section, quoting style, indentation, `=`
 * spacing and line terminator -- the only bytes that change are the six
 * target keys' values (and, for a missing key, one appended line).
 *
 * - An existing [display] section: each present target key is rewritten
 *   in place (every occurrence, if duplicated -- ini readers take
 *   last-wins, so a stale earlier line would be a lie); any target key
 *   NOT found is appended after the last non-blank line of the block.
 * - No [display] section at all: a new `[display]` block is appended at
 *   EOF with all six keys, after ensuring the existing content ends in a
 *   newline.
 */
export function patchDiskThresholds(cfgText: string, values: DiskThresholdsInput): string {
  const lines = splitPreservingTerminators(cfgText);
  const bounds = findDisplaySectionBounds(lines);
  if (!bounds) {
    return appendMissingDisplaySection(cfgText, values);
  }

  const { headerIndex, endIndex } = bounds;
  const found = new Set<DiskThresholdKey>();

  for (let i = headerIndex + 1; i < endIndex; i += 1) {
    const line = lines[i]!;
    const terminator = terminatorOf(line);
    const stripped = stripTerminator(line);
    const kvMatch = KEY_VALUE_RE.exec(stripped);
    if (!kvMatch) continue;
    const key = kvMatch[2]!;
    if (!isDiskThresholdKey(key)) continue;

    found.add(key);
    const indent = kvMatch[1] ?? '';
    const eq = kvMatch[3] ?? '';
    const rawValue = kvMatch[4] ?? '';
    const trailing = kvMatch[5] ?? '';
    lines[i] = `${indent}${key}${eq}${formatThresholdValue(rawValue, values[key])}${trailing}${terminator}`;
  }

  const missing = DISK_THRESHOLD_KEYS.filter((key) => !found.has(key));
  if (missing.length > 0) {
    const insertAt = lastNonBlankLineIndex(lines, headerIndex, endIndex);
    const eol =
      dominantTerminator(lines, headerIndex, endIndex) || dominantTerminator(lines, 0, lines.length) || '\n';
    const newLines = missing.map((key) => `${key}="${values[key]}"${eol}`);
    lines.splice(insertAt + 1, 0, ...newLines);
  }

  return lines.join('');
}

// ---------------------------------------------------------------------------
// DynamixConfigClient -- the injectable surface resolvers.ts depends on
// ---------------------------------------------------------------------------

export interface DynamixConfigClient {
  /** Reads the full raw text of dynamix.cfg. Throws when the file is
   * missing or unreadable -- unlike shares.ini, there is no safe
   * "degrade to empty" here (see design's "Where the shares precedent
   * must NOT be copied", item 1): a failed read must surface as an
   * error, not as plausible-looking invented data. */
  readText(): Promise<string>;
  /** Atomically writes the full raw text back (temp file in the same
   * directory + rename(2), via platform/atomic-write.ts). */
  writeText(content: string): Promise<void>;
}

/** Builds the REAL DynamixConfigClient bound to `cfgPath` (resolved by
 * platform/config.ts, never hardcoded at the call site). */
export function createDynamixConfigClient(cfgPath: string): DynamixConfigClient {
  return {
    readText: () => readFile(cfgPath, 'utf8'),
    writeText: (content: string) => Promise.resolve(atomicWrite(cfgPath, content)),
  };
}
