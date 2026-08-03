/**
 * Startup crash recovery.
 *
 * validated-reload.ts's step 3 (test) necessarily happens AFTER step 2
 * (the untested candidate is already live at the real include path via an
 * atomic rename). A process crash between step 2 and step 5's restore-on-
 * FAIL can therefore leave an UNTESTED candidate at the real path across a
 * service restart, with a `<includePath>.bak` marker (the pre-swap good
 * content) still sitting on disk as evidence.
 *
 * This module MUST run at service startup BEFORE the normal ensure-include
 * flow (locations-append.ts + validated-reload.ts for the fresh candidate):
 * if a `.bak` marker is found, restore it over the real path first (so we
 * never trust an untested candidate), then remove the marker. Only after
 * that does the normal startup sequence proceed.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { atomicWrite } from '../platform/atomic-write.js';

export interface RecoverFromCrashOptions {
  /** Real, on-disk path of the plugin-owned include file. */
  readonly includePath: string;
}

function backupPathFor(includePath: string): string {
  return `${includePath}.bak`;
}

/**
 * Checks for a leftover crash-recovery marker and restores it if present.
 * Returns `true` if a recovery was performed, `false` on a clean startup
 * (no marker found -- the common case).
 */
export function recoverFromCrashIfNeeded(options: RecoverFromCrashOptions): boolean {
  const { includePath } = options;
  const backupPath = backupPathFor(includePath);

  if (!existsSync(backupPath)) {
    return false;
  }

  const knownGoodContent = readFileSync(backupPath, 'utf8');
  atomicWrite(includePath, knownGoodContent);
  rmSync(backupPath);

  return true;
}
