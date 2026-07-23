/**
 * Plugin manifest platform primitives + the injectable PluginManifestClient
 * contract.
 *
 * Parses `.plg` XML manifests under `/boot/config/plugins/`, the plugin's
 * extracted README (`/usr/local/emhttp/plugins/<name>/README.md`) and the
 * cached remote `.plg` Unraid writes to `/tmp/plugins/<filename>` after a
 * `plugin checkall`. Pure/testable parsing helpers are exported directly;
 * `PluginManifestClient` is the higher-level injectable surface
 * `list-installed-detailed.ts` depends on -- production wiring (server.ts)
 * builds the REAL client (real fs reads); tests inject a fake so nothing
 * here ever touches the real filesystem in a unit test.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** Mirrors the field set the app's `installedUnraidPluginsDetailedQuery`
 * selects (unraid_graphql_plugins_queries.dart), field-for-field. */
export interface PluginManifestRecord {
  readonly filename: string;
  readonly name: string;
  readonly author: string | null;
  readonly version: string | null;
  readonly description: string | null;
  readonly pluginURL: string | null;
  readonly support: string | null;
  readonly icon: string | null;
  readonly launch: string | null;
  readonly changelog: string | null;
  readonly latestVersion: string | null;
  readonly lastCheckedAt: Date | null;
}

interface CachedPluginUpdate {
  readonly latestVersion: string | null;
  readonly lastCheckedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without any IO)
// ---------------------------------------------------------------------------

const ENTITY_RE = /<!ENTITY\s+(\w+)\s+(?:"([^"]*)"|'([^']*)')/g;
const PLUGIN_TAG_RE = /<PLUGIN\s+([^>]*)>/s;
const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g;
const ENTITY_REF_RE = /&(\w+);/g;
const CHANGES_RE = /<CHANGES>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/CHANGES>/;
const MAX_ENTITY_RESOLVE_DEPTH = 5;

/** Resolves `&entity;` references inside a value against the parsed
 * `<!ENTITY>` table, recursively (capped at MAX_ENTITY_RESOLVE_DEPTH to
 * guard against self-referencing entities). An unresolvable reference is
 * left as the literal `&name;` text rather than stripped. Empty-after-trim
 * resolves to null. */
function resolveEntities(
  value: string | null | undefined,
  entities: Readonly<Record<string, string>>,
  depth = 0,
): string | null {
  if (value == null) return null;
  if (depth > MAX_ENTITY_RESOLVE_DEPTH) return value;
  const replaced = value.replace(ENTITY_REF_RE, (_match, key: string) => {
    const raw = entities[key];
    if (raw === undefined) return `&${key};`;
    return resolveEntities(raw, entities, depth + 1) ?? `&${key};`;
  });
  const trimmed = replaced.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parses a `.plg` XML manifest's `<!ENTITY>` declarations and the root
 * `<PLUGIN ...>` tag's attributes, then extracts the fields
 * `parsePluginManifestXml` exposes. Malformed/empty XML degrades to an
 * all-null result rather than throwing -- every regex match against `''`
 * simply fails, so a missing/unreadable manifest still yields a usable
 * (mostly empty) record.
 */
export interface ParsedPluginManifestXml {
  readonly name: string | null;
  readonly author: string | null;
  readonly version: string | null;
  readonly pluginURL: string | null;
  readonly support: string | null;
  readonly icon: string | null;
  readonly launch: string | null;
  readonly changelog: string | null;
}

export function parsePluginManifestXml(xml: string): ParsedPluginManifestXml {
  const entities: Record<string, string> = {};
  for (const match of xml.matchAll(ENTITY_RE)) {
    const key = match[1]!;
    entities[key] = (match[2] ?? match[3] ?? '').trim();
  }

  const attrs: Record<string, string> = {};
  const pluginTag = PLUGIN_TAG_RE.exec(xml);
  if (pluginTag) {
    for (const match of pluginTag[1]!.matchAll(ATTR_RE)) {
      attrs[match[1]!] = match[2]!;
    }
  }

  const pick = (key: string, ...aliases: readonly string[]): string | null => {
    for (const k of [key, ...aliases]) {
      if (attrs[k] != null) return resolveEntities(attrs[k], entities);
    }
    for (const k of [key, ...aliases]) {
      if (entities[k] != null) return resolveEntities(entities[k], entities);
    }
    return null;
  };

  const changesMatch = CHANGES_RE.exec(xml);
  const changelogBody = changesMatch ? changesMatch[1]!.trim() : null;

  return {
    name: pick('name'),
    author: pick('author'),
    version: pick('version'),
    pluginURL: pick('pluginURL'),
    support: pick('support', 'supportURL'),
    icon: pick('icon'),
    launch: pick('launch'),
    changelog: changelogBody && changelogBody.length > 0 ? changelogBody : null,
  };
}

const CACHED_VERSION_RE = /<!ENTITY\s+version\s+(?:"([^"]*)"|'([^']*)')/s;

/** Extracts just the `version` entity from a cached remote `.plg`'s XML
 * text (the `/tmp/plugins/<filename>` Unraid writes after `plugin
 * checkall`). Returns null when absent or empty-after-trim. */
export function parseCachedPluginVersion(xml: string): string | null {
  const match = CACHED_VERSION_RE.exec(xml);
  const raw = match ? (match[1] ?? match[2] ?? '') : '';
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Strips a leading bold Markdown title line (`**Plugin Name**`) from a
 * plugin's extracted README body -- that line duplicates the plugin name
 * already surfaced by the `name` field, so the description shouldn't
 * repeat it. Empty-after-trim resolves to null. */
export function parseReadmeDescription(body: string): string | null {
  const lines = body.split('\n');
  const first = lines[0]?.trim();
  if (first !== undefined && first.startsWith('**') && first.endsWith('**')) {
    lines.shift();
  }
  const cleaned = lines.join('\n').trim();
  return cleaned.length > 0 ? cleaned : null;
}

// ---------------------------------------------------------------------------
// PluginManifestClient -- the injectable surface list-installed-detailed.ts
// depends on
// ---------------------------------------------------------------------------

export interface PluginManifestClient {
  /** Bare `.plg` filenames currently installed, sourced from
   * `/boot/config/plugins/`. */
  listPluginFilenames(): Promise<readonly string[]>;
  /** Reads and parses one `.plg` manifest by filename. A missing/unreadable
   * file degrades to an all-null parse rather than throwing. */
  readManifest(filename: string): Promise<ParsedPluginManifestXml>;
  /** Reads the plugin's extracted README description, or null when the
   * README is missing/unreadable/empty. */
  readReadmeDescription(name: string): Promise<string | null>;
  /** Reads the cached remote `.plg` Unraid wrote to `/tmp/plugins/<filename>`
   * after the last `plugin checkall`, or nulls when no cache file exists. */
  readCachedUpdate(filename: string): Promise<CachedPluginUpdate>;
}

const PLUGINS_DIR = '/boot/config/plugins';
const PLUGINS_CACHE_DIR = '/tmp/plugins';
const EMHTTP_PLUGINS_DIR = '/usr/local/emhttp/plugins';

async function listPluginFilenamesReal(): Promise<readonly string[]> {
  try {
    const entries = await readdir(PLUGINS_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.plg'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function readManifestReal(filename: string): Promise<ParsedPluginManifestXml> {
  try {
    const xml = await readFile(path.join(PLUGINS_DIR, filename), 'utf8');
    return parsePluginManifestXml(xml);
  } catch {
    return parsePluginManifestXml('');
  }
}

async function readReadmeDescriptionReal(name: string): Promise<string | null> {
  try {
    const body = await readFile(path.join(EMHTTP_PLUGINS_DIR, name, 'README.md'), 'utf8');
    return parseReadmeDescription(body);
  } catch {
    return null;
  }
}

async function readCachedUpdateReal(filename: string): Promise<CachedPluginUpdate> {
  const cachePath = path.join(PLUGINS_CACHE_DIR, filename);
  let mtime: Date;
  try {
    mtime = (await stat(cachePath)).mtime;
  } catch {
    return { latestVersion: null, lastCheckedAt: null };
  }
  try {
    const xml = await readFile(cachePath, 'utf8');
    return { latestVersion: parseCachedPluginVersion(xml), lastCheckedAt: mtime };
  } catch {
    return { latestVersion: null, lastCheckedAt: mtime };
  }
}

/** Builds the REAL PluginManifestClient -- real `/boot/config/plugins`,
 * `/usr/local/emhttp/plugins` and `/tmp/plugins` reads. */
export function createPluginManifestClient(): PluginManifestClient {
  return {
    listPluginFilenames: listPluginFilenamesReal,
    readManifest: readManifestReal,
    readReadmeDescription: readReadmeDescriptionReal,
    readCachedUpdate: readCachedUpdateReal,
  };
}
