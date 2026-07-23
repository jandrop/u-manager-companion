/**
 * features/shares/platform.ts tests.
 *
 * TDD: written before platform.ts exists -> RED first.
 *
 * Covers the emhttpd helpers: form-encoded POST to
 * `/var/run/emhttpd.socket` with a CSRF token read from
 * `/var/local/emhttp/var.ini`, the failure-response check, and a
 * recursive directory-empty scan under `/mnt/user/<name>` (skips
 * `.DS_Store`, stops at the first real file). Everything here is
 * injectable (socket/fs), so this suite never touches a real filesystem
 * or socket.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildShareCommands,
  isEmhttpdFailureResponse,
  parseCsrfToken,
  parseSharesIni,
  scanShareDirEmpty,
} from '../platform.js';

describe('parseCsrfToken', () => {
  it('extracts the csrf_token value from var.ini content', () => {
    const content = 'timezone="Europe/Madrid"\ncsrf_token="abc123"\nversion="6.12"\n';
    expect(parseCsrfToken(content)).toBe('abc123');
  });

  it('extracts an unquoted csrf_token value', () => {
    expect(parseCsrfToken('csrf_token=abc123\n')).toBe('abc123');
  });

  it('returns empty string when csrf_token is absent', () => {
    expect(parseCsrfToken('timezone="Europe/Madrid"\n')).toBe('');
  });
});

describe('isEmhttpdFailureResponse', () => {
  it('treats a script-tag success body as NOT a failure', () => {
    expect(isEmhttpdFailureResponse('<script>replaceName("media");</script>')).toBe(false);
  });

  it('treats a bare 500 error body as a failure', () => {
    expect(isEmhttpdFailureResponse('500 Internal Server Error')).toBe(true);
  });

  it('treats Bad Request / Unauthorized / Forbidden bodies as failures', () => {
    expect(isEmhttpdFailureResponse('Bad Request')).toBe(true);
    expect(isEmhttpdFailureResponse('Unauthorized')).toBe(true);
    expect(isEmhttpdFailureResponse('Forbidden')).toBe(true);
  });

  it('treats an empty body as NOT a failure', () => {
    expect(isEmhttpdFailureResponse('')).toBe(false);
  });
});

describe('buildShareCommands', () => {
  it('maps every settings key to its emhttpd command name with String() coercion', () => {
    const result = buildShareCommands({
      comment: 'hi',
      cachePool: 'cache',
      cachePool2: 'cache2',
      useCache: 'yes',
      cow: 'auto',
      floor: '100',
      allocator: 'highwater',
      splitLevel: '1',
      include: ['disk1', 'disk2'],
      exclude: ['disk3'],
    });

    expect(result).toEqual({
      shareComment: 'hi',
      shareCachePool: 'cache',
      shareCachePool2: 'cache2',
      shareUseCache: 'yes',
      shareCOW: 'auto',
      shareFloor: '100',
      shareAllocator: 'highwater',
      shareSplitLevel: '1',
      shareInclude: 'disk1,disk2',
      shareExclude: 'disk3',
    });
  });

  it('applies defaults for every omitted key', () => {
    const result = buildShareCommands({});

    expect(result).toEqual({
      shareComment: '',
      shareCachePool: '',
      shareCachePool2: '',
      shareUseCache: '',
      shareCOW: 'auto',
      shareFloor: '',
      shareAllocator: 'highwater',
      shareSplitLevel: '',
      shareInclude: '',
      shareExclude: '',
    });
  });

  it('passes through a plain string include/exclude unchanged (current-value merge case)', () => {
    // updateShare's current-value merge passes ShareRecord.include/exclude
    // straight through as a scalar string (see ShareRecord) -- this must
    // NOT be silently cleared to ''.
    const result = buildShareCommands({ include: 'disk1,disk2', exclude: 'disk3' });
    expect(result.shareInclude).toBe('disk1,disk2');
    expect(result.shareExclude).toBe('disk3');
  });

  it('defaults to an empty string for a value that is neither an array nor a string', () => {
    const result = buildShareCommands({ include: 42 as unknown as string });
    expect(result.shareInclude).toBe('');
  });
});

describe('scanShareDirEmpty', () => {
  it('returns true for a directory containing no entries', async () => {
    const readdir = vi.fn().mockResolvedValue([]);
    const stat = vi.fn();

    const result = await scanShareDirEmpty('/mnt/user/media', { readdir, stat });

    expect(result).toBe(true);
  });

  it('returns false as soon as a real (non-.DS_Store) file is found', async () => {
    const readdir = vi.fn().mockResolvedValue([
      { name: '.DS_Store', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      { name: 'movie.mkv', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
    ]);
    const stat = vi.fn();

    const result = await scanShareDirEmpty('/mnt/user/media', { readdir, stat });

    expect(result).toBe(false);
  });

  it('recurses into subdirectories and reports non-empty when a nested file exists', async () => {
    const readdir = vi
      .fn()
      .mockResolvedValueOnce([
        { name: 'subdir', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
      ])
      .mockResolvedValueOnce([
        { name: 'file.txt', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      ]);
    const stat = vi.fn();

    const result = await scanShareDirEmpty('/mnt/user/media', { readdir, stat });

    expect(result).toBe(false);
  });

  it('returns true when the directory cannot be read (IO error)', async () => {
    const readdir = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const stat = vi.fn();

    const result = await scanShareDirEmpty('/mnt/user/ghost', { readdir, stat });

    expect(result).toBe(true);
  });
});

describe('parseSharesIni', () => {
  // Source: /usr/local/emhttp/state/shares.ini. The exact key set
  // unraid-api's own parser reads hasn't been confirmed against a real
  // file yet -- worth double-checking on a live box.
  it('parses a single [ShareName] section into a ShareRecord', () => {
    const ini = [
      '["media"]',
      'free="1000"',
      'used="500"',
      'size="1500"',
      'nameOrig="media"',
      'comment="Media library"',
      'allocator="highwater"',
      'splitLevel=""',
      'floor="0"',
      'useCache="yes"',
      'cachePool="cache"',
      'cachePool2=""',
      'cow="auto"',
      'color=""',
      'luksStatus=""',
      'include=""',
      'exclude=""',
      '',
    ].join('\n');

    const result = parseSharesIni(ini);

    expect(result).toEqual([
      {
        id: 'media',
        name: 'media',
        free: 1000,
        used: 500,
        size: 1500,
        include: '',
        exclude: '',
        cache: true,
        useCache: 'yes',
        cachePool: 'cache',
        cachePool2: '',
        nameOrig: 'media',
        comment: 'Media library',
        allocator: 'highwater',
        splitLevel: '',
        floor: '0',
        cow: 'auto',
        color: '',
        luksStatus: null,
      },
    ]);
  });

  it('parses multiple share sections', () => {
    const ini = ['["media"]', 'useCache="yes"', '', '["appdata"]', 'useCache="no"', ''].join('\n');

    const result = parseSharesIni(ini);

    expect(result.map((share) => share.name)).toEqual(['media', 'appdata']);
    expect(result[1]?.cache).toBe(false);
  });

  it('returns an empty array for empty/unparseable content', () => {
    expect(parseSharesIni('')).toEqual([]);
  });

  it('derives cache=null when useCache is empty/absent', () => {
    const ini = ['["media"]', 'useCache=""', ''].join('\n');
    const result = parseSharesIni(ini);
    expect(result[0]?.cache).toBeNull();
  });
});
