/**
 * DockerConfigEntryType enum resolver map -- read (serialize) and write
 * (parseValue/parseLiteral) round-trip through the REAL executable schema
 * (buildExecutableSchema() from build-schema.ts), not a hand-rolled schema
 * or an isolated unit of resolvers.ts. Deliberately does NOT reuse
 * src/__tests__/resolvers.test.ts's local makeContext factory -- extracting
 * a shared one would enlarge the diff for a second consumer that does not
 * exist (design D1/testing-strategy).
 *
 * Spec: sdd/docker-template-config-type-enum -- "DockerTemplate config
 * entries serialize as wire-case enum values" + "Install/edit writes
 * convert wire-case enum input to title-case XML".
 */
import type { GraphQLEnumType } from 'graphql';
import { describe, expect, it, vi } from 'vitest';

// vitest/vite-node resolves an ESM `import` of the `graphql` package to a
// DIFFERENT module registry entry than the plain `require('graphql')`
// `@graphql-tools/schema`'s CJS build (the one actually loaded here, since
// this project is `"type": "commonjs"`) uses internally to construct its
// `GraphQLSchema`. Executing a schema built by one against the `graphql()`
// function imported by the other trips graphql-js's own `instanceof`-based
// `isSchema()` guard: "Cannot use GraphQLSchema from another module or
// realm." This split is a vitest/vite-node test-harness artifact only --
// the real esbuild-bundled single-file production/SEA build has exactly one
// `graphql` module instance, so `require` here (matching the CJS path
// `@graphql-tools/schema` itself takes) is what keeps this test executing
// against the SAME schema realm it built.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { graphql } = require('graphql') as typeof import('graphql');

import { buildExecutableSchema } from '../build-schema.js';
import { createOperation } from '../../operations/registry.js';
import { buildTemplateXml, parseTemplateXml } from '../../features/docker_template/xml.js';
import type { FeatureModuleDeps, GraphqlContext } from '../../resolvers.js';

/** Minimal harness: `authority: 'full'` always short-circuits isAuthorized()
 * to true (permissions.ts), and graphql-js only invokes resolvers actually
 * named in the executed document -- so `overrides` only ever needs to
 * supply the handful of deps a given test's document touches. */
function makeContext(overrides: Partial<FeatureModuleDeps> = {}): GraphqlContext {
  return {
    identity: { authority: 'full' } as unknown as GraphqlContext['identity'],
    deps: { ...overrides } as unknown as FeatureModuleDeps,
  };
}

const DOCKER_TEMPLATE_QUERY = `
  query DockerTemplateQuery($name: String!) {
    dockerTemplate(name: $name) {
      configs {
        name
        target
        type
      }
    }
  }
`;

const INSTALL_MUTATION = `
  mutation Install($input: DockerTemplateInput!) {
    docker {
      installDockerTemplate(input: $input) {
        id
      }
    }
  }
`;

describe('DockerConfigEntryType -- read path (serialize)', () => {
  it('T1: a single Path config entry serializes to wire-case PATH with no errors', async () => {
    const readDockerTemplate = vi.fn().mockResolvedValue({
      name: 'plex',
      repository: 'r',
      network: 'bridge',
      privileged: false,
      shell: 'sh',
      overview: null,
      icon: null,
      webui: null,
      support: null,
      project: null,
      readme: null,
      registry: null,
      extraParams: null,
      postArgs: null,
      cpuset: null,
      fixedMac: null,
      configs: [
        {
          name: 'c1',
          type: 'Path',
          target: '/data',
          value: '',
          default: '',
          mode: '',
          description: '',
          display: 'always',
          required: false,
          mask: false,
        },
      ],
    });

    const result = await graphql({
      schema: buildExecutableSchema(),
      source: DOCKER_TEMPLATE_QUERY,
      variableValues: { name: 'plex' },
      contextValue: makeContext({ readDockerTemplate }),
    });

    expect(result.errors).toBeUndefined();
    const configs = (result.data as Record<string, { configs: Array<{ type: string }> }>)['dockerTemplate']!
      .configs;
    expect(configs[0]!.type).toBe('PATH');
  });

  it('T6: an unrecognized XML config type is dropped, not fatal', async () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<Container version="2">',
      '  <Name>plex</Name>',
      '  <Repository>r</Repository>',
      '  <Config Name="c1" Target="/data" Default="" Mode="" Description="" Type="Path" Display="always" Required="false" Mask="false"/>',
      '  <Config Name="c2" Target="/bogus" Default="" Mode="" Description="" Type="Bogus" Display="always" Required="false" Mask="false"/>',
      '</Container>',
      '',
    ].join('\n');
    const parsed = parseTemplateXml(xml);
    const readDockerTemplate = vi.fn().mockResolvedValue(parsed);

    const result = await graphql({
      schema: buildExecutableSchema(),
      source: DOCKER_TEMPLATE_QUERY,
      variableValues: { name: 'plex' },
      contextValue: makeContext({ readDockerTemplate }),
    });

    expect(result.errors).toBeUndefined();
    const configs = (result.data as Record<string, { configs: Array<{ type: string }> }>)['dockerTemplate']!
      .configs;
    expect(configs).toHaveLength(1);
    expect(configs[0]!.type).toBe('PATH');
  });

  it('T7: zero config entries still resolves with an empty list, no errors', async () => {
    const readDockerTemplate = vi.fn().mockResolvedValue({
      name: 'empty',
      repository: 'r',
      network: 'bridge',
      privileged: false,
      shell: 'sh',
      overview: null,
      icon: null,
      webui: null,
      support: null,
      project: null,
      readme: null,
      registry: null,
      extraParams: null,
      postArgs: null,
      cpuset: null,
      fixedMac: null,
      configs: [],
    });

    const result = await graphql({
      schema: buildExecutableSchema(),
      source: DOCKER_TEMPLATE_QUERY,
      variableValues: { name: 'empty' },
      contextValue: makeContext({ readDockerTemplate }),
    });

    expect(result.errors).toBeUndefined();
    expect((result.data as Record<string, { configs: unknown[] }>)['dockerTemplate']!.configs).toEqual([]);
  });
});

describe('DockerConfigEntryType -- write path (parseValue/parseLiteral)', () => {
  const ALL_FIVE_INPUT = {
    name: 'plex',
    repository: 'r',
    network: 'bridge',
    privileged: false,
    shell: 'sh',
    configs: [
      {
        name: 'c1',
        type: 'PATH',
        target: '/data',
        value: '',
        default: '',
        mode: 'rw',
        description: 'd1',
        display: 'always',
        required: false,
        mask: false,
      },
      {
        name: 'c2',
        type: 'PORT',
        target: '8080',
        value: '8080',
        default: '8080',
        mode: '',
        description: 'd2',
        display: 'always',
        required: true,
        mask: false,
      },
      {
        name: 'c3',
        type: 'VARIABLE',
        target: 'ENV_VAR',
        value: 'val',
        default: '',
        mode: '',
        description: 'd3',
        display: 'always',
        required: false,
        mask: false,
      },
      {
        name: 'c4',
        type: 'LABEL',
        target: 'lbl',
        value: 'v',
        default: '',
        mode: '',
        description: 'd4',
        display: 'always',
        required: false,
        mask: false,
      },
      {
        name: 'c5',
        type: 'DEVICE',
        target: '/dev/x',
        value: '/dev/x',
        default: '',
        mode: '',
        description: 'd5',
        display: 'always',
        required: false,
        mask: true,
      },
    ],
  };

  const WIRE_TYPE_BY_NAME: Record<string, string> = {
    c1: 'PATH',
    c2: 'PORT',
    c3: 'VARIABLE',
    c4: 'LABEL',
    c5: 'DEVICE',
  };

  it('T3: all five enum members round-trip install -> real buildTemplateXml -> real parseTemplateXml -> dockerTemplate read, matched by name/target', async () => {
    const snapshot = createOperation('DOCKER_INSTALL', { containerName: 'plex', repository: 'r' });
    const installDockerTemplate = vi.fn().mockReturnValue(snapshot);

    const mutationResult = await graphql({
      schema: buildExecutableSchema(),
      source: INSTALL_MUTATION,
      variableValues: { input: ALL_FIVE_INPUT },
      contextValue: makeContext({ installDockerTemplate }),
    });
    expect(mutationResult.errors).toBeUndefined();
    expect(installDockerTemplate).toHaveBeenCalledTimes(1);

    const mappedInput = installDockerTemplate.mock.calls[0]![0] as Parameters<typeof buildTemplateXml>[0] & {
      name: string;
    };
    const xml = buildTemplateXml(mappedInput, mappedInput.name);
    const parsed = parseTemplateXml(xml);
    const readDockerTemplate = vi.fn().mockResolvedValue(parsed);

    const queryResult = await graphql({
      schema: buildExecutableSchema(),
      source: DOCKER_TEMPLATE_QUERY,
      variableValues: { name: 'plex' },
      contextValue: makeContext({ readDockerTemplate }),
    });

    expect(queryResult.errors).toBeUndefined();
    const configs = (queryResult.data as Record<string, { configs: Array<{ name: string; target: string; type: string }> }>)[
      'dockerTemplate'
    ]!.configs;
    expect(configs).toHaveLength(5);
    for (const config of ALL_FIVE_INPUT.configs) {
      const roundTripped = configs.find((c) => c.name === config.name && c.target === config.target);
      expect(roundTripped).toBeDefined();
      expect(roundTripped!.type).toBe(WIRE_TYPE_BY_NAME[config.name]);
    }
  });

  it('T2: an inline literal `type: PATH` maps to title-case "Path" for both installDockerTemplate and updateDockerTemplate', async () => {
    const installSnapshot = createOperation('DOCKER_INSTALL', { containerName: 'plex', repository: 'r' });
    const installDockerTemplate = vi.fn().mockReturnValue(installSnapshot);

    const installResult = await graphql({
      schema: buildExecutableSchema(),
      source: `
        mutation {
          docker {
            installDockerTemplate(
              input: {
                name: "plex"
                repository: "r"
                network: "bridge"
                privileged: false
                shell: "sh"
                configs: [
                  {
                    name: "c1"
                    type: PATH
                    target: "/data"
                    value: ""
                    default: ""
                    mode: ""
                    description: ""
                    display: "always"
                    required: false
                    mask: false
                  }
                ]
              }
            ) {
              id
            }
          }
        }
      `,
      contextValue: makeContext({ installDockerTemplate }),
    });
    expect(installResult.errors).toBeUndefined();
    expect(installDockerTemplate).toHaveBeenCalledTimes(1);
    const installArg = installDockerTemplate.mock.calls[0]![0] as { configs: Array<{ type: string }> };
    expect(installArg.configs[0]!.type).toBe('Path');

    const editSnapshot = createOperation('DOCKER_INSTALL', { containerName: 'plex', repository: 'r' });
    const editDockerTemplate = vi.fn().mockReturnValue(editSnapshot);

    const updateResult = await graphql({
      schema: buildExecutableSchema(),
      source: `
        mutation {
          docker {
            updateDockerTemplate(
              input: {
                name: "plex"
                repository: "r"
                network: "bridge"
                privileged: false
                shell: "sh"
                configs: [
                  {
                    name: "c1"
                    type: PATH
                    target: "/data"
                    value: ""
                    default: ""
                    mode: ""
                    description: ""
                    display: "always"
                    required: false
                    mask: false
                  }
                ]
              }
            ) {
              id
            }
          }
        }
      `,
      contextValue: makeContext({ editDockerTemplate }),
    });
    expect(updateResult.errors).toBeUndefined();
    expect(editDockerTemplate).toHaveBeenCalledTimes(1);
    const editArg = editDockerTemplate.mock.calls[0]![0] as { configs: Array<{ type: string }> };
    expect(editArg.configs[0]!.type).toBe('Path');
  });

  it('T5: an invalid enum literal ("BOGUS") is rejected by validation, not coerced -- inline literal leg', async () => {
    const installDockerTemplate = vi.fn();

    const result = await graphql({
      schema: buildExecutableSchema(),
      source: `
        mutation {
          docker {
            installDockerTemplate(
              input: {
                name: "x"
                repository: "r"
                network: "bridge"
                privileged: false
                shell: "sh"
                configs: [
                  {
                    name: "c"
                    type: BOGUS
                    target: "t"
                    value: ""
                    default: ""
                    mode: ""
                    description: ""
                    display: "always"
                    required: false
                    mask: false
                  }
                ]
              }
            ) {
              id
            }
          }
        }
      `,
      contextValue: makeContext({ installDockerTemplate }),
    });

    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    const combinedMessages = result.errors!.map((e) => e.message).join(' | ');
    expect(combinedMessages).toMatch(/DockerConfigEntryType/);
    expect(combinedMessages).toMatch(/BOGUS/);
    expect(result.data).toBeUndefined();
    expect(installDockerTemplate).not.toHaveBeenCalled();
  });

  it('T5: an invalid enum literal ("BOGUS") is rejected by validation, not coerced -- variable coercion leg', async () => {
    const installDockerTemplate = vi.fn();
    const invalidInput = {
      ...ALL_FIVE_INPUT,
      configs: [{ ...ALL_FIVE_INPUT.configs[0], type: 'BOGUS' }],
    };

    const result = await graphql({
      schema: buildExecutableSchema(),
      source: INSTALL_MUTATION,
      variableValues: { input: invalidInput },
      contextValue: makeContext({ installDockerTemplate }),
    });

    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    const combinedMessages = result.errors!.map((e) => e.message).join(' | ');
    expect(combinedMessages).toMatch(/DockerConfigEntryType/);
    expect(combinedMessages).toMatch(/BOGUS/);
    expect(result.data).toBeUndefined();
    expect(installDockerTemplate).not.toHaveBeenCalled();
  });
});

describe('DockerConfigEntryType -- schema shape', () => {
  it('T4: every enum member has an internal value distinct from its own name, and all five internal values are unique', () => {
    const schema = buildExecutableSchema();
    const enumType = schema.getType('DockerConfigEntryType') as GraphQLEnumType;
    expect(enumType).toBeDefined();

    const values = enumType.getValues();
    expect(values).toHaveLength(5);
    for (const enumValue of values) {
      expect(enumValue.value).not.toBe(enumValue.name);
    }
    const internalValues = values.map((v) => v.value as string);
    expect(new Set(internalValues).size).toBe(internalValues.length);
  });
});

// Both endpoints share the reader, so the SDL is the only place they can
// disagree -- and a non-null `value` used to kill the whole query here.
describe('DockerTemplateConfig -- nullability parity with /graphql', () => {
  const FULL_QUERY = `
    query DockerTemplateQuery($name: String!) {
      dockerTemplate(name: $name) {
        network
        privileged
        shell
        configs {
          name
          type
          target
          value
          default
          mode
          description
          display
          required
          mask
        }
      }
    }
  `;

  it('a self-closed Config entry resolves with value null instead of killing the query', async () => {
    // The literal shape that broke it: caddy's CUSTOM_BUILD entry.
    const xml = [
      '<?xml version="1.0"?>',
      '<Container version="2">',
      '  <Name>caddy</Name>',
      '  <Repository>ghcr.io/hotio/caddy</Repository>',
      '  <Config Name="CUSTOM_BUILD" Target="CUSTOM_BUILD" Default="" Mode=""',
      '     Description="" Type="Variable" Display="always" Required="false" Mask="false"/>',
      '</Container>',
    ].join('\n');
    const readDockerTemplate = vi.fn().mockResolvedValue(parseTemplateXml(xml));

    const result = await graphql({
      schema: buildExecutableSchema(),
      source: FULL_QUERY,
      variableValues: { name: 'caddy' },
      contextValue: makeContext({ readDockerTemplate } as unknown as Partial<FeatureModuleDeps>),
    });

    expect(result.errors).toBeUndefined();
    const configs = (result.data?.['dockerTemplate'] as { configs: unknown[] }).configs;
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ name: 'CUSTOM_BUILD', type: 'VARIABLE', value: null });
  });

  it('absent template-level tags resolve as null rather than erroring', async () => {
    // No <Network>, <Shell> or <Privileged>: the patch reports null for all
    // three, so this endpoint must too.
    const xml = [
      '<?xml version="1.0"?>',
      '<Container version="2">',
      '  <Name>bare</Name>',
      '  <Repository>r</Repository>',
      '</Container>',
    ].join('\n');
    const readDockerTemplate = vi.fn().mockResolvedValue(parseTemplateXml(xml));

    const result = await graphql({
      schema: buildExecutableSchema(),
      source: FULL_QUERY,
      variableValues: { name: 'bare' },
      contextValue: makeContext({ readDockerTemplate } as unknown as Partial<FeatureModuleDeps>),
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.['dockerTemplate']).toMatchObject({
      network: null,
      privileged: null,
      shell: null,
    });
  });
});
