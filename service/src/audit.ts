/**
 * Audit log module.
 *
 * Every privileged feature-module action calls `recordAuditEvent()`
 * synchronously -- BEFORE (fire-and-forget power) or immediately after
 * initiating (streamed docker/plugin ops) the underlying side effect: "log
 * must survive process death" for power actions in particular, since the
 * process can be gone by the time a completion signal would otherwise be
 * recorded.
 *
 * Each record is one JSON-lines entry:
 *   {action, caller: {id, name}, timestamp, target?, outcome}
 *
 * Storage: a rotating file at an INJECTABLE path (never a hardcoded
 * `<service-run-dir>/audit.log` inside this module -- the real run-dir is
 * wired by server.ts; tests pass a temp-dir path so nothing here ever
 * touches the real filesystem). Rotation is size-based with a capped
 * number of retained rotated files (size-based here; day-based rotation
 * would require a scheduler, which is out of scope for a v1 synchronous
 * logger and can be layered on top without changing this module's public
 * surface).
 *
 * The optional syslog mirror (`logger -t u-manager-companion-audit`) is
 * injected as a plain function so tests never actually shell out -- server.ts
 * wires the real mirror via execSync/execa at startup. A mirror failure must
 * NEVER prevent the file write (the file is the source of truth); the mirror
 * is best-effort only and does not replace the file.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** Lifecycle outcome recorded for a privileged action.
 *
 * - 'initiated' is written at call time for every action kind.
 * - 'succeeded'/'failed' update a STREAMED action's record once its
 *   operation resolves (docker template/update, plugin uninstall -- looked
 *   up by operation id at that point).
 * - Power actions are terminal at 'initiated': the detached process may
 *   outlive (or, for shutdown/reboot, terminate) this process before a
 *   completion signal could ever be recorded.
 */
export type AuditOutcome = 'initiated' | 'succeeded' | 'failed';

export interface AuditCaller {
  readonly id: string;
  readonly name: string;
}

export interface AuditEventInput {
  /** Operation type, e.g. 'docker.templateInstall', 'power.reboot',
   * 'plugins.uninstall'. Matches CAPABILITY_KEYS naming (schema/version.ts)
   * where the action maps 1:1 to a capability; power actions use
   * 'power.<shutdown|reboot|sleep>' since the capability key itself is the
   * coarser 'power'. */
  readonly action: string;
  readonly caller: AuditCaller;
  /** Subject of the action -- container/template name, plugin filename.
   * Omitted for power (no meaningful target). */
  readonly target?: string;
  readonly outcome: AuditOutcome;
}

export interface AuditEventRecord extends AuditEventInput {
  readonly timestamp: string;
}

export interface AuditLoggerOptions {
  /** Full path to the active audit log file. Injectable -- production
   * wiring (server.ts) points this at the real service run-dir; tests point
   * it at a temp directory. */
  readonly logPath: string;
  /** Optional syslog mirror, e.g. `logger -t u-manager-companion-audit`.
   * Called with the same one-line JSON string written to the file.
   * Best-effort: any throw is swallowed, never propagated to the caller. */
  readonly syslogMirror?: (line: string) => void;
  /** Rotate once the active log file would exceed this many bytes.
   * Defaults to 10 MiB. */
  readonly maxBytes?: number;
  /** Maximum number of rotated files retained (logPath.1, logPath.2, ...).
   * Oldest beyond this count is deleted on rotation. Defaults to 5. */
  readonly maxRotatedFiles?: number;
}

export interface AuditLogger {
  recordAuditEvent(input: AuditEventInput): void;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ROTATED_FILES = 5;

/**
 * Creates an audit logger bound to a specific log path. One instance is
 * expected to live for the process lifetime in production (server.ts), but
 * the factory shape keeps this module free of module-level mutable state so
 * tests can create independent instances per test without interference.
 */
export function createAuditLogger(options: AuditLoggerOptions): AuditLogger {
  const { logPath } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRotatedFiles = options.maxRotatedFiles ?? DEFAULT_MAX_ROTATED_FILES;

  return {
    recordAuditEvent(input) {
      const record: AuditEventRecord = {
        action: input.action,
        caller: input.caller,
        timestamp: new Date().toISOString(),
        // exactOptionalPropertyTypes: true -- omit the key entirely rather
        // than assigning `undefined` when no target was provided.
        ...(input.target !== undefined ? { target: input.target } : {}),
        outcome: input.outcome,
      };
      const line = JSON.stringify(record);

      ensureParentDir(logPath);
      rotateIfNeeded(logPath, line, maxBytes, maxRotatedFiles);
      appendFileSync(logPath, `${line}\n`, { encoding: 'utf8', mode: 0o644 });

      if (options.syslogMirror) {
        try {
          options.syslogMirror(line);
        } catch {
          // Best-effort mirror -- the file write above is the source of
          // truth and must never be undone by a syslog failure.
        }
      }
    },
  };
}

function ensureParentDir(logPath: string): void {
  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Rotates logPath -> logPath.1 -> logPath.2 -> ... (shifting older files up,
 * dropping anything beyond maxRotatedFiles) when appending `nextLine` would
 * push the active file over `maxBytes`. Rotation happens BEFORE the write
 * that would exceed the budget, so the active file's own size never itself
 * exceeds maxBytes by more than a single line, and no in-flight write is
 * ever split across the rotation boundary.
 */
function rotateIfNeeded(
  logPath: string,
  nextLine: string,
  maxBytes: number,
  maxRotatedFiles: number,
): void {
  if (!existsSync(logPath)) return;
  const currentSize = statSync(logPath).size;
  const projectedSize = currentSize + nextLine.length + 1; // +1 for the newline.
  if (projectedSize <= maxBytes) return;

  // Drop the oldest retained file if it would overflow the cap, then shift
  // every remaining rotated file up by one index, then move the active
  // file to `.1`. Walking from the highest index down avoids clobbering a
  // file before it's been shifted.
  const oldestPath = `${logPath}.${maxRotatedFiles}`;
  if (existsSync(oldestPath)) {
    rmSync(oldestPath, { force: true });
  }
  for (let index = maxRotatedFiles - 1; index >= 1; index -= 1) {
    const from = `${logPath}.${index}`;
    const to = `${logPath}.${index + 1}`;
    if (existsSync(from)) {
      renameSync(from, to);
    }
  }
  renameSync(logPath, `${logPath}.1`);
}
