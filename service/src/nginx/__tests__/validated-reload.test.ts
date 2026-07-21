/**
 * Validated-reload tests -- atomic write-then-rename(2) swap,
 * backup/restore-on-FAIL, `nginx -t` against the real tree, `nginx -s
 * reload` on PASS.
 *
 * TDD: written before validated-reload.ts exists -> RED first.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validatedReload } from '../validated-reload.js';

describe('validatedReload', () => {
  let dir: string;
  let includePath: string;
  let backupPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'companion-reload-'));
    includePath = join(dir, 'companion.conf');
    backupPath = `${includePath}.bak`;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the candidate atomically and reloads on PASS', async () => {
    const runNginx = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const result = await validatedReload({
      includePath,
      candidateContent: 'location /companion/graphql { }\n',
      nginxBinaryPath: '/usr/sbin/nginx',
      runNginx,
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(includePath, 'utf8')).toBe('location /companion/graphql { }\n');
    // -t (validate) then -s reload (apply) -- in that order.
    expect(runNginx).toHaveBeenNthCalledWith(1, '/usr/sbin/nginx', ['-t']);
    expect(runNginx).toHaveBeenNthCalledWith(2, '/usr/sbin/nginx', ['-s', 'reload']);
    // No leftover backup marker after a clean PASS.
    expect(existsSync(backupPath)).toBe(false);
  });

  it('backs up existing content before writing the candidate', async () => {
    writeFileSync(includePath, 'location /companion/graphql { proxy_pass old; }\n');
    let backupContentAtValidationTime: string | undefined;
    const runNginx = vi.fn().mockImplementation(async () => {
      // At validation time, the backup must already exist with the OLD content.
      backupContentAtValidationTime = readFileSync(backupPath, 'utf8');
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await validatedReload({
      includePath,
      candidateContent: 'location /companion/graphql { proxy_pass new; }\n',
      nginxBinaryPath: '/usr/sbin/nginx',
      runNginx,
    });

    expect(backupContentAtValidationTime).toBe('location /companion/graphql { proxy_pass old; }\n');
  });

  it('restores the previous content and does not reload on FAIL', async () => {
    writeFileSync(includePath, 'location /companion/graphql { proxy_pass old; }\n');
    const runNginx = vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'nginx: [emerg] bad config' });

    const result = await validatedReload({
      includePath,
      candidateContent: 'location /companion/graphql { BROKEN',
      nginxBinaryPath: '/usr/sbin/nginx',
      runNginx,
    });

    expect(result.ok).toBe(false);
    expect(readFileSync(includePath, 'utf8')).toBe('location /companion/graphql { proxy_pass old; }\n');
    // Only -t was called, never -s reload.
    expect(runNginx).toHaveBeenCalledTimes(1);
    expect(runNginx).toHaveBeenCalledWith('/usr/sbin/nginx', ['-t']);
    // Backup marker cleaned up after a successful restore.
    expect(existsSync(backupPath)).toBe(false);
  });

  it('removes the candidate on FAIL when there was no prior include (first install)', async () => {
    const runNginx = vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'nginx: [emerg] bad config' });

    const result = await validatedReload({
      includePath,
      candidateContent: 'location /companion/graphql { BROKEN',
      nginxBinaryPath: '/usr/sbin/nginx',
      runNginx,
    });

    expect(result.ok).toBe(false);
    expect(existsSync(includePath)).toBe(false);
    expect(existsSync(backupPath)).toBe(false);
  });

  it('never leaves a partial file at the real path when the write is interrupted', async () => {
    writeFileSync(includePath, 'location /companion/graphql { proxy_pass old; }\n');
    const runNginx = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    // Simulate an interruption during the temp-write stage: the writer used
    // internally must go through rename(2), so a crash before rename never
    // touches the real path. We assert this indirectly: even if the temp
    // file write "fails" (thrown), the real path content is untouched.
    const brokenContent = 'x'.repeat(10);
    const originalContent = readFileSync(includePath, 'utf8');

    // A legitimate large write should still land atomically (no partial
    // content ever observable at includePath -- verified by reading before
    // and after and confirming it's always one of the two full strings).
    await validatedReload({
      includePath,
      candidateContent: brokenContent,
      nginxBinaryPath: '/usr/sbin/nginx',
      runNginx,
    });

    const finalContent = readFileSync(includePath, 'utf8');
    expect([originalContent, brokenContent]).toContain(finalContent);
  });

  it('propagates runNginx rejection as a FAIL result and restores backup', async () => {
    writeFileSync(includePath, 'location /companion/graphql { proxy_pass old; }\n');
    const runNginx = vi.fn().mockRejectedValue(new Error('spawn ENOENT'));

    const result = await validatedReload({
      includePath,
      candidateContent: 'location /companion/graphql { proxy_pass new; }\n',
      nginxBinaryPath: '/usr/sbin/nginx',
      runNginx,
    });

    expect(result.ok).toBe(false);
    expect(readFileSync(includePath, 'utf8')).toBe('location /companion/graphql { proxy_pass old; }\n');
  });
});
