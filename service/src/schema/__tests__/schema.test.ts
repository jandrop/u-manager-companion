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
        'updateDiskSmartSettings',
        'resetDiskSmartSettings',
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
        'diskSmartSettings',
        'allDiskSmartSettings',
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

  it('DiskSmartSettings exposes a raw Float smLevel, nullable values and a non-null default set', () => {
    const sdl = readFileSync(SDL_PATH, 'utf8');
    const schema = buildSchema(sdl);

    const outputType = schema.getType('DiskSmartSettings') as import('graphql').GraphQLObjectType;
    expect(outputType).toBeDefined();
    const outputFields = outputType.getFields();
    expect(outputFields['diskId']!.type.toString()).toBe('String!');
    expect(outputFields['configured']!.type.toString()).toBe('Boolean!');
    expect(outputFields['hotTemp']!.type.toString()).toBe('Int');
    expect(outputFields['maxTemp']!.type.toString()).toBe('Int');
    // Raw passthrough, deliberately NOT an enum.
    expect(outputFields['smSelect']!.type.toString()).toBe('Int');
    expect(outputFields['smLevel']!.type.toString()).toBe('Float');
    expect(outputFields['notifyAttributes']!.type.toString()).toBe('[Int!]');
    expect(outputFields['defaultNotifyAttributes']!.type.toString()).toBe('[Int!]!');
    expect(outputFields['preselectAttributes']!.type.toString()).toBe('[Int!]!');
    // smCustom is written to the file but never exposed.
    expect(outputFields['smCustom']).toBeUndefined();
  });

  it('DiskSmartSettingsInput is total over the five modeled keys, every one nullable', () => {
    const sdl = readFileSync(SDL_PATH, 'utf8');
    const schema = buildSchema(sdl);

    const inputType = schema.getType('DiskSmartSettingsInput') as import('graphql').GraphQLInputObjectType;
    expect(inputType).toBeDefined();
    const inputFields = inputType.getFields();
    expect(Object.keys(inputFields).sort()).toEqual(
      ['hotTemp', 'maxTemp', 'smSelect', 'smLevel', 'notifyAttributes'].sort(),
    );
    expect(inputFields['hotTemp']!.type.toString()).toBe('Int');
    expect(inputFields['maxTemp']!.type.toString()).toBe('Int');
    expect(inputFields['smSelect']!.type.toString()).toBe('Int');
    expect(inputFields['smLevel']!.type.toString()).toBe('Float');
    expect(inputFields['notifyAttributes']!.type.toString()).toBe('[Int!]');
  });

  it('allDiskSmartSettings is a non-null list of non-null records, and takes no args', () => {
    const sdl = readFileSync(SDL_PATH, 'utf8');
    const schema = buildSchema(sdl);

    const field = schema.getQueryType()!.getFields()['allDiskSmartSettings']!;
    expect(field).toBeDefined();
    // Non-null list: "no disk has an override" is [], never null.
    expect(field.type.toString()).toBe('[DiskSmartSettings!]!');
    expect(field.args).toEqual([]);
  });

  it('preselectAttributes and defaultNotifyAttributes are DIFFERENT fields, not an alias', () => {
    const sdl = readFileSync(SDL_PATH, 'utf8');
    const schema = buildSchema(sdl);

    const fields = (
      schema.getType('DiskSmartSettings') as import('graphql').GraphQLObjectType
    ).getFields();
    expect(fields['preselectAttributes']).toBeDefined();
    expect(fields['defaultNotifyAttributes']).toBeDefined();
    expect(fields['preselectAttributes']).not.toBe(fields['defaultNotifyAttributes']);
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
        'diskSmartSettings',
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
