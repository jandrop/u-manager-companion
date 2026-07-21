/**
 * Server power mutations.
 *
 * Ported from `power.py` PHASE B (ServerService methods): shutdown ->
 * `/sbin/poweroff`, reboot -> `/sbin/reboot`, both fire-and-forget detached
 * processes -- no `powerdown` wrapper script dependency, matching the
 * reference's own rationale (mirrors what the web UI's Powerdown.php does
 * directly). sleep -> guarded on the Dynamix S3 Sleep plugin's
 * `rc.s3sleep` script existing; throws the SAME user-facing message as the
 * reference when it's missing, WITHOUT firing the detached call or
 * recording an audit entry (a rejected sleep request from a missing
 * capability is not a privileged action that happened).
 *
 * CRITICAL ordering invariant: audit entry recorded BEFORE the detached
 * call fires, because the log must survive process death. Every exported
 * function here calls `audit.recordAuditEvent()` SYNCHRONOUSLY BEFORE
 * calling `runDetached()`. This is not an optimization -- reboot and
 * shutdown can terminate THIS process before a completion signal could
 * ever be written, so the only safe place to log is before the side
 * effect, not after.
 */
import type { AuditCaller, AuditLogger } from '../../audit.js';
import type { DetachedProcessRunner } from '../../platform/process-runner.js';

export const POWEROFF_CLI = '/sbin/poweroff';
export const REBOOT_CLI = '/sbin/reboot';
export const S3_SLEEP_SCRIPT = '/usr/local/emhttp/plugins/dynamix.s3.sleep/scripts/rc.s3sleep';

interface PowerActionDeps {
  readonly runDetached: DetachedProcessRunner;
  readonly audit: AuditLogger;
  readonly caller: AuditCaller;
}

export interface SleepServerDeps extends PowerActionDeps {
  /** Injectable existence check for S3_SLEEP_SCRIPT -- production wiring
   * shells to fs.existsSync; tests inject a fake so nothing here touches
   * the real filesystem. */
  readonly sleepScriptExists: () => boolean;
}

/** Cleanly stops the array and powers the server off. Always returns true
 * (fire-and-forget -- the caller has no way to observe the actual power
 * event from this process). */
export function shutdownServer(deps: PowerActionDeps): boolean {
  deps.audit.recordAuditEvent({
    action: 'power.shutdown',
    caller: deps.caller,
    outcome: 'initiated',
  });
  deps.runDetached(POWEROFF_CLI, []);
  return true;
}

/** Cleanly stops the array and reboots the server. Same audit-before-fire
 * ordering as shutdownServer. */
export function rebootServer(deps: PowerActionDeps): boolean {
  deps.audit.recordAuditEvent({
    action: 'power.reboot',
    caller: deps.caller,
    outcome: 'initiated',
  });
  deps.runDetached(REBOOT_CLI, []);
  return true;
}

/** Puts the server into S3 sleep. Throws BEFORE any audit record or
 * detached call if the Dynamix S3 Sleep plugin's script is not present --
 * a capability gap is not a privileged action that happened. */
export function sleepServer(deps: SleepServerDeps): boolean {
  if (!deps.sleepScriptExists()) {
    throw new Error(
      'Sleep is not available. Install the Dynamix S3 Sleep plugin to enable this feature.',
    );
  }
  deps.audit.recordAuditEvent({
    action: 'power.sleep',
    caller: deps.caller,
    outcome: 'initiated',
  });
  deps.runDetached(S3_SLEEP_SCRIPT, []);
  return true;
}
