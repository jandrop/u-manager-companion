/**
 * audit.ts tests.
 *
 * TDD: written before audit.ts exists -> RED first.
 *
 * Pins: JSON-lines record shape {action, caller, timestamp, target, outcome},
 * rotating file writes under an injectable run-dir (never the real
 * filesystem in tests), and an optional syslog mirror that is injectable so
 * tests never actually shell out to `logger`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuditLogger } from '../audit.js';

describe('recordAuditEvent', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'companion-audit-'));
    logPath = join(dir, 'audit.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends a JSON-lines record with the expected shape', () => {
    const audit = createAuditLogger({ logPath });

    audit.recordAuditEvent({
      action: 'docker.templateInstall',
      caller: { id: 'abc-123', name: 'admin-key' },
      target: 'plex',
      outcome: 'initiated',
    });

    const raw = readFileSync(logPath, 'utf8').trim();
    const record: unknown = JSON.parse(raw);
    expect(record).toMatchObject({
      action: 'docker.templateInstall',
      caller: { id: 'abc-123', name: 'admin-key' },
      target: 'plex',
      outcome: 'initiated',
    });
    expect(record).toHaveProperty('timestamp');
    expect(typeof (record as { timestamp: unknown }).timestamp).toBe('string');
    // ISO 8601.
    expect(new Date((record as { timestamp: string }).timestamp).toString()).not.toBe('Invalid Date');
  });

  it('appends multiple records as separate lines (JSON-lines, not a JSON array)', () => {
    const audit = createAuditLogger({ logPath });

    audit.recordAuditEvent({
      action: 'power.reboot',
      caller: { id: 'a', name: 'a' },
      outcome: 'initiated',
    });
    audit.recordAuditEvent({
      action: 'plugins.uninstall',
      caller: { id: 'b', name: 'b' },
      target: 'some.plg',
      outcome: 'initiated',
    });

    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(() => JSON.parse(lines[0] ?? '')).not.toThrow();
    expect(() => JSON.parse(lines[1] ?? '')).not.toThrow();
  });

  it('omits target when not provided (e.g. power actions)', () => {
    const audit = createAuditLogger({ logPath });

    audit.recordAuditEvent({
      action: 'power.shutdown',
      caller: { id: 'a', name: 'a' },
      outcome: 'initiated',
    });

    const record: unknown = JSON.parse(readFileSync(logPath, 'utf8').trim());
    expect(record).not.toHaveProperty('target');
  });

  it('creates the run-dir if it does not already exist', () => {
    const nestedLogPath = join(dir, 'nested', 'run', 'audit.log');
    const audit = createAuditLogger({ logPath: nestedLogPath });

    audit.recordAuditEvent({
      action: 'power.reboot',
      caller: { id: 'a', name: 'a' },
      outcome: 'initiated',
    });

    expect(existsSync(nestedLogPath)).toBe(true);
  });

  it('mirrors to syslog via the injected mirror function when provided', () => {
    const syslogMirror = vi.fn();
    const audit = createAuditLogger({ logPath, syslogMirror });

    audit.recordAuditEvent({
      action: 'power.reboot',
      caller: { id: 'a', name: 'a' },
      outcome: 'initiated',
    });

    expect(syslogMirror).toHaveBeenCalledTimes(1);
    expect(syslogMirror).toHaveBeenCalledWith(expect.stringContaining('power.reboot'));
  });

  it('does not throw when the syslog mirror throws (best-effort only)', () => {
    const syslogMirror = vi.fn(() => {
      throw new Error('logger command not found');
    });
    const audit = createAuditLogger({ logPath, syslogMirror });

    expect(() =>
      audit.recordAuditEvent({
        action: 'power.reboot',
        caller: { id: 'a', name: 'a' },
        outcome: 'initiated',
      }),
    ).not.toThrow();
    // The file write must still have happened despite the mirror failing.
    expect(readFileSync(logPath, 'utf8').trim().length).toBeGreaterThan(0);
  });

  it('rotates the log file once it exceeds the configured size budget', () => {
    const audit = createAuditLogger({ logPath, maxBytes: 200 });

    for (let i = 0; i < 20; i += 1) {
      audit.recordAuditEvent({
        action: 'docker.templateInstall',
        caller: { id: `caller-${i}`, name: `name-${i}` },
        target: `container-${i}`,
        outcome: 'initiated',
      });
    }

    // A rotated file must exist alongside the active log.
    expect(existsSync(`${logPath}.1`)).toBe(true);
    // The active log must still be parseable JSON-lines (rotation never
    // drops or corrupts an in-flight write).
    const activeLines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of activeLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('caps retained rotated files at the configured limit', () => {
    const audit = createAuditLogger({ logPath, maxBytes: 100, maxRotatedFiles: 2 });

    for (let i = 0; i < 60; i += 1) {
      audit.recordAuditEvent({
        action: 'docker.templateInstall',
        caller: { id: `caller-${i}`, name: `name-${i}` },
        target: `container-${i}`,
        outcome: 'initiated',
      });
    }

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(`${logPath}.2`)).toBe(true);
    expect(existsSync(`${logPath}.3`)).toBe(false);
  });
});
