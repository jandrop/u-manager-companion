/**
 * features/shares tests.
 *
 * TDD: written before resolvers.ts exists -> RED first.
 *
 * Covers share mutations, share security, and share-is-empty. Talks to
 * emhttpd's unix socket (`/var/run/emhttpd.socket`) with form-encoded
 * commands and a CSRF token read from `/var/local/emhttp/var.ini`
 * through an injectable `EmhttpdClient`, so nothing here ever touches a
 * real socket/filesystem.
 *
 * Covered: list, security, security-users, is-empty, create, update
 * (partial-settings merge keeps omitted keys), delete (rejects non-empty
 * share dir), update-access ({userId, access} objects).
 */
import { describe, expect, it, vi } from 'vitest';
import type { EmhttpdClient, ShareRecord } from '../platform.js';
import {
  createShare,
  deleteShare,
  getShareIsEmpty,
  getShareSecurity,
  getShareSecurityUsers,
  listShares,
  updateShare,
  updateShareAccess,
  updateShareSecurity,
} from '../resolvers.js';
import type { AuditLogger } from '../../../audit.js';

function makeFakeAudit(): { audit: AuditLogger; calls: string[] } {
  const calls: string[] = [];
  return {
    audit: {
      recordAuditEvent: vi.fn((event) => {
        calls.push(`audit:${event.action}`);
      }),
    },
    calls,
  };
}

function makeShare(overrides: Partial<ShareRecord> = {}): ShareRecord {
  return {
    id: 'media',
    name: 'media',
    free: 100,
    used: 50,
    size: 150,
    include: '',
    exclude: '',
    cache: null,
    useCache: 'yes',
    cachePool: 'cache',
    cachePool2: '',
    nameOrig: 'media',
    comment: '',
    allocator: 'highwater',
    splitLevel: '',
    floor: '',
    cow: 'auto',
    color: null,
    luksStatus: null,
    ...overrides,
  };
}

function makeEmhttpdClient(overrides: Partial<EmhttpdClient> = {}): EmhttpdClient {
  return {
    getShares: vi.fn().mockResolvedValue([makeShare()]),
    sendCommand: vi.fn().mockResolvedValue('<script>replaceName("media");</script>'),
    readShareSecurity: vi.fn().mockResolvedValue({
      export: '-',
      security: 'public',
      caseSensitive: 'auto',
      readList: [],
      writeList: [],
      volsizelimit: '',
    }),
    readShareSecurityUsers: vi.fn().mockResolvedValue([
      { id: '0', name: 'root', description: '', isRoot: true },
    ]),
    isShareDirEmpty: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('listShares', () => {
  it('returns the raw share list from the emhttpd client', async () => {
    const client = makeEmhttpdClient({ getShares: vi.fn().mockResolvedValue([makeShare({ name: 'appdata' })]) });

    const result = await listShares({ client });

    expect(result).toEqual([makeShare({ name: 'appdata' })]);
  });
});

describe('getShareSecurity', () => {
  it('returns the SMB security blob for a share', async () => {
    const client = makeEmhttpdClient();

    const result = await getShareSecurity('media', { client });

    expect(result).toEqual({
      export: '-',
      security: 'public',
      caseSensitive: 'auto',
      readList: [],
      writeList: [],
      volsizelimit: '',
    });
    expect(client.readShareSecurity).toHaveBeenCalledWith('media');
  });
});

describe('getShareSecurityUsers', () => {
  it('returns the list of Unraid users for the access matrix', async () => {
    const client = makeEmhttpdClient();

    const result = await getShareSecurityUsers({ client });

    expect(result).toEqual([{ id: '0', name: 'root', description: '', isRoot: true }]);
  });
});

describe('getShareIsEmpty', () => {
  it('delegates to the injected directory-empty check', async () => {
    const client = makeEmhttpdClient({ isShareDirEmpty: vi.fn().mockResolvedValue(false) });

    const result = await getShareIsEmpty('media', { client });

    expect(result).toBe(false);
    expect(client.isShareDirEmpty).toHaveBeenCalledWith('media');
  });

  it('returns true (never blocks Delete) for an empty/missing name', async () => {
    const client = makeEmhttpdClient();

    expect(await getShareIsEmpty('', { client })).toBe(true);
    expect(client.isShareDirEmpty).not.toHaveBeenCalled();
  });
});

describe('createShare', () => {
  it('rejects when a share with the same name already exists', async () => {
    const client = makeEmhttpdClient({ getShares: vi.fn().mockResolvedValue([makeShare({ name: 'media' })]) });
    const { audit } = makeFakeAudit();

    await expect(
      createShare('media', {}, { client, audit, caller: { id: 'u1', name: 'admin' } }),
    ).rejects.toThrow(/already exists/);
  });

  it('rejects an invalid share name without calling the emhttpd client', async () => {
    const client = makeEmhttpdClient();
    const { audit } = makeFakeAudit();

    await expect(
      createShare('bad name!', {}, { client, audit, caller: { id: 'u1', name: 'admin' } }),
    ).rejects.toThrow(/Invalid share name/);
    expect(client.sendCommand).not.toHaveBeenCalled();
  });

  it('sends cmdEditShare=Add Share with the mapped settings and records an audit entry', async () => {
    const client = makeEmhttpdClient({
      getShares: vi
        .fn()
        .mockResolvedValueOnce([]) // existence check
        .mockResolvedValue([makeShare({ name: 'newshare' })]), // poll finds it immediately
    });
    const { audit } = makeFakeAudit();

    await createShare(
      'newshare',
      { comment: 'hello', cachePool: 'cache', useCache: 'yes' },
      { client, audit, caller: { id: 'u1', name: 'admin' } },
    );

    expect(client.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmdEditShare: 'Add Share',
        shareName: 'newshare',
        shareNameOrig: '',
        shareComment: 'hello',
        shareCachePool: 'cache',
        shareUseCache: 'yes',
      }),
    );
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'shares.create', target: 'newshare', outcome: 'initiated' }),
    );
  });

  it('returns the created share once it appears in the polled list', async () => {
    const client = makeEmhttpdClient({
      getShares: vi
        .fn()
        .mockResolvedValueOnce([]) // existence check
        .mockResolvedValue([makeShare({ name: 'newshare' })]),
    });
    const { audit } = makeFakeAudit();

    const result = await createShare(
      'newshare',
      {},
      { client, audit, caller: { id: 'u1', name: 'admin' } },
    );

    expect(result.name).toBe('newshare');
  });

  it('throws when emhttpd returns a failure response', async () => {
    const client = makeEmhttpdClient({
      getShares: vi.fn().mockResolvedValue([]),
      sendCommand: vi.fn().mockResolvedValue('500 Internal Server Error'),
    });
    const { audit } = makeFakeAudit();

    await expect(
      createShare('newshare', {}, { client, audit, caller: { id: 'u1', name: 'admin' } }),
    ).rejects.toThrow(/emhttpd refused createShare/);
  });
});

describe('updateShare', () => {
  it('rejects when no share with that name exists', async () => {
    const client = makeEmhttpdClient({ getShares: vi.fn().mockResolvedValue([]) });
    const { audit } = makeFakeAudit();

    await expect(
      updateShare('ghost', {}, { client, audit, caller: { id: 'u1', name: 'admin' } }),
    ).rejects.toThrow(/No share named/);
  });

  it('merges omitted settings keys with the current share values (partial update)', async () => {
    const current = makeShare({ name: 'media', comment: 'old comment', cachePool: 'cache' });
    const client = makeEmhttpdClient({ getShares: vi.fn().mockResolvedValue([current]) });
    const { audit } = makeFakeAudit();

    // Only `useCache` is provided -- comment/cachePool must keep the
    // CURRENT value, not be reset to defaults.
    await updateShare('media', { useCache: 'no' }, { client, audit, caller: { id: 'u1', name: 'admin' } });

    expect(client.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmdEditShare: 'Apply',
        shareName: 'media',
        shareNameOrig: 'media',
        shareComment: 'old comment',
        shareCachePool: 'cache',
        shareUseCache: 'no',
      }),
    );
  });

  it('records an audit entry for the update', async () => {
    const client = makeEmhttpdClient({ getShares: vi.fn().mockResolvedValue([makeShare()]) });
    const { audit } = makeFakeAudit();

    await updateShare('media', {}, { client, audit, caller: { id: 'u1', name: 'admin' } });

    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'shares.update', target: 'media', outcome: 'initiated' }),
    );
  });

  it('throws when emhttpd returns a failure response', async () => {
    const client = makeEmhttpdClient({
      getShares: vi.fn().mockResolvedValue([makeShare()]),
      sendCommand: vi.fn().mockResolvedValue('Bad Request'),
    });
    const { audit } = makeFakeAudit();

    await expect(
      updateShare('media', {}, { client, audit, caller: { id: 'u1', name: 'admin' } }),
    ).rejects.toThrow(/emhttpd refused updateShare/);
  });
});

describe('deleteShare', () => {
  it('rejects deleting a non-empty share (directory not empty)', async () => {
    const client = makeEmhttpdClient({
      getShares: vi.fn().mockResolvedValue([makeShare()]),
      isShareDirEmpty: vi.fn().mockResolvedValue(false),
    });
    const { audit } = makeFakeAudit();

    await expect(
      deleteShare('media', { client, audit, caller: { id: 'u1', name: 'admin' } }),
    ).rejects.toThrow(/not empty/);
    expect(client.sendCommand).not.toHaveBeenCalled();
  });

  it('rejects when no share with that name exists', async () => {
    const client = makeEmhttpdClient({ getShares: vi.fn().mockResolvedValue([]) });
    const { audit } = makeFakeAudit();

    await expect(
      deleteShare('ghost', { client, audit, caller: { id: 'u1', name: 'admin' } }),
    ).rejects.toThrow(/No share named/);
  });

  it('sends cmdEditShare=Delete and records an audit entry when the dir is empty', async () => {
    const client = makeEmhttpdClient({ getShares: vi.fn().mockResolvedValue([makeShare()]) });
    const { audit } = makeFakeAudit();

    const result = await deleteShare('media', { client, audit, caller: { id: 'u1', name: 'admin' } });

    expect(result).toBe(true);
    expect(client.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ cmdEditShare: 'Delete', confirmDelete: 'on', shareName: 'media' }),
    );
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'shares.delete', target: 'media', outcome: 'initiated' }),
    );
  });

  it('throws when emhttpd returns a failure response', async () => {
    const client = makeEmhttpdClient({
      getShares: vi.fn().mockResolvedValue([makeShare()]),
      sendCommand: vi.fn().mockResolvedValue('500 Internal Server Error'),
    });
    const { audit } = makeFakeAudit();

    await expect(
      deleteShare('media', { client, audit, caller: { id: 'u1', name: 'admin' } }),
    ).rejects.toThrow(/emhttpd refused deleteShare/);
  });
});

describe('updateShareSecurity', () => {
  it('sends changeShareSecurity=Apply with the settings and records an audit entry', async () => {
    const client = makeEmhttpdClient();
    const { audit } = makeFakeAudit();

    const result = await updateShareSecurity(
      'media',
      { export: 'e', security: 'private', caseSensitive: 'yes', volsizelimit: '10' },
      { client, audit, caller: { id: 'u1', name: 'admin' } },
    );

    expect(result).toBe(true);
    expect(client.sendCommand).toHaveBeenCalledWith({
      changeShareSecurity: 'Apply',
      shareName: 'media',
      shareExport: 'e',
      shareSecurity: 'private',
      shareCaseSensitive: 'yes',
      shareVolsizelimit: '10',
    });
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'shares.updateSecurity', target: 'media', outcome: 'initiated' }),
    );
  });

  it('applies defaults for omitted settings fields', async () => {
    const client = makeEmhttpdClient();
    const { audit } = makeFakeAudit();

    await updateShareSecurity('media', {}, { client, audit, caller: { id: 'u1', name: 'admin' } });

    expect(client.sendCommand).toHaveBeenCalledWith({
      changeShareSecurity: 'Apply',
      shareName: 'media',
      shareExport: '-',
      shareSecurity: 'public',
      shareCaseSensitive: 'auto',
      shareVolsizelimit: '',
    });
  });

  it('throws when emhttpd returns a failure response', async () => {
    const client = makeEmhttpdClient({ sendCommand: vi.fn().mockResolvedValue('Forbidden') });
    const { audit } = makeFakeAudit();

    await expect(
      updateShareSecurity('media', {}, { client, audit, caller: { id: 'u1', name: 'admin' } }),
    ).rejects.toThrow(/emhttpd refused updateShareSecurity/);
  });
});

describe('updateShareAccess', () => {
  it('sends userAccess.<id>=<access> entries for each {userId, access} object', async () => {
    const client = makeEmhttpdClient();
    const { audit } = makeFakeAudit();

    const result = await updateShareAccess(
      'media',
      [
        { userId: '0', access: 'read-write' },
        { userId: '1', access: 'read-only' },
      ],
      { client, audit, caller: { id: 'u1', name: 'admin' } },
    );

    expect(result).toBe(true);
    expect(client.sendCommand).toHaveBeenCalledWith({
      changeShareAccess: 'Apply',
      shareName: 'media',
      'userAccess.0': 'read-write',
      'userAccess.1': 'read-only',
    });
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'shares.updateAccess', target: 'media', outcome: 'initiated' }),
    );
  });

  it('defaults a missing access value to no-access', async () => {
    const client = makeEmhttpdClient();
    const { audit } = makeFakeAudit();

    await updateShareAccess(
      'media',
      [{ userId: '2', access: undefined as unknown as string }],
      { client, audit, caller: { id: 'u1', name: 'admin' } },
    );

    expect(client.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ 'userAccess.2': 'no-access' }),
    );
  });

  it('rejects a non-array access argument', async () => {
    const client = makeEmhttpdClient();
    const { audit } = makeFakeAudit();

    await expect(
      updateShareAccess(
        'media',
        'not-an-array' as unknown as { userId: string; access: string }[],
        { client, audit, caller: { id: 'u1', name: 'admin' } },
      ),
    ).rejects.toThrow(/must be a list/);
  });

  it('throws when emhttpd returns a failure response', async () => {
    const client = makeEmhttpdClient({ sendCommand: vi.fn().mockResolvedValue('500 Internal Server Error') });
    const { audit } = makeFakeAudit();

    await expect(
      updateShareAccess('media', [{ userId: '0', access: 'read-write' }], {
        client,
        audit,
        caller: { id: 'u1', name: 'admin' },
      }),
    ).rejects.toThrow(/emhttpd refused updateShareAccess/);
  });
});
