/**
 * Size-budget gate tests.
 *
 * Exercises scripts/check-size-budget.mjs as a real child process against
 * synthetic files, rather than reimplementing its threshold logic here --
 * the whole point of this gate is that it fails LOUDLY on a real artifact,
 * so the test should drive the actual script, not a copy of its logic.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, ftruncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';

// This file compiles to CommonJS (package.json "type": "commonjs"), so the
// native __dirname is used directly rather than an import.meta.url shim.
const serviceRoot = path.resolve(__dirname, '..', '..');
const checkScript = path.join(serviceRoot, 'scripts', 'check-size-budget.mjs');

let workDir: string | undefined;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

/** Creates a sparse file of the given size -- fast even at 150MB+, since the
 * size-budget script only stats the file, never reads its content. */
function makeFileOfSize(bytes: number): string {
  workDir = mkdtempSync(path.join(tmpdir(), 'companion-size-budget-'));
  const file = path.join(workDir, 'fake-binary');
  const fd = openSync(file, 'w');
  ftruncateSync(fd, bytes);
  closeSync(fd);
  return file;
}

describe('check-size-budget.mjs', () => {
  it('passes (exit 0) for a file under the 150MB budget', () => {
    const file = makeFileOfSize(10 * 1024 * 1024); // 10 MB
    const output = execFileSync('node', [checkScript, file], { encoding: 'utf-8' });
    expect(output).toContain('OK');
  });

  it('fails (non-zero exit) for a file over the 150MB budget', () => {
    const file = makeFileOfSize(151 * 1024 * 1024); // 151 MB -- one MB over
    expect(() => execFileSync('node', [checkScript, file], { stdio: 'pipe' })).toThrowError();
  });

  it('fails loudly when the target artifact does not exist', () => {
    const missing = path.join(tmpdir(), 'companion-size-budget-does-not-exist');
    expect(() => execFileSync('node', [checkScript, missing], { stdio: 'pipe' })).toThrowError();
  });
});
