import { describe, expect, it } from 'vitest';
import {
  hasAnySection,
  indexSections,
  listSectionNames,
  patchSection,
  readSectionValues,
  removeSection,
} from '../ini.js';

describe('indexSections', () => {
  it('returns no spans for content that holds no header', () => {
    expect(indexSections([])).toEqual([]);
    expect(indexSections(['# just a comment\n', '\n'])).toEqual([]);
  });

  it('spans a single section to the end of the file', () => {
    const lines = ['[diskA]\n', 'hotTemp="45"\n', 'maxTemp="55"\n'];
    expect(indexSections(lines)).toEqual([{ name: 'diskA', headerIndex: 0, endIndex: 3 }]);
  });

  it('ends a span at the next header and runs the last one to lines.length', () => {
    const lines = ['[diskA]\n', 'hotTemp="45"\n', '[diskB]\n', 'maxTemp="55"\n'];
    expect(indexSections(lines)).toEqual([
      { name: 'diskA', headerIndex: 0, endIndex: 2 },
      { name: 'diskB', headerIndex: 2, endIndex: 4 },
    ]);
  });

  it('excludes leading comments from every span', () => {
    const lines = ['# header comment\n', '\n', '[diskA]\n', 'hotTemp="45"\n'];
    expect(indexSections(lines)).toEqual([{ name: 'diskA', headerIndex: 2, endIndex: 4 }]);
  });

  it('preserves the header case verbatim -- names are NOT folded', () => {
    expect(indexSections(['[DiskA]\n'])[0]!.name).toBe('DiskA');
  });

  it('trims indent and trailing space around the header but keeps the name intact', () => {
    expect(indexSections(['  [diskA]  \n'])[0]!.name).toBe('diskA');
  });

  it('accepts a colon-bearing section name (real ids look like ..._0374922050003774-0:0)', () => {
    const lines = ['[Samsung_Flash_Drive_0374922050003774-0:0]\n', 'hotTemp="45"\n'];
    expect(indexSections(lines)).toEqual([
      { name: 'Samsung_Flash_Drive_0374922050003774-0:0', headerIndex: 0, endIndex: 2 },
    ]);
  });

  it('handles a final line with no terminator', () => {
    expect(indexSections(['[diskA]\n', 'hotTemp="45"'])).toEqual([
      { name: 'diskA', headerIndex: 0, endIndex: 2 },
    ]);
  });

  it('handles CRLF terminators', () => {
    expect(indexSections(['[diskA]\r\n', 'hotTemp="45"\r\n'])).toEqual([
      { name: 'diskA', headerIndex: 0, endIndex: 2 },
    ]);
  });
});

describe('hasAnySection', () => {
  it('is false for empty content', () => {
    expect(hasAnySection('')).toBe(false);
  });

  it('is false for comments and blank lines only', () => {
    expect(hasAnySection('# a comment\n\n; another\n')).toBe(false);
  });

  it('is true for one section', () => {
    expect(hasAnySection('[diskA]\nhotTemp="45"\n')).toBe(true);
  });

  it('is true for two sections', () => {
    expect(hasAnySection('[diskA]\n[diskB]\n')).toBe(true);
  });

  it('is true for an empty section header with no keys', () => {
    expect(hasAnySection('[diskA]\n')).toBe(true);
  });
});

describe('readSectionValues', () => {
  const TWO_DISKS =
    '[diskA]\nhotTemp="45"\nmaxTemp="55"\n[diskB]\nhotTemp="40"\n';

  it('returns null when the section does not exist -- never an empty map', () => {
    expect(readSectionValues(TWO_DISKS, 'diskC')).toBeNull();
    expect(readSectionValues('', 'diskA')).toBeNull();
  });

  it('returns only the target section keys, unquoted and trimmed', () => {
    const values = readSectionValues(TWO_DISKS, 'diskA');
    expect(values).not.toBeNull();
    expect([...values!.entries()]).toEqual([
      ['hotTemp', '45'],
      ['maxTemp', '55'],
    ]);
  });

  it('does not leak a same-named key from another section', () => {
    expect(readSectionValues(TWO_DISKS, 'diskB')!.get('hotTemp')).toBe('40');
    expect(readSectionValues(TWO_DISKS, 'diskB')!.has('maxTemp')).toBe(false);
  });

  it('takes the LAST occurrence of a duplicated key, matching PHP ini readers', () => {
    const text = '[diskA]\nhotTemp="45"\nhotTemp="48"\n';
    expect(readSectionValues(text, 'diskA')!.get('hotTemp')).toBe('48');
  });

  it('matches the section name CASE-SENSITIVELY', () => {
    const text = '[abc]\nhotTemp="45"\n';
    expect(readSectionValues(text, 'abc')).not.toBeNull();
    expect(readSectionValues(text, 'ABC')).toBeNull();
  });

  it('resolves a colon-bearing section name', () => {
    const id = 'Samsung_Flash_Drive_0374922050003774-0:0';
    const text = `[${id}]\nhotTemp="45"\n`;
    expect(readSectionValues(text, id)!.get('hotTemp')).toBe('45');
  });

  it('tolerates indent, bare values, single quotes and loose = spacing', () => {
    const text = "[diskA]\n  hotTemp = 45 \nmaxTemp='55'\nsmLevel=1.50\n";
    expect([...readSectionValues(text, 'diskA')!.entries()]).toEqual([
      ['hotTemp', '45'],
      ['maxTemp', '55'],
      ['smLevel', '1.50'],
    ]);
  });

  it('ignores comments and blank lines inside the section', () => {
    const text = '[diskA]\n# a comment\n\nhotTemp="45"\n';
    expect([...readSectionValues(text, 'diskA')!.entries()]).toEqual([['hotTemp', '45']]);
  });

  it('returns an empty map for a section header with no keys', () => {
    expect(readSectionValues('[diskA]\n', 'diskA')!.size).toBe(0);
  });

  it('reads unmodeled controller keys too -- ini.ts is key-agnostic', () => {
    const text = '[diskA]\nsmType="sat"\nsmPort1="0"\n';
    expect([...readSectionValues(text, 'diskA')!.keys()]).toEqual(['smType', 'smPort1']);
  });
});

// Deliberately awkward: a comment, a blank line, single quotes, loose = spacing,
// indent, a trailing space, an unmodeled key and a neighbour section. Do not tidy
// it up -- each oddity is what one of the preservation assertions below pins.
const RICH =
  '# smart-one.cfg\n' +
  '\n' +
  '[diskA]\n' +
  "  hotTemp = '45' \n" +
  'smType="sat"\n' +
  'maxTemp="55"\n' +
  '\n' +
  '[diskB]\n' +
  'hotTemp="40"\n';

describe('patchSection -- rewriting in place', () => {
  it('preserves indent, = spacing, quote style and the trailing space', () => {
    const result = patchSection(RICH, 'diskA', new Map([['hotTemp', '48']]));

    expect(result).toBe(RICH.replace("  hotTemp = '45' \n", "  hotTemp = '48' \n"));
  });

  it('leaves an unmodeled key and the neighbour section byte-identical', () => {
    const result = patchSection(RICH, 'diskA', new Map([['hotTemp', '48']]));

    expect(result).toContain('smType="sat"\n');
    expect(result).toContain('[diskB]\nhotTemp="40"\n');
    expect(result).toContain('# smart-one.cfg\n\n');
  });

  it('rewrites EVERY occurrence of a listed key -- readers are last-wins', () => {
    const text = '[diskA]\nhotTemp="45"\nsmType="sat"\nhotTemp="46"\n';

    expect(patchSection(text, 'diskA', new Map([['hotTemp', '48']]))).toBe(
      '[diskA]\nhotTemp="48"\nsmType="sat"\nhotTemp="48"\n',
    );
  });

  it('does not touch a same-named key in another section', () => {
    const result = patchSection(RICH, 'diskB', new Map([['hotTemp', '41']]));

    expect(result).toContain("  hotTemp = '45' \n");
    expect(result).toContain('[diskB]\nhotTemp="41"\n');
  });

  it('preserves a per-line CRLF terminator when rewriting', () => {
    const text = '[diskA]\r\nhotTemp="45"\r\nmaxTemp="55"\n';

    expect(patchSection(text, 'diskA', new Map([['hotTemp', '48']]))).toBe(
      '[diskA]\r\nhotTemp="48"\r\nmaxTemp="55"\n',
    );
  });

  it('is a no-op for an empty value map', () => {
    expect(patchSection(RICH, 'diskA', new Map())).toBe(RICH);
  });
});

describe('patchSection -- clearing a key', () => {
  it('DELETES the line rather than zeroing the value', () => {
    const result = patchSection(RICH, 'diskA', new Map([['maxTemp', null]]));

    expect(result).toBe(RICH.replace('maxTemp="55"\n', ''));
    expect(result).not.toContain('maxTemp');
  });

  it('deletes every occurrence of a duplicated key', () => {
    const text = '[diskA]\nhotTemp="45"\nhotTemp="46"\n';

    expect(patchSection(text, 'diskA', new Map([['hotTemp', null]]))).toBe('[diskA]\n');
  });

  it('ignores a null for a key that is already absent', () => {
    expect(patchSection(RICH, 'diskA', new Map([['smLevel', null]]))).toBe(RICH);
  });
});

describe('patchSection -- appending a missing key', () => {
  it('inserts after the last NON-BLANK line of the span, not after the blank separator', () => {
    const result = patchSection(RICH, 'diskA', new Map([['smLevel', '1.50']]));

    expect(result).toBe(RICH.replace('maxTemp="55"\n\n', 'maxTemp="55"\nsmLevel="1.50"\n\n'));
  });

  it('recomputes bounds so a delete plus an append land correctly together', () => {
    const result = patchSection(
      RICH,
      'diskA',
      new Map([
        ['hotTemp', null],
        ['smLevel', '1.50'],
      ]),
    );

    expect(result).toBe(
      '# smart-one.cfg\n' +
        '\n' +
        '[diskA]\n' +
        'smType="sat"\n' +
        'maxTemp="55"\n' +
        'smLevel="1.50"\n' +
        '\n' +
        '[diskB]\n' +
        'hotTemp="40"\n',
    );
  });

  it('appends into a section that runs to EOF', () => {
    const text = '[diskA]\nhotTemp="45"\n';

    expect(patchSection(text, 'diskA', new Map([['maxTemp', '55']]))).toBe(
      '[diskA]\nhotTemp="45"\nmaxTemp="55"\n',
    );
  });

  it('uses the dominant terminator for an appended line', () => {
    const text = '[diskA]\r\nhotTemp="45"\r\n';

    expect(patchSection(text, 'diskA', new Map([['maxTemp', '55']]))).toBe(
      '[diskA]\r\nhotTemp="45"\r\nmaxTemp="55"\r\n',
    );
  });

  it('appends into a keyless section header', () => {
    expect(patchSection('[diskA]\n', 'diskA', new Map([['hotTemp', '45']]))).toBe(
      '[diskA]\nhotTemp="45"\n',
    );
  });
});

describe('patchSection -- creating a section', () => {
  it('appends a new section at EOF', () => {
    const result = patchSection(RICH, 'diskC', new Map([['hotTemp', '50']]));

    expect(result).toBe(`${RICH}[diskC]\nhotTemp="50"\n`);
  });

  it('omits null keys from a freshly created section', () => {
    const result = patchSection(
      RICH,
      'diskC',
      new Map([
        ['hotTemp', '50'],
        ['maxTemp', null],
      ]),
    );

    expect(result).toBe(`${RICH}[diskC]\nhotTemp="50"\n`);
  });

  it('creates the first section in an empty file with no leading blank line', () => {
    expect(patchSection('', 'diskA', new Map([['hotTemp', '45']]))).toBe(
      '[diskA]\nhotTemp="45"\n',
    );
  });

  it('adds a missing trailing terminator before appending', () => {
    expect(patchSection('[diskA]\nhotTemp="45"', 'diskB', new Map([['hotTemp', '40']]))).toBe(
      '[diskA]\nhotTemp="45"\n[diskB]\nhotTemp="40"\n',
    );
  });

  it('returns the text UNCHANGED when the section is absent and every value is null', () => {
    const values = new Map([
      ['hotTemp', null],
      ['maxTemp', null],
      ['smEvents', null],
    ]);

    // An absent section with nothing to write must not leave an empty header behind.
    expect(patchSection(RICH, 'diskZ', values)).toBe(RICH);
    expect(patchSection('', 'diskZ', values)).toBe('');
  });
});

describe('removeSection', () => {
  it('removes the header, its keys AND the trailing blank line inside its span', () => {
    expect(removeSection(RICH, 'diskA')).toBe('# smart-one.cfg\n\n[diskB]\nhotTemp="40"\n');
  });

  it('removes the last section leaving everything before it byte-identical', () => {
    expect(removeSection(RICH, 'diskB')).toBe(
      '# smart-one.cfg\n' +
        '\n' +
        '[diskA]\n' +
        "  hotTemp = '45' \n" +
        'smType="sat"\n' +
        'maxTemp="55"\n' +
        '\n',
    );
  });

  it('takes unmodeled controller keys with the section', () => {
    const result = removeSection(RICH, 'diskA');

    expect(result).not.toContain('smType');
    expect(result).not.toContain('hotTemp = ');
  });

  it('leaves the text unchanged when the section is absent', () => {
    expect(removeSection(RICH, 'diskZ')).toBe(RICH);
    expect(removeSection('', 'diskA')).toBe('');
  });

  it('empties a file that held only that section', () => {
    expect(removeSection('[diskA]\nhotTemp="45"\n', 'diskA')).toBe('');
  });

  it('keeps leading comments when the only section goes', () => {
    const result = removeSection('# keep me\n[diskA]\nhotTemp="45"\n', 'diskA');

    expect(result).toBe('# keep me\n');
    expect(hasAnySection(result)).toBe(false);
  });

  it('matches the section name case-sensitively', () => {
    expect(removeSection('[abc]\nhotTemp="45"\n', 'ABC')).toBe('[abc]\nhotTemp="45"\n');
  });

  it('preserves CRLF terminators in the surviving section', () => {
    const text = '[diskA]\r\nhotTemp="45"\r\n[diskB]\r\nhotTemp="40"\r\n';

    expect(removeSection(text, 'diskA')).toBe('[diskB]\r\nhotTemp="40"\r\n');
  });
});

describe('listSectionNames', () => {
  it('is empty for an absent file and for content with no header', () => {
    expect(listSectionNames('')).toEqual([]);
    expect(listSectionNames('# a comment\n\nstray="value"\n')).toEqual([]);
  });

  it('returns every name in FILE order, not sorted', () => {
    const text = '[diskZ]\nhotTemp="45"\n[diskA]\nhotTemp="40"\n[diskM]\n';
    expect(listSectionNames(text)).toEqual(['diskZ', 'diskA', 'diskM']);
  });

  it('keeps names verbatim: case, colons and the trailing -0:0 of a flash id', () => {
    const flash = 'Samsung_Flash_Drive_0374922050003774-0:0';
    const text = `[${flash}]\nhotTemp="45"\n[WDC_WD80EFZZ-68B1VN0_VGKW1TRT]\n`;
    expect(listSectionNames(text)).toEqual([flash, 'WDC_WD80EFZZ-68B1VN0_VGKW1TRT']);
  });

  it('de-duplicates a repeated header, first-wins like readSectionValues', () => {
    const text = '[diskA]\nhotTemp="45"\n[diskB]\n[diskA]\nhotTemp="99"\n';
    expect(listSectionNames(text)).toEqual(['diskA', 'diskB']);
  });

  it('reports a keyless section -- presence is what configured means', () => {
    expect(listSectionNames('[diskA]\n')).toEqual(['diskA']);
  });

  it('reports a nameless [] header verbatim, leaving the filtering to platform', () => {
    expect(listSectionNames('[]\nhotTemp="45"\n[diskA]\n')).toEqual(['', 'diskA']);
  });

  it('handles CRLF and indented headers', () => {
    expect(listSectionNames('[diskA]\r\nhotTemp="45"\r\n  [diskB]\r\n')).toEqual([
      'diskA',
      'diskB',
    ]);
  });
});
