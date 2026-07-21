/**
 * dockerTemplate(name) query.
 *
 * Ported from `docker_template_edit.py`'s `readTemplate()`: reads
 * templates-user/my-<name>.xml and parses it via xml.ts's
 * parseTemplateXml, returning null when no template exists on disk
 * (matches the mutation's "hydrate an Edit form" use case). This is a
 * READ, not a privileged action -- NOT audited, since only privileged
 * actions are audited and a plain read produces no record.
 */
import { sanitiseContainerName, parseTemplateXml, type ParsedDockerTemplate } from './xml.js';
import { TEMPLATES_USER_DIR } from './install.js';

/** Injectable template-file reader -- production wiring shells to
 * fs/promises `readFile`; tests inject a fake so nothing here touches
 * `/boot/config/...`. Must reject with a Node-shaped `{code: 'ENOENT'}`
 * error when the file does not exist, matching fs/promises' own
 * behavior. */
export type ReadTemplateFile = (path: string) => Promise<string>;

export interface ReadDockerTemplateDeps {
  readonly readTemplateFile: ReadTemplateFile;
}

function templatePath(name: string): string {
  return `${TEMPLATES_USER_DIR}/my-${name}.xml`;
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * Returns the saved user template for an existing Docker container, or
 * null when no template is on disk for the given (sanitised) name.
 * Propagates any non-ENOENT read failure (e.g. permission errors) rather
 * than masking it as "not found".
 */
export async function readDockerTemplate(
  name: string,
  deps: ReadDockerTemplateDeps,
): Promise<ParsedDockerTemplate | null> {
  const safeName = sanitiseContainerName(name);
  try {
    const xml = await deps.readTemplateFile(templatePath(safeName));
    return parseTemplateXml(xml);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}
