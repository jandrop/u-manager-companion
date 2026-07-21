/**
 * Startup sequence.
 *
 * Composes the nginx modules into the real startup flow:
 *
 *   1. crash-recovery check (nginx/crash-recovery.ts) -- restores a leftover
 *      `.bak` marker BEFORE trusting the real include path, closing the
 *      crash window described below.
 *   2. ensure-include + validated reload (nginx/locations-append.ts +
 *      nginx/validated-reload.ts) -- makes sure our include line is present
 *      in locations.conf and, if it had to be (re)written, runs a validated
 *      reload so nginx actually serves it.
 *   3. self-heal monitor start (nginx/self-heal-monitor.ts) -- the SAME
 *      ensure-include + validated-reload pair is wired as the monitor's
 *      `heal` callback, so a later regeneration of locations.conf (rc.nginx
 *      renew/update, verified live on box) is repaired the same way the
 *      initial startup ensures it.
 *
 * nginx integration is entirely TOGGLEABLE via CompanionConfig.nginxEnabled
 * ("no nginx" mode) -- when false, this module skips every nginx step and
 * returns a no-op monitor handle, so local/dev/CI smoke tests never depend
 * on a real nginx installation or `/etc/nginx/...` paths existing.
 */
import { recoverFromCrashIfNeeded } from './nginx/crash-recovery.js';
import { ensureIncludeAppended } from './nginx/locations-append.js';
import { buildIncludeFileContent } from './nginx/include.js';
import {
  runNginxViaExeca,
  validatedReload,
  type RunNginx,
} from './nginx/validated-reload.js';
import {
  startSelfHealMonitor,
  watchLocationsConfWithFs,
  type SelfHealMonitor,
  type WatchFile,
} from './nginx/self-heal-monitor.js';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CompanionConfig } from './platform/config.js';

export interface StartupNginxDeps {
  /** Injectable nginx process runner (real execa wiring by default; tests
   * inject a mock so no real `nginx` binary is required). */
  readonly runNginx?: RunNginx;
  /** Injectable fs-watch primitive for the self-heal monitor (real fs.watch
   * by default; tests inject a fake to avoid real filesystem event timing). */
  readonly watchFile?: WatchFile;
}

export interface NoopMonitor {
  readonly close: () => void;
}

/**
 * Writes the include file content to includePath, ensuring the parent
 * directory exists first -- the plugin-owned /boot directory may not exist
 * yet on a fresh install.
 */
function writeIncludeFile(includePath: string, content: string): void {
  mkdirSync(dirname(includePath), { recursive: true });
  writeFileSync(includePath, content);
}

/** Reads the include file's current content, or undefined if it does not
 * exist yet. Used to decide whether the include content actually changed and
 * therefore whether nginx must be reloaded to pick it up. */
function readIncludeFileIfPresent(includePath: string): string | undefined {
  try {
    return readFileSync(includePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Runs ensure-include + (if needed) a validated reload against the real
 * paths in `config`. Shared by the initial startup sequence and the
 * self-heal monitor's `heal` callback so both paths perform IDENTICALLY --
 * one recovery mechanism, not two independently-drifting ones.
 */
async function ensureIncludeAndReload(config: CompanionConfig, runNginx: RunNginx): Promise<void> {
  const candidateContent = buildIncludeFileContent({ port: config.servicePort });

  // Compare BEFORE overwriting: nginx caches config in memory, so a changed
  // include file on disk (e.g. after adding `allow all`, or a
  // COMPANION_SERVICE_PORT change) has NO effect on the running process until
  // a reload. Reloading only when the `include <path>;` line was newly
  // appended (the old behaviour) silently served stale include content
  // whenever the line already existed but the content changed. Verified live:
  // the endpoint 302-redirected until a manual `nginx -s reload`.
  const previousContent = readIncludeFileIfPresent(config.includePath);
  const contentChanged = previousContent !== candidateContent;

  // Always (re)write our OWN include file content first -- ensureIncludeAppended
  // only manages the single `include <path>;` line inside locations.conf, not
  // the include file's own content, which must independently reflect the
  // current port (e.g. after a COMPANION_SERVICE_PORT change).
  writeIncludeFile(config.includePath, candidateContent);

  const appended = ensureIncludeAppended({
    locationsConfPath: config.locationsConfPath,
    includePath: config.includePath,
  });

  // Reload when EITHER the include line was newly appended OR the include
  // content changed. Steady-state restarts (line present, content identical)
  // still skip the reload, so the self-heal monitor cannot cause a reload
  // storm.
  if (appended || contentChanged) {
    await validatedReload({
      includePath: config.includePath,
      candidateContent,
      nginxBinaryPath: config.nginxBinaryPath,
      runNginx,
    });
  }
}

/**
 * Runs the full nginx startup sequence (crash-recovery -> ensure-include +
 * validated reload -> self-heal monitor start) when nginx integration is
 * enabled, or returns a no-op monitor handle when it's disabled (task 7.2's
 * "no nginx" mode).
 */
export async function runNginxStartupSequence(
  config: CompanionConfig,
  deps: StartupNginxDeps = {},
): Promise<SelfHealMonitor | NoopMonitor> {
  if (!config.nginxEnabled) {
    return { close: () => {} };
  }

  const runNginx = deps.runNginx ?? runNginxViaExeca;
  const watchFile = deps.watchFile ?? watchLocationsConfWithFs;

  // Step 1: crash recovery, BEFORE trusting the real include path at all.
  recoverFromCrashIfNeeded({ includePath: config.includePath });

  // Step 2: ensure-include + validated reload for the current startup.
  await ensureIncludeAndReload(config, runNginx);

  // Step 3: self-heal monitor, wired with the SAME ensure-include +
  // validated-reload pair as its `heal` callback.
  return startSelfHealMonitor({
    locationsConfPath: config.locationsConfPath,
    includePath: config.includePath,
    watchFile,
    heal: () => ensureIncludeAndReload(config, runNginx),
  });
}
