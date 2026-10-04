import { describe, expect, it } from 'vitest';

import { runStreamedProcess } from '../process-runner.js';

describe('runStreamedProcess', () => {
  it('passes each argument to the command verbatim', async () => {
    const lines: string[] = [];

    const result = await runStreamedProcess('/bin/echo', ['x;echo injected;.plg'], (line) =>
      lines.push(line),
    );

    expect(result.exitCode).toBe(0);
    expect(lines).toEqual(['x;echo injected;.plg']);
  });

  it('streams every output line and reports the exit code', async () => {
    const lines: string[] = [];

    const result = await runStreamedProcess('/bin/sh', ['-c', 'echo one; echo two; exit 3'], (line) =>
      lines.push(line),
    );

    expect(result.exitCode).toBe(3);
    expect(lines).toEqual(['one', 'two']);
  });
});
