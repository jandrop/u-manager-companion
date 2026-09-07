import { describe, expect, it } from 'vitest';
import type { DiskSmartSettingsInput } from '../platform.js';
import {
  DEFAULT_NOTIFY_ATTRIBUTES,
  PRESELECT_ATTRIBUTES,
  SMART_FILE_KEYS,
  createSmartConfigClient,
  parseAllDiskSmartSettings,
  parseDiskSmartSettings,
  patchDiskSmartSettings,
  readTextOrEmpty,
  removeDiskSmartSection,
  toFileValues,
} from '../platform.js';

const TWO_DISKS =
  '[diskA]\nhotTemp="45"\nmaxTemp="55"\nsmSelect="1"\nsmLevel="1.50"\nsmEvents="5|197"\n' +
  '[diskB]\nhotTemp="40"\n';

describe('attribute constants', () => {
  it('PRESELECT_ATTRIBUTES holds the six codes the webGUI renders as checkboxes', () => {
    expect([...PRESELECT_ATTRIBUTES]).toEqual([5, 187, 188, 197, 198, 199]);
  });

  it('DEFAULT_NOTIFY_ATTRIBUTES omits 188 -- a preselect code that is default-OFF', () => {
    expect([...DEFAULT_NOTIFY_ATTRIBUTES]).toEqual([5, 187, 197, 198, 199]);
    expect(DEFAULT_NOTIFY_ATTRIBUTES).not.toContain(188);
    expect(PRESELECT_ATTRIBUTES).toContain(188);
  });
});

describe('parseDiskSmartSettings', () => {
  it('reports an absent file as unconfigured with every value null', () => {
    expect(parseDiskSmartSettings('', 'diskA')).toEqual({
      diskId: 'diskA',
      configured: false,
      hotTemp: null,
      maxTemp: null,
      smSelect: null,
      smLevel: null,
      notifyAttributes: null,
      defaultNotifyAttributes: [5, 187, 197, 198, 199],
      preselectAttributes: [5, 187, 188, 197, 198, 199],
    });
  });

  it('reports an absent section as unconfigured even when a sibling section exists', () => {
    const record = parseDiskSmartSettings(TWO_DISKS, 'diskC');
    expect(record.configured).toBe(false);
    expect(record.hotTemp).toBeNull();
    expect(record.notifyAttributes).toBeNull();
  });

  it('parses every modeled key of the target section', () => {
    expect(parseDiskSmartSettings(TWO_DISKS, 'diskA')).toEqual({
      diskId: 'diskA',
      configured: true,
      hotTemp: 45,
      maxTemp: 55,
      smSelect: 1,
      smLevel: 1.5,
      notifyAttributes: [5, 197],
      defaultNotifyAttributes: [5, 187, 197, 198, 199],
      preselectAttributes: [5, 187, 188, 197, 198, 199],
    });
  });

  it('is configured with nulls when the section exists but holds only unmodeled keys', () => {
    const record = parseDiskSmartSettings('[diskA]\nsmType="sat"\nsmPort1="0"\n', 'diskA');
    expect(record.configured).toBe(true);
    expect(record.hotTemp).toBeNull();
    expect(record.smSelect).toBeNull();
  });

  it.each(['hotTemp', 'maxTemp', 'smSelect', 'smLevel'] as const)(
    'reads a stored -1 in %s as null (parity with get_value())',
    (key) => {
      const record = parseDiskSmartSettings(`[diskA]\n${key}="-1"\n`, 'diskA');
      expect(record[key]).toBeNull();
    },
  );

  it.each(['hotTemp', 'maxTemp', 'smSelect', 'smLevel'] as const)(
    'reads a non-numeric %s as null rather than throwing',
    (key) => {
      const record = parseDiskSmartSettings(`[diskA]\n${key}="junk"\n`, 'diskA');
      expect(record[key]).toBeNull();
    },
  );

  it('keeps a stored 0 as 0 -- only -1 is the unset sentinel', () => {
    expect(parseDiskSmartSettings('[diskA]\nhotTemp="0"\nsmSelect="0"\n', 'diskA')).toMatchObject({
      hotTemp: 0,
      smSelect: 0,
    });
  });

  it('splits smEvents on | and drops non-integer tokens', () => {
    const record = parseDiskSmartSettings('[diskA]\nsmEvents="5|junk|197|"\n', 'diskA');
    expect(record.notifyAttributes).toEqual([5, 197]);
  });

  it('reads an empty smEvents as null -- an empty value means "inherits"', () => {
    expect(parseDiskSmartSettings('[diskA]\nsmEvents=""\n', 'diskA').notifyAttributes).toBeNull();
  });

  it('reads an absent smEvents as null', () => {
    expect(parseDiskSmartSettings('[diskA]\nhotTemp="45"\n', 'diskA').notifyAttributes).toBeNull();
  });

  it('never exposes smCustom -- notifyAttributes is its single representation', () => {
    const record = parseDiskSmartSettings('[diskA]\nsmEvents="5|1"\nsmCustom="1"\n', 'diskA');
    expect(record).not.toHaveProperty('smCustom');
    expect(record.notifyAttributes).toEqual([5, 1]);
  });

  it('echoes the section name back as diskId', () => {
    const id = 'Samsung_Flash_Drive_0374922050003774-0:0';
    expect(parseDiskSmartSettings(`[${id}]\nhotTemp="45"\n`, id).diskId).toBe(id);
  });
});

// fs/promises rejects with an Error carrying .code -- same shape here.
function errnoError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('readTextOrEmpty', () => {
  it('passes the read text through unchanged', async () => {
    await expect(readTextOrEmpty(async () => TWO_DISKS)).resolves.toBe(TWO_DISKS);
  });

  it('degrades to empty on ENOENT -- an absent file is the normal stock state', async () => {
    await expect(
      readTextOrEmpty(() => Promise.reject(errnoError('ENOENT'))),
    ).resolves.toBe('');
  });

  // Reading these as empty would report the disk unconfigured, and the next
  // write would pin defaults over a file we merely failed to read.
  it.each(['EACCES', 'EIO', 'EPERM', 'EISDIR'])(
    'propagates %s instead of masking it as "no settings"',
    async (code) => {
      await expect(readTextOrEmpty(() => Promise.reject(errnoError(code)))).rejects.toThrow(code);
    },
  );

  it('propagates an error that carries no errno at all', async () => {
    await expect(readTextOrEmpty(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });
});

describe('createSmartConfigClient', () => {
  const MISSING = '/nonexistent-u-manager-companion-dir/smart-one.cfg';

  it('builds a client exposing the full contract', () => {
    const client = createSmartConfigClient(MISSING);

    expect(typeof client.readText).toBe('function');
    expect(typeof client.writeText).toBe('function');
    expect(typeof client.deleteFile).toBe('function');
  });

  // atomicWrite writes <dir>/.<rand>.tmp then renames, so a missing directory
  // fails on the temp path -- that is what proves the routing.
  it('routes writeText through atomicWrite -- the temp file lands in the target directory', async () => {
    await expect(createSmartConfigClient(MISSING).writeText('x')).rejects.toThrow(/\.tmp/);
  });

  // rmSync(force:true), so a concurrent webGUI unlink is not a race.
  it('deleteFile is idempotent when the file is already gone', async () => {
    await expect(createSmartConfigClient(MISSING).deleteFile()).resolves.toBeUndefined();
  });
});

const CLEARED: DiskSmartSettingsInput = {
  hotTemp: null,
  maxTemp: null,
  smSelect: null,
  smLevel: null,
  notifyAttributes: null,
};

function fileValues(input: Partial<DiskSmartSettingsInput> = {}) {
  return Object.fromEntries(toFileValues({ ...CLEARED, ...input }));
}

describe('toFileValues -- totality', () => {
  it('is TOTAL over every file key, so a cleared field always deletes its line', () => {
    expect(Object.keys(fileValues()).sort()).toEqual([...SMART_FILE_KEYS].sort());
  });

  it('maps an all-null input to all-null values', () => {
    expect(fileValues()).toEqual({
      hotTemp: null,
      maxTemp: null,
      smSelect: null,
      smLevel: null,
      smEvents: null,
      smCustom: null,
    });
  });
});

describe('toFileValues -- temperatures and raw passthrough', () => {
  it('writes temperatures verbatim, no unit conversion', () => {
    expect(fileValues({ hotTemp: 45, maxTemp: 55 })).toMatchObject({
      hotTemp: '45',
      maxTemp: '55',
    });
  });

  it('accepts an inverted temperature pair -- the webGUI has no such check', () => {
    expect(fileValues({ hotTemp: 60, maxTemp: 50 })).toMatchObject({
      hotTemp: '60',
      maxTemp: '50',
    });
  });

  it('passes an unknown smSelect through instead of rejecting it', () => {
    expect(fileValues({ smSelect: 7 })).toMatchObject({ smSelect: '7' });
  });

  it('writes smSelect 0 rather than treating it as unset', () => {
    expect(fileValues({ smSelect: 0 })).toMatchObject({ smSelect: '0' });
  });
});

describe('toFileValues -- smLevel byte format', () => {
  it('stores smLevel exactly 1 as an ABSENT key', () => {
    expect(fileValues({ smLevel: 1 })).toMatchObject({ smLevel: null });
  });

  it.each([
    // The webGUI renders smLevel through a <select> of 2-decimal strings, so
    // "1.5" would match no option and the form would fall back to the first.
    [1.5, '1.50'],
    [2, '2.00'],
    [1.25, '1.25'],
  ])('writes smLevel %s with two decimals as "%s"', (value, expected) => {
    expect(fileValues({ smLevel: value })).toMatchObject({ smLevel: expected });
  });
});

describe('toFileValues -- smEvents / smCustom', () => {
  it('stores the DEFAULT set as an absent key, exactly like the webGUI blanking it', () => {
    expect(fileValues({ notifyAttributes: [5, 187, 197, 198, 199] })).toMatchObject({
      smEvents: null,
      smCustom: null,
    });
  });

  it('joins a preselect subset with |', () => {
    expect(fileValues({ notifyAttributes: [5, 197] })).toMatchObject({
      smEvents: '5|197',
      smCustom: null,
    });
  });

  it('keeps 188 in smEvents but out of smCustom -- preselect yet default-off', () => {
    expect(fileValues({ notifyAttributes: [188, 1] })).toMatchObject({
      smEvents: '188|1',
      smCustom: '1',
    });
  });

  it('orders preselect codes in PRESELECT order regardless of input order', () => {
    expect(fileValues({ notifyAttributes: [199, 5, 187] })).toMatchObject({
      smEvents: '5|187|199',
    });
  });

  it('puts non-preselect codes after the preselect ones, in input order', () => {
    expect(fileValues({ notifyAttributes: [3, 5, 1] })).toMatchObject({
      smEvents: '5|3|1',
      smCustom: '3,1',
    });
  });

  it('de-duplicates repeated codes', () => {
    expect(fileValues({ notifyAttributes: [5, 5, 197, 197] })).toMatchObject({
      smEvents: '5|197',
    });
  });

  it('deletes smCustom when the non-preselect subset is empty', () => {
    expect(fileValues({ notifyAttributes: [5, 187] })).toMatchObject({
      smEvents: '5|187',
      smCustom: null,
    });
  });

  it('clears smEvents AND smCustom together, never leaving a stale smCustom', () => {
    expect(fileValues({ notifyAttributes: null })).toMatchObject({
      smEvents: null,
      smCustom: null,
    });
  });

  it('treats an empty list as a blank, defensively -- validation rejects it first', () => {
    expect(fileValues({ notifyAttributes: [] })).toMatchObject({
      smEvents: null,
      smCustom: null,
    });
  });
});

describe('patchDiskSmartSettings / removeDiskSmartSection', () => {
  const RICH = '# keep\n[diskA]\nhotTemp="45"\nsmType="sat"\n[diskB]\nhotTemp="40"\n';

  it('writes only the modeled keys, leaving comments, unmodeled keys and siblings intact', () => {
    const result = patchDiskSmartSettings(RICH, 'diskA', { ...CLEARED, hotTemp: 50 });

    expect(result).toBe('# keep\n[diskA]\nhotTemp="50"\nsmType="sat"\n[diskB]\nhotTemp="40"\n');
  });

  it('creates the section on demand when the file is empty', () => {
    const result = patchDiskSmartSettings('', 'diskA', {
      ...CLEARED,
      hotTemp: 45,
      notifyAttributes: [5, 197],
    });

    expect(result).toBe('[diskA]\nhotTemp="45"\nsmEvents="5|197"\n');
  });

  it('round-trips through the parser', () => {
    const written = patchDiskSmartSettings('', 'diskA', {
      hotTemp: 45,
      maxTemp: 55,
      smSelect: 7,
      smLevel: 1.5,
      notifyAttributes: [5, 197],
    });

    expect(parseDiskSmartSettings(written, 'diskA')).toMatchObject({
      configured: true,
      hotTemp: 45,
      maxTemp: 55,
      smSelect: 7,
      smLevel: 1.5,
      notifyAttributes: [5, 197],
    });
  });

  it('destroys the whole section including unmodeled keys', () => {
    const result = removeDiskSmartSection(RICH, 'diskA');

    expect(result).toBe('# keep\n[diskB]\nhotTemp="40"\n');
    expect(parseDiskSmartSettings(result, 'diskA').configured).toBe(false);
  });
});

describe('parseAllDiskSmartSettings', () => {
  it('is an empty list for an absent file -- the normal state, not an error', () => {
    expect(parseAllDiskSmartSettings('')).toEqual([]);
  });

  it('is an empty list when the file holds no section at all', () => {
    expect(parseAllDiskSmartSettings('# nothing configured yet\n')).toEqual([]);
  });

  it('returns one record per section, in file order', () => {
    const records = parseAllDiskSmartSettings(TWO_DISKS);
    expect(records.map((record) => record.diskId)).toEqual(['diskA', 'diskB']);
  });

  it('parses each section exactly as the single-disk read does', () => {
    const records = parseAllDiskSmartSettings(TWO_DISKS);
    expect(records[0]).toEqual(parseDiskSmartSettings(TWO_DISKS, 'diskA'));
    expect(records[1]).toEqual(parseDiskSmartSettings(TWO_DISKS, 'diskB'));
  });

  it('leaves a disk with no section OUT of the list rather than in it with nulls', () => {
    const ids = parseAllDiskSmartSettings(TWO_DISKS).map((record) => record.diskId);
    expect(ids).not.toContain('diskC');
  });

  it('reports every returned record as configured -- presence is the definition', () => {
    for (const record of parseAllDiskSmartSettings(TWO_DISKS)) {
      expect(record.configured).toBe(true);
    }
  });

  it('includes a section holding only unmodeled controller keys', () => {
    const text = '[diskA]\nsmType="sat"\nsmPort1="0"\n';
    const records = parseAllDiskSmartSettings(text);
    expect(records).toHaveLength(1);
    expect(records[0]!.configured).toBe(true);
    expect(records[0]!.hotTemp).toBeNull();
    expect(records[0]!.maxTemp).toBeNull();
  });

  it('skips a nameless [] header: resolveDiskSectionId could never address it', () => {
    const records = parseAllDiskSmartSettings('[]\nhotTemp="45"\n[diskA]\nhotTemp="40"\n');
    expect(records.map((record) => record.diskId)).toEqual(['diskA']);
  });

  it('keeps a colon-bearing flash id intact', () => {
    const flash = 'Samsung_Flash_Drive_0374922050003774-0:0';
    const records = parseAllDiskSmartSettings(`[${flash}]\nhotTemp="45"\n`);
    expect(records.map((record) => record.diskId)).toEqual([flash]);
    expect(records[0]!.hotTemp).toBe(45);
  });

  it('serves both attribute lists on every record', () => {
    for (const record of parseAllDiskSmartSettings(TWO_DISKS)) {
      expect([...record.defaultNotifyAttributes]).toEqual([...DEFAULT_NOTIFY_ATTRIBUTES]);
      expect([...record.preselectAttributes]).toEqual([...PRESELECT_ATTRIBUTES]);
    }
  });
});

describe('preselectAttributes on a record', () => {
  it('is served even for an unconfigured disk, so the form can draw its rows', () => {
    const record = parseDiskSmartSettings('', 'diskA');
    expect(record.configured).toBe(false);
    expect([...record.preselectAttributes]).toEqual([5, 187, 188, 197, 198, 199]);
  });

  it('is NOT the default set: 188 is a checkbox that starts unticked', () => {
    const record = parseDiskSmartSettings('', 'diskA');
    expect(record.preselectAttributes).toContain(188);
    expect(record.defaultNotifyAttributes).not.toContain(188);
  });
});
