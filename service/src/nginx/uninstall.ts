/**
 * nginx uninstall cleanup path.
 *
 * Invoked by the plugin's remove script and the service's own
 * shutdown hook: removes the plugin-owned include file, strips the single
 * appended `include <path>;` line from locations.conf (preserving every
 * other line -- other services/platform-generated lines are untouched),
 * and runs a validated reload so no orphaned `location` block survives an
 * uninstall.
 *
 * Uses the SAME validated-reload primitive as the install/self-heal paths
 * (validated-reload.ts) for the final reload, but the file removal here is
 * its own explicit step: after uninstall there is no candidate content for
 * includePath at all (the file itself goes away), which is a different
 * shape than validatedReload's "write new content" flow.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { buildIncludeLine } from './locations-append.js';
import type { RunNginx } from './validated-reload.js';

export interface UninstallNginxIntegrationOptions {
  /** Real, on-disk path of the plugin-owned include file. */
  readonly includePath: string;
  /** Path to the platform-generated locations.conf. */
  readonly locationsConfPath: string;
  /** Path to the nginx binary. */
  readonly nginxBinaryPath: string;
  /** Injectable nginx process runner. */
  readonly runNginx: RunNginx;
}

/** Removes the plugin-owned include file, if present. */
function removeIncludeFile(includePath: string): void {
  rmSync(includePath, { force: true });
}

/**
 * Strips the single `include <includePath>;` line from locations.conf,
 * leaving every other line untouched. No-op if locations.conf is absent or
 * the line isn't present.
 */
function stripIncludeLine(locationsConfPath: string, includePath: string): void {
  if (!existsSync(locationsConfPath)) {
    return;
  }

  const includeLine = buildIncludeLine(includePath);
  const content = readFileSync(locationsConfPath, 'utf8');
  const lines = content.split('\n');
  const filtered = lines.filter((line) => line.trim() !== includeLine);

  if (filtered.length === lines.length) {
    // Line was never present -- nothing changed, avoid an unnecessary write.
    return;
  }

  // Re-join preserving the original trailing-newline shape as closely as
  // possible: split('\n') on a file ending in '\n' produces a trailing ''
  // element, which join('\n') reproduces correctly.
  writeFileSync(locationsConfPath, filtered.join('\n'));
}

/**
 * Full uninstall cleanup: remove the include file, strip the appended line
 * from locations.conf, and run a validated reload so nginx picks up the
 * removal (no orphaned location block survives).
 */
export async function uninstallNginxIntegration(
  options: UninstallNginxIntegrationOptions,
): Promise<void> {
  const { includePath, locationsConfPath, nginxBinaryPath, runNginx } = options;

  removeIncludeFile(includePath);
  stripIncludeLine(locationsConfPath, includePath);

  // Validate + reload the real tree so the removal takes effect. Unlike
  // validatedReload's write-and-test-a-candidate flow, there is no new
  // includePath content to write here -- we're just confirming the tree
  // (now without our location block) is still valid and applying it.
  const testResult = await runNginx(nginxBinaryPath, ['-t']);
  if (testResult.exitCode === 0) {
    await runNginx(nginxBinaryPath, ['-s', 'reload']);
  }
}
