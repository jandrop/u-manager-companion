/**
 * Disk-utilization feature module.
 *
 * Backs the SDL's `updateDiskUtilizationThresholds` mutation. Per-disk
 * warning/critical utilization percentages live in `/boot/config/disk.cfg`
 * as `diskWarning.<idx>`/`diskCritical.<idx>`, owned by emhttpd and keyed
 * by the disk's SLOT INDEX. `src/resolvers.ts` binds this with permission
 * gating; all IO goes through the injected command sender.
 *
 * There is no read counterpart on purpose: the native Unraid API already
 * serves these as `array { disks { idx warning critical } }`.
 *
 * PARTIAL by contract -- an omitted field is not sent, so it keeps its
 * current value. This is the OPPOSITE of the sibling `updateDiskThresholds`
 * (features/disk_thresholds), whose input is TOTAL because it rewrites a
 * whole cfg file and cannot express "leave this one alone". emhttpd can,
 * so it needs no read-modify-write. Do not align one with the other.
 */
import { ValidationError } from '../../context.js';
import type { AuditCaller, AuditLogger } from '../../audit.js';
import { isEmhttpdFailureResponse, type EmhttpdCommands } from '../shares/platform.js';

/** The one method this module needs off shares' EmhttpdClient -- never
 * the share-specific reads. server.ts wires it from the client it
 * already constructs. */
export interface EmhttpdCommandSender {
  sendCommand(commands: EmhttpdCommands): Promise<string>;
}

/**
 * A write request for one disk slot. Field presence is the contract:
 *   absent -> not sent, keeps its current value
 *   null   -> sent EMPTY, clearing it back to inheriting the global
 *   number -> set
 */
export interface DiskUtilizationThresholdsInput {
  readonly diskIdx: number;
  readonly warning?: number | null;
  readonly critical?: number | null;
}

interface MutationDeps {
  readonly client: EmhttpdCommandSender;
  readonly audit: AuditLogger;
  readonly caller: AuditCaller;
}

const PERCENTAGE_MIN = 0;
const PERCENTAGE_MAX = 100;

function validatePercentage(field: string, value: number): void {
  if (!Number.isInteger(value)) {
    throw new ValidationError(`${field} must be an integer.`);
  }
  if (value < PERCENTAGE_MIN || value > PERCENTAGE_MAX) {
    throw new ValidationError(`${field} must be between ${PERCENTAGE_MIN} and ${PERCENTAGE_MAX}.`);
  }
}

/** Fail-fast before any IO, per validateShareName()'s pattern. An
 * inverted pair (warning above critical) is deliberately ACCEPTED: the
 * webGUI has no such check and this service is never stricter than the
 * surface it wraps. A null needs no range check -- it clears the field. */
function validateInput(input: DiskUtilizationThresholdsInput): void {
  if (!Number.isInteger(input.diskIdx) || input.diskIdx < 1) {
    throw new ValidationError('diskIdx must be a positive integer.');
  }
  if (input.warning === undefined && input.critical === undefined) {
    throw new ValidationError('Provide warning, critical, or both -- nothing to update.');
  }
  if (input.warning != null) validatePercentage('warning', input.warning);
  if (input.critical != null) validatePercentage('critical', input.critical);
}

/** Maps the input to a `changeDisk=Apply` payload carrying ONLY the
 * fields the caller named. 0 is emitted as "0" (a real value that
 * disables the band); null is emitted empty (cleared). */
export function buildDiskUtilizationCommands(
  input: DiskUtilizationThresholdsInput,
): EmhttpdCommands {
  const commands: Record<string, string> = { changeDisk: 'Apply' };
  if (input.warning !== undefined) {
    commands[`diskWarning.${input.diskIdx}`] = input.warning === null ? '' : String(input.warning);
  }
  if (input.critical !== undefined) {
    commands[`diskCritical.${input.diskIdx}`] =
      input.critical === null ? '' : String(input.critical);
  }
  return commands;
}

/** Backs `Mutation.updateDiskUtilizationThresholds`. Audited BEFORE the
 * round-trip so a refused or failed write stays visible in the log.
 * emhttpd signals an application-level refusal in the response BODY
 * rather than rejecting, so the body is checked explicitly. */
export async function updateDiskUtilizationThresholds(
  input: DiskUtilizationThresholdsInput,
  deps: MutationDeps,
): Promise<boolean> {
  validateInput(input);

  deps.audit.recordAuditEvent({
    action: 'diskUtilizationThresholds.update',
    caller: deps.caller,
    target: String(input.diskIdx),
    outcome: 'initiated',
  });

  const response = await deps.client.sendCommand(buildDiskUtilizationCommands(input));
  if (isEmhttpdFailureResponse(response)) {
    throw new ValidationError(
      `emhttpd refused updateDiskUtilizationThresholds: ${response.trim().slice(0, 200)}`,
    );
  }

  return true;
}
