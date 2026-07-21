/**
 * capabilities resolver returns
 * { schemaVersion, serviceVersion, features }.
 *
 * TDD: written before health.ts exists -> RED first.
 */
import { describe, expect, it } from 'vitest';
import { getCapabilities } from '../health.js';
import { SCHEMA_VERSION, CAPABILITY_KEYS } from '../schema/version.js';

describe('getCapabilities', () => {
  it('returns the current SCHEMA_VERSION', () => {
    const capabilities = getCapabilities();
    expect(capabilities.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('returns a non-empty serviceVersion string', () => {
    const capabilities = getCapabilities();
    expect(typeof capabilities.serviceVersion).toBe('string');
    expect(capabilities.serviceVersion.length).toBeGreaterThan(0);
  });

  it('returns every declared capability key in features', () => {
    const capabilities = getCapabilities();
    expect([...capabilities.features].sort()).toEqual(
      [...CAPABILITY_KEYS].sort(),
    );
  });

  it('features is a plain string array (GraphQL [String!]! shape)', () => {
    const capabilities = getCapabilities();
    expect(Array.isArray(capabilities.features)).toBe(true);
    for (const feature of capabilities.features) {
      expect(typeof feature).toBe('string');
    }
  });
});
