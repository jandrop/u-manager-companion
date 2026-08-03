/**
 * Disk-thresholds feature module.
 *
 * Backs the SDL's `diskThresholds` query and `updateDiskThresholds`
 * mutation (schema/schema.graphql). `src/resolvers.ts` binds these with
 * permission gating (the query is ungated, the mutation requires the
 * `diskThresholds` operation under the `DISPLAY` resource); this module
 * holds the actual behavior, delegating every byte-level decision to the
 * pure parse/patch functions in platform.ts and all IO to the injected
 * `DynamixConfigClient`.
 *
 * The mutation records ONE audit entry (`outcome: 'initiated'`) AFTER
 * validation but BEFORE the file write -- a write that later fails
 * (EROFS, ENOSPC) must still be visible in the audit log. There is no
 * separate acceptance signal to wait for (unlike shares' emhttpd
 * round-trip), so 'initiated' is the terminal outcome recorded.
 */
import type { AuditCaller, AuditLogger } from '../../audit.js';
import type { DiskThresholdKey, DiskThresholdsInput, DiskThresholdsRecord, DynamixConfigClient } from './platform.js';
import { parseDiskThresholds, patchDiskThresholds } from './platform.js';

const PERCENTAGE_KEYS: readonly DiskThresholdKey[] = ['warning', 'critical'];
const TEMPERATURE_KEYS: readonly DiskThresholdKey[] = ['hot', 'max', 'hotssd', 'maxssd'];

interface ClientDeps {
  readonly client: DynamixConfigClient;
}

interface MutationDeps extends ClientDeps {
  readonly audit: AuditLogger;
  readonly caller: AuditCaller;
}

function validateRange(key: DiskThresholdKey, value: number, min: number, max: number): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${key} must be an integer.`);
  }
  if (value < min || value > max) {
    throw new Error(`${key} must be between ${min} and ${max}.`);
  }
}

/** Fail-fast on the first bad field, per validateShareName()'s pattern.
 * warning/critical are percentages [0,100]; hot/max/hotssd/maxssd are
 * temperatures [0,300]. Ordering between warning and critical is
 * deliberately NOT enforced (see spec's "Inverted thresholds accepted"
 * scenario). */
function validateDiskThresholdsInput(input: DiskThresholdsInput): void {
  for (const key of PERCENTAGE_KEYS) {
    validateRange(key, input[key], 0, 100);
  }
  for (const key of TEMPERATURE_KEYS) {
    validateRange(key, input[key], 0, 300);
  }
}

/** Backs `Query.diskThresholds`. Read-only -- NOT audited. */
export async function getDiskThresholds(deps: ClientDeps): Promise<DiskThresholdsRecord> {
  const cfgText = await deps.client.readText();
  return parseDiskThresholds(cfgText);
}

/** Backs `Mutation.updateDiskThresholds(input)`. Validates first (before
 * any IO), reads the current file, records the audit entry, patches, and
 * writes -- then returns `parseDiskThresholds` of the text that was just
 * written (never a re-read; see design decision D3). */
export async function updateDiskThresholds(
  input: DiskThresholdsInput,
  deps: MutationDeps,
): Promise<DiskThresholdsRecord> {
  validateDiskThresholdsInput(input);

  const currentText = await deps.client.readText();

  deps.audit.recordAuditEvent({
    action: 'diskThresholds.update',
    caller: deps.caller,
    outcome: 'initiated',
  });

  const patchedText = patchDiskThresholds(currentText, input);
  await deps.client.writeText(patchedText);

  return parseDiskThresholds(patchedText);
}
