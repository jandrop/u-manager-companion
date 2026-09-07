/** Per-disk SMART settings feature module. Backs the diskSmartSettings and
 * allDiskSmartSettings queries and the update/reset mutations. Mutations run
 * validate -> read -> audit -> patch -> write, returning the parse of the text
 * just written. Concurrent webGUI saves are last-writer-wins. */
import type { AuditCaller, AuditLogger } from '../../audit.js';
import { hasAnySection } from './ini.js';
import type {
  DiskSmartSettingsInput,
  DiskSmartSettingsRecord,
  SmartConfigClient,
} from './platform.js';
import {
  parseAllDiskSmartSettings,
  parseDiskSmartSettings,
  patchDiskSmartSettings,
  removeDiskSmartSection,
} from './platform.js';

interface ClientDeps {
  readonly client: SmartConfigClient;
}

interface MutationDeps extends ClientDeps {
  readonly audit: AuditLogger;
  readonly caller: AuditCaller;
}

const MAX_TEMPERATURE_CELSIUS = 300;

function requireInteger(key: string, value: number): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${key} must be an integer.`);
  }
}

function requireNonNegative(key: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must not be negative.`);
  }
}

function validateDiskSmartInput(input: DiskSmartSettingsInput): void {
  for (const key of ['hotTemp', 'maxTemp'] as const) {
    const value = input[key];
    if (value === null) continue;
    requireInteger(key, value);
    requireNonNegative(key, value);
    if (value > MAX_TEMPERATURE_CELSIUS) {
      throw new Error(`${key} must be between 0 and ${MAX_TEMPERATURE_CELSIUS}.`);
    }
  }

  if (input.smSelect !== null) {
    requireInteger('smSelect', input.smSelect);
    requireNonNegative('smSelect', input.smSelect);
  }
  if (input.smLevel !== null) {
    requireNonNegative('smLevel', input.smLevel);
  }

  const codes = input.notifyAttributes;
  if (codes === null) return;
  if (codes.length === 0) {
    throw new Error('notifyAttributes must not be empty; use null to inherit the default set.');
  }
  for (const code of codes) {
    requireInteger('notifyAttributes', code);
    requireNonNegative('notifyAttributes', code);
  }
}

const SERVER_ID_PREFIX_RE = /^[0-9a-f]{64}:/;

// Matching C0 controls is the point: a newline or NUL is how a header gets forged.
// eslint-disable-next-line no-control-regex -- matching them is the point
const UNSAFE_SECTION_CHARS_RE = /[[\]=;#"']|[\x00-\x1f]/;

const MAX_SECTION_NAME_LENGTH = 128;

/** Wire id -> section name, before any IO. Strips at most one 64-hex serverId
 * prefix; rejects ids carrying characters an INI header cannot hold, without
 * echoing the value. */
export function resolveDiskSectionId(raw: string): string {
  const section = raw.replace(SERVER_ID_PREFIX_RE, '');

  if (section.length === 0 || section.length > MAX_SECTION_NAME_LENGTH) {
    throw new Error(`Disk id must be 1 to ${MAX_SECTION_NAME_LENGTH} characters.`);
  }
  if (section !== section.trim()) {
    throw new Error('Disk id must not have leading or trailing whitespace.');
  }
  if (UNSAFE_SECTION_CHARS_RE.test(section)) {
    throw new Error('Disk id contains characters that cannot appear in a config section name.');
  }

  return section;
}

/** One disk. A missing file or section reads as unconfigured, never an error. */
export async function getDiskSmartSettings(
  diskId: string,
  deps: ClientDeps,
): Promise<DiskSmartSettingsRecord> {
  const section = resolveDiskSectionId(diskId);
  return parseDiskSmartSettings(await deps.client.readText(), section);
}

/** Every configured disk. A disk with no override is absent from the list. */
export async function getAllDiskSmartSettings(
  deps: ClientDeps,
): Promise<readonly DiskSmartSettingsRecord[]> {
  return parseAllDiskSmartSettings(await deps.client.readText());
}

/** Writes the five modeled keys for one disk. Audited before the write. */
export async function updateDiskSmartSettings(
  diskId: string,
  input: DiskSmartSettingsInput,
  deps: MutationDeps,
): Promise<DiskSmartSettingsRecord> {
  const section = resolveDiskSectionId(diskId);
  validateDiskSmartInput(input);

  const currentText = await deps.client.readText();

  deps.audit.recordAuditEvent({
    action: 'diskSmartSettings.update',
    caller: deps.caller,
    target: section,
    outcome: 'initiated',
  });

  const patchedText = patchDiskSmartSettings(currentText, section, input);
  await deps.client.writeText(patchedText);

  return parseDiskSmartSettings(patchedText, section);
}

/** Drops the disk's whole section, unlinking the file when none remain. */
export async function resetDiskSmartSettings(
  diskId: string,
  deps: MutationDeps,
): Promise<DiskSmartSettingsRecord> {
  const section = resolveDiskSectionId(diskId);

  const currentText = await deps.client.readText();

  deps.audit.recordAuditEvent({
    action: 'diskSmartSettings.reset',
    caller: deps.caller,
    target: section,
    outcome: 'initiated',
  });

  const nextText = removeDiskSmartSection(currentText, section);
  if (hasAnySection(nextText)) {
    await deps.client.writeText(nextText);
  } else {
    await deps.client.deleteFile();
  }

  return parseDiskSmartSettings(nextText, section);
}
