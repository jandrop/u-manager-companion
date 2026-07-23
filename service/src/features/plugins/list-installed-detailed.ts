/**
 * installedUnraidPluginsDetailed query.
 *
 * Lists every `.plg` filename under `/boot/config/plugins/` and parses
 * each into a full `PluginManifestRecord` (name, author, version,
 * description, changelog, cached update info, ...), delegating all IO to
 * the injected `PluginManifestClient` (platform.ts) so nothing here
 * touches a filesystem directly. Read-only -- NOT audited, same posture
 * as the shares read queries.
 *
 * A plugin's `name` falls back to its filename (without `.plg`) when the
 * manifest is unreadable or omits `<!ENTITY name>`. `description` is
 * sourced from the plugin's extracted README, not from the manifest XML.
 */
import type { PluginManifestClient, PluginManifestRecord } from './platform.js';

export interface ListInstalledPluginsDetailedDeps {
  readonly client: PluginManifestClient;
}

function stripPlgExtension(filename: string): string {
  return filename.replace(/\.plg$/, '');
}

async function toManifestRecord(
  filename: string,
  client: PluginManifestClient,
): Promise<PluginManifestRecord> {
  const parsed = await client.readManifest(filename);
  const resolvedName = parsed.name ?? stripPlgExtension(filename);
  const [description, cachedUpdate] = await Promise.all([
    client.readReadmeDescription(resolvedName),
    client.readCachedUpdate(filename),
  ]);

  return {
    filename,
    name: resolvedName,
    author: parsed.author,
    version: parsed.version,
    description,
    pluginURL: parsed.pluginURL,
    support: parsed.support,
    icon: parsed.icon,
    launch: parsed.launch,
    changelog: parsed.changelog,
    latestVersion: cachedUpdate.latestVersion,
    lastCheckedAt: cachedUpdate.lastCheckedAt,
  };
}

/** Backs `Query.installedUnraidPluginsDetailed`. Read-only -- NOT audited.
 * Every per-plugin parse degrades gracefully (see platform.ts), so one
 * unreadable/malformed `.plg` never fails the whole list. */
export async function listInstalledPluginsDetailed(
  deps: ListInstalledPluginsDetailedDeps,
): Promise<readonly PluginManifestRecord[]> {
  const filenames = await deps.client.listPluginFilenames();
  return Promise.all(filenames.map((filename) => toManifestRecord(filename, deps.client)));
}
