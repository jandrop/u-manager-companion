/**
 * resolvers.ts tests.
 *
 * TDD: written before resolvers.ts exists -> RED first.
 *
 * resolvers.ts is a THIN binding layer: SDL field -> permission check
 * (auth/permissions.ts's isAuthorized, throwing PermissionError on
 * failure) -> feature module call -> GraphQL-shape mapping (the
 * `toGraphqlOperation`-equivalent step: operations/registry.ts's
 * OperationSnapshot<TSubject> is GENERIC with a `subject` field, never
 * Docker/plugin-shaped directly -- resolvers.ts is where that snapshot
 * becomes the SDL's DockerInstallOperation/PluginInstallOperation shape).
 * Does NOT wire the Apollo server itself (server.ts) -- this module only
 * exports the resolver map object server.ts mounts.
 *
 * Every feature-module call is injected via GraphqlContext.deps so this
 * suite exercises the BINDING logic (permission gating + shape mapping),
 * not feature-module internals already covered by their own test suites.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedIdentity } from '../auth/keystore.js';
import { PermissionError } from '../context.js';
import { pubsub, channelFor } from '../pubsub.js';
import { createOperation } from '../operations/registry.js';
import { resolvers, type GraphqlContext } from '../resolvers.js';

function makeIdentity(authority: ResolvedIdentity['authority'] = 'full'): ResolvedIdentity {
  return { id: 'u1', name: 'admin', roles: authority === 'full' ? ['ADMIN'] : [], permissions: [], authority };
}

function makeContext(overrides: Partial<GraphqlContext['deps']> = {}, identity = makeIdentity()): GraphqlContext {
  return {
    identity,
    deps: {
      installDockerTemplate: vi.fn(),
      editDockerTemplate: vi.fn(),
      deleteDockerTemplate: vi.fn().mockResolvedValue(true),
      readDockerTemplate: vi.fn().mockResolvedValue(null),
      updateContainerStream: vi.fn(),
      updateAllContainersStream: vi.fn(),
      checkForDockerUpdates: vi.fn().mockResolvedValue(true),
      shutdownServer: vi.fn().mockReturnValue(true),
      rebootServer: vi.fn().mockReturnValue(true),
      sleepServer: vi.fn().mockReturnValue(true),
      uninstallPlugin: vi.fn(),
      checkForPluginUpdates: vi.fn().mockReturnValue(true),
      ...overrides,
    },
  };
}

describe('resolvers -- permission gating', () => {
  it('throws PermissionError for a read-only identity attempting a privileged docker mutation', () => {
    const context = makeContext({}, makeIdentity('read-only'));
    const installDockerTemplate = resolvers.DockerMutations.installDockerTemplate;

    expect(() =>
      installDockerTemplate(
        {},
        {
          input: {
            name: 'plex',
            repository: 'r',
            network: 'bridge',
            privileged: false,
            shell: 'sh',
            configs: [],
          },
        },
        context,
      ),
    ).toThrow(PermissionError);
  });

  it('throws PermissionError for a read-only identity attempting serverPower.shutdown', () => {
    const context = makeContext({}, makeIdentity('read-only'));
    expect(() => resolvers.ServerPowerMutations.shutdown({}, {}, context)).toThrow(PermissionError);
  });

  it('allows a full-authority identity through to the feature module', () => {
    const context = makeContext({}, makeIdentity('full'));
    const result = resolvers.ServerPowerMutations.shutdown({}, {}, context);
    expect(result).toBe(true);
    expect(context.deps.shutdownServer).toHaveBeenCalled();
  });
});

describe('resolvers.DockerMutations.installDockerTemplate', () => {
  it('maps the OperationSnapshot subject to the GraphQL DockerInstallOperation shape', () => {
    const snapshot = createOperation('DOCKER_INSTALL', { containerName: 'plex', repository: 'r' });
    const context = makeContext({ installDockerTemplate: vi.fn().mockReturnValue(snapshot) });

    const result = resolvers.DockerMutations.installDockerTemplate(
      {},
      {
        input: {
          name: 'plex',
          repository: 'r',
          network: 'bridge',
          privileged: false,
          shell: 'sh',
          configs: [],
        },
      },
      context,
    );

    expect(result).toMatchObject({
      id: snapshot.id,
      containerName: 'plex',
      repository: 'r',
      status: 'RUNNING',
      output: [],
    });
  });
});

describe('resolvers.DockerMutations.updateContainerStream', () => {
  it('strips the PrefixedID prefix before hitting the feature module', () => {
    const snapshot = createOperation('DOCKER_INSTALL', { containerName: 'agh', repository: 'r' });
    const updateContainerStream = vi.fn().mockReturnValue(snapshot);
    const context = makeContext({ updateContainerStream });

    resolvers.DockerMutations.updateContainerStream(
      {},
      // The app sends the container's full PrefixedID (`<prefix>:<id>`);
      // dockerode needs only the bare id after the last colon.
      { id: 'a42869b5ff179:ebeee0fea0ca08' },
      context,
    );

    expect(updateContainerStream).toHaveBeenCalledWith('ebeee0fea0ca08', expect.anything());
  });

  it('passes a bare id with no prefix through unchanged', () => {
    const snapshot = createOperation('DOCKER_INSTALL', { containerName: 'agh', repository: 'r' });
    const updateContainerStream = vi.fn().mockReturnValue(snapshot);
    const context = makeContext({ updateContainerStream });

    resolvers.DockerMutations.updateContainerStream({}, { id: 'ebeee0fea0ca08' }, context);

    expect(updateContainerStream).toHaveBeenCalledWith('ebeee0fea0ca08', expect.anything());
  });
});

describe('resolvers.Query.dockerInstallOperation', () => {
  it('maps a docker install snapshot to the GraphQL shape', () => {
    const snapshot = createOperation('DOCKER_INSTALL', { containerName: 'plex', repository: 'r' });
    const context = makeContext();

    const result = resolvers.Query.dockerInstallOperation({}, { operationId: snapshot.id }, context);

    expect(result).toMatchObject({ id: snapshot.id, containerName: 'plex', repository: 'r' });
  });

  it('returns null for an unknown operation id', () => {
    const context = makeContext();
    const result = resolvers.Query.dockerInstallOperation({}, { operationId: 'nope' }, context);
    expect(result).toBeNull();
  });
});

describe('resolvers.UnraidPluginsMutations.uninstallPlugin', () => {
  it('maps the plugin OperationSnapshot to the PluginInstallOperation shape', () => {
    const snapshot = createOperation('PLUGIN_INSTALL', { name: 'my-plugin', url: 'my-plugin.plg' });
    const context = makeContext({ uninstallPlugin: vi.fn().mockReturnValue(snapshot) });

    const result = resolvers.UnraidPluginsMutations.uninstallPlugin(
      {},
      { filename: 'my-plugin.plg' },
      context,
    );

    expect(result).toMatchObject({ id: snapshot.id, name: 'my-plugin', url: 'my-plugin.plg', status: 'RUNNING' });
  });

  it('gates uninstallPlugin behind PLUGINS:update permission', () => {
    const context = makeContext({}, makeIdentity('read-only'));
    expect(() =>
      resolvers.UnraidPluginsMutations.uninstallPlugin({}, { filename: 'x.plg' }, context),
    ).toThrow(PermissionError);
  });
});

describe('resolvers.UnraidPluginsMutations.checkForUpdates', () => {
  it('rejects a read-only (VIEWER) caller -- it triggers a network side effect', () => {
    const context = makeContext({}, makeIdentity('read-only'));
    expect(() =>
      resolvers.UnraidPluginsMutations.checkForUpdates({}, {}, context),
    ).toThrow(PermissionError);
  });

  it('allows a full (ADMIN) caller', () => {
    const context = makeContext({}, makeIdentity('full'));
    const result = resolvers.UnraidPluginsMutations.checkForUpdates({}, {}, context);
    expect(result).toBe(true);
  });
});

describe('resolvers.Subscription.dockerInstallUpdates', () => {
  it('subscribes to the channel derived from the operation id', () => {
    const snapshot = createOperation('DOCKER_INSTALL', { containerName: 'plex', repository: 'r' });
    const context = makeContext();
    const publishSpy = vi.spyOn(pubsub, 'asyncIterator');

    resolvers.Subscription.dockerInstallUpdates.subscribe({}, { operationId: snapshot.id }, context);

    expect(publishSpy).toHaveBeenCalledWith(channelFor('DOCKER_INSTALL', snapshot.id));
    publishSpy.mockRestore();
  });
});
