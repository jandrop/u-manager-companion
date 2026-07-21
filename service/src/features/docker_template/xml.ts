/**
 * Docker template XML builder/parser + container-name sanitisation.
 *
 * PARITY-CRITICAL: ported verbatim (byte-for-byte output) from
 * `docker_template_create.py`'s `buildTemplateXml()`/`configToXml()`/
 * `sanitiseName()` and `docker_template_edit.py`'s identical write-side
 * copies plus its read-side `parseTemplateXml()`/`readTag()`/
 * `readBool()`/`unescXml()`. The written file is
 * `/boot/config/plugins/dockerMan/templates-user/my-<Name>.xml`, read by
 * Unraid's own dockerMan UI and by CA's "Previous Apps" flow -- any
 * structural drift here (attribute order, self-closing vs. body-value
 * Config rendering, escaping) breaks interop with code this project does
 * not own. Golden-string tests in __tests__/xml.test.ts pin this exact
 * shape.
 */

/** Allowed container-name charset, ported verbatim from the Python
 * patches' `sanitiseName()`. */
const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Validates + trims a raw container/template name. Throws with the SAME
 * message format the Python-patched bundle throws, so any surfaced error
 * text stays consistent across the migration.
 */
export function sanitiseContainerName(raw: string): string {
  const trimmed = raw.trim();
  if (!NAME_PATTERN.test(trimmed)) {
    throw new Error(`Invalid container name "${raw}". Allowed: A-Z a-z 0-9 _ . -`);
  }
  return trimmed;
}

/** Config entry kinds mirrored from DockerConfigEntryType in the legacy
 * patched bundle (schema.graphql's DockerConfigEntryType enum uses the
 * upper-case wire form; this module works in the title-case XML form the
 * on-disk template actually uses). */
export type DockerConfigEntryTypeXml = 'Path' | 'Port' | 'Variable' | 'Label' | 'Device';

export interface DockerConfigEntry {
  readonly name: string;
  readonly target: string;
  readonly type?: DockerConfigEntryTypeXml;
  readonly value?: string;
  readonly default?: string;
  readonly mode?: string;
  readonly description?: string;
  readonly display?: string;
  readonly required?: boolean;
  readonly mask?: boolean;
}

export interface DockerTemplateXmlInput {
  readonly repository: string;
  readonly registry?: string;
  readonly network?: string;
  readonly shell?: string;
  readonly privileged?: boolean;
  readonly support?: string;
  readonly project?: string;
  readonly readme?: string;
  readonly overview?: string;
  readonly webui?: string;
  readonly icon?: string;
  readonly extraParams?: string;
  readonly postArgs?: string;
  readonly cpuset?: string;
  readonly fixedMac?: string;
  readonly configs: readonly DockerConfigEntry[];
}

/** Parsed template shape, as read back by parseTemplateXml(). Mirrors the
 * app-facing DockerTemplate SDL type's field set. */
export interface ParsedDockerTemplate {
  readonly name: string;
  readonly repository: string;
  readonly network: string | null;
  readonly privileged: boolean | null;
  readonly shell: string | null;
  readonly overview: string | null;
  readonly icon: string | null;
  readonly webui: string | null;
  readonly support: string | null;
  readonly project: string | null;
  readonly readme: string | null;
  readonly registry: string | null;
  readonly extraParams: string | null;
  readonly postArgs: string | null;
  readonly cpuset: string | null;
  readonly fixedMac: string | null;
  readonly configs: readonly ParsedDockerConfigEntry[];
}

export interface ParsedDockerConfigEntry {
  readonly name: string;
  readonly type: string;
  readonly target: string;
  readonly value: string | null;
  readonly default: string | null;
  readonly mode: string | null;
  readonly description: string | null;
  readonly display: string | null;
  readonly required: boolean | null;
  readonly mask: boolean | null;
}

function escXml(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(value: unknown): string {
  return escXml(value).replace(/"/g, '&quot;');
}

function unescXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Renders a single `<Config .../>` (or `<Config ...>value</Config>` when a
 * value is present) element. Attribute order is FIXED (Name, Target,
 * Default, Mode, Description, Type, Display, Required, Mask) -- matches
 * the Python patches exactly.
 */
export function configToXml(config: DockerConfigEntry): string {
  const attrs = [
    `Name="${escAttr(config.name)}"`,
    `Target="${escAttr(config.target)}"`,
    `Default="${escAttr(config.default ?? '')}"`,
    `Mode="${escAttr(config.mode ?? '')}"`,
    `Description="${escAttr(config.description ?? '')}"`,
    `Type="${config.type ?? 'Variable'}"`,
    `Display="${escAttr(config.display ?? 'always')}"`,
    `Required="${config.required ? 'true' : 'false'}"`,
    `Mask="${config.mask ? 'true' : 'false'}"`,
  ];
  const value = config.value ?? '';
  return value === ''
    ? `<Config ${attrs.join(' ')}/>`
    : `<Config ${attrs.join(' ')}>${escXml(value)}</Config>`;
}

function pushTag(lines: string[], tag: string, value: string | undefined): void {
  const v = value ?? '';
  lines.push(v === '' ? `  <${tag}/>` : `  <${tag}>${escXml(v)}</${tag}>`);
}

/**
 * Renders the full `my-<Name>.xml` document. Tag order is FIXED -- matches
 * `docker_template_create.py`'s `buildTemplateXml()` line-for-line,
 * including the empty `<MyIP/>` placeholder (kept for on-disk format
 * parity even though this project never populates it) and `<MyMAC>` being
 * OMITTED ENTIRELY (not just self-closed) when fixedMac is absent.
 */
export function buildTemplateXml(input: DockerTemplateXmlInput, name: string): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0"?>');
  lines.push('<Container version="2">');
  pushTag(lines, 'Name', name);
  pushTag(lines, 'Repository', input.repository);
  pushTag(lines, 'Registry', input.registry);
  pushTag(lines, 'Network', input.network ?? 'bridge');
  pushTag(lines, 'MyIP', '');
  pushTag(lines, 'Shell', input.shell ?? 'sh');
  pushTag(lines, 'Privileged', input.privileged ? 'true' : 'false');
  pushTag(lines, 'Support', input.support);
  pushTag(lines, 'Project', input.project);
  pushTag(lines, 'ReadMe', input.readme);
  pushTag(lines, 'Overview', input.overview);
  pushTag(lines, 'WebUI', input.webui);
  pushTag(lines, 'Icon', input.icon);
  pushTag(lines, 'ExtraParams', input.extraParams);
  pushTag(lines, 'PostArgs', input.postArgs);
  pushTag(lines, 'CPUset', input.cpuset);
  if (input.fixedMac) pushTag(lines, 'MyMAC', input.fixedMac);
  for (const config of input.configs) lines.push(`  ${configToXml(config)}`);
  lines.push('</Container>');
  return `${lines.join('\n')}\n`;
}

const CONFIG_TYPES = new Set<string>(['Path', 'Port', 'Variable', 'Label', 'Device']);

function readTag(xml: string, tag: string): string | null {
  const selfClosing = new RegExp(`<${tag}\\s*/>`);
  if (selfClosing.test(xml)) return '';
  const withBody = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`);
  const match = xml.match(withBody);
  return match?.[1] !== undefined ? unescXml(match[1]).trim() : null;
}

function readBool(xml: string, tag: string): boolean | null {
  const value = readTag(xml, tag);
  if (value === null || value === '') return null;
  return value.toLowerCase() === 'true';
}

/**
 * Parses a `my-<Name>.xml` document back into the shape an Edit form
 * hydrates from. Ported verbatim from `docker_template_edit.py`'s
 * `parseTemplateXml()`/`readTag()`/`readBool()`.
 */
export function parseTemplateXml(xml: string): ParsedDockerTemplate {
  const configs: ParsedDockerConfigEntry[] = [];
  const configRegex = /<Config\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/Config>)/g;
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = configRegex.exec(xml)) !== null) {
    const attrsRaw = match[1] ?? '';
    const inner = match[2] ?? '';
    const attr = (attrName: string): string | null => {
      const attrMatch = attrsRaw.match(new RegExp(`${attrName}="([^"]*)"`));
      return attrMatch?.[1] !== undefined ? unescXml(attrMatch[1]) : null;
    };
    const type = attr('Type') ?? '';
    if (!CONFIG_TYPES.has(type)) continue;
    const requiredAttr = attr('Required');
    const maskAttr = attr('Mask');
    configs.push({
      name: attr('Name') ?? '',
      type,
      target: attr('Target') ?? '',
      value: inner ? unescXml(inner).trim() : null,
      default: attr('Default'),
      mode: attr('Mode'),
      description: attr('Description'),
      display: attr('Display'),
      required: requiredAttr !== null ? requiredAttr === 'true' : null,
      mask: maskAttr !== null ? maskAttr === 'true' : null,
    });
  }

  return {
    name: readTag(xml, 'Name') ?? '',
    repository: readTag(xml, 'Repository') ?? '',
    network: readTag(xml, 'Network'),
    privileged: readBool(xml, 'Privileged'),
    shell: readTag(xml, 'Shell'),
    overview: readTag(xml, 'Overview'),
    icon: readTag(xml, 'Icon'),
    webui: readTag(xml, 'WebUI'),
    support: readTag(xml, 'Support'),
    project: readTag(xml, 'Project'),
    readme: readTag(xml, 'ReadMe'),
    registry: readTag(xml, 'Registry'),
    extraParams: readTag(xml, 'ExtraParams'),
    postArgs: readTag(xml, 'PostArgs'),
    cpuset: readTag(xml, 'CPUset'),
    fixedMac: readTag(xml, 'MyMAC'),
    configs,
  };
}
