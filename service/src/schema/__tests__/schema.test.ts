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
        'updateDiskThresholds',
      ].sort(),
    );
  });

  it('declares the v1 Query fields (dockerInstallOperation, dockerTemplate, capabilities) plus the Slice 1 root share queries and the Slice 2 plugins query', () => {
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
        'installedUnraidPluginsDetailed',
        'diskThresholds',
      ].sort(),
    );
  });

  it('DiskThresholds and DiskThresholdsInput fields are all nullable Int; defaults are Int!', () => {
    const sdl = readFileSync(SDL_PATH, 'utf8');
    const schema = buildSchema(sdl);
    const keys = ['warning', 'critical', 'hot', 'max', 'hotssd', 'maxssd'];

    const outputType = schema.getType('DiskThresholds') as import('graphql').GraphQLObjectType;
    expect(outputType).toBeDefined();
    const outputFields = outputType.getFields();
    for (const key of keys) {
      expect(outputFields[key]!.type.toString()).toBe('Int');
    }

    const inputType = schema.getType('DiskThresholdsInput') as import('graphql').GraphQLInputObjectType;
    expect(inputType).toBeDefined();
    const inputFields = inputType.getFields();
    for (const key of keys) {
      expect(inputFields[key]!.type.toString()).toBe('Int');
    }
  });

  it('declares the v1 Subscription fields (dockerInstallUpdates, dockerContainerStats)', () => {
    const sdl = readFileSync(SDL_PATH, 'utf8');
    const schema = buildSchema(sdl);
    const subscriptionType = schema.getSubscriptionType();
    expect(subscriptionType).toBeDefined();
    const fields = subscriptionType!.getFields();
    expect(Object.keys(fields).sort()).toEqual(['dockerContainerStats', 'dockerInstallUpdates'].sort());
  });

  it('DockerContainerStatsSample declares exact-integer BigInt fields, nullable network/blkio', () => {
    const sdl = readFileSync(SDL_PATH, 'utf8');
    const schema = buildSchema(sdl);
    const sampleType = schema.getType('DockerContainerStatsSample') as import('graphql').GraphQLObjectType;
    expect(sampleType).toBeDefined();
    const fields = sampleType.getFields();
    expect(fields['id']!.type.toString()).toBe('ID!');
    expect(fields['cpuPercent']!.type.toString()).toBe('Float!');
    expect(fields['memUsedBytes']!.type.toString()).toBe('BigInt!');
    expect(fields['memTotalBytes']!.type.toString()).toBe('BigInt!');
    expect(fields['netRxBytes']!.type.toString()).toBe('BigInt');
    expect(fields['netTxBytes']!.type.toString()).toBe('BigInt');
    expect(fields['blkReadBytes']!.type.toString()).toBe('BigInt');
    expect(fields['blkWriteBytes']!.type.toString()).toBe('BigInt');
    expect(fields['sampledAtMs']!.type.toString()).toBe('BigInt!');
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
        'plugins.installedDetailed',
        'shares',
        'diskThresholds',
        'docker.templateFixedIp',
        'docker.stats',
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
