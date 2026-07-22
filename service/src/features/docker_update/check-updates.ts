/**
 * docker.checkForUpdates.
 *
 * Shells to the dynamix `dockerupdate` CLI (no args) and returns true iff
 * it exits 0. Mirrors the "Check for Updates" button on the Unraid Docker
 * page (refreshes `/var/lib/docker/unraid-update-status.json` so
 * `updateAvailable` flags surface on the next container list fetch).
 * Synchronous mutation (`Boolean!` in the SDL, no streamed operation) --
 * unlike install/edit/update, this runs to completion before returning.
 *
 * Privileged + audited (auth/permissions.ts maps 'docker.checkForUpdates'
 * to DOCKER:update) -- distinct from the plugins-namespace
 * `checkForUpdates`, which is explicitly NOT audited since it's a
 * non-privileged read.
 */
import type { AuditCaller, AuditLogger } from '../../audit.js';
import type { StreamedProcessRunner } from '../../platform/process-runner.js';

export const DOCKERUPDATE_CLI = '/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/dockerupdate';

export interface CheckForDockerUpdatesDeps {
  readonly runDockerUpdateScript: StreamedProcessRunner;
  readonly audit: AuditLogger;
  readonly caller: AuditCaller;
}

/**
 * Runs the dockerupdate CLI to completion and returns whether it
 * succeeded. Audits the outcome (succeeded/failed) once the script exits.
 */
export async function checkForDockerUpdates(deps: CheckForDockerUpdatesDeps): Promise<boolean> {
  const result = await deps.runDockerUpdateScript(DOCKERUPDATE_CLI, [], () => {
    /* dockerupdate's own stdout/stderr is not surfaced -- this is a
     * synchronous cache-refresh action, not a streamed operation. */
  });
  const ok = result.exitCode === 0;

  deps.audit.recordAuditEvent({
    action: 'docker.checkForUpdates',
    caller: deps.caller,
    outcome: ok ? 'succeeded' : 'failed',
  });

  return ok;
}
