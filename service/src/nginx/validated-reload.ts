/**
 * Validated nginx reload: atomic write-then-rename(2) swap at the REAL
 * include path, backup/restore-on-FAIL, `nginx -t` against the real tree,
 * `nginx -s reload` on PASS.
 *
 * Why atomic-write-then-test instead of test-a-temp-copy-then-move: `nginx
 * -t` only ever validates the REAL on-disk config tree -- it cannot be
 * pointed at a synthetic "effective config" assembled from a temp file plus
 * the real tree. So the exact file that gets tested must already BE the
 * real file. This sequence, steps 1-5:
 *
 *   1. Back up. If a file exists at includePath, copy it to `<includePath>.bak`.
 *   2. Write atomically. Temp file in the SAME DIRECTORY as includePath,
 *      then rename(2) over includePath. Same-filesystem rename is atomic --
 *      includePath is never observed as a partial write.
 *   3. Test. `nginx -t` against the real tree (includePath is now the
 *      candidate, byte-for-byte, because of step 2's atomic rename).
 *   4. On PASS: `nginx -s reload`.
 *   5. On FAIL: restore the backup over includePath (same atomic swap), or
 *      remove the candidate if there was no prior include. Do NOT reload.
 *
 * The backup file left at `<includePath>.bak` during steps 1-5 is also the
 * crash-recovery marker consumed by crash-recovery.ts: if the process dies
 * between step 2 and step 5's restore, a `.bak` file survives on disk and
 * the next startup finishes the recovery before trusting includePath again.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execa } from 'execa';

export interface NginxRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Injectable process runner -- production wiring shells to the real
 * `nginx` binary (via execa), tests inject a mock so no real nginx process
 * is required to exercise this logic.
 */
export type RunNginx = (
  nginxBinaryPath: string,
  args: readonly string[],
) => Promise<NginxRunResult>;

/**
 * Production RunNginx implementation: shells to the real nginx binary via
 * execa. Verified on the box: /usr/sbin/nginx is directly usable for
 * `-t`/`-s reload`. `nginx -t`/`-s reload` return a non-zero exit code on
 * failure rather than throwing for "expected" failures (bad config); execa
 * is called with `reject: false` so a non-zero exit surfaces as a normal
 * NginxRunResult instead of a thrown ExecaError, matching validatedReload's
 * exitCode-based branching.
 */
export const runNginxViaExeca: RunNginx = async (nginxBinaryPath, args) => {
  const result = await execa(nginxBinaryPath, args, { reject: false });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

export interface ValidatedReloadOptions {
  /** Real, on-disk path of the plugin-owned include file. */
  readonly includePath: string;
  /** Full desired content for includePath. */
  readonly candidateContent: string;
  /** Path to the nginx binary (/usr/sbin/nginx). */
  readonly nginxBinaryPath: string;
  /** Injectable nginx process runner (real impl in production, mock in tests). */
  readonly runNginx: RunNginx;
}

export interface ValidatedReloadResult {
  readonly ok: boolean;
  /** `nginx -t` stderr/stdout on FAIL, for logging. Absent on PASS. */
  readonly validationOutput?: string;
}

function backupPathFor(includePath: string): string {
  return `${includePath}.bak`;
}

/**
 * Atomically writes `content` to `targetPath`: write to a temp file in the
 * SAME DIRECTORY (required for rename(2) to be atomic -- cross-filesystem
 * renames are not), then rename(2) over targetPath. targetPath is never
 * observable in a partially-written state.
 */
function atomicWrite(targetPath: string, content: string): void {
  const tempPath = join(dirname(targetPath), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tempPath, content);
  renameSync(tempPath, targetPath);
}

/**
 * Runs the full validated-reload sequence (steps 1-5) against
 * the real include path. See module doc for the step-by-step rationale.
 */
export async function validatedReload(
  options: ValidatedReloadOptions,
): Promise<ValidatedReloadResult> {
  const { includePath, candidateContent, nginxBinaryPath, runNginx } = options;
  const backupPath = backupPathFor(includePath);

  // Step 1: back up. Absence is itself the "previous state" to restore to.
  const hadPriorInclude = existsSync(includePath);
  if (hadPriorInclude) {
    const previousContent = readFileSync(includePath, 'utf8');
    atomicWrite(backupPath, previousContent);
  }

  // Step 2: write the candidate atomically. From here on, includePath IS
  // the candidate -- untested, but never partially written.
  atomicWrite(includePath, candidateContent);

  // Step 3: test the real tree.
  let testResult: NginxRunResult;
  try {
    testResult = await runNginx(nginxBinaryPath, ['-t']);
  } catch (error) {
    // Treat a failure to even invoke nginx (e.g. spawn ENOENT) the same as
    // a validation FAIL -- restore and do not reload.
    restoreOnFail(includePath, backupPath, hadPriorInclude);
    return {
      ok: false,
      validationOutput: error instanceof Error ? error.message : String(error),
    };
  }

  if (testResult.exitCode !== 0) {
    // Step 5 (FAIL branch): restore, no reload.
    restoreOnFail(includePath, backupPath, hadPriorInclude);
    return { ok: false, validationOutput: `${testResult.stdout}${testResult.stderr}` };
  }

  // Step 4 (PASS branch): apply, then clean up the backup marker -- a clean
  // PASS leaves no crash-recovery marker behind.
  await runNginx(nginxBinaryPath, ['-s', 'reload']);
  if (existsSync(backupPath)) {
    rmSync(backupPath);
  }

  return { ok: true };
}

/**
 * Step 5: restore the backup over the real path (atomic swap), or remove
 * the untested candidate if there was no prior include. Always cleans up
 * the backup marker afterward -- a completed restore is not a crash state.
 */
function restoreOnFail(includePath: string, backupPath: string, hadPriorInclude: boolean): void {
  if (hadPriorInclude) {
    const previousContent = readFileSync(backupPath, 'utf8');
    atomicWrite(includePath, previousContent);
  } else {
    rmSync(includePath, { force: true });
  }
  if (existsSync(backupPath)) {
    rmSync(backupPath);
  }
}
