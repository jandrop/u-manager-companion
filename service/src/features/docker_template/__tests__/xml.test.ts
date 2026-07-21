/**
 * docker_template/xml.ts tests.
 *
 * TDD: written before xml.ts exists -> RED first.
 *
 * GOLDEN-STRING PARITY: buildTemplateXml/configToXml/sanitiseName here MUST
 * match the CURRENT patched bundle output BYTE-FOR-BYTE -- ported verbatim
 * from `docker_template_create.py`'s `buildTemplateXml()`/`configToXml()`/
 * `sanitiseName()` (and cross-checked against `docker_template_edit.py`'s
 * identical copies + its `parseTemplateXml()`/`readTag()`/`unescXml()`
 * read-side). The app's DTOs and the demo server depend on this exact
 * shape -- any structural drift (attribute order, escaping, empty-tag
 * self-closing, config self-closing-vs-body-value) is a parity break, not a
 * style choice.
 */
import { describe, expect, it } from 'vitest';
import {
  buildTemplateXml,
  configToXml,
  parseTemplateXml,
  sanitiseContainerName,
  type DockerConfigEntry,
  type DockerTemplateXmlInput,
} from '../xml.js';

describe('sanitiseContainerName', () => {
  it('accepts names matching ^[A-Za-z0-9_.-]+$', () => {
    expect(sanitiseContainerName('Plex-Media-Server_2.0')).toBe('Plex-Media-Server_2.0');
  });

  it('trims surrounding whitespace before validating', () => {
    expect(sanitiseContainerName('  plex  ')).toBe('plex');
  });

  it('rejects names with disallowed characters (golden Python error message)', () => {
    expect(() => sanitiseContainerName('plex server')).toThrow(
      'Invalid container name "plex server". Allowed: A-Z a-z 0-9 _ . -',
    );
  });

  it('rejects path traversal attempts', () => {
    expect(() => sanitiseContainerName('../../etc/passwd')).toThrow(/Invalid container name/);
  });

  it('rejects an empty name', () => {
    expect(() => sanitiseContainerName('')).toThrow(/Invalid container name/);
  });
});

describe('configToXml', () => {
  const baseConfig: DockerConfigEntry = {
    name: 'WEBUI_PORT',
    target: '80',
    type: 'Port',
  };

  it('self-closes a Config entry with no value', () => {
    expect(configToXml(baseConfig)).toBe(
      '<Config Name="WEBUI_PORT" Target="80" Default="" Mode="" Description="" Type="Port" Display="always" Required="false" Mask="false"/>',
    );
  });

  it('renders Config with a body when value is present', () => {
    expect(configToXml({ ...baseConfig, value: '32400' })).toBe(
      '<Config Name="WEBUI_PORT" Target="80" Default="" Mode="" Description="" Type="Port" Display="always" Required="false" Mask="false">32400</Config>',
    );
  });

  it('defaults Type to Variable when omitted', () => {
    expect(configToXml({ name: 'X', target: 'X' })).toBe(
      '<Config Name="X" Target="X" Default="" Mode="" Description="" Type="Variable" Display="always" Required="false" Mask="false"/>',
    );
  });

  it('renders Required/Mask as literal true/false, not attribute omission', () => {
    expect(configToXml({ ...baseConfig, required: true, mask: true })).toBe(
      '<Config Name="WEBUI_PORT" Target="80" Default="" Mode="" Description="" Type="Port" Display="always" Required="true" Mask="true"/>',
    );
  });

  it('escapes &, <, > in attribute and body values, and additionally " in attributes', () => {
    expect(
      configToXml({
        name: 'A&B',
        target: 'T',
        description: '<desc "quoted">',
        value: 'a<b>&"c"',
      }),
    ).toBe(
      '<Config Name="A&amp;B" Target="T" Default="" Mode="" Description="&lt;desc &quot;quoted&quot;&gt;" Type="Variable" Display="always" Required="false" Mask="false">a&lt;b&gt;&amp;"c"</Config>',
    );
  });

  it('honours a custom Display value', () => {
    expect(configToXml({ ...baseConfig, display: 'always-hide' })).toContain(
      'Display="always-hide"',
    );
  });
});

describe('buildTemplateXml', () => {
  const minimalInput: DockerTemplateXmlInput = {
    repository: 'lscr.io/linuxserver/plex',
    configs: [],
  };

  it('renders the minimal golden template (empty configs, all-default optional fields)', () => {
    const xml = buildTemplateXml(minimalInput, 'plex');
    expect(xml).toBe(
      [
        '<?xml version="1.0"?>',
        '<Container version="2">',
        '  <Name>plex</Name>',
        '  <Repository>lscr.io/linuxserver/plex</Repository>',
        '  <Registry/>',
        '  <Network>bridge</Network>',
        '  <MyIP/>',
        '  <Shell>sh</Shell>',
        '  <Privileged>false</Privileged>',
        '  <Support/>',
        '  <Project/>',
        '  <ReadMe/>',
        '  <Overview/>',
        '  <WebUI/>',
        '  <Icon/>',
        '  <ExtraParams/>',
        '  <PostArgs/>',
        '  <CPUset/>',
        '</Container>',
        '',
      ].join('\n'),
    );
  });

  it('renders every optional field and configs when provided', () => {
    const input: DockerTemplateXmlInput = {
      repository: 'lscr.io/linuxserver/plex',
      registry: 'https://hub.docker.com/r/linuxserver/plex',
      network: 'host',
      shell: 'bash',
      privileged: true,
      support: 'https://forums.unraid.net/topic/1',
      project: 'https://github.com/linuxserver/docker-plex',
      readme: 'https://github.com/linuxserver/docker-plex/blob/master/README.md',
      overview: 'Plex Media Server',
      webui: 'http://[IP]:[PORT:32400]/web',
      icon: 'https://example.com/icon.png',
      extraParams: '--device=/dev/dri:/dev/dri',
      postArgs: '',
      cpuset: '0-3',
      fixedMac: '02:42:AC:11:00:02',
      configs: [{ name: 'WEBUI_PORT', target: '80', type: 'Port', value: '32400' }],
    };
    const xml = buildTemplateXml(input, 'plex');
    expect(xml).toBe(
      [
        '<?xml version="1.0"?>',
        '<Container version="2">',
        '  <Name>plex</Name>',
        '  <Repository>lscr.io/linuxserver/plex</Repository>',
        '  <Registry>https://hub.docker.com/r/linuxserver/plex</Registry>',
        '  <Network>host</Network>',
        '  <MyIP/>',
        '  <Shell>bash</Shell>',
        '  <Privileged>true</Privileged>',
        '  <Support>https://forums.unraid.net/topic/1</Support>',
        '  <Project>https://github.com/linuxserver/docker-plex</Project>',
        '  <ReadMe>https://github.com/linuxserver/docker-plex/blob/master/README.md</ReadMe>',
        '  <Overview>Plex Media Server</Overview>',
        '  <WebUI>http://[IP]:[PORT:32400]/web</WebUI>',
        '  <Icon>https://example.com/icon.png</Icon>',
        '  <ExtraParams>--device=/dev/dri:/dev/dri</ExtraParams>',
        '  <PostArgs/>',
        '  <CPUset>0-3</CPUset>',
        '  <MyMAC>02:42:AC:11:00:02</MyMAC>',
        '  <Config Name="WEBUI_PORT" Target="80" Default="" Mode="" Description="" Type="Port" Display="always" Required="false" Mask="false">32400</Config>',
        '</Container>',
        '',
      ].join('\n'),
    );
  });

  it('escapes XML special characters in tag bodies', () => {
    const xml = buildTemplateXml(
      { repository: 'a&b<c>', configs: [], overview: 'Line with & < > "quote"' },
      'plex',
    );
    expect(xml).toContain('<Repository>a&amp;b&lt;c&gt;</Repository>');
    expect(xml).toContain('<Overview>Line with &amp; &lt; &gt; "quote"</Overview>');
  });

  it('omits MyMAC entirely when fixedMac is not provided', () => {
    const xml = buildTemplateXml(minimalInput, 'plex');
    expect(xml).not.toContain('MyMAC');
  });
});

describe('parseTemplateXml (round-trip with buildTemplateXml)', () => {
  it('round-trips repository, network, privileged, and one Variable config', () => {
    const input: DockerTemplateXmlInput = {
      repository: 'lscr.io/linuxserver/plex',
      network: 'host',
      privileged: true,
      configs: [{ name: 'WEBUI_PORT', target: '80', type: 'Port', value: '32400' }],
    };
    const xml = buildTemplateXml(input, 'plex');
    const parsed = parseTemplateXml(xml);

    expect(parsed.name).toBe('plex');
    expect(parsed.repository).toBe('lscr.io/linuxserver/plex');
    expect(parsed.network).toBe('host');
    expect(parsed.privileged).toBe(true);
    expect(parsed.configs).toHaveLength(1);
    expect(parsed.configs[0]).toMatchObject({
      name: 'WEBUI_PORT',
      target: '80',
      type: 'Port',
      value: '32400',
    });
  });

  it('unescapes entities back to their literal characters', () => {
    const xml = buildTemplateXml(
      { repository: 'a&b<c>', configs: [], overview: 'Line with & < > "quote"' },
      'plex',
    );
    const parsed = parseTemplateXml(xml);
    expect(parsed.repository).toBe('a&b<c>');
    expect(parsed.overview).toBe('Line with & < > "quote"');
  });
});
