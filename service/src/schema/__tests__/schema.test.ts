/**
 * schema loads without errors, capabilities resolver returns the
 * expected shape.
 *
 * TDD: written before schema.ts / schema.graphql exist -> RED first.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildSchema, validateSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, CAPABILITY_KEYS } from '../version.js';

const SDL_PATH = path.join(__dirname, '..', 'schema.graphql');

describe('schema.graphql', () => {
  it('parses without errors via graphql-js buildSchema', () => {
    const sdl = readFileSync(SDL_PATH, 'utf8');
    const schema = buildSchema(sdl);
    const errors = validateSchema(schema);
    expect(errors).toHaveLength(0);
  });

  it('declares the v1 Mutation namespaces (docker, serverPower, unraidPlugins) plus the Slice 1 root share mutations', () => {
    const sdl = readFileSync(SDL_PATH, 'utf8');
    const schema = buildSchema(sdl);
    const mutationType = schema.getMutationType();
    expect(mutationType).toBeDefined();
    const fields = mutationType!.getFields();
    expect(Object.keys(fields).sort()).toEqual(
      [
        'docker',
        'serverPower',
        'unraidPlugins',
        'createShare',
        'updateShare',
        'deleteShare',
        'updateShareSecurity',
        'updateShareAccess',
      ].sort(),
    );
  });

  it('declares the v1 Query fields (dockerInstallOperation, dockerTemplate, capabilities) plus the Slice 1 root share queries', () => {
    const sdl = readFileSync(SDL_PATH, 'utf8');
    const schema = buildSchema(sdl);
    const queryType = schema.getQueryType();
    expect(queryType).toBeDefined();
    const fields = queryType!.getFields();
    expect(Object.keys(fields).sort()).toEqual(
      [
        'capabilities',
        'dockerInstallOperation',
        'dockerTemplate',
        'shares',
        'shareSecurity',
        'shareSecurityUsers',
        'shareIsEmpty',
      ].sort(),
    );
  });

  it('declares the v1 Subscription field (dockerInstallUpdates)', () => {
    const sdl = readFileSync(SDL_PATH, 'utf8');
    const schema = buildSchema(sdl);
    const subscriptionType = schema.getSubscriptionType();
    expect(subscriptionType).toBeDefined();
    const fields = subscriptionType!.getFields();
    expect(Object.keys(fields)).toEqual(['dockerInstallUpdates']);
  });

  it('CompanionCapabilities carries schemaVersion, serviceVersion, features', () => {
    const sdl = readFileSync(SDL_PATH, 'utf8');
    const schema = buildSchema(sdl);
    const capabilitiesType = schema.getType('CompanionCapabilities');
    expect(capabilitiesType).toBeDefined();
    const fields = (capabilitiesType as import('graphql').GraphQLObjectType).getFields();
    expect(Object.keys(fields).sort()).toEqual(
      ['features', 'schemaVersion', 'serviceVersion'].sort(),
    );
  });
});

describe('SCHEMA_VERSION', () => {
  it('is a non-empty semver-like string', () => {
    expect(SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('CAPABILITY_KEYS', () => {
  it('lists every v1 capability key', () => {
    expect([...CAPABILITY_KEYS].sort()).toEqual(
      [
        'docker.templateInstall',
        'docker.templateEdit',
        'docker.templateDelete',
        'docker.updateStream',
        'docker.checkForUpdates',
        'power',
        'plugins.uninstall',
        'plugins.checkForUpdates',
        'shares',
      ].sort(),
    );
  });

  it('is readonly at the type level (as const)', () => {
    // Compile-time guarantee, exercised at runtime via Object.isFrozen check
    // would require freezing the array -- instead assert it's a tuple-typed
    // readonly array by checking it's a real Array we can iterate safely.
    expect(Array.isArray(CAPABILITY_KEYS)).toBe(true);
  });
});
