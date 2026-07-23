/**
 * unraidPlugins.checkForUpdates.
 *
 * Fires `plugin checkall` DETACHED (fire-and-forget) and returns true
 * immediately, without waiting for the check to finish -- the boolean
 * does NOT indicate check outcome; the client polls the list afterwards
 * (re-queries `installedUnraidPluginsDetailed` to pick up refreshed
 * `latestVersion` fields once the background check completes).
 *
 * Deliberately NOT audited: the read-only update-check is not privileged
 * and is not audited. The `audit` dependency is still accepted (rather
 * than omitted) so this function's signature stays structurally
 * consistent with every other feature-module entry point server.ts wires
 * up, but it is intentionally never called -- see check-updates.test.ts's
 * explicit negative assertion.
 */
import type { AuditLogger } from '../../audit.js';
import type { DetachedProcessRunner } from '../../platform/process-runner.js';
import { PLUGIN_CLI } from './uninstall.js';

export interface CheckForPluginUpdatesDeps {
  readonly runDetached: DetachedProcessRunner;
  /** Accepted for signature symmetry with other feature entry points;
   * deliberately never invoked -- see module doc. */
  readonly audit: AuditLogger;
}

/** Triggers a background plugin update check and returns true immediately. */
export function checkForPluginUpdates(deps: CheckForPluginUpdatesDeps): boolean {
  deps.runDetached(PLUGIN_CLI, ['checkall']);
  return true;
}
