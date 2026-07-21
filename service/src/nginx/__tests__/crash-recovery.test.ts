/**
 * Startup crash-recovery tests -- if a `.bak` marker is
 * present alongside the real include path, restore it FIRST (before the
 * normal ensure-include flow runs), then remove the leftover marker.
 *
 * TDD: written before crash-recovery.ts exists -> RED first.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recoverFromCrashIfNeeded } from '../crash-recovery.js';

describe('recoverFromCrashIfNeeded', () => {
  let dir: string;
  let includePath: string;
  let backupPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'companion-crash-recovery-'));
    includePath = join(dir, 'companion.conf');
    backupPath = `${includePath}.bak`;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('restores the backup over the real path when a .bak marker is present', () => {
    writeFileSync(includePath, 'location /companion/graphql { UNTESTED CANDIDATE');
    writeFileSync(backupPath, 'location /companion/graphql { proxy_pass known-good; }\n');

    const recovered = recoverFromCrashIfNeeded({ includePath });

    expect(recovered).toBe(true);
    expect(readFileSync(includePath, 'utf8')).toBe(
      'location /companion/graphql { proxy_pass known-good; }\n',
    );
  });

  it('removes the leftover backup marker after restoring', () => {
    writeFileSync(includePath, 'UNTESTED');
    writeFileSync(backupPath, 'GOOD');

    recoverFromCrashIfNeeded({ includePath });

    expect(existsSync(backupPath)).toBe(false);
  });

  it('is a no-op when no .bak marker is present (clean startup)', () => {
    writeFileSync(includePath, 'location /companion/graphql { proxy_pass stable; }\n');

    const recovered = recoverFromCrashIfNeeded({ includePath });

    expect(recovered).toBe(false);
    expect(readFileSync(includePath, 'utf8')).toBe(
      'location /companion/graphql { proxy_pass stable; }\n',
    );
  });

  it('handles a .bak marker with no real include present (crash before first-ever write completed)', () => {
    writeFileSync(backupPath, 'PRIOR CONTENT');
    // includePath deliberately absent.

    const recovered = recoverFromCrashIfNeeded({ includePath });

    expect(recovered).toBe(true);
    expect(readFileSync(includePath, 'utf8')).toBe('PRIOR CONTENT');
    expect(existsSync(backupPath)).toBe(false);
  });
});
