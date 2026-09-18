import { describe, expect, it } from 'vitest';
import { createDiskConfigClient, parseDiskUtilizationThresholds, readTextOrEmpty } from '../platform.js';

describe('parseDiskUtilizationThresholds', () => {
  it('parses both keys for the target slot', () => {
    const text = 'diskWarning.3="75"\ndiskCritical.3="95"\n';
    expect(parseDiskUtilizationThresholds(text, 3)).toEqual({ diskIdx: 3, warning: 75, critical: 95 });
  });

  it('reads an absent key as null -- the disk inherits the global percentage', () => {
    expect(parseDiskUtilizationThresholds('', 3)).toEqual({ diskIdx: 3, warning: null, critical: null });
    expect(parseDiskUtilizationThresholds('diskWarning.3="80"\n', 3).critical).toBeNull();
  });

  it('reads an empty value as null, same as an absent key', () => {
    const text = 'diskWarning.3=""\ndiskCritical.3="90"\n';
    expect(parseDiskUtilizationThresholds(text, 3)).toEqual({ diskIdx: 3, warning: null, critical: 90 });
  });

  it('keeps a stored 0 as 0 -- it disables the band, it is not "unset"', () => {
    const text = 'diskWarning.3="0"\n';
    expect(parseDiskUtilizationThresholds(text, 3).warning).toBe(0);
  });

  it('reads non-integer junk as null rather than throwing', () => {
    const text = 'diskWarning.3="not-a-number"\n';
    expect(parseDiskUtilizationThresholds(text, 3).warning).toBeNull();
  });

  it('does not confuse diskWarning.3 with diskWarning.33 -- exact key match only', () => {
    const text = 'diskWarning.33="99"\ndiskWarning.3="80"\ndiskCritical.33="70"\n';

    expect(parseDiskUtilizationThresholds(text, 3)).toEqual({ diskIdx: 3, warning: 80, critical: null });
    expect(parseDiskUtilizationThresholds(text, 33)).toEqual({ diskIdx: 33, warning: 99, critical: 70 });
  });

  it('parses correctly across CRLF line endings', () => {
    const text = 'diskWarning.3="80"\r\ndiskCritical.3="90"\r\n';
    expect(parseDiskUtilizationThresholds(text, 3)).toEqual({ diskIdx: 3, warning: 80, critical: 90 });
  });

  it('echoes the requested diskIdx back even when the slot holds no keys at all', () => {
    expect(parseDiskUtilizationThresholds('diskWarning.7="10"\n', 9)).toEqual({
      diskIdx: 9,
      warning: null,
      critical: null,
    });
  });
});

// fs/promises rejects with an Error carrying .code -- same shape here.
function errnoError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('readTextOrEmpty', () => {
  it('passes the read text through unchanged', async () => {
    await expect(readTextOrEmpty(async () => 'diskWarning.3="80"\n')).resolves.toBe('diskWarning.3="80"\n');
  });

  it('degrades to empty on ENOENT -- a missing disk.cfg means every disk inherits the global percentage', async () => {
    await expect(readTextOrEmpty(() => Promise.reject(errnoError('ENOENT')))).resolves.toBe('');
  });

  it.each(['EACCES', 'EIO', 'EPERM', 'EISDIR'])(
    'propagates %s instead of masking it as "nothing configured"',
    async (code) => {
      await expect(readTextOrEmpty(() => Promise.reject(errnoError(code)))).rejects.toThrow(code);
    },
  );
});

describe('createDiskConfigClient', () => {
  const MISSING = '/nonexistent-u-manager-companion-dir/disk.cfg';

  it('builds a client exposing readText', () => {
    const client = createDiskConfigClient(MISSING);
    expect(typeof client.readText).toBe('function');
  });

  it('reads a missing file as empty text rather than rejecting', async () => {
    await expect(createDiskConfigClient(MISSING).readText()).resolves.toBe('');
  });
});
