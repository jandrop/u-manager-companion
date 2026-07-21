/**
 * Thin, injectable wrappers over `execa`. Feature modules depend on
 * `StreamedProcessRunner` / `DetachedProcessRunner` FUNCTION TYPES, never on
 * `execa` directly, so tests never actually shell out. Two shapes, matching
 * the two process patterns the ported Python patches use:
 *
 *   - streamed: `rebuild_container`, `plugin remove` -- merged
 *     stdout/stderr captured line-by-line via a callback, resolves with the
 *     exit code once the child exits. Mirrors
 *     docker_template_create.py's `rebuildContainer()` all-stream handling.
 *   - detached: `/sbin/poweroff`, `/sbin/reboot`, `rc.s3sleep` -- fire and
 *     forget, `detached: true` + `unref()` so the parent process exiting
 *     (shutdown/reboot) never blocks on the child. Mirrors power.py's
 *     `fireAndForget()`.
 */
import { execa } from 'execa';

export interface StreamedProcessResult {
  readonly exitCode: number;
}

/**
 * Runs `command args...`, invoking `onLine` for each complete line of
 * merged stdout+stderr as it arrives (never the cumulative buffer -- one
 * call per line, matching the ring-buffer append-per-line semantics the
 * operation engine expects), and resolves once the child exits.
 */
export type StreamedProcessRunner = (
  command: string,
  args: readonly string[],
  onLine: (line: string) => void,
) => Promise<StreamedProcessResult>;

/**
 * Production StreamedProcessRunner: shells to `command` via execa with
 * merged stdout/stderr (`all: true`), buffering partial lines across chunk
 * boundaries the same way the ported Python patches' `onChunk` closures do.
 * `reject: false` so a non-zero exit surfaces as a normal
 * StreamedProcessResult instead of a thrown ExecaError -- callers branch on
 * `exitCode`, matching the reference implementation's
 * `if (result.exitCode !== 0) throw ...` pattern at the call site instead
 * of here.
 */
export const runStreamedProcess: StreamedProcessRunner = async (command, args, onLine) => {
  const child = execa(command, args, { all: true, reject: false, shell: true });

  let buffer = '';
  const onChunk = (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.replace(/\s+$/, '');
      if (trimmed.length > 0) onLine(trimmed);
    }
  };

  if (child.all) {
    child.all.on('data', onChunk);
  } else {
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
  }

  const result = await child;
  if (buffer.trim().length > 0) onLine(buffer.trim());

  return { exitCode: result.exitCode ?? 1 };
};

/**
 * Fire-and-forget process launch: `detached: true` + `unref()` so the
 * spawned child survives (and is not blocked on by) the parent process
 * potentially exiting -- required for power actions, where `/sbin/reboot`
 * or `/sbin/poweroff` may terminate THIS process before the child even
 * finishes running. Never awaited by design; the caller has already
 * recorded the audit entry before invoking this -- the audit entry must be
 * recorded BEFORE the detached call fires.
 */
export type DetachedProcessRunner = (command: string, args: readonly string[]) => void;

export const runDetachedProcess: DetachedProcessRunner = (command, args) => {
  const subprocess = execa(command, args, { detached: true, stdio: 'ignore', reject: false });
  subprocess.unref();
};
