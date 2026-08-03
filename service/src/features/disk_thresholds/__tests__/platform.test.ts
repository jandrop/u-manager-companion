/**
 * features/disk_thresholds/platform.ts tests.
 *
 * TDD: written before platform.ts exists -> RED first.
 *
 * Covers the pure parse/patch algorithm against dynamix.cfg's [display]
 * section. DYNAMIX_CFG_FIXTURE below is pinned byte-for-byte from a live
 * box (root@192.168.1.132, /boot/config/plugins/dynamix/dynamix.cfg,
 * captured 2026-08-03) -- LF-only line endings, font="68.75" sitting
 * between max and hotssd, [parity] following [display] with no
 * blank-line separator, and a stray `warning="5"` inside [notify] that
 * must never leak into the [display]-scoped read. Everything here is
 * pure string-in/string-out (no IO), so this suite never touches a real
 * filesystem.
 */
import { describe, expect, it } from 'vitest';
import { parseDiskThresholds, patchDiskThresholds } from '../platform.js';

// Pinned byte-for-byte from the live box. Do not "clean up" this fixture
// -- its exact shape (key order, font in the middle, no blank-line
// separators between sections, the [notify] warning collision) is the
// point.
const DYNAMIX_CFG_FIXTURE = `[display]
date="%c"
number=".,"
scale="-1"
tabs="1"
users="Tasks:3"
resize="0"
wwn="0"
total="1"
usage="1"
dashapps="icons"
theme="black"
text="2"
unit="C"
tty="15"
headerdescription="yes"
showBannerGradient="yes"
header="ffffff"
headermetacolor="ffffff"
background="000000"
banner="image"
sysinfo="/Tools/SystemProfiler"
warning="80"
critical="90"
hot="45"
max="55"
font="68.75"
hotssd="60"
maxssd="70"
sleep="plugins/dynamix.s3.sleep/Sleep.php"
favorites="yes"
liveUpdate="yes"
terminalButton="yes"
power="1"
[parity]
mode="3"
day="0"
hour="0 0"
dotm="1"
frequency="1"
duration="9"
[notify]
entity="1"
normal="5"
warning="5"
alert="5"
unraid="5"
plugin="5"
docker_notify="5"
report="5"
display="0"
date="d-m-Y"
time="H:i"
position="top-right"
path="/boot/config/plugins/dynamix/notifications"
system="*/1 * * * *"
unraidos="11 0 * * *"
version="10 0 * * *"
docker_update="10 0 * * *"
status="20 0 * * *"
language_notify="1"
life="5"
[ssd]
hour="0"
mode="2"
min="0"
[scrub_cache]
hour="9"
mode="4"
dotm="15"
min="0"
day="0"
[scrub_disk1]
hour="2"
mode="0"
day="5"
min="0"
dotm="3"
[scrub_disk2]
hour="2"
mode="0"
day="5"
min="0"
dotm="3"
[scrub_disk8]
hour="2"
mode="0"
dotm="3"
min="0"
[balance_cache]
hour="4"
mode="4"
dotm="2"
min="0"
[scrub_disk3]
hour="0"
mode="0"
dotm="2"
min="0"
[scrub_disk4]
hour="2"
mode="4"
dotm="3"
min="0"
[scrub_disk5]
hour="2"
mode="0"
dotm="3"
min="0"
[scrub_disk6]
hour="2"
mode="0"
dotm="3"
min="0"
[scrub_disk7]
hour="2"
mode="0"
dotm="3"
min="0"
[confirm]
sleep="1"
`;

describe('parseDiskThresholds', () => {
  it('parses all six values from the live fixture, scoped to [display]', () => {
    const result = parseDiskThresholds(DYNAMIX_CFG_FIXTURE);
    expect(result).toEqual({
      warning: 80,
      critical: 90,
      hot: 45,
      max: 55,
      hotssd: 60,
      maxssd: 70,
    });
  });

  it('never leaks a same-named key from a different section ([notify].warning="5")', () => {
    const result = parseDiskThresholds(DYNAMIX_CFG_FIXTURE);
    expect(result.warning).toBe(80);
  });

  it('ignores non-target keys inside [display] (font sits between max and hotssd)', () => {
    const result = parseDiskThresholds(DYNAMIX_CFG_FIXTURE);
    expect(result).not.toHaveProperty('font');
  });

  it('returns null for a key missing from [display]', () => {
    const withoutHotssd = DYNAMIX_CFG_FIXTURE.replace('hotssd="60"\n', '');
    const result = parseDiskThresholds(withoutHotssd);
    expect(result.hotssd).toBeNull();
    expect(result.warning).toBe(80);
  });

  it('returns null for a non-integer value (junk / decimal)', () => {
    const withDecimalHot = DYNAMIX_CFG_FIXTURE.replace('hot="45"', 'hot="45.5"');
    const withJunkMax = DYNAMIX_CFG_FIXTURE.replace('max="55"', 'max="not-a-number"');
    expect(parseDiskThresholds(withDecimalHot).hot).toBeNull();
    expect(parseDiskThresholds(withJunkMax).max).toBeNull();
  });

  it('returns null for every key when [display] is entirely absent', () => {
    const noDisplay = '[parity]\nmode="3"\n';
    expect(parseDiskThresholds(noDisplay)).toEqual({
      warning: null,
      critical: null,
      hot: null,
      max: null,
      hotssd: null,
      maxssd: null,
    });
  });

  it('parses an unquoted value the same as a quoted one', () => {
    const ini = '[display]\nwarning=80\ncritical="90"\n[parity]\n';
    const result = parseDiskThresholds(ini);
    expect(result.warning).toBe(80);
    expect(result.critical).toBe(90);
  });
});

describe('patchDiskThresholds', () => {
  const NEW_VALUES = { warning: 75, critical: 85, hot: 40, max: 50, hotssd: 55, maxssd: 65 };

  it('changes exactly the six display values; every other byte is identical', () => {
    const result = patchDiskThresholds(DYNAMIX_CFG_FIXTURE, NEW_VALUES);

    const expected = DYNAMIX_CFG_FIXTURE.replace('warning="80"', 'warning="75"')
      .replace('critical="90"', 'critical="85"')
      .replace('hot="45"', 'hot="40"')
      .replace('max="55"', 'max="50"')
      .replace('hotssd="60"', 'hotssd="55"')
      .replace('maxssd="70"', 'maxssd="65"');

    expect(result).toBe(expected);
  });

  it('the patched text re-parses to exactly the submitted values', () => {
    const result = patchDiskThresholds(DYNAMIX_CFG_FIXTURE, NEW_VALUES);
    expect(parseDiskThresholds(result)).toEqual(NEW_VALUES);
  });

  it('never touches [parity] or any other section', () => {
    const result = patchDiskThresholds(DYNAMIX_CFG_FIXTURE, NEW_VALUES);
    expect(result).toContain('[parity]\nmode="3"\nday="0"\nhour="0 0"\n');
    expect(result).toContain('warning="5"'); // [notify]'s own warning key, untouched
  });

  it('preserves quoting style per key (double, single, bare)', () => {
    const ini = '[display]\nwarning=80\ncritical=\'90\'\nhot="45"\nmax="55"\nhotssd="60"\nmaxssd="70"\n[parity]\n';
    const result = patchDiskThresholds(ini, {
      warning: 1,
      critical: 2,
      hot: 3,
      max: 4,
      hotssd: 5,
      maxssd: 6,
    });
    expect(result).toContain('warning=1\n');
    expect(result).toContain("critical='2'\n");
    expect(result).toContain('hot="3"\n');
  });

  it('preserves indentation, = spacing and the line terminator', () => {
    const ini = '[display]\n  warning = "80"\ncritical="90"\r\nhot="45"\nmax="55"\nhotssd="60"\nmaxssd="70"\n[parity]\n';
    const result = patchDiskThresholds(ini, NEW_VALUES);
    expect(result).toContain('  warning = "75"\n');
    expect(result).toContain('critical="85"\r\n');
  });

  it('appends a missing target key inside the [display] block, before a trailing blank line', () => {
    const withBlankLineAndMissingKey = DYNAMIX_CFG_FIXTURE.replace('maxssd="70"\n', '').replace(
      'power="1"\n[parity]',
      'power="1"\n\n[parity]',
    );

    const result = patchDiskThresholds(withBlankLineAndMissingKey, NEW_VALUES);

    expect(result).toContain('power="1"\nmaxssd="65"\n\n[parity]');
    expect(parseDiskThresholds(result).maxssd).toBe(65);
  });

  it('appends every missing target key when [display] has none of them', () => {
    const bare = '[display]\ndate="%c"\n[parity]\nmode="3"\n';
    const result = patchDiskThresholds(bare, NEW_VALUES);
    expect(parseDiskThresholds(result)).toEqual(NEW_VALUES);
    expect(result).toContain('[parity]\nmode="3"\n');
  });

  it('creates a [display] section at EOF when none exists', () => {
    const noDisplay = '[parity]\nmode="3"\n';
    const result = patchDiskThresholds(noDisplay, NEW_VALUES);
    expect(result.startsWith('[parity]\nmode="3"\n')).toBe(true);
    expect(result).toContain('[display]\n');
    expect(parseDiskThresholds(result)).toEqual(NEW_VALUES);
  });

  it('round-trips a minimal LF-only file byte-exact on a no-op edit', () => {
    const minimal =
      '[display]\nwarning="80"\ncritical="90"\nhot="45"\nmax="55"\nhotssd="60"\nmaxssd="70"\n';
    const result = patchDiskThresholds(minimal, {
      warning: 80,
      critical: 90,
      hot: 45,
      max: 55,
      hotssd: 60,
      maxssd: 70,
    });
    expect(result).toBe(minimal);
  });

  it('is idempotent: re-applying the same values twice yields the same output', () => {
    const first = patchDiskThresholds(DYNAMIX_CFG_FIXTURE, NEW_VALUES);
    const second = patchDiskThresholds(first, NEW_VALUES);
    expect(second).toBe(first);
  });
});
