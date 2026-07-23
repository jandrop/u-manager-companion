/**
 * features/plugins/platform.ts tests.
 *
 * Covers the `.plg` manifest XML parser (entities, attributes, entity-
 * reference resolution, `<CHANGES>` extraction with/without CDATA), the
 * cached-update version extractor, and the README description cleaner.
 * Everything here is pure/synchronous parsing (no IO), so this suite
 * never touches a real filesystem.
 */
import { describe, expect, it } from 'vitest';
import {
  parseCachedPluginVersion,
  parsePluginManifestXml,
  parseReadmeDescription,
} from '../platform.js';

describe('parsePluginManifestXml', () => {
  it('extracts fields from <!ENTITY> declarations', () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE PLUGIN [
<!ENTITY name "tailscale">
<!ENTITY author "Ich777">
<!ENTITY version "2026.05.07">
<!ENTITY pluginURL "https://example.com/tailscale.plg">
<!ENTITY support "https://forums.unraid.net/topic/1">
<!ENTITY icon "tailscale-icon">
<!ENTITY launch "Settings/Tailscale">
]>
<PLUGIN name="&name;" author="&author;" version="&version;">
  <CHANGES>
### 2026.05.07
- Initial release
  </CHANGES>
</PLUGIN>`;

    const result = parsePluginManifestXml(xml);

    expect(result.name).toBe('tailscale');
    expect(result.author).toBe('Ich777');
    expect(result.version).toBe('2026.05.07');
    expect(result.pluginURL).toBe('https://example.com/tailscale.plg');
    expect(result.support).toBe('https://forums.unraid.net/topic/1');
    expect(result.icon).toBe('tailscale-icon');
    expect(result.launch).toBe('Settings/Tailscale');
    expect(result.changelog).toContain('2026.05.07');
    expect(result.changelog).toContain('Initial release');
  });

  it('falls back to the support alias supportURL', () => {
    const xml = `<!ENTITY supportURL "https://forums.unraid.net/topic/2">
<PLUGIN name="x"></PLUGIN>`;
    expect(parsePluginManifestXml(xml).support).toBe('https://forums.unraid.net/topic/2');
  });

  it('prefers PLUGIN tag attributes over entities of the same name', () => {
    const xml = `<!ENTITY name "entity-name">
<PLUGIN name="attribute-name"></PLUGIN>`;
    expect(parsePluginManifestXml(xml).name).toBe('attribute-name');
  });

  it('resolves entity references inside another entity value', () => {
    const xml = `<!ENTITY base "example.com">
<!ENTITY pluginURL "https://&base;/plugin.plg">
<PLUGIN name="x"></PLUGIN>`;
    expect(parsePluginManifestXml(xml).pluginURL).toBe('https://example.com/plugin.plg');
  });

  it('leaves an unresolvable entity reference as literal text', () => {
    const xml = `<!ENTITY pluginURL "https://&missing;/plugin.plg">
<PLUGIN name="x"></PLUGIN>`;
    expect(parsePluginManifestXml(xml).pluginURL).toBe('https://&missing;/plugin.plg');
  });

  it('does not infinite-loop on a self-referencing entity', () => {
    const xml = `<!ENTITY loop "&loop;">
<!ENTITY name "&loop;">
<PLUGIN name="x"></PLUGIN>`;
    expect(() => parsePluginManifestXml(xml)).not.toThrow();
  });

  it('extracts a CDATA-wrapped <CHANGES> body', () => {
    const xml = `<PLUGIN name="x">
  <CHANGES><![CDATA[
### 2026.01.01
- Fixed a bug with \`<filename>\` handling
]]></CHANGES>
</PLUGIN>`;
    const changelog = parsePluginManifestXml(xml).changelog;
    expect(changelog).toContain('Fixed a bug with `<filename>` handling');
    expect(changelog).not.toContain('CDATA');
  });

  it('returns an all-null result for empty/malformed XML', () => {
    const result = parsePluginManifestXml('');
    expect(result).toEqual({
      name: null,
      author: null,
      version: null,
      pluginURL: null,
      support: null,
      icon: null,
      launch: null,
      changelog: null,
    });
  });

  it('returns a null changelog when <CHANGES> is absent or empty', () => {
    expect(parsePluginManifestXml('<PLUGIN name="x"></PLUGIN>').changelog).toBeNull();
    expect(
      parsePluginManifestXml('<PLUGIN name="x"><CHANGES></CHANGES></PLUGIN>').changelog,
    ).toBeNull();
  });
});

describe('parseCachedPluginVersion', () => {
  it('extracts the version entity from cached remote .plg XML', () => {
    const xml = `<!ENTITY version "2026.06.01">
<PLUGIN name="x"></PLUGIN>`;
    expect(parseCachedPluginVersion(xml)).toBe('2026.06.01');
  });

  it('supports single-quoted entity values', () => {
    expect(parseCachedPluginVersion("<!ENTITY version '2026.06.01'>")).toBe('2026.06.01');
  });

  it('returns null when the version entity is absent', () => {
    expect(parseCachedPluginVersion('<PLUGIN name="x"></PLUGIN>')).toBeNull();
  });

  it('returns null for an empty-after-trim version value', () => {
    expect(parseCachedPluginVersion('<!ENTITY version "   ">')).toBeNull();
  });
});

describe('parseReadmeDescription', () => {
  it('strips a leading bold title line', () => {
    const body = '**Tailscale**\nA secure network client.\nMore details here.';
    expect(parseReadmeDescription(body)).toBe('A secure network client.\nMore details here.');
  });

  it('keeps the first line when it is not a bold title', () => {
    const body = 'A secure network client.\nMore details here.';
    expect(parseReadmeDescription(body)).toBe(body);
  });

  it('returns null for empty-after-trim content', () => {
    expect(parseReadmeDescription('**Tailscale**\n\n   \n')).toBeNull();
    expect(parseReadmeDescription('')).toBeNull();
  });
});
