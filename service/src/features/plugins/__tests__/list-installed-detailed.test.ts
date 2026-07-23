/**
 * features/plugins/list-installed-detailed.ts tests.
 *
 * TDD: written before list-installed-detailed.ts exists -> RED first.
 *
 * Covers `listInstalledPluginsDetailed(deps)`: maps every filename the
 * injected client reports through `readManifest`/`readReadmeDescription`/
 * `readCachedUpdate`, resolving the name fallback and assembling the final
 * PluginManifestRecord. Everything here is injectable (client), so this
 * suite never touches a real filesystem.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ParsedPluginManifestXml, PluginManifestClient } from '../platform.js';
import { listInstalledPluginsDetailed } from '../list-installed-detailed.js';

function makeParsed(overrides: Partial<ParsedPluginManifestXml> = {}): ParsedPluginManifestXml {
  return {
    name: null,
    author: null,
    version: null,
    pluginURL: null,
    support: null,
    icon: null,
    launch: null,
    changelog: null,
    ...overrides,
  };
}

function makeFakeClient(overrides: Partial<PluginManifestClient> = {}): PluginManifestClient {
  return {
    listPluginFilenames: vi.fn(async () => []),
    readManifest: vi.fn(async () => makeParsed()),
    readReadmeDescription: vi.fn(async () => null),
    readCachedUpdate: vi.fn(async () => ({ latestVersion: null, lastCheckedAt: null })),
    ...overrides,
  };
}

describe('listInstalledPluginsDetailed', () => {
  it('returns an empty list when no plugins are installed', async () => {
    const client = makeFakeClient();
    const result = await listInstalledPluginsDetailed({ client });
    expect(result).toEqual([]);
  });

  it('assembles a full record per filename from the manifest, README and cache', async () => {
    const client = makeFakeClient({
      listPluginFilenames: vi.fn(async () => ['tailscale.plg']),
      readManifest: vi.fn(async () =>
        makeParsed({
          name: 'tailscale',
          author: 'Ich777',
          version: '2026.05.07',
          pluginURL: 'https://example.com/tailscale.plg',
          support: 'https://forums.unraid.net/topic/1',
          icon: 'tailscale-icon',
          launch: 'Settings/Tailscale',
          changelog: '- Initial release',
        }),
      ),
      readReadmeDescription: vi.fn(async () => 'A secure network client.'),
      readCachedUpdate: vi.fn(async () => ({
        latestVersion: '2026.06.01',
        lastCheckedAt: new Date('2026-06-01T12:00:00Z'),
      })),
    });

    const [record] = await listInstalledPluginsDetailed({ client });

    expect(record).toEqual({
      filename: 'tailscale.plg',
      name: 'tailscale',
      author: 'Ich777',
      version: '2026.05.07',
      description: 'A secure network client.',
      pluginURL: 'https://example.com/tailscale.plg',
      support: 'https://forums.unraid.net/topic/1',
      icon: 'tailscale-icon',
      launch: 'Settings/Tailscale',
      changelog: '- Initial release',
      latestVersion: '2026.06.01',
      lastCheckedAt: new Date('2026-06-01T12:00:00Z'),
    });
  });

  it('falls back to the filename without .plg when the manifest has no name', async () => {
    const client = makeFakeClient({
      listPluginFilenames: vi.fn(async () => ['unnamed.plugin.plg']),
      readManifest: vi.fn(async () => makeParsed({ name: null })),
    });

    const [record] = await listInstalledPluginsDetailed({ client });

    expect(record!.name).toBe('unnamed.plugin');
  });

  it('reads the README description using the resolved name, not the filename', async () => {
    const readReadmeDescription = vi.fn(async () => 'desc');
    const client = makeFakeClient({
      listPluginFilenames: vi.fn(async () => ['tailscale.plg']),
      readManifest: vi.fn(async () => makeParsed({ name: 'tailscale' })),
      readReadmeDescription,
    });

    await listInstalledPluginsDetailed({ client });

    expect(readReadmeDescription).toHaveBeenCalledWith('tailscale');
  });

  it('processes every plugin independently -- one bad entry never drops the rest', async () => {
    const client = makeFakeClient({
      listPluginFilenames: vi.fn(async () => ['a.plg', 'b.plg']),
      readManifest: vi.fn(async (filename: string) =>
        makeParsed({ name: filename === 'a.plg' ? null : 'b' }),
      ),
    });

    const result = await listInstalledPluginsDetailed({ client });

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.name)).toEqual(['a', 'b']);
  });
});
