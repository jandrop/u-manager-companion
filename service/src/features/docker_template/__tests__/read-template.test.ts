/**
 * docker_template/read-template.ts tests.
 *
 * TDD: written before read-template.ts exists -> RED first.
 *
 * Covers `readDockerTemplate()`: reads templates-user/my-<name>.xml and
 * parses it via xml.ts's parseTemplateXml, returning null when no
 * template exists on disk (ENOENT). Backs the `dockerTemplate(name)`
 * query -- a READ, not audited, since only privileged actions are
 * audited.
 */
import { describe, expect, it, vi } from 'vitest';
import { readDockerTemplate, type ReadTemplateFile } from '../read-template.js';

describe('readDockerTemplate', () => {
  it('returns the parsed template when the file exists', async () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<Container version="2">',
      '  <Name>plex</Name>',
      '  <Repository>lscr.io/linuxserver/plex</Repository>',
      '  <Network>bridge</Network>',
      '</Container>',
      '',
    ].join('\n');
    const readTemplateFile: ReadTemplateFile = vi.fn().mockResolvedValue(xml);

    const result = await readDockerTemplate('plex', { readTemplateFile });

    expect(result).toMatchObject({ name: 'plex', repository: 'lscr.io/linuxserver/plex' });
  });

  it('returns null when the template file does not exist (ENOENT)', async () => {
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    const readTemplateFile: ReadTemplateFile = vi.fn().mockRejectedValue(enoent);

    const result = await readDockerTemplate('ghost', { readTemplateFile });

    expect(result).toBeNull();
  });

  it('propagates a non-ENOENT read error', async () => {
    const readTemplateFile: ReadTemplateFile = vi.fn().mockRejectedValue(new Error('EACCES'));

    await expect(readDockerTemplate('plex', { readTemplateFile })).rejects.toThrow('EACCES');
  });

  it('rejects an invalid name synchronously without reading the file', async () => {
    const readTemplateFile: ReadTemplateFile = vi.fn();

    await expect(readDockerTemplate('bad name!', { readTemplateFile })).rejects.toThrow(
      /Invalid container name/,
    );
    expect(readTemplateFile).not.toHaveBeenCalled();
  });
});
