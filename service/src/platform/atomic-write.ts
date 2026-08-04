/**
 * Atomically writes `content` to `targetPath`: write to a temp file in the
 * SAME DIRECTORY (required for rename(2) to be atomic -- cross-filesystem
 * renames are not), then rename(2) over targetPath. targetPath is never
 * observable in a partially-written state.
 *
 * Lifted verbatim from nginx/validated-reload.ts (the same private helper
 * was duplicated in nginx/crash-recovery.ts) so a third caller
 * (features/disk_thresholds) can reuse it without a third copy. Both nginx
 * call sites import this shared version; their existing test suites are
 * the regression proof that the move is behaviour-preserving.
 */
import { renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function atomicWrite(targetPath: string, content: string): void {
  const tempPath = join(dirname(targetPath), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tempPath, content);
  renameSync(tempPath, targetPath);
}
